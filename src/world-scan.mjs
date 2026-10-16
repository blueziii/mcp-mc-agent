/**
 * 附近扫描与实体列表 —— 从 `src/core.mjs` 搬出来的"感知"那一层（路线图第 ④ 条第十二刀）。
 *
 * 约定（每一刀都照这个来）：
 *   ① **不反向 import `core.mjs`** —— 这些函数只吃传进来的 `b`（mineflayer bot）。
 *   ② 只借 `vec3`（`new Vec3()`）与纯方块名判据，不直接 import mineflayer —— 依赖方向保持"叶子 → 上层"。
 *   ③ **只读、不 await、不改状态** —— 不碰控制位、不发包、不受看图门禁限制。
 *
 * 两个函数都是"把 `bot` 已经知道的东西读出来、分类、排序、截断"，没有自研算法：
 *   · `scanAround(b, opts)`  —— 周围方块的计数（不点名）或按名字找（点名时按距离升序取前 N 个）。
 *   · `entitiesNear(b, …)`   —— 附近有谁：名字 / 坐标 / 距离 / 上下差 / 血量 / 是不是远程。
 *
 * 🔴 `core.mjs` 里留了**同名薄包装**（`scan()` / `entities()`），因为它们俩是**公开方法** ——
 *    调用方（`index.js` 的 `mc_scan`、`extensions\mc_observe.mjs` 的"程序检测到"、套件）用的是
 *    `bot.scan()` / `bot.entities()`，而不是"`core.mjs` 导出了这个名字"，re-export 救不了方法。
 *    薄包装里照样先 `requireBot()`，保持"不在线就抛"的语义。
 */

import { Vec3 } from 'vec3'
import { isAir } from './block-names.mjs'
import { entityNameOf, HOSTILE_RE, RANGED_RE } from './entity-names.mjs'

export function scanAround (b, { radius = 16, height = 4, name = null, limit = 10 } = {}) {
  /* 半径默认 16 = **1 区块**（2026-10-13 用户要求，先定 32 后改回 16）：一次扫 33×33 格，
   * 找树 / 找矿 / 找水源够用，又不至于每次调用都查几万格。上限 48 留给显式传大半径的场合。 */
  const R = Math.min(Math.max(radius, 1), 48)
  const H = Math.min(Math.max(height, 0), 16)
  const c = b.entity.position.floored()
  const counts = new Map()
  const found = []
  let unloaded = 0
  for (let dx = -R; dx <= R; dx++) {
    for (let dz = -R; dz <= R; dz++) {
      for (let dy = -H; dy <= H; dy++) {
        const pos = new Vec3(c.x + dx, c.y + dy, c.z + dz)
        const blk = b.blockAt(pos)
        if (!blk) { unloaded++; continue }
        if (isAir(blk.name)) continue
        if (name) {
          if (blk.name === name) {
            /* 🔴 2026-10-08 第五份审计报告 ③：以前只 `found.push` 再 `slice(0, limit)` ——
             *    而三层循环是 `dx → dz → dy`，所以"前 N 个"全落在 x/z 最负的那个角
             *    （半径 24 时能差 30 多格）。AI 于是跑去够不着的地方挖，或据此判"附近没有"。
             *    现在带距离一起记，最后**按到我的距离升序**取前 N 个。 */
            const d = Math.hypot(pos.x + 0.5 - b.entity.position.x, pos.y + 0.5 - b.entity.position.y, pos.z + 0.5 - b.entity.position.z)
            found.push({ pos: `${pos.x},${pos.y},${pos.z}`, d: Math.round(d * 10) / 10 })
          }
        } else counts.set(blk.name, (counts.get(blk.name) ?? 0) + 1)
      }
    }
  }
  if (name) {
    found.sort((a, b2) => a.d - b2.d)
    /* 🔴 2026-10-15 审计：`found` 是 `string[]`，而 `nearest` 以前塞的是内部的 `{pos,d}` 对象
     *    ⇒ 两套形状，谁把它当字符串用就会拿到 `[object Object]`。统一成字符串坐标。 */
    return { found: found.slice(0, limit).map((f) => f.pos), total: found.length, unloaded, nearest: found.length ? found[0].pos : null }
  }
  return {
    center: { x: c.x, y: c.y, z: c.z }, radius: R, height: H, unloaded,
    counts: [...counts.entries()].sort((a, b2) => b2[1] - a[1]).slice(0, 25).map(([n, v]) => ({ name: n, count: v })),
  }
}

/**
 * 附近有谁（怪 / 玩家 / 动物 / 掉落物）—— 名字、坐标、距离、上下差、血量、是不是远程。
 *
 * 上游原版只有"名字 / 类型 / 坐标 / 距离"，2026-10-06 用户问"可不可以获取附近怪物的位置"
 * 之后补上了**分类 + 血量 + 远程标记**。**不用自己算**：mineflayer 内核本来就把周围所有实体
 * 放在 `bot.entities`（服务端 spawn / teleport / relative-move 包喂进去的），每条都有
 * `.name` / `.position` / `.kind` / `.metadata`。这里只是**读出来 + 分类 + 按距离排序 + 截断**，
 * 没有任何自研算法。
 *
 * 血量和距离用**现成的** `@nxg-org/mineflayer-util-plugin`（`bot.util.entity.*`）：
 * 它是 `mineflayer-auto-eat` 的依赖，auto-eat 注入时会 `bot.loadPlugin()` 它
 * （见 `mineflayer-auto-eat/dist/index.js:2,6`），所以我们加载 auto-eat 之后 `bot.util` 就在。
 * 它按版本挑 metadata 槽位读怪的血（1.17+ 用 9），比 `entity.health` 靠谱 ——
 * mineflayer **不给别的实体**暴露 `.health`（只有 bot 自己的）。助手不在/抛错就退回自己算。
 *
 * 🔴 只读：不碰世界、不按控制位、不受看图门禁限制。
 */
export function entitiesNear (b, radius = 24, { kind = 'all', limit = 40 } = {}) {
  const me = b.entity?.position
  if (!me) return { error: '还没有位置信息（区块没加载完？）' }
  const R = Math.min(Math.max(Number(radius) || 24, 1), 128)
  const want = String(kind ?? 'all').toLowerCase()
  const ue = b?.util?.entity ?? null                       // 现成助手（可能没装）
  const distOf = (e) => {
    try {
      const d = Number(ue?.entityDistance?.(e))
      if (Number.isFinite(d)) return d
    } catch { /* 助手不可用就自己算 */ }
    try { return e.position.distanceTo(me) } catch { return Infinity }
  }
  const healthOf = (e) => {
    try {
      const h = Number(ue?.getHealth?.(e))
      if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10
    } catch { /* 同上 */ }
    const h2 = Number(e?.health)
    return Number.isFinite(h2) && h2 > 0 ? Math.round(h2 * 10) / 10 : null
  }
  const list = []
  for (const e of Object.values(b.entities ?? {})) {
    if (!e || e === b.entity || !e.position) continue
    const nm = entityNameOf(e)
    const isPlayer = Boolean(e.username) || e.type === 'player'
    const hostile = HOSTILE_RE.test(nm) || e.kind === 'Hostile mobs'
    const group = isPlayer ? 'player' : (hostile ? 'hostile' : 'other')
    if (want === 'hostile' && group !== 'hostile') continue
    if (want === 'player' && group !== 'player') continue
    if (want === 'mob' && group === 'player') continue
    const d = distOf(e)
    if (d > R) continue
    const hp = healthOf(e)
    list.push({
      name: nm, kind: group, hostile, ranged: RANGED_RE.test(nm),
      distance: Math.round(d * 100) / 100,
      position: { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) },
      dy: Math.round((e.position.y - me.y) * 10) / 10,
      ...(hp === null ? {} : { health: hp }),
      ...(isPlayer ? { player: true } : {}),
    })
  }
  list.sort((a, c) => a.distance - c.distance)
  const counts = { hostile: 0, player: 0, other: 0 }
  for (const x of list) counts[x.kind]++
  return {
    me: { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) },
    radius: R, kind: want, counts,
    total: list.length,
    list: list.slice(0, Math.min(Math.max(Number(limit) || 40, 1), 64)),
  }
}
