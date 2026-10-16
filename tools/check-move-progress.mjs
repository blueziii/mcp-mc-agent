#!/usr/bin/env node
/**
 * P0-1 移动进度监控 + 自动脱困阶梯自检（`src/movement.mjs`）
 *
 * 用户 2026-10-15 的原话要求（导航优化方案 P0-1）：
 *   「给移动增加**进度监控 + 自动脱困**……每隔约 500–1000 ms 采样一次坐标……
 *     连续 2–3 秒没有有效位移，判定为疑似卡住……按顺序尝试重新计算路径、跳跃脱困、
 *     后退后重新寻路……多次失败后返回明确的 `stuck` 或 `unreachable`，不要无限重试」
 *   「**关键点：不要只根据速度为零判断卡住**。机器人在跳跃、落地、等待方块更新或
 *     接近目标时，短时间不动可能是正常的。」
 *
 * 这一套要钉死四件事：
 *   ① **判据是"既没挪动、也没靠近"** —— 光看速度为零会把正常停顿误判成卡住；
 *      反过来，"一直在动但没靠近"（绕圈）必须照样判卡住；
 *   ② **正常等待要豁免** —— 挖着 / 放着 / 悬空（跳跃落地中）算正常等待，把进度时钟往后推，
 *      但最多推 `MOVE_BUSY_MAX_MS`（免得一直挖个不停就永远不判卡）；
 *   ③ **阶梯顺序与收尾** —— 重算路径 → 跳跃脱困 → 后退再寻路；三级用完明确报 `unreachable`
 *      并带上 `repathCount`，**不无限重试**；采样器的定时器一定收掉（不然把进程钉住）；
 *   ④ **脱困动作不能跟 pathfinder 抢控制位** —— 必须先 `setGoal(null)` 真停
 *      （vendor 每个 physicsTick 都会把 forward/jump 按回去），且**不换 goal 对象**
 *      （换了 vendor 的 `goto` 会直接以 `GoalChanged` 拒绝，等于把这次走路判死）。
 *
 * 用法：node tools/check-move-progress.mjs
 */
import { readFileSync } from 'node:fs'
import vec3pkg from 'vec3'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
const mod = await import(new URL('../src/movement.mjs', import.meta.url))
const {
  MOVE_SAMPLE_MS, MOVE_STUCK_MS, MOVE_BUSY_MAX_MS, MOVE_ESCAPES,
  escapeStepOf, escapeTextOf, moveBusyNow, moveProgressWatcher, escapeMove, walkPathfinder,
} = mod

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 假时钟：注入给采样器，免得一套断言真等 2.4 秒 × 4 轮 ─────────────────── */
function fakeClock () {
  let t = 0
  const jobs = []
  const c = {
    onTick: null,
    now: () => t,
    setTimer: (fn, ms) => { const h = { fn, ms, at: t + ms, live: true }; jobs.push(h); return h },
    clearTimer: (h) => { if (h) h.live = false },
    get live () { return jobs.filter((j) => j.live).length },
    async advance (ms) {
      const target = t + ms
      for (;;) {
        const due = jobs.filter((j) => j.live && j.at <= target).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        t = due.at
        due.at = t + due.ms
        due.fn()
        if (c.onTick) c.onTick()
        await Promise.resolve()
      }
      t = target
    },
  }
  return c
}
/** 让假时钟自己往前走（真实 1ms 推 600ms 假时间）—— 驱动 `walkPathfinder` 的整条循环 */
function autoClock () {
  const c = fakeClock()
  let busy = false
  const h = setInterval(() => {
    if (busy) return
    busy = true
    c.advance(MOVE_SAMPLE_MS).finally(() => { busy = false })
  }, 1)
  c.stopPump = () => clearInterval(h)
  return c
}

/* ── 只够采样器 / escapeMove 用的假机器人 ─────────────────────────────────── */
function mkProbe (pos = { x: 0, y: 64, z: 0 }, { mining = false, building = false, onGround = true } = {}) {
  const b = {
    entity: { position: new Vec3(pos.x, pos.y, pos.z), onGround },
    controls: [],
    pathfinder: { isMining: () => mining, isBuilding: () => building },
    setControlState (k, v) { b.controls.push([k, v]) },
  }
  return b
}
const watchOpts = (clock) => ({ arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer })

/* ═══════════════ ① 阶梯：纯函数 ═══════════════ */
section('① 脱困阶梯的顺序与命名（纯函数）')
{
  ok(Array.isArray(MOVE_ESCAPES) && MOVE_ESCAPES.length === 3, '阶梯就是三级', JSON.stringify(MOVE_ESCAPES))
  ok(MOVE_ESCAPES[0] === 'repath' && MOVE_ESCAPES[1] === 'jump' && MOVE_ESCAPES[2] === 'backoff',
    '🔴 顺序 = 用户要求的「重算路径 → 跳跃脱困 → 后退再寻路」', MOVE_ESCAPES.join(' → '))
  ok(escapeStepOf(0) === 'repath' && escapeStepOf(1) === 'jump' && escapeStepOf(2) === 'backoff',
    'escapeStepOf(n) 按序给动作')
  ok(escapeStepOf(3) === null && escapeStepOf(99) === null, '🔴 走完阶梯返回 null（= 该认输了，不无限重试）')
  ok(escapeTextOf('repath') === '重算路径' && escapeTextOf('jump') === '跳跃脱困' && escapeTextOf('backoff') === '后退再寻路',
    'escapeTextOf 的中文名（日志与返回值文案用）')
  ok(escapeTextOf('随便什么') === '放弃', '不认识的级别 → 放弃')
  ok(MOVE_SAMPLE_MS >= 500 && MOVE_SAMPLE_MS <= 1000, '采样间隔落在用户要求的 500–1000ms 里', `${MOVE_SAMPLE_MS}ms`)
  ok(MOVE_STUCK_MS >= 2000 && MOVE_STUCK_MS <= 3000, '判卡阈值落在用户要求的 2–3 秒里', `${MOVE_STUCK_MS}ms`)
}

/* ═══════════════ ② moveBusyNow：什么算"正常等待" ═══════════════ */
section('② moveBusyNow —— 挖着 / 放着 / 悬空都算正常等待（用户点名的坑）')
{
  ok(moveBusyNow(mkProbe({}, { mining: true })) === true, '正在挖（pathfinder.isMining）⇒ 忙')
  ok(moveBusyNow(mkProbe({}, { building: true })) === true, '正在放（pathfinder.isBuilding）⇒ 忙')
  ok(moveBusyNow(mkProbe({}, { onGround: false })) === true, '悬空（跳跃 / 落地中）⇒ 忙')
  ok(moveBusyNow(mkProbe()) === false, '站着不动、没在挖没在放、踩着地 ⇒ 不忙（照常判卡）')
  ok(moveBusyNow({}) === false, '没有 pathfinder / entity 的假 bot ⇒ 不忙（不当成"永远正常"）')
  ok(moveBusyNow(null) === false, 'null ⇒ 不忙，不抛错')
  ok(moveBusyNow({ get pathfinder () { throw new Error('x') } }) === false, '读字段抛错 ⇒ 吞掉当不忙')
}

/* ═══════════════ ③ 采样器：判据 ═══════════════ */
section('③ moveProgressWatcher —— "既没挪动、也没靠近"才判卡住')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS - MOVE_SAMPLE_MS)
  ok(err === null, `不到 ${MOVE_STUCK_MS}ms 不判卡住（跳跃/落地/等方块更新都在这段时间里）`)
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err?.mcStuck === true, '🔴 连续既没挪动也没靠近 ⇒ reject 一个带 mcStuck 的错误')
  ok(Number.isFinite(err?.remaining) && err.remaining > 9, '错误里带 remaining（还剩多远）', String(err?.remaining))
  ok(w.info().stuck?.ms >= MOVE_STUCK_MS, 'info() 记下卡了多久（排查用）', JSON.stringify(w.info()))
  ok(clock.live === 0, '判卡住后采样定时器自己收掉')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 20, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 8; i++) {
    b.entity.position = new Vec3(i * 0.8, 64, 0)     // 每 600ms 靠近 0.8 格（> eps）
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 永远不判卡住（哪怕还没到）')
  w.stop()
}
{
  // 绕着目标转圈：位置一直在变（速度不为零），但离目标始终 10 格
  const clock = fakeClock()
  const b = mkProbe({ x: 10, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 0, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  let a = 0
  for (let i = 0; i < 6; i++) {
    a += 0.9
    b.entity.position = new Vec3(10 * Math.cos(a), 64, 10 * Math.sin(a))
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err?.mcStuck === true, '🔴 **只挪动、不靠近**（绕圈）照样判卡住 —— 不是"速度为零才算"，用户点名的那条')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 9, y: 64, z: 0 })          // 离目标 1 格 ⇒ 已经在到达半径里
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS * 3)
  ok(err === null, '已经在到达半径里 ⇒ 不动也不算卡住')
  w.stop()
}

/* ═══════════════ ④ 采样器：正常等待的豁免有上限 ═══════════════ */
section('④ 正常等待豁免有上限（一直挖个不停不会变成"永远正常"）')
{
  const clock = fakeClock()
  const b = mkProbe({}, { mining: true })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_BUSY_MAX_MS + MOVE_STUCK_MS - 200)
  ok(err === null, `挖着不动最多推 ${MOVE_BUSY_MAX_MS}ms，之前不判卡住`)
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err?.mcStuck === true, '🔴 一直挖超过 busyMax 之后就不再当"正常等待"，照判卡住')
  w.stop()
}
{
  const clock = fakeClock()
  const b = mkProbe({}, { onGround: false })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS)
  ok(err === null, '悬空（跳跃落地中）不判卡住')
  w.stop()
}

/* ═══════════════ ⑤ 采样器：stop() 之后彻底安静 ═══════════════ */
section('⑤ stop() 之后彻底安静（不能留下把进程钉住的定时器）')
{
  const clock = fakeClock()
  const b = mkProbe()
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS)
  w.stop()
  ok(clock.live === 0, 'stop() 清掉定时器')
  await clock.advance(MOVE_STUCK_MS * 4)
  ok(err === null, '🔴 stop() 之后即使时间再久也不 reject（否则是"竞速结束了才炸"）')
  ok(w.info().stuck === null, 'stop() 之后 info() 也不记"卡住"')
  let again = false
  try { w.stop() } catch { again = true }
  ok(again === false, 'stop() 可以重复调（finally 里无脑调一次）')
}

/* ═══════════════ ⑤b P1：路径失效重算（不用等满 2.4 秒） ═══════════════ */
section('⑤b P1 —— 路径被反复失效：光重算没用，直接进阶梯')
{
  const clock = fakeClock()
  let resets = 3
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => resets, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 2)
  ok(err === null, '失效 3 次（< 上限 4）还不认输')
  resets = 4
  await clock.advance(MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true, '🔴 失效到上限 ⇒ 直接判卡住（不等满 2.4 秒）')
  ok(err?.mcPathThrash === true, '🔴 带 mcPathThrash 标记（跟"没进展"分开报，下一步建议也不同）')
  ok(/路径被反复失效/.test(String(err?.message ?? '')), '文案说清是"光重算没用"', String(err?.message))
  ok(w.info()?.stuck?.thrash === true && w.info()?.stuck?.resets === 4, 'info() 记下成因与次数', JSON.stringify(w.info()))
  ok(clock.live === 0, '认输时收掉定时器')
}
{
  const clock = fakeClock()
  const b = mkProbe({ x: 0, y: 64, z: 0 })
  const w = moveProgressWatcher(b, { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  for (let i = 1; i <= 6; i++) {
    b.entity.position = new Vec3(i * 0.9, 64, 0)   // 每轮都在靠近
    await clock.advance(MOVE_SAMPLE_MS)
  }
  ok(err === null, '🔴 一直在靠近 ⇒ 失效次数再多也不叫停（**进展优先**：一直被打断但还在往前挪，就让它挪）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe({}, { mining: true }), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => 99, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_SAMPLE_MS * 3)
  ok(err === null, '挖着（算正常等待）⇒ 失效次数也不叫停（挖本身就会让世界更新、路径失效）')
  w.stop()
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 },
    { ...watchOpts(clock), resetsOf: () => { throw new Error('x') }, resetLimit: 4 })
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true,
    'resetsOf 抛错 ⇒ 当 0：仍按"没进展"判卡（不炸、也不误报 thrash）')
}
{
  const clock = fakeClock()
  const w = moveProgressWatcher(mkProbe(), { x: 10, y: 64, z: 0 }, watchOpts(clock))
  let err = null
  w.promise.catch((e) => { err = e })
  await clock.advance(MOVE_STUCK_MS + MOVE_SAMPLE_MS)
  ok(err?.mcStuck === true && err?.mcPathThrash !== true, '不传 resetsOf ⇒ 退回 P0-1 那套纯"没进展"判据')
}

/* ═══════════════ ⑥ escapeMove：先真停、再动控制位 ═══════════════ */
section('⑥ escapeMove —— 先真停 pathfinder，再按控制位')
{
  const b = mkProbe()
  const stops = []
  const ctx = { stopPathing: (bb) => stops.push(bb === b) }
  const goal = { x: 0, y: 64, z: 0 }
  await escapeMove(b, goal, 'repath', ctx)
  ok(stops.length === 1 && stops[0] === true, '🔴 每一级脱困都先 ctx.stopPathing(b)（不然 vendor 每个 tick 把控制位按回去）')
  ok(b.controls.length === 0, 'repath 只重算，不按任何控制位')
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'jump', ctx)
  ok(stops.length === 1, 'jump 级同样先真停')
  ok(b.controls.some(([k, v]) => k === 'jump' && v === true) && b.controls.some(([k, v]) => k === 'jump' && v === false),
    'jump 级按住 jump 再松开（卡在台阶/栅栏/半砖边缘时最有效）', JSON.stringify(b.controls))
  b.controls.length = 0; stops.length = 0
  await escapeMove(b, goal, 'backoff', ctx)
  ok(b.controls.some(([k, v]) => k === 'back' && v === true) && b.controls.some(([k, v]) => k === 'back' && v === false),
    'backoff 级按住 back 再松开（贴墙贴角时原地重算还是同一条死路）', JSON.stringify(b.controls))
  ok(!b.controls.some(([k]) => k === 'jump'), 'backoff 不顺手按 jump（两级动作不混）')
  let threw = false
  try { await escapeMove(b, goal, 'repath', { stopPathing: () => { throw new Error('x') } }) } catch { threw = true }
  ok(threw === false, 'stopPathing 抛错不把整次走路炸掉')
}

/* ═══════════════ ⑦ walkPathfinder 整条循环 ═══════════════ */
section('⑦ walkPathfinder 整条循环：卡住 → 阶梯 → 明确 unreachable')

function mkLoopBot (start = { x: 0, y: 64, z: 0 }) {
  const b = {
    entity: { position: new Vec3(start.x, start.y, start.z), onGround: true },
    controls: [],
    calls: { goto: 0, setGoal: [] },
    _pending: null,
  }
  b.blockAt = () => ({ name: 'stone' })
  b.setControlState = (k, v) => b.controls.push([k, v])
  b.on = () => {}
  b.removeListener = () => {}
  b.pathfinder = {
    isMining: () => false,
    isBuilding: () => false,
    setMovements: () => {},
    setGoal (g) {
      b.calls.setGoal.push(g)
      if (g === null && b._pending) {
        const p = b._pending; b._pending = null
        const e = new Error('GoalChanged'); e.name = 'GoalChanged'; p.reject(e)
      }
    },
    goto () {
      b.calls.goto++
      return new Promise((resolve, reject) => { b._pending = { resolve, reject } })
    },
  }
  b.settleGoto = (fn) => { const p = b._pending; if (p) { b._pending = null; fn(p) } }
  return b
}
function mkSelf (bot, budgetMs = 20000) {
  const self = {
    bot,
    cfg: { moveBudgetMs: budgetMs },
    abortSignal: null,
    _moveGen: 0,
    logs: [],
    _pf: {
      goals: { GoalNear: class { constructor (x, y, z, r) { this.x = x; this.y = y; this.z = z; this.rangeSq = r } isEnd () { return false } } },
      Movements: class {},
    },
    msLeft: () => 30000,
    log (m) { self.logs.push(String(m)) },
  }
  return self
}
function mkCtx (self, clock) {
  return {
    movements: () => ({}),
    collectBusy: () => false,
    cancelCollect: async () => {},
    beginMove: () => ++self._moveGen,
    stopPathing: (bb) => { bb.pathfinder.setGoal(null) },
    releaseControls: () => {},
    watchOpts: { arrive: 1.6, ty: 64, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
  }
}

{
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const r = await walkPathfinder(self, { x: 20, y: 64, z: 0 }, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.arrived === false && r.stuck === true, '走不动 ⇒ arrived:false / stuck:true', JSON.stringify({ a: r.arrived, s: r.stuck }))
  ok(r.reason === 'unreachable', '🔴 阶梯用完 ⇒ reason = unreachable（**不是** timeout / 不是"再叫一次"）', String(r.reason))
  ok(r.repathCount === MOVE_ESCAPES.length, `repathCount = ${MOVE_ESCAPES.length}（三级都试过了）`, String(r.repathCount))
  ok(bot.calls.goto === MOVE_ESCAPES.length + 1, `重新 goto 了 ${MOVE_ESCAPES.length + 1} 次（首次 + 每级脱困各一次）`, String(bot.calls.goto))
  ok(/真的走不动了/.test(r.hint ?? ''), 'hint 如实说"真的走不动了"', String(r.hint).slice(0, 60))
  ok(/别原地重试/.test(r.hint ?? ''), '🔴 hint 明确劝"别原地重试"（把长路拆成几段）', String(r.hint).slice(0, 90))
  ok(!/再叫一次 mc_move 往同一个目标走/.test(r.hint ?? ''), '不误报成"再叫一次就好"')
  const escLogs = self.logs.filter((m) => /脱困/.test(m))
  ok(escLogs.length === MOVE_ESCAPES.length, '每级脱困各记一行日志', String(escLogs.length))
  ok(/重算路径/.test(escLogs[0] ?? '') && /跳跃脱困/.test(escLogs[1] ?? '') && /后退再寻路/.test(escLogs[2] ?? ''),
    '日志按阶梯顺序（重算路径 → 跳跃脱困 → 后退再寻路）', JSON.stringify(escLogs.map((s) => s.slice(0, 30))))
  ok(bot.controls.some(([k, v]) => k === 'jump' && v === true), '真的按过 jump（跳跃脱困不是空话）')
  ok(bot.controls.some(([k, v]) => k === 'back' && v === true), '真的按过 back（后退再寻路不是空话）')
  ok(clock.live === 0, '🔴 收尾时采样器定时器全清掉（不然把进程钉住）')
  ok(bot.calls.setGoal.filter((g) => g === null).length >= MOVE_ESCAPES.length,
    '每次重发 goto 前都先 setGoal(null) 真停（不攒重复的 goal_reached 监听器）', String(bot.calls.setGoal.filter((g) => g === null).length))
}
{
  // 一路靠近 ⇒ 不脱困、直接到达
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  clock.onTick = () => {
    const p = bot.entity.position
    const d = p.distanceTo(new Vec3(target.x, 64, target.z))
    if (d <= 1.6) { bot.settleGoto((q) => q.resolve()); return }
    bot.entity.position = new Vec3(p.x + 0.8, 64, p.z)
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.arrived === true, '一路靠近 ⇒ 正常到达', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.repathCount === undefined, '🔴 没卡住就不报 repathCount（不无中生有）', String(r.repathCount))
  ok(bot.calls.goto === 1, '一次 goto 就走完（没白重算）', String(bot.calls.goto))
  ok(self.logs.filter((m) => /脱困/.test(m)).length === 0, '没记任何脱困日志')
  ok(clock.live === 0, '收尾清掉采样器')
}
{
  /* P1：**水平到位、垂直差两格** —— 三维距离其实小于阈值（旧判据会报"到了"），
   * 但人站在目标正上方，必须判成"没到"。假 bot 的 `blockAt` 恒为 stone ⇒ `ty` 就是 64。 */
  const clock = autoClock()
  const bot = mkLoopBot()
  const self = mkSelf(bot)
  const ctx = mkCtx(self, clock)
  const target = { x: 20, y: 64, z: 0 }
  let done = false
  clock.onTick = () => {
    if (done) return
    done = true
    bot.entity.position = new Vec3(20, 66, 0)      // 水平 0 格、垂直 +2 格
    bot.settleGoto((q) => q.resolve())
  }
  const r = await walkPathfinder(self, target, { arrive: 1.6, budget: 20000 }, ctx)
  clock.stopPump()
  ok(r.remaining <= 1.6 + 1.0, '前提：这个位置的三维距离确实小于阈值（正是旧判据会误报的情形）', String(r.remaining))
  ok(r.arrived === false, '🔴 水平到位、高 2 格 ⇒ 不报"到了"（旧判据只看三维距离会放过去）', JSON.stringify({ a: r.arrived, rem: r.remaining }))
  ok(r.reason === 'goal_reached-but-far', 'reason = goal_reached-but-far', String(r.reason))
  ok(r.vert === 2 && r.horiz === 0, '把两个轴分开报出来', JSON.stringify({ h: r.horiz, v: r.vert }))
  ok(/高度不对/.test(r.hint ?? ''), '🔴 hint 点明"高度不对"（不是含糊的"还差 N 格"）', String(r.hint).slice(0, 80))
  ok(/同一层/.test(r.hint ?? ''), '下一步给的是"走到同一层"（能直接执行）', String(r.hint).slice(0, 120))
  ok(clock.live === 0, '收尾清掉采样器')
}

/* ═══════════════ ⑧ 静态接线：循环与返回值真的接上了 ═══════════════ */
section('⑧ 静态接线（谁把这几条改回去谁红）')
{
  const raw = read('../src/movement.mjs')
  const src = strip(raw)
  ok(/await Promise\.race\(\[\s*[\s\S]{0,300}?watch\.promise,?\s*\]\)/.test(src),
    '🔴 walkPathfinder 把采样器的 promise 和 goto 一起竞速')
  ok(!/await raceAbort\(withTimeout\(work, budget, '寻路'\), self\.abortSignal, '寻路'\)/.test(src),
    '🔴 不再是"一次 goto 到底"的老写法')
  ok(/for \(let attempt = 0; ; attempt\+\+\)/.test(src), '有重试循环')
  ok(/const step = escapeStepOf\(attempt - 1\)/.test(src), '每轮按阶梯取脱困动作')
  ok(/err\.mcStuck = true[\s\S]{0,120}?err\.mcExhausted = true/.test(src), '阶梯用完抛的是带 mcStuck 的错误')
  ok(/if \(e\?\.mcStuck\) continue/.test(src), '采样器判卡 ⇒ 进下一轮脱困')
  ok(/const exhausted = Boolean\(e\?\.mcStuck\)/.test(src), 'catch 里认出 mcStuck')
  ok(/: exhausted \? 'unreachable'/.test(src), '🔴 reason 里有 unreachable 这一档')
  ok(/const moveInfo = \(\) => \(\{/.test(src), 'moveInfo 是个多字段的汇总（地形 + 脱困 + 路径失效）')
  ok(/\.\.\.\(repathCount \? \{ repathCount \} : \{\}\)/.test(src), 'repathCount 只在 >0 时报')
  ok(/\.\.\.\(pathThrash \? \{ pathThrash \} : \{\}\)/.test(src), 'pathThrash 只在 >0 时报')
  ok(/pathResetsTotal >= 2 \? \{ pathResets/.test(src), '失效 ≥2 次才报 pathResets（1 次是正常的）')
  ok([...src.matchAll(/\.\.\.moveInfo\(\)/g)].length >= 5, '每条返回路径都带上 moveInfo（脱困/失效/地形）', String([...src.matchAll(/\.\.\.moveInfo\(\)/g)].length))
  ok(/try \{ watch\?\.stop\(\) \} catch \{\}/.test(src), '🔴 finally 里一定收掉采样器')
  ok(/ctx\.watchOpts \?\? \{\}/.test(src), 'watchOpts 可注入（离线测试拿假时钟驱动）')
  // ── P1：路径失效重算 ──
  ok(/export const MOVE_RESET_LIMIT = \d+/.test(src), 'MOVE_RESET_LIMIT 是个具体数字（不是"无限重算"）')
  ok(/resetsOf: \(\) => pathResets/.test(src), '🔴 采样器拿到的是**本轮**失效计数（不是累计值，否则第二趟一开局就认输）')
  ok(/pathResets = 0\s*\/\//.test(src), '每轮把失效计数归零')
  ok(/if \(resetsOf && resetLimit > 0 && resetsNow\(\) >= resetLimit\)/.test(src), '🔴 失效够多就直接进阶梯')
  ok(/if \(e\?\.mcPathThrash\) pathThrash\+\+/.test(src), 'catch 里数"因失效而脱困"的次数')
  ok(/resetReasons\[k\] = \(resetReasons\[k\] \?\? 0\) \+ 1/.test(src), '按理由（stuck / block_updated / …）分类计数')
  ok(/const onReset = \(reason\) => \{[\s\S]{0,120}?pathResets\+\+/.test(src), 'onReset 里真的在数')
  ok(/REASON_TEXT\[k\] \?\? k/.test(src), '报出去的理由也翻成人话（不漏内部字符串）')
  // ── P1：到达判定分两轴 ──
  ok(/const vertBad = vert < -1\.5 \|\| vert > 1\.5/.test(src), '🔴 垂直窗口 ±1.5 格（一步台阶以内）')
  ok(/if \(left > arrive \+ 1\.0 \|\| vertBad\)/.test(src), '🔴 高度不对也算"没到"（水平到了、人却在目标上下）')
  ok(/horiz: Number\(horiz\.toFixed\(2\)\), vert: Number\(vert\.toFixed\(2\)\)/.test(src), '两个轴分开报给模型')
  ok(/高度不对/.test(src), 'hint 里点明是"高度不对"（不是"还差 N 格"）')
  ok(/vertBad && horiz <= arrive \+ 1\.0/.test(src), '🔴 "站错层"要单独报（不然会被 `mine === false` 那条吞掉）')
  ok(src.indexOf('vertBad && horiz <= arrive + 1.0') < src.indexOf('emptyNoPath || mine === false'),
    '🔴 顺序：先报"站错层"，再报"别人的锅"（插件的 GoalNear 是三维球，人在上层它必然不满足）')
  ok(/Math\.max\(200, budget - \(Date\.now\(\) - t0\)\)/.test(src), '重试时用**剩余**预算（总时间仍以 budget 为界）')
  ok(!/require\(|import .*mineflayer|prismarine/.test(strip(read('../src/movement.mjs')).replace(/from 'vec3'/g, '')),
    'movement.mjs 不 import 游戏运行时（vec3 除外）')
  const all = read('./check-all.mjs')
  ok(/check-move-progress\.mjs/.test(all), 'check-all.mjs 的 ORDER 里登记了这一套')
}

console.log(`\n${'─'.repeat(50)}`)
console.log(`check-move-progress：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
