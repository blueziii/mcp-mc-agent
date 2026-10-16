#!/usr/bin/env node
/**
 * check-logging.mjs —— 日志基建（2026-10-06 用户"你看下日志哪里可以优化的"）
 *
 * 为什么需要它：主日志 1455 行里 **59.7% 是启动噪声**（依赖横幅每个连接重打一遍、账户/归档/
 * 记忆播种每会话重打一遍），时间戳是 **UTC**（比本地早 8 小时、跨天看不出是哪天），没有版本标记，
 * 从不轮转（selfcheck.log 已 1.2 MB / 7815 行）。这套断言锁住五件事：
 *   ① `stamp()` 是**本地** `MM-DD HH:MM:SS`；② `logDebug()` 默认不落盘、`MC_LOG_LEVEL=debug` 才落；
 *   ③ `logOnce()` 在**整个进程**内只打一次 —— 必须跨模块实例有效（每个 MC 连接都会重新 import 一份 core.mjs）；
 *   ④ 超过 `MC_LOG_MAX_BYTES` 会改名轮转、只留 `MC_LOG_KEEP` 份；⑤ 旧的噪声/UTC/成对写法不再回潮。
 *
 * 🔴 2026-10-08（路线图第 ④ 条第五刀）：这些函数**整体搬到了 `src/log.mjs`**，
 *    `core.mjs` 只是 re-export（外部 import 一行没改）。所以 ⑦ 的静态断言改成查 `src/log.mjs`，
 *    并补一条"`core.mjs` 确实 re-export 了"（否则"搬走 + 忘接"也会绿）。
 *    另外：轮转上限现在是**现读**环境变量 —— 模块只加载一次，加载时读死会让本节 ⑥ 永远读到旧值。
 *
 * 用法：node tools/check-logging.mjs
 *   ⚠️ 必须从**包目录**跑（要 node_modules）；工作区根目录跑会因为解析不到 mineflayer 而 ERR_MODULE_NOT_FOUND。
 */
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 🔴 必须在 import core.mjs **之前**设好：`MC_LOG` 是模块加载时读进 `DEFAULTS` 的
 *    （真机上由环境变量给，测试里这样喂）。
 *    第五刀之后 `MC_LOG_MAX_BYTES` / `MC_LOG_KEEP` 是**轮转时现读**的（`src/log.mjs`
 *    整个进程只加载一次，加载时读死的话本节 ⑥ 会永远读到旧值）。 */
const TMP = mkdtempSync(join(tmpdir(), 'wc-logging-'))
const LOG = join(TMP, 'mcp-mc-agent.log')
process.env.MC_LOG = LOG
process.env.MC_LOG_MAX_BYTES = String(10 * 1024 * 1024)     // 本节别轮转，留给 ⑥ 单独测
process.env.MC_LOG_KEEP = '2'
delete process.env.MC_LOG_LEVEL

const CORE_URL = new URL('../src/core.mjs', import.meta.url).href
const LOG_URL = new URL('../src/log.mjs', import.meta.url).href
const core = await import(CORE_URL)
const { stamp, logLevel, logLine, logDebug, logOnce, McBot } = core

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }
const count = (hay, needle) => hay.split(needle).length - 1
const p2 = (n) => String(n).padStart(2, '0')

/* ─────────── ① stamp()：本地时间 ─────────── */
section('① stamp() —— 本地 `MM-DD HH:MM:SS`（原来用 toISOString 的 UTC 时分秒）')
{
  const now = new Date()
  const want = `${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`
  ok(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp()), '格式是 `MM-DD HH:MM:SS`', stamp())
  ok(stamp() === want, '用的是**本地**时间（和 UTC 不同也不受影响）', `${stamp()} vs ${want}`)
  ok(stamp(new Date(2026, 9, 6, 23, 34, 7)) === '10-06 23:34:07', '月/日补零、24 小时制', stamp(new Date(2026, 9, 6, 23, 34, 7)))
  ok(stamp(new Date(2026, 0, 1, 0, 0, 0)) === '01-01 00:00:00', '零点/元旦也补零', stamp(new Date(2026, 0, 1, 0, 0, 0)))
}

/* ─────────── ② logLevel()：级别 ─────────── */
section('② logLevel() —— `MC_LOG_LEVEL=quiet|info|debug`（默认 info）')
{
  ok(logLevel() === 1, '默认 info', String(logLevel()))
  process.env.MC_LOG_LEVEL = 'debug'
  ok(logLevel() === 2, 'debug', String(logLevel()))
  process.env.MC_LOG_LEVEL = 'quiet'
  ok(logLevel() === 0, 'quiet', String(logLevel()))
  process.env.MC_LOG_LEVEL = '瞎写的'
  ok(logLevel() === 1, '不认识的值退回 info（不静音）', String(logLevel()))
  delete process.env.MC_LOG_LEVEL
}

/* ─────────── ③ logLine / logDebug ─────────── */
section('③ logLine 落盘（本地时间）、logDebug 只在 debug 落盘')
{
  const line = logLine('测试行 A')
  ok(line.includes('[mcp-mc-agent ') && line.endsWith('测试行 A'), 'logLine 返回的整行带前缀', line)
  const body = rd(LOG)
  ok(body.includes(`[mcp-mc-agent ${stamp()}] 测试行 A`), '写进了 MC_LOG 指的文件（本地时间）')
  ok(!/\[\d{4}-\d{2}-\d{2}T/.test(body), '不再出现 ISO（UTC）时间戳')
  ok(count(body, '测试行 A') === 1, '一行一次', String(count(body, '测试行 A')))
  ok(logDebug('不该出现的调试行').length > 0, 'logDebug 仍然返回整行（调用方可能要用）')
  ok(!rd(LOG).includes('不该出现的调试行'), 'info 级别下 logDebug **不落盘**')
  process.env.MC_LOG_LEVEL = 'debug'
  logDebug('该出现的调试行')
  ok(rd(LOG).includes('该出现的调试行'), 'debug 级别下落盘（要查的时候能开）')
  delete process.env.MC_LOG_LEVEL
}

/* ─────────── ④ logOnce：进程内一次，且跨模块实例 ─────────── */
section('④ logOnce() —— 每个连接重打一遍的启动横幅只留一行（跨模块实例）')
{
  ok(logOnce('check-logging:k1', '只该出现一次的行') === true, '第一次返回 true（真打了）')
  ok(logOnce('check-logging:k1', '只该出现一次的行') === false, '第二次返回 false（跳过）')
  ok(count(rd(LOG), '只该出现一次的行') === 1, '文件里只有一行', String(count(rd(LOG), '只该出现一次的行')))
  const before = count(rd(LOG), '只该出现一次的行')
  /* 第五刀之后 `logOnce` 住在 `src/log.mjs`：core.mjs 只是 re-export ⇒ 换一份 core 实例
   * 拿到的是**同一个**函数对象（这本身就是要验证的效果）。要模拟"下一个连接"，
   * 得换一份 **log.mjs** 实例 —— 那才是"模块级变量拦不住"的那个边界。 */
  const core2 = await import(`${CORE_URL}?fresh=1`)
  ok(core2.logOnce === logOnce, 'core 的 fresh 实例 re-export 的还是同一份 log.mjs（第五刀的效果）')
  const log2 = await import(`${LOG_URL}?fresh=1`)
  ok(log2.logOnce !== logOnce, '换一份 log.mjs 实例：确实拿到了新的函数对象')
  ok(log2.logOnce('check-logging:k1', '只该出现一次的行') === false,
    '新实例也认得出"这个 key 打过了"（靠 globalThis，不是模块级变量）')
  ok(count(rd(LOG), '只该出现一次的行') === before, '没有多打一行', String(count(rd(LOG), '只该出现一次的行')))
}

/* ─────────── ⑤ McBot.log / logDebug / logOnce ─────────── */
section('⑤ McBot.log —— 本地时间 + 机器人短标签（多会话共用一份日志时能分辨）')
{
  const mcLog = join(TMP, 'mc.log')
  const mc = new McBot({ logFile: mcLog, auth: { name: 'DeepSeek' } })
  mc.log('已进入 主服 @ (0,64,0) gamemode=survival')
  const t = rd(mcLog)
  ok(new RegExp(`\\[mcp-mc-agent \\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2} DeepSeek\\] 已进入 主服`).test(t),
    '带 `机器人名` 标签 + 本地时间', (t.split('\n')[0] ?? '').slice(0, 70))
  const long = new McBot({ logFile: join(TMP, 'mc2.log'), auth: { name: 'a'.repeat(30) } })
  long.log('x')
  ok(/\[mcp-mc-agent \d{2}-\d{2} \d{2}:\d{2}:\d{2} aaaaaaaaaaaa\] x/.test(rd(join(TMP, 'mc2.log'))),
    '名字太长截到 12 字', (rd(join(TMP, 'mc2.log')).split('\n')[0] ?? '').slice(0, 70))
  const noName = new McBot({ logFile: join(TMP, 'mc3.log') })
  noName.log('y')
  ok(/\[mcp-mc-agent \d{2}-\d{2} \d{2}:\d{2}:\d{2}\] y/.test(rd(join(TMP, 'mc3.log'))), '没设 auth.name 就不加标签（不留双空格）')
  mc.logDebug('mc 的调试行')
  ok(!rd(mcLog).includes('mc 的调试行'), 'McBot.logDebug 同样受级别控制')
  process.env.MC_LOG_LEVEL = 'debug'
  mc.logDebug('mc 的调试行')
  ok(rd(mcLog).includes('mc 的调试行'), 'debug 级别下落盘')
  delete process.env.MC_LOG_LEVEL
  ok(mc.logOnce('check-logging:mc1', 'mc 只一次') === true && mc.logOnce('check-logging:mc1', 'mc 只一次') === false,
    'McBot.logOnce 也是进程内一次')
}

/* ─────────── ⑥ 轮转：超过上限改名，只留 MC_LOG_KEEP 份 ─────────── */
section('⑥ 轮转 —— 主日志超过 MC_LOG_MAX_BYTES 就改名 `mcp-mc-agent.YYYY-MM-DD[-n].log`')
{
  const dir = join(TMP, 'rot')
  const rot = join(dir, 'mcp-mc-agent.log')
  process.env.MC_LOG = rot
  process.env.MC_LOG_MAX_BYTES = '300'
  process.env.MC_LOG_KEEP = '2'
  const core3 = await import(`${CORE_URL}?rot=1`)
  for (let i = 0; i < 9; i++) core3.logLine(`轮转测试 ${i} ${'x'.repeat(180)}`)
  const names = readdirSync(dir)
  const archives = names.filter((n) => /^mcp-mc-agent\.\d{4}-\d{2}-\d{2}(-\d+)?\.log$/.test(n))
  ok(existsSync(rot), '主日志还在（轮转后自动重建）')
  ok(archives.length > 0, '产生了归档文件', archives.join(', '))
  ok(archives.length <= 2, '只留 MC_LOG_KEEP=2 份', `${archives.length} 份`)
  ok(rd(rot).includes('轮转测试 8'), '最后一行在主日志里（没丢）')
  process.env.MC_LOG = LOG
  process.env.MC_LOG_MAX_BYTES = String(10 * 1024 * 1024)
}

/* ─────────── ⑦ 静态检查：旧的噪声 / UTC / 成对写法不许回潮 ─────────── */
section('⑦ 源码静态检查 —— 降级过的行别再回到 info，UTC 时间戳别再回来')
{
  const root = new URL('../', import.meta.url)
  const coreSrc = readFileSync(new URL('src/core.mjs', root), 'utf8')
/* 路线图第 ④ 条第二十八刀：vendor 依赖加载器搬进 `src\plugins.mjs`（`logWarn ?? log` 在那里）。 */
const plugSrc = readFileSync(new URL('src/plugins.mjs', root), 'utf8')
  /* 路线图第 ④ 条第五刀：日志基建（stamp/logLevel/logDebug/logLine/logOnce + 轮转）搬到了
   * `src/log.mjs` ⇒ 按名字找代码的静态断言要跟着搬（否则红的是"文件里没这段文字"，不是行为）。 */
  const logSrc = readFileSync(new URL('src/log.mjs', root), 'utf8')
  /* 路线图第 ④ 条第三十一刀：连接层搬进 `src\connection.mjs`（`已进入 …` / `后重连 …` 两行日志在那里）。 */
  const connSrc = readFileSync(new URL('src/connection.mjs', root), 'utf8')
const runSrc = readFileSync(new URL('src/runtime.mjs', root), 'utf8')
  const idxSrc = readFileSync(new URL('index.js', root), 'utf8')
  /* 🔴 上游的 `selfcheck.mjs`（DSH 插件版的 fake-ctx 集成检查）已删。
   *    MCP 版的端到端自检在 `mcp/selfcheck-mcp.mjs`，它**不往真日志里写**：
   *    自己建一个临时状态目录、用 `--state-dir` 喂给子进程，所以"截断自己的日志"这件事
   *    它根本不需要 —— 下面改成断言这个隔离本身。 */
  const scSrc = readFileSync(new URL('mcp/selfcheck-mcp.mjs', root), 'utf8')
  ok(!/toISOString\(\)\.slice\(11, 19\)/.test(coreSrc) && !/toISOString\(\)\.slice\(11, 19\)/.test(logSrc),
    'core.mjs / log.mjs 里都没有 UTC 时分秒写法')
  ok(/export function stamp \(/.test(logSrc) && /export function logDebug \(/.test(logSrc) && /export function logOnce \(/.test(logSrc),
    'stamp / logDebug / logOnce 都在 src/log.mjs 里导出了')
  ok(/export \{[^}]*logLine[^}]*\} from '\.\/log\.mjs'/.test(coreSrc),
    'core.mjs 照样导出 logLine 等名字（第五刀：外部 import 一行都不用改）')
  ok(/globalThis\.__mcpMcAgentLogged/.test(logSrc), 'logOnce 用 globalThis 判重（跨模块实例）')
  ok(/function logLimits \(\)/.test(logSrc) && /process\.env\.MC_LOG_MAX_BYTES/.test(logSrc) && /\.slice\(keep\)/.test(logSrc),
    '轮转上限是**现读**环境变量（搬进单例模块后不能在加载时读死）')
  /* 🔴 2026-10-15：这行代码早就搬进 `src/connection.mjs`（而且实例变量改名成了 `self.`）
   *    ⇒ 旧断言在 `core.mjs` 里找 `this.` 版，从拆分那天起一直红着。 */
  ok(/if \(!self\.stopped\) self\.log\('连接结束'/.test(connSrc), '主动下线不再打「连接结束」两行（实现已搬到 src/connection.mjs）')
  ok(/已进入 \$\{sub \|\| '主服'\}/.test(connSrc) && /后重连 \$\{sub \|\| '主服'\}/.test(connSrc),
    '`sub` 为空时显示「主服」（不再出现双空格）')
  ok(/这一轮的时间用完了（还剩/.test(runSrc) && /from '\.\/runtime\.mjs'/.test(coreSrc),
    '超时文案能区分"本轮时间用完"与"操作超时"（第三十三刀起在 src\\runtime.mjs 里）')
  ok(/logOnce\('deps-ready'/.test(plugSrc), '「现成插件就绪」进程内只打一次（第二十八刀起在 src\\plugins.mjs 里）')
  ok(/const logWarn = \(m\) => self\.log\(m\)/.test(plugSrc) && /logWarn \?\? log/.test(plugSrc),
    '依赖细节走 debug、失败行仍走 info（logWarn；第二十九刀起两处都在 src\\plugins.mjs）')
  ok(/logFile: process\.env\.MC_LOG/.test(coreSrc), 'MC_LOG 仍然决定日志落点')

  ok(/logDebug, logOnce, logLevel/.test(idxSrc), 'index.js 从 core 引入 logDebug/logOnce/logLevel')
  ok(/v\$\{PLUGIN_VERSION\}：配置/.test(idxSrc), '启动配置行带**版本号**（以前日志里分不出是哪份代码）')
  ok(count(idxSrc, 'logDebug(') >= 8, 'index.js 里 ≥8 处降级成 logDebug', String(count(idxSrc, 'logDebug(')))
  ok(/logOnce\('no-host-createUserMessage'/.test(idxSrc), '「拿不到宿主 createUserMessage」只打一次（原来 22 遍）')
  ok(/const extLogLine = \(m\) =>/.test(idxSrc) && /logLine: extLogLine/.test(idxSrc),
    '扩展拿到的 logLine 会按内容去重（各扩展的「已加载」行）')
  ok(/logDebug\(`扩展已加载：/.test(idxSrc), '「扩展已加载」降级成 debug')
  for (const [re, label] of [
    [/logLine\('已挂上归档保护/, '归档保护'],
    [/logLine\('账户库就绪/, '账户库就绪'],
    [/logLine\(`非 MC 模式：mc \/ mc_kit 工具已从可见面摘掉/, '非 MC 模式'],
    [/logLine\(`MC 模式：工具白名单已生效/, 'MC 模式白名单'],
    [/logLine\(`新会话记忆已从基根播种/, '记忆播种'],
  ]) ok(!re.test(idxSrc), `「${label}」已不在 info 级别`)

  ok(/mkdtempSync\(/.test(scSrc) && /--state-dir/.test(scSrc) && /MCP_MC_AGENT_STATE_DIR/.test(scSrc),
    'MCP 端到端自检用临时状态目录跑（不往真日志/真账户库里写）')
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
try { rmSync(TMP, { recursive: true, force: true }) } catch {}
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
