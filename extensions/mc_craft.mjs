/**
 * mc_craft —— 真·合成能力（mcp-mc-agent 扩展）
 *
 * 需求（用户 2026-10-06 转述 MC 里那个 AI 的原话）：插件 31 个工具里**没有合成/开容器**，
 * 生存模式下做不了"原木 → 木板 → 工作台 → 木镐"这条最基础的链路；它试 `/craft` 又被指令白名单拒了。
 * （`/craft` 本来也不是原版指令，原版只有 `/recipe`——所以不该靠白名单绕，而是把真能力补上。）
 *
 * 做法：mineflayer **自带** craft 插件（`lib/plugins/craft.js`），bot 上有
 *   `bot.craft(recipe, count, craftingTable)` / `bot.recipesFor(...)` / `bot.recipesAll(...)`。
 * 本文件把它们包成工具 `mc_craft`，并补上 mineflayer 没做的事：
 *   ① **递归规划**：原料不够但能再合成（原木→木板→木棍）就自动排好顺序一起做，
 *      不再需要 AI 自己一步步算（它算错过，也会因此反问 Master）。
 *   ② **自动用/放工作台**：附近没有工作台、但背包里有，就自己放到脚边再用（mineflayer 只会抛错）。
 *   ③ **缺料报告**：缺什么、缺几个、现有几个，并给出下一步该调哪个工具。
 *   ④ 名字解析（`planks` → `oak_planks` 这种）、`list` 看配方、`dryRun` 只出计划。
 *
 * 装法：放在 `<profile>/node_modules/mcp-mc-agent/extensions/` 下即自动加载（插件 index.js:4089 的扩展点）。
 *
 * 门禁：**不**加进 mc_observe 的 `DEFAULT_GATED` —— 合成只动背包、不动世界，不需要"先看一眼"。
 * （`mc_furnace` 会动世界里的熔炉，所以它进。）
 *
 * 环境变量：无。参数都在工具调用里。
 */
import {
  clamp, itemNameOf, itemIdOf, blockIdOf, countOf, canPlaceInto, blockAtXYZ, findPlaceSpot,
} from './mc_util.mjs'
import { withTimeout, CALL_MS } from '../src/core.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* 上面这些原来在本文件里定义，2026-10-06 搬到 `mc_util.mjs`（mc_chest / mc_furnace / mc_observe 也用
 * 同一份；箱子工具不该去 import 合成工具）。这里再导出一次，老的 `from './mc_craft.mjs'` 不用改。 */
export { itemNameOf, itemIdOf, blockIdOf, canPlaceInto, blockAtXYZ, findPlaceSpot }

export const name = 'mc_craft'

/** 工作台方块名（目前只有一种） */
const TABLE_NAMES = ['crafting_table']
/** 一次规划最多做多少次单次合成（防止 AI 写个巨大 count 把服务器点爆） */
const MAX_TIMES = 64
/** 递归规划的最大深度（原木→木板→木棍→木镐 这种 4 层足够） */
const MAX_DEPTH = 4

/* ───────────────────────── 基础查询（都能脱离真实 bot 单测） ───────────────────────── */
/* 名字 ↔ id 互转、`countOf`、`canPlaceInto`、`vec3Of`、`blockAtXYZ` 2026-10-06 搬到
 * `mc_util.mjs`（mc_chest / mc_furnace / mc_observe 也用同一份）—— 文件顶部的 import 与再导出里都有。 */

/** 找工作台：给了 x/y/z 就查那一格；否则在 radius 内找最近的一个 */
export function findTableBlock (bot, { x, y, z, radius = 4 } = {}) {
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z))) {
    const b = blockAtXYZ(bot, x, y, z)
    return b && /crafting_table/.test(b.name) ? b : null
  }
  // 🔴 必须用**方块 id**（blocksByName），不是物品 id：1.13+ 两套 id 不同
  // （1.21.10：crafting_table 物品 332 / 方块 205；oak_log 物品 134 / 方块 49），
  // 而 mineflayer 的 findBlock 比的是 block.type（方块 id）——传物品 id 永远找不到，
  // 会退化成"明明脚边有工作台却以为没有，又去放一个"（2026-10-06 实机踩到）。
  const ids = TABLE_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return null
  try { return bot.findBlock({ matching: ids, maxDistance: clamp(Number(radius) || 4, 1, 8) }) ?? null } catch { return null }
}

function recipesAllOf (bot, id, table) {
  try { return bot.recipesAll(id, null, table) ?? [] } catch { return [] }
}

function recipesReady (bot, id, table, minCount) {
  try { return bot.recipesFor(id, null, minCount, table) ?? [] } catch { return [] }
}

/**
 * 某样东西"够不够得着"：3 = 现在就有 / 现在就能做出来，1 = 有一点但不够，0 = 没有也做不出来。
 * 只看背包（或调用方给的虚拟背包）+ 配方，**不改任何状态**，纯探路。
 * 🔴 为什么要它：只按"现在有几个"排，会在"背包里只有原木、还没有木板"时挑错木种 ——
 *   `crafting_table` 有 12 条配方（每个木种一条），这时 12 条的 full/part 全是 0，
 *   只能按"原料 id 最小"兜底 → 挑成 `oak_planks`，而背包里其实是 `jungle_log`，
 *   于是报"缺 oak_log"，明明是同一棵树上的木头（2026-10-06 实机踩到）。
 */
function reachOf (bot, id, need, depth, cnt, memo) {
  const key = `${id}|${need}|${depth}`
  if (memo.has(key)) return memo.get(key)
  memo.set(key, 0)                              // 防配方互相引用时转圈
  const have = Number(cnt(id)) || 0
  let res
  if (have >= need) res = 3
  else if (depth <= 0) res = have > 0 ? 1 : 0
  else {
    let best = have > 0 ? 1 : 0
    for (const r of recipesAllOf(bot, id, true)) {
      const out = r.result?.count || 1
      const times = Math.max(1, Math.ceil((need - have) / out))
      let worst = 3
      for (const ing of ingredientsOf(r)) {
        worst = Math.min(worst, reachOf(bot, ing.id, ing.count * times, depth - 1, cnt, memo))
        if (worst === 0) break
      }
      if (worst >= 2) { best = 3; break }       // 这条配方的原料现在全都够 → 立刻能做
      best = Math.max(best, worst)
    }
    res = best
  }
  memo.set(key, res)
  return res
}

/**
 * 挑一条配方。
 * 🔴 真配方数据里同一样东西**每个木种/石种各有一条**（1.21.10：`crafting_table` 12 条、`wooden_pickaxe` 12 条、
 * `stick` 13 条、`furnace` 3 条），而 `Recipe.find` 的返回顺序是任意的 —— cherry 恰好排在最前，
 * 于是"手里有橡木原木却让你去找樱桃木"。所以**必须看背包**：原料现有量多的优先。
 * 都没有时按"配方越老越常见"（原料 id 越小）兜底 —— oak 的 id 最小，正好是默认木材。
 * @param {Array} list 候选配方
 * @param {(id:number)=>number} [countFn] 某物品现有几个（默认当 0；`planCraft` 传虚拟背包）
 * @param {object} [bot] 给了就多算一层 `reachOf`（原料自己不够时，看能不能用背包里的东西现做出来）
 */
/* 兜底挑料时的"最普通优先"。
 * 同一样东西常有多个变体（熔炉有 8 圆石 / 8 深板岩圆石 / 8 黑石三条配方），
 * 背包里一个都没有时 full/part/reach 全平，只按"原料 id 最小"兜底会挑出生僻的那个 ——
 * 实机（2026-10）踩到 `mc_craft {name:"furnace"}` 报「缺料（cobbled_deepslate）」，
 * 而正常玩家心里的默认材料是 cobblestone。所以给最常见的默认材料一点权重，
 * 位置放在**最后一道**（id 之前），只有前面所有判据都打平时才起作用。 */
const COMMON_INGREDIENTS = new Set([
  'oak_log', 'oak_planks', 'stick', 'cobblestone', 'stone', 'coal', 'charcoal',
  'iron_ingot', 'iron_nugget', 'gold_ingot', 'copper_ingot', 'sand', 'glass',
  'crafting_table', 'furnace', 'chest', 'torch', 'white_wool', 'leather',
  'string', 'feather', 'flint', 'gunpowder', 'paper', 'wheat',
])

function pickRecipe (list, countFn, bot = null) {
  const cnt = typeof countFn === 'function' ? countFn : () => 0
  const memo = new Map()
  const score = (r) => {
    const ings = ingredientsOf(r)
    let full = 0
    let part = 0
    let reach = 3
    let common = 0
    for (const ing of ings) {
      const have = Number(cnt(ing.id)) || 0
      if (have >= ing.count) full++
      else if (have > 0) part++
      if (bot) reach = Math.min(reach, reachOf(bot, ing.id, ing.count, 3, cnt, memo))
      if (bot && COMMON_INGREDIENTS.has(String(itemNameOf(bot, ing.id)))) common++
    }
    const minId = ings.reduce((m, i) => Math.min(m, Number(i.id) || 1e9), 1e9)
    return { full, part, reach, common, table: r?.requiresTable ? 1 : 0, n: ings.length, minId }
  }
  const scored = list.map((r) => ({ r, s: score(r) }))
  scored.sort((a, b) =>
    (b.s.reach - a.s.reach) || (b.s.full - a.s.full) || (b.s.part - a.s.part) ||
    (a.s.table - b.s.table) || (a.s.n - b.s.n) || (b.s.common - a.s.common) ||
    (a.s.minId - b.s.minId))
  return scored[0]?.r
}

/** 一条配方的原料（delta 里负数是消耗，正数是产出） */
export function ingredientsOf (recipe) {
  const out = []
  for (const d of recipe?.delta ?? []) {
    if (!d || typeof d.count !== 'number') continue
    if (d.count >= 0) continue
    out.push({ id: d.id, metadata: d.metadata ?? null, count: -d.count })
  }
  return out
}

/* ───────────────────────── 名字解析 ───────────────────────── */

/** 把 AI 写的名字解析成一个物品（planks → oak_planks；log → 背包里那种原木） */
export function resolveItem (bot, query, table) {
  const raw = String(query ?? '').trim()
  if (!raw) throw new Error('要合成什么？给个物品名，比如 name:"oak_planks"（也可以先 list:true 看当前能做什么）')
  const q = raw.toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  const byName = bot?.registry?.itemsByName ?? {}
  if (byName[q]) return { item: byName[q], note: null }
  const cands = Object.keys(byName).filter((n) => n === q || n.endsWith('_' + q) || n.includes(q))
  if (!cands.length) {
    throw new Error(`没有叫“${raw}”的物品（要写英文 id，如 oak_planks / stick / wooden_pickaxe / crafting_table；list:true 可以看当前能做什么）`)
  }
  if (cands.length === 1) return { item: byName[cands[0]], note: null }
  const scored = cands.map((n) => {
    const it = byName[n]
    const have = countOf(bot, it.id, null)
    let ok = false
    try { ok = planCraft(bot, it.id, 1, table).ok } catch { ok = false }
    return { n, it, have, ok }
  })
  const best = scored.filter((s) => s.have > 0).sort((a, b) => b.have - a.have)[0]
    ?? scored.filter((s) => s.ok)[0]
    ?? null
  if (!best) {
    throw new Error(`“${raw}”能对应 ${cands.length} 个物品（${cands.slice(0, 10).join(' / ')}`
      + `${cands.length > 10 ? ' …' : ''}），按现在的背包一个都做不出来 —— 写全名指定要哪个`)
  }
  return {
    item: best.it,
    note: `“${raw}”能对应 ${cands.length} 个物品，按"背包里有 / 现在能做"自动选了 **${best.n}**（要别的请写全名）`,
  }
}

/* ───────────────────────── 递归规划 ───────────────────────── */

/**
 * 规划"把 want 个 itemId 弄到手"需要哪些合成步骤（按执行顺序）。
 * 用**虚拟背包**记账：排过的步骤算已产出、消耗也算进去，所以不会重复合成同一样中间产物。
 * @returns {{ok:boolean, steps:Array, missing:Array, note:string|null}}
 */
export function planCraft (bot, itemId, want, table, opts = {}) {
  const maxDepth = opts.maxDepth ?? MAX_DEPTH
  const steps = []
  const missing = []
  const virt = new Map()
  const haveOf = (id) => {
    if (!virt.has(id)) virt.set(id, countOf(bot, id, null))
    return virt.get(id)
  }
  const addOf = (id, n) => virt.set(id, haveOf(id) + n)

  /**
   * 递归栈：每一层是「谁、要几个、现在有几个」。
   * 缺料报告要顺着它说清**卡在哪一步** —— 只报最底下那个叶子会把人带沟里。
   * 实机教训（2026-10-07）：机器人只有 2 块木板、做工作台要 4 块，报告只写
   * 「oak_log：需要 1，背包里有 0」，模型当场理解成"工作台要用原木做"，
   * 还以为是 `mc_craft` 数错了背包，跑去砍树。
   */
  const path = []

  /** 记一笔"缺什么"（同一个物品只记第一次，免得报告刷屏） */
  const lack = (id, need, why) => {
    if (!missing.some((m) => m.id === id)) {
      missing.push({ id, name: itemNameOf(bot, id), need, have: haveOf(id), why, via: path.filter((n) => n.id !== id) })
    }
    return false
  }

  /** 原料表按物品合并（合并步骤后会重复） */
  const aggFrom = (from) => {
    const m = new Map()
    for (const f of from) m.set(f.id, (m.get(f.id) ?? 0) + f.count)
    return [...m].map(([id, count]) => ({ id, name: itemNameOf(bot, id), count }))
  }

  const ensure = (id, need, depth) => {
    const have = haveOf(id)
    if (have >= need) return true
    if (depth <= 0) return lack(id, need, `层次太深（链条超过 ${maxDepth} 层）`)
    path.push({ id, name: itemNameOf(bot, id), need, have })
    try {
      let recipes = recipesAllOf(bot, id, table)
      const full = recipesAllOf(bot, id, true)
      let cantTable = false
      if (!recipes.length) {
        // 现在没工作台，但配方要工作台：**照样把原料走一遍**，好把"还缺什么材料"一次说清
        if (full.length && !table) { recipes = full; cantTable = true } else {
          return lack(id, need, full.length ? '需要工作台' : '没有配方：这个物品不能合成，要去挖/找（或名字写错了）')
        }
      }
      const r = pickRecipe(recipes, haveOf, bot)
      if (!r) return lack(id, need, '没有配方')
      if (r.requiresTable && !table) cantTable = true
      if (cantTable) {
        // 缺的是"能用的工作台"，不是目标物品本身 —— 报告里直接点名工作台，模型才知道该去放/做一个
        const tableId = itemIdOf(bot, 'crafting_table')
        if (tableId != null) {
          lack(tableId, 1, haveOf(tableId) > 0
            ? `需要工作台：背包里有，放到脚边就能用`
            : `需要工作台：合成 ${itemNameOf(bot, id)} 要用它（4 个木板做一个）`)
        } else lack(id, need, '需要工作台')
      }
      const out = r.result?.count || 1
      let times = Math.max(1, Math.ceil((need - have) / out))
      let capped = false
      if (times > MAX_TIMES) { times = MAX_TIMES; capped = true }
      // 先把原料凑齐（原料不够 → 递归去合成它）
      let ingsOk = true
      for (const ing of ingredientsOf(r)) {
        const sub = ensure(ing.id, ing.count * times, depth - 1)
        if (sub) addOf(ing.id, -ing.count * times) // 这一步会把它消耗掉
        else { ingsOk = false; if (!cantTable) return false }
      }
      if (cantTable || !ingsOk) return false
      addOf(id, times * out)
      steps.push({
        id, name: itemNameOf(bot, id), want: need, times, out,
        table: !!r.requiresTable, capped,
        // 🔴 把**选中的那条配方**一起带上：执行期必须照着它做，不能自己再挑一次
        // （再挑一次就可能挑成别的木种，见 runPlan 里的长注释）
        recipe: r,
        from: aggFrom(ingredientsOf(r).map((i) => ({ id: i.id, count: i.count * times }))),
      })
      return true
    } finally {
      path.pop()
    }
  }

  const ok = ensure(itemId, want, maxDepth)

  // 虚拟背包记账会把同一样东西拆成多步（先做 4 木板、再做 4 木板）——相邻的合并成一步
  for (let i = steps.length - 1; i > 0; i--) {
    const a = steps[i - 1]
    const b = steps[i]
    if (a.id === b.id && a.table === b.table) {
      a.times += b.times
      a.capped = a.capped || b.capped
      a.recipe = a.recipe ?? b.recipe
      a.from = aggFrom(a.from.concat(b.from))
      a.want = Math.max(a.want, b.want)
      steps.splice(i, 1)
    }
  }
  const note = ok ? (steps.some((s) => s.capped) ? `一次最多做 ${MAX_TIMES} 次，计划已被截断` : null) : null
  return { ok, steps, missing, note }
}

/** 把计划写成给人/模型看的文字 */
export function describePlan (plan, targetName, want) {
  const lines = []
  lines.push(`🧱 合成计划：**${targetName} ×${want}**（${plan.steps.length} 步）`)
  plan.steps.forEach((s, i) => {
    const from = s.from.length ? ` ← ${s.from.map((f) => `${f.name} ×${f.count}`).join(' + ')}` : ''
    lines.push(`  ${i + 1}. ${s.name} ×${s.times * s.out}（${s.times} 次合成${s.table ? '，用工作台' : ''}）${from}`)
  })
  if (plan.note) lines.push(`  ⚠️ ${plan.note}`)
  return lines.join('\n')
}

/** 缺料报告：缺什么、缺几个、现有几个、**卡在链条的哪一步**、下一步调什么 */
export function describeMissing (plan) {
  const lines = ['❌ 原料不够，做不了：']
  const tips = new Map() // 缺料叶子 → 链条上最靠近它的那一层（真正卡住的那一步）
  for (const m of plan.missing) {
    const why = m.why ? `（${m.why}）` : ''
    lines.push(`  · ${m.name}：需要 ${m.need}，背包里有 ${m.have}${why}`)
    // 光报叶子不够：实机里"工作台要 4 块木板、只有 2 块"被报成"oak_log：需要 1，背包里有 0"，
    // 模型于是以为"工作台要用原木做"。把整条链摆出来，它一眼就知道差的是什么、差几个。
    // 链条被 maxDepth 截断时不摆（那时候"链条"本来就不完整，说了反而误导）。
    const chain = /层次太深/.test(m.why ?? '') ? [] : (m.via ?? []).filter((n) => n.id !== m.id)
    const tip = chain.length > 1 ? chain[chain.length - 1] : null
    if (tip) {
      tips.set(m.name, tip)
      const short = Math.max(0, tip.need - tip.have)
      lines.push(`    ↳ 卡在 **${tip.name}**：要 ${tip.need}、现在只有 ${tip.have}${short ? `（差 ${short}）` : ''}`
        + `｜链条：${[...chain.map((n) => n.name), m.name].join(' → ')}`)
    } else if (chain.length === 1) {
      lines.push(`    ↳ 链条：${chain[0].name} → ${m.name}`)
    }
  }
  const hints = new Set()
  for (const m of plan.missing) {
    if (/_log$/.test(m.name)) hints.add(`原木：\`mc_dig {name:"${m.name}",count:3}\`（或者砍你附近那种树，_log 换成对应名字）`)
    else if (/_ore$|raw_/.test(m.name)) hints.add('矿石：`mc_dig {name:"iron_ore",count:3}` 或下矿找')
    else if (m.why?.includes('需要工作台')) hints.add('工作台：背包里有就 `mc_act {mode:"place",name:"crafting_table",x,y,z}` 放到脚边；没有就先 `mc_craft {name:"crafting_table"}`（4 木板）。放好后再试一次（本工具加 `placeTable:true` 会自己放）')
    else if (/cobble|stone/.test(m.name)) hints.add('石头：`mc_dig {name:"stone",count:8}`（要用镐子挖）')
    const tip = tips.get(m.name)
    if (tip && /_planks$/.test(tip.name)) {
      hints.add(`木板：**要同一种木头**（${tip.name} 要 ${tip.need} 块、现在只有 ${tip.have} 块 —— 手里混着别的木种也凑不齐）。`
        + `先 \`mc_dig {name:"${/_log$/.test(m.name) ? m.name : 'oak_log'}",count:1}\` 砍一根原木（1 根 = 4 块木板），再叫一次 mc_craft`)
    }
  }
  for (const h of hints) lines.push(`  → ${h}`)
  return lines.join('\n')
}

/* ───────────────────────── list：看配方 / 看能做什么 ───────────────────────── */

/** 某个物品的所有配方（原料 + 现有量） */
export function listRecipesFor (bot, itemId, table) {
  const all = recipesAllOf(bot, itemId, table)
  const full = recipesAllOf(bot, itemId, true)
  return {
    name: itemNameOf(bot, itemId),
    recipes: all.map((r) => ({
      out: r.result?.count || 1,
      table: !!r.requiresTable,
      from: ingredientsOf(r).map((i) => ({
        name: itemNameOf(bot, i.id), count: i.count, have: countOf(bot, i.id, null),
      })),
    })),
    needTable: all.length === 0 && full.length > 0,
  }
}

/** 当前背包能立刻合成的东西（不用工作台的那些） */
export function listCraftable (bot, table, limit = 24) {
  const byName = bot?.registry?.itemsByName ?? {}
  const out = []
  for (const n of Object.keys(byName)) {
    const it = byName[n]
    if (!it || !it.id) continue
    if (!recipesReady(bot, it.id, table, 1).length) continue
    out.push({ name: n, have: countOf(bot, it.id, null) })
    if (out.length >= limit) break
  }
  return out
}

/* ───────────────────────── 执行 ───────────────────────── */

/**
 * 这条配方的原料现在够做 times 次吗？够 → null；不够 → 缺哪些、各缺多少。
 * 用来**在动手之前**核对，而不是让 mineflayer 抛一句 `missing ingredient`（它不告诉你缺什么）。
 */
export function shortfallOf (bot, recipe, times = 1) {
  const short = []
  for (const ing of ingredientsOf(recipe)) {
    const need = ing.count * times
    const have = countOf(bot, ing.id, ing.metadata)
    if (have < need) short.push({ id: ing.id, name: itemNameOf(bot, ing.id), need, have })
  }
  return short.length ? short : null
}

/* 调试日志：默认不输出，`MCP_MC_AGENT_CRAFT_DEBUG=1` 时每步打一行（排"合成了但背包没变"这类问题时用） */
let dbgLog = () => {}
const invSnap = (bot) => {
  try {
    const items = bot.inventory.items()
    return items.length ? items.map((i) => `${i.name}x${i.count}`).join(',') : '(空)'
  } catch (e) { return `(读不到：${e.message})` }
}

/* 🔴🔴 mineflayer 的 `bot.craft()` **不可取消**：11 秒预算到点只是"我们不等了"，
 * 它内部的点格子循环还在跑（`clickWindow` 最多再挂 20 秒，`once('windowOpen')` 甚至没有超时）。
 * 这时再开一次 mc_craft，两条合成链会抢同一个窗口 —— 服务端就"格子里剩什么就做什么"。
 * 实机（2026-10-07 用户报"10 根橡木没了、多了个橡木按钮、合成一直超时"）：
 * 连着三次 `oak_planks` 超时（4589/4123/5000ms）后，背包里多出一个 `oak_button`
 * （合成格里只剩 1 块木板时，结果槽就是按钮），原木从 10 变 0（其实卡在合成格/窗口里，
 * `bot.inventory` 看不见）。所以：**同一个 bot 同时只允许一条合成链**。 */
const craftBusy = new WeakMap()      // bot -> Promise（还在跑的 bot.craft，settle 后自动清）
const craftPendingAt = new WeakMap() // bot -> 开始时间（挂太久就当它死了）
const CRAFT_STUCK_MS = 25_000        // mineflayer 自己的 clickWindow 20 秒会抛；超过这个还没动静就是真挂了

const trackCraft = (bot, p) => {
  const t = p.then(() => {}, () => {})
  craftBusy.set(bot, t)
  craftPendingAt.set(bot, Date.now())
  t.then(() => { if (craftBusy.get(bot) === t) { craftBusy.delete(bot); craftPendingAt.delete(bot) } })
  return t
}

/* 上一条合成还在跑吗：null = 空闲 / 'busy' = 还在跑 / 'stuck-cleared' = 挂太久了（只重置计时，**不**删 busy）
 * 🔴 2026-10-08 审计 M2：以前这里 `craftBusy.delete(bot)` 把守卫**删掉**了，但 `craft.js:43` 的
 *    `await once(bot,'windowOpen')` **没有超时** —— 够不着/看不见的工作台会让它永远挂着。
 *    25 秒后守卫一没，下一次 mc_craft 就再发一次 activateBlock，两条链共用 `craft.js` 的模块级
 *    `windowCraftingTable` ⇒ 又回到"材料留在合成格、做出别的东西"。现在只重置计时、busy 一直留着，
 *    真要解锁就 `mc_connect` 重连（新 bot 对象 ⇒ WeakMap 自然失效）。 */
const craftState = (bot) => {
  const p = craftBusy.get(bot)
  if (!p) return null
  if (Date.now() - (craftPendingAt.get(bot) ?? 0) > CRAFT_STUCK_MS) {
    craftPendingAt.set(bot, Date.now())
    return 'stuck-cleared'
  }
  return 'busy'
}

/* 等上一条合成收尾：settle 了返回 true，等超时返回 false */
const craftSettled = (bot, ms) => {
  const p = craftBusy.get(bot)
  if (!p) return Promise.resolve(true)
  return Promise.race([p.then(() => true, () => true), new Promise((r) => setTimeout(() => r(false), ms))])
}

/* 背包快照（名字 → 总数），用来抓"服务端其实做出了别的东西" */
const invSnapMap = (bot) => {
  const m = new Map()
  try { for (const it of bot.inventory.items()) m.set(it.name, (m.get(it.name) ?? 0) + it.count) } catch {}
  return m
}
const invDiffText = (bot, before, expectName) => {
  const added = []
  try {
    for (const [n, c] of invSnapMap(bot)) {
      const d = c - (before.get(n) ?? 0)
      if (d > 0 && n !== expectName) added.push(`${n}×${d}`)
    }
  } catch {}
  return added.length
    ? `⚠️ 服务端其实做出了别的东西：${added.join('、')} —— 合成格的模型和服务端对不上（已经把窗口关掉、格子里的东西收回背包）`
    : null
}

/* 这个工作台现在能不能用：够得着（≤4 格）且看得见。
 * 🔴 够不着/看不见 ⇒ 服务端不理这次右键 ⇒ craft.js 里 `once('windowOpen')` 永远不返回
 * （它没有超时）⇒ 整条 craft 挂到我们预算到点（实机日志里那些 4123~5000ms 的超时就是这个）。 */
const tableUsable = (bot, tbl) => {
  try {
    const p = tbl?.position
    if (!p) return false
    /* 🔴 别假定是 Vec3：假机器人/测试里就是普通 {x,y,z}（真 mineflayer 才是 Vec3） */
    const center = typeof p.offset === 'function'
      ? p.offset(0.5, 0.5, 0.5)
      : { x: (p.x ?? 0) + 0.5, y: (p.y ?? 0) + 0.5, z: (p.z ?? 0) + 0.5 }
    const me = bot?.entity?.position
    if (!me) return false
    const d = typeof me.distanceTo === 'function'
      ? me.distanceTo(center)
      : Math.hypot((me.x ?? 0) - center.x, (me.y ?? 0) - center.y, (me.z ?? 0) - center.z)
    if (!(d <= 4.0)) return false
    if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(tbl)) return false
    return true
  } catch { return false }
}

/**
 * 把玩家**自己**背包里那个 2×2 合成格（window 0 的 slot 1~4）里的东西点回背包。
 *
 * 🔴 为什么必须做（2026-10-08 实机反馈：AI 在公屏说"材料像是被吞了"）：
 *    `closeMaybeWindow()` 只关**容器**窗口（工作台/熔炉）；玩家自己的 2×2 合成格
 *    **没有窗口可关** —— 上一次合成被 11 秒预算掐断后，材料就留在那 4 个格子里：
 *    `bot.inventory` 看不见它们（于是报"缺料"），而下一次 `bot.craft()` 又带着
 *    "客户端以为空格子、服务端里还堆着东西"的错位去点，服务端"格子里剩什么就做什么"
 *    （日志里 `⚠️ 服务端其实做出了别的东西：oak_planks×5` 就是这么来的）。
 *    点回背包用 `bot.moveSlotItem`（= 两次 clickWindow），一次点一格，点不动就停手 ——
 *    别在合成还在跑的时候乱点。真点不动就如实报 + 让模型 `mc_connect` 重连（重连也会退回去）。
 *
 * @returns {Promise<string[]>} 搬回去的东西（`["oak_planksx5"]`），没搬就空数组
 */
/**
 * 跟服务端对一次窗口账。
 *
 * 🔴 为什么必须先做这一步（2026-10-13 用户报"合成方块还是会卡在合成栏里"）：
 *    1.17.1+ 的服务端"只在它认为客户端记录过期时才回包"，**被它忽略的点击永远不回**
 *    ⇒ 客户端这份 `bot.inventory.slots` 会一直停在"合成格是空的"，而服务端里其实还堆着东西。
 *    这时去点那 4 个格子等于睁眼瞎（循环里 `win.slots[slot]` 全是 null），材料就一直卡着。
 *    `bot._syncWindow(窗口)`（`mineflayer\lib\plugins\inventory.js:853-870`）发一个
 *    `stateId:-1` 的空点击，服务端**必回**整窗内容 ⇒ 客户端模型被刷成服务端的真实状态。
 *    老版本 mineflayer 没有 `stateIdUsed` 特性时它是空操作（立刻 return，不会挂）。
 */
const syncNextAt = new WeakMap() // bot -> 下次允许对账的时间（成功 0.8 秒内不重复；**失败后退避 8 秒**，别连着卡）
const resyncInventory = async (bot, msLeft = () => Infinity) => {
  try {
    if (typeof bot?._syncWindow !== 'function' || !bot.inventory) return false
    if (Date.now() < (syncNextAt.get(bot) ?? 0)) return false
    syncNextAt.set(bot, Date.now() + 800)
    const left = msLeft() ?? Infinity
    const ms = Number.isFinite(left) ? Math.max(300, Math.min(1_200, left - 300)) : 1_200
    try {
      await withTimeout(Promise.resolve(bot._syncWindow(bot.inventory)), ms, '同步背包窗口')
    } catch (e) {
      /* 服务端没回包（超时/断线）：退避 8 秒再试 —— 否则每次关窗口都白等一个超时 */
      syncNextAt.set(bot, Date.now() + 8_000)
      throw e
    }
    await new Promise((r) => setTimeout(r, 150))
    return true
  } catch { return false }
}

async function clearCraftGrid (bot, msLeft = () => Infinity) {
  const win = bot?.inventory
  if (!win?.slots) return []
  /* 🔴 先跟服务端对账再动手。只在"4 个合成格看起来全是空的"时候对 ——
   *    这正是客户端模型过期（服务端里还压着东西）的样子；格子里看得见东西就不用白跑一趟。 */
  if ([1, 2, 3, 4].every((s) => !win.slots[s])) await resyncInventory(bot, msLeft)
  const moved = []
  for (let slot = 1; slot <= 4; slot++) {         // 0 = 合成结果槽，1~4 = 2×2 合成格
    const it = win.slots[slot]
    if (!it) continue
    if ((msLeft() ?? Infinity) < 400) break
    let dest = null
    try {
      dest = typeof win.firstEmptyInventorySlot === 'function' ? win.firstEmptyInventorySlot() : null
    } catch { dest = null }
    if (dest == null) break
    try {
      await withTimeout(Promise.resolve(bot.moveSlotItem(slot, dest)), 1_200, '把合成格里的东西收回背包')
      moved.push(`${it.name}x${it.count}`)
    } catch { break }
  }
  /* 🔴 万一两次点击中间被打断（东西还捏在光标上），关窗口会把它**掉在地上** —— 先放回背包。
   *    `bot.moveSlotItem` 是"拿起来 + 放下"两次点击，第二次超时就是这个状态。 */
  try {
    if (win.selectedItem) {
      const held = `${win.selectedItem.name}x${win.selectedItem.count}`
      const dest2 = typeof win.firstEmptyInventorySlot === 'function' ? win.firstEmptyInventorySlot() : null
      if (dest2 != null) {
        await withTimeout(Promise.resolve(bot.clickWindow(dest2, 0, 0)), 1_200, '把手上的东西放回背包')
        moved.push(`${held}（光标上那件）`)
      }
    }
  } catch {}
  return moved
}

async function runPlan (bot, plan, table, timeoutMs, notes = [], msLeftFn = null) {
  const done = []
  /* 🔴 bot 是裸 mineflayer bot，`msLeft()` 在 McBot 上 —— 由调用方把函数递进来 */
  const msLeft = () => msLeftFn?.() ?? Infinity
  /* 关掉残留的**容器**窗口（不动合成格）。`bot.craft()` 的 2×2 那条路是拿 `bot.inventory`
   * 的格子号去点 `bot.currentWindow`（craft.js 里 `clickWindow` 不传窗口）—— 工作台窗口还开着
   * 的时候，格子号就串到工作台窗口上：服务端把材料放进工作台、结果槽变成"格子里剩什么就做什么"，
   * 而这些东西全在窗口里、`bot.inventory` 看不见（"背包里 0 根原木"就是这么来的）。
   * 关窗口 = 服务端把合成格里的东西退回背包。 */
  const closeContainer = async () => {
    try {
      if (bot.currentWindow && bot.currentWindow !== bot.inventory) {
        await withTimeout(Promise.resolve(bot.closeWindow(bot.currentWindow)), 1_500, '关掉残留的合成窗口')
      }
    } catch {}
  }
  const closeMaybeWindow = async () => {
    await closeContainer()
    /* 🔴 容器窗口关掉还不够：**自己背包的 2×2 合成格没有窗口可关** ——
     *    掐断合成后留在格子里的材料必须点回背包，否则下一次合成会拿错位的格子号去点
     *    （实机日志：`⚠️ 服务端其实做出了别的东西：oak_planks×5`、"背包里 0 根原木"）。
     *    🔴 审计 M1：**只在"上一条合成确实收尾了"之后才点**（点走正在跑的那条链刚放进去的原料，
     *    它下一轮 `findInventoryItem` 就会抛 missing ingredient，或者把料放回去再点结果槽）。 */
    const grid = await clearCraftGrid(bot, msLeft)
    if (grid.length) notes.push(`（合成格里还剩 ${grid.join('、')}：已经点回背包了）`)
  }
  /* 开头先清干净。🔴 但**上一条合成还在跑时只关窗口、不点合成格**（审计 M1）：
   * 点走它刚放进去的原料，它下一轮 `findInventoryItem` 就会抛 missing ingredient，
   * 或者把料放回去再点结果槽 ⇒ 服务端"格子里剩什么就做什么"。
   * 等它收尾之后再清，交给下面的重试循环处理。 */
  if (craftBusy.get(bot)) await closeContainer()
  else await closeMaybeWindow()
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i]
    // 🔴 单次调用 ≤11 秒：做到一半就停，剩下的步骤让 AI 再叫一次接着做
    if (msLeft() < 400) {
      notes.push(`这一轮的 11 秒用完了：第 ${i + 1}~${plan.steps.length} 步还没做 —— 再叫一次 mc_craft 接着做`)
      break
    }
    /* 🔴 有工作台就**一律用工作台**，哪怕这条配方 2×2 背包也能做。
     * 实机（2026-10）踩到：mineflayer 的 2×2 背包合成走 `bot.inventory`，
     * 而 `craft.js` 的 `grabResult()` 里 `bot.putAway(0)` 用的是 `bot.currentWindow`，
     * 窗口状态一错就卡 20 秒报 `Event updateSlot:0 did not fire within timeout of 20000ms`，
     * 合成格里的材料还可能丢掉。工作台那条路稳定得多。 */
    const tbl = table ?? null
    if (s.table && !tbl) throw new Error(`合成 ${s.name} 需要工作台，但附近没有`)
    const id = itemIdOf(bot, s.name)
    const all = recipesAllOf(bot, id, tbl)
    /* 🔴 ① 优先沿用**计划里那条配方**（`s.recipe`）。
     * 真配方数据里同一样东西每个木种各一条，`Recipe.find` 的顺序里 cherry/birch 排在 oak 前面。
     * 计划是拿虚拟背包一路选下来的（同一个木种走到底），执行期要是再用 `recipesReady(...)[0]` 重挑一次，
     * 就会挑成"背包里恰好也够"的**另一个木种**：计划"橡木木板→橡木木棍→橡木镐"，
     * 第一步做了橡木木板，第二步却挑走背包里剩的桦木木板，第三步既没有 3 个橡木木板、也没有 2 根桦木木棍，
     * `recipesReady` 空 → 兜底 `recipesAllOf(...)[0]` 变成 cherry → mineflayer 抛 `missing ingredient`。
     * （2026-10-06 实机踩到：第一次调用失败、重试就成功，AI 自己都学会"重试一次"了。根因就在这。）
     */
    let rec = null
    if (s.recipe && !shortfallOf(bot, s.recipe, s.times)) rec = s.recipe
    /* ② 计划那条用不了了（背包在这中间变了）→ 重新按**真实背包**挑：
     * `pickRecipe` 会挑原料最多的那条；都没有时按"最普通的材料"（oak 系、cobblestone…）
     * 再按原料 id 最小兜底，不会挑 cherry / cobbled_deepslate。 */
    if (!rec) {
      const ready = recipesReady(bot, id, tbl, s.times * s.out)
      rec = pickRecipe(ready.length ? ready : all, (x) => countOf(bot, x, null), bot)
    }
    if (!rec) throw new Error(`合成 ${s.name} 时找不到配方（背包里的原料可能对不上）`)
    /* ③ 动手前核对原料真的在背包里；不够就换成能凑出来的那条（换个木种也算成功），
     * 实在不行就**说清楚缺什么**，别让 mineflayer 那句 missing ingredient 白跑一趟。 */
    let short = shortfallOf(bot, rec, s.times)
    if (short) {
      const alt = pickRecipe(all, (x) => countOf(bot, x, null), bot)
      if (alt && !shortfallOf(bot, alt, s.times)) {
        rec = alt
        short = null
        notes.push(`第 ${i + 1} 步「${s.name}」换了材料：改用 ${ingredientsOf(alt).map((x) => itemNameOf(bot, x.id)).join(' + ')}`)
      }
    }
    if (short) {
      throw new Error(`第 ${i + 1} 步「${s.name}」原料对不上：`
        + short.map((x) => `${x.name} 要 ${x.need} 个、背包里只有 ${x.have} 个`).join('；')
        + '（同一种木材要凑齐 —— 手里混了别的木种时先把要用的那种凑够）')
    }
    const outId = rec.result?.id ?? id
    const before = countOf(bot, outId, null)
    dbgLog(`第 ${i + 1} 步「${s.name}」×${s.times}｜配方 ${itemNameOf(bot, outId)} ← ${ingredientsOf(rec).map((x) => `${itemNameOf(bot, x.id)}×${x.count}`).join(' + ')}${tbl ? '（工作台）' : '（背包 2×2）'}｜craft 前背包 ${invSnap(bot)}`)
    /* ④ 失败重试：mineflayer 开工作台/点格子时偶尔会误报 `missing ingredient`、
     * 或者卡在窗口上（`Event updateSlot:0 did not fire ...`）；craft 正常返回但背包没变
     * （点格子没生效）也算失败。一律"关掉窗口 → 隔一下 → 再来一次"，别让 AI 自己重试。 */
    let lastErr = null
    let threw = false
    let got = 0
    const tStep = Date.now()
    for (let attempt = 0; attempt < 3; attempt++) {
      threw = false
      // 🔴 每次重试都按"本轮还剩多少时间"给超时，别 3 次各 30 秒把调用拖到 90 秒
      const leftMs = msLeft() === Infinity ? (Number(timeoutMs) || 30_000) : msLeft()
      if (leftMs < 400) { lastErr = lastErr ?? new Error('这一轮的 11 秒用完了'); break }
      const stepMs = Math.max(300, Math.min(Number(timeoutMs) || 30_000, leftMs))
      /* 🔴 上一条合成还在跑就**绝不并行**，也**不先去点合成格**（审计 M1：点走正在跑的那条链
       * 刚放进去的原料，它下一轮就会抛 missing ingredient / 做出别的东西）。
       * 顺序是：等它收尾 → 收尾了才关窗口 + 清合成格 → 还挂着就如实拒绝，宁可这一轮什么都不做。 */
      const st = craftState(bot)
      if (st) {
        const why = st === 'stuck-cleared'
          ? '上一次合成挂了太久（服务端一直没回应）'
          : '上一次合成还在跑（可能卡住了：窗口一直没回应）'
        if (st === 'stuck-cleared') notes.push(`${why} —— 我这次会先等它收尾，不会开第二条链`)
        const waitMs = Math.max(300, Math.min(1_500, msLeft() - 400))
        if (!(await craftSettled(bot, waitMs))) {
          /* 等不到收尾：关**容器窗口**（服务端会把里面的东西退回背包）。
           * 🔴 另外，链已经挂了不止 3 秒 ⇒ 它不会再动了，**顺手把自己背包 2×2 合成格里压着的东西
           *    点回背包**（`clearCraftGrid` 里会先 `resyncInventory` 跟服务端对账，否则那 4 格
           *    在客户端模型里是空的、点不动 —— 这正是"材料卡在合成格里、背包里看不见"的主因）。
           *    3 秒是留给"正常但慢的合成"的余地，免得把还在干活的链刚放进去的原料抢走（审计 M1）。 */
          await closeContainer()
          /* 🔴 报告 H5（2026-10-13）：以前这里算 `age = Date.now() - craftPendingAt.get(bot)` 再判
           *    `age > 3_000`，但 `craftState()`（`:449-451`）在**真挂死**那条路上刚刚把时间戳
           *    重置成 `Date.now()` ⇒ 这里的 `age ≈ 0` ⇒ `clearCraftGrid` 永远不跑 ——
           *    而它正是"材料卡在合成格里、背包里看不见"的修法（那次修复实际是死代码）。
           *    判据直接用 `craftState` 已经算好的结论：`st === 'stuck-cleared'` 才是真挂死
           *    （`busy` 说明还没到 25 秒，别去抢它刚放进去的原料）。 */
          const grid = st === 'stuck-cleared' ? await clearCraftGrid(bot, msLeft) : []
          throw new Error(`${why} —— 我**没有**开第二条链`
            + (grid.length
              ? `；顺手把合成格里压着的 ${grid.join('、')} 点回背包了`
              : '（只把合成窗口关掉了，格子里的东西服务端会退回背包）')
            + '。过一会儿再叫一次 mc_craft 重试；'
            + '要是还卡，就先 mc_scan 复核一眼现场（每次动手前我都会先把合成格里的材料点回背包）。')
        }
        await closeMaybeWindow()
      }
      const invBefore = invSnapMap(bot)
      try {
        /* 🔴 一次只做**一批**（count=1）：`bot.craft(rec, N)` 不保证做够 N 批 ——
         * 2026-10-08 实机：要 8 块木板只出了 4 块，下一步就撞 `原料对不上`；
         * 更糟的是"点格子点了一半被 11 秒预算掐断"会把材料留在合成格里（窗口失步）。
         * 一批一批来，每批都对账，剩下的交给下面那个补做循环。 */
        const p = bot.craft(rec, 1, tbl)
        trackCraft(bot, p)
        await withTimeout(p, stepMs, `合成 ${s.name}`)
      } catch (e) {
        threw = true
        lastErr = e
        /* 🔴 2026-10-08 审计（会话 step 642：`❌ 合成中断：合成 oak_planks 超时（5000ms）`）：
         *    mineflayer 的 `waitForWindowUpdate()` 用 `once(window, 'updateSlot:N')` 等**服务端回包**
         *    （`mineflayer\lib\plugins\inventory.js:476-488`），而 1.17.1+ 的服务端"只有它认为
         *    客户端记录过期时才回"—— 它忽略的点击**永远不回**，于是干等到 20 秒
         *    （就是 `Event updateSlot:0 did not fire within timeout of 20000ms`）。
         *    mineflayer 自己留了后门：`bot._syncWindow(窗口)`（`inventory.js:853-870`）发一个
         *    `stateId:-1` 的**空点击**，服务端必回整窗内容 ⇒ 那些挂着的 `updateSlot` 事件一起到。
         *    所以"超时"先 sync 一把再量背包，别直接判失败。 */
        const stall = /updateSlot|did not fire|超时|timeout/i.test(String(e?.message ?? ''))
        if (stall) {
          const win = bot.currentWindow && bot.currentWindow !== bot.inventory ? bot.currentWindow : bot.inventory
          try {
            if (typeof bot._syncWindow === 'function' && win) {
              await withTimeout(Promise.resolve(bot._syncWindow(win)), 1_200, '同步合成窗口')
              await new Promise((r) => setTimeout(r, 150))
            }
          } catch { /* 老版本 mineflayer / 假 bot 没有 _syncWindow 就算了 */ }
        }
        /* 🔴 报错 ≠ 没做成：`updateSlot ... did not fire` 常常是"东西已经到手、只是窗口事件丢了"
         * （mineflayer 点完格子就等事件，事件没来照样抛）。先量一下背包：真涨了就当成功 ——
         * 不然会拿着刚做好的东西再要一次材料，最后报一个假的 `missing ingredient`。
         * （2026-10-06 生产日志里 `mc_craft：torch ×4 失败：Event updateSlot:0 did not fire…` 就是这一类。） */
        got = countOf(bot, outId, null) - before
        /* 🔴 报错 ≠ 没做成，也可能"做出了**别的东西**"：窗口/格子模型串了的时候，
         * 服务端按它自己那份格子做，结果槽里是另一条配方（1 块木板 → 按钮）。
         * 拿背包前后快照一比就能看见，别让它悄悄躺在背包里让 AI 困惑。 */
        const extra = invDiffText(bot, invBefore, itemNameOf(bot, outId))
        if (extra) notes.push(`第 ${i + 1} 步「${s.name}」：${extra}`)
        if (got > 0) {
          lastErr = null
          notes.push(`第 ${i + 1} 步「${s.name}」：窗口事件丢了，但东西已经到手（${itemNameOf(bot, outId)}×${got}）`)
          await closeMaybeWindow()
          break
        }
        const msg = String(e?.message ?? '')
        // 只重试"窗口/格子没跟上"这类；真缺料、配方不对这种重试也没用
        if (!/missing ingredient|updateSlot|did not fire|timeout/i.test(msg)) { await closeMaybeWindow(); break }
        await closeMaybeWindow()
        await new Promise((r) => setTimeout(r, 400))
        continue
      }
      got = countOf(bot, outId, null) - before
      if (got > 0) { lastErr = null; break }
      lastErr = new Error('craft 正常返回但背包没变')
      await closeMaybeWindow()
      await new Promise((r) => setTimeout(r, 400))
    }
    dbgLog(`第 ${i + 1} 步「${s.name}」craft 返回（${Date.now() - tStep}ms）｜得到 ${itemNameOf(bot, outId)}×${got}｜craft 后背包 ${invSnap(bot)}`)
    /* 只做出来一部分（材料刚好不够 / 中途被打断）也如实说：别让 AI 以为数量够了 */
    const wantOut = (Number(s.out) || 1) * s.times
    /* 🔴 一次 `bot.craft(rec, N)` 有时只做出**一批**（背包 2×2 上实测过：要 8 块木板只出了 4 块），
     * 后面那一步就会拿着"只有 2 块木板"去撞 `原料对不上`。材料还够就自己把剩下的补上，
     * 一次只做一批（count=1），做不动就如实说，绝不假装数量够了。
     * 轮数上限跟要做的批数挂钩（`s.times` 批 + 1 轮容错），别写死。 */
    let made = got
    for (let round = 0; made > 0 && made < wantOut && round < Math.max(2, (Number(s.times) || 1) + 1); round++) {
      if (shortfallOf(bot, rec, 1)) break          // 材料真不够了，认
      const leftMs2 = msLeft() === Infinity ? (Number(timeoutMs) || 30_000) : msLeft()
      if (leftMs2 < 400) {
        notes.push(`这一轮的 11 秒用完了：「${s.name}」还差 ${wantOut - made} 个 —— 再叫一次 mc_craft 接着做`)
        break
      }
      const snap2 = invSnapMap(bot)
      const before2 = countOf(bot, outId, null)
      try {
        const p2 = bot.craft(rec, 1, tbl)
        trackCraft(bot, p2)
        await withTimeout(p2, Math.max(300, Math.min(Number(timeoutMs) || 30_000, leftMs2)), `补做 ${s.name}`)
      } catch (e) {
        const extra2 = invDiffText(bot, snap2, itemNameOf(bot, outId))
        if (extra2) notes.push(`补做「${s.name}」时：${extra2}`)
        dbgLog(`补做「${s.name}」第 ${round + 1} 轮抛错：${e?.message ?? e}`)
        await closeMaybeWindow()
        break
      }
      const now = countOf(bot, outId, null)
      if (now <= before2) { await closeMaybeWindow(); break }
      made = now - before
    }
    got = made
    if (got > 0 && got < wantOut) {
      notes.push(`第 ${i + 1} 步「${s.name}」只做出来 ${got} 个（本来要 ${wantOut} 个）—— 材料不够了？再叫一次 mc_craft 试试`)
    }
    if (got <= 0) {
      /* 报错前先把窗口关干净：合成格里可能还留着材料，关窗口 = 服务端把它们退回背包，
       * 不然下一轮 mc_craft 看到的还是"背包里 0 根原木"。 */
      await closeMaybeWindow()
      throw new Error(threw
        ? `第 ${i + 1} 步「${s.name}」失败：${lastErr?.message ?? '未知错误'}`
        : `第 ${i + 1} 步「${s.name}」合成没有产出（连试 3 次背包都没变 —— mineflayer 点格子没生效，材料可能留在合成格里）`)
    }
    done.push({ name: s.name, times: s.times, got })
  }
  return done
}

export async function apply (api) {
  const { ctx, asTool, getSession, logLine } = api
  dbgLog = (m) => { if (process.env.MCP_MC_AGENT_CRAFT_DEBUG === '1') logLine(`mc_craft[调试] ${m}`) }

  ctx.tools.register(asTool({
    name: 'mc_craft',
    description: '🧱 **合成物品**（真合成，走服务端的合成台，不是作弊给物）。生存模式下"原木→木板→工作台→木镐"就靠它。\n'
      + '· 会**自动补齐中间产物**：给它 `name:"wooden_pickaxe"`，它自己排"木板→木棍→木镐"的顺序一起做，不用你一步步算。\n'
      + '· 需要工作台时：附近有就直接用；附近没有但背包里有，就**自己放到脚边**再用（`placeTable:false` 可关）。\n'
      + '· 原料不够会告诉你**缺什么、缺几个、现在有几个**，并给出下一步该调哪个工具（比如先 `mc_dig` 砍原木）。\n'
      + '· `name` 可以写简称：`planks` 会自动选背包里那种原木对应的木板（选了哪个会写在结果里）。\n'
      + '· `list:true` 看配方/看当前能做什么；`dryRun:true` 只出计划不动手（拿不准就先 dryRun）。\n'
      + '· `count` 是"背包里**一共**要到几个"（默认 1）：已经够了就**一个都不做**，结果会如实说"一个都没做"。要"再做 4 个"就写 `{count:4, more:true}`。\n'
      + '· 🔴 连着两三次都"超时"就先 `mc_scan` 复核现场（我每次动手前都会先把合成格里的材料点回背包）。\n'
      + '🔴 合成只动背包、不动世界，所以**不受 mc_observe 门禁限制**。',
    parameters: {
      name: { type: 'string', description: '要合成的物品（英文 id 或简称，如 planks / stick / wooden_pickaxe）' },
      count: { type: 'number', description: '合成后背包里**一共**要有几个（默认 1）。要"再做 N 个"就加 more:true' },
      more: { type: 'boolean', description: 'count 当"再做几个"（在现有基础上加，默认 false = count 是"一共要到几个"）' },
      table: { type: 'boolean', description: '允许用工作台（默认 true）' },
      placeTable: { type: 'boolean', description: '附近没工作台时自己放一个（默认 true）' },
      x: { type: 'number', description: '指定工作台坐标 x（可选，和 y/z 一起给）' },
      y: { type: 'number', description: '指定工作台坐标 y（可选）' },
      z: { type: 'number', description: '指定工作台坐标 z（可选）' },
      radius: { type: 'number', description: '附近找工作台的半径（默认 4，最大 8）' },
      list: { type: 'boolean', description: '只看配方，不合成' },
      dryRun: { type: 'boolean', description: '只出合成计划，不动手（默认 false）' },
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

      const allowTable = args.table !== false
      const radius = clamp(Number(args.radius) || 4, 1, 8)
      const wantPos = { x: args.x, y: args.y, z: args.z, radius }

      /* ① list：只看配方 */
      if (args.list === true) {
        if (args.name == null || args.name === '') {
          const table0 = allowTable ? findTableBlock(bot, wantPos) : null
          const can = listCraftable(bot, table0)
          const lines = [`🧾 现在背包里**立刻能合成**的（${can.length} 个${table0 ? '，含用旁边工作台的' : '，不含需要工作台的'}）：`]
          if (!can.length) lines.push('  （一个都做不了——先 `mc_dig` 挖点原料，或 `mc_craft {name:"crafting_table"}` 再放下）')
          else lines.push('  ' + can.map((c) => c.name).join(' / '))
          lines.push('　看某个物品的配方：`mc_craft {list:true,name:"wooden_pickaxe"}`')
          return { text: lines.join('\n') }
        }
        const t = resolveItem(bot, args.name, allowTable ? findTableBlock(bot, wantPos) : null)
        const info = listRecipesFor(bot, t.item.id, allowTable ? findTableBlock(bot, wantPos) : null)
        const lines = [`🧾 **${info.name}** 的配方（共 ${info.recipes.length} 条）：`]
        if (!info.recipes.length) {
          lines.push(info.needTable ? '  （有配方，但需要工作台——先合成+放下工作台）' : '  （没有配方：这个物品不能合成，或名字不对）')
        }
        for (const r of info.recipes) {
          const from = r.from.map((f) => `${f.name} ×${f.count}（有 ${f.have}）`).join(' + ')
          const enough = r.from.every((f) => f.have >= f.count)
          lines.push(`  · 产出 ×${r.out}${r.table ? '（需要工作台）' : ''} ← ${from} ${enough ? '✅ 够' : '⚠️ 缺'}`)
        }
        if (t.note) lines.push(`　${t.note}`)
        return { text: lines.join('\n') }
      }

      /* ② 解析目标 + 找/放工作台 */
      let table = allowTable ? findTableBlock(bot, wantPos) : null
      let placedNote = null
      let target
      try {
        target = resolveItem(bot, args.name, table)
      } catch (e) {
        return { text: `❌ ${e.message}` }
      }
      /* 🔴 `count` 的口径（2026-10-08 实机反馈：AI 说"材料像是被吞了"）：
       *    默认是"**背包里一共要到 N 个**"（`planCraft` 的 want 就是这个意思），
       *    所以背包里已经有 13 块木板时 `{name:"oak_planks",count:4}` **一个都不做**、
       *    却回一句"✅ 合成完成" —— 模型以为做过了，再叫一次还是这句，看起来就像材料被吞。
       *    现在：① 什么都没做时如实说"一个都没做 + 你现在有几个 + 想再做几个该怎么写"；
       *          ② `more:true` = count 当"再做几个"（在现有基础上加），一句话就能表达"再做 4 个"。 */
      const wantN = clamp(Math.round(Number(args.count) || 1), 1, 1024)
      const haveNow = countOf(bot, target.item.id, null)
      const want = args.more === true ? clamp(haveNow + wantN, 1, 4096) : wantN

      /* ③ 规划：先按"手边没工作台"规划一次，只有真缺工作台才去放（免得做不需要桌子东西时也乱放） */
      let plan = planCraft(bot, target.item.id, want, table)
      /* 🔴 够不着/看不见的工作台不能用：服务端不理这次右键 ⇒ craft.js 的 `once('windowOpen')`
       * 没有超时 ⇒ 整条 craft 挂到预算到点（实机日志里那些 4123~5000ms 的超时就是这么来的）。
       * 判据用"计划里有没有哪一步要用工作台"（`s.table`），**不能**用 `plan.missing` ——
       * 有工作台的时候 missing 里当然没有 crafting_table，那条件永远不成立（第一版就是这么错的）。
       * 2×2 就能做的东西不为此多放一张桌子。 */
      if (table && !tableUsable(bot, table) && plan.steps.some((s) => s.table)) {
        placedNote = '（附近那个工作台够不着或看不见，先不用它）'
        table = null
        plan = planCraft(bot, target.item.id, want, null)
      }
      /* 🔴 只要计划里有步骤，就**尽量用工作台**（哪怕这条配方 2×2 也能做）：
       * mineflayer 的 2×2 背包合成容易卡在 `updateSlot` 上甚至丢材料（见 runPlan 的注释），
       * 而"背包里有工作台就放到脚边"几乎零成本。想省这一步可以传 placeTable:false。 */
      if (!table && allowTable && args.placeTable !== false
        && (plan.missing.some((m) => /crafting_table/.test(String(m.name))) || plan.steps.length > 0)) {
        const tid = itemIdOf(bot, 'crafting_table')
        const haveTable = countOf(bot, tid, null)
        if (haveTable > 0) {
          const spot = findPlaceSpot(bot)
          if (spot && args.dryRun === true) {
            // dryRun 不该动世界：假装桌子已经放好了，好把计划完整写出来
            table = { position: spot, virtual: true }
            placedNote = `（dryRun：附近没工作台，真跑的时候我会把背包里的工作台放到 (${spot.x},${spot.y},${spot.z})）`
          } else if (spot) {
            try {
              const r = await mc.placeBlock({ x: spot.x, y: spot.y, z: spot.z, name: 'crafting_table' })
              if (r?.placed) {
                /* 🔴 审计 G2：客户端收到方块更新晚一拍，放完**立刻**查常常还是 null ⇒
                 * 旧代码这里直接 `table = findTableBlock(...)`（零轮询）⇒ `table` 是 null ⇒
                 * 下面 `planCraft(bot, …, table)` 拿到 null ⇒ 计划没把工作台算进去，
                 * 同一条回复里既说"我把工作台放好了"又说"缺工作台"。
                 * `mc_chest.mjs` / `mc_furnace.mjs` 早就有这段轮询（6×150ms），照抄。 */
                for (let i = 0; i < 6 && !table; i++) {
                  table = findTableBlock(bot, { x: spot.x, y: spot.y, z: spot.z })
                  if (!table) await sleep(150)
                }
                placedNote = table
                  ? `（附近本来没有工作台，我把背包里的放到 (${spot.x},${spot.y},${spot.z}) 了）`
                  : `（工作台放出去了，但客户端还没收到方块更新，读不到 (${spot.x},${spot.y},${spot.z}) 上的工作台 —— 过一会儿再叫我一次）`
                logLine(`mc_craft：自动放了工作台 (${spot.x},${spot.y},${spot.z})${table ? '' : '（还没读到）'}`)
              } else {
                placedNote = `（想放工作台但没成功：${r?.note ?? '未知原因'}）`
              }
            } catch (e) {
              placedNote = `（想放工作台但失败：${e.message}）`
            }
          } else {
            placedNote = '（想放工作台，但脚边找不到能放的空位）'
          }
          if (table) plan = planCraft(bot, target.item.id, want, table)
        }
      }
      const head = []
      if (placedNote) head.push(placedNote)
      if (target.note) head.push(`　${target.note}`)
      if (table) head.push(`　🔨 工作台：(${table.position.x},${table.position.y},${table.position.z})`)

      if (!plan.ok) {
        const text = [...head, describeMissing(plan)].filter(Boolean).join('\n')
        logLine(`mc_craft：${target.item.name} ×${want} 缺料（${plan.missing.map((m) => m.name).join(',')}）`)
        return { text }
      }
      if (args.dryRun === true) {
        return { text: [...head, describePlan(plan, target.item.name, want)].filter(Boolean).join('\n') }
      }

      /* ④ 执行 */
      const t0 = Date.now()
      const notes = []
      let done
      try {
        done = await runPlan(bot, plan, table, 30_000, notes, () => mc.msLeft?.() ?? Infinity)
      } catch (e) {
        const text = [...head, ...notes, `❌ 合成中断：${e.message}`, describePlan(plan, target.item.name, want)].filter(Boolean).join('\n')
        logLine(`mc_craft：${target.item.name} ×${want} 失败：${e.message}`)
        return { text }
      }
      const ms = Date.now() - t0
      const got = countOf(bot, target.item.id, null)
      const lines = [...head, ...notes]
      /* 🔴 "一个都没做"不能报"✅ 合成完成"：`count` 是"背包里一共要到几个"，
       *    背包里已经够了的时候计划是 0 步，回"完成"会让模型以为做过了（实机原话"材料像是被吞了"）。 */
      if (!done.length) {
        lines.push(`ℹ️ 一个都没做：背包里已经有 **${target.item.name} ×${got}**`
          + `（\`count\` 是"背包里一共要到几个"，你要的 ${want} 个已经够了）`)
        lines.push(`　→ 要**再做** ${wantN} 个：\`mc_craft {name:"${target.item.name}", count:${wantN}, more:true}\``
          + `（或者 count 直接写 ${got + wantN}）`)
      } else {
        lines.push(`✅ 合成完成（${(ms / 1000).toFixed(1)}s）：${done.map((d) => `${d.name} ×${d.got}`).join('、')}`)
      }
      lines.push(`　背包里现在有 **${target.item.name} ×${got}**`)
      // 🔴 `mc.inventory()` 回的是 `{ text, held, items }`，**不是数组** —— 这里以前写
      // `Array.isArray(inv) ? … : []`，条件永远为假，这行"背包：…"从来没打印过。
      const inv = mc.inventory()
      const bag = Array.isArray(inv?.items) ? inv.items.slice(0, 12) : []
      if (bag.length) lines.push('　背包：' + bag.map((i) => `${i.name}×${i.count}`).join('、'))
      logLine(`mc_craft：${target.item.name} ×${want} ${done.length ? '完成' : '没做新的（背包里已经够了）'}`
        + `（${done.length} 步 / ${ms}ms）`)
      return { text: lines.join('\n'), steps: done, target: target.item.name, count: got }
    },
  }))

  logLine('mc_craft 已加载：工具 mc_craft（递归合成 / 自动用或放工作台 / 缺料报告；不受看图门禁限制）')
}
