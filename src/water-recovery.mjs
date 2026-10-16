/**
 * 水下恢复控制器 —— **判断"要不要救自己"、按什么顺序救**，真正的移动仍然交给现有接口。
 *
 * 用户 m04784 的原话（这条约束是这个文件存在的理由）：
 *   > 建议新增模块只管理水域导航策略。实际移动仍通过现有接口执行，
 *   > 避免另起一套按键控制、移动代次或资源锁。
 *   > 不要让 PathFinder 与自定义游泳控制同时操纵移动。
 *
 * 所以这里**一行 `setControlState` 都没有**：
 *   - 出口怎么找 —— 交给 `water-navigation.mjs`（只读世界 + 纯计算）；
 *   - 路线怎么走 —— 交给调用方注入的 `ctx.walkTo` / `ctx.swimUp`
 *     （默认由 `core.mjs` 接到 `movement.mjs` 的 `walkTo` / `swimUp`，
 *      它们自己会领 `_moveGen`、走 ActionScheduler、检查 abort）；
 *   - 怎么告诉 AI —— 交给 `ctx.notify`（接的是自主层的 `wakeForDanger` → `agent.steer`）。
 *
 * **自动接管，但绝不偷偷接管**：每一次下水救援都会走 notify 说清"我为什么动了、
 * 往哪去、结果如何"，所以不存在"机器人自己游走了而 AI 不知道"。
 *
 * 流程（用户定的）：局部搜索 → 路线执行 → 复核进度；路线失败就把那个目标拉黑，重新搜。
 */

import { WATER_ARRIVE, feetOfBot, inWaterAt, waterExitSearch, waterSummaryOf } from './water-navigation.mjs'

/* ─────────── 常量 ─────────── */

/** 氧气低于这个就开始急（20 是满的；8 大约还剩 8 秒） */
export const WATER_AIR_LOW = 8
/** 低于这个属于"马上要掉血了"，用最急的语气 */
export const WATER_AIR_CRITICAL = 4
/** 一次恢复最多试几条路线（试完还不行就放弃，别把整个工具预算耗在水里） */
export const WATER_RECOVER_ROUNDS = 3
/** 一次恢复最多花多久（毫秒）—— 和别的动作一样，宁可少量多次 */
export const WATER_RECOVER_MS = 12_000
/** 卡在原地多久算"没进展" */
export const WATER_STUCK_MS = 2_500
/** 朝出口挪近了这么多格就算"有进展"（不一定非要踩到那一格） */
export const WATER_PROGRESS_EPS = 1.2

/** 触发原因 → 人话 */
export const WATER_TRIGGER_TEXT = {
  'oxygen-low': '氧气不多了',
  'oxygen-dropping': '氧气在往下掉',
  'taking-damage': '已经开始掉血了',
  'no-progress': '泡在水里没挪窝',
}

/* ─────────── 状态与触发 ─────────── */

/** 现在的水域状态（只读，不碰 bot） */
export function waterStateOf (b) {
  const feet = feetOfBot(b)
  const airRaw = b?.oxygenLevel
  const air = Number.isFinite(airRaw) ? Number(airRaw) : null
  const hpRaw = b?.health
  const health = Number.isFinite(hpRaw) ? Number(hpRaw) : null
  return { feet, inWater: feet ? inWaterAt(b, feet) : false, air, health, submerged: feet ? inWaterAt(b, feet) : false }
}

const sameCell = (a, c) => Boolean(a && c && a.x === c.x && a.y === c.y && a.z === c.z)

/**
 * 该不该启动恢复？**纯函数**（传上一次的快照，不自己存状态 —— 免得一个模块级变量
 * 在多个会话之间串味）。返回 `{ fire, why, detail }`。
 */
export function waterTriggerOf (state, prev = null, { airLow = WATER_AIR_LOW, eps = WATER_PROGRESS_EPS, stuckMs = WATER_STUCK_MS, now = Date.now() } = {}) {
  if (!state?.inWater) return { fire: false, why: 'not-in-water', detail: '没在水里' }
  if (state.air != null && state.air <= airLow) {
    return { fire: true, why: 'oxygen-low', detail: `氧气只剩 ${state.air}（低于 ${airLow}）` }
  }
  if (state.health != null && prev?.health != null && state.health < prev.health) {
    return { fire: true, why: 'taking-damage', detail: `血量从 ${prev.health} 掉到 ${state.health} —— 已经在淹了` }
  }
  if (prev?.air != null && state.air != null && state.air < prev.air) {
    return { fire: true, why: 'oxygen-dropping', detail: `氧气从 ${prev.air} 掉到 ${state.air}` }
  }
  if (prev?.feet && sameCell(state.feet, prev.feet) && Number.isFinite(prev.at) && now - prev.at >= stuckMs) {
    return { fire: true, why: 'no-progress', detail: `在水里 ${Math.round((now - prev.at) / 1000)} 秒没挪窝` }
  }
  return { fire: false, why: 'ok', detail: '还行' }
}

/* ─────────── 路线执行 ─────────── */

const keyOf = (t) => (t ? `${t.x},${t.y},${t.z}` : '')

/** 目标是不是**正上方**（那种情况按住 jump 上浮最快，也最不容易被寻路器绕远） */
export function straightUpFrom (from, to) {
  return Boolean(from && to && from.x === to.x && from.z === to.z && to.y > from.y)
}

function distTo (from, to) {
  if (!from || !to) return Number.POSITIVE_INFINITY
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
}

/**
 * 走一条出口路线。**不自己按键盘** —— 只挑"用哪个现有接口"，然后调它。
 * @returns {{ moved, used, from, to, error }}
 */
export async function executeRoute (self, res, ctx = {}) {
  const b = self?.requireBot?.() ?? self?.bot ?? null
  const from = feetOfBot(b)
  const t = res?.target
  if (!t) return { moved: 0, used: null, from, to: from, error: '没有目标' }
  /* 正上方 ⇒ 上浮（`swimUp` 按住 jump）；其它一律交给寻路器（它会游泳、会绕）。
   * 两者**不会同时**跑：这里是一条 await 串下来的，而且它们各自会领 `_moveGen`。 */
  const up = straightUpFrom(from, t) && res.path.every((p) => p.x === from.x && p.z === from.z)
  const used = up ? 'swim' : 'walk'
  try {
    if (up) {
      if (!ctx.swimUp) return { moved: 0, used, from, to: from, error: '调用方没给 swimUp' }
      await ctx.swimUp(self, { hold: ctx.swimMs ?? 3_000 })
    } else {
      if (!ctx.walkTo) return { moved: 0, used, from, to: from, error: '调用方没给 walkTo' }
      await ctx.walkTo(self, { x: t.x, y: t.y, z: t.z }, { arrive: ctx.arrive ?? WATER_ARRIVE })
    }
  } catch (e) {
    return { moved: 0, used, from, to: feetOfBot(b), error: String(e?.message ?? e) }
  }
  return { moved: distTo(from, feetOfBot(b)), used, from, to: feetOfBot(b), error: null }
}

/* ─────────── 主流程 ─────────── */

/**
 * 从水里把自己救出来。**可以被取消**（`ctx.signal`），**有预算**（`ctx.budgetMs`）。
 *
 * @returns {{
 *   ok, reason, rounds, target, kind, moved, tried, log, note, state
 * }}
 *   `reason`：`'escaped'`（真上岸了）/ `'improved'`（挪近了但没到）/ `'no-exit-found'`
 *   / `'budget-out'` / `'rounds-out'`（试完所有路线都不行）/ `'aborted'` / `'no-executor'` / `'not-in-water'`
 */
export async function recoverFromWater (self, opts = {}, ctx = {}) {
  const now = ctx.now ?? Date.now
  const sleep = ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
  const b = self?.requireBot?.() ?? self?.bot ?? null
  const t0 = now()
  const budgetMs = Number.isFinite(Number(opts.budgetMs)) ? Number(opts.budgetMs) : WATER_RECOVER_MS
  const maxRounds = Number.isFinite(Number(opts.rounds)) ? Number(opts.rounds) : WATER_RECOVER_ROUNDS
  const tried = new Set()
  const log = []

  const state0 = waterStateOf(b)
  if (!state0.inWater) {
    return { ok: true, reason: 'not-in-water', rounds: 0, target: null, kind: null, moved: 0, tried: [], log, note: '我本来就没在水里', state: state0 }
  }
  if (!ctx.walkTo && !ctx.swimUp) {
    return { ok: false, reason: 'no-executor', rounds: 0, target: null, kind: null, moved: 0, tried: [], log, note: '没人给我"怎么走"的接口 —— 这条得由宿主接上 walkTo / swimUp', state: state0 }
  }

  let lastRes = null
  let movedTotal = 0
  for (let round = 1; round <= maxRounds; round++) {
    if (ctx.signal?.aborted) {
      return { ok: false, reason: 'aborted', rounds: round - 1, target: null, kind: null, moved: movedTotal, tried: [...tried], log, note: '被取消了', state: waterStateOf(b) }
    }
    if (now() - t0 >= budgetMs) {
      return { ok: false, reason: 'budget-out', rounds: round - 1, target: null, kind: null, moved: movedTotal, tried: [...tried], log, note: `这一轮的 ${Math.round(budgetMs / 1000)} 秒用完了 —— 过一会儿再叫我一次`, state: waterStateOf(b) }
    }

    /* 找出口（把上一轮试过没用的目标排除掉，然后重新搜） */
    const res = waterExitSearch(b, { ...(opts.search ?? {}), avoid: tried.size ? tried : null })
    lastRes = res
    if (!res.found) {
      /* 兜底：头顶一路是水的话，上浮仍然是有效的（而且最省）—— 别因为"没找到干燥落脚点"
       * 就放弃一条明明能换气的路。 */
      const st = waterStateOf(b)
      const canUp = st.feet && (ctx.swimUp != null)
      if (canUp && res.reason !== 'budget-out') {
        log.push(`第 ${round} 轮：没找到出口（${res.reason}）⇒ 先试着直接上浮换气`)
        await executeRoute(self, { target: { x: st.feet.x, y: st.feet.y + 1, z: st.feet.z }, path: [{ x: st.feet.x, y: st.feet.y + 1, z: st.feet.z }] }, ctx)
        const after = waterStateOf(b)
        if (!after.inWater || (after.air != null && st.air != null && after.air > st.air)) {
          return { ok: true, reason: 'escaped', rounds: round, target: null, kind: 'surface', moved: movedTotal, tried: [...tried], log, note: '上浮之后能换气了（或者已经出水）', state: after }
        }
      }
      return { ok: false, reason: res.reason, rounds: round, target: null, kind: null, moved: movedTotal, tried: [...tried], log, note: res.note, state: waterStateOf(b) }
    }
    if (tried.has(keyOf(res.target))) {
      return { ok: false, reason: 'rounds-out', rounds: round, target: res.target, kind: res.kind, moved: movedTotal, tried: [...tried], log, note: '能找的出口都试过了，都没走通 —— 换个方向再叫我一次', state: waterStateOf(b) }
    }

    const before = feetOfBot(b)
    const beforeAir = waterStateOf(b).air
    log.push(`第 ${round} 轮：${waterSummaryOf(res)}`)
    const run = await executeRoute(self, res, ctx)
    movedTotal += Number.isFinite(run.moved) ? run.moved : 0

    /* **复核**（用户明确要求）：不能仅凭移动函数返回成功就恢复原任务 ——
     * 重新看位置、氧气、水里状态。
     * ⚠️ `reached` 不能只看"离目标够近"：出口就在正上方一格时，人**根本没动**也满足
     * "距离 ≤ 到达半径"，那样会把"一次都没挪"报成"到了"。所以必须要求
     * **真的踩到那一格**，或者**确实挪近了**。 */
    const after = feetOfBot(b)
    const st = waterStateOf(b)
    const distNow = distTo(after, res.target)
    const distWas = distTo(before, res.target)
    const atTarget = sameCell(after, res.target)
    const improved = distNow <= distWas - WATER_PROGRESS_EPS
    const gained = st.air != null && beforeAir != null && st.air > beforeAir
    const outOfWater = !st.inWater
    if (outOfWater || gained || atTarget || improved) {
      const escaped = outOfWater || atTarget
      return {
        ok: true,
        reason: escaped ? 'escaped' : 'improved',
        rounds: round,
        target: res.target,
        kind: res.kind,
        moved: movedTotal,
        tried: [...tried],
        log,
        note: escaped
          ? `到了${res.kind === 'dry' ? '岸上' : '那个能换气的地方'}`
          : '挪近了 / 气在回 —— 还没脱险，接着来',
        state: st,
      }
    }

    /* 这条路走不通 ⇒ 拉黑它，下一轮重新搜 */
    tried.add(keyOf(res.target))
    log.push(`第 ${round} 轮：往 (${res.target.x},${res.target.y},${res.target.z}) 走了 ${Math.round(run.moved * 10) / 10} 格，没靠近${run.error ? `（${run.error}）` : ''} ⇒ 换一条`)
    if (now() - t0 < budgetMs) await sleep(60)
  }

  return {
    ok: false,
    reason: 'rounds-out',
    rounds: maxRounds,
    target: lastRes?.target ?? null,
    kind: lastRes?.kind ?? null,
    moved: movedTotal,
    tried: [...tried],
    log,
    note: `试了 ${maxRounds} 条路线都没走通 —— 别在原地继续游，换个方向或者叫我用 mc_scan 看看四周`,
    state: waterStateOf(b),
  }
}

/**
 * 给 AI 看的一段话（走 `agent.steer` 送出去，或塞进 `mc_diag`）。
 * **每一次自动救援都必须调用它** —— 这就是"绝不偷偷接管"。
 */
export function waterReportText (res, trigger = null) {
  if (!res) return '水下恢复：没有结果'
  const why = trigger ? `（因为${WATER_TRIGGER_TEXT[trigger.why] ?? trigger.why}${trigger.detail ? `：${trigger.detail}` : ''}）` : ''
  const head = res.ok ? '🌊 我自己从水里出来了一趟' : '🌊 我在水里没出来'
  const lines = [`${head}${why} —— ${res.note}`]
  if (res.kind) lines.push(`目标类型：${res.kind}`)
  if (res.tried?.length) lines.push(`试过但没走通的：${res.tried.join(' / ')}`)
  for (const l of res.log ?? []) lines.push(`· ${l}`)
  lines.push(res.ok
    ? '我**没有**替你决定接下来去哪 —— 原来的任务要不要继续，你看一眼再定。'
    : '要救我：给个明确的目标（岸在哪 / 往哪个方向），或者用 mc_scan 看一眼四周再决定。')
  return lines.join('\n')
}
