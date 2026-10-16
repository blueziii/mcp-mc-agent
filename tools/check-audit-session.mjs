#!/usr/bin/env node
/**
 * check-audit-session.mjs —— 会话/状态层审计（F1–F12）的回归护栏
 *
 * 为什么需要它：2026-10-08 的会话/状态组审计（子代理报告，全文见「踩坑档案.md」F1–F12）
 *   发现的 12 条 bug **形状完全一样**：只有主路径判了状态、旁路没判。
 *   它们都不崩，而是给 AI 一个**看起来正常的错误世界**：
 *     · F1 `#scheduleReconnect(sub)` 把子服名当 opts ⇒ 自动重连**永远连不上**且无限重试，
 *          看门狗还注入"正在自动重连，先别再操作" ⇒ AI 停手死等一个永远不会来的重连；
 *     · F2 事件队列满 200 条后从**头部** splice，而 `waitSec` 拿 `events.length` 当游标
 *          ⇒ `slice(200)` 恒空 ⇒ 长挂机会话的唤醒通道**静默失效**；
 *     · F3 `mc_diag` 只判 `!b?.entity`、不判 `_client.ended` ⇒ 幽灵在线时报 `online:true`，
 *         而 `status()`/`requireBot()` 都说不在线 ⇒ 两个工具互相打脸，AI 永远不去 mc_connect；
 *     · F5 `peek` 给**最新** N 条、消费给**最旧** N 条，描述没写方向；
 *     · F6 `mc_lan` 把 socket 错误吞成"没听到"，恒 `ok:true`；
 *     · F7 `mc_ping` 回传的是**调用方给的值**而不是生效值（传 50 实际等 1000）；
 *     · F8–F12 小账：LABEL 缺 disconnect、`stats.suppressed` 永远 0、mc_disconnect 把
 *          "关不掉"说成"本来就没挂"、mc_config 会凭空创建看门狗、mc_capabilities 泄露家目录。
 *
 * 用法：node tools/check-audit-session.mjs
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const read = (p) => readFileSync(join(ROOT, p), 'utf8')

const INDEX = read('index.js')
const CORE = read('src/core.mjs')
/* 路线图第 ④ 条第三十一刀：连接层（connect / #scheduleReconnect / disconnect）搬进
 * `src\connection.mjs` ⇒ 这几条静态断言改读新模块，另补一条"core 确实是薄包装"的接线断言。 */
const CONN = read('src/connection.mjs')
const WATCH = read('src/watchdog.mjs')
const WAIT = read('src/wait.mjs')
const LAN = read('src/lan.mjs')
const PING = read('src/ping.mjs')

const { waitForEvents } = await import(new URL('../src/wait.mjs', import.meta.url))
const { listenLanBroadcast } = await import(new URL('../src/lan.mjs', import.meta.url))
const { statusPing } = await import(new URL('../src/ping.mjs', import.meta.url))
const { redactPath } = await import(new URL('../src/core.mjs', import.meta.url))
const { resolveStateDir } = await import(new URL('../src/config.mjs', import.meta.url))
const { resolveStateHome } = await import(new URL('../src/format.mjs', import.meta.url))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 1. F1 自动重连：别再把子服名当 opts ────────────────────────────────────────
section('1. F1 自动重连（`connect(sub)` 把子服名当 opts ⇒ 永远连不上 + 无限重试）')
{
  ok(/if \(typeof opts === 'string'\) opts = \{ subserver: opts \}/.test(CONN),
    'connect() 兜住老写法：字符串 = 只指定子服')
  ok(/self\._connectOpts = \{ host, port, subserver: sub, version, auth \}/.test(CONN),
    '连接成功前记下**真**连接参数（含 auth，只存内存）')
  ok(/await connect\(self, \{ \.\.\.o, subserver: sub \|\| o\.subserver \}, ctx\)/.test(CONN),
    '#scheduleReconnect 用记下的参数重连（不再把 sub 字符串塞进 connect）')
  // 只看真代码（注释里会引用旧写法当反例）
  const CONN_CODE = CONN.split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n')
  ok(!/connect\(self, sub\)/.test(CONN_CODE),
    '旧写法 `await this.connect(sub)` 已从代码里彻底移除（只在注释里留作反例）')
  ok(/maxReconnectAttempts/.test(CORE) && /tries >= max/.test(CONN),
    '重试有次数上限（DEFAULTS.maxReconnectAttempts 在 core，判据在 connection.mjs）')
  ok(/自动重连没有可用的登录参数/.test(CONN) && /willReconnect: false/.test(CONN),
    '没有登录参数 / 次数耗尽时如实回 `willReconnect:false`（看门狗据此收手并叫 AI mc_connect）')

  ok(/from '\.\/connection\.mjs'/.test(CORE) && /async connect \(opts = \{\}\) \{ return await connectImpl\(this, opts, this\.#connCtx\(\)\) \}/.test(CORE),
    'core 的 connect / #scheduleReconnect / disconnect 都是薄包装、并且确实 import 了 connection.mjs')

  // 行为：真发一次连接（端口 1 必拒）。只验"参数在连接一开始就被认到" ——
  //   修复前 `#scheduleReconnect(sub)` 走的是 `connect('lobby')`，auth 在这一层就丢了。
  const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))
  const b = new McBot({ host: '127.0.0.1', port: 1, logFile: join(process.env.TEMP ?? '.', 'wc-audit-session.log') })
  const quiet = console.error
  console.error = () => {}                      // mineflayer 会把 ECONNREFUSED 原样打出来，别污染套件输出
  const pending = b.connect({ host: '127.0.0.1', port: 1, auth: { mode: 'offline', name: 'audit_sess' } })
    .then(() => 'ok').catch((e) => String(e?.message ?? e))
  ok(b._connectOpts?.auth?.mode === 'offline' && b._connectOpts?.port === 1 && b._connectOpts?.host === '127.0.0.1',
    '行为：连接一开始就记下 host + auth（自动重连有料可用）',
    `_connectOpts = ${b._connectOpts?.host}:${b._connectOpts?.port} auth.mode=${b._connectOpts?.auth?.mode}`)
  await new Promise((r) => setTimeout(r, 600))
  try { b.bot?.quit?.() } catch { /* 已经断了就算了 */ }
  const msg = await Promise.race([pending, new Promise((r) => setTimeout(() => r('（连接还没返回，本机端口 1 必拒，这步只验参数）'), 2500))])
  console.error = quiet
  ok(!/缺少登录账户|缺少服务器地址/.test(msg),
    '行为：host + auth 都被认到（不是"缺少登录账户"这类参数错）', msg.slice(0, 60))
}

// ── 2. F2 唤醒游标按单调 seq，不按数组长度 ─────────────────────────────────────
section('2. F2 事件队列满 200 条后 `waitSec` 永远漏事件（从头部 splice ⇒ length 恒 200）')
{
  ok(/fromSeq/.test(WAIT) && /Number\(e\?\.seq \?\? 0\) > fromSeq/.test(WAIT),
    'waitForEvents 按 `e.seq > fromSeq` 判"有没有新事件"')
  ok(/this\.eventSeq = 0/.test(INDEX) && /seq: \+\+this\.eventSeq/.test(INDEX),
    '每个事件带单调递增的 seq（McSession.eventSeq）')

  // 行为：模拟"队列已满 200 条"（seq 1..200 全在 fromSeq 之前），再塞一条 seq=201
  const sess = { events: Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, kind: 'chat', text: `旧${i + 1}` })) }
  setTimeout(() => sess.events.push({ seq: 201, kind: 'chat', text: '新消息' }), 400)
  const r1 = await waitForEvents({ sess, fromSeq: 200, waitSec: 2, pollMs: 100 })
  ok(r1.reason === '有事件', '行为：队列满 200 条时也能等到新事件（修复前这里恒 null）', `reason=${r1.reason} waitedMs=${r1.waitedMs}`)
  ok(sess.events.length === 201, '行为：新事件还在队列里（没被 splice 掉）', `length=${sess.events.length}`)

  // 老写法确实会漏（证明这个护栏测的是真问题）
  const sess2 = { events: Array.from({ length: 200 }, (_, i) => ({ seq: i + 1, kind: 'chat', text: `旧${i + 1}` })) }
  const r2 = await waitForEvents({ sess: sess2, from: sess2.events.length, waitSec: 0.3, pollMs: 100 })
  ok(r2.reason === null, '对照：老写法（from = length）在满队列时确实漏事件', `reason=${r2.reason}`)

  const sess3 = { events: [{ seq: 1, kind: 'chat' }, { seq: 2, kind: 'lifecycle' }] }
  const r3 = await waitForEvents({ sess: sess3, fromSeq: 0, kind: 'chat', waitSec: 1, pollMs: 100 })
  ok(r3.reason === '有事件', 'kind 过滤仍然生效（只认 chat）', `reason=${r3.reason}`)
}

// ── 3. F3 mc_diag 别在幽灵在线时报 online:true ─────────────────────────────────
section('3. F3 mc_diag 在幽灵在线时报 online:true（只有主路径判了状态）')
{
  ok(/if \(!sess\.bot\.online \|\| !b\?\.entity\)/.test(INDEX),
    'mc_diag 用 `sess.bot.online`（和 status()/requireBot() 同一判据）')
  ok(/ghost: Boolean\(b\?\.entity\) && b\?\._client\?\.ended === true/.test(INDEX),
    'mc_diag 如实标出 ghost（连接已结束、entity 只是残留）')
}

// ── 4. F5 peek / 消费 的方向一致 ──────────────────────────────────────────────
section('4. F5 `peek` 给最新 N 条、消费给最旧 N 条（描述还没写方向）')
{
  ok(/peekEvents\(limit = 20, kind = null\)/.test(INDEX),
    '有独立 `peekEvents`（最早的先出，不删）')
  ok(/\? sess\.peekEvents\(limit, kind\)\s*\n\s*: sess\.drainEvents\(limit, kind\)/.test(INDEX),
    'mc_events 的 peek 与消费走同一方向')
  ok(/都是最早的先出/.test(INDEX),
    '描述里写清了方向（不然 AI 会以为 peek 是"看最新的"）')
}

// ── 5. F6 mc_lan 别把 socket 错误吞成"没听到" ──────────────────────────────────
section('5. F6 mc_lan 恒 ok:true、socket 错误全吞')
{
  ok(/warnings\.push\(/.test(LAN) && /加入多播组/.test(LAN),
    'lan.mjs 把 socket / addMembership 的失败记进 warnings')
  ok(/\{ found, warnings \}|found, warnings/.test(LAN),
    'listenLanBroadcast 回 `{found, warnings}`（不再只回裸数组）')

  // 行为：给一个非法的多播组，必须**如实报出来**，而不是"没人开 LAN 房"
  const r = await listenLanBroadcast({ group: 'not-a-multicast-group', seconds: 1 })
  const warns = Array.isArray(r?.warnings) ? r.warnings : []
  ok(Array.isArray(r?.found), '行为：返回结构是 `{found, warnings}`', `keys=${Object.keys(r ?? {}).join(',')}`)
  ok(warns.length > 0, '行为：非法多播组会报 warning（修复前是"安静地什么都没听到"）', warns[0] ?? '（无）')
  ok(/warnings\.length \? \{ warnings \}/.test(INDEX) || /warnings\.length \?/.test(INDEX),
    'mc_lan 把 warnings 带进工具返回')
}

// ── 6. F7 mc_ping 回传生效值 ─────────────────────────────────────────────────
section('6. F7 `timeoutMs` 只有上限没下限、回传的不是生效值')
{
  ok(/Math\.min\(Math\.max\(Number\(args\.timeoutMs\) \|\| 5000, 1_000\), 10_000\)/.test(INDEX),
    'mc_ping 把超时钳到 1000–10000（不再只有上限）')
  ok(/out\.timeoutMs = limit/.test(PING),
    'ping.mjs 回传**生效**的 limit（不再原样回传调用方给的值）')

  // 行为：传 50 → 生效值必须如实报 1000
  const p = await statusPing({ host: '127.0.0.1', port: 1, timeoutMs: 50 })
  ok(p.timeoutMs === 1000, '行为：传 timeoutMs=50 时回传生效值 1000', `timeoutMs=${p.timeoutMs}`)
}

// ── 7. F8 / F9 看门狗的小账 ──────────────────────────────────────────────────
section('7. F8/F9 看门狗：LABEL 缺 disconnect、`stats.suppressed` 永远 0')
{
  ok(/disconnect: '断线了'/.test(WATCH), 'LABEL 表补了 disconnect（不再印英文 `disconnect`）')
  ok(/#suppress \(kind\)/.test(WATCH) && /this\.stats\.suppressed\+\+/.test(WATCH),
    '被 gate 挡下的唤醒真的记进 stats.suppressed')
  const suppressed = (WATCH.match(/return this\.#suppress\(/g) ?? []).length
  ok(suppressed >= 8, '8 处 wakeOn 闸门都改成 #suppress（不再静默 return）', `实测 ${suppressed} 处`)
}

// ── 8. F10 mc_disconnect 的三态 ───────────────────────────────────────────────
section('8. F10 mc_disconnect 把"关不掉"说成"本来就没挂"')
{
  ok(/watchErr \? `关不掉（\$\{watchErr\}）`/.test(INDEX),
    'disarm 抛错时如实说"关不掉"（不再吞成"本来就没挂"）')
  ok(/online: Boolean\(sess\.bot\.online\)/.test(INDEX),
    'online 按真实连接状态回（不再硬编码 false）')
}

// ── 9. F11 mc_config 别凭空创建看门狗 ─────────────────────────────────────────
section('9. F11 mc_config 凭空创建看门狗、reset 少回 defaults')
{
  ok(/const wantsChange = Boolean\(args\.reset\) \|\| Object\.keys\(args\.patch \?\? \{\}\)\.length > 0/.test(INDEX),
    '先判"是不是真要改"，只读调用不挂看门狗')
  ok(/if \(!sess\.watchdog && !wantsChange\)/.test(INDEX),
    '没挂看门狗且只是读配置时直接回默认值')
}

// ── 10. F12 mc_capabilities 别泄露家目录 ─────────────────────────────────────
section('10. F12 mc_capabilities 暴露宿主绝对路径（含用户名）')
{
  /* 路线图第 ④ 条第二刀：`redactPath` 已搬进 `src/format.mjs`（core 里只剩 import + 用法）。 */
  ok(/export function redactPath \(p\)/.test(read('src/format.mjs')), 'redactPath() 在 src/format.mjs 里（第二刀搬走的）')
  ok(/redactPath/.test(CORE), 'core.mjs 里确实在用 redactPath（薄包装/调用点）')
  const wrapped = (INDEX.match(/redactPath\(/g) ?? []).length
  ok(wrapped >= 5, 'mc_capabilities 的 5 个路径字段全包了 redactPath（dir/file/memoryDir/workspaceConfigFile/agentsMd）', `实测 ${wrapped} 处`)

  // 行为：临时把状态目录指到一个固定位置，看脱敏是否按它切
  //   🔴 锚点从 `DSH_HOME` 改成了 `MCP_MC_AGENT_STATE_DIR`（2026-10-16 审计：MCP 版以前按 `~/.dsh` 切前缀，
  //     真实状态目录是 `~/.mcp-mc-agent` ⇒ 一条都切不掉、主机用户名照样进工具返回）。
  const prevState = process.env.MCP_MC_AGENT_STATE_DIR
  process.env.MCP_MC_AGENT_STATE_DIR = join(HERE, 'tmp-state-probe')
  try {
    const st = process.env.MCP_MC_AGENT_STATE_DIR
    ok(redactPath(join(st, 'logs', 'x.log')) === '$MCP_MC_AGENT_STATE_DIR/logs/x.log',
      '行为：状态目录前缀换成 $MCP_MC_AGENT_STATE_DIR', redactPath(join(st, 'logs', 'x.log')))
    ok(redactPath(st) === '$MCP_MC_AGENT_STATE_DIR', '行为：状态目录本身也换掉')
    ok(redactPath(join(st, 'msa', 'acc-1', 'cache.json')) === '$MCP_MC_AGENT_STATE_DIR/msa/acc-1/cache.json',
      '行为：多级子路径照样切')
    ok(redactPath('C:\\somewhere\\else') === 'C:\\somewhere\\else', '行为：不在状态目录下的路径原样返回')
    ok(redactPath('') === '' && redactPath(null) === '', '行为：空值安全')
  } finally {
    if (prevState === undefined) delete process.env.MCP_MC_AGENT_STATE_DIR
    else process.env.MCP_MC_AGENT_STATE_DIR = prevState
  }
}

// ── 10b. 状态目录名只能有一处出处 ────────────────────────────────────────────
section('10b. 状态目录名两处副本走偏（真实目录 `~/mcp-mc-agent`，脱敏锚点找 `~/.mcp-mc-agent`）')
{
  /* 🔴 2026-10-16 审计第二次踩同一个坑：`config.mjs` 的 `STATE_DIR_NAME` 写的是**没有点**的
   *   `'mcp-mc-agent'`（它自己上一行的注释写的却是 `~/.mcp-mc-agent`），而 `format.mjs`
   *   的 `resolveStateHome()` 写的是**带点**的 ⇒ 状态目录真的落在 `~/mcp-mc-agent`，
   *   脱敏锚点却找 `~/.mcp-mc-agent` ⇒ 又变成"一条路径都切不掉"。
   *   修法：名字只有一个出处，`format.mjs` import `config.mjs` 的 `STATE_DIR_NAME`。 */
  const FORMAT = read('src/format.mjs')
  const CONFIG = read('src/config.mjs')
  ok(/export const STATE_DIR_NAME = '\.mcp-mc-agent'/.test(CONFIG),
    'config.mjs 的 STATE_DIR_NAME 带点（与 README / CHANGELOG / format 一致）')
  ok(/import \{ STATE_DIR_NAME \} from '\.\/config\.mjs'/.test(FORMAT),
    'format.mjs 从 config.mjs import 这个名字，不再自己写一遍')
  ok(!/join\((fromEnv|homedir\(\)|process\.cwd\(\)), '[^']*mcp-mc-agent'\)/.test(FORMAT),
    'format.mjs 里没有写死的目录名字面量了')

  // 行为：两个函数必须指同一个地方 —— 这是"脱敏能不能生效"的前提
  const envKeys = ['MCP_MC_AGENT_STATE_DIR', 'MCP_MC_AGENT_DIR', 'MCP_MC_AGENT_HOME']
  const saved = envKeys.map((k) => [k, process.env[k]])
  for (const k of envKeys) delete process.env[k]
  try {
    const a = resolveStateDir({ env: process.env })
    const b = resolveStateHome()
    ok(a === b, '行为：resolveStateDir() 与 resolveStateHome() 指同一个目录', `${a} vs ${b}`)
    ok(/[\\/]\.mcp-mc-agent$/.test(a), '行为：默认落在 ~/.mcp-mc-agent（带点）', a)
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

// ── 11. F4 注入失败时别"先打断、后什么都不给" ─────────────────────────────────
section('11. F4 `#inject` 先打断等待、再尝试注入；两条路都没有时只写自己的 log')
{
  ok(/#injectFailed \(why, text\)/.test(WATCH),
    '注入失败有专门分支 #injectFailed（不再只写自己的 log 就 return）')
  ok(/pushEvent\?\.\('lifecycle'/.test(WATCH),
    '注入失败会写进会话事件（AI 能通过 mc_events 知道"看门狗想叫我没叫到"）')
  ok(/#interruptWait \(kind\)/.test(WATCH),
    '打断等待抽成 #interruptWait，只在注入成功后才调')
  // 顺序：源码里 `#interruptWait(` 的调用点必须都在 steer 尝试**之后**（即 #inject 里不再开头就打断）
  const injectBody = WATCH.slice(WATCH.indexOf('#inject (text, kind)'), WATCH.indexOf('#injectFailed (why, text)'))
  ok(!/^\s*(try \{ )?this\.#interruptWait\(/m.test(injectBody.slice(0, injectBody.indexOf('steer'))),
    '#inject 开头不再先打断（避免"等待被打断了、唤醒却没到"）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
