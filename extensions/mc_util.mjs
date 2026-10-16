/**
 * mc_util —— 扩展之间共用的最小工具件（**不是**一个扩展，没有 `apply`）
 *
 * 为什么有这个文件：`mc_craft` / `mc_chest` / `mc_furnace` / `mc_observe` 都要"名字 ↔ id 互转、
 * 查某一格方块、找个能放东西的位置、夹取一个数"这几件事。原来这些是各自抄一份
 * （`clamp` 4 份、`countOf` 3 份），或者让箱子/熔炉去 `import` 合成模块 —— 箱子工具依赖合成工具，
 * 方向不对，而且想单独给某个扩展做离线套件时得连合成那一坨一起拖进来。
 *
 * 现在统一在这里，依赖方向是：mc_craft / mc_chest / mc_furnace / mc_observe → **mc_util** → mc_view-render。
 * 插件加载器只对导出 `apply` 的文件调扩展点（index.js:4278），所以这个文件被 import 时会被安静跳过。
 *
 * 这里只放**跟具体业务无关**的东西；凡是有"合成/熔炼/箱子"语义的一律留在各自扩展里。
 */
import { makePos } from './mc_view-render.mjs'

/** 夹取：`clamp(v, lo, hi)`（参数不是数时按 `Number()` 处理，NaN 落到 lo） */
export const clamp = (v, lo, hi) => Math.min(Math.max(Number(v), lo), hi)

/** 物品 id → 名字（查不到就给 `#id`，方便日志里看出是哪个 id） */
export function itemNameOf (bot, id) {
  const it = bot?.registry?.items?.[id]
  return it?.name ?? `#${id}`
}

/** 物品名 → 物品 id（查不到给 null） */
export function itemIdOf (bot, name) {
  const it = bot?.registry?.itemsByName?.[name]
  return it && typeof it.id === 'number' ? it.id : null
}

/**
 * 方块名 → **方块** id（给 `bot.findBlock({matching:[id]})` 用）。
 * 🔴 1.13+ 物品 id ≠ 方块 id（1.21.10：crafting_table 物品 332 / 方块 205，oak_log 物品 134 / 方块 49），
 * 而 findBlock 比的是 `block.type` —— 拿物品 id 去找永远找不到。
 * 老 registry 没有 blocksByName 时退回物品 id（1.13 以前两者相同）。
 */
export function blockIdOf (bot, name) {
  const b = bot?.registry?.blocksByName?.[name]
  if (b && typeof b.id === 'number') return b.id
  return itemIdOf(bot, name)
}

/**
 * 背包里有几个（`metadata` 给 null = 不看损伤值）。
 * 优先用 mineflayer 自带的 `inventory.count()`；假 bot（离线套件）没有这个方法时
 * 退回自己数 `inventory.items()`（两边的判据都是 `item.type === id`）。
 */
export function countOf (bot, id, metadata = null) {
  if (id == null) return 0
  try {
    const c = bot?.inventory?.count
    if (typeof c === 'function') return c.call(bot.inventory, id, metadata)
  } catch { /* 落到下面的手数 */ }
  try {
    return (bot?.inventory?.items?.() ?? [])
      .filter((it) => it.type === id)
      .reduce((a, it) => a + it.count, 0)
  } catch { return 0 }
}

/** 这一格能放方块吗（和 core.mjs 同判据：不占空间） */
export function canPlaceInto (block) {
  return !!block && block.boundingBox === 'empty'
}

/**
 * 造一个坐标对象给 mineflayer 用。
 * 🔴 必须是**真 Vec3**：`bot.blockAt(pos)` 返回的 block 会把你传进去的那个对象原样挂在 `block.position` 上，
 * 而 mineflayer 后面会调 `block.position.offset(...)`（比如 `bot.craft` 开工作台）——
 * 纯 `{x,y,z}` 会让它炸 `TypeError: block.position.offset is not a function`。
 */
export function vec3Of (bot, x, y, z) {
  const V = bot?.entity?.position?.constructor
  if (typeof V === 'function' && typeof V.prototype?.offset === 'function') {
    try { return new V(x, y, z) } catch { /* 落到下面的兜底 */ }
  }
  const p = makePos()
  p.x = x; p.y = y; p.z = z
  return p
}

/** 用 duck-type 坐标查一个方块（prismarine-world 要 `pos.floored()`，纯 {x,y,z} 会抛） */
export function blockAtXYZ (bot, x, y, z) {
  try {
    return bot.blockAt(vec3Of(bot, Math.floor(x), Math.floor(y), Math.floor(z))) ?? null
  } catch { return null }
}

/**
 * 找一格能放东西的地方（机器人脚那一层的空气、下面垫得住）。
 * 从最近的开始一圈圈往外找 —— 真服里脚边四格常被草/树叶占住，只看四边会白跑一趟。
 * 半径默认 2（McBot.placeBlock 会自己走进 4.5 格内，够得着）。
 */
/**
 * 返回**有序的**候选点位（最好的在前）。
 * 为什么要一串而不是一个：实机（2026-10-08）里"服务端拒了这次放置"并不罕见
 * （目标格被自己占着 / 客户端世界失步 / 站位太靠边），换一个点位再放往往就成了。
 */
export function findPlaceSpots (bot, { radius = 2, limit = 6 } = {}) {
  const p = bot?.entity?.position
  if (!p) return null
  const base = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
  const r = clamp(Number(radius) || 2, 1, 4)
  const seen = new Set()
  const cands = []
  const add = (dx, dz) => {
    if (Math.abs(dx) > r || Math.abs(dz) > r || (!dx && !dz)) return
    const k = dx + ',' + dz
    if (seen.has(k)) return
    seen.add(k)
    cands.push({ x: base.x + dx, y: base.y, z: base.z + dz })
  }
  for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) add(dx, dz) // 先四边（最好用）
  const rest = []
  for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) rest.push({ dx, dz, d: dx * dx + dz * dz })
  rest.sort((a, b) => a.d - b.d) // 再按直线距离补斜角和外圈
  for (const { dx, dz } of rest) add(dx, dz)
  const hasSolidNeighbor = (t) => {
    for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
      const nb = blockAtXYZ(bot, t.x + dx, t.y + dy, t.z + dz)
      if (nb && !canPlaceInto(nb)) return true
    }
    return false
  }
  const placeable = cands.filter((t) => canPlaceInto(blockAtXYZ(bot, t.x, t.y, t.z)))
  // 先找"下面垫得住"的（最自然）；实在没有就找"贴着一面墙/石头"的
  // （悬崖边、树屋、浮空平台上很常见，McBot.placeBlock 也支持贴着侧面放）
  const out = []
  for (const t of placeable) if (!canPlaceInto(blockAtXYZ(bot, t.x, t.y - 1, t.z))) out.push({ x: t.x, y: t.y, z: t.z })
  /* 🔴 审计 G8：第二圈会把第一圈已经收进去的点**再 push 一遍** ⇒ `out` 里出现 [A,B,A]
   *    这种重复，`limit:3` 的调用方（`mc_furnace`）实际只拿到 2 个不同点位。去重。 */
  const added = new Set(out.map((t) => `${t.x},${t.y},${t.z}`))
  for (const t of placeable) {
    const k = `${t.x},${t.y},${t.z}`
    if (added.has(k)) continue
    if (hasSolidNeighbor(t)) { added.add(k); out.push({ x: t.x, y: t.y, z: t.z }) }
  }
  const lim = clamp(Number(limit) || 6, 1, 16)
  return out.slice(0, lim)
}

/** 只要"最好的那一个"点位（多数调用方用这个）。 */
export function findPlaceSpot (bot, { radius = 2 } = {}) {
  /* 🔴 审计 G3：`findPlaceSpots()` 在拿不到 bot 坐标时**回 null**，旧写法直接 `[0]`
   *    ⇒ `TypeError: Cannot read properties of null (reading '0')`，
   *    而调用方（mc_craft / mc_furnace / mc_chest）只想拿到"没有点位"这一个答案。 */
  const spots = findPlaceSpots(bot, { radius, limit: 1 })
  return spots ? (spots[0] ?? null) : null
}
