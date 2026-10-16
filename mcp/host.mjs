/**
 * mcp-mc-agent / mcp/host.mjs —— 给 index.js 的 `apply(ctx, config)` 喂一个**最小宿主桩**
 * ============================================================================
 * 为什么这么做（而不是把 index.js 拆了重写）：
 *
 *   `index.js` 里 3 万行里绝大部分是**真正的资产** —— 34 个工具的入参表、执行体、动作调度、
 *   看门狗、记忆、任务状态机，以及 53 个 `src/` 模块。它们跟 DSH 的耦合只有薄薄一层：
 *   一个 `ctx` 对象（服务查询 / 工具注册 / 生命周期）和一个 `exec` 对象（当前会话的 agent）。
 *
 *   所以 MCP 化的最小改动是：**保留 `apply()` 原样，给它一个假 ctx / 假 exec**。
 *   这样上游 `mcp-mc-agent` 的每一处修复都能直接搬过来，不用两套代码各修一遍。
 *
 * 这个桩要实现的东西（对照 index.js 里全部 `ctx.*` 用法）：
 *
 *   ctx.get(name)        → 服务查询。DSH 专属的服务一律 undefined（代码里都做了 `?.` 兜底），
 *                          只有四个要真给：`agents`（伪 agent 表）、`attachments`（图片内联）、
 *                          `agentPresets`（让"MC 模式"判据成立）、`jobs`（后台任务清理）。
 *   ctx.inject(deps, cb) → 立即回调（MCP 下服务永远是"已就绪"）。
 *   ctx.effect(fn, label) → 立刻执行，把返回的清理函数收起来。
 *   ctx.on(ev, handler)  → 记下来，返回清理函数。**注意 `agent/pre-step` 是 DSH 的 waterfall，
 *                          在 MCP 下永远不会触发**；提示词的投递改走 MCP 的 instructions/resource
 *                          （见 server.mjs 的 `#promptItems`）。
 *   ctx.tools.register   → 收集进工具表（server.mjs 拿它转成 MCP tools/list）。
 *   ctx.tools.guard      → **故意不生效**。原版 guard 是"按 agent preset 分档的调用级兜底"，
 *                          判据是 `mcPresetIdOf(agent)`；MCP 下没有 preset 体系，套上去会把
 *                          所有 `mc_*` 工具全拒掉。MCP 的隔离靠"这个进程只暴露这些工具"。
 *   ctx.webServer        → 空实现（原版的 /api/mc 是给 DSH 状态条 UI 用的）。
 *
 * exec 桩（每次工具调用造一个）：
 *   `{ agent, signal, __actionId: null }` —— `agent` 就是那个伪 agent，字段与 DSH 的
 *   `exec.agent` 对齐：`id` / `session.header.cwd` / `ctx` / `status` / `inbox` /
 *   **`steer(message)`**（最后这个是把 DSH 的"叫醒"接到 onWake 上的关键，别删）。
 * ============================================================================
 */
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'

/** MCP 下只有一个"会话"：整个 server 进程 = 一个 Minecraft 角色 */
export const MCP_SESSION_ID = 'mcp'

const noop = () => {}

/** cwd 的规范路径（解析软链/junction；解析不了就用原样 —— 目录可能还不存在） */
const realCwd = (cwd) => {
  const s = String(cwd ?? '')
  try { return realpathSync(s) } catch { return s }
}

/**
 * cwd → **稳定**的伪工作区 id（uuid 形状，因为 index.js 的分享地址把它当 uuid 拼）。
 * 用 sha1 派生而不是随机 uuid：分享 URL 里带着它，server 重启后必须还是同一个。
 */
const workspaceIdOf = (cwd) => {
  const h = createHash('sha1').update(realCwd(cwd)).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * 从一条 `userMessage()`（宿主 `UserMessage` 形状）里把正文抠出来。
 * 形状见 `src/user-message.mjs`：`{role:'user', content:[{type:'text',text}], source:{kind,form,summary}}`。
 * 也容忍直接传字符串（有些调用点图省事）。
 */
const steerTextOf = (message) => {
  if (typeof message === 'string') return message.trim()
  const content = message?.content
  if (!Array.isArray(content)) return ''
  return content
    .map((c) => (typeof c === 'string' ? c : (c?.type === 'text' ? String(c.text ?? '') : '')))
    .filter((s) => s !== '')
    .join('\n')
    .trim()
}

/** 默认日志走 **stderr** —— stdio 传输的 stdout 是 JSON-RPC 通道，绝不能被日志污染 */
const defaultLog = (...args) => {
  try { process.stderr.write(`[mcp-mc-agent] ${args.join(' ')}\n`) } catch { /* 写不进去就算了 */ }
}

/**
 * 造一个宿主桩。
 *
 * @param {object} [options]
 * @param {string} [options.cwd]       会话工作区（记忆/落盘都挂它下面）；默认 `process.cwd()`
 * @param {Function} [options.onWake]  看门狗唤醒钩子 `(text, kind) => void`；见 src/watchdog.mjs
 * @param {Function} [options.log]     日志函数（默认 stderr）
 * @param {Function} [options.onRegister] 工具注册回调 `(tool) => void`（扩展**异步**加载，所以要有）
 * @param {Function} [options.credentials] 凭据服务（见 mcp/credentials.mjs）
 * @returns {{ctx:object, makeExec:Function, tools:Map, bridge:object, dispose:Function,
 *            beginCall:Function, endCall:Function, setAgentStatus:Function}}
 */
export function createHost (options = {}) {
  const {
    cwd = process.cwd(),
    onWake = null,
    log = defaultLog,
    onRegister = null,
    credentials = null,
    fileServer = null,
  } = options

  /** 工具表：name → 工具定义（`ctx.tools.register` 收集到的，形状见 src/tool-def.mjs） */
  const tools = new Map()
  /** 生命周期清理函数（`ctx.effect` 收的） */
  const disposers = []
  /** 事件监听器（`ctx.on` 收的；MCP 下**不会**被触发，只保证代码不报错） */
  const listeners = []
  /** 本次工具调用期间收集到的图片（→ MCP image content） */
  let imageSink = null
  /** `ctx.webServer.register` 收下的路由（MCP 下不挂载，只留痕） */
  const webRoutes = []
  /** apply() 内部挂出来的桥（记忆根、提示词条目……），见 index.js 末尾的 `ctx.__mcpBridge` */
  const bridge = {}

  /* ── 伪 agent：DSH 的 `exec.agent` 对齐件 ────────────────────────────────
   * 🔴 四个字段是**必须**的，缺一个就有功能静默退化：
   *   · `id`                → McRegistry.getOrCreate(agent.id)，也是 jobs/lock 的归属键
   *   · `session.header.cwd` → 记忆根、落盘路径（`workspaceOf` 唯一来源）
   *   · `ctx`               → `mcPresetIdOf()` 第一行就是 `if (!agent?.ctx) return null`，
   *                           没有它 ⇒ 判据恒 false ⇒ 看门狗闸门把**所有**唤醒都丢掉
   *   · `steer(message)`    → **DSH 的"叫醒 AI"通道**。见下面那段注释，这个最容易被漏掉。
   * ------------------------------------------------------------------- */
  const agent = {
    id: MCP_SESSION_ID,
    status: 'idle',
    ctx: null,                 // 下面补（要引用 ctx 本身）
    session: { header: { id: MCP_SESSION_ID, cwd } },
    /* 提示词对账（`reconcileNotices`）要读这三样；MCP 下没有宿主 inbox，
       给一个空数组即可 —— 条目会通过 MCP instructions/resource 送出去。 */
    inbox: { nextStep: [] },
    snapshotEvents: () => [],

    /* 🔴🔴 `agent.steer(message)` —— **MCP 版的"叫醒"就靠它**。
     *
     * DSH 下宿主提供 `agent.steer()`：把一条 plugin notice 注入对话（空闲起一轮、运行中
     * 下一步插话）。MCP **没有**这个能力，所以这里把它接到 `onWake`（= 事件队列 +
     * MCP logging 通知 + `mc://wake-log`）。
     *
     * 为什么必须在**桩上**补、而不是去改每个调用点：全仓 `agent.steer` 的调用点很多，
     * 而且大多是**守卫式**的 ——
     *   · `src/watchdog.mjs:660`   `if (agent && typeof agent.steer === 'function')`
     *   · `extensions/mc_auto.mjs:818` `if (!agent || typeof agent.steer !== 'function') return 'none'`
     *   · `extensions/mc_auto.mjs:1134` 注释原话：「没人值守时（没有 steer 通道）就只记档」
     * 没有这个方法时它们**全部静默退化**：自主层的"被怪打叫醒 AI"、"水下恢复报账"、
     * "空闲决策层叫醒"一条都发不出来，而且不报错、不写日志 —— 属于最难发现的那类坑。
     * 补在这里 ⇒ 所有调用点一行不用改，上游改动也能整块搬过来。 */
    steer: (message) => {
      const text = steerTextOf(message)
      if (!text) return
      const kind = message?.source?.form ?? 'notice'
      /* `running` 只用于日志措辞（MCP 下没有"插话"这回事，两种都是写进队列等人来取） */
      const running = agent.status === 'running'
      try {
        onWake?.(text, kind, running)
      } catch (e) { log(`agent.steer → onWake 失败：${e?.message ?? e}`) }
    },
  }

  /* ── ctx 桩 ─────────────────────────────────────────────────────────── */

  /** DSH 服务查询。只给 MCP 下真正有意义的四个，其余一律 undefined（调用点都有 `?.`）。 */
  const services = {
    /* 伪 agent 表：`ctx.get('agents').get(sessionId)`。用于 stopSession / safeAgentById 等 */
    agents: { get: (id) => (String(id) === MCP_SESSION_ID ? agent : null) },
    /* 🔴 让"MC 模式"判据成立。MCP 下整个 server 就是 MC 会话，没有 preset 可切。
     *    `composedPreset()` 返回 `minecraft`（在 DEFAULT_CONFIG.mcModePresets 里）。 */
    agentPresets: { composedPreset: () => 'minecraft' },
    /* 图片内联：`attachments.saveImage({data, mediaType, name})`。
     *    只在**工具调用期间**有值 —— 图片收进 imageSink，调用结束由 server.mjs
     *    转成 MCP 的 `{type:'image', data, mimeType}` content block。 */
    get attachments () {
      if (!imageSink) return undefined
      return {
        async saveImage ({ data, mediaType = 'image/png', name = 'image.png' } = {}) {
          const bytes = data instanceof Uint8Array ? data : new Uint8Array(data ?? [])
          imageSink.push({ data: bytes, mediaType, name })
          return { id: `mcp-${imageSink.length}`, name, mediaType, bytes: bytes.length, mcp: true }
        },
      }
    },
    /* 后台任务表：MCP 下没有 DSH 的 jobs-local 服务，给一个能 list/kill 的本地实现，
     * 让 `mc_stop` 的"强清后台任务"路径不报错（看门狗自己也在 jobs 里，见 watchdog.mjs:327/369）。 */
    jobs: makeJobRegistry(),
    /* 工作区注册表：`ctx.get('workspaceRegistry').list()` → `[{id, path}]`。
     *   index.js:620 的 `workspaceRows()` 用它做两件事：
     *     ① `workspaceIdOfCwd(cwd)`（index.js:628）—— **`mc_kit_express` 靠它拿"分享地址里的工作区指代"**
     *        （index.js:3406）。不给的话那个工具在 MCP 下**每次都抛**
     *        「这个会话的工作区不在 DSH 的工作区注册表里…请让用户在工作区选择器里选中该目录」
     *        —— 一句 MCP 下根本做不到的指引。
     *     ② `installArchiveGuard`（index.js:~1000）的归档保护；给不了真注册表时它只记一行日志，安全。
     *   id 用 **cwd 的稳定哈希**（不是随机 uuid）：分享 URL 里带着它，重启后必须还是同一个。 */
    workspaceRegistry: {
      list: () => [{ id: workspaceIdOf(cwd), path: realCwd(cwd) }],
      get: (id) => (String(id) === workspaceIdOf(cwd) ? { id: workspaceIdOf(cwd), path: realCwd(cwd) } : null),
    },
  }

  const ctx = {
    /* ── 服务查询 ── */
    get (name) {
      const key = String(name ?? '')
      if (Object.hasOwn(services, key)) return services[key]
      /* 宿主给的状态目录解析函数：MCP 下没有宿主，返回 undefined 让 resolveStateDir 走自己的兜底 */
      if (key === 'dshHomePath') return undefined
      return undefined
    },
    /* ── 依赖注入 ─────────────────────────────────────────────────────────
     * 🔴 **必须异步回调**，不能同步调。DSH 里 `ctx.inject` 是"服务就绪后再叫我"，
     *    回调一定在**当前同步块之后**跑。同步调会踩 TDZ：
     *      · index.js:4444 `ctx.inject(['agentPresets'], …)` 的回调里用了 `ensureMcPreset`，
     *        而它到 index.js:4464 才 `const` 定义 —— 同步调 ⇒
     *        `ReferenceError: Cannot access 'ensureMcPreset' before initialization`。
     *      · index.js:1046 `ctx.inject(['workspaceRegistry'], …)` 同理（`installArchiveGuard`）。
     *    用 `queueMicrotask`：语义上"本同步块之后立刻"，又早于任何工具调用。 */
    inject (_deps, cb) {
      if (typeof cb !== 'function') return () => {}
      queueMicrotask(() => {
        try { cb(ctx) } catch (e) { log(`ctx.inject 回调失败：${e?.message ?? e}`) }
      })
      return () => {}
    },
    /* ── 生命周期 ── */
    effect (fn, label) {
      let off = null
      try { off = fn() } catch (e) { log(`ctx.effect(${label ?? '?'}) 执行失败：${e?.message ?? e}`) }
      if (typeof off === 'function') disposers.push({ off, label })
      return () => { try { off?.() } catch { /* 清理失败无所谓 */ } }
    },
    /* ── 事件：收下不触发（MCP 没有 DSH 的 agent 生命周期事件） ── */
    on (event, handler) {
      listeners.push({ event, handler })
      return () => {
        const i = listeners.findIndex((l) => l.handler === handler)
        if (i >= 0) listeners.splice(i, 1)
      }
    },
    /* ── 日志 ── */
    logger: {
      info: (...a) => log(...a),
      warn: (...a) => log('⚠️', ...a),
      error: (...a) => log('🔴', ...a),
      debug: (...a) => log(...a),
    },
    /* ── 工具 ── */
    tools: {
      register (tool) {
        if (!tool?.name) return
        tools.set(tool.name, tool)
        try { onRegister?.(tool) } catch (e) { log(`工具注册回调失败（${tool.name}）：${e?.message ?? e}`) }
      },
      /* 🔴 故意不生效：原版 guard 按 agent preset 分档，MCP 下会把 mc_* 全拒掉。
       *    MCP 的隔离边界是"这个进程只注册了这些工具"，不需要调用级兜底。 */
      guard (_fn) { return () => {} },
    },
    /* ── Web 服务：原版的 /api/mc 是 DSH 状态条 UI 用的，MCP 下不存在。
     *    收下注册请求（`{path, handler}`）只为留痕/将来挂载，**不启用**。 */
    webServer: {
      register: (route) => { webRoutes.push(route); return noop },
    },
    /* ── 有没有内置文件服务：`null` = 没有（stdio 传输）。
     *    `mc_kit_express` 靠它决定"能不能给一个点得开的分享链接"——
     *    MCP 下没有宿主 webServer，发布区的 URL 谁也服务不了，给出去就是死链。 ── */
    __mcpFileServer: fileServer,
    /* ── 宿主没给的能力（`agent.steer` / `sessionController`）由看门狗兜底到 onWake ── */
    __mcpWake: typeof onWake === 'function' ? onWake : undefined,
    /* ── 桥：apply() 末尾会把记忆根 / 提示词条目挂上来 ── */
    __mcpBridge: bridge,
  }
  agent.ctx = ctx
  /* 凭据服务：MCP 版是本地文件（`<stateDir>/credentials.json`，0600）。
     接口与 DSH 的 `ctx.credentials` 对齐：listRecords / readRecord / modifyRecord / deleteRecord。 */
  if (credentials) services.credentials = credentials

  /* ── exec 桩 ────────────────────────────────────────────────────────── */

  const makeExec = (signal = null) => ({
    agent,
    signal: signal ?? new AbortController().signal,
    __actionId: null,
  })

  /* ── 每次工具调用的图片收集 ─────────────────────────────────────────── */

  /** 开始一次工具调用：之后的 `attachments.saveImage` 会收进本次调用 */
  const beginCall = () => { imageSink = [] }
  /** 结束一次工具调用：返回本次收到的图片（并停止收集） */
  const endCall = () => {
    const out = imageSink ?? []
    imageSink = null
    return out
  }

  /** 看门狗会读 `sess.watchdog.agent.status` 判断"运行中 / 空闲" */
  const setAgentStatus = (status) => { agent.status = String(status ?? 'idle') }

  const dispose = () => {
    for (const { off, label } of disposers.reverse()) {
      try { off() } catch (e) { log(`清理 ${label ?? '?'} 失败：${e?.message ?? e}`) }
    }
    disposers.length = 0
    listeners.length = 0
  }

  return { ctx, agent, makeExec, tools, bridge, webRoutes, dispose, beginCall, endCall, setAgentStatus, log }
}

/**
 * 本地后台任务表（替代 DSH 的 `jobs-local` 服务）。
 *
 * 为什么要有：`src/watchdog.mjs` 在"挂机超时/被踢"时会 `ctx.get('jobs')?.kill(jobId, owner, reason)`
 * 掐掉自己的后台任务，`index.js` 的 `mc_stop` 也会按会话 id 清一遍。MCP 下没有宿主 jobs 服务，
 * 给一个**真能 list/kill** 的本地表，行为就与 DSH 下一致（而不是静默 `?.` 掉）。
 *
 * 接口按 DSH `jobs-local` 的公开形状裁剪：`register/list/kill/owner`。
 */
function makeJobRegistry () {
  const jobs = new Map()
  let seq = 0
  return {
    /* 🔴 宿主 `jobs-local` 的真接口是 **`start(spec)`**（不是 `register`）：
     *   `spec = { kind, label, owner, run }`，`run()` 返回 `{cancel, done, readOutput}`，
     *   返回值是 **job id 字符串**。看门狗 `#startJob()`（src/watchdog.mjs:386）走的就是它 ——
     *   少了这个方法的直接后果是每次 arm() 都撞 TypeError 被 catch 吞掉、
     *   静默降级成"无 job 模式"（`mc_stop` 就清不掉看门狗了）。 */
    start (spec = {}) {
      const id = `mcp-job-${++seq}`
      let hooks = null
      try { hooks = typeof spec.run === 'function' ? spec.run() : null } catch (e) { hooks = null; void e }
      jobs.set(id, {
        id,
        kind: spec.kind ?? 'task',
        label: spec.label ?? null,
        owner: spec.owner,              // 会话 id 字符串（与 DSH 口径一致）
        startedAt: Date.now(),
        kill: (reason) => { try { hooks?.cancel?.(reason) } catch { /* 任务自己的收尾失败不影响调用方 */ } },
      })
      // 任务自己结算（done resolve）后自动摘掉 —— 否则 list() 里永远挂着已完成的 job
      Promise.resolve(hooks?.done).then(
        () => { jobs.delete(id) },
        () => { jobs.delete(id) },
      )
      return id
    },
    /** 兼容写法：直接登记一个已存在的 job（包内目前没人用，留着防扩展用到） */
    register ({ id, owner, kind = 'task', kill = null } = {}) {
      if (!id) return null
      jobs.set(String(id), { id: String(id), owner, kind, kill, startedAt: Date.now() })
      return String(id)
    },
    /** DSH 的 `list(caller)` 口径：自己的 + 无主的 */
    list (caller) {
      const me = caller == null ? null : String(caller)
      return [...jobs.values()].filter((j) => j.owner === undefined || me === null || String(j.owner) === me)
    },
    kill (id, caller, reason) {
      const j = jobs.get(String(id))
      if (!j) return false
      if (j.owner !== undefined && caller != null && String(j.owner) !== String(caller)) {
        throw new Error(`job ${id} 不属于 ${caller}`)
      }
      jobs.delete(String(id))
      try { j.kill?.(reason) } catch { /* 任务自己的收尾失败不影响调用方 */ }
      return true
    },
    owner (id) { return jobs.get(String(id))?.owner },
    size () { return jobs.size },
  }
}

/** 状态目录的默认位置（与 src/config.mjs 的 resolveStateDir 同一套规则） */
export const stateDirHint = () => {
  const explicit = String(process.env.MCP_MC_AGENT_STATE_DIR ?? '').trim()
  if (explicit) return explicit
  const home = String(process.env.MCP_MC_AGENT_HOME ?? '').trim()
  return join(home || process.env.HOME || process.env.USERPROFILE || '.', 'mcp-mc-agent')
}
