/**
 * Worker 线程池（**默认关**）。
 *
 * 为什么要有它：有几段纯计算会**同步堵住事件循环** —— 物理、看门狗、别的工具全停。
 * 实测（2026-10-15）唯一够格搬走的是"字符网格 → RGBA 像素图"：
 * `radius:96, scale:16` ⇒ 943 万像素、纯循环 28.2ms、整条 36.1ms。
 * 其余候选（`heightmapOf` / `floorMapOf` / `classifyTerrain`）都在 16ms 以内，
 * 而且**大头是 `bot.blockAt()`** —— 那东西绑在 bot 对象上，**搬不动，也不该搬**。
 *
 * 三条纪律：
 * 1. **默认关**（`MCP_MC_AGENT_WORKERS` 不给就是 off）。没量过就别上。
 * 2. **搬不动就退回来干活**：`new Worker` 失败（打包 / asar / 权限）、线程崩了、
 *    超时了 —— 一律回主线程同步跑同一份实现，结果照给，只是多一个 `via` 字段说明。
 * 3. **小活不搬**：postMessage 的来回 + 结构化拷贝是有成本的，
 *    预计（或实测）不到 `WORKER_MIN_MS` 的直接原地算 —— 搬了反而更慢。
 *
 * 叶子模块：只 import `node:*` 和 `worker-tasks.mjs`；不碰 `core.mjs`、不碰 mineflayer。
 */
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { WORKER_TASKS } from './worker-tasks.mjs'

/** 低于这个预估耗时就别搬了（来回成本比省下的还多） */
export const WORKER_MIN_MS = 8
/** 池子上限（再多也没意义：这些任务本来就串行） */
export const WORKER_MAX = 4
/** 一次任务的默认超时 */
export const WORKER_TIMEOUT_MS = 30_000

const OFF_WORDS = new Set(['', 'off', '0', 'false', 'no', 'none'])

/** `MCP_MC_AGENT_WORKERS`：不给 / `off` ⇒ 关；数字 ⇒ 池子上限；`on`/`true` ⇒ 自动取 */
export function workerPoolEnabled () {
  const raw = String(process.env.MCP_MC_AGENT_WORKERS ?? '').trim().toLowerCase()
  return !OFF_WORDS.has(raw)
}

/** 想要几个线程（**关掉时回 0**） */
export function workerPoolSize () {
  if (!workerPoolEnabled()) return 0
  const raw = String(process.env.MCP_MC_AGENT_WORKERS ?? '').trim().toLowerCase()
  const n = Number(raw)
  if (Number.isFinite(n) && n > 0) return Math.min(Math.floor(n), WORKER_MAX)
  const auto = Math.max(1, Math.min(cpus().length - 1, 2))
  return Math.min(auto, WORKER_MAX)
}

/* ───────────── 池子状态 ───────────── */

const pool = []
const stats = {
  tasks: 0,        // 总共来了多少件
  offloaded: 0,    // 真搬到线程里跑的
  inline: 0,       // 原地跑的（关着 / 太小 / 退路）
  errors: 0,       // 线程报错或崩了的次数
  fallbacks: 0,    // 搬失败退回原地跑的
  timeouts: 0,
  spawns: 0,
  avgMs: Object.create(null),
  lastMs: null,
}
let seq = 0
let broken = false          // 这个环境起不了 Worker（打包/asar/权限）—— 记住，别再试
let shutdown = false

/** 给自检/诊断看的一份快照 */
export function workerPoolStats () {
  return {
    enabled: workerPoolEnabled(),
    size: workerPoolSize(),
    live: pool.filter((w) => !w.dead).length,
    idle: pool.filter((w) => !w.dead && !w.busy).length,
    spawns: stats.spawns,
    broken,
    shutdown,
    ...stats,
    avgMs: { ...stats.avgMs },
  }
}

/** 关掉池子（宿主退出、断线时调）。之后 `runInWorker` 一律原地跑。 */
export function workerPoolShutdown () {
  shutdown = true
  for (const w of pool.splice(0)) {
    w.dead = true
    try { w.worker.terminate() } catch { /* 已经没了 */ }
  }
}

function noteMs (task, ms) {
  stats.lastMs = ms
  const prev = stats.avgMs[task]
  stats.avgMs[task] = prev == null ? ms : prev * 0.7 + ms * 0.3
}

/** 这个任务大概要跑多久（有实测用实测，没有用调用方给的估算） */
function estimateMs (task, estMs) {
  const avg = stats.avgMs[task]
  const est = Number(estMs)
  if (avg != null && Number.isFinite(est)) return Math.max(avg, est)
  if (avg != null) return avg
  return Number.isFinite(est) ? est : Infinity   // 完全没信息：交给池子决定
}

/* ───────────── 原地跑（退路 / 关掉时） ───────────── */

function runInline (task, payload) {
  const fn = WORKER_TASKS[task]
  if (typeof fn !== 'function') throw new Error(`未知任务：${task}`)
  return fn(payload)
}

/* ───────────── 起线程 ───────────── */

function spawn () {
  if (broken || shutdown) return null
  const url = new URL('./worker-entry.mjs', import.meta.url)
  let worker
  try {
    worker = new Worker(url, { name: `mc-worker-${stats.spawns + 1}` })
  } catch {
    /* 打包环境 / asar / 权限 —— 一次就够，别每次都撞 */
    broken = true
    return null
  }
  const rec = { worker, busy: false, dead: false, waiters: new Map() }
  worker.on('message', (msg) => {
    const w = rec.waiters.get(msg?.id)
    if (!w) return
    rec.waiters.delete(msg?.id)
    w.done(msg.ok ? null : new Error(String(msg.error ?? '线程报错')), msg.value)
  })
  worker.on('error', (e) => {
    /* 线程自己崩了：所有等着的都按失败收，然后把它从池子里去掉 */
    rec.dead = true
    for (const [, w] of rec.waiters) w.done(e ?? new Error('线程挂了'))
    rec.waiters.clear()
    stats.errors++
  })
  worker.on('exit', (code) => {
    rec.dead = true
    const err = new Error(`工作线程退出了（code ${code}）`)
    for (const [, w] of rec.waiters) w.done(err)
    rec.waiters.clear()
    const i = pool.indexOf(rec)
    if (i >= 0) pool.splice(i, 1)
  })
  /* 别让线程吊住进程退出 */
  worker.unref?.()
  stats.spawns++
  pool.push(rec)
  return rec
}

function pick () {
  const idle = pool.find((w) => !w.dead && !w.busy)
  if (idle) return idle
  if (pool.filter((w) => !w.dead).length >= workerPoolSize()) return null
  return spawn()
}

/**
 * 把一件纯计算交给线程池。
 *
 * @param {string} task         `WORKER_TASKS` 里的名字
 * @param {object} payload      结构化克隆得过去的普通数据（TypedArray 最好）
 * @param {object} [opts]
 * @param {number} [opts.estMs] 这件活大概多久（不知道就别传）
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal]
 * @param {ArrayBuffer[]} [opts.transfer] 可以零拷贝转移过去的 buffer
 * @returns {Promise<{ ok:boolean, value?:any, via:'worker'|'inline'|'fallback', ms:number, error?:string }>}
 */
export async function runInWorker (task, payload, { estMs = null, timeoutMs = WORKER_TIMEOUT_MS, signal = null, transfer = [] } = {}) {
  stats.tasks++
  const t0 = Date.now()

  const inline = (via, err) => {
    const value = runInline(task, payload)
    const ms = Date.now() - t0
    noteMs(task, ms)
    if (via === 'inline') stats.inline++
    else stats.fallbacks++
    return { ok: true, value, via, ms, ...(err ? { workerError: err.message ?? String(err) } : {}) }
  }

  if (!workerPoolEnabled() || shutdown || broken) return inline('inline')

  /* 小活别搬：来回的成本比省下的多 */
  const est = estimateMs(task, estMs)
  if (est < WORKER_MIN_MS) return inline('inline')

  if (signal?.aborted) throw signal.reason ?? new Error('已中止')

  const rec = pick()
  if (!rec) return inline('fallback')   // 池子满了（或起不来）⇒ 原地跑，别排长队

  const id = ++seq
  rec.busy = true
  try {
    const value = await new Promise((resolve, reject) => {
      /* 🔴 这个定时器**故意不 unref** —— 它是"这次任务的死线"，必须算数。
       *    （同 `withTimeout()` / 调度器排队定时器那个坑：unref 之后进程一没别的事
       *    就直接退出，Promise 永远不 resolve，自检会报 `Detected unsettled top-level await`。） */
      const timer = setTimeout(() => {
        rec.waiters.delete(id)
        stats.timeouts++
        reject(new Error(`工作线程超时（${timeoutMs}ms）：${task}`))
      }, timeoutMs)
      const onAbort = () => {
        clearTimeout(timer)
        rec.waiters.delete(id)
        reject(signal.reason ?? new Error('已中止'))
      }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      rec.waiters.set(id, {
        done: (err, val) => {
          clearTimeout(timer)
          try { signal?.removeEventListener?.('abort', onAbort) } catch { /* 无所谓 */ }
          err ? reject(err) : resolve(val)
        },
      })
      try { rec.worker.postMessage({ id, task, payload }, transfer) } catch (e) {
        clearTimeout(timer)
        rec.waiters.delete(id)
        reject(e)
      }
    })
    const ms = Date.now() - t0
    noteMs(task, ms)
    stats.offloaded++
    return { ok: true, value, via: 'worker', ms }
  } catch (e) {
    stats.errors++
    /* 线程这一趟没成 —— 但**活还是要干**：原地跑同一份实现，如实标 fallback */
    try {
      return inline('fallback', e)
    } catch (e2) {
      return { ok: false, via: 'fallback', ms: Date.now() - t0, error: e2?.message ?? String(e2), workerError: e?.message ?? String(e) }
    }
  } finally {
    rec.busy = false
    if (rec.dead) {
      const i = pool.indexOf(rec)
      if (i >= 0) pool.splice(i, 1)
    }
  }
}
