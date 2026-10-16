/*
 * 移动那一层：现在只有两个"原地按/松控制位"的小原语 —— `jump` 与 `swimUp`。
 *
 * 大件按路线图第 ④ 条逐步搬进来：第三十五刀两个纯控制位（`jump` / `swimUp`）、
 * 第三十六刀移动主体（`walkSwim` / `walkTo` / `flyTo`）、第三十七刀 `walkPathfinder`（移动最后一块）。
 *
 * 两条都是"按住某个控制位一小会儿"：
 *   · `jump(self, ctx)` —— 原地蹦一下（爬台阶 / 从卡住里出来）。领移动号、只在还是自己时才松 jump，
 *     落地缓冲不超过本轮剩余时间；已 abort 或本轮时间用完就如实拒绝（不再固定占 520ms）。
 *   · `swimUp(self, opts, ctx)` —— 在水里按住 jump **上浮换气**（不是"跳"：水里按 jump 是浮在水面游）。
 *     判据用 `inWaterNow(b)` 而不是 `entity.isInWater`（泡在水柱里没贴水面时后者读出来是 undefined）。
 *
 * 形状：读写全是实例状态（`requireBot` / `callLeft` / `msLeft` / `abortSignal` / `position` / `_moveGen`）
 * ⇒ 第一参数收 `self`；`#beginMove` 是私有方法、模块够不着 ⇒ 由 core 的薄包装塞进 `ctx.bumpGen`
 *（迁移规矩第 28 条；`_moveGen` 本身是下划线公开字段，模块里照旧读它判"还是不是我"）。
 */
import { sleep, raceAbort, abortError, withTimeout, DESYNC_HINT } from './async-util.mjs'
import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg
import { callBudget, callSecText, budgetSecText, CALL_BUDGET_MS } from './budget.mjs'
import { inWaterNow } from './world-observer.mjs'
import { heldText, invSnap, invUsed } from './inventory.mjs'
import { isAir, isLiquid, isPassable } from './block-names.mjs'
import { classifyTerrainCached } from './terrain.mjs'
import { recoverFromWater } from './water-recovery.mjs'

/**
 * 给水下恢复控制器用的执行器 —— **就是这一层已有的 `walkTo` / `swimUp`**，不另起一套按键。
 * 用户 2026-10-15 的约束原话："实际移动仍通过现有接口执行，避免另起一套按键控制、移动代次或资源锁"。
 * `noWaterRecover` 防递归：恢复过程中再走一次路时不许再次触发恢复。
 */
function recoverCtxOf (self, ctx) {
  return {
    walkTo: (s, p, o = {}) => walkTo(s, p, { arrive: o.arrive, budget: o.budget }, { ...ctx, noWaterRecover: true }),
    swimUp: (s, o) => swimUp(s, o, ctx),
  }
}

/**
 * 把走路目标的 y 收到底面：那个 y **站不住**时，往下找最近能站的一层。
 *
 * 🔴 为什么必须有（用户 2026-10-13 实机报的"搭路一直搭到空气上"）：
 *    AI 给的走路目标 y 常常是**半空**——`mc_map`/`mc_scan` 报的"地表高度"在树林里是树冠顶、
 *    在山上是最高的石头，从实体/玩家那抄来的 y 也可能是对方站在高处时的值。
 *    `goals.GoalNear` 是按**三维距离**算的，于是 pathfinder 为了"离那个 y 近一点"，
 *    会一路**垫方块把自己顶上去**（返回值里的 `pillared`）——玩家看到的就是"往空气上搭"。
 *    实机证据：`mc_move {x:10,y:68,z:-100}` 只挪了 1 格却 `pillared: 9`（目标比脚下高 9 格）。
 *
 * 判据：脚下那格是**实心**（不是空气/液体）且这一格与头上一格都能穿过（`isPassable`）。
 * 找不到就**原样返回**（跨沟搭桥那种目标本来就该让 pathfinder 自己想办法）。
 *
 * @param {object} b 机器人
 * @param {number} x 目标 x
 * @param {number} y 目标 y（可能偏高）
 * @param {number} z 目标 z
 * @returns {number} 修正后的 y
 */
export function standableY (b, x, y, z) {
  const gx = Math.floor(x); const gy = Math.floor(y); const gz = Math.floor(z)
  const at = (xx, yy, zz) => {
    try { return b.blockAt(new Vec3(xx, yy, zz)) } catch { return null }
  }
  const canStand = (yy) => {
    const u = at(gx, yy - 1, gz); const a = at(gx, yy, gz); const c = at(gx, yy + 1, gz)
    if (!u || !a || !c) return false
    if (isAir(u.name) || isLiquid(u.name)) return false
    return isPassable(a.name) && isPassable(c.name)
  }
  if (canStand(gy)) return gy
  for (let d = 1; d <= 4; d++) if (canStand(gy - d)) return gy - d
  for (let d = 1; d <= 2; d++) if (canStand(gy + d)) return gy + d
  return gy
}
/** 原地跳一下（爬台阶用） */
export async function jump (self, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  /* 🔴 2026-10-08 审计⑥：以前固定占 520ms —— 不看预算、不认中断。
   *    探针：已 abort + `setCallDeadline(0)` 时仍按 jump 526ms 才返回（同条件 `flyTo` 1ms 就抛
   *    `mcAborted`）。用户已经点了停止，还会多做一个真实的跳跃动作。 */
  if (self.abortSignal?.aborted) throw abortError('跳跃', self.abortSignal)
  const left = self.msLeft()
  if (left <= 120) {
    throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"jump"}`)
  }
  /* 🔴 审计（第四份报告②）：jump 以前**不领 `_moveGen` 号**，finally 里无条件松 jump
   *    ⇒ 会把"接管者"（另一次移动/反射层）正按着的 jump 松掉。现在领号，只在还是自己时才松。 */
  const gen = bumpGen()
  const hold = Math.max(60, Math.min(320, left - 120))
  b.setControlState('jump', true)
  try {
    await raceAbort(sleep(hold), self.abortSignal, '跳跃')
  } finally {
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  // 落地缓冲（别超过本轮剩余时间）
  const rest = Math.max(0, Math.min(200, self.msLeft() - 60))
  if (rest > 0) await raceAbort(sleep(rest), self.abortSignal, '跳跃')
  return { position: self.position }
}

/**
 * 上浮换气（在水里按住 jump 游泳）。**淹死的机制**是氧气（`air`）掉到 0 之后开始掉血，
 * 所以正确动作是"先浮上来换气"，而不是挖水（水/岩浆是流体，挖不掉）。
 * 一次最多 3 秒（和别的动作一样，宁可少量多次），返回 rose（涨了几格）与 air。
 */
export async function swimUp (self, { hold = 3_000 } = {}, ctx = {}) {
  const bumpGen = ctx.bumpGen ?? (() => ++self._moveGen)
  const b = self.requireBot()
  const e = b.entity
  const airOf = () => (Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null)
  const y0 = e?.position?.y ?? null
  const air0 = airOf()
  /* 🔴 2026-10-08 实机：这里以前只看 `entity.isInWater` —— 而它在**泡在水柱里但没贴水面**
   *    时读出来是 undefined（prismarine-physics 的入水 AABB 从底部缩了 0.401）。
   *    实测机器人沉在 (-31,59,261)、脚/头两格都是 water、`onGround:false`，
   *    `swimUp` 却回"我本来就没在水里" ⇒ 淹死也救不了自己。改用和挖矿守卫同一个判据。 */
  if (!inWaterNow(b)) {
    return { inWater: false, air: air0, note: '我本来就没在水里 —— 这条是给"在水里憋气"用的' }
  }
  const want0 = Number.isFinite(Number(hold)) ? Number(hold) : 3_000
  /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前三个病一起犯 ——
   *   ① 完全不认中断（abort 后仍空转满 3 秒，`heldMs` 还是**假数据**）；
   *   ④ 预算归零时 `Math.max(200, …)` 白送 200ms（探针：`setCallDeadline(0)` ⇒ 真按了 215ms）；
   *   ⑧ `Number(hold) || 3_000` 把 `hold: 0` 当成 3000。
   *   现在：先看预算、领 `_moveGen` 号、每轮查 abort 与号、`heldMs` 报实际按住时长。 */
  const left = self.callLeft()
  if (left <= 300) {
    return {
      inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, reason: 'call-over', remaining: 1,
      hint: `这一轮的 ${callSecText()}用完了，我没按 —— 过一会儿再叫一次 mc_move{"mode":"swim"} 接着上浮`,
    }
  }
  const want = Math.max(0, Math.min(want0, 3_000, left - 300))
  if (want <= 0) {
    return { inWater: true, airBefore: air0, air: air0, rose: 0, heldMs: 0, note: 'hold 是 0（没让我按）—— 要上浮就再叫一次 mc_move{"mode":"swim"}' }
  }
  const gen = bumpGen()
  const t0 = Date.now()
  let held = 0
  let preempted = false
  try {
    b.setControlState('jump', true)
    while (Date.now() - t0 < want) {
      if (self.abortSignal?.aborted) throw abortError('上浮', self.abortSignal)
      await raceAbort(sleep(100), self.abortSignal, '上浮')
      held = Date.now() - t0
      if (self._moveGen !== gen) { preempted = true; break }              // 被别人接管了
      if (!inWaterNow(b)) break                                     // 已经出水
      const a = airOf()
      const rose = y0 != null && b.entity?.position ? b.entity.position.y - y0 : 0
      if (held > 500 && rose >= 0.4 && a != null && a >= 20) break        // 头露出水面、气在恢复
    }
  } finally {
    /* 🔴 报告②：只在**还是自己**的时候松 jump —— 否则会把接管者正按着的 jump 松掉。 */
    if (self._moveGen === gen) { try { b.setControlState('jump', false) } catch { /* 忽略 */ } }
  }
  const y = b.entity?.position?.y ?? null
  const air = airOf()
  const still = inWaterNow(b)
  if (preempted) {
    return {
      inWater: still, airBefore: air0, air, rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
      heldMs: held, reason: 'preempted', remaining: 1,
      hint: '另一次移动把我接管了（我没再按着 jump）—— 再叫一次 mc_move{"mode":"swim"} 接着上浮',
    }
  }
  return {
    inWater: still,
    airBefore: air0, air,
    rose: y0 != null && y != null ? Math.round((y - y0) * 100) / 100 : null,
    heldMs: held,
    ...(still
      ? {
          remaining: 1,
          hint: air != null && air >= 18
            ? '已经浮到水面、气在恢复 —— 接着用 mc_move 往岸上走（不知道岸在哪就先 mc_scan 找干燥方块）'
            : '还在水里 —— 再叫一次 mc_move{"mode":"swim"} 接着上浮；水挖不掉，别去 mc_dig 水',
        }
      : { note: '已经出水了' }),
  }
}

/* ─────────── 第三十六刀：移动主体（walkTo / walkSwim / flyTo）───────────
 * 三件都在这一层：`walkTo` 是公开入口，水里先走 `walkSwim`（A* 不把水当节点），
 * 上岸再交回 `#walkPathfinder`（那个留在 core，用 `ctx.walkPathfinder` 递进来 —— 它跟
 * 移动编号 / 控制位租约 / 事件监听缠得最紧，按路线图放最后）。
 * `#beginMove` / `#releaseControls` 也是私有件，同样走 `ctx`。
 */
/**
 * 在水里"直接游"到目标附近（**绕开 pathfinder**）。
 *
 * 🔴 为什么水里不能用 pathfinder：vendor 里那份 mineflayer-pathfinder 的 A* 明确
 *    拒绝把水当节点 —— `lib/movements.js:503` `if (blockC.liquid) return // dont go underwater`、
 *    `:523` 同一句、`:571` `if (self.getBlock(node,0,0,0).liquid) return // cant jump from water`；
 *    控制器在水里只会按住 jump（`index.js:611-613`）。所以"泡在水里、目标在岸上"时
 *    它要么只给一条只有一个节点的路、要么直接 NoPath，实机表现就是**"4 秒只挪 1 格"**。
 *    直接控制 `forward + jump` 实测 **2.05~2.27 格/秒**（正好等于 prismarine-physics 的
 *    水里水平极限 `liquidAcceleration/(1-waterInertia)` = 0.02/0.2 = 0.1 格/tick），快近 10 倍。
 *    水里按 jump 不是为了"跳"，是**浮在水面**游（贴底会卡、也慢）。
 *
 * 上岸就交还给 pathfinder（返回 `outOfWater: true`），别自己在地面上走 —— 地面上它比手写按键靠谱。
 */
export async function walkSwim (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs } = {}, ctx = {}) {
  const b = self.bot
  const goal = new Vec3(Number(target.x), Number(target.y), Number(target.z))
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const r2 = (n) => Math.round(n * 100) / 100
  if (!inWaterNow(b)) {
    // 本来就在岸上（`mc_move {"mode":"swim"}` 给了坐标时可能这样）：按普通走路走
    /* 🔴 2026-10-08 第四份审计报告 ⑨：这里以前把**没按 `msLeft()` 钳过**的 `budget` 直接往下传 ——
     *    平时走不到（`walkTo` 判 `isInWater` 与这里判 `#inWaterNow` 之间没有 await，读的是同一个值），
     *    但哪天 `cfg.moveBudgetMs` 变成历史遗留的大值，`withTimeout(work, budget)` 就会是几十秒。
     *    埋着的雷，照样钳一遍（`budgetAsked` 仍留原值，供 cutByCall 判"是被本轮截断还是真走不通"）。 */
    const leftMs = self.msLeft()
    const r = await ctx.walkPathfinder(goal, {
      arrive,
      budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
      budgetAsked: callBudget(budget),
    })
    return { ...r, swam: false, outOfWater: true, note: '我没在水里，这条就按普通走路走' }
  }
  const t0 = Date.now()
  const start = b.entity.position.clone()
  /* 🔴 2026-10-08 审计①：这条游泳循环以前**不认中断、也不领移动号** ——
   *    已 abort 的信号 + budget 1200ms 实测照样跑满 1313ms、forward/jump 各按 5 次
   *    （同条件 `flyTo` 1ms 就抛 mcAborted）；用户点停止后机器人还在水里游，而且它的 finally
   *    会把别人正在走的那份控制位一起松掉。现在：领号 + 每轮查 abort/号，收尾也看号。 */
  const gen = ctx.beginMove()
  const left0 = self.msLeft()
  const bd = left0 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget), left0))
  let moved = 0
  const preemptResult = (end) => ({
    arrived: false, position: at(end), ms: Date.now() - t0,
    remaining: r2(end.distanceTo(goal)), moved: r2(start.distanceTo(end)),
    via: 'swim', stuck: true, reason: 'preempted', outOfWater: !inWaterNow(b),
    hint: '这次游泳被**另一次移动**接管了：等它结束，再叫一次 mc_move 往同一个目标游就行，**不是游不动**。',
  })
  try {
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('游泳', self.abortSignal)
      if (self._moveGen !== gen) return preemptResult(b.entity?.position ?? start)
      const me = b.entity.position
      const left = me.distanceTo(goal)
      moved = r2(start.distanceTo(me))
      if (left <= arrive) {
        return { arrived: true, position: at(me), ms: Date.now() - t0, moved, via: 'swim', remaining: r2(left) }
      }
      // 每 250ms 重新对准：水流、撞岸、浮起来都会把朝向推偏（只对准一次会游歪）
      try { await b.lookAt(goal.offset(0, 1.0, 0), true) } catch { /* 假 bot 没有 lookAt */ }
      b.setControlState('forward', true)
      b.setControlState('jump', true)      // 浮在水面游（不是跳）
      await raceAbort(sleep(250), self.abortSignal, '游泳')   // 可中断（用户点停止要立刻出来）
      // 已经上岸：剩下的路交给 pathfinder（地面上它更靠谱）
      if (!inWaterNow(b) && b.entity?.onGround) break
    }
  } finally {
    // 只有"我还是最新那次移动"才允许松控制位（被抢占时松了会把正在走的那份一起停掉）
    if (self._moveGen === gen) ctx.releaseControls()
  }
  const end = b.entity?.position ?? start
  moved = r2(start.distanceTo(end))
  const left = r2(end.distanceTo(goal))
  const outOfWater = !inWaterNow(b)
  return {
    arrived: false,
    position: at(end),
    ms: Date.now() - t0,
    remaining: left,
    moved,
    via: 'swim',
    stuck: !outOfWater,
    reason: outOfWater ? 'swim-shore' : 'swim-budget',
    outOfWater,
    hint: outOfWater
      ? `已经上岸了（游了 ${moved} 格，离目标 ${left} 格）—— 再叫一次 mc_move 到同一个目标，它会自己走完。`
      : `还在水里：游了 ${moved} 格（离目标 ${left} 格）—— 再叫一次 mc_move 往同一个目标游，会接着游。`,
  }
}

/**
 * 通过 mineflayer-pathfinder 走到目标。
 * 这是唯一的移动实现：不再保留手写的按键、盲跳、挖方块或垫脚兜底。
 * ⚠️ 唯一的例外：**在水里**先交给 `#walkSwim`（A* 不把水当节点，见它的注释）。
 */
export async function walkTo (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs } = {}, ctx = {}) {
  const b = self.requireBot()
  // 🔴 在水里：A* 不把水当节点（见 #walkSwim 的注释），实机表现是"4 秒挪 1 格"。
  //    先直接游；上了岸、还有时间，再把剩下的路交给 pathfinder 走完。
  //    ⚠️ 判据用 `#inWaterNow`：`entity.isInWater` 在泡水柱里会读出 undefined（实机踩过）。
  if (inWaterNow(b)) {
    const swim = await walkSwim(self, target, { arrive, budget }, ctx)
    const canWalk = self.pfReady && typeof b.pathfinder?.goto === 'function'
    /* 🔴 用户点名的"水下寻路"就接在这里（2026-10-15）：**游不动了**（还泡在水里、没到目标）
     * 就交给恢复控制器 —— 它负责**找出口、选路线、复核进度**；
     * 真正移动仍然走这一层已有的 `walkTo` / `swimUp`，**不另起一套游泳按键控制**
     * （用户："建议新增模块只管理水域导航策略。实际移动仍通过现有接口执行"）。
     * `noWaterRecover` 防递归：恢复过程中再走一次路时，不许再次触发恢复。
     * 🔴 时间不够就**别开这一趟**（用户："继续用现有预算与取消机制，避免一次出口搜索
     *    耗尽整个工具调用预算"）—— 剩不到 1.5 秒时老实把"还在水里"报回去。 */
    if (swim.stuck && !ctx.noWaterRecover && self.msLeft() > 1_500) {
      const rec = await recoverFromWater(self, { budgetMs: Math.min(12_000, Math.max(0, self.msLeft() - 900)) }, recoverCtxOf(self, ctx))
      const out = !inWaterNow(b)
      return {
        ...swim,
        stuck: !out,
        outOfWater: out,
        waterRecover: rec,
        hint: rec?.ok
          ? `我**自己从水里出来了一趟**（${rec.note}）—— 原来的目标还要不要接着走，你看一眼再定。`
          : `还在水里，而且没找到出口（${rec?.reason ?? 'unknown'}）：${rec?.note ?? ''}`,
      }
    }
    if (swim.arrived || !swim.outOfWater || !canWalk) return swim
    const left = self.msLeft()
    if (left < 500) return swim
    const rest = await ctx.walkPathfinder(target, { arrive, budget: Math.max(0, Math.min(callBudget(budget), left)), budgetAsked: callBudget(budget) })
    return { ...rest, swam: true, swimMoved: swim.moved, swimMs: swim.ms }
  }
  if (!self.pfReady || typeof b.pathfinder?.goto !== 'function') {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder-unavailable',
      stuck: true,
      reason: 'PathfinderUnavailable',
      hint: 'mineflayer-pathfinder 没有加载，已停止移动，避免盲跳。装一下它（npm i mineflayer-pathfinder）再重启 MCP 客户端；细节看 mcp-mc-agent.log。',
    }
  }
  /* 🔴 2026-10-08 审计⑦：以前是 `Math.max(150, Math.min(callBudget(budget), self.msLeft()))`
   *    —— `msLeft()` 已经是 0 时，`Math.min` 给出 0，外层 `Math.max` 又把它抬回 150 ⇒ 照样再跑 150ms。
   *    本轮时间真的用完了就**别开始**，如实告诉模型"再叫一次接着走"。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) {
    return {
      arrived: false,
      position: { x: Math.floor(b.entity.position.x), y: Math.floor(b.entity.position.y), z: Math.floor(b.entity.position.z) },
      remaining: Number(Math.hypot(b.entity.position.x - target.x, b.entity.position.z - target.z).toFixed(2)),
      moved: 0,
      via: 'pathfinder',
      stuck: true,
      reason: 'call-over',
      hint: `这一轮的走路时间已经用完了（单次调用最多 ${budgetSecText()}）—— 直接再叫一次 mc_move 往同一个目标走，会接着走。`,
    }
  }
  return await ctx.walkPathfinder(target, {
    arrive,
    // 🔴 单次调用 ≤11 秒：预算收进 CALL_BUDGET_MS，且不超过本轮剩余时间。
    //    走不到不是失败，是"这一轮用完了"—— 再叫一次接着走。
    //    `msLeft()` 没设截止时刻时返回 CALL_MS（11000），用完时返回 0（别再 `||` 补 10 秒）。
    budget: Math.max(0, Math.min(callBudget(budget), leftMs)),
    budgetAsked: callBudget(budget),
  })
}

/**
 * 飞到某个坐标（仅创造模式）。
 *
 * 🔴 **刻意不使用 mineflayer 的 `bot.creative.flyTo`** —— 它有两处硬伤，
 *    2026-09-15 真机（mc）踩得很惨，三个症状全部源于它：
 *
 *   ① 结尾是 `await once(bot, 'move', 0)` —— **timeout 传 0 = 永不超时**。
 *      服务端不回 move 回执就永久挂住。真机日志里 `飞行 超时（30000ms）` /
 *      `接近放置点 超时（30000ms）` 反复出现，就是这个。
 *      **表现特别坑**：客户端位移其实已经改了 → **动作生效了，但工具迟迟不返回、
 *      最后报超时**（用户原话："移动有时候已经生效了，但等很久工具才返回，返回的是超时"）。
 *
 *   ② 它调 `startFlying()` 把 `physics.gravity` 置 0，却**从不 `stopFlying()`**。
 *      一次失败就把机器人永久留在**零重力** → 之后 `walkTo` 完全失效
 *      （真机症状：fly 超时之后 walk 30s 原地不动）。
 *
 * 所以这里自己实现：小步推进 + **进度检测**（推不动就早停，不耗满预算）+ 预算上限，
 * 并且**无论如何在 finally 里恢复重力**。到位就返回，**不等服务端回执**。
 */
export async function flyTo (self, x, y, z, { budget = CALL_BUDGET_MS } = {}, ctx = {}) {
  const b = self.requireBot()
  if (b.game?.gameMode !== 'creative') throw new Error('飞行只在创造模式可用（当前 ' + b.game?.gameMode + '）')
  const target = new Vec3(Number(x), Number(y), Number(z))
  const t0 = Date.now()
  /* 🔴 单次调用 ≤11 秒（创造模式飞远路要分几次）；`msLeft()` 用完时是 0，别 `||` 补 10 秒。
   * 🔴 2026-10-08 审计⑤⑦：默认值以前是 20_000（比单次上限还大），而且调用方**不传 budgetMs** ⇒
   *    AI 写 `budgetMs:2000` 想"飞一小段"照样跑满 10 秒；`msLeft()` 用完时又被外层 max 抬回 150ms。 */
  const leftMs = self.msLeft()
  if (leftMs <= 100) throw new Error(`这一轮的 ${callSecText()}用完了（单次调用最多 ${budgetSecText()}）—— 过一会儿再叫一次 mc_move{mode:"fly"}`)
  const bd = Math.max(0, Math.min(callBudget(budget), leftMs))
  /* 🔴 2026-10-08 第四份审计报告 ⑥⑦：flyTo 以前**不领 `_moveGen` 号**（体系外的一块）——
   *    它靠直接写 `b.entity.position` 移动，不看控制位也不看 pathfinder，
   *    所以别的移动/反射层"抢占"它时它照飞；循环里的 `sleep(60)` 也没 `raceAbort`（中断最多晚 60ms）。
   *    现在领号 + 每轮查号 + 可中断 sleep + finally 只在还是自己时 `stopFlying()`。 */
  const gen = ctx.beginMove()
  let preempted = false
  let flying = false                       // 这次调用有没有真的 startFlying（收尾要认它，不认号）
  let last = b.entity.position.clone()
  let lastProgress = Date.now()
  self._selfMovingAt = Date.now()          // 别把自己飞当成"被传送"
  try {
    b.creative.startFlying()
    flying = true
    while (Date.now() - t0 < bd) {
      if (self.abortSignal?.aborted) throw abortError('飞行', self.abortSignal)
      if (self._moveGen !== gen) { preempted = true; break }
      const pos = b.entity.position
      const v = target.minus(pos)
      const mag = Math.hypot(v.x, v.y, v.z)
      if (mag <= 1.5) break
      const step = Math.min(mag, 2)
      b.physics.gravity = 0
      b.entity.velocity = new Vec3(0, 0, 0)
      b.entity.position = pos.offset((v.x / mag) * step, (v.y / mag) * step, (v.z / mag) * step)
      await raceAbort(sleep(60), self.abortSignal, '飞行')
      if (b.entity.position.distanceTo(last) > 0.3) {
        last = b.entity.position.clone()
        lastProgress = Date.now()
      } else if (Date.now() - lastProgress > 2500) {
        break                               // 推不动了（服务端可能不接受客户端位移），别耗满预算
      }
    }
  } finally {
    // 🔴 必须恢复重力：否则之后走路全废（见上面 ②）
    /* 🔴 报告⑥：被接管了就别动接管者的状态。
     * 🔴 报告 H7（2026-10-13）：但 `startFlying()` 是**这次调用**做的，重力必须由这次调用恢复 ——
     *    以前这里也带 `_moveGen === gen` 守卫，被抢占那条路（号变了）会跳过它，而全仓没有第二处
     *    `stopFlying` ⇒ `physics.gravity` 永久为 0（之后走路/跳跃全废，只能重连）。
     *    判据改成"我起过飞就我收"，跟号无关：别人接管的是"继续移动"，不是"替我恢复重力"。 */
    if (flying) { try { b.creative.stopFlying() } catch { /* 忽略 */ } }
    self._selfMovingAt = Date.now()
  }
  const p = b.entity.position
  const distance = Number(p.distanceTo(target).toFixed(2))
  const arrived = distance <= 2.5
  return {
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    distance, arrived, ms: Date.now() - t0,
    ...(preempted ? { reason: 'preempted', hint: '另一次移动把我接管了（我停了飞行）—— 再叫一次 mc_move{mode:"fly"} 往同一个点飞' } : {}),
    ...(arrived ? {} : {
      note: `没到目标（还差 ${distance} 格）。`
        + (Date.now() - t0 >= bd - 120
          ? `这一轮的 ${callSecText()}用完了（飞了 ${Math.round((Date.now() - t0) / 1000)} 秒）—— 直接再叫一次 mc_move{mode:"fly"} 往同一个点飞，会接着飞。`
          : '创造模式直飞是**客户端位移**，服务端未必接受（反作弊/延迟）——可改用 mc_move{mode:"walk"}，或挑更近的点位。'),
    }),
  }
}

/* ══ P0-1 移动进度监控 + 自动脱困阶梯（用户 2026-10-15 方案）══════════════════
 *
 * 为什么要有这一层：vendor 的 pathfinder 只在"**3.5 秒没走到下一个路径节点**"时
 * 自己 `resetPath('stuck')`（`mineflayer-pathfinder/index.js:632`）——那只是**重算**，
 * 既不换策略，也不如实告诉模型"我卡住了"。实机表现就是用户报的：能走到附近，
 * 但绕路、卡方块边缘、反复跳跃，最后要么谎报到达、要么无限重试。
 *
 * 判据（**用户特别点名的坑**："不要只根据速度为零判断卡住"）：
 *   · 只认"**既没挪动、也没靠近**"——`剩余距离`连续 `MOVE_STUCK_MS` 没有改善才算卡住；
 *   · 跳跃、落地、等方块更新时位置本来就不前进 ⇒ "正在挖 / 正在放 / 悬空"算**正常等待**，
 *     把进度时钟往后推（最多推 `MOVE_BUSY_MAX_MS`，免得一直挖个不停就永远不判卡）。
 *
 * 脱困阶梯三级（见 `MOVE_ESCAPES`）：重算路径 → 跳跃脱困 → 后退再寻路；三级用完还是
 * 没进展就明确报 `unreachable`，**不再无限重试**。
 */
export const MOVE_SAMPLE_MS = 600       // 采样间隔（用户建议 500–1000ms）
export const MOVE_STUCK_MS = 2400       // 连续这么久"既没挪动也没靠近" ⇒ 卡住（用户建议 2–3 秒）
export const MOVE_PROGRESS_EPS = 0.35   // 靠近这么多格才算"有进展"
export const MOVE_BUSY_MAX_MS = 6000    // 一直挖/一直悬空超过这么久，就不再当"正常等待"
export const MOVE_JUMP_MS = 320         // 跳跃脱困按住 jump 多久
export const MOVE_BACK_MS = 420         // 后退脱困按住 back 多久
/* P1：一次 `goto` 里路径被**失效**这么多次 ⇒ 别再等"没进展"了，直接进脱困阶梯。
 * 依据：vendor 自己会在 3.5s 无节点进展时 `resetPath('stuck')`，但它只会**重算同一条**；
 * 一个 goto 里失效这么多次，说明"光重算没用"（世界在变 / 一直被人挡），换策略才有意义。 */
export const MOVE_RESET_LIMIT = 4
/** 脱困阶梯（第 1 级 = `MOVE_ESCAPES[0]`）。走完还没进展 ⇒ 报 `unreachable`。 */
export const MOVE_ESCAPES = ['repath', 'jump', 'backoff']

/** 第 `n` 级脱困动作（0 起）；超出阶梯返回 `null`（= 该认输了）。 */
export function escapeStepOf (n) { return MOVE_ESCAPES[n] ?? null }

/** 脱困动作的中文名（日志 / 返回值文案用）。 */
export function escapeTextOf (step) {
  return step === 'repath' ? '重算路径'
    : step === 'jump' ? '跳跃脱困'
      : step === 'backoff' ? '后退再寻路'
        : '放弃'
}

/**
 * "现在算不算正常等待" —— 挖着 / 放着 / 悬空（跳跃落地中）时位置不前进是正常的。
 * 防假 bot：字段缺了当 false（不是"忙"，照常判卡）。
 */
export function moveBusyNow (b) {
  try {
    const pf = b?.pathfinder
    if (pf?.isMining?.() === true || pf?.isBuilding?.() === true) return true
    return b?.entity?.onGround === false
  } catch { return false }
}

/**
 * 移动进度采样器（P0-1）。每 `sampleMs` 看一眼"离目标还有多远"，判卡住时 **reject**
 * 一个带 `mcStuck: true` 的错误；其余情况永远 pending，由 `stop()` 收尾。
 *
 * ⚠️ 不自己按控制位：`pathfinder` 每个 physicsTick 都会把 `forward/jump/sprint`
 *    按回去（vendor `monitorMovement`），采样器里按什么都会被立刻覆盖 —— 脱困动作
 *    必须由调用方在"pathfinder 已经停掉"的窗口里做（见 `escapeMove`）。
 *
 * 注入 `now` / `setTimer` / `clearTimer` 是为了离线测试能拿假时钟驱动它。
 *
 * @returns {{ promise: Promise<void>, stop: () => void, info: () => object }}
 */
export function moveProgressWatcher (b, target, {
  arrive = 1.6, ty = null,
  sampleMs = MOVE_SAMPLE_MS, stuckMs = MOVE_STUCK_MS,
  busyMaxMs = MOVE_BUSY_MAX_MS, progressEps = MOVE_PROGRESS_EPS,
  resetsOf = null, resetLimit = MOVE_RESET_LIMIT,
  now = () => Date.now(),
  setTimer = (fn, ms) => setInterval(fn, ms),
  clearTimer = (h) => clearInterval(h),
} = {}) {
  const goalVec = new Vec3(target.x, ty ?? target.y, target.z)
  const distOf = () => {
    try { return b.entity.position.distanceTo(goalVec) } catch { return Infinity }
  }
  let stopped = false
  let reject = null
  let best = distOf()
  let lastProgressAt = now()
  let busySince = null
  let stuckInfo = null
  const promise = new Promise((_, rej) => { reject = rej })
  // ⚠️ 竞速可能先结束、采样器随后才 reject ⇒ 自己吞掉，否则是"未处理拒绝"（会炸宿主）。
  promise.catch(() => {})
  /** 路径被失效了几次（`resetsOf` 抛错就当 0 —— 判卡不该因为数数失败而失效）。 */
  const resetsNow = () => { try { return resetsOf ? Number(resetsOf()) || 0 : 0 } catch { return 0 } }
  /**
   * 认输：收掉定时器 + reject 一个带 `mcStuck` 的错误。
   * `thrash` = 成因是"路径一直被失效"（而不是"2.4 秒没进展"）—— 两者给模型的下一步不一样。
   */
  const giveUp = (d, { ms = 0, thrash = false } = {}) => {
    stopped = true
    try { clearTimer(timer) } catch {}
    stuckInfo = { ms, remaining: Number(d.toFixed(2)), ...(thrash ? { thrash: true, resets: resetsNow() } : {}) }
    const err = new Error(thrash
      ? `路径被反复失效（这一次 goto 里被重算了 ${resetsNow()} 次）—— 光重算没用（离目标还有 ${d.toFixed(1)} 格）`
      : `移动卡住：${(stuckMs / 1000).toFixed(1)} 秒里既没挪动、也没靠近（离目标还有 ${d.toFixed(1)} 格）`)
    err.mcStuck = true
    err.remaining = Number(d.toFixed(2))
    if (thrash) err.mcPathThrash = true
    reject(err)
  }
  const timer = setTimer(() => {
    if (stopped) return
    const t = now()
    const d = distOf()
    if (d <= arrive + 0.6 || d < best - progressEps) {
      // 到了 / 真的靠近了 —— 有进展，进度时钟归零（**在进展面前，失效次数不算数**：
      // 一直被打断但还在往前挪，那就让它挪）
      best = Math.min(best, d)
      lastProgressAt = t
      busySince = null
      return
    }
    if (moveBusyNow(b)) {
      // 挖着 / 放着 / 悬空：算正常等待，推后进度时钟（但最多推 busyMaxMs）
      if (busySince == null) busySince = t
      if (t - busySince < busyMaxMs) { lastProgressAt = t; return }
    } else busySince = null
    /* P1：**路径失效重算** —— vendor 自己会 `resetPath('stuck')` 重算，但它只重算**同一条**。
     * 一个 `goto` 里"没进展 + 又失效了太多次" ⇒ 世界在变 / 一直被挡，"光重算没用"，
     * 直接进脱困阶梯换策略，不用再等满 `stuckMs`。 */
    if (resetsOf && resetLimit > 0 && resetsNow() >= resetLimit) { giveUp(d, { ms: t - lastProgressAt, thrash: true }); return }
    if (t - lastProgressAt >= stuckMs) giveUp(d, { ms: t - lastProgressAt })
  }, sampleMs)
  return {
    promise,
    stop () { if (stopped) return; stopped = true; try { clearTimer(timer) } catch {} },
    info: () => ({ best: Number(best.toFixed(2)), stuck: stuckInfo }),
  }
}

/**
 * 走一级脱困动作（P0-1）。**必须在"pathfinder 已经停掉"的窗口里跑**：
 * 先 `ctx.stopPathing(b)`（`setGoal(null)` ⇒ `resetPath` + `clearControlStates`），
 * 否则 vendor 每个 physicsTick 都会把 `forward/jump` 按回去，我们按什么都被立刻覆盖；
 * 顺带让上一轮的 `goto` 以 `GoalChanged` 收场（调用方已经 `.catch(()=>{})`）。
 *
 * ⚠️ 三级动作**都不换 goal 对象** —— vendor 的 `goto` 监听 `goal_updated`，换了对象
 *    就直接以 `GoalChanged` 拒绝（`lib/goto.js:35`），等于把这次走路判死。
 */
export async function escapeMove (b, goal, step, ctx = {}) {
  try { ctx.stopPathing?.(b) } catch {}
  await sleep(60)                       // 让 pathfinder 的 physicsTick 把控制位松开
  if (step === 'jump') {
    try { b.setControlState('jump', true) } catch {}
    await sleep(MOVE_JUMP_MS)
    try { b.setControlState('jump', false) } catch {}
  } else if (step === 'backoff') {
    // 贴墙/贴角时原地重算还是同一条死路 —— 先退开半步再重算
    try { b.setControlState('back', true) } catch {}
    await sleep(MOVE_BACK_MS)
    try { b.setControlState('back', false) } catch {}
  }
  // 'repath' 不做额外动作：重新 `goto` 本身就是一次重算
}

/**
 * 用 pathfinder 走到目标（**现成的防卡住寻路**：自己绕路、挖穿挡路的方块、垫 1×1 塔、过门）。
 *
 * 返回值保持 `arrived / moved / remaining / stuck / hint` 结构；
 * 上层 `mc_move` 和自主层直接使用；额外带 `via:"pathfinder"` 便于排查。
 */
export async function walkPathfinder (self, target, { arrive = 1.6, budget = self.cfg.moveBudgetMs, budgetAsked = null } = {}, ctx = {}) {
  const b = self.bot
  const { goals, Movements } = self._pf
  const t0 = Date.now()
  const start = b.entity.position.clone()
  const at = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) })
  const startRemaining = Math.hypot(start.x - target.x, start.z - target.z)
  /* 🔴 目标 y 可能是半空（地图/扫描给的是"地表高度"、树冠、别人站的 y）—— 直接朝那个 y 走，
   *    pathfinder 会一路垫方块往上爬（"搭路一直搭到空气上"）。收到底面再走。 */
  const ty = standableY(b, target.x, target.y, target.z)
  const goal = new goals.GoalNear(Math.floor(target.x), ty, Math.floor(target.z),
    Math.max(0, Math.round(arrive - 0.6)))
  // 地形分类（导航 P2，用户 m02868 的"地形分类 + 路径评分"）：
  // **只换权重，不换算法** —— 台阶上把挖穿调便宜一点、沟边把垫方块调便宜一点、
  // 岩浆边一格都不许往下跳。看错了顶多走回原来的路，不会让机器人做危险动作。
  const terrain = classifyTerrainCached(b)
  const mv = ctx.movements(terrain)
  if (!mv) throw new Error('pathfinder 的 Movements 造不出来（插件没挂上？）')
  if (terrain.kind !== 'flat' && terrain.kind !== 'unknown') {
    self.log(`🧭 脚边是${terrain.text}（${terrain.note}）—— 按这一类调寻路权重`)
  }
  // 🔴 上一次 `mc_dig` 超时可能留下一个还在后台跑的采集任务（它按着 forward、
  //    占着 pathfinder）—— 不先停掉，这次走路会和它抢控制权：实机表现是
  //    "15 秒只挪 0.03 格、reason:stuck"。见 #cancelCollect 的注释。
  if (ctx.collectBusy(b)) {
    self.log('⚠️ 上次的采集任务还在后台跑（超时没停掉）—— 先停掉它再走路')
    await ctx.cancelCollect(b)
  }
  const gen = ctx.beginMove()      // 领号：这次走路从此是"最新的一次移动"
  b.pathfinder.setMovements(mv)
  let why = null
  let dug = 0, placed = 0
  const held0 = heldText(b)
  const snap0 = invSnap(b)     // 垫路会吃掉背包里的方块 —— 走完要如实报"用掉了什么、手上还剩什么"
  /**
   * 垫路/挖路的如实报告：`pillared` 只说了"垫了几块"，模型据此**不知道垫的是泥土**
   * 也不知道手上现在攥着什么（2026-10-07 实机：垫完爬出矿坑后拿着泥土去刨石头）。
   */
  const roadInfo = () => {
    if (!placed) return {}
    const used = invUsed(b, snap0)
    const held = heldText(b)
    return {
      ...(used.length ? { pillaredWith: used[0].name } : {}),
      ...(held !== held0 ? { held, heldBefore: held0 } : {}),
    }
  }
  let emptyNoPath = false
  const onUpdate = (r) => {
    if (r?.status && r.status !== 'success') why = r.status
    /* 🔴 2026-10-08 审计③：A* 一个邻居都生成不出来时 `path = []`，vendor 的 `lib/goto.js:22-30`
     *    对**空路径**的 noPath 分支是"无错 resolve"（只有非空路径才 reject NoPath）⇒ 我们拿到
     *    "成功"却离目标很远。旧代码据此报 `preempted`（"不是走不通"），模型于是一遍遍重发同一个
     *    到不了的点。这里把"空路径的 noPath"单独记下来。 */
    if (r?.status === 'noPath' && Array.isArray(r?.path) && r.path.length === 0) emptyNoPath = true
  }
  /* P1：**路径失效计数** —— vendor 会在 3.5s 无节点进展时 `resetPath('stuck')`，另外还有
   * `block_updated` / `path_stopped` / `goal_updated` 等理由。同一个 `goto` 里反复失效
   * = 这条路一直在被世界变化（别人放的方块、实体、岩浆流）打断，**光重算没用**。 */
  let pathResets = 0                 // 本轮 goto（每一轮都归零）
  let pathResetsTotal = 0            // 整次调用
  const resetReasons = {}
  const onReset = (reason) => {
    why = reason
    pathResets++; pathResetsTotal++
    const k = String(reason ?? 'unknown')
    resetReasons[k] = (resetReasons[k] ?? 0) + 1
  }
  const onDig = () => { dug++ }
  const onBlock = (oldB, newB) => { if (oldB && newB && oldB.boundingBox !== 'block' && newB.boundingBox === 'block') placed++ }
  // ⚠️ 事件名要防着"假 bot"（自检里的最小物理 bot 没有 on/removeListener）
  const off = []
  const listen = (ev, fn) => { if (typeof b.on === 'function') { b.on(ev, fn); off.push([ev, fn]) } }
  listen('path_update', onUpdate); listen('path_reset', onReset)
  listen('diggingCompleted', onDig); listen('blockUpdate', onBlock)
  /* P0-1：一次 `goto` 到底不够 —— 卡住时按阶梯换策略再试（见上面的常量注释）。
   * 每一轮都是**全新的 `goto(同一个 goal 对象)`**：重发前先由 `escapeMove` 把上一轮真停掉，
   * 所以不会攒下重复的 `goal_reached` 监听器。 */
  let repathCount = 0
  /* P1：其中有多少次是**因为路径被反复失效**而进阶梯的（不是"没进展"）—— 分开报，
   * 因为给模型的下一步不同：一个该换目标点，一个该先看看世界在变什么。 */
  let pathThrash = 0
  let watch = null
  /** 脱困次数（P0-1）与路径失效次数（P1）：>0 才报 —— 模型据此知道"这次走得磕磕绊绊"。
   *  外加地形分类（P2）：只有不是平地时才报（平地是默认，报了纯占地方）。 */
  const moveInfo = () => ({
    ...(terrain.kind === 'flat' || terrain.kind === 'unknown' ? {} : { terrain: terrain.kind }),
    ...(repathCount ? { repathCount } : {}),
    ...(pathThrash ? { pathThrash } : {}),
    ...(pathResetsTotal >= 2 ? { pathResets: pathResetsTotal, pathResetReasons: { ...resetReasons } } : {}),
  })
  try {
    for (let attempt = 0; ; attempt++) {
      if (attempt > 0) {
        const step = escapeStepOf(attempt - 1)
        if (!step) {
          // 阶梯走完还是没进展 —— 如实认输，**不再无限重试**
          const err = new Error(`脱困阶梯用完了（重算 ${repathCount} 次）还是走不动`)
          err.mcStuck = true
          err.mcExhausted = true
          throw err
        }
        repathCount++
        self.log(`🔁 走不动了 → 第 ${attempt} 级脱困：${escapeTextOf(step)}（累计重算 ${repathCount} 次）`)
        await escapeMove(b, goal, step, ctx)
      }
      pathResets = 0                               // 本轮重新数（脱困动作自己也会 reset 一次）
      const work = b.pathfinder.goto(goal)
      work.catch(() => {})                         // race 可能先结束：别让它变成"未处理拒绝"（会炸宿主）
      // `ctx.watchOpts` 是给离线测试注入假时钟用的（不然一套断言要真等 2.4 秒 × 4 轮）
      watch = moveProgressWatcher(b, target, {
        arrive, ty, resetsOf: () => pathResets, ...(ctx.watchOpts ?? {}),
      })
      try {
        await Promise.race([
          // 总时间仍以 `budget` 为界（脱困动作也吃时间，所以这里用**剩余**预算）
          raceAbort(withTimeout(work, Math.max(200, budget - (Date.now() - t0)), '寻路'),
            self.abortSignal, '寻路'),
          watch.promise,
        ])
        watch.stop(); watch = null
        break                                      // 正常结束（到了 / 普通失败）⇒ 下面照旧复核距离
      } catch (e) {
        watch.stop(); watch = null
        if (e?.mcPathThrash) pathThrash++          // P1：这次是被"路径反复失效"逼进阶梯的
        if (e?.mcStuck) continue                   // 卡住 ⇒ 下一轮走脱困阶梯
        throw e
      }
    }
    const end = b.entity.position
    // 复核距离要用**收过的 ty**（不然目标 y 在半空时，明明站到它脚下了也会被判成"还差 9 格"）
    const left = end.distanceTo(new Vec3(target.x, ty, target.z))
    /* P1：**到达判定分两轴看** —— 只看三维距离会漏掉一种假成功：水平已经到位、垂直却差着一两格
     * （站在目标正上方/正下方，比如目标格旁边有个坑），三维距离照样小于阈值 ⇒ 被报成"到了"。
     * 水平仍用 `arrive + 1.0`（宽松，允许"到附近"）；垂直卡在 ±1.5 格（一步台阶以内）。 */
    const horiz = Math.hypot(end.x - target.x, end.z - target.z)
    const vert = end.y - ty
    const vertBad = vert < -1.5 || vert > 1.5
    // ⚠️ 现成的插件报"到了"，也**自己核一遍距离**：`goal_reached` 个别情况会早一点
    //    （目标格被占住 / 站在半砖上 / 只到附近），盲信就又变成"谎报 arrived"。
    if (left > arrive + 1.0 || vertBad) {
      // 🔴 先分清"插件真的早报"还是"别人的 goal_reached 把我这次 goto 一起 resolve 了"。
      //    vendor 的 lib/goto.js:60 监听的是 bot 上的**全局** `goal_reached`，`goalReached()`
      //    连事件带的 goal 参数都不看 ⇒ 自主层的逃跑/跟随同时在走时，**它**到点会顺手把
      //    我这次 goto resolve 掉。实机表现（2026-10-06 打怪实测）：连续 19 次 mc_move
      //    秒返回 `moved=0` + `goal_reached-but-far`，模型被告知"插件说到了但还差 5 格"。
      //    判据：pathfinder 自己用的是 `stateGoal.isEnd(pos.floored())`（index.js:590，
      //    还允许 +1 格），**我自己的 goal 没满足 ⇒ 这次 resolve 必然来自别人的 goal**。
      const fp = typeof end?.floored === 'function' ? end.floored() : null
      const up1 = fp && typeof fp.offset === 'function' ? fp.offset(0, 1, 0) : null
      // mine === null 表示"判不了"（假 bot 的位置不是真 Vec3）⇒ 不据此下结论
      const mine = !fp || typeof goal?.isEnd !== 'function' ? null
        : Boolean(goal.isEnd(fp) || (up1 && goal.isEnd(up1)))
      if (self._moveGen !== gen) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
          via: 'pathfinder', stuck: true, reason: 'preempted',
          ...roadInfo(), ...moveInfo(),
          hint: `这次走路被**另一次移动**接管了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：`
            + `我从 ${startRemaining.toFixed(1)} 格挪到了 ${left.toFixed(1)} 格，但走到目标的是那一份。`
            + '等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。',
        }
      }
      /* 🔴 2026-10-08 审计③：走到这里 = "goto 无错 resolve 但我没到"，两种成因**必须分开说**：
       *    · `emptyNoPath`：A* 连一个邻居都生成不出来（空路径假成功）⇒ **真没路**，再叫也没用；
       *    · `mine === false`：vendor 的 `goal_reached` 是**全局**事件（`lib/goto.js:60`），
       *      自主层的逃跑/跟随到点时会顺手把我这次 goto resolve 掉 ⇒ 只是被别人的到点顶了。
       *    旧代码两种都报 `preempted` + "不是走不通"，把"死路"说成"再叫一次就行"。 */
      /* P1：**"站错层"要优先于"别人的锅"报出来** —— 水平已经到位（`horiz` 落在"到附近"以内）
       * 却差了 1.5 格以上的高度时，成因是**这一层站错了**，不是"另一次寻路到点把我顶掉"、
       * 也不是"没路"。⚠️ 旧代码在这条路上会一路落进下面 `mine === false` 那条诊断：插件自己的
       * `GoalNear` 是**三维球**（半径 `round(arrive-0.6)`），人站在上层它当然不满足 ⇒ `mine` 为假，
       * 于是把"高度不对"说成"别人的锅"，模型就一直重叫同一个目标。 */
      if (vertBad && horiz <= arrive + 1.0) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
          via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(),
          // P1：把两个轴分开报 —— 否则"水平到了但高了两格"看起来和"还差 5 格"一模一样
          horiz: Number(horiz.toFixed(2)), vert: Number(vert.toFixed(2)),
          hint: `寻路插件说到了，但**高度不对**：水平只差 ${horiz.toFixed(1)} 格，垂直差了 ${Math.abs(vert).toFixed(1)} 格`
            + `（我${vert > 0 ? '站在目标上方' : '站在目标下方'}）—— 先 \`mc_move\` 走到目标**同一层**，或换个目标点。`,
        }
      }
      if (emptyNoPath || mine === false) {
        return {
          arrived: false, position: at(end), ms: Date.now() - t0,
          remaining: Number(left.toFixed(2)),
          moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
          via: 'pathfinder', stuck: true,
          reason: emptyNoPath ? 'NoPath' : 'goal-reached-elsewhere',
          ...roadInfo(), ...moveInfo(),
          hint: emptyNoPath
            ? `寻路**没路可走**（被墙 / 水 / 悬崖挡住，或目标在实心方块里）：离目标还有 ${left.toFixed(1)} 格。`
              + '先 `mc_scan` 看挡路的是什么：是方块就 `mc_act{mode:"break"}` 挖开；'
              + '**是沟/缺口就 `mc_act{mode:"bridge"}`**（寻路插件不会水平搭桥，只会报没路）——'
              + '朝对岸那一格铺过去（x/y/z 给对岸**脚下一层**的坐标）。换个目标点再叫 mc_move 也一样走不通。'
            : `寻路插件报的"到了"**不是我这次的目标**（另一次寻路到点时顺手把我这次 goto 一起 resolve 掉了）`
              + `—— 我还在 ${left.toFixed(1)} 格外：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。`,
        }
      }
      return {
        arrived: false, position: at(end), ms: Date.now() - t0,
        remaining: Number(left.toFixed(2)),
        moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
        via: 'pathfinder', stuck: true, reason: 'goal_reached-but-far', ...moveInfo(),
        hint: `寻路插件说到了，但离目标还有 ${left.toFixed(1)} 格（可能被占住或只到附近）—— 再走一次，或换个目标点。`,
      }
    }
    return {
      arrived: true,
      position: at(end),
      ms: Date.now() - t0,
      moved: Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2)),
      /* 到了也报 `remaining`（实机第 6 跑：`walkTo` 明明到了、`remaining` 却是 undefined，
       * 测试脚本只能打 `-`，看着像"谎报到达"）。 */
      remaining: Number(left.toFixed(2)),
      via: 'pathfinder',
      ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(), ...moveInfo(),
    }
  } catch (e) {
    if (e?.mcAborted) throw e
    const end = b.entity.position
    const moved = Number(Math.hypot(end.x - start.x, end.z - start.z).toFixed(2))
    const remaining = Number(end.distanceTo(new Vec3(target.x, ty, target.z)).toFixed(2))
    /* P0-1：`mcStuck` = 采样器判卡住（脱困阶梯走完还没进展）—— 这跟"时间用完了"、
     * "被抢占"、"没路可走"都是**不同结局**，必须分开报，否则模型会继续原地重发。 */
    const exhausted = Boolean(e?.mcStuck)
    const nm = exhausted
      ? (pathThrash
        ? `**路一直在被改 / 一直被挡**（脱困 ${repathCount} 次，其中 ${pathThrash} 次是"路径被反复失效"）`
        : `**真的走不动了**（原地试了 ${repathCount} 次脱困：重算路径 / 跳跃 / 后退，位置都没改善）`)
      : e?.mcTimeout ? `走了 ${Math.round((Date.now() - t0) / 1000)} 秒还没到`
      : e?.name === 'NoPath' ? '寻路说**没路可走**（被墙/水/悬崖/沟挡住，或目标在实心方块里）'
        : e?.name === 'Timeout' ? '寻路想路线超时'
          : e?.name === 'PathStopped' || e?.name === 'GoalChanged' ? '寻路被打断'
            : `寻路失败（${e?.name ?? '错误'}：${String(e?.message ?? '').slice(0, 80)}）`
    // 是"这一轮 11 秒用完了"还是"真走不通"—— 给模型的下一步完全不同。
    // 🔴 第三种情况最容易漏：`budget` 本身就被 `CALL_BUDGET_MS`（10 秒）压过 —— 走长路
    //    到点返回是**正常**的，不是死路。以前只看 `msLeft() <= 400`，DSH 把截止时刻设成
    //    一整轮时，预算到点的 `msLeft()` 还剩 ~1 秒 → 判成"真走不通"，
    //    于是模型被告知"换个目标点"，明明再叫一次就能接着走。
    const cutByCall = Boolean(e?.mcCallOver) || self.msLeft() <= 400
    /* 🔴 2026-10-15 审计（报告 C 第 4 条）：这里原来还有第三个析取
     *    `Boolean(e?.mcTimeout) && budget <= Number(budgetAsked ?? budget) + 50` ——
     *    而 `budget = min(callBudget(budgetAsked), leftMs)` **恒 ≤ budgetAsked**；`budgetAsked` 缺省时
     *    退化成 `budget <= budget + 50`，也恒真 ⇒ 整个条件**恒真**（`reason: 'timeout'` 那条分支
     *    因此永远走不到）。副作用更糟：下面 `noProgress && !cutByCall` 那条"真没走通"永远为假，
     *    一格没挪也会被告知"这一轮的走路时间用完了、**不是走不通**" —— 正是 2026-10-08 那次审计
     *    要修的病。改成如实区分两件事：`cutByCall`（这一轮的时间用完了）与 `timeUp`（预算到点）。
     *    注意 `timeUp` **不能**再退回"恒真" —— 它只用于选文案，判据是"内部计时器真的响过"。 */
    const timeUp = cutByCall || Boolean(e?.mcTimeout)
    // 被抢占（自保反射先跑 / 又发了一次 mc_move）：编号已经不是我的了。
    // 这跟"走不通"完全是两回事 —— 必须说清楚，否则模型会以为目标不可达。
    const preempted = self._moveGen !== gen
    /* 🔴 2026-10-08 审计（会话 step 789 实机）：
     *    `{"moved":0,"remaining":2.3,...,"reason":"Error","hint":"…挪了 0 格）—— 这一轮的走路时间用完了，
     *      **不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。"}`
     *    —— 4 秒一格没挪，却告诉模型"不是走不通"，于是它一次次重发同一个走不到的点。
     *    判据补一条：**既没挪动、也没靠近** 就不算"时间到了"，得如实说卡住了。 */
    const noProgress = moved < 0.6 && remaining >= startRemaining - 0.3
    /* `reason` 也别把内部字符串原样透出去（旧版漏出过 `Error` / `block_updated`） */
    const REASON_TEXT = { stuck: 'stuck', block_updated: 'block-changed', goal_changed: 'goal-changed', path_stopped: 'stopped', path_reset: 'path-reset' }
    const PF_ERR = new Set(['NoPath', 'Timeout', 'PathStopped', 'GoalChanged', 'NoPathFound'])
    /* 🔴 2026-10-08 实机（熔炼验证，真服）：`why` 记的是**中途**事件（`path_reset` 在
     *    A* 重算 / 踩到方块更新 / 3.5 秒没推进时都会发），不能拿它盖过"这一轮时间用完了"
     *    这个真正结局 —— 那次跑出 `{"moved":32,"remaining":6.11,"reason":"path-reset"}`，
     *    10 秒明明正常挪了 32 格、只是预算到点，模型看到 "path-reset" 却会以为路被重置了、
     *    以为走不通。时间到点 + 有进展 ⇒ 如实报 budget/timeout。 */
    const reasonOut = preempted ? 'preempted'
      : exhausted ? 'unreachable'
      : (e?.mcTimeout && !noProgress ? (cutByCall ? 'budget' : 'timeout')
        : (why ? (REASON_TEXT[why] ?? 'path-reset') : (PF_ERR.has(String(e?.name)) ? String(e.name) : 'walk-failed')))
    return {
      arrived: false,
      position: at(end),
      ms: Date.now() - t0,
      remaining,
      moved,
      via: 'pathfinder',
      stuck: true,
      reason: reasonOut,
      ...(dug ? { dug } : {}), ...(placed ? { pillared: placed } : {}), ...roadInfo(), ...moveInfo(),
      hint: `${nm}（从 ${startRemaining.toFixed(1)} 格变成 ${remaining.toFixed(1)} 格，挪了 ${moved} 格）`
         // 地形那一句（导航 P2）：只在**真有用**的时候说 —— 沟要说"用 bridge"，
         // 危险地形要说"别走这边"，平地/未知不说（说了纯占地方）
         + (!preempted && terrain.kind === 'gap'
           ? `—— 你脚边是**${terrain.text}**（${terrain.note}）：别绕着试了，直接 \`mc_act {mode:"bridge"}\` 朝目标搭过去。`
           : !preempted && terrain.kind === 'hazard'
             ? `—— 你脚边是**${terrain.text}**（${terrain.note}）：别从这边走，换个方向绕。`
             : '')
         + (preempted
           ? '—— 这次走路被**另一次移动**打断了（旁边有怪时是自保反射先跑，也可能是又发了一次 mc_move）：等它结束，再叫一次 mc_move 往同一个目标走就行，**不是走不通**。'
           : exhausted
             ? (pathThrash
               ? `—— 这一轮**路径被重算了 ${pathResetsTotal} 次**`
                 + `（${Object.entries(resetReasons).map(([k, v]) => `${REASON_TEXT[k] ?? k}×${v}`).join('、')}）：`
                 + '说明**路一直在被世界变化打断**（别人放的方块 / 走过来的实体 / 岩浆流 / 方块更新），'
                 + '不是"找不到路"——光重算没用，所以停了。**换个走法**：'
               : '') + `—— **别原地重试了**（已经替你换过 ${repathCount} 次策略都没用）：把长路**拆成几段**，`
               + '先走到中间一个能站住的点、再走下一段；或者用 `mc_scan` 看挡在中间的是什么（墙 / 水 / 栅栏 / 半砖）。'
               + '　要是"脚下明明没东西却还是走不动"，可能是我这边的世界和服务端对不上（客户端预测的方块缓存）——'
               + '走远 32 格再回来让区块重发。'
               + DESYNC_HINT
             : noProgress && !timeUp
             ? '—— **是真没走通**（一格没挪、也没靠近）：先 `mc_act {mode:"jump"}` 蹦一下（可能是卡在方块里 / 台阶上），再 `mc_scan` 看脚下和目标那格是什么；换个近一点的目标点通常更快。'
                  + '　要是"脚下明明没东西却还是走不动"，可能是我这边的世界和服务端对不上（客户端预测的方块缓存）——'
                  + '走远 32 格再回来让区块重发。'
                  + DESYNC_HINT
             : timeUp
               ? `—— 这一轮的走路时间用完了（单次调用最多 ${budgetSecText()}），**不是走不通**：直接再叫一次 mc_move 往同一个目标走，会接着走。`
               : noProgress
                 ? '—— 这一轮**一格没挪**（时间到了，但也没靠近）：再叫一次 mc_move 试试；两次都一样就换个目标点。'
                 : '—— 换个能走到的目标点，或先解除挡住它的方块。'),
    }
  } finally {
    // P0-1：采样器的定时器必须收掉 —— 留着会把进程钉住（也会在返回之后误判"卡住"）。
    try { watch?.stop() } catch {}
    for (const [ev, fn] of off) { try { b.removeListener?.(ev, fn) } catch {} }
    // 🔴 只有"我还是最新那次移动"才允许收尾（停 pathfinder + 松控制位）。
    //    被抢占时绝不能动：否则会把正在走的那一份一起停掉 —— 实机表现就是
    //    "动了一下不动了"。见 _moveGen 的注释。
    if (self._moveGen === gen) {
      // 🔴 2026-10-08 审计②：`stop()` 只是置标志 —— 必须 `setGoal(null)` 才真停
      //    （详见 #stopPathing 的注释：不然控制位会被插件按回去，甚至返回之后才开始挖方块）。
      try { ctx.stopPathing(b) } catch {}
      ctx.releaseControls()
    }
  }
}
