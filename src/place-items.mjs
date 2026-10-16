// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / place-items.mjs —— "挑方块 / 垫脚料"那一层（路线图第 ④ 条第六刀）
 * ---------------------------------------------------------------------------
 * 2026-10-08 从 src/core.mjs **原文**搬出（正文逐字未改，只给两个私有常量加了 export）。
 * 判据分三层，都是"读 bot 但不改状态"的纯函数：
 *   1. NON_FULL_BLOCK —— 形状不是整方块的方块名黑名单（半砖/楼梯/墙/栅栏/地毯/耕地/头颅/铁砧…）；
 *   2. isFullBlockItem(bot, name) —— 三段判据（boundingBox === 'block' + transparent === false + 黑名单），
 *      为什么不能只看 boundingBox 见下面那段注释（用户 2026-10-06 报"它搭方块会用非实体方块搭"就是这里）；
 *   3. NO_SCAFFOLD + scaffoldingItemIds(bot) + pickPlaceItem(bot, want) —— 垫脚料与"能放"的方块物品。
 *
 * 调用方（一行都不用改）：src/core.mjs 在这里 import 并**照样导出**
 * isFullBlockItem / scaffoldingItemIds / pickPlaceItem ——
 * tools/check-core-place.mjs 与 实机验证/搭方块/live-place.mjs 都是 import { … } from '../src/core.mjs'。
 *
 * 依赖：无（只读 bot.registry.blocksByName 与 bot.inventory.items()，不 import 游戏库、不 import core）。
 */
/**
 * 形状**不是整方块**的方块名（半砖/楼梯/墙/栅栏/地毯/耕地/告示牌/头颅/铁砧…）。
 *
 * 为什么不能只看 `boundingBox`：半砖、楼梯、栅栏、墙、地毯、耕地、土径、头颅、铁砧的
 * `boundingBox` 同样是 `'block'`、`transparent` 同样是 `false`，但它们**站不住、也叠不起来**。
 * 2026-10-06 用户报"它搭方块会用非实体方块搭"就是踩在这里。
 */
export const NON_FULL_BLOCK = /(_slab|_stairs|_wall|_fence|_fence_gate|_carpet|_pane|_door|_trapdoor|_button|_pressure_plate|_sign|_banner|_bed|_rail|_torch|_candle|_chain|_bars|_head|_skull|_anvil|_cauldron|_composter|_lectern|_grindstone|_stonecutter|_loom|_cartography_table|_fletching_table|_smithing_table|_brewing_stand|_enchanting_table|_beacon|_conduit|_bell|_campfire|_lantern|_pot|_plant|_flower|_sapling|_roots|_sprouts|_vine|_lily|_grass|_fern|_leaves|_azalea|_bush|_shoot|_petals?|_cluster|_hanging|_cocoon|_vein|_pointed|_dripstone|_chorus|_kelp|_seagrass|_pickle|_egg|_web|_layer)$|^(farmland|dirt_path|snow|tnt|vine|chain|anvil|rail|scaffolding|cobweb)$/

/**
 * 这个方块物品能不能当**实体方块**用 —— 整方块，能站上去、能往上叠。
 * 火把/花/告示牌/门/玻璃/树叶/梯子/半砖/楼梯/栅栏…一律不算。
 *
 * 判据三段（缺一不可，实测过 1.21.10 的 registry）：
 *   ① `boundingBox === 'block'` 排掉火把/树苗/按钮/告示牌/铁轨/蜘蛛网；
 *   ② `transparent === false` 排掉门/活板门/梯子/玻璃/树叶/脚手架/竹子/荷叶；
 *   ③ 名字黑名单排掉半砖/楼梯/墙/栅栏/地毯/耕地/土径/头颅/铁砧（①②都拦不住它们）。
 */
export function isFullBlockItem (bot, name) {
  const b = bot?.registry?.blocksByName?.[name]
  if (!b) return false                             // 根本不是方块（木棍、煤、钻石…）
  if (b.boundingBox !== 'block') return false      // 火把/花/按钮/告示牌/铁轨/蜘蛛网/树苗…
  if (b.transparent !== false) return false        // 门/活板门/梯子/玻璃/树叶/脚手架/竹子/荷叶…
  return !NON_FULL_BLOCK.test(String(name))        // 半砖/楼梯/墙/栅栏/地毯/耕地/土径/头颅/铁砧…
}

/**
 * 背包里**能当垫脚料**的方块，返回 **item id** 列表（pathfinder 的 `scafoldingBlocks` 要的就是它）。
 *
 * ⚠️ 必须用 `itemsByName`：`scafoldingBlocks` 是跟 `bot.inventory.items()` 里的 `item.type`
 *    比的（**物品 id**）；1.13+ 物品 id ≠ 方块 id，拿 `blocksByName` 的 id 填进去会永远匹配不上
 *    （2026-10-06 在 mc_craft 上刚被同一个坑咬过：工作台物品 332 / 方块 205）。
 *
 * ⚠️ 必须是**整方块**（见 `isFullBlockItem`）：火把、树苗、门、半砖也能"放下去"，
 *    但垫在脚下一站就掉 —— 用户报的"它搭方块会用非实体方块搭"就是这个。
 * 贵重的方块（矿石、钻石/铁/金块…）和家当（箱子、熔炉、工作台…）不拿去垫。
 */
export const NO_SCAFFOLD = /(_ore$|^(diamond|netherite|emerald|gold|iron|copper|coal|redstone|lapis|quartz|amethyst)_(block|ore)?$|^(diamond|netherite|emerald)_block$|^ancient_debris$|^(chest|trapped_chest|barrel|ender_chest|shulker_box|furnace|blast_furnace|smoker|crafting_table|anvil|chipped_anvil|damaged_anvil|enchanting_table|beacon|conduit|hopper|dispenser|dropper|jukebox|note_block|respawn_anchor|lodestone|beehive|bee_nest|brewing_stand|cauldron|bell|sculk_catalyst|tnt)$|_shulker_box$|_bed$)/
export function scaffoldingItemIds (bot) {
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch {}
  const counts = new Map()                          // item id -> 手里最多的一摞
  for (const it of items) {
    const name = it?.name
    if (!name) continue
    if (!isFullBlockItem(bot, name)) continue       // 火把/门/半砖这些搭不了
    if (NO_SCAFFOLD.test(name)) continue
    counts.set(it.type, Math.max(counts.get(it.type) ?? 0, it.count ?? 1))
  }
  // 手里多的排前面：垫脚优先用存货多的，别把最后一块土用掉
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/**
 * 挑一个"能放"的方块物品。
 * - 指定 `want`：就给那个（哪怕它是火把/半砖 —— AI 明确点名要的，不拦）
 * - 没指定：**只挑整方块**，并跳过家当（矿石/箱子/熔炉/工作台…）。
 *
 * 旧版没指定时直接 `items[0]` —— 于是背包第一格是火把/树苗/门/木棍时它就拿去搭，
 * 用户 2026-10-06 报的"它搭方块会用非实体方块搭"就是这个。
 */
export function pickPlaceItem (bot, want = null) {
  let items = []
  try { items = bot?.inventory?.items?.() ?? [] } catch {}
  if (!items.length) return null
  if (want) return items.find((i) => i.name === want) ?? null
  return items.find((i) => isFullBlockItem(bot, i.name) && !NO_SCAFFOLD.test(String(i.name))) ?? null
}
