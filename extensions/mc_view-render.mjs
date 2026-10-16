/**
 * mc_view-render —— 第一人称体素渲染内核（纯函数、零依赖、不 import 任何包）
 *
 * 只吃两样东西：
 *   · `world.getBlock(pos)`：prismarine-world 就是；pos 必须带 `floored()`（见 makePos）。
 *     未加载区块返回 null。
 *   · 眼睛坐标 + yaw/pitch。
 *
 * 画出来的东西（尽量接近"真的在看屏幕"）：
 *   ① 方块：DDA 体素步进 + 每个方块类型一套**程序化贴图**（草皮、木板纹、原木年轮、
 *      树叶窟窿、矿石斑点、砖缝、水波、岩浆结壳…），不是纯色块。
 *   ② 光照：面明暗（顶 1.0 / 南北 0.8 / 东西 0.6 / 底 0.5）+ 体素 AO（相邻方块在角上压暗）
 *      + 朝阳面微亮 + 距离雾（雾色跟着天空变）+ 发光方块不吃雾。
 *   ③ 天空：随 `time`（0..24000）走的昼夜 —— 太阳/月亮圆盘、晚霞、云层（世界坐标噪声，
 *      转头时云会正确地平移）、夜里出星星；下界/末地另有一套天空色。
 *   ④ 实体：玩家画成人形（头/身/手/腿 + 眼睛），怪物画成四足/方块生物，掉落物画成小方块，
 *      带黑色描边；被方块挡住的像素不画（有深度缓冲）。玩家的配色由名字哈希决定，
 *      文字摘要里给出"谁是什么颜色"，对着图就能认人。
 *   ⑤ 手里拿着的东西（右下角手臂 + 手持方块的颜色）。
 *   ⑥ 准星（中心留空一格）、未加载区块（暗紫，不是方块）。
 *
 * 坐标约定（和 mineflayer 一致）：
 *   yaw=0 看 -Z（北）、yaw=π/2 看 -X（西）、yaw=π 看 +Z（南）、yaw=3π/2 看 +X（东）；
 *   pitch>0 抬头。眼高默认 1.62。
 *
 * @returns renderView() → { rgba, stats, center, camera, entities }
 */

export const VIEW_DEFAULTS = {
  width: 192,
  height: 108,
  fov: 70,
  distance: 48,
  crosshair: true,
  fogStart: 0.72,
  eyeHeight: 1.62,
  maxSteps: 512,
  texture: true,
  ao: true,
  sky: true,
  entities: true,
  hand: true,
}

/* ───────────────────────────── 小工具 ───────────────────────────── */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v)
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0)

/** 32 位确定性哈希 → [0,1) */
function hash3 (x, y, z, s = 0) {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 1442695041) ^ Math.imul(s | 0, 2246822519)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
const hash2 = (x, y, s = 0) => hash3(x, y, 0, s)

/** 双线性平滑的 value noise（云、噪声斑块用） */
function valueNoise2 (x, y, s = 0) {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const n00 = hash2(x0, y0, s)
  const n10 = hash2(x0 + 1, y0, s)
  const n01 = hash2(x0, y0 + 1, s)
  const n11 = hash2(x0 + 1, y0 + 1, s)
  const a = n00 + (n10 - n00) * sx
  const b = n01 + (n11 - n01) * sx
  return a + (b - a) * sy
}

const mixC = (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
const scaleC = (c, k) => [c[0] * k, c[1] * k, c[2] * k]
const hex = (c) => '#' + c.map((v) => clamp255(v).toString(16).padStart(2, '0')).join('')

/* ─────────────────────── 调色板 + 程序化贴图 ─────────────────────── */

/** 矿石的亮点色（贴在石头底色上） */
const ORE_ACCENT = [
  [/diamond_ore/, [110, 232, 235]],
  [/emerald_ore/, [74, 222, 122]],
  [/lapis_ore/, [62, 112, 222]],
  [/redstone_ore/, [222, 62, 52]],
  [/coal_ore/, [42, 42, 46]],
  [/iron_ore/, [216, 180, 150]],
  [/gold_ore/, [250, 216, 82]],
  [/copper_ore/, [230, 150, 92]],
  [/quartz_ore/, [242, 236, 226]],
  [/ancient_debris/, [156, 112, 96]],
]

/**
 * 方块规则表。**顺序敏感**：越具体的排越前。
 * color=基础色；side/top/bottom=按面覆盖（草方块侧面是土、原木顶面是年轮）；
 * pattern=程序化贴图名；accent=矿石亮点；emissive=发光（不吃雾）；glass=透明（射线穿过去）。
 */
const RULES = [
  { re: /lava/, color: [255, 138, 32], pattern: 'lava', emissive: true },
  { re: /^(torch|wall_torch|soul_torch|soul_wall_torch)$/, color: [255, 214, 130], pattern: 'glow', emissive: true },
  { re: /(lantern|glowstone|shroomlight|sea_lantern|redstone_lamp|beacon|end_rod|jack_o_lantern|campfire|froglight|crying_obsidian|magma_block|respawn_anchor|amethyst_cluster|sculk_catalyst|sculk_shrieker)/, color: [255, 212, 132], pattern: 'glow', emissive: true },
  { re: /(glass_pane|tinted_glass|^glass$|_glass$)/, color: [186, 226, 236], pattern: 'glass', glass: true, alpha: 0.26 },
  { re: /(packed_ice|blue_ice|frosted_ice|^ice$)/, color: [168, 210, 255], pattern: 'ice', glass: true, alpha: 0.34 },
  { re: /water/, color: [58, 110, 214], pattern: 'water' },
  { re: /redstone_block/, color: [198, 40, 30], pattern: 'noise' },
  { re: /(redstone_wire|redstone_torch|redstone_repeater|redstone_comparator)/, color: [188, 52, 40], pattern: 'noise' },
  { re: /_ore$/, color: [130, 130, 132], pattern: 'ore', accent: [235, 235, 235] },
  { re: /grass_block/, color: [104, 168, 78], side: [136, 98, 66], bottom: [136, 98, 66], pattern: 'grass', sidePattern: 'dirt' },
  { re: /(mycelium|podzol)/, color: [122, 100, 92], side: [110, 82, 58], bottom: [110, 82, 58], pattern: 'dirt' },
  { re: /(dirt|rooted_dirt|coarse_dirt|mud)/, color: [134, 96, 67], pattern: 'dirt' },
  { re: /farmland/, color: [126, 88, 58], pattern: 'dirt' },
  { re: /(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_log/, color: [96, 74, 50], top: [172, 138, 96], bottom: [172, 138, 96], pattern: 'bark', topPattern: 'rings' },
  { re: /(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|crimson|warped)_(wood|hyphae)/, color: [96, 74, 50], pattern: 'bark' },
  { re: /_planks$/, color: [162, 130, 78], pattern: 'planks' },
  { re: /_leaves$/, color: [72, 130, 58], pattern: 'leaves' },
  { re: /(cobblestone|mossy_cobblestone)/, color: [126, 126, 126], pattern: 'cobble' },
  { re: /cobbled_deepslate/, color: [84, 84, 88], pattern: 'cobble' },
  { re: /(andesite|stone|smooth_stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|chiseled_stone_bricks)/, color: [128, 128, 128], pattern: 'stone' },
  { re: /(granite)/, color: [154, 108, 90], pattern: 'stone' },
  { re: /(diorite|calcite)/, color: [206, 206, 208], pattern: 'stone' },
  { re: /(deepslate|tuff|basalt|smooth_basalt)/, color: [82, 82, 86], pattern: 'stone' },
  { re: /(blackstone|polished_blackstone)/, color: [52, 46, 52], pattern: 'stone' },
  { re: /(obsidian)/, color: [22, 18, 32], pattern: 'noise' },
  { re: /(netherrack|crimson_nylium|warped_nylium)/, color: [124, 54, 54], pattern: 'blotch' },
  { re: /(soul_sand|soul_soil)/, color: [92, 74, 62], pattern: 'dirt' },
  { re: /end_stone/, color: [220, 218, 158], pattern: 'blotch' },
  { re: /(red_sand|^sand$)/, color: [220, 208, 154], pattern: 'sand' },
  { re: /(gravel)/, color: [132, 128, 126], pattern: 'blotch' },
  { re: /clay/, color: [160, 166, 178], pattern: 'noise' },
  { re: /(red_sandstone|sandstone)/, color: [216, 202, 150], pattern: 'sandstone' },
  { re: /(snow|powder_snow)/, color: [246, 248, 250], pattern: 'snow' },
  { re: /(brick)/, color: [150, 78, 62], pattern: 'brick' },
  { re: /(bookshelf)/, color: [140, 112, 70], pattern: 'books' },
  { re: /(iron_block|iron_bars|anvil|cauldron|hopper|lodestone)/, color: [216, 216, 216], pattern: 'metal' },
  { re: /(gold_block|raw_gold_block)/, color: [246, 214, 84], pattern: 'metal' },
  { re: /(diamond_block)/, color: [96, 226, 222], pattern: 'metal' },
  { re: /(emerald_block)/, color: [70, 214, 118], pattern: 'metal' },
  { re: /(netherite_block)/, color: [70, 62, 64], pattern: 'metal' },
  { re: /(copper_block|exposed_copper|weathered_copper|oxidized_copper)/, color: [206, 132, 96], pattern: 'metal' },
  { re: /(raw_iron_block)/, color: [186, 158, 132], pattern: 'blotch' },
  { re: /(wool|_carpet$)/, color: [228, 228, 228], pattern: 'wool' },
  { re: /concrete_powder/, color: [200, 200, 200], pattern: 'sand' },
  { re: /concrete/, color: [190, 190, 190], pattern: 'flat' },
  { re: /terracotta/, color: [152, 94, 68], pattern: 'noise' },
  { re: /(bed$|_bed$)/, color: [176, 40, 44], pattern: 'wool' },
  { re: /(chest|barrel|crafting_table|furnace|smoker|blast_furnace|lectern|cartography_table|loom|smithing_table|stonecutter|composter|beehive|bee_nest)/, color: [150, 116, 70], pattern: 'planks' },
  { re: /(door|trapdoor|fence|gate|ladder|scaffolding|sign|rail|torchflower|lever|button|pressure_plate)/, color: [150, 118, 74], pattern: 'planks' },
  { re: /(pumpkin|melon)/, color: [222, 148, 40], pattern: 'blotch' },
  { re: /(hay_block)/, color: [200, 170, 60], pattern: 'hay' },
  { re: /(cactus)/, color: [80, 140, 62], pattern: 'noise' },
  { re: /(sponge|wet_sponge)/, color: [214, 208, 96], pattern: 'blotch' },
  { re: /(moss_block|moss_carpet|vine|glow_lichen)/, color: [92, 132, 58], pattern: 'leaves' },
  { re: /(sapling|_flower|flowering_azalea|azalea|fern|short_grass|tall_grass|_bush|seagrass|kelp|wheat|carrots|potatoes|beetroots|sugar_cane|bamboo|lily_pad|crop)/, color: [96, 156, 66], pattern: 'plant' },
  { re: /(sculk|sculk_vein)/, color: [36, 52, 62], pattern: 'blotch' },
  { re: /(slime_block|honey_block)/, color: [140, 200, 120], pattern: 'flat' },
  { re: /(prismarine|sea_lantern|dark_prismarine)/, color: [96, 168, 158], pattern: 'stone' },
  { re: /(purpur|chorus)/, color: [168, 120, 168], pattern: 'stone' },
  { re: /(quartz)/, color: [236, 232, 222], pattern: 'stone' },
]

const FALLBACK_RULE = { color: [150, 150, 150], pattern: 'noise' }

const ruleCache = new Map()
export function ruleOf (name) {
  const key = name ?? ''
  const hit = ruleCache.get(key)
  if (hit !== undefined) return hit
  let rule = FALLBACK_RULE
  for (const r of RULES) {
    if (r.re.test(key)) { rule = r; break }
  }
  if (rule.pattern === 'ore') {
    for (const [re, accent] of ORE_ACCENT) {
      if (re.test(key)) { rule = { ...rule, accent }; break }
    }
  }
  ruleCache.set(key, rule)
  return rule
}

/** 兼容旧接口：基础色 */
export function colorOf (name) {
  return ruleOf(name).color
}

export const isAirName = (n) => n === 'air' || n === 'cave_air' || n === 'void_air'
export const isWaterName = (n) => typeof n === 'string' && /water/.test(n)
export const isLavaName = (n) => n === 'lava'
export const isGlassName = (n) => ruleOf(n).glass === true
export const isEmissiveName = (n) => ruleOf(n).emissive === true

/** 面 + 局部坐标 → 该像素的**未打光**颜色（含程序化贴图） */
export function patternPixel (rule, axis, step, u, v, bx, by, bz) {
  // 先决定这一面的基础色（草方块侧面是土、原木顶面是年轮）
  let base = rule.color
  let pattern = rule.pattern
  if (axis === 1) {
    if (step < 0 && rule.top) { base = rule.top; pattern = rule.topPattern ?? pattern }
    else if (step > 0 && rule.bottom) { base = rule.bottom; pattern = rule.bottomPattern ?? pattern }
  } else if (rule.side) {
    base = rule.side
    pattern = rule.sidePattern ?? pattern
  }

  const px = Math.floor(u * 16)
  const py = Math.floor(v * 16)
  let k = 1
  switch (pattern) {
    case 'grass': {
      const n = hash2(px, py, 7)
      k = 0.9 + n * 0.2
      if (n < 0.16) k *= 0.86
      base = mixC(base, [150, 196, 84], hash2(px >> 1, py >> 1, 71) * 0.35)
      break
    }
    case 'dirt': {
      k = 0.9 + hash2(px, py, 3) * 0.2
      if (hash2(px >> 2, py >> 2, 23) < 0.22) k *= 0.86
      break
    }
    case 'stone': {
      k = 0.9 + hash2(px >> 1, py >> 1, 11) * 0.16 + hash2(px, py, 12) * 0.06
      break
    }
    case 'cobble': {
      const n = hash2(px >> 2, py >> 2, 9)
      k = 0.84 + n * 0.3
      if ((px & 7) === 0 || (py & 7) === 0) k *= 0.9
      break
    }
    case 'blotch': {
      k = 0.86 + valueNoise2(bx * 4 + px / 4, bz * 4 + py / 4, 5) * 0.28
      k *= 0.96 + hash2(px, py, 6) * 0.08
      break
    }
    case 'sand': {
      k = 0.95 + hash2(px, py, 13) * 0.09
      break
    }
    case 'sandstone': {
      k = 0.95 + hash2(px, py, 14) * 0.07
      if (Math.floor(v * 16) % 6 === 0) k *= 0.9
      break
    }
    case 'planks': {
      k = 0.94 + hash2(px, py, 15) * 0.1
      if (Math.floor(v * 16) % 8 === 0) k *= 0.85
      k *= 0.97 + 0.06 * Math.sin(u * 12 + bx)
      break
    }
    case 'bark': {
      k = 0.9 + hash2(px, py, 17) * 0.14
      if (Math.floor(u * 16) % 7 === 0) k *= 0.84
      break
    }
    case 'rings': {
      const du = u - 0.5
      const dv = v - 0.5
      const r = Math.sqrt(du * du + dv * dv)
      k = 0.94 + hash2(px, py, 18) * 0.1
      if (Math.floor(r * 26) % 3 === 0) k *= 0.88
      break
    }
    case 'leaves': {
      const n = hash2(px, py, 3)
      k = n < 0.26 ? 0.66 : 0.92 + n * 0.16
      base = mixC(base, [128, 172, 62], hash2(px >> 1, py >> 1, 19) * 0.3)
      break
    }
    case 'water': {
      const w = Math.sin(u * 9 + v * 4 + (bx + bz) * 0.7) + 0.5 * Math.sin(u * 21 - v * 13)
      k = 0.93 + 0.07 * w
      if (hash2(px >> 1, py >> 1, 17) > 0.93) k *= 1.08
      break
    }
    case 'lava': {
      const n = valueNoise2(bx * 3 + px / 5, bz * 3 + py / 5, 21)
      k = 0.82 + n * 0.4
      if (n < 0.34) { k *= 0.6; base = mixC(base, [120, 30, 10], 0.5) }
      break
    }
    case 'glow': {
      k = 0.95 + hash2(px, py, 29) * 0.12
      break
    }
    case 'ice': {
      k = 0.94 + hash2(px, py, 43) * 0.12
      if (Math.floor(u * 16) % 9 === 0) k *= 1.1
      break
    }
    case 'glass': {
      k = 1
      if (px === 0 || py === 0 || px === 15 || py === 15) k = 1.16
      break
    }
    case 'ore': {
      const n = hash2(px >> 1, py >> 1, 31)
      k = 0.9 + hash2(px, py, 32) * 0.12
      if (n < 0.34) return scaleC(rule.accent ?? [235, 235, 235], 0.92 + hash2(px, py, 33) * 0.16)
      break
    }
    case 'brick': {
      k = 0.96 + hash2(px, py, 35) * 0.07
      if (py % 5 === 0) k *= 0.82
      if ((px + (Math.floor(py / 5) % 2) * 4) % 8 === 0) k *= 0.82
      break
    }
    case 'books': {
      k = 0.94 + hash2(px, py, 39) * 0.1
      if (py % 7 === 0) k *= 0.86
      if (px < 2 || px > 13) k *= 0.9
      break
    }
    case 'hay': {
      k = 0.92 + hash2(px, py, 44) * 0.12
      if (px % 4 === 0) k *= 0.9
      break
    }
    case 'metal': {
      k = 0.96 + hash2(px >> 1, py >> 1, 37) * 0.08
      break
    }
    case 'wool': {
      k = 0.96 + hash2(px, py, 41) * 0.07
      break
    }
    case 'snow': {
      k = 0.98 + hash2(px, py, 45) * 0.04
      break
    }
    case 'plant': {
      k = 0.9 + hash2(px, py, 47) * 0.2
      break
    }
    case 'flat': {
      k = 0.99 + hash2(px, py, 49) * 0.02
      break
    }
    default: {
      k = 0.94 + hash2(px, py, 5) * 0.12
    }
  }
  return scaleC(base, k)
}

/* ─────────────────────────── 相机 ─────────────────────────── */

export function cameraBasis (yaw, pitch) {
  const sy = Math.sin(yaw)
  const cy = Math.cos(yaw)
  const sp = Math.sin(pitch)
  const cp = Math.cos(pitch)
  const f = [-sy * cp, sp, -cy * cp]
  // r = normalize(cross(f, up))，up=(0,1,0) → (-f.z, 0, f.x)
  let rx = -f[2]
  let rz = f[0]
  const rl = Math.sqrt(rx * rx + rz * rz) || 1
  rx /= rl
  rz /= rl
  // u = cross(r, f)，r=(rx,0,rz)
  const u = [
    0 * f[2] - rz * f[1],
    rz * f[0] - rx * f[2],
    rx * f[1] - 0 * f[0],
  ]
  return { f, r: [rx, 0, rz], u }
}

/** 进入面的明暗系数（近似 MC：顶 1.0 / 南北 0.8 / 东西 0.6 / 底 0.5） */
export function shadeOf (axis, step) {
  if (axis === 1) return step < 0 ? 1 : 0.5
  if (axis === 0) return 0.6
  return 0.8
}

/* ─────────────────────────── 世界 ─────────────────────────── */

/**
 * 传给 `world.getBlock(pos)` 的坐标对象。
 * 真实世界里 `world` 是 prismarine-world，它的 getBlock 会调用 `pos.floored()`
 * （`prismarine-world/src/worldsync.js:102` `block.position = pos.floored()`），
 * 所以**纯 `{x,y,z}` 对象会在真实世界里抛 `pos.floored is not a function`**。
 * 这里 duck-type 一个最小实现：渲染内核不必依赖 vec3，也避免每个方块分配一个 Vec3。
 */
export function makePos () {
  return {
    x: 0,
    y: 0,
    z: 0,
    floored () { return { x: Math.floor(this.x), y: Math.floor(this.y), z: Math.floor(this.z) } },
  }
}

/**
 * 单条射线的 DDA 体素步进。
 * @returns null（没命中=天空）| { unknown:true, dist }（撞到未加载区块）
 *          | { name, dist, axis, step, block, bx, by, bz }（axis: 0=x 1=y 2=z；step: 沿该轴的前进方向）
 */
export function castRay (world, ox, oy, oz, dx, dy, dz, maxDist, scratch, maxSteps = VIEW_DEFAULTS.maxSteps) {
  // 把"几乎为 0"的分量按 0 处理：否则 yaw 正好 ±90° 时 cos(yaw)≈6e-17 会让射线
  // 在第一步就沿另一轴漂一格（tMax≈0），画面出现一格错位。
  const EPS = 1e-12
  if (Math.abs(dx) < EPS) dx = 0
  if (Math.abs(dy) < EPS) dy = 0
  if (Math.abs(dz) < EPS) dz = 0
  let x = Math.floor(ox)
  let y = Math.floor(oy)
  let z = Math.floor(oz)
  const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0
  const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0
  const stepZ = dz > 0 ? 1 : dz < 0 ? -1 : 0
  const invX = dx !== 0 ? Math.abs(1 / dx) : Infinity
  const invY = dy !== 0 ? Math.abs(1 / dy) : Infinity
  const invZ = dz !== 0 ? Math.abs(1 / dz) : Infinity
  let tMaxX = dx !== 0 ? (dx > 0 ? x + 1 - ox : ox - x) * invX : Infinity
  let tMaxY = dy !== 0 ? (dy > 0 ? y + 1 - oy : oy - y) * invY : Infinity
  let tMaxZ = dz !== 0 ? (dz > 0 ? z + 1 - oz : oz - z) * invZ : Infinity
  let axis = -1
  let step = 0
  let t = 0
  const s = scratch ?? makePos()
  for (let i = 0; i < maxSteps; i++) {
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      x += stepX
      t = tMaxX
      tMaxX += invX
      axis = 0
      step = stepX
    } else if (tMaxY <= tMaxZ) {
      y += stepY
      t = tMaxY
      tMaxY += invY
      axis = 1
      step = stepY
    } else {
      z += stepZ
      t = tMaxZ
      tMaxZ += invZ
      axis = 2
      step = stepZ
    }
    if (t > maxDist) return null
    s.x = x
    s.y = y
    s.z = z
    const b = world.getBlock(s)
    if (b === null || b === undefined) return { unknown: true, dist: t }
    const n = b.name
    if (isAirName(n)) continue
    // 花草/藤蔓/红石线等 boundingBox 为空的**非实体**方块穿过去（水/岩浆例外，要停）
    if (b.boundingBox === 'empty' && !isWaterName(n) && !isLavaName(n)) continue
    return { name: n, dist: t, axis, step, block: b, bx: x, by: y, bz: z }
  }
  return null
}

/** 射线 vs 轴对齐盒（slab 法）。返回进入点信息，用于画实体。 */
function rayBox (ox, oy, oz, dx, dy, dz, b, maxDist) {
  let tmin = 0
  let tmax = maxDist
  let axis = -1
  let step = 0
  // x
  if (dx > -1e-12 && dx < 1e-12) {
    if (ox < b.minX || ox > b.maxX) return null
  } else {
    const inv = 1 / dx
    let t1 = (b.minX - ox) * inv
    let t2 = (b.maxX - ox) * inv
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tmin) { tmin = t1; axis = 0; step = dx > 0 ? 1 : -1 }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  // y
  if (dy > -1e-12 && dy < 1e-12) {
    if (oy < b.minY || oy > b.maxY) return null
  } else {
    const inv = 1 / dy
    let t1 = (b.minY - oy) * inv
    let t2 = (b.maxY - oy) * inv
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tmin) { tmin = t1; axis = 1; step = dy > 0 ? 1 : -1 }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  // z
  if (dz > -1e-12 && dz < 1e-12) {
    if (oz < b.minZ || oz > b.maxZ) return null
  } else {
    const inv = 1 / dz
    let t1 = (b.minZ - oz) * inv
    let t2 = (b.maxZ - oz) * inv
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp }
    if (t1 > tmin) { tmin = t1; axis = 2; step = dz > 0 ? 1 : -1 }
    if (t2 < tmax) tmax = t2
    if (tmin > tmax) return null
  }
  if (axis < 0 || tmin <= 0 || tmin > maxDist) return null
  const hx = ox + dx * tmin
  const hy = oy + dy * tmin
  const hz = oz + dz * tmin
  let u
  let v
  if (axis === 0) { u = hz - Math.floor(hz); v = hy - Math.floor(hy) } else if (axis === 1) { u = hx - Math.floor(hx); v = hz - Math.floor(hz) } else { u = hx - Math.floor(hx); v = hy - Math.floor(hy) }
  return { dist: tmin, axis, step, u, v, hx, hy, hz }
}

/** 方块是否"实心"（AO 采样用；水/空气/花草不算） */
function solidAt (world, pos, x, y, z) {
  pos.x = x
  pos.y = y
  pos.z = z
  let b
  try { b = world.getBlock(pos) } catch { return 0 }
  if (!b) return 0
  const n = b.name
  if (!n || isAirName(n)) return 0
  if (b.boundingBox === 'empty' && !isWaterName(n) && !isLavaName(n)) return 0
  return 1
}

/**
 * 体素 AO：面外侧 8 个邻居决定 4 个角的遮蔽度，按像素双线性插值。
 * 结果缓存（同一面只算一次）。
 */
function aoCorners (world, bx, by, bz, axis, step, pos) {
  // 面外侧那一格
  let ox = bx
  let oy = by
  let oz = bz
  if (axis === 0) ox += step
  else if (axis === 1) oy += step
  else oz += step
  // u/v 轴的单位向量
  let eUx = 0
  let eUy = 0
  let eUz = 0
  let eVx = 0
  let eVy = 0
  let eVz = 0
  if (axis === 0) { eUz = 1; eVy = 1 } else if (axis === 1) { eUx = 1; eUz = 1 } else { eUx = 1; eVy = 1 }
  const out = [1, 1, 1, 1]
  let i = 0
  for (let dv = 0; dv <= 1; dv++) {
    for (let du = 0; du <= 1; du++) {
      const su = du ? 1 : -1
      const sv = dv ? 1 : -1
      const s1 = solidAt(world, pos, ox + eUx * su, oy + eUy * su, oz + eUz * su)
      const s2 = solidAt(world, pos, ox + eVx * sv, oy + eVy * sv, oz + eVz * sv)
      const cn = solidAt(world, pos, ox + eUx * su + eVx * sv, oy + eUy * su + eVy * sv, oz + eUz * su + eVz * sv)
      /* 审计 G11：这个数**越大越开阔**（两侧都实心时 = 0 = 最暗；周围全空 = 3 = 最亮），
       * 所以叫 `openness` 才不误导 —— 原来叫 `occ`（occlusion 遮挡）语义正好是反的。
       * 算式一个字没动。 */
      const openness = (s1 && s2) ? 0 : 3 - (s1 + s2 + cn)
      out[i++] = 1 - 0.3 * (3 - openness) / 3
    }
  }
  return out
}

/* ─────────────────────────── 天空 ─────────────────────────── */

const SKY_DAY_HORIZON = [206, 226, 255]
const SKY_DAY_ZENITH = [104, 152, 252]
const SKY_NIGHT_HORIZON = [16, 20, 44]
const SKY_NIGHT_ZENITH = [5, 7, 22]
const SKY_SUNSET = [252, 156, 92]
const CLOUD_LIGHT = [252, 252, 255]
const CLOUD_DARK = [178, 186, 204]

/** 由世界时间（0..24000）算出太阳方向与亮度 */
export function sunOf (time) {
  const t = ((Number(time) || 0) % 24000 + 24000) % 24000
  const a = (t / 24000) * Math.PI * 2
  const sun = [Math.cos(a), Math.sin(a), 0]
  const daylight = clamp01((sun[1] + 0.2) / 0.55) * 0.85 + 0.15
  const sunset = clamp01(1 - Math.abs(sun[1]) / 0.3)
  return { sun, daylight, sunset, ticks: t }
}

function skyColor (dx, dy, dz, sky, pc) {
  const { sun, daylight, sunset } = sky
  /* 🔴 报告 H13（2026-10-13）：`pc.dimension` 是从 `bot.game.dimension` 来的**完整标识符**
   *    （`minecraft:the_nether` / `minecraft:the_end`），而这里以前拿 `'nether'` / `'end'` 比
   *    ⇒ 下界和末地的天空永远走不到这两支（一直是主世界的颜色）。本文件 `:1071` 的文档
   *    写的就是 `'the_nether'` / `'the_end'`。这里统一剥掉 `minecraft:` 前缀，两种写法都认。 */
  const dim = String(pc.dimension ?? '').replace(/^minecraft:/, '')
  if (dim === 'nether' || dim === 'the_nether') {
    const haze = 0.55 + 0.45 * clamp01(dy + 0.4)
    return [118 * haze + 40, 26 * haze + 8, 20 * haze + 6]
  }
  if (dim === 'end' || dim === 'the_end') {
    const haze = 0.6 + 0.4 * clamp01(dy + 0.3)
    return [42 * haze + 12, 30 * haze + 10, 58 * haze + 16]
  }
  let base = mixC(scaleC(SKY_NIGHT_HORIZON, 1), SKY_DAY_HORIZON, daylight)
  const zen = mixC(scaleC(SKY_NIGHT_ZENITH, 1), SKY_DAY_ZENITH, daylight)
  const t = clamp01((dy + 1) / 2)
  let c = mixC(base, zen, t * t)
  // 晚霞：靠近太阳那一侧的地平线发橙
  if (sunset > 0.01) {
    const toward = clamp01((dx * sun[0] + dz * sun[2]) * 0.5 + 0.5)
    const low = clamp01(1 - Math.abs(dy) / 0.45)
    c = mixC(c, SKY_SUNSET, sunset * low * toward * 0.75)
  }
  // 星星（夜里；稀疏一点，避免天空发麻）
  if (daylight < 0.42 && dy > 0.03) {
    const n = hash3(Math.floor(dx * 190), Math.floor(dy * 190), Math.floor(dz * 190), 77)
    if (n > 0.9994) {
      const tw = 0.5 + 0.5 * hash3(Math.floor(dx * 190), Math.floor(dy * 190), 0, 78)
      c = mixC(c, [255, 255, 255], (1 - daylight / 0.42) * tw)
    }
  }
  // 云层：世界坐标上的噪声，位于 cloudY 高度；转头时云会正确平移
  if (dy > 0.06) {
    const cloudY = 192
    const t2 = (cloudY - pc.oy) / dy
    if (t2 > 0 && t2 < 420) {
      const cxp = pc.ox + dx * t2
      const czp = pc.oz + dz * t2
      const n = valueNoise2(cxp / 46, czp / 46, 91) * 0.66 + valueNoise2(cxp / 19, czp / 19, 92) * 0.34
      const cover = 0.52 - (1 - daylight) * 0.06
      if (n > cover) {
        // 靠近地平线的云淡出，否则采样会 aliasing 成雪花
        const horizonFade = clamp01((dy - 0.06) / 0.16)
        const a = clamp01((n - cover) / 0.16) * horizonFade
        const lit = clamp01(0.45 + 0.55 * clamp01(dy + 0.25))
        const cc = mixC(scaleC(CLOUD_DARK, daylight), CLOUD_LIGHT, lit)
        c = mixC(c, cc, a * 0.92)
      }
    }
  }
  // 太阳 / 月亮
  const sd = dx * sun[0] + dy * sun[1] + dz * sun[2]
  if (sd > 0.965) {
    const edge = clamp01((sd - 0.965) / 0.035)
    c = mixC(c, [255, 246, 214], Math.min(1, edge * 2.2) * clamp01(daylight + 0.25))
  } else if (sd > 0.86) {
    c = mixC(c, [255, 228, 176], (sd - 0.86) / 0.105 * 0.35 * clamp01(daylight))
  }
  const md = -sd
  if (md > 0.992) {
    c = mixC(c, [226, 232, 246], clamp01((md - 0.992) / 0.008) * clamp01(1.3 - daylight))
  }
  return c
}

/* ─────────────────────────── 实体 ─────────────────────────── */

const CLOTHES = [
  [86, 132, 214], [206, 82, 92], [92, 178, 108], [214, 158, 62], [162, 108, 206],
  [72, 186, 190], [222, 116, 176], [140, 140, 152],
]
const HOSTILE = /(zombie|skeleton|spider|creeper|witch|enderman|endermite|blaze|ghast|slime|magma_cube|piglin|hoglin|zoglin|wither|guardian|shulker|phantom|drowned|husk|stray|pillager|vindicator|evoker|ravager|silverfish|vex|warden|breeze|bogged|illager|giant|illusioner|ender_dragon)/
const PASSIVE = /(cow|pig|sheep|chicken|horse|donkey|mule|rabbit|wolf|cat|ocelot|fox|parrot|llama|goat|frog|tadpole|axolotl|bee|turtle|panda|polar_bear|camel|sniffer|armadillo|allay|villager|wandering_trader|golem|mooshroom|strider|squid|dolphin|bat|nautilus|fish|cod|salmon|pufferfish|tropical_fish)/
const SKIN = [228, 178, 148]

/**
 * 给实体挑"造型 + 配色"。
 * @param ent { type, name, displayName, username, kind, id }
 */
export function entityStyle (ent) {
  const type = String(ent?.type ?? '').toLowerCase()
  const kind = String(ent?.kind ?? '').toLowerCase()
  const nm = String(ent?.name ?? ent?.displayName ?? '').toLowerCase()
  const uname = ent?.username ? String(ent.username) : ''
  if (type === 'player' || uname || /player/.test(kind)) {
    const h = Math.abs([...(uname || String(ent?.id ?? ''))].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))
    const cloth = CLOTHES[h % CLOTHES.length]
    return { shape: 'player', label: uname || '玩家', color: cloth, pants: scaleC(cloth, 0.42), skin: SKIN }
  }
  if (type === 'mob') {
    if (HOSTILE.test(nm)) return { shape: 'mob', label: ent?.name ?? '怪物', color: [214, 74, 74], hostile: true, skin: [188, 96, 82] }
    if (PASSIVE.test(nm)) return { shape: 'mob', label: ent?.name ?? '动物', color: [226, 202, 108], hostile: false, skin: [236, 226, 210] }
    return { shape: 'mob', label: ent?.name ?? '生物', color: [176, 146, 206], hostile: false, skin: [210, 200, 220] }
  }
  if (type === 'orb') return { shape: 'item', label: '经验球', color: [196, 244, 120] }
  if (type === 'object') return { shape: 'item', label: ent?.displayName ?? ent?.name ?? '物体', color: [232, 232, 238] }
  return { shape: 'item', label: ent?.displayName ?? ent?.name ?? '实体', color: [255, 176, 64] }
}

/** 实体的世界包围盒（position 是脚底，x/z 居中） */
export function entityBoxOf (ent) {
  if (!ent || ent.x == null || ent.y == null || ent.z == null) return null
  const w = Math.max(0.25, Number(ent.width) || 0.6)
  const h = Math.max(0.25, Number(ent.height) || 1.8)
  const hw = w / 2
  return {
    minX: ent.x - hw, maxX: ent.x + hw,
    minY: ent.y, maxY: ent.y + h,
    minZ: ent.z - hw, maxZ: ent.z + hw,
    cx: ent.x, cy: ent.y + h / 2, cz: ent.z,
  }
}

/* ── 实体朝向与"局部盒"（要按 yaw 转的部件都用这套） ── */

const IDENTITY_FRAME = { r: [1, 0, 0], u: [0, 1, 0], b: [0, 0, 1] }

/**
 * yaw → 实体局部坐标系的世界基向量（x = 右手，y = 上，z = 背后）。
 * mineflayer 的视线方向是 (-sin yaw, 0, -cos yaw)，所以背后 = (sin yaw, 0, cos yaw)。
 */
export function frameOfYaw (yaw) {
  const a = Number(yaw)
  const t = Number.isFinite(a) ? a : 0
  const s = Math.sin(t)
  const c = Math.cos(t)
  return { r: [c, 0, -s], u: [0, 1, 0], b: [s, 0, c] }
}

/** 局部盒（中心 + 半长 + 帧）→ 世界 AABB */
function rotAabb (center, local, frame) {
  const { r, u, b } = frame
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  let minZ = Infinity
  let maxZ = -Infinity
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? local.hx : -local.hx
    const sy = (i & 2) ? local.hy : -local.hy
    const sz = (i & 4) ? local.hz : -local.hz
    const x = center[0] + r[0] * sx + u[0] * sy + b[0] * sz
    const y = center[1] + r[1] * sx + u[1] * sy + b[1] * sz
    const z = center[2] + r[2] * sx + u[2] * sy + b[2] * sz
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  return { minX, maxX, minY, maxY, minZ, maxZ }
}

/** 局部轴 + 进入方向 → 皮肤贴图的面名（局部 +X=右手，-Z=正面）。
 *  注意 rayBox 的 step 是"射线方向的符号"，不是面朝哪边：
 *  step>0 表示从局部负侧进入（-X/-Y/-Z 那一面）。 */
const FACE_TABLE = [['left', 'right'], ['bottom', 'top'], ['front', 'back']]
export function skinFaceOf (axis, step) { return FACE_TABLE[axis][step > 0 ? 0 : 1] }

const localBoxOf = (local) => ({ minX: -local.hx, maxX: local.hx, minY: -local.hy, maxY: local.hy, minZ: -local.hz, maxZ: local.hz })

/** 局部命中点 → 面内归一化 uv。
 *  贴图约定（跟 skinview3d / MC 一致）：正面是"从正面看玩家"画出来的，
 *  所以 u 向玩家的**左**边增大、v 向下；顶/底面同样 u 向左、v 向前。 */
function faceUVOf (axis, step, local, lx, ly, lz) {
  const ux = (lx + local.hx) / (2 * local.hx)
  const uy = (local.hy - ly) / (2 * local.hy)
  const uz = (lz + local.hz) / (2 * local.hz)
  if (axis === 0) return { u: step > 0 ? uz : 1 - uz, v: uy }        // 局部 -X=玩家右手侧 / +X=左手侧
  if (axis === 1) return { u: 1 - ux, v: 1 - uz }                    // 顶面与底面朝向一致
  return { u: step > 0 ? 1 - ux : ux, v: uy }                        // -Z=正面 / +Z=背面
}

/** 部件盒（可能带旋转）与射线求交 */
export function hitPart (ox, oy, oz, dx, dy, dz, part, maxDist) {
  if (!part?.frame || !part.local) return rayBox(ox, oy, oz, dx, dy, dz, part, maxDist)
  const { r, u, b } = part.frame
  const c = part.center
  const vx = ox - c[0]
  const vy = oy - c[1]
  const vz = oz - c[2]
  const lox = vx * r[0] + vy * r[1] + vz * r[2]
  const loy = vx * u[0] + vy * u[1] + vz * u[2]
  const loz = vx * b[0] + vy * b[1] + vz * b[2]
  const ldx = dx * r[0] + dy * r[1] + dz * r[2]
  const ldy = dx * u[0] + dy * u[1] + dz * u[2]
  const ldz = dx * b[0] + dy * b[1] + dz * b[2]
  return rayBox(lox, loy, loz, ldx, ldy, ldz, localBoxOf(part.local), maxDist)
}

/** 描边用：把部件盒外扩 g 格（旋转盒按局部扩，不变成大一圈的 AABB） */
export function grownPart (part, g) {
  if (!part?.frame || !part.local) {
    return {
      minX: part.minX - g, maxX: part.maxX + g,
      minY: part.minY - g, maxY: part.maxY + g,
      minZ: part.minZ - g, maxZ: part.maxZ + g,
    }
  }
  const local = { hx: part.local.hx + g, hy: part.local.hy + g, hz: part.local.hz + g }
  return { frame: part.frame, center: part.center, local, ...rotAabb(part.center, local, part.frame) }
}

/* ── 玩家模型：MC 原始比例（1 皮肤像素 = 身高/32 格），按 yaw 转 ── */

/** 没有皮肤时用的"默认皮肤"配色（跟客户端里离线玩家看到的一样） */
const STEVE = { head: [228, 178, 148], shirt: [0, 168, 168], pants: [62, 62, 170] }

function playerParts (ent, style, skin) {
  const h = Math.max(0.25, Number(ent.height) || 1.8)
  const k = h / 32 // 1 皮肤像素
  const frame = frameOfYaw(ent.yaw)
  const slim = skin?.model === 'slim'
  const armW = slim ? 3 : 4
  const base = [Number(ent.x) || 0, Number(ent.y) || 0, Number(ent.z) || 0]
  const headC = skin ? null : STEVE.head
  const shirtC = skin ? null : STEVE.shirt
  const pantsC = skin ? null : STEVE.pants
  const mk = (part, px, py, pz, w, hh, dd, color, opts = {}) => {
    const local = { hx: (w * k) / 2, hy: (hh * k) / 2, hz: (dd * k) / 2 }
    const center = [
      base[0] + (frame.r[0] * px + frame.u[0] * py + frame.b[0] * pz) * k,
      base[1] + (frame.r[1] * px + frame.u[1] * py + frame.b[1] * pz) * k,
      base[2] + (frame.r[2] * px + frame.u[2] * py + frame.b[2] * pz) * k,
    ]
    return {
      ...rotAabb(center, local, frame),
      center, local, frame, color,
      mark: opts.mark === true,
      skinPart: opts.skinPart ?? null,
      skin: opts.skin ?? skin ?? null,
      cape: opts.cape === true,
    }
  }
  const parts = [
    mk('rightLeg', 2, 6, 0, 4, 12, 4, pantsC, { skinPart: 'rightLeg' }),
    mk('leftLeg', -2, 6, 0, 4, 12, 4, pantsC, { skinPart: 'leftLeg' }),
    mk('body', 0, 18, 0, 8, 12, 4, shirtC, { skinPart: 'body' }),
    mk('rightArm', 4 + armW / 2, 18, 0, armW, 12, 4, shirtC, { skinPart: 'rightArm' }),
    mk('leftArm', -(4 + armW / 2), 18, 0, armW, 12, 4, shirtC, { skinPart: 'leftArm' }),
    mk('head', 0, 28, 0, 8, 8, 8, headC, { skinPart: 'head', mark: !skin }),
  ]
  if (skin?.cape) {
    // 披风：贴在躯干背面（局部 +Z 是背后），从肩膀垂到腰下
    parts.push(mk('cape', 0, 16, 2.6, 10, 16, 1, [40, 40, 52], { cape: true, skinPart: '__cape__', skin }))
  }
  return parts
}

/** 把一个实体拆成若干"部件盒"（人形/生物/小方块），带颜色 */
export function entityParts (ent, style, skin) {
  const w = Math.max(0.25, Number(ent.width) || 0.6)
  const h = Math.max(0.25, Number(ent.height) || 1.8)
  const x = ent.x
  const y = ent.y
  const z = ent.z
  const bx = (cx, cy, cz, sw, sh, sd, color, mark) => ({
    minX: cx - sw / 2, maxX: cx + sw / 2,
    minY: cy, maxY: cy + sh,
    minZ: cz - sd / 2, maxZ: cz + sd / 2,
    color, mark,
  })
  if (style.shape === 'player') return playerParts(ent, style, skin)
  if (style.shape === 'mob') {
    const headH = Math.min(0.6, h * 0.36)
    const legH = Math.min(0.45, h * 0.3)
    const bodyH = h - headH - legH
    return [
      bx(x - w * 0.26, y, z, w * 0.2, legH, w * 0.2, scaleC(style.color, 0.75)),
      bx(x + w * 0.26, y, z, w * 0.2, legH, w * 0.2, scaleC(style.color, 0.75)),
      bx(x, y + legH, z, w, bodyH, w * 0.9, style.color),
      bx(x, y + legH + bodyH, z, w * 0.62, headH, w * 0.62, style.skin ?? style.color, true),
    ]
  }
  // 掉落物/箭/船…：一个小方块，略微离地
  const s = Math.max(0.28, Math.min(w, h) * 0.9)
  return [bx(x, y + Math.max(0.05, h * 0.25), z, s, s, s, style.color)]
}

/* ───────────────────────── 绘制辅助 ───────────────────────── */

/** 在 rgba/depth 上画一个盒（带深度测试），返回画了多少像素。
 *  统一走"局部盒 + 帧"：不旋转的盒帧就是单位阵；带 skinPart 的部件逐像素采皮肤贴图。 */
function paintBox (pc, box, color, opts = {}) {
  const { width, height, ox, oy, oz, f, r, u, tanX, tanY, rgba, depth, distance } = pc
  const mark = opts.mark === true
  const writeDepth = opts.writeDepth !== false
  const faceDark = opts.faceDark === true
  const skin = opts.plain === true ? null : (box.skin ?? null)
  const skinPart = skin && box.skinPart ? box.skinPart : null
  const frame = box.frame ?? IDENTITY_FRAME
  const local = box.local ?? { hx: (box.maxX - box.minX) / 2, hy: (box.maxY - box.minY) / 2, hz: (box.maxZ - box.minZ) / 2 }
  const center = box.center ?? [(box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2, (box.minZ + box.maxZ) / 2]
  const r0 = frame.r[0]
  const r1 = frame.r[1]
  const r2 = frame.r[2]
  const u0 = frame.u[0]
  const u1 = frame.u[1]
  const u2 = frame.u[2]
  const b0 = frame.b[0]
  const b1 = frame.b[1]
  const b2 = frame.b[2]
  const cx = center[0]
  const cy = center[1]
  const cz = center[2]
  const lbox = localBoxOf(local)
  // ① 8 个角投影 → 像素包围盒
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < 8; i++) {
    const sx = (i & 1) ? local.hx : -local.hx
    const sy = (i & 2) ? local.hy : -local.hy
    const sz = (i & 4) ? local.hz : -local.hz
    const wx = cx + r0 * sx + u0 * sy + b0 * sz
    const wy = cy + r1 * sx + u1 * sy + b1 * sz
    const wz = cz + r2 * sx + u2 * sy + b2 * sz
    const vx = wx - ox
    const vy = wy - oy
    const vz = wz - oz
    const zc = vx * f[0] + vy * f[1] + vz * f[2]
    if (zc <= 0.03) continue
    const xc = vx * r[0] + vy * r[1] + vz * r[2]
    const yc = vx * u[0] + vy * u[1] + vz * u[2]
    const px = ((xc / (zc * tanX)) + 1) * 0.5 * width
    const py = (1 - (yc / (zc * tanY))) * 0.5 * height
    if (px < minX) minX = px
    if (px > maxX) maxX = px
    if (py < minY) minY = py
    if (py > maxY) maxY = py
  }
  if (minX > maxX || minY > maxY) return 0
  const x0 = Math.max(0, Math.floor(minX) - 1)
  const x1 = Math.min(width - 1, Math.ceil(maxX) + 1)
  const y0 = Math.max(0, Math.floor(minY) - 1)
  const y1 = Math.min(height - 1, Math.ceil(maxY) + 1)
  if (x0 > x1 || y0 > y1) return 0
  // 相机位置在局部空间的坐标（每像素只变方向，不变起点）
  const vox = ox - cx
  const voy = oy - cy
  const voz = oz - cz
  const lox = vox * r0 + voy * r1 + voz * r2
  const loy = vox * u0 + voy * u1 + voz * u2
  const loz = vox * b0 + voy * b1 + voz * b2
  let painted = 0
  for (let py = y0; py <= y1; py++) {
    const ndcY = 1 - ((py + 0.5) / height) * 2
    const q0 = f[0] + u[0] * ndcY * tanY
    const q1 = f[1] + u[1] * ndcY * tanY
    const q2 = f[2] + u[2] * ndcY * tanY
    let idx = py * width + x0
    for (let px = x0; px <= x1; px++, idx++) {
      const ndcX = ((px + 0.5) / width) * 2 - 1
      let dx = q0 + r[0] * ndcX * tanX
      let dy = q1 + r[1] * ndcX * tanX
      let dz = q2 + r[2] * ndcX * tanX
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      dx /= len
      dy /= len
      dz /= len
      const ldx = dx * r0 + dy * r1 + dz * r2
      const ldy = dx * u0 + dy * u1 + dz * u2
      const ldz = dx * b0 + dy * b1 + dz * b2
      const hit = rayBox(lox, loy, loz, ldx, ldy, ldz, lbox, distance)
      if (hit === null) continue
      if (hit.dist > depth[idx] + 1e-4) continue
      let c
      if (skinPart) {
        const face = skinFaceOf(hit.axis, hit.step)
        const uv = faceUVOf(hit.axis, hit.step, local, hit.hx, hit.hy, hit.hz)
        const sp = skinPart === '__cape__' ? skin.sampleCape?.(face, uv.u, uv.v) : skin.sample(skinPart, face, uv.u, uv.v)
        if (!sp || sp[3] < 100) continue // 贴图这里是透明的：当个洞，让后面的东西露出来
        c = [sp[0], sp[1], sp[2]]
      } else {
        c = color ?? [150, 150, 150] // 兜底：颜色缺失也不能崩
        if (mark && hit.axis !== 1) {
          // 没有皮肤时给脸画两个眼睛（用归一化面内坐标，跟皮肤的眼睛位置一致）
          const uv = faceUVOf(hit.axis, hit.step, local, hit.hx, hit.hy, hit.hz)
          const inU = (uv.u > 0.26 && uv.u < 0.42) || (uv.u > 0.58 && uv.u < 0.74)
          const inV = uv.v > 0.52 && uv.v < 0.74
          if (inU && inV) c = scaleC(c, 0.22)
        }
      }
      c = scaleC(c, shadeOf(hit.axis, hit.step))
      if (faceDark) c = scaleC(c, 0.5)
      const o = idx * 4
      rgba[o] = clamp255(c[0])
      rgba[o + 1] = clamp255(c[1])
      rgba[o + 2] = clamp255(c[2])
      rgba[o + 3] = 255
      if (writeDepth) depth[idx] = hit.dist
      painted++
    }
  }
  return painted
}

/** 右下角：手臂 + 手持物（让画面有"第一人称"的实感，也让模型看见手里是什么） */
function paintHand (pc, held) {
  const { width, height, rgba } = pc
  const armW = Math.max(4, height * 0.2)
  const tipX = width - 1 - width * 0.13
  const tipY = height - 1 - height * 0.3
  const ax = width - 1
  const ay = height - 1
  const dx = tipX - ax
  const dy = tipY - ay
  const segLen2 = dx * dx + dy * dy || 1
  const skin = [228, 178, 148]
  const sleeve = [92, 132, 196]
  // 🔴 2026-10-08 审计：`status().held` 形如 `oak_planksx1`（名字 + x数量），而 `colorOf` 的规则
  //    （`/_planks$/`、`/^(torch|…)$/`、`/_ore$/`）都**带锚点** ⇒ 一个都匹配不上、永远落 FALLBACK 灰。
  //    先归一化再匹配（同一类"契约不匹配 ⇒ 条件恒假 ⇒ 功能等于没做"的坑见踩坑档案）。
  const itemColor = held ? colorOf(String(held).replace(/x\d+$/, '')) : null
  const put = (x, y, c) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const o = (y * width + x) * 4
    rgba[o] = clamp255(c[0])
    rgba[o + 1] = clamp255(c[1])
    rgba[o + 2] = clamp255(c[2])
    rgba[o + 3] = 255
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x - ax
      const py = y - ay
      let t = (px * dx + py * dy) / segLen2
      if (t < 0 || t > 1) continue
      const cx = ax + dx * t
      const cy = ay + dy * t
      const dist = Math.hypot(x - cx, y - cy)
      if (dist > armW / 2) continue
      let c = t < 0.42 ? sleeve : skin
      c = scaleC(c, dist > armW / 2 - 1.2 ? 0.55 : 1 - 0.12 * (1 - t))
      put(x, y, c)
    }
  }
  if (itemColor) {
    const s = Math.max(4, Math.round(height * 0.16))
    const ix = Math.round(tipX - s * 0.55)
    const iy = Math.round(tipY - s * 0.55)
    for (let y = iy - 1; y <= iy + s; y++) {
      for (let x = ix - 1; x <= ix + s; x++) {
        // 🔴 2026-10-08 审计：第三项原来写成 `x === iy + s`（拿 x 比 y 的坐标）⇒ 右边框恒不绘制，
        //    画幅接近正方时还会在图标**内部**多画一条暗线。应该是 `ix + s`。
        const edge = x === ix - 1 || y === iy - 1 || x === ix + s || y === iy + s
        put(x, y, edge ? [28, 28, 32] : itemColor)
      }
    }
    // 一点高光，看起来像块
    put(ix + 1, iy + 1, mixC(itemColor, [255, 255, 255], 0.35))
    put(ix + 2, iy + 1, mixC(itemColor, [255, 255, 255], 0.35))
  }
}

/** 画准星（中心留空一格，方便看清"我正对着哪一格"） */
function drawCrosshair (rgba, w, h) {
  const cx = w >> 1
  const cy = h >> 1
  const arm = Math.max(2, Math.round(h / 26))
  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return
    const o = (y * w + x) * 4
    rgba[o] = r
    rgba[o + 1] = g
    rgba[o + 2] = b
    rgba[o + 3] = 255
  }
  for (let d = -arm; d <= arm; d++) {
    if (d === 0) continue
    put(cx + d, cy, 255, 255, 255)
    put(cx, cy + d, 255, 255, 255)
    put(cx + d, cy + 1, 24, 24, 24)
    put(cx + d, cy - 1, 24, 24, 24)
    put(cx + 1, cy + d, 24, 24, 24)
    put(cx - 1, cy + d, 24, 24, 24)
  }
}

/* ─────────────────────────── 渲染 ─────────────────────────── */

/**
 * 渲染一帧第一人称画面。
 * @param opts.world   需有 `getBlock(pos)`（prismarine-world 就是）；pos 必须是带 `floored()` 的对象，
 *                     未加载区块返回 null。内核内部用 `makePos()` 造坐标。
 * @param opts.origin  [x,y,z] 眼睛世界坐标（浮点）
 * @param opts.yaw/pitch  弧度
 * @param opts.time    世界时间 0..24000（决定太阳/月亮/云的颜色）
 * @param opts.dimension 'overworld' | 'the_nether' | 'the_end'
 * @param opts.entities [{x,y,z,width,height,name,username,type,kind,id}]，position 是脚底
 * @param opts.held    手持方块/物品名（画在右下角）
 * @returns { rgba, stats, center, camera, entities }
 */
export function renderView (opts) {
  const {
    world,
    origin,
    yaw = 0,
    pitch = 0,
    width = VIEW_DEFAULTS.width,
    height = VIEW_DEFAULTS.height,
    fov = VIEW_DEFAULTS.fov,
    distance = VIEW_DEFAULTS.distance,
    crosshair = VIEW_DEFAULTS.crosshair,
    fogStart = VIEW_DEFAULTS.fogStart,
    maxSteps = VIEW_DEFAULTS.maxSteps,
    texture = VIEW_DEFAULTS.texture,
    ao = VIEW_DEFAULTS.ao,
    sky: skyOn = VIEW_DEFAULTS.sky,
    entities: drawEntities = VIEW_DEFAULTS.entities,
    hand: drawHand = VIEW_DEFAULTS.hand,
    time = 6000,
    dimension = 'overworld',
    held = null,
  } = opts
  if (!world || !origin) throw new Error('renderView 需要 world 与 origin')

  const rgba = new Uint8Array(width * height * 4)
  const depth = new Float32Array(width * height).fill(Infinity)
  const { f, r, u } = cameraBasis(yaw, pitch)
  const tanY = Math.tan((fov * Math.PI) / 360)
  const tanX = tanY * (width / height)
  const fogFrom = Math.max(1, distance * fogStart)
  const fogSpan = Math.max(1, distance - fogFrom)
  const scratch = makePos()
  const aoPos = makePos()
  const aoCache = new Map()
  const counts = new Map()
  const stats = { sky: 0, unknown: 0, hit: 0, pixels: width * height, top: [], entityPixels: 0, entitiesDrawn: 0, skinned: 0 }
  const ox = origin[0]
  const oy = origin[1]
  const oz = origin[2]
  const cx = width >> 1
  const cy = height >> 1
  const pc = { rgba, depth, width, height, ox, oy, oz, f, r, u, tanX, tanY, distance, dimension }
  const sky = sunOf(time)
  let center = null

  for (let py = 0; py < height; py++) {
    const ndcY = 1 - ((py + 0.5) / height) * 2
    const b0 = f[0] + u[0] * ndcY * tanY
    const b1 = f[1] + u[1] * ndcY * tanY
    const b2 = f[2] + u[2] * ndcY * tanY
    let o = py * width * 4
    for (let px = 0; px < width; px++) {
      const ndcX = ((px + 0.5) / width) * 2 - 1
      let dx = b0 + r[0] * ndcX * tanX
      let dy = b1 + r[1] * ndcX * tanX
      let dz = b2 + r[2] * ndcX * tanX
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
      dx /= len
      dy /= len
      dz /= len

      const skyC = skyOn ? skyColor(dx, dy, dz, sky, pc) : [SKY_DAY_HORIZON[0], SKY_DAY_HORIZON[1], SKY_DAY_HORIZON[2]]

      // 透明方块（玻璃/冰）会让射线继续往后走，最多穿 3 层
      let hit = null
      let travelled = 0
      let tintR = 0
      let tintG = 0
      let tintB = 0
      let tintA = 0
      for (let layer = 0; layer < 4; layer++) {
        const h = castRay(world, ox + dx * travelled, oy + dy * travelled, oz + dz * travelled, dx, dy, dz, distance - travelled, scratch, maxSteps)
        if (h === null || h.unknown) { hit = h; break }
        const rule = ruleOf(h.name)
        if (rule.glass === true && layer < 3) {
          const k = rule.alpha ?? 0.3
          const gc = rule.color
          tintR += (gc[0] - tintR) * k
          tintG += (gc[1] - tintG) * k
          tintB += (gc[2] - tintB) * k
          tintA = 1 - (1 - tintA) * (1 - k)
          travelled += h.dist + 0.002
          if (travelled >= distance) { hit = null; break }
          continue
        }
        h.dist += travelled
        hit = h
        break
      }

      let cr
      let cg
      let cb
      let dist = Infinity
      if (hit === null) {
        stats.sky++
        cr = skyC[0]
        cg = skyC[1]
        cb = skyC[2]
      } else if (hit.unknown) {
        stats.unknown++
        dist = distance
        const n = 0.9 + hash2(px, py, 61) * 0.2
        cr = 122 * n
        cg = 52 * n
        cb = 150 * n
      } else {
        stats.hit++
        dist = hit.dist
        counts.set(hit.name, (counts.get(hit.name) ?? 0) + 1)
        const rule = ruleOf(hit.name)
        const hx = ox + dx * dist
        const hy = oy + dy * dist
        const hz = oz + dz * dist
        const fracX = hx - Math.floor(hx)
        const fracY = hy - Math.floor(hy)
        const fracZ = hz - Math.floor(hz)
        let lu
        let lv
        if (hit.axis === 0) { lu = fracZ; lv = fracY } else if (hit.axis === 1) { lu = fracX; lv = fracZ } else { lu = fracX; lv = fracY }
        let base = texture
          ? patternPixel(rule, hit.axis, hit.step, lu, lv, hit.bx, hit.by, hit.bz)
          : rule.color
        let light = shadeOf(hit.axis, hit.step)
        // 朝阳面微亮
        if (skyOn && sky.daylight > 0.2) {
          const nx = hit.axis === 0 ? -hit.step : 0
          const ny = hit.axis === 1 ? -hit.step : 0
          const nz = hit.axis === 2 ? -hit.step : 0
          light *= 0.96 + 0.1 * clamp01(nx * sky.sun[0] + ny * sky.sun[1] + nz * sky.sun[2])
        }
        // 体素 AO
        if (ao) {
          const key = hit.bx + ',' + hit.by + ',' + hit.bz + ',' + hit.axis + ',' + hit.step
          let corners = aoCache.get(key)
          if (corners === undefined) {
            corners = aoCorners(world, hit.bx, hit.by, hit.bz, hit.axis, hit.step, aoPos)
            if (aoCache.size > 8192) aoCache.clear()
            aoCache.set(key, corners)
          }
          const top = corners[0] + (corners[1] - corners[0]) * lu
          const bot = corners[2] + (corners[3] - corners[2]) * lu
          light *= top + (bot - top) * lv
        }
        cr = base[0] * light
        cg = base[1] * light
        cb = base[2] * light
        if (rule.emissive === true) {
          cr = Math.max(cr, 190) * 1.02
          cg = Math.max(cg, 150) * 1.02
          cb = Math.max(cb, 70) * 1.02
        } else if (dist > fogFrom) {
          const k = Math.min(1, (dist - fogFrom) / fogSpan)
          cr += (skyC[0] - cr) * k
          cg += (skyC[1] - cg) * k
          cb += (skyC[2] - cb) * k
        }
      }
      if (tintA > 0) {
        cr += (tintR - cr) * tintA
        cg += (tintG - cg) * tintA
        cb += (tintB - cb) * tintA
      }
      rgba[o] = clamp255(cr)
      rgba[o + 1] = clamp255(cg)
      rgba[o + 2] = clamp255(cb)
      rgba[o + 3] = 255
      depth[py * width + px] = dist
      if (px === cx && py === cy) center = hit
      o += 4
    }
  }

  /* ── 实体 ── */
  const ents = []
  /* 🔴 审计 G9：这里原来叫 `partsById`、按 `ent.id ?? null` 存 —— 实体没有 id 时全挤在
   *    同一个 `null` 键上（后一个覆盖前一个），而查的时候是 `partsById.get(e.id)`（`undefined`）
   *    ⇒ `Map` 里 `null !== undefined`，**一个都查不到** ⇒ 准星判定 `bestId` 永远是 null
   *    ⇒ `underCrosshair` 永远不置真、`crosshairEntity` 永远是 null。
   *    改成按"在 `ents` 里的下标"存，跟 id 有没有、是不是 null 都无关。 */
  const partsByIndex = new Map()
  if (drawEntities && Array.isArray(opts.entities) && opts.entities.length > 0) {
    const list = []
    for (const ent of opts.entities) {
      const box = entityBoxOf(ent)
      if (!box) continue
      const ddx = box.cx - ox
      const ddy = box.cy - oy
      const ddz = box.cz - oz
      const dc = Math.sqrt(ddx * ddx + ddy * ddy + ddz * ddz)
      if (dc > distance + 4) continue
      const style = entityStyle(ent)
      list.push({ ent, box, style, dc })
    }
    list.sort((a, b) => a.dc - b.dc)
    for (const item of list.slice(0, 96)) {
      const { ent, box, style, dc } = item
      const skin = opts.skins ? (opts.skins[ent.username ?? ''] ?? opts.skins[ent.id] ?? null) : null
      if (skin) stats.skinned++
      const parts = entityParts(ent, style, skin)
      partsByIndex.set(ents.length, parts)
      // ① 描边（外扩一点，深色，不写深度、不采样皮肤）
      for (const p of parts) {
        paintBox(pc, grownPart(p, 0.035), [22, 22, 26], { writeDepth: false, faceDark: true, plain: true })
      }
      // ② 实体本体（写深度，近的挡住远的）
      let painted = 0
      for (const p of parts) painted += paintBox(pc, p, p.color, { mark: p.mark === true })
      if (painted > 0) stats.entitiesDrawn++
      stats.entityPixels += painted
      // 屏幕方位（给文字摘要用）
      let sx = null
      let sy = null
      const vx = box.cx - ox
      const vy = box.cy - oy
      const vz = box.cz - oz
      const zc = vx * f[0] + vy * f[1] + vz * f[2]
      if (zc > 0.05) {
        const xc = vx * r[0] + vy * r[1] + vz * r[2]
        const yc = vx * u[0] + vy * u[1] + vz * u[2]
        sx = Math.round(((xc / (zc * tanX)) + 1) * 0.5 * 100)
        sy = Math.round((1 - (yc / (zc * tanY))) * 0.5 * 100)
      }
      const onCrosshair = false // 稍后沿视线做射线-部件盒测试再定
      ents.push({
        id: ent.id ?? null,
        name: ent.username || ent.displayName || ent.name || '实体',
        shape: style.shape,
        label: style.label,
        hostile: style.hostile === true,
        color: hex(skin ? skin.average() : style.color),
        skin: skin ? { model: skin.model, slim: skin.model === 'slim', legacy: skin.legacy === true, cape: !!skin.cape } : null,
        distance: Math.round(dc * 10) / 10,
        screen: { xPct: sx, yPct: sy, visible: sx !== null },
        pixels: painted,
        underCrosshair: onCrosshair,
      })
    }
  }
  // 准星真正对着的实体：沿视线方向做射线-部件盒测试（比"投影中心靠近画面中心"可靠）
  if (ents.length > 0) {
    const centerDist = center && center.unknown !== true ? center.dist : distance
    let bestIdx = null
    let bestDist = Math.min(centerDist, distance)
    for (let i = 0; i < ents.length; i++) {
      const parts = partsByIndex.get(i)
      if (!parts) continue
      for (const p of parts) {
        const h = hitPart(ox, oy, oz, f[0], f[1], f[2], p, bestDist)
        if (h !== null && h.dist <= bestDist) { bestDist = h.dist; bestIdx = i }
      }
    }
    if (bestIdx !== null) {
      const e = ents[bestIdx]
      e.underCrosshair = e.pixels > 0
    }
  }
  stats.entities = ents
  stats.crosshairEntity = ents.find((e) => e.underCrosshair && e.pixels > 0) ?? null

  if (drawHand) paintHand(pc, held)
  if (crosshair) drawCrosshair(rgba, width, height)
  stats.top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, pixels]) => ({ name, pixels }))
  return { rgba, stats, center, camera: { f, r, u, tanX, tanY }, entities: ents, sun: sky }
}

/** yaw（弧度）→ 罗盘方位（yaw=0 正北，顺时针） */
const COMPASS = ['北(N,-Z)', '北西', '西(W,-X)', '南西', '南(S,+Z)', '南东', '东(E,+X)', '北东']
export function compassOf (yaw) {
  const deg = (((yaw * 180) / Math.PI) % 360 + 360) % 360
  return COMPASS[Math.round(deg / 45) % 8]
}

/* ────────────────────────── 自检 ──────────────────────────
 * 用法：node -e "import('file:///…/mc_view-render.mjs').then(m=>m.selfTest())"
 * 造一个"平地 + 一面墙 + 一个坑 + 两个实体"的假世界，渲染成 PNG 落盘，肉眼确认画面方向对不对。 */
export function selfTest (outFile) {
  const world = {
    getBlock (pos) {
      // 照抄 prismarine-world 的行为：必须调用 pos.floored()（worldsync.js:102）。
      // 这样任何"只传纯 {x,y,z}"的写法都会在离线自检里立刻炸出来。
      const { x, y, z } = pos.floored()
      // ① 右前方一大块"未加载区块"（在墙之前，所以看得见）
      if (x >= 6 && x <= 14 && z <= -4 && z >= -8) return null
      // ② 水坑（要排在 y===0 的草地之前，否则永远看不到）
      if (x >= 3 && x <= 5 && z >= -3 && z <= -1 && y === 0) return { name: 'water', boundingBox: 'empty' }
      if (y < 0) return { name: 'stone', boundingBox: 'block' }
      if (y === 0) return { name: 'grass_block', boundingBox: 'block' }
      if (z === -6 && y >= 1 && y <= 3) return { name: 'oak_planks', boundingBox: 'block' }
      if (z === -10 && y >= 1 && y <= 2) return { name: 'glass', boundingBox: 'block' }
      if (x === -4 && z === -4 && y === 1) return { name: 'torch', boundingBox: 'empty' }
      return { name: 'air', boundingBox: 'empty' }
    },
  }
  const entities = [
    { id: 7, type: 'player', username: 'Steve', name: 'player', x: -1.6, y: 1, z: -4, width: 0.6, height: 1.8 },
    { id: 8, type: 'mob', name: 'zombie', x: 2.2, y: 1, z: -5, width: 0.6, height: 1.95 },
  ]
  const frame = renderView({
    world, origin: [0, 1.62, 0], yaw: 0, pitch: 0, width: 192, height: 108,
    entities, held: 'diamond_pickaxe', time: 4000,
  })
  return { frame, world, entities }
}
