// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / log.mjs —— 日志基建（路线图第 ④ 条第五刀）
 * ---------------------------------------------------------------------------
 * 从 `src/core.mjs` **原文**搬出，行为一字不改：
 *   ① `stamp()` 本地 `MM-DD HH:MM:SS`；② `logDebug()` 只在 `MC_LOG_LEVEL=debug` 落盘；
 *   ③ `logOnce(key)` 用 **globalThis** 判重（每个连接都会重新 import 一份模块，模块级变量拦不住）；
 *   ④ 超过 `MC_LOG_MAX_BYTES` 就改名 `mcp-mc-agent.YYYY-MM-DD[-n].log`，只留最近 `MC_LOG_KEEP` 份。
 *
 * 🔴 搬家时**唯一**要改的地方：`logLine`/`logDebug` 原来直接读 `DEFAULTS.logFile`，
 *    而 `DEFAULTS` 定义在 core.mjs 里 ⇒ 直接 import 会造出 core ↔ log 的**循环导入**。
 *    改成"由 core.mjs 注入"：core.mjs 定义完 `DEFAULTS` 之后调一次 `setDefaultLogFile(DEFAULTS.logFile)`。
 *    "插件加载/卸载"这种没有机器人实例的时刻写的还是同一个文件，行为不变。
 *
 * 迁移规矩（见 README「渐进拆分 core.mjs」）：一次只搬一个模块；`core.mjs` 保留同名导出
 * （`logLine`/`logDebug`/`logOnce`/`logLevel`/`stamp` 被 index.js、4 个扩展、8 个套件从 core.mjs import）。
 */
import {
  existsSync, statSync, mkdirSync, appendFileSync, renameSync, readdirSync, unlinkSync,
} from 'node:fs'
import { join, dirname, basename } from 'node:path'

/** "没有机器人实例时往哪写" —— 由 core.mjs 注入 `DEFAULTS.logFile` */
let defaultLogFile = null
/** 由 core.mjs 在定义完 `DEFAULTS` 之后调一次 */
export function setDefaultLogFile (file) { defaultLogFile = file ? String(file) : null }
/** 当前默认落点（没注入过就是 null ⇒ 那几行不落盘，和"文件建不出来"一样静默） */
export function defaultLogFilePath () { return defaultLogFile }

/* ── 日志基建：本地时间 + 级别 + 进程内去重 + 轮转（2026-10-06 用户"日志优化"）───────
 * 起因（实测 1455 行主日志）：59.7% 是启动噪声 —— 依赖横幅**每个连接重打一遍**、
 * 账户/归档/记忆播种每会话重打一遍；时间戳是 UTC（比本地早 8 小时、跨天看不出是哪天）；
 * 没有版本标记（今天的行和几天前的混在一起分不出）；从不轮转（selfcheck.log 已 1.2 MB）。
 * 改法：① `stamp()` 本地 `MM-DD HH:MM:SS`；② `logDebug()` 只在 MC_LOG_LEVEL=debug 落盘；
 *      ③ `logOnce(key)` 用 **globalThis** 判重（每个连接是新的模块实例，模块级变量拦不住）；
 *      ④ 超过 MC_LOG_MAX_BYTES（默认 2 MB）就改名 `mcp-mc-agent.YYYY-MM-DD[-n].log`，留最近 MC_LOG_KEEP（默认 7）份。
 */
/** 级别表（core.mjs 的 `McBot.logDebug` 也要用 ⇒ 这里导出，但 core.mjs 不再往外 re-export） */
export const LOG_LEVELS = { quiet: 0, info: 1, debug: 2 }
/** 当前日志级别（`MC_LOG_LEVEL=quiet|info|debug`，默认 info） */
export function logLevel () {
  const v = String(process.env.MC_LOG_LEVEL ?? 'info').trim().toLowerCase()
  return LOG_LEVELS[v] ?? LOG_LEVELS.info
}
/** 本地时间 `MM-DD HH:MM:SS`（原来是 `toISOString()` 的 UTC 时分秒：跨天分不出哪天、和游戏日志差 8 小时） */
export function stamp (d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
/** 🟡 2026-10-15 审计（报告 E 第 10 条）：原来写 `Number(env) || 默认` ——
 *  ① `MC_LOG_KEEP=0` 被当成假值退回 7（0 不可配）；② 非法值静默变默认（用户以为自己配了）；
 *  ③ 更糟的是**负数**：`MC_LOG_MAX_BYTES=-1` 时下面 `statSync(file).size < maxBytes` 恒假
 *  ⇒ `appendLog` 每写一行就轮转一次日志。这里统一校验：只有"正的有限数"才采用。 */
function envPositiveInt (raw, dflt) {
  const s = String(raw ?? '').trim()
  if (!s) return dflt
  const n = Number(s)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.floor(n)
}

/**
 * 轮转上限。🔴 **每次轮转现读环境变量**，不是模块加载时读一次。
 * 理由（第五刀搬完才暴露）：搬进 `src/log.mjs` 之后这个模块**整个进程只加载一次**，
 * 而 `tools\check-logging.mjs` 的 ⑥ 是"改 `MC_LOG_MAX_BYTES` → 重新 `import()` 一份 core.mjs
 * → 看它轮转" —— 加载时读死就会永远读到第一次那个值，⑥ 直接红。
 * 现读顺带也更对：进程里改这两个变量立刻生效。
 */
function logLimits () {
  return {
    maxBytes: envPositiveInt(process.env.MC_LOG_MAX_BYTES, 2 * 1024 * 1024),
    keep: envPositiveInt(process.env.MC_LOG_KEEP, 7),
  }
}

/** 超过上限就把主日志改名存档（`<名字>.YYYY-MM-DD[-n].log`），只留最近 keep 份 */
export function rotateLogIfNeeded (file) {
  try {
    const { maxBytes, keep } = logLimits()
    if (!existsSync(file) || statSync(file).size < maxBytes) return
    const stem = basename(file).replace(/\.log$/i, '')
    const dir = dirname(file)
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    let target = join(dir, `${stem}.${day}.log`)
    for (let i = 2; existsSync(target) && i < 200; i++) target = join(dir, `${stem}.${day}-${i}.log`)
    renameSync(file, target)
    const re = new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.\\d{4}-\\d{2}-\\d{2}(-\\d+)?\\.log$`)
    readdirSync(dir)
      .filter((n) => re.test(n))
      .map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs } } catch { return null } })
      .filter(Boolean)
      .sort((a, b) => b.t - a.t)
      .slice(keep)
      .forEach((o) => { try { unlinkSync(join(dir, o.n)) } catch {} })
  } catch {}
}

/** 统一落盘：自动建目录 + 轮转 */
export function appendLog (file, line) {
  try {
    const dir = dirname(file)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    rotateLogIfNeeded(file)
    appendFileSync(file, line + '\n')
  } catch {}
}

/**
 * 独立落盘日志（不需要 McBot 实例）。
 * 用途：插件加载/卸载这种"机器人都还没有"的时刻也要在 mcp-mc-agent.log 留痕——
 * 排查"插件到底加载了没"全靠这一行（曾因为没有它而误判成"工具没注册"）。
 */
export function logLine (...args) {
  const line = `[mcp-mc-agent ${stamp()}] ${args.join(' ')}`
  appendLog(defaultLogFile, line)
  return line
}

/** 只有 `MC_LOG_LEVEL=debug` 才落盘：启动横幅这类"每个连接都重打一遍"的细节行 */
export function logDebug (...args) {
  const line = `[mcp-mc-agent ${stamp()}] ${args.join(' ')}`
  if (logLevel() >= LOG_LEVELS.debug) appendLog(defaultLogFile, line)
  return line
}

/**
 * 整个进程只落盘一次（同 key 再来直接跳过，返回 false）。
 * 🔴 **必须挂在 `globalThis` 上**：每个 MC 连接都会重新 `import()` 一份 core.mjs，
 *    模块级变量根本拦不住"每个连接重打一遍"。
 */
export function logOnce (key, ...args) {
  const g = (globalThis.__mcpMcAgentLogged ??= new Set())
  if (g.has(key)) return false
  g.add(key)
  logLine(...args)
  return true
}
