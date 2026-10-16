#!/usr/bin/env node
/**
 * `src/water-navigation.mjs` 的离线自检（2026-10-15 用户点名要的"水下寻路"第一层）。
 *
 * 全程用假世界 + 假 bot（只提供 `entity.position` 和 `blockAt`），
 * **不需要 MC、不需要 DSH** —— 和 `check-bridge.mjs` / `check-terrain.mjs` 一个路子。
 *
 * 覆盖用户列的八个场景里属于"出口搜索"的五个（① 头顶通水面 ② 侧面出口
 * ③ 空气口袋不算脱险 ④ 死路 vs 远处出口 ⑤ 完全没有出口），
 * ⑥⑦⑧（执行期的氧气/取消/恢复原任务）归 `check-water-recovery.mjs`。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')

const W = await import(new URL('../src/water-navigation.mjs', import.meta.url))
const {
  WATER_RADIUS, WATER_UP, WATER_DOWN, WATER_MAX_NODES, WATER_KINDS, WATER_KIND_TEXT,
  nameAt, cellKindAt, swimmableAt, breathableAt, standableAt, hazardNear,
  waterExitSearch, feetOfBot, inWaterAt, waterSummaryOf,
} = W

/* ── 假世界：显式方块表；没写过的格子 = 没加载（`blockAt` 回 null ⇒ 'unknown'） ── */
const mkWorld = () => {
  const m = new Map()
  const K = (x, y, z) => `${x},${y},${z}`
  const api = {
    set (x, y, z, n) { m.set(K(x, y, z), n); return api },
    box (x1, y1, z1, x2, y2, z2, n) {
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) m.set(K(x, y, z), n)
      return api
    },
    /** 假 bot：`position` 是脚中心（真 mineflayer 也是带 .5 偏移的） */
    bot (px = 0.5, py = 60, pz = 0.5) {
      return {
        entity: { position: { x: px, y: py, z: pz } },
        blockAt: (v) => {
          const n = m.get(K(Math.floor(v.x), Math.floor(v.y), Math.floor(v.z)))
          return n == null ? null : { name: n }
        },
      }
    },
  }
  return api
}

/* ─────────── ① 单格判据 ─────────── */
section('① 单格判据：水 / 空气 / 挡路 / 没加载，四者不能混')
{
  const w = mkWorld()
  w.set(0, 60, 0, 'water').set(0, 61, 0, 'air').set(0, 62, 0, 'stone')
    .set(0, 63, 0, 'lava').set(0, 64, 0, 'snow').set(0, 65, 0, 'ladder')
  const b = w.bot()
  ok(cellKindAt(b, 0, 60, 0) === 'water', '水 ⇒ water')
  ok(cellKindAt(b, 0, 61, 0) === 'air', '空气 ⇒ air')
  ok(cellKindAt(b, 0, 62, 0) === 'blocked', '石头 ⇒ blocked')
  ok(cellKindAt(b, 0, 63, 0) === 'blocked', '🔴 岩浆 ⇒ blocked（不是"能游过去"）')
  ok(cellKindAt(b, 0, 64, 0) === 'air', '雪片（可穿过）⇒ air')
  ok(cellKindAt(b, 0, 65, 0) === 'air', '梯子（可穿过）⇒ air')
  w.set(0, 66, 0, 'oak_door')
  ok(cellKindAt(b, 0, 66, 0) === 'blocked', '🔴 关着的门 ⇒ blocked（宁可保守：方块名这一层不知道门开没开）')
  ok(cellKindAt(b, 9, 60, 9) === 'unknown', '🔴 没写过的格子 ⇒ unknown（**不能当空气**）')
  ok(nameAt(b, 9, 60, 9) === null, 'nameAt 拿不到就回 null，不编一个方块名')

  ok(swimmableAt(b, 0, 60, 0) === true, '脚水 + 头空气 ⇒ 能游过去')
  ok(swimmableAt(b, 0, 62, 0) === false, '脚是石头 ⇒ 游不过去')
  ok(swimmableAt(b, 9, 60, 9) === false, '🔴 未加载 ⇒ 不能游（宁可少找，也不要瞎走）')
  w.set(1, 60, 0, 'water').set(1, 61, 0, 'stone')
  ok(swimmableAt(b, 1, 60, 0) === false, '脚有水但头是石头 ⇒ 游不过去（会淹死）')

  ok(breathableAt(b, 0, 60, 0) === true, '头那格是空气 ⇒ 能换气')
  w.set(2, 60, 0, 'water').set(2, 61, 0, 'water')
  ok(breathableAt(b, 2, 60, 0) === false, '头那格还是水 ⇒ 换不了气')

  /* 安全落脚点：三个条件缺一不可 */
  w.box(10, 58, 10, 10, 58, 10, 'stone').set(10, 59, 10, 'air').set(10, 60, 10, 'air')
  ok(standableAt(b, 10, 59, 10) === true, '脚/头都是空气 + 脚下是石头 ⇒ 安全落脚点')
  w.set(10, 58, 10, 'water')
  ok(standableAt(b, 10, 59, 10) === false, '🔴 脚下是水 ⇒ 不是落脚点（只看"头是空气"会把水面当成岸）')
  w.set(10, 58, 10, 'lava')
  ok(standableAt(b, 10, 59, 10) === false, '🔴 脚下是岩浆 ⇒ 不是落脚点')
  w.set(10, 58, 10, 'stone').set(10, 60, 10, 'water')
  ok(standableAt(b, 10, 59, 10) === false, '头那格是水 ⇒ 不是落脚点')
  ok(standableAt(b, 9, 59, 9) === false, '未加载 ⇒ 不是落脚点')

  w.set(20, 60, 20, 'lava')
  ok(hazardNear(b, 20, 61, 20) === 'lava', 'hazardNear 找得到旁边（这里在正下方）的岩浆')
  ok(hazardNear(b, 21, 60, 20) === 'lava', '正旁边那格也算"附近"（7 格邻域，不是只查脚下）')
  ok(hazardNear(b, 0, 60, 0) === null, '干净的地方回 null')

  ok(feetOfBot(w.bot(3.7, 60.2, -2.9)).x === 3, 'feetOfBot 往下取整（x）')
  ok(feetOfBot(w.bot(3.7, 60.2, -2.9)).z === -3, 'feetOfBot 往下取整（z，负数是 -3 不是 -2）')
  ok(feetOfBot({ entity: {} }) === null, '读不到坐标 ⇒ null，不炸')
  ok(feetOfBot(null) === null, '没 bot ⇒ null')
  ok(inWaterAt(b, { x: 0, y: 60, z: 0 }) === true, '脚那格是水 ⇒ 在水里')
  ok(inWaterAt(b, { x: 0, y: 59, z: 0 }) === true, '头那格是水 ⇒ 也算在水里')
  ok(inWaterAt(b, { x: 8, y: 60, z: 8 }) === false, '都不是水 ⇒ 不在水里')
  ok(WATER_KINDS.join(',') === 'dry,breath,passage', '三类出口的顺序就是优先级 dry > breath > passage')
  ok(WATER_RADIUS === 8 && WATER_UP === 8 && WATER_DOWN === 8, '第一版的搜索范围就是水平 8 / 上下 8（用户给的初值）', `${WATER_RADIUS}/${WATER_UP}/${WATER_DOWN}`)
  ok(Object.keys(WATER_KIND_TEXT).length === 3, '三类都有中文说法（要给 AI 看人话）')
}

/* ─────────── ② 用户场景①：头顶直接通到水面 ─────────── */
section('② 场景①：头顶一路通到水面 ⇒ 优先找到上浮路线')
{
  const w = mkWorld()
  w.box(-3, 54, -3, 3, 54, 3, 'stone')          // 地板
  w.box(-3, 55, -3, 3, 64, 3, 'stone')          // 先全填石头（四面都是墙）
  for (let y = 55; y <= 64; y++) w.set(0, y, 0, 'water')   // 中间挖一条水柱
  for (let y = 65; y <= 68; y++) w.set(0, y, 0, 'air')     // 水面上方的空气
  const b = w.bot(0.5, 60, 0.5)
  const r = waterExitSearch(b)
  ok(r.found === true, '找到了出口', r.reason)
  ok(r.kind === 'breath', '类型是"可呼吸空间"（水面）', r.kind)
  ok(r.target && r.target.x === 0 && r.target.z === 0, '出口就在正上方同一条竖线上', JSON.stringify(r.target))
  ok(r.target.y === 64, '目标就是水柱最顶上那格（头那格是空气）', String(r.target.y))
  ok(r.distance === 4, '从 y=60 上去 4 格（61/62/63/64）', String(r.distance))
  ok(r.path.length === 4, '路线是 4 步', String(r.path.length))
  ok(r.path.every((p) => p.x === 0 && p.z === 0), '路线全程在竖直水柱里（没乱拐）', JSON.stringify(r.path))
  ok(r.path.map((p) => p.y).join(',') === '61,62,63,64', '路线就是一路往上', r.path.map((p) => p.y).join(','))
  ok(r.note.includes('可呼吸空间'), '人话里说清是"可呼吸空间"', r.note)
  ok(waterSummaryOf(r).includes('(0,64,0)'), 'waterSummaryOf 带上坐标', waterSummaryOf(r))
}

/* ─────────── ③ 用户场景②：头顶封住、侧面有出口 ─────────── */
section('③ 场景②：头顶被石头封住、侧面有出口 ⇒ 搜索侧向通道')
{
  const w = mkWorld()
  w.box(-5, 54, -5, 5, 54, 5, 'stone')
  w.box(-5, 55, -5, 5, 66, 5, 'stone')
  for (let y = 55; y <= 63; y++) w.set(0, y, 0, 'water')     // 水柱，顶上是 64 的石头
  for (let x = 1; x <= 3; x++) { w.set(x, 60, 0, 'water'); w.set(x, 61, 0, 'water') }  // 侧向水道
  w.set(4, 60, 0, 'air'); w.set(4, 61, 0, 'air')             // 干燥落脚点（脚下 4,59,0 是石头）
  const b = w.bot(0.5, 60, 0.5)
  const r = waterExitSearch(b)
  ok(r.found === true, '找到了出口', r.reason)
  ok(r.kind === 'dry', '🔴 类型是"安全落脚点"（不是随便一个能呼吸的地方）', r.kind)
  ok(r.target && r.target.x === 4 && r.target.y === 60 && r.target.z === 0, '目标就是那块干燥落脚点', JSON.stringify(r.target))
  ok(r.distance === 4, '往东 4 格', String(r.distance))
  ok(r.path.every((p) => p.z === 0), '路线没离开 z=0 这条线', JSON.stringify(r.path))
  ok(r.path.every((p) => p.y === 60), '路线是平着过去的（不是往上撞天花板）', r.path.map((p) => p.y).join(','))
  ok(r.note.includes('安全落脚点'), '人话里说清是"安全落脚点"', r.note)
}

/* ─────────── ④ 用户场景③：空气口袋不是脱险 ─────────── */
section('④ 场景③：洞穴里的空气口袋 ⇒ 认成中间目标，不误报脱险')
{
  const w = mkWorld()
  w.box(-3, 54, -3, 3, 54, 3, 'stone')
  w.box(-3, 55, -3, 3, 70, 3, 'stone')
  for (let y = 55; y <= 62; y++) w.set(0, y, 0, 'water')
  w.set(0, 63, 0, 'air'); w.set(0, 64, 0, 'air')            // 空气口袋，上面还是石头
  const b = w.bot(0.5, 60, 0.5)
  const r = waterExitSearch(b)
  ok(r.found === true, '找到了东西（空气口袋）', r.reason)
  ok(r.kind === 'breath', '🔴 类型是"可呼吸空间"而不是"安全落脚点"', r.kind)
  ok(r.kind !== 'dry', '🔴 绝不把空气口袋报成脱险', r.kind)
  ok(r.note.includes('空气口袋'), '人话里点明这是空气口袋', r.note)
  ok(r.note.includes('中间目标'), '并说清它只是中间目标', r.note)
  ok(r.note.includes('别当已经上岸'), '明确警告"别当已经上岸"', r.note)
}

/* ─────────── ⑤ 用户场景④：近处死路 vs 远处出口 ─────────── */
section('⑤ 场景④：近处有个能换气的小洞、远处才有岸 ⇒ 选远的那个')
{
  const w = mkWorld()
  w.box(-3, 54, -3, 8, 54, 3, 'stone')
  w.box(-3, 55, -3, 8, 66, 3, 'stone')
  for (let x = 0; x <= 6; x++) { w.set(x, 60, 0, 'water'); w.set(x, 61, 0, 'water') }  // 主水道
  w.set(1, 62, 0, 'air'); w.set(1, 63, 0, 'air')            // 近处：一个只能换气的小洞（距离 1）
  w.set(7, 60, 0, 'air'); w.set(7, 61, 0, 'air')            // 远处：真正的岸（距离 7）
  const b = w.bot(0.5, 60, 0.5)
  const r = waterExitSearch(b)
  ok(r.found === true, '找到了出口', r.reason)
  ok(r.kind === 'dry', '🔴 选了远处的"安全落脚点"，没被近处的小洞骗走', r.kind)
  ok(r.target && r.target.x === 7, '目标就是 7 格外那块岸', JSON.stringify(r.target))
  ok(r.distance === 7, '代价是 7 格（近处的只要 1 格）', String(r.distance))
  const breath = r.candidates.filter((c) => c.kind === 'breath')
  ok(breath.length >= 1, '近处那个小洞仍然在候选列表里（只是没被选）', JSON.stringify(breath.map((c) => c.distance)))
  ok(r.candidates[0].kind === 'dry', '候选列表也是"岸"排第一（按分阶段评分排序）', JSON.stringify(r.candidates[0]))
}

/* ─────────── ⑥ 用户场景⑤：完全没有出口 ─────────── */
section('⑥ 场景⑤：附近完全没有可达出口 ⇒ 明确失败，不无限游动')
{
  const w = mkWorld()
  w.box(-2, 55, -2, 2, 64, 2, 'stone')
  w.box(-1, 56, -1, 1, 63, 1, 'water')                      // 密闭水牢：全是水，没有空气
  const b = w.bot(0.5, 60, 0.5)
  const r = waterExitSearch(b)
  ok(r.found === false, '🔴 明确回"没找到"，而不是硬编一个目标', String(r.found))
  ok(r.reason === 'no-exit-found', '理由就是 no-exit-found', r.reason)
  ok(r.target === null && r.path.length === 0, '没有目标、没有路线', JSON.stringify({ t: r.target, p: r.path.length }))
  ok(r.candidates.length === 0, '候选也是空的', JSON.stringify(r.candidates))
  ok(r.note.includes('没找到任何出口') && r.note.includes('别在原地一直游'), '人话里明确说"别在原地一直游"', r.note)
  ok(r.scanned > 1, '确实翻过格子（不是压根没搜）', String(r.scanned))
}

/* ─────────── ⑦ 边界与预算 ─────────── */
section('⑦ 边界：不在水里 / 范围 / 预算 / 危险候选')
{
  /* 干燥的岸边（脚下石头、身体两格空气）—— 站在这里不该去"搜水下出口" */
  const wDry = mkWorld()
  wDry.box(-2, 60, -2, 2, 60, 2, 'stone')
  const rDry = waterExitSearch(wDry.bot(0.5, 61, 0.5))
  ok(rDry.found === false && rDry.reason === 'not-in-water', '🔴 站在干燥岸上 ⇒ 明确说"我本来就不在水里"，不瞎搜', rDry.note)
  ok(waterExitSearch({ entity: {} }).reason === 'unknown-world', '读不到坐标 ⇒ unknown-world')
  ok(waterExitSearch(null).reason === 'unknown-world', '没 bot ⇒ unknown-world，不炸')

  const w = mkWorld()
  w.box(-3, 54, -3, 8, 54, 3, 'stone')
  w.box(-3, 55, -3, 8, 66, 3, 'stone')
  for (let x = 0; x <= 6; x++) { w.set(x, 60, 0, 'water'); w.set(x, 61, 0, 'water') }
  w.set(7, 60, 0, 'air'); w.set(7, 61, 0, 'air')
  const b = w.bot(0.5, 60, 0.5)

  const rSmall = waterExitSearch(b, { radius: 3 })
  ok(!(rSmall.found && rSmall.kind === 'dry'), '🔴 半径收到 3 格 ⇒ 7 格外的岸就找不到了（范围真的是硬边界）', `${rSmall.found}/${rSmall.kind}`)
  ok(rSmall.target == null || Math.abs(rSmall.target.x) <= 3, '任何返回的目标都在半径内', JSON.stringify(rSmall.target))
  const rBig = waterExitSearch(b, { radius: 8 })
  ok(rBig.found === true && rBig.kind === 'dry' && rBig.target.x === 7, '半径 8 ⇒ 找得到那块岸', JSON.stringify(rBig.target))
  ok(rSmall.scanned < rBig.scanned, '范围小 ⇒ 翻的格子也少', `${rSmall.scanned} < ${rBig.scanned}`)

  const rTiny = waterExitSearch(b, { maxNodes: 2 })
  ok(rTiny.scanned <= 2, '🔴 maxNodes 是硬上限（不许一次搜索吃光整个工具预算）', String(rTiny.scanned))
  ok(rTiny.found === false && rTiny.reason === 'budget-out', '🔴 预算用光 ⇒ 老实回"没搜完"，不拿随便一个水格冒充出口', `${rTiny.found}/${rTiny.reason}`)

  const rUp = waterExitSearch(b, { up: 0 })
  ok(rUp.target == null || rUp.target.y <= 60, '🔴 up 收到 0 ⇒ 返回的目标不许比起点高（纵向也是硬边界）', JSON.stringify(rUp.target))

  /* 危险候选：唯一能换气的地方旁边就是岩浆 ⇒ 候选上必须标 safe:false */
  const w2 = mkWorld()
  w2.box(-3, 54, -3, 3, 54, 3, 'stone')
  w2.box(-3, 55, -3, 3, 66, 3, 'stone')
  for (let y = 55; y <= 60; y++) w2.set(0, y, 0, 'water')
  w2.set(0, 61, 0, 'air'); w2.set(0, 62, 0, 'air')
  w2.set(1, 61, 0, 'lava')
  const r2 = waterExitSearch(w2.bot(0.5, 60, 0.5))
  ok(r2.found === true, '还是找到了（那个能换气的格）', String(r2.found))
  ok(r2.candidates.some((c) => c.safe === false), '🔴 紧挨着岩浆的候选标了 safe:false（AI 能看出这地方危险）', JSON.stringify(r2.candidates.map((c) => `${c.x},${c.y},${c.z}:${c.kind}:${c.safe}`)))

  /* 有安全的岸时，必须先挑安全的那个（分阶段评分：生存安全排在路径成本前面） */
  const w3 = mkWorld()
  w3.box(-3, 54, -3, 5, 54, 3, 'stone')
  w3.box(-3, 55, -3, 5, 66, 3, 'stone')
  for (let y = 55; y <= 61; y++) w3.set(0, y, 0, 'water')
  w3.set(0, 62, 0, 'air'); w3.set(0, 63, 0, 'air')          // 近处：能换气，但紧挨着岩浆
  w3.set(1, 62, 0, 'lava')
  for (let x = 0; x <= 3; x++) { w3.set(x, 62, 1, 'water'); w3.set(x, 63, 1, 'water') }  // 另一条路
  w3.set(4, 62, 1, 'air'); w3.set(4, 63, 1, 'air')          // 远处：干净的岸
  const r3 = waterExitSearch(w3.bot(0.5, 60, 0.5))
  ok(r3.found === true && r3.kind === 'dry', '🔴 有安全的岸时先挑安全的（不选岩浆旁边那个空气口袋）', `${r3.kind} ${JSON.stringify(r3.target)}`)
  ok(r3.candidates[0].safe === true, '排第一的候选是 safe:true', JSON.stringify(r3.candidates[0]))
  ok(r3.candidates.every((c) => c.safe === true), '🔴 有安全候选时，危险的那个**不进**候选列表（别邀请 AI 游进岩浆）', JSON.stringify(r3.candidates.map((c) => c.safe)))
}

/* ─────────── ⑧ 静态接线 ─────────── */
section('⑧ 静态接线：不许反向依赖、不许碰 bot 的按键')
{
  const src = readFileSync(new URL('../src/water-navigation.mjs', import.meta.url), 'utf8')
  const no = stripComments(src)
  ok(!/from '\.\/core\.mjs'/.test(no), '🔴 不 import core.mjs（会成环）')
  ok(!/from 'mineflayer/.test(no), '🔴 不 import mineflayer')
  ok(!/setControlState|\.dig\(|\.placeBlock|\.chat\(/.test(no), '🔴 不碰 bot 的按键 / 动作（出口搜索只读世界）')
  ok(/from '\.\/block-names\.mjs'/.test(no), '复用 block-names.mjs 的方块判据')
  ok(/from '\.\/bridge\.mjs'/.test(no), '复用 bridge.mjs 的危险方块名单（同一份知识只有一个出处）')
  ok(/export function waterExitSearch/.test(no), '导出 waterExitSearch')
  ok(/export function standableAt/.test(no) && /export function breathableAt/.test(no), '导出三类出口的判据')
  ok(/open <= startOpen/.test(no), '🔴 A 类兜底带"比我这里更开阔"的门槛（否则密闭水牢会被报成"找到水道"）')
  ok(/WATER_MAX_NODES/.test(no) && /maxNodes/.test(no), '搜索有节点预算')
  ok(/no-exit-found/.test(no), '有明确的 no-exit-found 结果码')
  ok(/WATER_KIND_TEXT/.test(no), '三类出口都有人话（要给 AI 看）')
  ok(!/console\.log/.test(no), '自己不打 console（日志走宿主）')
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
