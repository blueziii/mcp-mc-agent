/**
 * 方块名 → 类别 / 字符 / 颜色（**纯函数**，路线图第 ④ 条第二刀）。
 *
 * 这一刀搬的是"只认字符串"的那一层：给一个方块名，判断它是不是空气 / 液体 / 能穿过去，
 * 以及给地形图挑一个字符和颜色。它们**没有 `this`、没有事件、没有异步、不碰 mineflayer**，
 * 所以能安全地搬出 `core.mjs`；`core.mjs` 里保留同名导出
 * （`export { glyphOf } from './block-names.mjs'`），外部 import 一行都不用改。
 *
 * 迁移规矩（与 `src/format.mjs` 头注释一致）：
 *   1. 一次只搬一个模块；
 *   2. 搬完立刻 `node --check` + 把 `core.mjs` 导入一遍，确认导出还在、行为没变；
 *   3. **移动和挖掘最后再拆** —— `#walkPathfinder()` / `dig()` 共享 `_moveGen`（移动编号）、
 *      `_ctrlLease`（控制位租约）、11 秒预算和一堆事件监听，是最容易"拆完看着没事、跑起来才怪"的部分。
 */

export const isAir = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'
export const isLiquid = (n) => n === 'water' || n === 'lava' || /_water$|_lava$/.test(String(n ?? ''))

/**
 * 能"穿过去"的小东西（花草火把之类）—— 洞穴层图里**不算墙**（否则一张图全是 `#`）。
 * 注意：树叶**不在**这里（它挡视线、也算地形），但在 `SOFT_ROOF` 里（头顶有树不算"在地下"）。
 */
export const PASSABLE = /^(air|cave_air|void_air|short_grass|tall_grass|fern|large_fern|dead_bush|snow|vine|glow_lichen|torch|wall_torch|soul_torch|soul_wall_torch|redstone_torch|lantern|soul_lantern|chain|rail|powered_rail|detector_rail|activator_rail|redstone_wire|tripwire|tripwire_hook|lever|lily_pad|scaffolding|string|cobweb|ladder|light)$|_sapling$|_flower$|_carpet$|^carpet$|_sign$|^sign$|_banner$|^banner$|_button$|_pressure_plate$/
export const isPassable = (n) => Boolean(n) && PASSABLE.test(String(n))

/** 头顶有这些东西**不算**"在地下"（树冠、竹子、雪层…）：站在树下 / 竹林里看地表图更有用 */
export const SOFT_ROOF = /_leaves$|_log$|_wood$|^bamboo|^snow|_snow$|cactus|^moss|^melon|^pumpkin|_sapling$|_flower$|^vine$|glow_lichen|^hanging_roots$|^big_dripleaf/

/**
 * 洞穴层视图的**合成方块名 → 字符**（`heightmap({ mode:'cave' })` 用，见 `core.mjs` 的 `#caveCell`）。
 * 地表图是"这格地表是什么方块"，洞穴图是"这格能不能走、脚下有没有地面"，所以另起一套字形。
 */
export const CAVE_GLYPH = {
  cave_wall: '#', cave_open: '·', cave_step: '↓', cave_drop: 'v',
  cave_water: '~', cave_lava: '≈', cave_ore: '*', cave_void: '?', cave_deep: 'V',
}

/** 洞穴层视图的中文标签（图例 / 文案用） */
export const CAVE_LABEL = {
  cave_wall: '墙', cave_open: '能站', cave_step: '低一格', cave_drop: '会掉下去',
  cave_water: '水', cave_lava: '岩浆', cave_ore: '矿石', cave_void: '未加载', cave_deep: '探不到底',
}

/**
 * **"脚下方块那一层"（地板层视图）**的合成名 → 字符（2026-10-15 用户需求）。
 *
 * 和洞穴层视图（`CAVE_GLYPH`）的区别：洞穴图问"我站在这格行不行"（以我**脚下那层**为中心
 * 往上下看），地板图问"**这一层本身**是什么、站上去会不会掉"。两者判据不同，所以另起一套键。
 */
export const FLOOR_GLYPH = {
  floor_walk: '·', floor_wall: '#', floor_drop: 'v',
  floor_water: '~', floor_lava: '≈', floor_void: '?',
}

/** 地板层视图的中文标签 */
export const FLOOR_LABEL = {
  floor_walk: '能站', floor_wall: '墙', floor_drop: '会掉下去',
  floor_water: '水', floor_lava: '岩浆', floor_void: '未加载',
}

/**
 * 这块方块算不算**实心、能托住我**。
 *
 * 🔴 与 `isPassable()` 互补但**不等价**：`isPassable` 只认花草火把那类小东西，
 *    水和岩浆在它眼里同样"不可穿过" —— 所以液体必须单独排掉，否则岩浆会被当成地板。
 * 判据只用方块名（与这个文件里其它判据一致），不依赖 `boundingBox`
 * （`check-core-map.mjs` 的假方块就只有 `name`）。
 */
export const isSolidBlock = (n) => Boolean(n) && !isAir(n) && !isLiquid(n) && !isPassable(n)

/** 方块名 → 单字符（给没有视觉的模型"看"地形） */
export function glyphOf (name) {
  if (!name) return '?'
  if (CAVE_GLYPH[name]) return CAVE_GLYPH[name]
  if (FLOOR_GLYPH[name]) return FLOOR_GLYPH[name]
  if (isAir(name)) return ' '
  if (/_water$|water|_ice$|^ice$/.test(name)) return '~'
  if (/sand/.test(name)) return '.'
  if (/_leaves$|grass_block|short_grass|tall_grass|_flower|fern|bush|cactus|moss/.test(name)) return '"'
  if (/_log$|_wood$|_planks$|fence|door|sign|stairs|slab|bookshelf|crafting_table|chest/.test(name)) return 'T'
  if (/stone|cobble|deepslate|brick|concrete|terracotta|copper|iron|gold|diamond|obsidian|quartz|purpur|anvil|enchant/.test(name)) return ':'
  /* 🔴 2026-10-15 审计：这里原来还写了 `quartz|iron_block`，但上一行已经先匹配 `quartz` 和
   *    `iron` 并返回 `':'` ⇒ 那两个分支永远不可达。删掉，别再让读的人以为它们会走到。 */
  if (/snow|white_|glass/.test(name)) return '#'
  if (/dirt|podzol|mud|gravel|clay|farmland|wheat|carrot|potato|beetroot/.test(name)) return '_'
  return '+'
}

export const COLORS = {
  // 洞穴层视图（`mode:'cave'`）：能走 = 亮，墙 = 暗，掉下去 = 偏蓝，水/岩浆/矿石各自一色
  cave_wall: [95, 95, 100], cave_open: [205, 205, 195], cave_step: [165, 165, 150],
  cave_drop: [125, 125, 175], cave_water: [51, 76, 178], cave_lava: [222, 110, 40],
  cave_ore: [190, 155, 70], cave_void: [40, 40, 48], cave_deep: [70, 55, 90],
  // 地板层视图（`mode:'floor'`，2026-10-15）：能站 = 亮，墙 = 暗，掉下去 = 偏蓝
  floor_walk: [205, 205, 195], floor_wall: [95, 95, 100], floor_drop: [125, 125, 175],
  floor_water: [51, 76, 178], floor_lava: [222, 110, 40], floor_void: [40, 40, 48],
  grass_block: [106, 170, 64], dirt: [134, 96, 67], sand: [219, 207, 163], suspicious_sand: [200, 185, 140],
  sandstone: [216, 203, 155], smooth_sandstone: [214, 200, 150], stone: [125, 125, 125], cobblestone: [110, 110, 110],
  water: [51, 76, 178], ice: [160, 180, 240], snow_block: [250, 250, 250], oak_log: [110, 84, 50],
  oak_leaves: [60, 120, 45], oak_planks: [162, 130, 78], glass: [200, 220, 230], farmland: [110, 80, 50],
  wheat: [190, 180, 90], bricks: [150, 97, 83], bookshelf: [140, 110, 70], obsidian: [30, 20, 45],
}

export function colorOf (name) {
  if (!name) return [70, 20, 90]
  if (COLORS[name]) return COLORS[name]
  if (/_water$/.test(name)) return [51, 76, 178]
  if (/_leaves$/.test(name)) return [55, 115, 45]
  if (/_log$|_wood$/.test(name)) return [105, 80, 48]
  if (/_planks$/.test(name)) return [162, 130, 78]
  if (/_sand/.test(name)) return [219, 207, 163]
  if (/_concrete$/.test(name)) return [160, 160, 160]
  if (/_wool$/.test(name)) return [220, 220, 220]
  if (/_ore$/.test(name)) return [125, 125, 125]
  if (/stone|cobble|deepslate|brick/.test(name)) return [120, 120, 120]
  return [150, 150, 150]
}
/** 路线图第 ④ 条第八刀：把"右键交互判据 + 能不能放方块"搬进来（都是纯方块名/方块对象判据，2026-10-08） */

/** 右键能**打开窗口**的方块（`use` 之后窗口该出现，这就是"交互成功"的硬证据） */
export const CONTAINER_RE = /chest|barrel|shulker_box|furnace|smoker|hopper|dispenser|dropper|brewing_stand|enchanting_table|anvil|grindstone|smithing_table|loom|cartography_table|stonecutter|crafting_table|beacon|lectern|fletching_table|respawn_anchor|decorated_pot|chiseled_bookshelf|crafter/i

/** 右键会**翻转状态**的方块（门/活板门/栅栏门/按钮/拉杆）—— 可以复核状态有没有变 */
export const TOGGLE_RE = /(_door|_trapdoor|fence_gate|button|lever)$/i

/**
 * 这个位置**能不能放方块进去**（= 该方块不占空间 / 是可替换物）。
 *
 * 判据用 `boundingBox === 'empty'`，**不是**"名字是不是 air"。
 * 旧版只认 air/cave_air/void_air，2026-09-15 用真实 minecraft-data(26.2) 实测发现漏了一大片：
 *   ✅ air / cave_air / void_air   → 'empty'
 *   ✅ **water / lava**             → 'empty'  ← 旧版这里直接失败，**水里建不了东西**（码头/桥全废）
 *   ✅ 草/花/蕨/雪/藤蔓/海草/海带/气泡柱/火把/火/树苗/地毯/铁轨 → 'empty'
 *   ❌ 石头/木板/台阶/楼梯/土径      → 'block'  （正确拒绝）
 * ⚠️ 未加载（blockAt 返回 null）**不算可放** —— 不能盲放。
 */
export const canPlaceInto = (blk) => {
  if (!blk) return false
  if (blk.boundingBox === 'empty') return true
  return isAir(blk.name) || isLiquid(blk.name)     // 兜底：个别版本 boundingBox 可能不准
}
