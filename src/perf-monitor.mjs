/**
 * 事件循环延迟 / CPU 占用监测（2026-10-15）
 *
 * 来源：用户给的「DSH-MC-Agent 异步与多线程优化实施方案」第 3.2 步，原话是
 *   **「只有确认 CPU 计算或同步操作确实造成卡顿后，再决定是否使用 Worker。」**
 * 这个模块就是那个"确认"—— 每次工具调用记三个数：
 *
 *   · `wallMs`  —— 这次调用挂了多久（墙钟）
 *   · `cpuMs`   —— 这次调用真的烧了多少 CPU（`process.cpuUsage()` 前后差）
 *   · `loopMaxMs` / `loopP99Ms` —— 调用期间**事件循环延迟**的最大值 / 99 分位
 *
 * 判据（`perfVerdict()` 会把结论直接写成中文，`mc_diag` 的 `perf` 段原样给模型看）：
 *   · `cpuMs` 接近 `wallMs`（比值高）⇒ **CPU 密集**，会阻塞事件循环 ⇒ 值得搬进 Worker。
 *     候选：`src/map-render.mjs` 的 `floorMapOf()`/`heightmapOf()`（96×96 列 × 每列十几次
 *     **同步** `blockAt()`）、`src/png.mjs` 的 `encodePng()`、`extensions/mc_view-render.mjs` 的渲染。
 *   · `cpuMs ≪ wallMs` ⇒ 在等 I/O / 等服务器 ⇒ **不要**搬 Worker。
 *     `mc_move`（等 pathfinder）、`mc_connect`（等握手）、`mc_task`（等子动作）都是这一类。
 *   · `loopMaxMs` 很大但这次调用自己不烧 CPU ⇒ 期间**别人**在阻塞，顺着 `calls` 里的名字往下查。
 *
 * 🔴 设计纪律（和 `src/action-scheduler.mjs` 一样）：
 *   · 不 import 任何游戏库、不反向 import `core.mjs`（会循环导入）；
 *   · 关掉时**零成本**：`perfWrap()` 直接 `return fn()`，连 `hrtime` 都不取；
 *   · 只记"工具名 + 数字"，**不记参数** —— 免得把聊天内容 / 坐标 / 物品名写进日志。
 *
 * 环境变量：
 *   · `MCP_MC_AGENT_PERF` —— `off` / `0` / `false` 关掉（默认**开**：每次工具调用两次
 *     `process.hrtime.bigint()` + 一次 `process.cpuUsage()`，工具调用是"分钟级"的频率，可忽略）；
 *   · `MCP_MC_AGENT_PERF_RESOLUTION` —— 事件循环延迟直方图分辨率 ms（默认 100，最小 10）；
 *   · `MCP_MC_AGENT_PERF_KEEP` —— 每个动作留多少次样本（默认 20）。
 *
 * ⚠️ 并发调用时只记 `wall`/`cpu`，**不记** `loop*` —— 直方图是全局的，
 *    同时有两个动作在跑时"这次调用期间的延迟"分不清是谁的（宁可缺，不要假）。
 *
 * ⚠️ **主信号是 `cpuRatio`（CPU ÷ 墙钟），不是 `loop*`**：直方图的采样间隔就是 `resolution`，
 *    所以 `loop*` 天然带着一个"分辨率级"的底噪（默认 100ms 下，空转也常报几十 ms），
 *    只适合看"这次调用期间事件循环最多被堵了多久"这个量级，别拿它做精确判断。
 */
import { monitorEventLoopDelay } from 'node:perf_hooks'

const OFF = new Set(['0', 'off', 'false', 'no', 'none', ''])

/** 默认开（见文件头：这是"要不要上 Worker"的唯一依据，得先有数据） */
export function perfEnabled () {
  return !OFF.has(String(process.env.MCP_MC_AGENT_PERF ?? '1').trim().toLowerCase())
}

export function perfResolution () {
  const n = Number(process.env.MCP_MC_AGENT_PERF_RESOLUTION)
  return Number.isFinite(n) && n >= 10 ? Math.floor(n) : 100
}

export function perfKeep () {
  const n = Number(process.env.MCP_MC_AGENT_PERF_KEEP)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 20
}

/** ns → ms，留一位小数（`percentile()` 回的是纳秒） */
const toMs = (ns) => Math.round(Number(ns) / 1e5) / 10

let hist = null
let histError = null
let startedAt = 0
let inflight = 0

function ensureHist () {
  if (hist || histError) return hist
  try {
    hist = monitorEventLoopDelay({ resolution: perfResolution() })
    hist.enable()
    startedAt = Date.now()
  } catch (e) {
    /* 拿不到就算了：`perfWrap()` 照样记 wall/cpu，只是没有 loop* */
    histError = e?.message ?? String(e)
    hist = null
  }
  return hist
}

/** 工具名 → { n, wall[], cpu[], loopMax[], loopP99[], sync, firstAt, lastAt } */
const stats = new Map()

function slotOf (name) {
  let s = stats.get(name)
  if (!s) {
    s = { n: 0, wall: [], cpu: [], loopMax: [], loopP99: [], sync: 0, firstAt: 0, lastAt: 0 }
    stats.set(name, s)
  }
  return s
}

function pushCapped (arr, v, cap) {
  arr.push(v)
  while (arr.length > cap) arr.shift()
}

const cpuMsOf = (u) => (Number(u?.user ?? 0) + Number(u?.system ?? 0)) / 1000

/**
 * 包住一次工具调用。同步 / 异步都认。
 * 关掉时**只有一次函数调用**的开销。
 *
 * ⚠️ 同步调用拿不到直方图 —— `monitorEventLoopDelay` 的采样定时器要等事件循环转一圈才触发，
 *    同步函数一返回就立即读 `h.max` 必然是 0（会误导成"没阻塞"）。所以**同步调用一律
 *    把 `loopMax` 记成 `wallMs`**：那段时间事件循环确实被这一整段堵死了，这个数字是真的。
 */
export function perfWrap (name, fn) {
  if (!perfEnabled()) return fn()
  const label = String(name ?? '?')
  const h = ensureHist()
  const cap = perfKeep()
  /* 只有"这一次是唯一在跑的"才记 loop*（直方图是全局的，并发时会张冠李戴） */
  const sole = inflight === 0
  inflight++
  if (sole && h) { try { h.reset() } catch { /* 忽略 */ } }
  const wall0 = process.hrtime.bigint()
  const cpu0 = process.cpuUsage()

  const finish = (sync) => {
    const wallMs = toMs(process.hrtime.bigint() - wall0)
    const c = process.cpuUsage(cpu0)
    const cpuMs = Math.round(cpuMsOf(c) * 10) / 10
    const s = slotOf(label)
    s.n++
    if (sync) s.sync++
    pushCapped(s.wall, wallMs, cap)
    pushCapped(s.cpu, cpuMs, cap)
    if (sole && h) {
      pushCapped(s.loopMax, sync ? wallMs : toMs(h.max), cap)
      pushCapped(s.loopP99, sync ? wallMs : toMs(h.percentile(99)), cap)
    }
    const now = Date.now()
    if (!s.firstAt) s.firstAt = now
    s.lastAt = now
    inflight--
  }

  let out
  try {
    out = fn()
  } catch (e) {
    finish(true)
    throw e
  }
  if (!out || typeof out.then !== 'function') { finish(true); return out }
  return out.then(
    (v) => { finish(false); return v },
    (e) => { finish(false); throw e }
  )
}

const avg = (arr) => (arr.length ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null)

/**
 * 墙钟短于这个值就**不给占比**（`cpuRatio` 记 `null`，不编个 0 出来骗人）。
 *
 * ⚠️ 实测（Windows / Node 22）：`process.cpuUsage()` 的分辨率是**一个 ~15.6ms 的时钟节拍**，
 *    不是微秒 —— 5ms 忙循环报 16ms、**20ms 忙循环报 0**、60ms 报 78ms。
 *    所以任何比"两个节拍"还短的样本，`cpuMs` 只是量化噪声；拿它除墙钟算出的占比
 *    （0%、150%、whatever）**看着像数据，其实是噪声**。宁可报"判不了"，也不报假结论。
 *
 * 顺带把 `check-perf-monitor.mjs` 那条"抛错的动作 ⇒ 占比记 null"从**看运气**变成确定：
 * 以前判据是 `wallMs && …` —— 靠 `toMs` 四舍五入正好落到 0 才成立，而 `new Error()`
 * 抓栈耗时恰好在 0.05ms 上下抖 ⇒ 同一台机器上时红时绿。
 */
const RATIO_MIN_WALL_MS = 32

/** 给 `mc_diag` 的结构化快照 */
export function perfSnapshot () {
  if (!perfEnabled()) {
    return { enabled: false, note: '已用 MCP_MC_AGENT_PERF=off 关掉（想开就删掉这个环境变量）' }
  }
  const h = ensureHist()
  const calls = [...stats.entries()].map(([name, s]) => {
    const wallMs = avg(s.wall)
    const cpuMs = avg(s.cpu)
    return {
      name, n: s.n, wallMs, cpuMs,
      cpuRatio: (wallMs != null && wallMs >= RATIO_MIN_WALL_MS && cpuMs != null)
        ? Math.round((cpuMs / wallMs) * 100) / 100
        : null,
      /* 全是同步调用的动作：整段墙钟都在堵事件循环（`loopMax` 就是墙钟） */
      sync: s.sync === s.n,
      loopMaxMs: s.loopMax.length ? Math.max(...s.loopMax) : null,
      loopP99Ms: s.loopP99.length ? Math.max(...s.loopP99) : null,
    }
  }).sort((a, b) => (b.wallMs ?? 0) - (a.wallMs ?? 0))

  return {
    enabled: true,
    resolutionMs: perfResolution(),
    ...(histError ? { histogramError: histError } : {}),
    ...(startedAt ? { watchingSince: new Date(startedAt).toISOString() } : {}),
    /* 全局健康度（进程起来到现在，不 reset 的那一份） */
    loop: h ? { p50Ms: toMs(h.percentile(50)), p99Ms: toMs(h.percentile(99)), maxMs: toMs(h.max) } : null,
    calls,
    verdict: perfVerdict(calls),
  }
}

/** 把数字翻成"该不该上 Worker"的结论（纯函数，测试好写） */
export function perfVerdict (calls = []) {
  const heavy = calls.filter((c) => (c.cpuMs ?? 0) >= 30 && (c.cpuRatio ?? 0) >= 0.5)
  const waiting = calls.filter((c) => (c.wallMs ?? 0) >= 1000 && (c.cpuRatio ?? 1) < 0.2)
  const out = []
  if (heavy.length) {
    out.push('🐌 CPU 密集（会阻塞事件循环，**值得搬 Worker**）：'
      + heavy.map((c) => `${c.name}（墙钟 ${c.wallMs}ms / CPU ${c.cpuMs}ms = ${Math.round((c.cpuRatio ?? 0) * 100)}%`
        + `${c.sync ? '，而且整段是同步的' : ''}）`).join('、'))
  }
  if (waiting.length) {
    out.push('⏳ 在等 I/O 或等服务器（**不要**搬 Worker）：'
      + waiting.map((c) => `${c.name}（墙钟 ${c.wallMs}ms 但只烧了 ${c.cpuMs}ms CPU）`).join('、'))
  }
  if (!out.length) out.push('（还没有够多、够大的样本 —— 多跑几次 mc_map / mc_move / mc_observe 再看）')
  return out
}

/** 多行文本（`mc_diag` / 日志 / 人工看） */
export function perfText (snap = null) {
  const s = snap ?? perfSnapshot()
  if (!s.enabled) return `📊 性能监测：${s.note}`
  const lines = [`📊 性能监测（直方图分辨率 ${s.resolutionMs}ms）`]
  if (s.loop) lines.push(`  事件循环延迟（全程）：p50 ${s.loop.p50Ms}ms ｜ p99 ${s.loop.p99Ms}ms ｜ 最大 ${s.loop.maxMs}ms`)
  if (!s.calls.length) {
    lines.push('  还没采到样本。')
  } else {
    lines.push('  动作 ｜ 次数 ｜ 墙钟(均) ｜ CPU(均) ｜ CPU占比 ｜ 期间延迟最大/p99')
    for (const c of s.calls) {
      lines.push(`  · ${c.name} ｜ ${c.n} ｜ ${c.wallMs}ms ｜ ${c.cpuMs}ms ｜ `
        + `${c.cpuRatio == null ? '?' : Math.round(c.cpuRatio * 100) + '%'} ｜ `
        + `${c.loopMaxMs == null ? '（并发，没记）' : `${c.loopMaxMs}/${c.loopP99Ms}ms${c.sync ? '（同步，整段都在堵）' : ''}`}`)
    }
    /* 有 "?" 就说清楚为什么 —— 别让人以为"占比没算出来"是坏了 */
    if (s.calls.some((c) => c.cpuRatio == null && (c.wallMs ?? 0) < RATIO_MIN_WALL_MS)) {
      lines.push(`  （占比 "?" = 样本太短（平均墙钟不足 ${RATIO_MIN_WALL_MS}ms）判不了：`
        + 'CPU 计时在 Windows 上是一个 ~15.6ms 的节拍，短样本算出来的占比是噪声，不如不报）')
    }
  }
  for (const v of s.verdict) lines.push(`  ${v}`)
  return lines.join('\n')
}

/** 清空样本（换场景重测时用） */
export function perfReset () {
  stats.clear()
  inflight = 0
  try { hist?.reset() } catch { /* 忽略 */ }
  startedAt = perfEnabled() ? Date.now() : 0
  return true
}
