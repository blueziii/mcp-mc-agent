#!/usr/bin/env node
/**
 * `src/water-recovery.mjs` 的离线自检（2026-10-15 用户点名要的"水下寻路"第二层）。
 *
 * 覆盖用户列的八个场景里属于"恢复控制器"的三个：
 *   ⑥ 路线执行时氧气继续下降 ⇒ 停掉这条路线、换下一条（不重复同一个动作）
 *   ⑦ 恢复期间收到取消信号 ⇒ 立刻停手、一条路线都不走（**不遗留按键**是执行器的活，
 *      这一层连 `setControlState` 都不许出现）
 *   ⑧ 到达岸边后 ⇒ 重新看状态、并且**明确把"要不要恢复原任务"交回 AI**
 *
 * 假 bot 只提供 `entity.position` / `blockAt` / `oxygenLevel` / `health`；
 * 移动全靠注入的 `ctx.walkTo` / `ctx.swimUp` —— 正是"真正移动复用现有接口"那条约束的落点。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const R = await import(new URL('../src/water-recovery.mjs', import.meta.url))
const {
  WATER_AIR_LOW, WATER_AIR_CRITICAL, WATER_RECOVER_ROUNDS, WATER_RECOVER_MS, WATER_STUCK_MS,
  WATER_TRIGGER_TEXT, waterStateOf, waterTriggerOf, straightUpFrom, executeRoute,
  recoverFromWater, waterReportText,
} = R

/* ── 假世界 + 假 bot（和 check-water-navigation.mjs 同一套写法） ── */
const mkWorld = () => {
  const m = new Map()
  const K = (x, y, z) => `${x},${y},${z}`
  const api = {
    set (x, y, z, n) { m.set(K(x, y, z), n); return api },
    box (x1, y1, z1, x2, y2, z2, n) {
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) m.set(K(x, y, z), n)
      return api
    },
    bot (px = 0.5, py = 60, pz = 0.5) {
      return {
        entity: { position: { x: px, y: py, z: pz } },
        oxygenLevel: 20,
        health: 20,
        blockAt: (v) => {
          const n = m.get(K(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
          return n == null ? null : { name: n }
        },
      }
    },
  }
  return api
}

/** 假时钟：`t` 是毫秒，`sleep` 一睡就把时间往前推 */
const mkClock = (start = 0) => {
  const c = { t: start }
  c.now = () => c.t
  c.sleep = async (ms) => { c.t += Math.max(0, Number(ms) || 0) }
  return c
}

const mkCtx = (b, extra = {}) => {
  const clock = extra.clock ?? mkClock()
  return {
    now: clock.now,
    sleep: clock.sleep,
    clock,
    ...extra,
    ...(extra.walkTo ? {} : { walkTo: null }),
  }
}

/* 一个"一条路都不通"的场景：水柱 + 上面一个空气口袋 + 侧面一块干燥落脚点 */
const sceneTwoExits = () => {
  const w = mkWorld()
  w.box(-3, 54, -3, 5, 54, 3, 'stone')
  w.box(-3, 55, -3, 5, 66, 3, 'stone')
  for (let y = 55; y <= 61; y++) w.set(0, y, 0, 'water')
  w.set(0, 62, 0, 'air'); w.set(0, 63, 0, 'air')            // 上面：能换气（距离 1）
  for (let x = 1; x <= 2; x++) { w.set(x, 60, 0, 'water'); w.set(x, 61, 0, 'water') }
  w.set(3, 60, 0, 'air'); w.set(3, 61, 0, 'air')            // 侧面：干燥落脚点（距离 3）
  return w
}

/* ─────────── ① 状态与触发判据 ─────────── */
section('① waterStateOf / waterTriggerOf：什么时候该救自己')
{
  const w = sceneTwoExits()
  const b = w.bot()
  const s = waterStateOf(b)
  ok(s.inWater === true, '泡在水里 ⇒ inWater', JSON.stringify(s))
  ok(s.feet && s.feet.x === 0 && s.feet.y === 60, '报出脚底那格', JSON.stringify(s.feet))
  ok(s.air === 20 && s.health === 20, '氧气和血量都读到了', `${s.air}/${s.health}`)
  ok(waterStateOf({ entity: {} }).feet === null, '读不到坐标 ⇒ feet 是 null，不炸')
  ok(waterStateOf(null).inWater === false, '没 bot ⇒ 不在水里')

  const dry = mkWorld().box(-2, 60, -2, 2, 60, 2, 'stone').bot(0.5, 61, 0.5)
  ok(waterStateOf(dry).inWater === false, '站在岸上 ⇒ 不在水里')
  ok(waterTriggerOf(waterStateOf(dry)).fire === false, '不在水里 ⇒ 不触发')

  const st = (air, health = 20) => ({ feet: { x: 0, y: 60, z: 0 }, inWater: true, air, health, submerged: true })
  ok(waterTriggerOf(st(20)).fire === false, '氧气满、血量满 ⇒ 不触发', JSON.stringify(waterTriggerOf(st(20))))
  const low = waterTriggerOf(st(WATER_AIR_LOW))
  ok(low.fire === true && low.why === 'oxygen-low', '🔴 氧气掉到 8 ⇒ 触发（就是"该上浮了"）', JSON.stringify(low))
  ok(low.detail.includes('氧气只剩 8'), '说清是氧气的事', low.detail)
  ok(waterTriggerOf(st(WATER_AIR_CRITICAL)).why === 'oxygen-low', '氧气 4 ⇒ 还是 oxygen-low 这一类（血量会另说）')
  ok(WATER_AIR_LOW === 8 && WATER_AIR_CRITICAL === 4, '两个阈值就是 8 / 4', `${WATER_AIR_LOW}/${WATER_AIR_CRITICAL}`)

  const dmg = waterTriggerOf(st(20, 17), { air: 20, health: 20, feet: { x: 0, y: 60, z: 0 }, at: 0 })
  ok(dmg.fire === true && dmg.why === 'taking-damage', '🔴 氧气还够但血掉了 ⇒ 已经在淹了，触发', JSON.stringify(dmg))

  const drop = waterTriggerOf(st(15), { air: 20, health: 20, feet: { x: 0, y: 60, z: 0 }, at: 0 })
  ok(drop.fire === true && drop.why === 'oxygen-dropping', '🔴 氧气在往下掉（20→15）⇒ 触发', JSON.stringify(drop))

  const stuck = waterTriggerOf(st(20), { air: 20, health: 20, feet: { x: 0, y: 60, z: 0 }, at: 0 }, { now: WATER_STUCK_MS })
  ok(stuck.fire === true && stuck.why === 'no-progress', '🔴 氧气不掉、血不掉，但一直没挪窝 ⇒ 也触发', JSON.stringify(stuck))
  const stuckEarly = waterTriggerOf(st(20), { air: 20, health: 20, feet: { x: 0, y: 60, z: 0 }, at: 0 }, { now: WATER_STUCK_MS - 1 })
  ok(stuckEarly.fire === false, '没到时间就不喊（不然刚下水就报警）', JSON.stringify(stuckEarly))
  const moved = waterTriggerOf(st(20), { air: 20, health: 20, feet: { x: 1, y: 60, z: 0 }, at: 0 }, { now: 99_999 })
  ok(moved.fire === false, '人挪了格子 ⇒ 不算"没挪窝"', JSON.stringify(moved))

  ok(Object.keys(WATER_TRIGGER_TEXT).length === 4, '四种触发原因都有中文说法', Object.keys(WATER_TRIGGER_TEXT).join(','))
  ok(waterTriggerOf(st(20), null, { airLow: 20 }).why === 'oxygen-low', 'airLow 可以按调用方调', JSON.stringify(waterTriggerOf(st(20), null, { airLow: 20 })))
  ok(waterTriggerOf(null).fire === false, 'state 是 null ⇒ 不炸、不触发')
}

/* ─────────── ② 选哪个执行器 ─────────── */
section('② executeRoute：正上方用上浮、其它交给寻路器（不自己按键盘）')
{
  ok(straightUpFrom({ x: 1, y: 60, z: 2 }, { x: 1, y: 64, z: 2 }) === true, '正上方 ⇒ true')
  ok(straightUpFrom({ x: 1, y: 60, z: 2 }, { x: 2, y: 64, z: 2 }) === false, '斜的 ⇒ false')
  ok(straightUpFrom({ x: 1, y: 60, z: 2 }, { x: 1, y: 58, z: 2 }) === false, '往下的 ⇒ false')
  ok(straightUpFrom(null, { x: 1, y: 64, z: 2 }) === false, '没起点 ⇒ false')

  const w = sceneTwoExits()
  const b = w.bot()
  const self = { requireBot: () => b }
  const calls = []
  const ctx = {
    swimUp: async (s, o) => { calls.push(['swim', o]) },
    walkTo: async (s, p, o) => { calls.push(['walk', p, o]) },
  }
  const up = await executeRoute(self, { target: { x: 0, y: 62, z: 0 }, path: [{ x: 0, y: 61, z: 0 }, { x: 0, y: 62, z: 0 }] }, ctx)
  ok(up.used === 'swim' && calls[0][0] === 'swim', '🔴 目标是正上方 ⇒ 走上浮（按住 jump 最快）', JSON.stringify(up.used))
  const side = await executeRoute(self, { target: { x: 3, y: 60, z: 0 }, path: [{ x: 1, y: 60, z: 0 }, { x: 3, y: 60, z: 0 }] }, ctx)
  ok(side.used === 'walk' && calls[1][0] === 'walk', '目标是侧面的岸 ⇒ 交给寻路器（它会游泳、会绕）', JSON.stringify(side.used))
  ok(calls[1][2].arrive === 1.6, '到达半径用的是 WATER_ARRIVE', JSON.stringify(calls[1][2]))
  const none = await executeRoute(self, { target: { x: 3, y: 60, z: 0 }, path: [] }, {})
  ok(none.error === '调用方没给 walkTo', '没人给执行器 ⇒ 明确报出来（不是静默不动）', String(none.error))
  const boom = await executeRoute(self, { target: { x: 3, y: 60, z: 0 }, path: [] }, { walkTo: async () => { throw new Error('寻路失败') } })
  ok(boom.error === '寻路失败', '执行器抛错 ⇒ 记下来，不吞', String(boom.error))
  const noTarget = await executeRoute(self, { target: null, path: [] }, ctx)
  ok(noTarget.error === '没有目标', '没目标 ⇒ 明确说', String(noTarget.error))
}

/* ─────────── ③ 用户场景⑥：氧气一直掉、这条路走不通 ⇒ 换下一条 ─────────── */
section('③ 场景⑥：路线没走通时换下一条（不是重复同一个动作）')
{
  const w = sceneTwoExits()
  const b = w.bot()
  b.oxygenLevel = 20
  const self = { requireBot: () => b }
  const clock = mkClock()
  const targets = []
  const ctx = mkCtx(b, {
    clock,
    /* 这个 walkTo **故意不动人**：模拟"走了但没靠近"（被岩壁挡住那种） */
    walkTo: async (s, p) => { targets.push(`${p.x},${p.y},${p.z}`); b.oxygenLevel -= 3 },
    /* 正上方的那个目标走的是"上浮"分支 —— 两条路线用的是**两个不同的执行器** */
    swimUp: async () => { targets.push('surface') },
  })
  const res = await recoverFromWater(self, { rounds: 3 }, ctx)
  ok(targets.length >= 2 && targets[0] !== targets[1], '🔴 试了两条**不同**的路线（第一条走不通就拉黑，不再重试它）', JSON.stringify(targets))
  ok(targets[0] === '3,60,0', '第一条先试最好的那个（干燥落脚点，交给寻路器）', targets[0])
  ok(targets[1] === 'surface', '第二条换成"能换气的那个"（次优，而且是正上方 ⇒ 走上浮）', targets[1])
  ok(res.ok === false, '都没走通 ⇒ 老实回失败', String(res.ok))
  ok(res.reason === 'rounds-out', '轮数用光 ⇒ rounds-out（不装成功）', res.reason)
  ok(res.tried.length === 3, '拉黑名单里正好三条（每轮一个）', JSON.stringify(res.tried))
  ok(new Set(res.tried).size === 3, '三条都不一样（不是反复重试同一个）', JSON.stringify(res.tried))
  ok(res.log.some((l) => l.includes('换一条')), '日志里明确写了"换一条"', JSON.stringify(res.log))
  ok(res.log.some((l) => l.includes('没靠近')), '日志里也说了"没靠近"（不是"成功"）', JSON.stringify(res.log))
  ok(res.note.includes('别在原地继续游'), '人话里劝它别原地打转', res.note)

  /* 候选**全试完了** ⇒ all-tried（跟"轮数用光"是两种不同的交代，不能混） */
  const b9 = w.bot()
  const t9 = []
  const ctx9 = mkCtx(b9, {
    walkTo: async (s, p) => { t9.push(`${p.x},${p.y},${p.z}`); b9.oxygenLevel -= 3 },
    swimUp: async () => { t9.push('surface') },
  })
  const res9 = await recoverFromWater({ requireBot: () => b9 }, { rounds: 6 }, ctx9)
  ok(res9.ok === false && res9.reason === 'all-tried', '候选全试完了 ⇒ all-tried', `${res9.ok}/${res9.reason}`)
  ok(res9.note.includes('都试过了'), '人话里承认"都试过了"，不装', res9.note)
}

/* ─────────── ④ 用户场景⑦：取消信号 ⇒ 立刻停手 ─────────── */
section('④ 场景⑦：恢复期间收到取消信号 ⇒ 一条路线都不走')
{
  const w = sceneTwoExits()
  const b = w.bot()
  const self = { requireBot: () => b }
  let called = 0
  const ctx = mkCtx(b, { walkTo: async () => { called++ } })
  ctx.signal = { aborted: true }
  const res = await recoverFromWater(self, {}, ctx)
  ok(res.ok === false && res.reason === 'aborted', '🔴 已取消 ⇒ 立刻回 aborted', `${res.ok}/${res.reason}`)
  ok(called === 0, '🔴 一次 walkTo 都没调（不许"取消了我还走一段"）', String(called))
  ok(res.rounds === 0, '一轮都没跑', String(res.rounds))
  ok(res.note.includes('被取消'), '人话里说清是被取消了', res.note)

  /* 中途取消：第一轮走完之后才被取消 */
  const b2 = w.bot()
  const self2 = { requireBot: () => b2 }
  let n = 0
  const ctx2 = mkCtx(b2, { walkTo: async () => { n++; ctx2.signal.aborted = true } })
  ctx2.signal = { aborted: false }
  const res2 = await recoverFromWater(self2, { rounds: 3 }, ctx2)
  ok(n === 1, '中途取消 ⇒ 停在那一轮，不再走第二条', String(n))
  ok(res2.reason === 'aborted', '理由还是 aborted', res2.reason)
}

/* ─────────── ⑤ 用户场景⑧：上岸之后 ─────────── */
section('⑤ 场景⑧：上岸后重新看状态，并把"要不要继续原任务"交回 AI')
{
  const w = sceneTwoExits()
  const b = w.bot()
  const self = { requireBot: () => b }
  const ctx = mkCtx(b, {
    /* 这次真的把人挪到岸上（模拟寻路器成功） */
    walkTo: async (s, p) => { b.entity.position = { x: p.x + 0.5, y: p.y, z: p.z + 0.5 } },
  })
  const res = await recoverFromWater(self, {}, ctx)
  ok(res.ok === true, '上岸了', `${res.ok}/${res.reason}`)
  ok(res.reason === 'escaped', '理由是 escaped', res.reason)
  ok(res.kind === 'dry', '目标是"安全落脚点"', String(res.kind))
  ok(res.state.inWater === false, '🔴 **重新读了**状态（不是拿移动函数的返回值当结论）', JSON.stringify(res.state.inWater))
  ok(res.rounds === 1, '一轮就成', String(res.rounds))

  const txt = waterReportText(res, { why: 'oxygen-dropping', detail: '氧气从 20 掉到 15' })
  ok(txt.includes('我自己从水里出来了'), '报告抬头说清"我自己动了"', txt.split('\n')[0])
  ok(txt.includes('氧气在往下掉') && txt.includes('20 掉到 15'), '报告里带上**为什么**动手', txt.split('\n')[0])
  ok(txt.includes('没有') && txt.includes('替你决定'), '🔴 明确把"要不要恢复原任务"交回 AI（不偷偷接管后续）', txt.split('\n').pop())
  ok(txt.includes('原来的任务要不要继续'), '原话就是"原来的任务要不要继续"', txt.split('\n').pop())
  ok(waterReportText(null) === '水下恢复：没有结果', '没结果也不炸')
  ok(waterReportText({ ok: false, note: 'x', tried: [], log: [] }).includes('我在水里没出来'), '失败的报告抬头不一样')

  /* 挪近了但没到 ⇒ 算 improved（还没脱险，别当成功）
   * 场景刻意做成"岸在 7 格之外的水隧道"：挪 4 格之后离岸还有 4 格 ⇒
   * "离目标 ≤ 到达半径(1.6)" 根本不可能成立，只能靠"确实挪近了"判成功。 */
  const w3 = mkWorld()
  w3.box(-2, 54, -2, 9, 59, 2, 'stone')
  w3.box(-2, 62, -2, 9, 66, 2, 'stone')
  for (let x = -2; x <= 6; x++) for (let y = 60; y <= 61; y++) w3.set(x, y, 0, 'water')
  for (let y = 60; y <= 61; y++) w3.set(7, y, 0, 'air')            // 岸在 7 格之外
  const b3 = w3.bot(0.5, 60, 0.5)
  const ctx3 = mkCtx(b3, { walkTo: async (s, p) => { b3.entity.position = { x: p.x - 4 + 0.5, y: p.y, z: p.z + 0.5 } } })
  const res3 = await recoverFromWater({ requireBot: () => b3 }, {}, ctx3)
  ok(res3.ok === true && res3.reason === 'improved', '只挪近了 ⇒ improved（不是 escaped）', `${res3.ok}/${res3.reason}`)
  ok(res3.note.includes('还没脱险'), '人话里明说"还没脱险"', res3.note)
}

/* ─────────── ⑥ 兜底与失败路径 ─────────── */
section('⑥ 兜底：没出口时先试着上浮；预算/轮数/前置条件都要有明确交代')
{
  /* 没有出口，但上浮之后氧气回升 ⇒ 算逃出来了（surface） */
  const w = mkWorld()
  w.box(-2, 54, -2, 2, 54, 2, 'stone')
  w.box(-2, 55, -2, 2, 60, 2, 'stone')
  for (let y = 55; y <= 60; y++) w.set(0, y, 0, 'water')     // 密闭水柱（上面还是石头 ⇒ 没出口）
  const b = w.bot(0.5, 57, 0.5)
  b.oxygenLevel = 5                                            // 快憋死了
  const self = { requireBot: () => b }
  const ctx = mkCtx(b, { swimUp: async () => { b.oxygenLevel = 20; b.entity.position = { x: 0.5, y: 57, z: 0.5 } } })
  const res = await recoverFromWater(self, {}, ctx)
  ok(res.ok === true && res.reason === 'escaped', '🔴 没找到出口但上浮后气回来了 ⇒ 算逃出来', `${res.ok}/${res.reason}`)
  ok(res.kind === 'surface', '类型标成 surface（不是"上岸"）', String(res.kind))
  ok(res.log.some((l) => l.includes('没找到出口')), '日志里交代了"没找到出口"', JSON.stringify(res.log))

  /* 没有出口 + 上浮也没用 ⇒ 老实失败，理由用搜索的 reason */
  const b2 = w.bot(0.5, 57, 0.5)
  const ctx2 = mkCtx(b2, { swimUp: async () => {} })
  const res2 = await recoverFromWater({ requireBot: () => b2 }, {}, ctx2)
  ok(res2.ok === false && res2.reason === 'no-exit-found', '上浮也没用 ⇒ no-exit-found', `${res2.ok}/${res2.reason}`)
  ok(res2.note.includes('别在原地一直游'), '人话里劝它别原地打转', res2.note)

  /* 预算用光 */
  const w3 = sceneTwoExits()
  const b3 = w3.bot()
  const ctx3 = mkCtx(b3, { walkTo: async () => {} })
  const res3 = await recoverFromWater({ requireBot: () => b3 }, { budgetMs: 0 }, ctx3)
  ok(res3.ok === false && res3.reason === 'budget-out', '🔴 预算 0 ⇒ 立刻回 budget-out（不硬跑）', `${res3.ok}/${res3.reason}`)
  ok(res3.note.includes('过一会儿再叫我一次'), '人话里说"过一会儿再叫我"', res3.note)

  /* 前置条件 */
  const dry = mkWorld().box(-2, 60, -2, 2, 60, 2, 'stone').bot(0.5, 61, 0.5)
  const rDry = await recoverFromWater({ requireBot: () => dry }, {}, mkCtx(dry, { walkTo: async () => {} }))
  ok(rDry.ok === true && rDry.reason === 'not-in-water', '不在水里 ⇒ 直接说"我本来就没在水里"', `${rDry.ok}/${rDry.reason}`)
  const b4 = sceneTwoExits().bot()
  const rNo = await recoverFromWater({ requireBot: () => b4 }, {}, mkCtx(b4, {}))
  ok(rNo.ok === false && rNo.reason === 'no-executor', '🔴 没人给 walkTo/swimUp ⇒ 明确报 no-executor（不是假装成功）', rNo.reason)
  ok(rNo.note.includes('宿主'), '并说清这是宿主该接的', rNo.note)
  ok(WATER_RECOVER_ROUNDS === 3 && WATER_RECOVER_MS === 12_000, '默认 3 条路线 / 12 秒', `${WATER_RECOVER_ROUNDS}/${WATER_RECOVER_MS}`)
  ok(WATER_STUCK_MS === 2_500, '默认 2.5 秒算"没挪窝"', String(WATER_STUCK_MS))
}

/* ─────────── ⑦ 静态接线 ─────────── */
section('⑦ 静态接线：不自己按键盘、不反向依赖、一定通知 AI')
{
  const src = readFileSync(new URL('../src/water-recovery.mjs', import.meta.url), 'utf8')
  const no = stripComments(src)
  ok(!/from '\.\/core\.mjs'/.test(no), '🔴 不 import core.mjs（会成环）')
  ok(!/from '\.\/movement\.mjs'/.test(no), '🔴 不 import movement.mjs（不然 movement ↔ water-recovery 成环）')
  ok(!/from 'mineflayer/.test(no), '🔴 不 import mineflayer')
  ok(!/setControlState/.test(no), '🔴 一行 setControlState 都没有 —— 用户要求"不再实现第二套游泳按键控制"')
  ok(/from '\.\/water-navigation\.mjs'/.test(no), '出口搜索走 water-navigation.mjs（同一份知识只有一个出处）')
  ok(/ctx\.walkTo/.test(no) && /ctx\.swimUp/.test(no), '移动全靠注入的 ctx.walkTo / ctx.swimUp')
  ok(/export async function recoverFromWater/.test(no), '导出 recoverFromWater')
  ok(/export function waterReportText/.test(no), '导出 waterReportText（"绝不偷偷接管"的落点）')
  ok(/export function waterTriggerOf/.test(no), '导出 waterTriggerOf')
  ok(/avoid: tried\.size \? tried : null/.test(no), '🔴 把"试过没走通的目标"传给搜索（路线失败就排除它）')
  ok(/重新看位置|重新看状态|重新读了/.test(src), '复核那一步在注释里说清了"不能仅凭移动函数返回成功"')
  ok(!/console\.log/.test(no), '自己不打 console（日志走宿主）')
}

/* ─────────── ⑧ 接进现有架构（用户 2026-10-15 的几条硬约束） ─────────── */
section('⑧ 接线：移动层自动接管、反射层通知 AI、都不另起一套按键控制')
{
  const mvSrc = readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8')
  const mv = stripComments(mvSrc)
  ok(/import \{ recoverFromWater \} from '\.\/water-recovery\.mjs'/.test(mv),
    '🔴 movement.mjs 引了恢复控制器（接进**现有水中流程**，不是另开一条路）')
  ok(/function recoverCtxOf \(self, ctx\)/.test(mv), '给恢复控制器造 ctx 的小函数在')
  ok(/walkTo: \(s, p, o = \{\}\) => walkTo\(/.test(mv) && /swimUp: \(s, o\) => swimUp\(/.test(mv),
    '🔴 执行器**就是这一层已有的 walkTo / swimUp**（不另起一套按键控制 / 移动代次 / 资源锁）')
  ok(/noWaterRecover: true/.test(mv), '🔴 防递归：恢复过程中再走路时不许再次触发恢复')
  ok(/if \(swim\.stuck && !ctx\.noWaterRecover && self\.msLeft\(\) > 1_500\)/.test(mv),
    '🔴 只在"游不动了 + 还有时间"时才开这一趟（用户："避免一次出口搜索耗尽整个工具调用预算"）')
  ok(/budgetMs: Math\.min\(12_000, Math\.max\(0, self\.msLeft\(\) - 900\)\)/.test(mv),
    '恢复预算按剩余调用时间收窄（不吃掉整次工具调用的预算）')
  ok(/waterRecover: rec/.test(mv), '恢复结果挂回 walkTo 的返回值（AI 看得到）')

  const auSrc = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  const au = stripComments(auSrc)
  ok(/import \{ recoverFromWater, waterReportText \} from '\.\.\/src\/water-recovery\.mjs'/.test(au),
    '🔴 反射层也用同一份恢复控制器（同一份知识只有一个出处）')
  ok(/const startWaterRecover = \(s, sess, cfg, t, info\) =>/.test(au), '反射层有"水下自救"入口')
  ok(/recoverFromWater\(bot, \{\}, \{/.test(au), '它调的就是 recoverFromWater')
  ok(/walkTo: \(self, p, o\) => bot\.walkTo\(/.test(au) && /swimUp: \(self, o\) => bot\.swimUp\(/.test(au),
    '🔴 反射层的移动也走现有接口（bot.walkTo / bot.swimUp）')
  ok(/agent\.steer\(userMessage\(\{/.test(au) && /waterReportText\(res, trigger\)/.test(au),
    '🔴 **绝不偷偷接管**：每次自动救援都 agent.steer 一条给 AI')
  ok(/s\.stats\.waterRecovers\+\+/.test(au) && /s\.stats\.waterEscapes\+\+/.test(au),
    '记进 stats（水下自救次数 / 出来次数）')
  ok(/s\.waterRecoverLast = \{ \.\.\.\(res \?\? \{\}\), at: t \}/.test(au), '上一次结果留在会话状态里（status 看得到）')
  ok(/const WATER_RECOVER_GAP_MS = 15_000/.test(au) && /const WATER_RECOVER_MAX_MS = 15_000/.test(au),
    '限流 15 秒 / 单次上限 15 秒')
  ok(/waterRecover: recovering/.test(au) && /同时在试着自己找出口/.test(auSrc),
    '🔴 叫醒文案里如实说"我同时在试着自己找出口"（不偷偷接管）')
  ok(/const recovering = startWaterRecover\(s, sess, cfg, t, \{/.test(au),
    '只在**憋气**那条分支里启动自救（挨打那条照旧只叫醒、不自己动）')
  /* 自救这一路自己不许按键盘（按 jump 抬一下是**原有**的濒死保命动作，不在这条里） */
  const recFn = au.slice(au.indexOf('const startWaterRecover ='), au.indexOf('const avoid = (s, sess, cfg, t)'))
  ok(recFn.length > 200 && !/setControlState/.test(recFn), '自救这一路一行 setControlState 都没有')
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
