#!/usr/bin/env node
/**
 * mcp-mc-agent / mcp/server.mjs —— MCP server 入口
 * ============================================================================
 * 这个进程 = **一个 Minecraft 角色**。
 *
 * 它把 `mcp-mc-agent` 那 34 个工具原封不动地搬到 MCP 上：`index.js` 的 `apply()`
 * 一行没改（只加了一个 `ctx.__mcpBridge` 出口），宿主 ctx / exec 由 `mcp/host.mjs` 打桩，
 * 这里负责把「注册进桩里的工具表」翻译成 MCP 的 `tools/list` + `tools/call`。
 *
 * ── 三件事在 MCP 下没有对应物，各自的替代方案 ─────────────────────────────
 *
 *   ① 提示词注入（DSH 的 `agent/pre-step` 瀑布）
 *      → MCP 的 `instructions` 字段（initialize 响应里回给客户端）+ `mc://prompt` resource。
 *        `initialize` 时调一次 `reconcileNotices()`，把 AGENTS.md / RULES.md 指针 /
 *        版本提示 / 记忆索引拼成一段文字塞进去。客户端会把它带给模型。
 *
 *   ② 看门狗/自主层唤醒（DSH 的 `agent.steer` / `sessionController.prompt`）
 *      → 三通道，见下面 `onWake`：
 *        · **会话事件队列**（`sess.pushEvent`）—— 主通道，模型下次调 `mc_events` 就看见；
 *        · **MCP logging 通知**（`notifications/message`）—— 只提醒"有事"，支持它的客户端
 *          能立刻知道，但**内容以 `mc_events` 为准**（通知可能被客户端丢掉）；
 *        · **`mc://wake-log` resource** —— 本地环形留档 50 条，排障用。
 *        这是"AI 正在挂机、突然被打断"这条链路的全部（MCP 是"你问它答"，
 *        没有东西能把消息主动塞进模型的上下文，所以队列才是主通道）。
 *
 *   ③ 图片内联（DSH 的 `ctx.get('attachments').saveImage`）
 *      → 桩在工具调用期间收集图片，调用结束转成 MCP 的
 *        `{type:'image', data:<base64>, mimeType}` content block。模型能**直接看图**
 *        （`mc_map` 的地图、`mc_observe` 的截图都不再只是"落了个文件"）。
 *
 * ── 启动 ────────────────────────────────────────────────────────────────
 *
 *   node mcp/server.mjs                      # stdio（默认，给 MCP 客户端用）
 *   node mcp/server.mjs --http 3921          # HTTP（Streamable HTTP，给远程/网页客户端）
 *   node mcp/server.mjs --cwd /path/to/world # 指定会话工作区（记忆/落盘挂它下面）
 *
 * 环境变量：MCP_MC_AGENT_STATE_DIR / MCP_MC_AGENT_HOME / MCP_MC_AGENT_CWD /
 *          MCP_MC_AGENT_HTTP_PORT / MCP_MC_AGENT_VERBOSE
 * ============================================================================
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { createHost, MCP_SESSION_ID, stateDirHint } from './host.mjs'
import { createFileCredentials } from './credentials.mjs'
import { renderContent } from './content.mjs'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 调试开关：`MCP_MC_AGENT_VERBOSE=1` 时多打一些 stderr 日志（协议行为不变） */
const verbose = ['1', 'true', 'yes'].includes(String(process.env.MCP_MC_AGENT_VERBOSE ?? '').toLowerCase())

/* ── 0. 先保命：stdout 是 JSON-RPC 通道，任何 console.log 都会把协议打断 ──────
 * `src/log.mjs` 本身是落盘的不写 stdout，但**依赖树里**（mineflayer / prismarine-*）
 * 保不齐谁 `console.log` 一句调试信息。stdio 传输下那一句就够客户端解析失败了。
 * 所以进程一起来就把 `console.log` / `console.info` 改道到 stderr，全程不再恢复。 */
for (const m of ['log', 'info']) {
  console[m] = (...a) => {
    try { process.stderr.write(`[stdout→stderr] ${a.map(String).join(' ')}\n`) } catch { /* 无所谓 */ }
  }
}

const log = (...a) => {
  try { process.stderr.write(`[mcp-mc-agent] ${a.join(' ')}\n`) } catch { /* 无所谓 */ }
}

/* ── 1. 命令行 ─────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2)
if (argv.includes('-h') || argv.includes('--help')) {
  process.stderr.write(`mcp-mc-agent —— Minecraft 的 MCP server

用法：
  node mcp/server.mjs [选项]
  node mcp/server.mjs accounts <子命令>     ← 在终端里管账户（加账户 / 登正版号）

选项：
  --stdio              用 stdio 传输（默认）
  --http [端口]        用 Streamable HTTP 传输（默认端口 3921）
  --cwd <目录>         会话工作区（记忆、落盘图片挂它下面；默认当前目录）
  --state-dir <目录>   状态目录（配置 + 账户库 + 凭据；默认 ~/.mcp-mc-agent）
  --version, -v        打印版本后退出
  -h, --help           这条帮助

账户（MCP 工具加不了账户，要用这个）：
  node mcp/server.mjs accounts list
  node mcp/server.mjs accounts add offline <名字>
  node mcp/server.mjs accounts add yggdrasil --url <认证服> --login <账号> [--password-stdin]
  node mcp/server.mjs accounts add microsoft --email <微软邮箱>
  node mcp/server.mjs accounts login <innerID>     正版号：打印 8 位设备码 + 网址
  node mcp/server.mjs accounts help               全部子命令

环境变量：
  MCP_MC_AGENT_STATE_DIR / MCP_MC_AGENT_HOME / MCP_MC_AGENT_CWD / MCP_MC_AGENT_HTTP_PORT
  MCP_MC_AGENT_VERBOSE=1 多打 stderr 日志
`)
  process.exit(0)
}

/* `--version`：**必须在起 server 之前短路**。写在后面的话，进程会先进 stdio 模式挂住等
 * stdin，`--version` 就变成"卡死"了（真踩过）。这里走 stdout —— 马上就 exit，
 * 不会污染 JSON-RPC 通道。
 * 直接读 package.json（不能用下面那个 `PKG_VERSION`：它在第 373 行才初始化，
 * 这里还在 TDZ 里）。 */
if (argv.includes('--version') || argv.includes('-v')) {
  let v = '0.0.0'
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    v = String(pkg.version ?? v)
  } catch { /* 读不到就给 0.0.0，不为了版本号把命令搞崩 */ }
  process.stdout.write(`${v}\n`)
  process.exit(0)
}

const flag = (name) => {
  const i = argv.indexOf(name)
  if (i < 0) return undefined
  const next = argv[i + 1]
  return next && !next.startsWith('--') ? next : true
}

const httpFlag = flag('--http')
const stdioFlag = flag('--stdio')

/* `--stdio` 与 `--http` 同时给 = 用户意图矛盾，**直接报错**而不是悄悄挑一个。
 * （`--stdio` 是默认值，单独给它是合法的空操作 —— 但"写了不认"就是坑，所以真要认。） */
if (stdioFlag !== undefined && httpFlag !== undefined) {
  process.stderr.write('mcp-mc-agent：`--stdio` 和 `--http` 不能同时给（stdio 是默认值，只在想显式声明时写）\n')
  process.exit(2)
}
const useHttp = httpFlag !== undefined
const httpPort = Number(
  (typeof httpFlag === 'string' ? httpFlag : '')
  || process.env.MCP_MC_AGENT_HTTP_PORT
  || 3921,
)
if (useHttp && (!Number.isInteger(httpPort) || httpPort <= 0 || httpPort > 65535)) {
  process.stderr.write(`mcp-mc-agent：端口不合法（${httpFlag === true ? process.env.MCP_MC_AGENT_HTTP_PORT : httpFlag}），要 1–65535\n`)
  process.exit(2)
}
const cwd = String(
  (typeof flag('--cwd') === 'string' ? flag('--cwd') : '')
  || process.env.MCP_MC_AGENT_CWD
  || process.cwd(),
)
const stateDirOverride = String(
  (typeof flag('--state-dir') === 'string' ? flag('--state-dir') : '')
  || process.env.MCP_MC_AGENT_STATE_DIR
  || '',
)

/* `--state-dir` 落到环境变量上，让 `resolveStateDir()`（src/config.mjs:39）和下面
 * `stateDirHint()`（凭据文件）**看到同一个值** —— 否则凭据库会落在默认的 `~/.mcp-mc-agent`
 * 而配置落在 `--state-dir` 指定的地方，两个文件分家。 */
if (stateDirOverride) process.env.MCP_MC_AGENT_STATE_DIR = stateDirOverride

/* 日志落盘也跟状态目录走。
 * 🔴 `src/core.mjs` 的默认值是 `$DSH_HOME/mcp-mc-agent/logs/` —— 那是 **DSH 版遗留**，
 *    而 MCP 版的状态目录是 `~/.mcp-mc-agent`（或 `--state-dir`）。不改的话日志会落在
 *    `~/.dsh/...` 里，跟账户库/配置**分家**，README 上写着"日志在状态目录"也对不上
 *    （2026-10-16 实机核对时发现）。
 * 显式给了 `MC_LOG` 就不动。⚠️ 必须赶在下面 `await import('../index.js')` **之前** ——
 * `core.mjs` 的 `DEFAULTS` 是模块加载时求值的。 */
if (!String(process.env.MC_LOG ?? '').trim()) {
  try {
    const { resolveStateDir } = await import('../src/config.mjs')
    process.env.MC_LOG = join(resolveStateDir(), 'logs', 'mcp-mc-agent.log')
  } catch { /* 拿不到就让它走 core.mjs 的兜底（能跑，只是位置不是状态目录） */ }
}

/* ── 1.5 `accounts` 子命令：在终端里管账户，**不进 MCP 协议** ──────────────
 * 为什么要有它：MCP 客户端没有"账户界面"（那是 DSH 版 Web GUI 的活），而 `mc_accounts`
 * 只给模型 list/search/use/refresh —— **加不了账户、登录不了正版号**，结果就是只能用自动
 * 建的那个离线号。账户和密码是**用户**的东西，不该由模型代管，所以走终端子命令。
 *
 * 它跟 `--version` / `-h` 一样是**短路命令**：做完就 `process.exit`，绝不进传输层
 * （否则 stdio 模式下会挂住等 stdin，看起来像卡死 —— `--version` 当年就这么踩过）。
 * 放在这里而不是更前面：`resolveStateDir()` 要看到上面刚落好的 `MCP_MC_AGENT_STATE_DIR`。 */
if (String(argv[0] ?? '').toLowerCase() === 'accounts') {
  const { runAccountsCli } = await import('./accounts-cli.mjs')
  const { resolveStateDir } = await import('../src/config.mjs')
  const code = await runAccountsCli(argv.slice(1), { stateDir: resolveStateDir() })
  process.exit(code)
}

/* ── 2. 起宿主桩 → 跑 apply() ──────────────────────────────────────────── */

/** 服务端收到的唤醒（看门狗叫不动 AI 时至少能从这里查到，见 `mc://wake-log`） */
const wakeLog = []
let mcpServerRef = null

/** 看门狗唤醒 → ① 会话事件队列 ② MCP logging 通知 ③ 本地环形缓冲 */
const onWake = (text, kind = 'wake', running = false) => {
  const at = Date.now()
  const line = `【看门狗唤醒·${kind}】${text}`
  wakeLog.push({ at, kind, running, text })
  if (wakeLog.length > 50) wakeLog.splice(0, wakeLog.length - 50)

  /* ① 塞进会话事件队列：模型下次 `mc_events` 必然看得见（**这条是主通道**，
   *    因为 MCP 没有"主动起一轮对话"的能力，最终还是要模型自己来取）。 */
  try {
    const sess = host?.bridge?.registry?.peek?.(MCP_SESSION_ID)
    sess?.pushEvent?.('lifecycle', line)
  } catch (e) { log(`唤醒写事件队列失败：${e?.message ?? e}`) }

  /* ② MCP logging 通知：客户端支持的话会**立刻**把这条推给模型（MCP 版的"叫醒"）。 */
  try {
    void mcpServerRef?.notification?.({
      method: 'notifications/message',
      params: { level: 'warning', logger: 'mcp-mc-agent', data: line },
    })?.catch?.((e) => log(`唤醒通知发送失败：${e?.message ?? e}`))
  } catch (e) { log(`唤醒通知构造失败：${e?.message ?? e}`) }

  log(`唤醒（${running ? '运行中' : '空闲'}）：${text.slice(0, 200)}`)
}

const credentials = createFileCredentials({ stateDir: stateDirHint(), log })

/** 工具表变化（扩展是**异步**注册的）→ 告诉客户端"列表变了" */
let toolsListServed = false
const onRegister = (tool) => {
  if (!toolsListServed) return
  try {
    void mcpServerRef?.notification?.({ method: 'notifications/tools/list_changed' })
      ?.catch?.((e) => log(`tools/list_changed 发送失败：${e?.message ?? e}`))
  } catch { /* 通知失败不影响工具注册 */ }
}

/* `fileServer: null` = **明确告诉插件"没人托管发布区"**。
 *   后果：`mc_kit_express` 不会递出 `expressBase + /api/mcp-mc-agent/express/…` 这种点不开的链接，
 *   而是如实回"给绝对路径"。两个传输都不挂载发布区路由（HTTP 模式下这个 http server
 *   只服务 `POST /mcp` 与 `GET /health`），所以两个传输都是 null。
 *   将来真要在 HTTP 模式下托管发布区：把 `host.webRoutes` 挂到这个 server 上，
 *   这里改成 `fileServer: { base }` 即可 —— 插件侧一行都不用动。 */
let host = createHost({ cwd, onWake, log, onRegister, credentials, fileServer: null })

/* `apply()` 是同步的（扩展加载是 fire-and-forget），所以这里直接 await 也不会漏掉同步注册。 */
const plugin = await import('../index.js')
try {
  plugin.apply(host.ctx, {})
} catch (e) {
  log(`🔴 apply() 抛错：${e?.stack ?? e?.message ?? e}`)
  throw e
}

/* 扩展的 `apply()` 是 async 的，注册时间不确定 —— 等工具表**稳定**下来再对外服务，
 * 否则客户端 initialize 后立刻 tools/list 会少 5 个扩展工具（mc_auto/mc_chest/mc_craft/
 * mc_furnace/mc_observe），而且之后再也不会重列。 */
async function waitForToolsStable (tools, { quietMs = 400, maxMs = 15000 } = {}) {
  const t0 = Date.now()
  let last = -1
  let lastChange = Date.now()
  while (Date.now() - t0 < maxMs) {
    if (tools.size !== last) { last = tools.size; lastChange = Date.now() }
    else if (Date.now() - lastChange >= quietMs) return { count: tools.size, waitedMs: Date.now() - t0 }
    await new Promise((r) => setTimeout(r, 50))
  }
  return { count: tools.size, waitedMs: Date.now() - t0, timedOut: true }
}

const toolWait = await waitForToolsStable(host.tools)
log(`工具表已稳定：${toolWait.count} 个（等了 ${toolWait.waitedMs}ms${toolWait.timedOut ? '，超时' : ''}）`)
if (toolWait.count === 0) log('🔴 一个工具都没注册上 —— index.js 的 apply() 可能提前返回了')

/* ── 3. 提示词：DSH 的 pre-step 注入 → MCP 的 instructions / resource ───── */

/**
 * 调 `reconcileNotices()` 拿提示词条目。
 * 返回 `{items:[{rel,title,text}], reason?}`；条目来源见 index.js:3792 的注释。
 */
function collectPrompt () {
  const bridge = host.bridge
  if (typeof bridge?.noticesFor !== 'function') {
    return { items: [], reason: '桥没挂上（index.js 末尾的 ctx.__mcpBridge 段缺失？）' }
  }
  try {
    const r = bridge.noticesFor(host.agent)
    const items = Array.isArray(r?.todo) ? r.todo : []
    return { items, reason: r?.reason }
  } catch (e) {
    return { items: [], reason: `reconcileNotices 抛错：${e?.message ?? e}` }
  }
}

const prompt = collectPrompt()

/** 拼 MCP 的 `instructions` —— 客户端会把它带给模型，等价于 DSH 下那段系统提示词。 */
function buildInstructions () {
  const parts = [
    '# mcp-mc-agent',
    '',
    '你是通过 MCP 操作一个 Minecraft 角色的 Agent。这个 server 就是**一个角色**，',
    '同一时刻只有一个机器人、一份记忆。',
    '',
    '## 基本节奏',
    '1. `mc_status` 看现在什么情况（在线？血量？位置？）。',
    '2. 没上线就 `mc_accounts` 选账户、`mc_connect` 上线。',
    '3. `mc_events` **先取走**攒下的事件（聊天、被打、掉线、看门狗唤醒都在里面）。',
    '4. `mc_scan` / `mc_map` 看周围，`mc_inventory` 看背包，然后 `mc_move` / `mc_act` / `mc_dig` / `mc_build`。',
    '5. 长活儿用 `mc_task`（一条自然语言目标，内部自己拆步骤），别用几百次 `mc_move` 硬啃。',
    '6. **记忆要写**：`mc_kit_memory` 记下基地坐标、挖到什么、打算做什么 —— 下一个会话只靠它。',
    '',
    '## 几个容易踩的',
    '- `mc_events` 是**消费**（取走即删）；只想看不取用 `peek:true`。',
    '- 动作有预算（默认 11 秒），超时会返回"被打断"，不是失败 —— 接着做就行。',
    '- 图片（`mc_map` 的地图、`mc_observe` 的截图、`mc_kit_image` 出的图）会**直接以图片形式**给你，不用去读文件。',
    '- 挂机时看门狗会命中唤醒条件 —— 它会往事件队列记一条，并**发一条 MCP 日志通知**。'
      + '通知只是提示，**内容以 `mc_events` 为准**：收到提示（或过一阵子）就去 `mc_events` 收一次。',
    '- 没人能把消息主动塞进你的上下文（MCP 是"你问它答"）——**别指望叫醒自己蹦到你面前**，'
      + '长时间没动作时记得自己 `mc_events` 收一次。',
  ]
  if (prompt.items.length) {
    parts.push('', '## 会话提示词（来自工作区 / 记忆）', '')
    for (const it of prompt.items) {
      parts.push(`### ${it.title || it.rel || '提示'}`, '', String(it.text ?? '').trim(), '')
    }
  }
  if (prompt.reason) parts.push('', `> 提示词对账说明：${prompt.reason}`)
  const text = parts.join('\n')
  /* instructions 太长会被某些客户端截断；超了就只留头部，全文放 `mc://prompt` resource */
  return text.length > 20000 ? `${text.slice(0, 20000)}\n\n…（完整提示词见 resource mc://prompt）` : text
}

const instructions = buildInstructions()

/* ── 4. 工具结果 → MCP content blocks ──────────────────────────────────── */

const ok = (content) => ({ content })
const errResult = (text) => ({ content: [{ type: 'text', text: String(text) }], isError: true })
/* 工具返回值 → MCP content blocks 这一层搬去了 `./content.mjs`（抽出来才能离线单测）。
 * 它挡的正是「DSH 形状的图片块」—— 见那个文件的头注释（2026-10-16 实机 -32602）。 */

/* ── 5. 组装 MCP server ───────────────────────────────────────────────── */

const PKG_VERSION = plugin.PLUGIN_VERSION ?? '0.0.0'

const server = new Server(
  { name: 'mcp-mc-agent', version: String(PKG_VERSION) },
  {
    capabilities: {
      tools: {},
      logging: {},
      resources: {},
    },
    instructions,
  },
)
mcpServerRef = server

/* 工具表在进程里是**动态**的（扩展异步注册），所以每次都现查，不缓存快照。 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  toolsListServed = true
  const tools = []
  for (const tool of host.tools.values()) {
    tools.push({
      name: tool.name,
      description: String(tool.description ?? ''),
      /* `tool.parameters` 已经是编译好的 JSON Schema（src/tool-def.mjs 的
       * parameterSchemaSpecToJsonSchema）—— 直接就是 MCP 要的 inputSchema，不用转。 */
      inputSchema: normalizeInputSchema(tool.parameters),
    })
  }
  return { tools }
})

/** MCP 客户端普遍要求根节点是 `{type:'object', properties}`；缺字段就补上，别让它拒收 */
function normalizeInputSchema (schema) {
  const s = schema && typeof schema === 'object' ? { ...schema } : {}
  if (s.type !== 'object') s.type = 'object'
  if (!s.properties || typeof s.properties !== 'object') s.properties = {}
  return s
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = String(req?.params?.name ?? '')
  const args = req?.params?.arguments ?? {}
  const tool = host.tools.get(name)
  if (!tool) return errResult(`没有这个工具：${name}（现有 ${host.tools.size} 个，调 tools/list 看）`)

  host.beginCall()
  /* 让看门狗知道"AI 正在干活"—— 它据此决定是"起一轮"还是"下一步插话"。
   * （MCP 下两者都退化成推通知，但这个状态 `mc_diag` / `mc_watch` 里看得见。） */
  host.setAgentStatus('running')
  const ac = new AbortController()
  const exec = host.makeExec(ac.signal)
  let value
  let failed = null
  const t0 = Date.now()
  try {
    value = await tool.execute(args, exec)
  } catch (e) {
    failed = e
  } finally {
    host.setAgentStatus('idle')
  }
  const images = host.endCall()
  const ms = Date.now() - t0

  if (failed) {
    const msg = failed?.message ?? String(failed)
    /* `builtinDefineTool` 的入参校验错误：单独标出来，模型看到"参数错了"才知道该改参数
     * 而不是以为"动作失败了"。错误码见 src/tool-def.mjs 的 BuiltinToolArgsError（INVALID_ARGS）。 */
    const kind = failed?.code === 'INVALID_ARGS' ? '入参不合法' : '执行出错'
    log(`🔴 ${name} ${kind}（${ms}ms）：${msg}`)
    return errResult(`${kind}（${name}）：${msg}`)
  }
  log(`${name} ok（${ms}ms${images.length ? `，${images.length} 张图` : ''}）`)
  return ok(renderContent({ tool, args, value, images, cwd, log, verbose }))
})

/* ── resources：把 DSH 下"塞进系统提示词"的东西变成可读的 ─────────────────── */

const RESOURCES = [
  {
    uri: 'mc://prompt',
    name: '会话提示词全文',
    description: '工作区 AGENTS.md、记忆 RULES.md 指针、版本提示、记忆索引 —— DSH 下这段是自动注入系统提示词的，MCP 下放在这里。',
    mimeType: 'text/markdown',
  },
  {
    uri: 'mc://rules',
    name: '游戏规则（RULES.md）',
    description: '记忆根下的 `.mcp-mc-agent/RULES.md`：这个角色的行为准则。**开工前读一遍。**',
    mimeType: 'text/markdown',
  },
  {
    uri: 'mc://state',
    name: '运行状态',
    description: '状态目录、会话工作区、记忆根、工具数量 —— 排查"东西存哪去了"用。',
    mimeType: 'application/json',
  },
  {
    uri: 'mc://wake-log',
    name: '看门狗唤醒记录',
    description: '最近 50 条看门狗唤醒。MCP 没有"主动起一轮对话"，所以唤醒是推通知 + 进事件队列；漏掉的通知来这里找。',
    mimeType: 'application/json',
  },
]

server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES }))

server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
  const uri = String(req?.params?.uri ?? '')
  const text = (t, mimeType) => ({ contents: [{ uri, mimeType, text: String(t ?? '') }] })

  if (uri === 'mc://prompt') {
    const items = prompt.items
    if (!items.length) return text(`（没有提示词条目）${prompt.reason ? `\n原因：${prompt.reason}` : ''}`, 'text/markdown')
    const md = items.map((it) => `## ${it.title || it.rel}\n\n${String(it.text ?? '').trim()}`).join('\n\n')
    return text(md, 'text/markdown')
  }

  if (uri === 'mc://rules') {
    /* RULES.md 在记忆根下的 `.mcp-mc-agent/`。记忆根从桥里拿（`memoryRootFor`）。 */
    try {
      const { readFileSync, existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      const root = host.bridge.memoryRootFor?.(cwd, MCP_SESSION_ID) ?? join(cwd, '.mcp-mc-agent')
      const p = join(root, '.mcp-mc-agent', 'RULES.md')
      const alt = join(root, 'RULES.md')
      const file = existsSync(p) ? p : (existsSync(alt) ? alt : null)
      if (!file) return text(`（还没生成 RULES.md）\n找过：\n- ${p}\n- ${alt}`, 'text/markdown')
      return text(readFileSync(file, 'utf8'), 'text/markdown')
    } catch (e) {
      return text(`读 RULES.md 失败：${e?.message ?? e}`, 'text/markdown')
    }
  }

  if (uri === 'mc://state') {
    const info = {
      server: 'mcp-mc-agent',
      version: String(PKG_VERSION),
      sessionId: MCP_SESSION_ID,
      cwd,
      stateDir: host.bridge.stateDir ?? stateDirHint(),
      stateDirOverride: stateDirOverride || null,
      memoryRoot: safeCall(() => host.bridge.memoryRootFor?.(cwd, MCP_SESSION_ID)),
      workspaceRoot: safeCall(() => host.bridge.workspaceRootFor?.(host.agent)),
      tools: host.tools.size,
      toolNames: [...host.tools.keys()],
      credentialsFile: credentials.file,
      transports: useHttp ? `http:${httpPort}` : 'stdio',
      promptItems: prompt.items.map((i) => ({ rel: i.rel, title: i.title })),
      promptReason: prompt.reason ?? null,
    }
    return text(JSON.stringify(info, null, 2), 'application/json')
  }

  if (uri === 'mc://wake-log') {
    return text(JSON.stringify(wakeLog.slice().reverse(), null, 2), 'application/json')
  }

  throw new Error(`没有这个 resource：${uri}`)
})

function safeCall (fn) { try { return fn() ?? null } catch { return null } }

/* ── 6. 传输 ───────────────────────────────────────────────────────────── */

/** 优雅收尾：关掉会话（会断开 bot、停看门狗）、跑 effect 的清理 */
async function shutdown (why) {
  log(`收尾（${why}）…`)
  try { host.dispose() } catch (e) { log(`dispose 失败：${e?.message ?? e}`) }
  /* 给 bot 一点时间发完 disconnect 包 */
  await new Promise((r) => setTimeout(r, 50))
}

if (useHttp) {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js')
  const { createServer } = await import('node:http')
  const { randomUUID } = await import('node:crypto')

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    /* 纯 JSON 响应（不开 SSE）—— 方便用 curl 调，也让"一次调用一个请求"这种用法简单 */
    enableJsonResponse: true,
  })
  await server.connect(transport)

  const http = createServer((req, res) => {
    const url = String(req.url ?? '')
    if (url === '/' || url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, server: 'mcp-mc-agent', version: String(PKG_VERSION), tools: host.tools.size }))
      return
    }
    if (url === '/mcp' || url.startsWith('/mcp?')) {
      transport.handleRequest(req, res).catch((e) => {
        log(`HTTP 请求处理失败：${e?.message ?? e}`)
        try { res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: String(e?.message ?? e) })) } catch { /* 已经发过头了 */ }
      })
      return
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found', hint: 'MCP 端点在 POST /mcp' }))
  })
  http.listen(httpPort, () => log(`HTTP 传输已就绪：http://127.0.0.1:${httpPort}/mcp`))

  const bye = async () => { await shutdown('http 关闭'); http.close(); process.exit(0) }
  process.on('SIGINT', bye)
  process.on('SIGTERM', bye)
} else {
  /* 🔴 stdout 污染闸门：stdio 传输下 stdout **就是** JSON-RPC 通道，任何一个依赖
   * （mineflayer / minecraft-protocol / sharp …）往 stdout 打一行人话，客户端解析就会炸，
   * 而且是那种"偶发、难复现"的炸。所以把 stdout.write 包一层：
   *   · 以 `{` 开头的（JSON-RPC 消息一定长这样）照原样放行；
   *   · 其它一律**改道 stderr**，并留一句是谁干的。
   * 只做整块判断、不缓冲不改内容，所以不会把消息切碎；返回值照原样透传（背压语义不变）。 */
  const rawStdoutWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = (chunk, ...rest) => {
    const s = typeof chunk === 'string' ? chunk : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : '')
    if (s === '' || s.startsWith('{') || s.startsWith('[')) return rawStdoutWrite(chunk, ...rest)
    return process.stderr.write(`[stdout→stderr] 有东西往 stdout 打了非 JSON-RPC 内容（已改道，免得污染协议通道）：${s.slice(0, 400)}\n`)
  }

  const transport = new StdioServerTransport()
  await server.connect(transport)
  log(`stdio 传输已就绪（${host.tools.size} 个工具）`)

  /* stdio：stdin 关掉 = 客户端走了。注意 **不能**在这里 process.exit —— 机器人可能还有
   * 未落盘的记忆要写。先收尾，再退出。 */
  process.stdin.on('close', () => {
    void shutdown('stdin 关闭').then(() => process.exit(0))
  })
  process.on('SIGINT', () => { void shutdown('SIGINT').then(() => process.exit(0)) })
  process.on('SIGTERM', () => { void shutdown('SIGTERM').then(() => process.exit(0)) })
}

/* 兜底：别让一个未捕获异常把整个 server 静默带走（机器人掉线时的 promise 很难全部抓住） */
process.on('unhandledRejection', (e) => log(`⚠️ 未处理的 Promise 拒绝（已吞）：${e?.stack ?? e}`))
process.on('uncaughtException', (e) => log(`⚠️ 未捕获异常（已吞）：${e?.stack ?? e}`))
