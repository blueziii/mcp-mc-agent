/**
 * mc_furnace —— 真·熔炼能力（mcp-mc-agent 扩展）
 *
 * 为什么需要它：插件原来 32 个工具里**没有熔炼**。1.17 以后铁矿石掉的是"粗铁"，
 * 必须烧成铁锭才能做铁镐；没有铁镐挖不动钻石；没有钻石镐挖不动黑曜石；没有黑曜石搭不起下界门。
 * 所以"像正常玩家一样发展、最后打末影龙"这条长期目标**卡在熔炼这一步**——
 * 机器人只能停在石器时代（2026-10-06 实机确认）。
 *
 * 有没有现成的？
 *   · **高层插件：没有。** npm 上搜 `mineflayer furnace/smelt/smelting/mining/container`，
 *     返回的全是已经在用的那几个包（collectblock / pathfinder / tool / pvp / auto-eat / armor-manager）。
 *   · **底层原语：现成的。** mineflayer **自带** `lib/plugins/furnace.js`：
 *     `bot.openFurnace(block)` 之后有 `putInput/putFuel/takeOutput/takeInput/takeFuel`、
 *     `inputItem/fuelItem/outputItem`、`fuel/progress/fuelSeconds/progressSeconds`、`update` 事件，
 *     连熔炉类型（furnace / blast_furnace / smoker）都判好了。协议层的活一点不用自己写。
 *   · **配方表：不是现成的。** minecraft-data 的 `recipes.json`（397 KB）**只有合成配方**，
 *     全文搜 `smelting`/`furnace`/`blasting` 都是 False；`prismarine-recipe` 也只做合成。
 *     所以本文件自己带一张熔炼表 —— **按名字写**（不按数字 id），跨版本不会坏。
 *
 * 本文件做的事（都是 mineflayer 没做的"编排"）：
 *   ① **找熔炉 / 没有就自己放一个**（复用 mc_util 的 findPlaceSpot）。
 *   ② **挑燃料**：按"浪费最少"算 —— 要烧 1 个就用 2 根木棍，别为一点东西烧掉一整块煤。
 *   ③ **盯进度（可选）**：默认不盯（装好料就返回）；给了 `maxWaitSec` 才盯熔炉自己的 `progress`/`fuel`，火灭了还没好就自己补燃料。
 *   ④ **收成品**：到点 `takeOutput()`（空槽调用会 assert 抛错，所以先看有没有）。
 *   ⑤ **反查**：写产物名（`iron_ingot`）也能烧 —— 自动找背包里的粗铁/铁矿石。
 *
 * 装法：放在 `<profile>/node_modules/mcp-mc-agent/extensions/` 下即自动加载（插件 index.js:4089 的扩展点）。
 *
 * 门禁：**加进** mc_observe 的 `DEFAULT_GATED` —— 熔炼会动世界里的熔炉（放/开/塞东西），
 * 属于"要动手之前先看一眼"那一类（门禁默认关，只有强制模式才拦）。
 *
 * 环境变量：无。参数都在工具调用里。
 */
import { blockIdOf, itemIdOf, findPlaceSpots, blockAtXYZ, clamp, countOf } from './mc_util.mjs'
import { withTimeout, CALL_MS, CALL_BUDGET_MS, callBudget } from '../src/core.mjs'

export const name = 'mc_furnace'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 熔炉类方块（高炉/烟熏炉也认，烧得快一倍） */
const FURNACE_NAMES = ['furnace', 'blast_furnace', 'smoker']
/**
 * 一次调用最多盯多久（秒）。
 * 🔴 用户要求：熔炉**不需要一直看着** —— 料装进去就返回，过一会儿再叫一次取成品。
 *    所以默认 0（不盯）；模型明确想等一小会儿时可以给 1~10 秒（仍然守住"单次调用 ≤11 秒"）。
 *    窗口关掉后炉子**照样在服务端烧**，下次再叫一次 mc_furnace 取货就行（不用重新装料）。
 */
const DEFAULT_MAX_WAIT_SEC = 0
const MAX_WAIT_SEC = 10
/** 熔炉烧一个物品 10 秒（200 游戏刻）；高炉/烟熏炉 5 秒 */
const SEC_PER_ITEM = 10
/** 一次最多往炉子里装几个（装多了这一轮肯定烧不完，少量多次） */
const MAX_LOAD = 8

/* ───────────────────────── 熔炼表（按名字） ───────────────────────── */

/** 精确表：烧炼物 → 产物。全部按名字写。 */
export const SMELT_EXACT = {
  // 矿物（粗矿和矿石方块都能烧，产物一样）
  iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot', raw_iron: 'iron_ingot',
  copper_ore: 'copper_ingot', deepslate_copper_ore: 'copper_ingot', raw_copper: 'copper_ingot',
  gold_ore: 'gold_ingot', deepslate_gold_ore: 'gold_ingot', raw_gold: 'gold_ingot', nether_gold_ore: 'gold_ingot',
  ancient_debris: 'netherite_scrap',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone', lit_redstone_ore: 'redstone',
  coal_ore: 'coal', deepslate_coal_ore: 'coal',
  nether_quartz_ore: 'quartz',
  // 石头类
  cobblestone: 'stone', cobbled_deepslate: 'deepslate',
  stone: 'smooth_stone', smooth_stone: 'smooth_stone',
  sand: 'glass', red_sand: 'glass',
  clay_ball: 'brick', clay: 'terracotta',
  netherrack: 'nether_brick', basalt: 'smooth_basalt',
  // 其他
  cactus: 'green_dye', sea_pickle: 'lime_dye', wet_sponge: 'sponge',
  chorus_fruit: 'popped_chorus_fruit', kelp: 'dried_kelp',
  // 食物
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit',
  cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato',
}
// smooth_stone 烧不出别的，别让它自己指向自己
delete SMELT_EXACT.smooth_stone

/** 工具/武器/盔甲 → 对应的粒（1.21.9+ 才有铜的） */
const TOOL_ARMOR = new Set([
  'sword', 'pickaxe', 'axe', 'shovel', 'hoe', 'spear',
  'helmet', 'chestplate', 'leggings', 'boots', 'horse_armor', 'nautilus_armor',
])
const METAL_PREFIX = { iron: 'iron_nugget', golden: 'gold_nugget', gold: 'gold_nugget', copper: 'copper_nugget' }

/**
 * 这个物品烧出来是什么？烧不出来 → null。
 * 支持：精确表 / 任意原木木头 → 木炭 / 铁金铜工具盔甲 → 粒 / 锁链甲 → 铁粒。
 */
export function smeltTargetOf (rawName) {
  const n = String(rawName ?? '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  if (!n) return null
  if (SMELT_EXACT[n]) return SMELT_EXACT[n]
  if (/_log$|_wood$/.test(n)) return 'charcoal'
  const m = n.match(/^(iron|golden|gold|copper)_(.+)$/)
  if (m && TOOL_ARMOR.has(m[2])) return METAL_PREFIX[m[1]]
  if (/^chainmail_(helmet|chestplate|leggings|boots)$/.test(n)) return 'iron_nugget'
  return null
}

/** 反查：想烧出 output，可以烧哪些东西？（按"背包里有没有"排序由调用方做） */
export function smeltInputsFor (bot, rawOutput) {
  const out = String(rawOutput ?? '').toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const names = Object.keys(bot?.registry?.itemsByName ?? {})
  const list = []
  for (const [k, v] of Object.entries(SMELT_EXACT)) if (v === out) list.push(k)
  if (out === 'charcoal') for (const n of names) if (/_log$|_wood$/.test(n)) list.push(n)
  const m = out.match(/^(iron|gold|copper)_nugget$/)
  if (m) {
    const pre = m[1] === 'gold' ? 'golden|gold' : m[1]
    const re = new RegExp(`^(${pre})_(.+)$`)
    for (const n of names) {
      const mm = n.match(re)
      if (mm && TOOL_ARMOR.has(mm[2])) list.push(n)
    }
    if (m[1] === 'iron') for (const n of names) if (/^chainmail_/.test(n)) list.push(n)
  }
  return [...new Set(list)]
}

/**
 * 解析 AI 写的名字 → `{input, output, note}`。
 * ① 直接写烧炼物（raw_iron / iron_ore / sand / beef / oak_log）→ 查表。
 * ② 写产物名（iron_ingot / glass / charcoal）→ 反查，**优先背包里真有的那种**。
 */
export function resolveSmelt (bot, query) {
  const raw = String(query ?? '').trim()
  if (!raw) {
    throw new Error('要烧什么？给个名字，比如 name:"raw_iron"（也可以直接写产物名 name:"iron_ingot"；list:true 看全部）')
  }
  const q = raw.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const direct = smeltTargetOf(q)
  if (direct) return { input: q, output: direct, note: null }
  const cands = smeltInputsFor(bot, q)
  if (!cands.length) {
    throw new Error(`“${raw}”既不是能烧的东西，也不是能烧出来的东西`
      + '（写英文 id：raw_iron / iron_ore / sand / cobblestone / beef / oak_log / potato …；list:true 看全部）')
  }
  const have = cands.filter((c) => countOf(bot, itemIdOf(bot, c)) > 0)
  const pick = have[0] ?? cands[0]
  return {
    input: pick,
    output: q,
    note: have.length
      ? (have.length > 1 ? `“${raw}”可以烧 ${have.join(' / ')}，按背包里有的选了 **${pick}**` : null)
      : `背包里没有 ${cands.slice(0, 4).join('/')}，这次大概率烧不出来`,
  }
}

/* ───────────────────────── 燃料表（按名字） ───────────────────────── */

/**
 * 燃料表。`per` = 一个能烧几个物品（1 个物品 = 10 秒，所以 per×10 就是燃烧秒数）。
 * 数字来自 Minecraft Wiki「烧炼 / 燃料效率」（Java 版）；这里只用来**挑燃料和估时间**，
 * 真正的进度靠盯熔炉的 `progress`/`fuel` —— 所以表里数字有点误差也不会烧坏东西。
 * `kind`：**0 = 正经燃料**（煤炭/木炭/煤炭块/烈焰棒/熔岩桶/干海带块，该烧的就是它们），
 * **1 = 木头类**（原木/木板/木棍/树苗/竹子 —— 这些是建材和合成料，只在没有正经燃料时才烧）。
 * 顺序 = 档位（越靠前越"经烧"，平手时优先用它）。
 */
export const FUELS = [
  { re: /^lava_bucket$/, per: 100, kind: 0, label: '熔岩桶' },
  { re: /^coal_block$/, per: 80, kind: 0, label: '煤炭块' },
  { re: /^dried_kelp_block$/, per: 20, kind: 0, label: '干海带块' },
  { re: /^blaze_rod$/, per: 12, kind: 0, label: '烈焰棒' },
  { re: /^(coal|charcoal)$/, per: 8, kind: 0, label: '煤炭/木炭' },
  {
    re: /^(bamboo_block|stripped_bamboo_block)$|_(planks|log|wood)$|^(crafting_table|chest|barrel|bookshelf|ladder|fletching_table|cartography_table|smithing_table|loom|composter|beehive|bee_nest|note_block|jukebox|lectern)$/,
    per: 1.5,
    kind: 1,
    label: '木头类',
  },
  { re: /^(stick|bowl|leaf_litter|.*_sapling)$/, per: 0.5, kind: 1, label: '木棍/树苗' },
  /* 🔴 2026-10-08 第五份审计旁注：木制工具（剑/镐/斧/锹/锄）每个能烧 1 个物品，
   *    以前没进表 ⇒ 快坏的木镐只能扔。放在"木棍/树苗"之后（互不重叠）。 */
  { re: /^wooden_(sword|pickaxe|axe|shovel|hoe)$/, per: 1, kind: 1, label: '木制工具' },
  { re: /^bamboo$/, per: 0.25, kind: 1, label: '竹子' },
]

/** 背包里所有能当燃料的东西（含 per / 档位） */
export function fuelListOf (bot) {
  const out = []
  for (const it of invItems(bot)) {
    if (!it?.count) continue
    const idx = FUELS.findIndex((f) => f.re.test(it.name))
    if (idx < 0) continue
    // 🔴 prismarine-item 的 Item 上数字 id 叫 `type`，**没有 `id` 字段** ——
    // 写成 it.id 会静默变 undefined，把"排除产物本身"这条规则废掉（本文件的自检抓过一次）。
    out.push({ id: it.type ?? it.id, name: it.name, have: it.count, per: FUELS[idx].per, kind: FUELS[idx].kind, label: FUELS[idx].label, tier: idx })
  }
  return out
}

/**
 * 挑燃料 + 决定放几个（**按要烧的数量算，一次放够**）。
 * 判据顺序：
 *   ① **够烧**：`放几个 = ceil(要烧几个 / per)`，背包里得有这么多；
 *   ② **正经燃料优先**：有煤炭/木炭就不烧木头和木棍（木棍是合成料，`kind: 0` 压过 `kind: 1`）；
 *   ③ **浪费最少**：`浪费 = 放几个 × per - 要烧几个`；平手挑档位更高、放得更少的。
 * 例：要烧 1 个 → 有煤就放 1 块煤（够烧 8 个，剩下的热留着烧下一批），没煤才放 2 根木棍；
 *     要烧 8 个 → 1 块煤；要烧 9 个 → 2 块煤（或 1 块煤 + 别的）。
 * 数量不够的燃料排在后面；全都不够时挑"总热量最大"的那种，让调用方补。
 * @param {object} bot
 * @param {number} need 要烧几个物品
 * @param {number|number[]|null} excludeId 不要拿来当燃料（**产物**和**要烧的原料**都要排除 ——
 *        否则"烧原木成木炭"会把原木本身当燃料烧掉）
 * @param {string|null} forceName 指定燃料名；**指定的优先于排除**（AI 明确说了要用它，就听它的）
 */
export function pickFuel (bot, need, excludeId = null, forceName = null) {
  const all = fuelListOf(bot)
  const score = (cands) => {
    const scored = cands.map((c) => {
      const count = Math.max(1, Math.ceil(need / c.per))
      return { ...c, count, waste: count * c.per - need, enough: c.have >= count }
    })
    const ok = scored.filter((s) => s.enough)
    if (ok.length) {
      // 正经燃料 > 木头类，再比浪费，再比档位/数量
      ok.sort((a, b) => (a.kind - b.kind) || (a.waste - b.waste) || (a.tier - b.tier) || (a.count - b.count))
      return ok[0]
    }
    scored.sort((a, b) => ((b.have * b.per) - (a.have * a.per)) || (a.kind - b.kind) || (a.tier - b.tier))
    return scored[0]
  }
  // 明确指定的燃料优先（哪怕它正好是要烧的原料 —— 那是 AI 自己的选择）
  if (forceName) {
    const want = String(forceName).toLowerCase().replace(/^minecraft:/, '')
    const only = all.filter((c) => c.name === want || c.name.includes(want))
    if (only.length) return score(only)
  }
  const ex = excludeId == null ? [] : (Array.isArray(excludeId) ? excludeId : [excludeId])
  const cands = all.filter((c) => !ex.includes(c.id))
  if (!cands.length) return null
  return score(cands)
}

/* ───────────────────────── 小工具 ───────────────────────── */

function invItems (bot) {
  try { return bot?.inventory?.items() ?? [] } catch { return [] }
}

function safeCall (obj, fn) {
  try { return typeof obj?.[fn] === 'function' ? obj[fn]() : null } catch { return null }
}

/** 等背包真收到成品，返回"现在有多少个"。
 *  🔴 2026-10-08 审计 H4：`putAway`/`takeOutput` resolve 只代表"服务端处理了这次点击"
 *  （`mineflayer/lib/plugins/inventory.js:660-671` 的 `confirmTransaction`），背包那格要等
 *  `set_slot` 到客户端才更新。以前 takeOnly 路径立刻读，报出"收走了 ×4（背包里现在有 0 个）"，
 *  AI 以为东西丢了，转头重挖重烧。 */
async function awaitOutput (bot, outId, before, took, tries = 20) {
  let now = countOf(bot, outId)
  for (let i = 0; i < tries && took > 0 && now < before + took; i++) {
    await sleep(150)
    now = countOf(bot, outId)
  }
  return now
}

/** 找工作着的熔炉：给了 x/y/z 就查那一格；否则在 radius 内找最近的一个 */
export function findFurnaceBlock (bot, { x, y, z, radius = 6 } = {}) {
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z))) {
    const b = blockAtXYZ(bot, x, y, z)
    return b && FURNACE_NAMES.includes(b.name) ? b : null
  }
  // 🔴 必须用**方块 id**（blocksByName），不是物品 id —— findBlock 比的是 block.type
  const ids = FURNACE_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return null
  try {
    return bot.findBlock({ matching: ids, maxDistance: clamp(Number(radius) || 6, 1, 12) }) ?? null
  } catch { return null }
}

/** 背包里有几个熔炉（三种都算） */
export function furnaceInInventory (bot) {
  for (const n of FURNACE_NAMES) {
    const id = itemIdOf(bot, n)
    const have = countOf(bot, id)
    if (have > 0) return { name: n, id, have }
  }
  return null
}

/** 缺料时给一条能照着做的下一步 */
export function hintFor (name) {
  const n = String(name ?? '')
  if (/^raw_/.test(n)) {
    const ore = n.replace(/^raw_/, '') + '_ore'
    return `粗矿：挖 \`${ore}\` 就有 —— \`mc_dig {name:"${ore}",count:3}\`（要用对镐子）`
  }
  if (/_ore$/.test(n)) return `矿石：\`mc_dig {name:"${n}",count:3}\`（要用对镐子），或者下矿找`
  if (n === 'sand' || n === 'red_sand') return `沙子：\`mc_dig {name:"${n}",count:8}\`（水边 / 沙漠）`
  if (n === 'cobblestone') return '圆石：`mc_dig {name:"stone",count:8}`（要用镐子）'
  if (n === 'cobbled_deepslate' || n === 'deepslate') return `深层石头：\`mc_dig {name:"${n}",count:8}\`（y 很低的洞里）`
  if (/_log$|_wood$/.test(n)) return `原木：\`mc_dig {name:"${n}",count:3}\`（砍你附近那种树）`
  if (/^(beef|porkchop|chicken|mutton|rabbit|cod|salmon|potato)$/.test(n)) {
    return '食物：`mc_act {mode:"attack"}` 打牛/猪/鸡/羊，或者钓鱼、种马铃薯'
  }
  if (n === 'clay_ball') return '黏土球：挖水底的黏土块（`mc_dig {name:"clay",count:8}`）'
  if (n === 'ancient_debris') return '远古残骸：去下界 y≈15 挖（要钻石镐），烧成下界合金碎片'
  if (n === 'cactus') return '仙人掌：`mc_dig {name:"cactus",count:8}`（沙漠）'
  if (n === 'kelp') return '海带：海里 `mc_dig {name:"kelp",count:8}`'
  return '先想办法弄到它（`mc_dig` 挖 / `mc_craft` 合成 / 打怪掉落）'
}

/* ───────────────────────── list：看能烧什么 ───────────────────────── */

export function listText (bot, name) {
  const q = name == null || name === '' ? null : String(name).trim().toLowerCase().replace(/^minecraft:/, '')
  if (q) {
    const out = smeltTargetOf(q)
    if (out) return `🔥 **${q}** 能烧成 **${out}**（背包里有 ${countOf(bot, itemIdOf(bot, q))} 个）`
    const ins = smeltInputsFor(bot, q)
    if (ins.length) {
      const withHave = ins.map((n) => `${n}（有 ${countOf(bot, itemIdOf(bot, n))}）`)
      return `🔥 想烧出 **${q}**，可以烧：${withHave.join(' / ')}`
    }
    return `❌ “${name}”不在熔炼表里（烧不了，也烧不出来）。`
  }
  const lines = []
  const can = []
  for (const n of Object.keys(bot?.registry?.itemsByName ?? {})) {
    const out = smeltTargetOf(n)
    if (!out) continue
    const have = countOf(bot, itemIdOf(bot, n))
    if (have > 0) can.push(`  · ${n} ×${have} → ${out}`)
  }
  lines.push(`🔥 背包里现在能烧的（${can.length} 项）：`)
  lines.push(...(can.length ? can : ['  （没有 —— 先用 mc_dig 挖点矿石/沙/圆石，或 mc_craft 做点吃的）']))
  const fuels = fuelListOf(bot)
  lines.push(`　燃料：${fuels.length
    ? fuels.map((f) => `${f.name}×${f.have}（够烧 ${Math.floor(f.have * f.per)} 个）`).join('、')
    : '没有（挖点煤，或者把原木烧成木炭）'}`)
  lines.push('　常见的：煤炭 8 个、木炭 8 个、木板/原木 1.5 个、木棍 0.5 个、煤炭块 80 个、烈焰棒 12 个、干海带块 20 个、熔岩桶 100 个。')
  return lines.join('\n')
}

/* ───────────────────────── 盯熔炉 ───────────────────────── */

/**
 * 盯着熔炉烧，直到产物够了 / 火灭了 / 超时。
 * 🔴 不靠"算时间"，而是读熔炉自己的 `progress`（当前进度）和 `fuel`（当前燃料还能烧多久）：
 *    没火了（`fuel<=0` 且燃料槽空）但输入槽还有东西 → 自己补燃料。所以表里数字不准也不怕。
 * @returns {{got:number, why:string}} why ∈ done|noinput|nofuel|timeout|closed
 */
export async function waitForOutput (win, target, { budgetMs = 60_000, refill = null, maxRefill = 4 } = {}) {
  const t0 = Date.now()
  let refills = 0
  let badStreak = 0
  /** 读熔炉槽位；窗口被关掉/出错时返回 {v:null, bad:true}，不要把它当成"槽是空的" */
  const read = (fn) => {
    try {
      if (typeof win?.[fn] !== 'function') return { v: null, bad: true }
      return { v: win[fn](), bad: false }
    } catch { return { v: null, bad: true } }
  }
  while (Date.now() - t0 < budgetMs) {
    const o = read('outputItem')
    const got = o.v?.count ?? 0
    if (got >= target) return { got, why: 'done' }
    const i = read('inputItem')
    const fi = read('fuelItem')
    const fuel = Number(win?.fuel) || 0
    // 连着几次都读不出来 ⇒ 窗口已经关了，别硬报"输入槽空了"
    if (o.bad && i.bad && fi.bad) {
      badStreak++
      if (badStreak >= 3) return { got, why: 'closed' }
      await sleep(250)
      continue
    }
    badStreak = 0
    if (!i.v && got < target) return { got, why: 'noinput' }
    // 火灭了、燃料槽也空了、还有东西没烧完 → 补燃料
    if (!fi.v && fuel <= 0 && i.v) {
      if (!refill || refills >= maxRefill) return { got, why: 'nofuel' }
      const added = await refill()
      if (!added) return { got, why: 'nofuel' }
      refills++
    }
    await sleep(250)
  }
  return { got: read('outputItem').v?.count ?? 0, why: 'timeout' }
}

/* ───────────────────────── 工具 ───────────────────────── */

export async function apply (api) {
  const { ctx, asTool, getSession, logLine } = api

  ctx.tools.register(asTool({
    name: 'mc_furnace',
    description: '🔥 **熔炼**（真熔炼，走服务端的熔炉，不是作弊给物）。生存模式下"粗铁 → 铁锭 → 铁镐"就靠它。\n'
      + '· 能烧：矿石/粗矿（铁、铜、金、远古残骸…）、沙 → 玻璃、圆石 → 石头、原木 → 木炭、'
      + '生肉/马铃薯 → 熟的、黏土球 → 砖、海带 → 干海带、仙人掌 → 绿色染料 等等。\n'
      + '· **写产物名也行**：`name:"iron_ingot"` 会自动找背包里的粗铁/铁矿石去烧。\n'
      + '· 附近没有熔炉、但背包里有，就**自己放到脚边**再用（`placeFurnace:false` 可关）；'
      + '都没有会告诉你去 `mc_craft {name:"furnace"}` 做一个（8 个圆石）。\n'
      + '· **自己挑燃料**：按要烧的数量算，一次放够 —— 有煤炭/木炭就先烧煤（木棍、原木、木板是合成料，'
      + '只有没有正经燃料时才拿来烧）；要烧 1 个放 1 块煤（够烧 8 个），要烧 9 个放 2 块。'
      + '可以 `fuel:"coal"` 指定；`list:true` 看背包里有哪些燃料。\n'
      + '· 🔴 **装好料就返回，不用盯着**：炉子在服务端自己烧。默认**不盯**（`maxWaitSec` 默认 0，'
      + '最多给 10 秒）；过一会儿再叫一次 `mc_furnace` 就能收成品（不用重新装料）。'
      + '要烧很多就少量多次（一次最多装 8 个）。\n'
      + '· `takeOnly:true` = 只把熔炉里已经烧好的拿走（不新塞东西）；`dryRun:true` 只出计划。\n'
      + '🔴 熔炼会动世界里的熔炉，所以**受 mc_observe 门禁限制**（强制模式要先看）。',
    parameters: {
      name: { type: 'string', description: '要烧的东西（英文 id 或简称，如 raw_iron），也可以写产物名（如 iron_ingot）' },
      count: { type: 'number', description: '想要几个产物（默认 1，一次最多装 8 个）' },
      fuel: { type: 'string', description: '指定燃料（可选），如 coal / stick；不给就自己挑' },
      x: { type: 'number', description: '指定熔炉坐标 x（可选，和 y/z 一起给）' },
      y: { type: 'number', description: '指定熔炉坐标 y（可选）' },
      z: { type: 'number', description: '指定熔炉坐标 z（可选）' },
      radius: { type: 'number', description: '附近找熔炉的半径（默认 6，最大 12）' },
      placeFurnace: { type: 'boolean', description: '附近没熔炉时自己放一个（默认 true）' },
      takeOnly: { type: 'boolean', description: '只取已经烧好的，不新塞（默认 false）' },
      maxWaitSec: { type: 'number', description: '最多盯多少秒（**默认 0 = 不盯**；最多 10）' },
      list: { type: 'boolean', description: '只看熔炼表和燃料（不烧）' },
      dryRun: { type: 'boolean', description: '只出计划，不动手（默认 false）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (args, value) => [{ type: 'text', text: String(value?.text ?? JSON.stringify(value, null, 2)) }],
    },
    timeoutMs: CALL_MS + 1_000,
    async execute (args, exec) {
      const sess = getSession(exec)
      const mc = sess.bot
      const bot = mc.requireBot() // 不在线会抛带原因的错
      // 🔴 等区块也算进"这一轮 11 秒"
      await withTimeout(mc.waitForChunks(), CALL_MS, '等待区块加载')

      /* ① list：只看表 */
      if (args.list === true) return { text: listText(bot, args.name) }

      const radius = clamp(Number(args.radius) || 6, 1, 12)
      const wantPos = { x: args.x, y: args.y, z: args.z, radius }
      const allowPlace = args.placeFurnace !== false
      // 🔴 默认 0 = 不盯：装好料就返回，下次再叫一次取成品（用户要求：熔炉不用一直看着）
      const maxWaitSec = clamp(Number(args.maxWaitSec) || DEFAULT_MAX_WAIT_SEC, 0, MAX_WAIT_SEC)

      /* ② 解析烧炼物 */
      let t
      try { t = resolveSmelt(bot, args.name) } catch (e) { return { text: `❌ ${e.message}` } }
      const inId = itemIdOf(bot, t.input)
      const outId = itemIdOf(bot, t.output)
      const have = countOf(bot, inId)
      const want = clamp(Math.round(Number(args.count) || 1), 1, 512)

      const head = []
      if (t.note) head.push(`　${t.note}`)

      /* ③ 找熔炉（没有就放一个） */
      let fblock = findFurnaceBlock(bot, wantPos)
      /* 🔴 报告 H18（2026-10-13）：给了坐标就**只认那个坐标**。以前"上次用过的熔炉"这条兜底
       *    排在 H6 守卫（下面那段）**之前** ⇒ 给了坐标、那里又不是熔炉时，会偷偷拿记忆里
       *    那个旧熔炉去烧/取（用户以为在 A 处烧，其实在 B 处）。所以先把 `askedPos` 算出来。 */
      const askedPos = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))
      // 上次用过/自己放的那个熔炉还认 —— radius 给小了（比如 1）也能接着用（但给了坐标时不认）
      if (!fblock && !askedPos && bot.__wcLastFurnace) {
        const last = bot.__wcLastFurnace
        const b2 = blockAtXYZ(bot, last.x, last.y, last.z)
        if (b2 && FURNACE_NAMES.includes(b2.name)) fblock = b2
      }
      let placedNote = null
      /* 🔴 2026-10-08 审计 H6：**给了坐标却在那里找不到熔炉**时，以前会照走"没熔炉就放一个"这条路
       *    ⇒ 在脚边另造一个新熔炉，然后对着它烧/取。给了坐标就只认那个坐标。 */
      if (!fblock && askedPos) {
        /* 🔴 报告 H17（2026-10-13）：这里原来写 `listText(bot, { radius })` —— 而 `listText(bot, name)`
         *    第二个参数是**物品名**（`String({radius:6})` ⇒ `"[object Object]"`）⇒ 用户看到的是
         *    `❌ "[object object]"不在熔炼表里`。这里要的是"附近有哪些熔炉"，自己扫一遍。 */
        const nearF = (bot.findBlocks({ matching: (x) => FURNACE_NAMES.includes(x?.name), maxDistance: 16, count: 3 }) ?? [])
          .map((p) => `${blockAtXYZ(bot, p.x, p.y, p.z)?.name ?? 'furnace'}(${p.x},${p.y},${p.z})`)
        const lines = [...head, `❌ (${args.x},${args.y},${args.z}) 那里**不是**熔炉（读到的是 ${blockAtXYZ(bot, args.x, args.y, args.z)?.name ?? '空气/没加载'}）。`,
          '　→ 我**没有**另放新熔炉（免得你对着一个自己不知道的炉子烧/取）。',
          nearF.length ? `　附近 16 格内的熔炉：${nearF.join('、')}` : '　附近 16 格内也没找到别的熔炉 —— 要新放一个的话就别给坐标。']
        logLine(`mc_furnace：给的坐标 (${args.x},${args.y},${args.z}) 上没有熔炉，没另放`)
        return { text: lines.join('\n') }
      }
      if (!fblock && allowPlace) {
        const inv = furnaceInInventory(bot)
        if (inv) {
          const spots = findPlaceSpots(bot, { radius: 2, limit: 3 })
          const spot = spots[0] ?? null
          if (spot && args.dryRun === true) {
            placedNote = `（dryRun：附近没熔炉，真跑的时候我会把背包里的 ${inv.name} 放到 (${spot.x},${spot.y},${spot.z})）`
            fblock = { position: spot, name: inv.name, virtual: true }
          } else if (spot) {
            /* 🔴 实机（2026-10-08）：一个点位被服务端拒（目标格被自己占着 / 客户端世界失步 / 站位太靠边）
             *    换下一个点位往往就成了 ⇒ 最多试 3 个候选，别一个点位失败就报"放不下"。 */
            const refused = []
            for (const s of spots) {
              if ((mc.callLeft?.() ?? 9_999) < 900) break
              try {
                const r = await mc.placeBlock({ x: s.x, y: s.y, z: s.z, name: inv.name })
                if (r?.placed) {
                  /* 客户端收到方块更新会晚一拍：立刻查常常还是 null。放完轮询几百毫秒再认。 */
                  for (let i = 0; i < 6 && !fblock; i++) {
                    fblock = findFurnaceBlock(bot, { x: s.x, y: s.y, z: s.z })
                    if (!fblock) await sleep(150)
                  }
                  placedNote = fblock
                    ? `（附近本来没有熔炉，我把背包里的 ${inv.name} 放到 (${s.x},${s.y},${s.z}) 了${refused.length ? ` —— 前 ${refused.length} 个点位服务端没收` : ''}）`
                    : `（方块放出去了，但客户端还没收到方块更新，读不到 (${s.x},${s.y},${s.z}) 上的熔炉 —— 过一会儿再叫我一次）`
                  logLine(`mc_furnace：自动放了 ${inv.name} (${s.x},${s.y},${s.z})${fblock ? '' : '（还没读到）'}${refused.length ? `（换了 ${refused.length} 个点位）` : ''}`)
                  break
                }
                refused.push(`(${s.x},${s.y},${s.z})：${r?.note ?? '未知原因'}`)
              } catch (e) {
                refused.push(`(${s.x},${s.y},${s.z})：${e.message}`)
              }
            }
            if (!fblock && !placedNote) {
              placedNote = `（想放熔炉，试了 ${refused.length} 个点位都没成功：${refused.join('；')} —— 先用 \`mc_move\` 走到平整点的地面上，再叫我一次）`
            }
          } else {
            placedNote = '（想放熔炉，但脚边找不到能放的空位）'
          }
        }
      }
      if (!fblock) {
        const inv = furnaceInInventory(bot)
        const lines = [...head]
        if (placedNote) lines.push(placedNote)
        lines.push(`❌ 附近 ${radius} 格没有熔炉，背包里${inv ? `有 ${inv.name}×${inv.have} 但放不下` : '也没有'}。`)
        lines.push('　→ 先做一个：`mc_craft {name:"furnace"}`（8 个圆石），然后叫我（我会自己放）；')
        lines.push('　　或者你自己 `mc_act {mode:"place",name:"furnace",x:…,y:…,z:…}` 放到脚边。')
        logLine(`mc_furnace：${t.output} 找不到熔炉`)
        return { text: lines.join('\n') }
      }
      if (placedNote) head.push(placedNote)
      const fp = fblock.position
      const fname = FURNACE_NAMES.includes(fblock.name) ? fblock.name : 'furnace'
      const fast = /blast_furnace|smoker/.test(fname)
      head.push(`　🔥 熔炉：(${fp.x},${fp.y},${fp.z})${fast ? ` —— ${fname}，烧得快一倍` : ''}`)

      /* ④ 走/飞到够得着（openFurnace 要 4.5 格内） */
      if (!fblock.virtual) {
        try {
          const p = bot.entity.position
          if (p && p.distanceTo?.(fp) > 4) {
            await mc.walkTo({ x: fp.x, y: fp.y, z: fp.z }, { arrive: 2.2, budget: 20_000 })
          }
        } catch (e) {
          logLine(`mc_furnace：靠近熔炉没成功（${e.message}），还是试着开一下`)
        }
      }

      /* ⑤ dryRun：先把计划写出来，不动手 */
      if (args.dryRun === true) {
        const canPlan = Math.min(want, have)
        const needNow = clamp(Math.min(canPlan, MAX_LOAD), 1, 512)
        const f = pickFuel(bot, needNow, [outId, inId], args.fuel)
        const lines = [...head]
        lines.push(`🧾 熔炼计划：**${t.input} ×${canPlan}** → ${t.output} ×${canPlan}`)
        if (!have) lines.push(`　⚠️ 背包里一个 ${t.input} 都没有 —— ${hintFor(t.input)}`)
        else {
          lines.push(`　这一轮装 ${needNow} 个（一次最多装 ${MAX_LOAD} 个${maxWaitSec > 0 ? `、最多盯 ${maxWaitSec} 秒` : '、装好就返回不盯着'}；背包里有 ${have} 个，想要 ${want} 个）`)
          lines.push(`　这一炉全烧完要 ${needNow * (fast ? SEC_PER_ITEM / 2 : SEC_PER_ITEM)} 秒 —— 装好料后过一会儿再叫一次 mc_furnace 取成品`)
          lines.push(`　燃料：${f ? `${f.name} ×${f.count}（${f.label}，1 个能烧 ${f.per} 个${f.kind === 1 ? ' —— 背包里没有煤炭/木炭，只能烧建材' : ''}）` : '❌ 没有可用的燃料'}`)
          if (!f) lines.push('　→ 挖点煤（`mc_dig {name:"coal_ore"}`），或者拿原木/木板/木棍当燃料')
        }
        return { text: lines.join('\n') }
      }

      /* ⑥ 背包里没料 ≠ 烧不了 —— 上一轮可能已经把料装进炉子里了。
       *    先记一笔，开了炉子看输入槽再决定要不要报错（takeOnly 例外：它只是去收成品） */
      const missingInput = args.takeOnly !== true && !have

      /* ⑦ 开熔炉 */
      let win = null
      try {
        win = await withTimeout(bot.openFurnace(fblock), callBudget(10_000), '开熔炉')
        bot.__wcLastFurnace = { x: fp.x, y: fp.y, z: fp.z }
      } catch (e) {
        logLine(`mc_furnace：打不开熔炉 ${e.message}`)
        return { text: [...head, `❌ 打不开熔炉 (${fp.x},${fp.y},${fp.z})：${e.message}`].join('\n') }
      }
      const notes = []
      try {
        /* ⑧ takeOnly：只收成品 */
        if (args.takeOnly === true) {
          const out = safeCall(win, 'outputItem')
          const n = out?.count ?? 0
          if (!n) return { text: [...head, '　熔炉里没有烧好的东西。'].join('\n') }
          const free = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null
          if (free === 0) {
            /* 🔴 审计 H5：背包满时 `putAway` 会 `tossLeftover()` 把成品**丢到地上**。宁可先不取。 */
            logLine(`mc_furnace：背包满了，没敢取 ${out.name ?? t.output} ×${n}`)
            return {
              text: [...head, `⚠️ 熔炉里烧好了 **${out.name ?? t.output} ×${n}**，但**背包满了** —— 我没取（取出来会掉在地上）。`,
                '　→ 先腾位置（`mc_chest` 存起来 / 扔掉没用的），再叫一次 `mc_furnace {takeOnly:true}`。'].join('\n'),
            }
          }
          const before = countOf(bot, outId)
          await withTimeout(win.takeOutput(), callBudget(10_000), '取成品')
          /* 🔴 审计 H4：`takeOutput` resolve 只代表"服务端处理了这次点击"，背包那格要等 `set_slot` 到客户端。
           *    以前这里立刻读 ⇒ 报出"收走了 ×4（背包里现在有 0 个）"，AI 以为东西丢了。 */
          const got = await awaitOutput(bot, outId, before, n)
          const still = safeCall(win, 'outputItem')?.count ?? 0
          logLine(`mc_furnace：只收了 ${out.name ?? t.output} ×${n}`)
          const lines = [...head]
          if (got >= before + n) lines.push(`✅ 收走了熔炉里的 **${out.name ?? t.output} ×${n}**（背包里现在有 ${got} 个）`)
          /* 🔴 实机（2026-10-08）：服务端的 `set_slot` 有时比 1.2 秒还晚 ⇒ 旧文案会吓人地说"只多出 0 个"。
           *    输出槽已经空了 = 东西**确实**被收走了，只是背包那格还没同步 —— 按这个如实说。 */
          else if (still === 0) lines.push(`✅ 收走了熔炉里的 **${out.name ?? t.output} ×${n}**（输出槽已经空了；背包同步慢一拍，过一会儿 \`mc_inventory\` 再看）`)
          else lines.push(`⚠️ 取成品了，但背包里只多出 **${got - before}** 个（要的是 ${n} 个）—— 可能还在同步，过一会儿 \`mc_inventory\` 再看。`)
          if (still > 0) lines.push(`　（输出槽里还剩 ${still} 个 —— 背包可能放不下，或者服务端还没处理完）`)
          return { text: lines.join('\n') }
        }

        /* ⑨ 炉子里现在有什么 */
        const alreadyIn = safeCall(win, 'inputItem')
        const alreadyOut = safeCall(win, 'outputItem')
        // 背包空、炉子输入槽也空 ⇒ 是真的没料
        if (missingInput && !alreadyIn) {
          logLine(`mc_furnace：没有 ${t.input}，烧不了 ${t.output}`)
          return {
            text: [...head, `❌ 背包里没有 **${t.input}**，炉子里也没有 —— 烧不了 ${t.output}。`, `　→ ${hintFor(t.input)}`].join('\n'),
          }
        }
        if (alreadyOut && alreadyOut.name !== t.output) {
          return {
            text: [...head, `⚠️ 熔炉里已经有 **${alreadyOut.name} ×${alreadyOut.count}** 了，和 ${t.output} 不是一样东西 —— 先把那个拿走，我再烧。`,
              `　（\`mc_furnace {takeOnly:true}\` 可以只收成品。）`].join('\n'),
          }
        }
        if (alreadyIn && alreadyIn.name !== t.input) {
          return {
            text: [...head, `⚠️ 熔炉里已经有 **${alreadyIn.name} ×${alreadyIn.count}** 了，和 ${t.input} 不是一样东西 —— 先清一下我再烧。`].join('\n'),
          }
        }

        /* ⑩ 这一轮还要不要装料：想要的 − 炉子里已有的（在烧的 + 已烧好的），一次最多装 MAX_LOAD 个
         *    —— 上一轮装的还没烧完时 add=0，这一轮就只是"来看一眼、把烧好的收走"，不会再塞。
         *    🔴 2026-10-08 审计 H3：`batch` 是"这一轮**总共**要有多少在炉子里"，
         *    不是"这一轮要装进去多少"。旧代码炉里已有同类料时一个都不装（`if (!alreadyIn)`），
         *    却把 batch 当"装进去的量"报出去、还说"不用再装料" ⇒ 要 8 个铁锭实际只烧炉里那 3 个。 */
        const perItemSec = fast ? SEC_PER_ITEM / 2 : SEC_PER_ITEM
        const room = Math.max(0, MAX_LOAD - (alreadyIn?.count ?? 0))
        const add = Math.max(0, Math.min(have, want - (alreadyIn?.count ?? 0) - (alreadyOut?.count ?? 0), room))
        const batch = add

        /* ⑪ 燃料 + 装料（只有真要装料时才动背包） */
        let f = null
        let fuelId = null
        if (batch > 0) {
          f = pickFuel(bot, batch, [outId, inId], args.fuel)
          if (!f) {
            const lines = [...head]
            lines.push(`❌ 背包里没有能当燃料的东西，烧不了（要烧 ${t.input} ×${batch}）。`)
            lines.push('　→ 挖点煤：`mc_dig {name:"coal_ore",count:3}`；或者拿原木/木板/木棍当燃料（木头 1.5 个、木棍 0.5 个）。')
            logLine(`mc_furnace：${t.output} 没有燃料`)
            return { text: lines.join('\n') }
          }
          fuelId = itemIdOf(bot, f.name)
          if (f.count > f.have) {
            notes.push(`（燃料不太够：想放 ${f.name} ×${f.count}，背包里只有 ${f.have} 个 —— 会边烧边看，不够就告诉你）`)
          }
          /* 🔴 审计 H3：只要有**装得下且还缺**的量就补料 —— 炉里已有 3 个、想要 8 个，就该再装 5 个。 */
          if (add > 0) await withTimeout(win.putInput(inId, null, add), callBudget(15_000), '放烧炼物')
          const alreadyFuel = safeCall(win, 'fuelItem')
          const needPut = Math.max(0, f.count - (alreadyFuel?.count ?? 0))
          if (needPut > 0 && (!alreadyFuel || alreadyFuel.name === f.name)) {
            await withTimeout(win.putFuel(fuelId, null, Math.min(needPut, f.have)), callBudget(15_000), '放燃料')
          } else if (alreadyFuel && alreadyFuel.name !== f.name) {
            notes.push(`（燃料槽里已经有 ${alreadyFuel.name} ×${alreadyFuel.count}，就不另加了）`)
          }
        }

        /* ⑫ 默认**不盯**（maxWaitSec = 0）：料装好就返回，炉子在服务端自己烧。
         *    只有模型明确说要等（maxWaitSec 1~10）才盯一小会儿 —— 出来一个就先收走。 */
        const t0 = Date.now()
        let r = { why: 'nowatch' }
        let ms = 0
        const refill = async () => {
          const stillIn = safeCall(win, 'inputItem')?.count ?? 0
          const again = pickFuel(bot, Math.max(1, stillIn || batch), [outId, inId], args.fuel)
          if (!again || again.count <= 0 || again.have <= 0) return false
          const put = Math.min(again.count, again.have)
          if (put <= 0) return false
          try {
            await withTimeout(win.putFuel(itemIdOf(bot, again.name), null, put), callBudget(15_000), '补燃料')
            notes.push(`（火灭了，补了 ${again.name} ×${put}）`)
            return true
          } catch { return false }
        }
        if (maxWaitSec > 0) {
          const leftMs = Math.max(600, Math.min(maxWaitSec * 1000, mc.msLeft?.() ?? CALL_BUDGET_MS))
          r = await waitForOutput(win, 1, { budgetMs: leftMs, refill })
          ms = Date.now() - t0
        }

        /* ⑬ 收成品（背包满就先不取：`putAway` 会把成品丢地上，见审计 H5） */
        const out = safeCall(win, 'outputItem')
        const gotSlot = out?.count ?? 0
        const invBefore = countOf(bot, outId)
        let took = 0
        let fullWarn = 0
        const free = typeof bot.inventory?.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : null
        if (gotSlot > 0 && free === 0) fullWarn = gotSlot
        else if (gotSlot > 0) {
          await withTimeout(win.takeOutput(), callBudget(10_000), '取成品')
          took = gotSlot
        }
        const invGot = await awaitOutput(bot, outId, invBefore, took)

        /* ⑭ 报告：这一轮收到多少 + 炉子里还剩什么、大概还要多久 */
        const lines = [...head, ...notes]
        const leftIn = safeCall(win, 'inputItem')
        const leftFuel = safeCall(win, 'fuelItem')
        const prog = Number(win?.progress) || 0
        if (fullWarn > 0) {
          lines.push(`⚠️ 熔炉里烧好了 **${out?.name ?? t.output} ×${fullWarn}**，但**背包满了** —— 我没取（取出来会掉在地上）`)
          lines.push('　→ 先腾位置（`mc_chest` 存起来 / `mc_act {mode:"toss"}` 扔掉没用的），再叫一次 mc_furnace')
        } else if (took > 0) {
          const real = invGot - invBefore
          const slotLeft = safeCall(win, 'outputItem')?.count ?? 0
          if (real >= took) lines.push(`✅ 这一轮收到 **${out?.name ?? t.output} ×${took}**${ms > 0 ? `（盯了 ${(ms / 1000).toFixed(1)}s）` : ''}`)
          /* 🔴 实机（2026-10-08）：`takeOutput` 之后背包那格有时要 1 秒以上才更新（服务端 `set_slot` 晚到）。
           *    输出槽空了 = 确实收到了 —— 别因为背包还没同步就报"只多出 0 个"吓唬模型。 */
          else if (slotLeft === 0) lines.push(`✅ 收走了 **${out?.name ?? t.output} ×${took}**（输出槽已经空了；背包同步慢一拍，过一会儿 \`mc_inventory\` 再看）`)
          else lines.push(`⚠️ 取成品了，但背包里只多出 **${real}** 个（要的是 ${took} 个）—— 输出槽里还剩 ${slotLeft} 个，可能背包放不下；先 \`mc_inventory\` 看看`)
        } else if (leftIn) {
          lines.push(`⏳ 还在烧（当前这个 ${Math.round(prog * 100)}%${ms > 0 ? `，盯了 ${(ms / 1000).toFixed(1)}s` : ''}）`)
        } else {
          lines.push(`⚠️ 没收到成品：${whyText(r.why)}`)
        }
        if (leftIn) {
          /* 输入槽里那叠**包含正在烧的那个**，所以"后面还要几个"要减 1 —— 否则 2 个 0% 会报 30 秒（实际 20 秒） */
          const rest = Math.max(0, (leftIn.count ?? 0) - 1)
          const etaSec = Math.max(1, Math.ceil((1 - prog) * perItemSec + rest * perItemSec))
          lines.push(`　炉子里还在烧：${leftIn.name} ×${leftIn.count}（当前这个 ${Math.round(prog * 100)}%），大概还要 **${etaSec} 秒**`)
          lines.push(`　→ 过一会儿再叫一次 \`mc_furnace {name:"${args.name}", count:${Math.max(1, want - took)}}\` 取成品就行（**不用再装料**）`)
        } else if (batch > 0 && took === 0) {
          lines.push('　（料是这一轮刚装进去的，还没烧出第一个来）')
        }
        lines.push(`　背包里现在有 **${t.output} ×${invGot}**`)
        if (leftFuel) lines.push(`　燃料槽还剩 ${leftFuel.name} ×${leftFuel.count}`)
        /* 还想要几个：扣掉这一轮真收到的、以及炉子里还在烧的（审计旁注：以前没扣 invBefore，会多报） */
        const remain = Math.max(0, want - Math.max(0, invGot - invBefore) - (leftIn?.count ?? 0))
        if (remain > 0 && !leftIn) lines.push(`　还想要 ${remain} 个的话，再叫我一次：mc_furnace {name:"${args.name}", count:${remain}}`)

        // 🔴 `mc.inventory()` 回的是 `{ text, held, items }`，**不是数组** —— 这里以前写
        // `Array.isArray(inv) ? … : []`，条件永远为假，这行"背包：…"从来没打印过。
        const inv = mc.inventory()
        const bag = Array.isArray(inv?.items) ? inv.items.slice(0, 12) : []
        if (bag.length) lines.push('　背包：' + bag.map((i) => `${i.name}×${i.count}`).join('、'))
        logLine(`mc_furnace：${t.input}→${t.output} 得到 ${took} 个（${ms}ms，装了 ${batch} 个，燃料 ${f?.name ?? '（上一轮放的）'}）`)
        return { text: lines.join('\n'), input: t.input, output: t.output, got: took, loaded: batch, fuel: f?.name ?? null }
      } finally {
        try { if (typeof win?.close === 'function') win.close() } catch { /* 关不上就算了 */ }
      }
    },
  }))

  logLine('mc_furnace 已加载：工具 mc_furnace（自动找/放熔炉、按要烧的数量挑正经燃料、装好就返回不盯着、过一会儿再叫一次收成品；受看图门禁限制）')
}

/** 没烧成的原因，说人话 */
export function whyText (why) {
  switch (why) {
    case 'done': return '烧好了'
    case 'nowatch': return '没等（默认不盯熔炉 —— 料装好了，过一会儿再叫一次来收成品）'
    case 'noinput': return '输入槽空了（东西可能被别的东西占了，或者数量对不上）'
    case 'nofuel': return '燃料用完了，背包里也没有能当燃料的了（挖点煤，或者拿原木/木板/木棍当燃料）'
    case 'timeout': return '等太久了（这次最多等这么久，剩下的下次再来）'
    case 'closed': return '熔炉被关掉了'
    default: return String(why ?? '未知原因')
  }
}
