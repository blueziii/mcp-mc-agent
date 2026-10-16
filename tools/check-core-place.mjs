#!/usr/bin/env node
/**
 * check-core-place.mjs —— "拿什么方块去搭"的选料检查
 *
 * 背景（用户 2026-10-06 报的 bug）："它搭方块会用非实体方块搭"。两个来源：
 *   ① `McBot.placeBlock()` 没给 name 时直接 `items[0]` —— 背包第一格是火把/树苗/门/木棍也照拿；
 *   ② `scaffoldingItemIds()` 只排掉了矿石，火把、树苗、门、半砖、楼梯全进了 pathfinder 的
 *      `scafoldingBlocks`，垫在脚下一站就掉。
 *
 * 坑在哪：光看 `boundingBox === 'block'` 不够 —— 半砖、楼梯、栅栏、墙、地毯、耕地、土径、
 * 头颅、铁砧的 `boundingBox` **也是** `'block'`、`transparent` **也是** `false`。
 * 这个脚本用**真 registry（1.21.10）**把"什么算整方块"钉死，防止这两个坑回来。
 *
 * 用法：node tools/check-core-place.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 真 registry ───────────────────────────────────────────────────────────────
// 源码树里没有 node_modules，得从包目录（<profile>/node_modules/mcp-mc-agent）借 minecraft-data。
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const loadMcData = () => {
  const bases = [
    process.env.MCP_MC_AGENT_MCDATA_BASE,
    new URL('../index.js', import.meta.url).href,                                  // 包内直接就有
    join(PROFILE, 'node_modules', 'mcp-mc-agent', 'index.js'),                      // 源码树 → 借包里的
    join(PROFILE, 'index.js'),
  ].filter(Boolean)
  for (const base of bases) {
    try {
      const m = createRequire(base)('minecraft-data')
      if (m) return m('1.21.10')
    } catch {}
  }
  return null
}
const mcData = loadMcData()
if (!mcData) {
  console.log('✗ 拿不到 minecraft-data —— 用 MCP_MC_AGENT_MCDATA_BASE 指到有它的 index.js 再跑')
  process.exit(2)
}
const reg = { blocksByName: mcData.blocksByName, itemsByName: mcData.itemsByName }

const { isFullBlockItem, scaffoldingItemIds, pickPlaceItem } = await import(new URL('../src/core.mjs', import.meta.url))
const itemId = (n) => mcData.itemsByName[n]?.id
const bag = (list) => ({ registry: reg, inventory: { items: () => list } })
/** 造背包：名字 → 一摞（默认 1 个） */
const itemsOf = (spec) => {
  const out = []
  let slot = 0
  for (const [n, c] of spec) {
    const id = itemId(n)
    if (id == null) { console.log(`  (跳过：registry 里没有物品 ${n})`); continue }
    out.push({ type: id, name: n, count: c ?? 1, slot: slot++ })
  }
  return out
}
const names = (ids) => ids.map((id) => mcData.items[id]?.name ?? String(id))

/* ─────────────────────── ① 整方块：必须认 ─────────────────────── */
section('① 整方块（能站上去、能往上叠）—— 必须认')
{
  const good = ['stone', 'dirt', 'cobblestone', 'oak_planks', 'oak_log', 'sand', 'gravel',
    'netherrack', 'end_stone', 'obsidian', 'deepslate', 'cobbled_deepslate', 'snow_block']
  for (const n of good) {
    const exists = !!mcData.blocksByName[n]
    ok(exists && isFullBlockItem(bag([]), n), `${n} 算整方块`, exists ? '' : '（registry 里没有）')
  }
}

/* ─────────────────────── ② 非整方块：必须排掉 ─────────────────────── */
section('② 非整方块 —— 必须排掉（用户报的就是这类被拿去搭）')
{
  const cases = [
    // 根本不是方块（木棍、材料）
    ['stick', '不是方块'], ['coal', '不是方块'], ['diamond', '不是方块'],
    ['apple', '不是方块'], ['string', '不是方块'], ['bucket', '不是方块'],
    // boundingBox !== 'block'
    ['torch', 'boundingBox=empty'], ['oak_sapling', 'boundingBox=empty'],
    ['oak_button', 'boundingBox=empty'], ['oak_sign', 'boundingBox=empty'],
    ['rail', 'boundingBox=empty'], ['cobweb', 'boundingBox=empty'],
    ['vine', 'boundingBox=empty'], ['redstone_torch', 'boundingBox=empty'],
    // transparent !== false
    ['oak_door', 'transparent'], ['oak_trapdoor', 'transparent'], ['ladder', 'transparent'],
    ['glass', 'transparent'], ['oak_leaves', 'transparent'], ['scaffolding', 'transparent'],
    ['bamboo', 'transparent'], ['lily_pad', 'transparent'],
    // 名字黑名单（①②都拦不住：bb=block 且 transparent=false）
    ['oak_slab', '半砖'], ['oak_stairs', '楼梯'], ['oak_fence', '栅栏'],
    ['oak_fence_gate', '栅栏门'], ['cobblestone_wall', '墙'], ['white_carpet', '地毯'],
    ['farmland', '耕地'], ['dirt_path', '土径'], ['player_head', '头颅'],
    ['skeleton_skull', '头颅'], ['anvil', '铁砧'], ['chipped_anvil', '铁砧'],
  ]
  for (const [n, why] of cases) {
    const exists = !!(mcData.blocksByName[n] || mcData.itemsByName[n])
    ok(exists && !isFullBlockItem(bag([]), n), `${n} 不算整方块（${why}）`, exists ? '' : '（registry 里没有）')
  }
  // 半砖/栅栏的 boundingBox 确实是 block —— 证明"只看 boundingBox 不够"，注释里那句话不是猜的
  ok(mcData.blocksByName.oak_slab?.boundingBox === 'block' && mcData.blocksByName.oak_slab?.transparent === false,
    'oak_slab 的 boundingBox 是 block 且 transparent 是 false（所以必须靠名字黑名单）',
    JSON.stringify({ bb: mcData.blocksByName.oak_slab?.boundingBox, tr: mcData.blocksByName.oak_slab?.transparent }))
}

/* ─────────────────────── ③ scaffoldingItemIds：垫脚料选谁 ─────────────────────── */
section('③ scaffoldingItemIds —— 垫脚料只认整方块')
{
  const b = bag(itemsOf([['torch', 8], ['oak_sapling', 3], ['stick', 5], ['oak_door', 1],
    ['oak_slab', 12], ['stone', 4], ['cobblestone', 64], ['diamond_block', 1], ['chest', 1], ['coal_ore', 2]]))
  const got = names(scaffoldingItemIds(b))
  ok(JSON.stringify([...got].sort()) === JSON.stringify(['cobblestone', 'stone'].sort()),
    '混装背包只返回 stone + cobblestone', JSON.stringify(got))
  ok(!got.includes('torch') && !got.includes('oak_sapling') && !got.includes('stick'),
    '火把/树苗/木棍 不进垫脚名单')
  ok(!got.includes('oak_door') && !got.includes('oak_slab'),
    '门/半砖 不进垫脚名单')
  ok(!got.includes('diamond_block') && !got.includes('chest') && !got.includes('coal_ore'),
    '钻石块/箱子/煤矿石（家当）不拿去垫')
  ok(got[0] === 'cobblestone', '手里多的排前面（64 个圆石 > 4 个石头）', JSON.stringify(got))

  // 空背包 / 只有垃圾 → 空数组，不抛
  ok(JSON.stringify(scaffoldingItemIds(bag([]))) === '[]', '空背包 → 空数组')
  ok(JSON.stringify(scaffoldingItemIds(bag(itemsOf([['torch', 1], ['stick', 1]])))) === '[]',
    '背包里只有火把和木棍 → 空数组（不硬塞）')
  // 没有 registry 也不炸
  ok(JSON.stringify(scaffoldingItemIds({ inventory: { items: () => itemsOf([['stone', 1]]) } })) === '[]',
    '没有 registry 时不崩，返回空数组')
  // 同一种方块叠在两个格子 → 只留一个 id
  const dup = itemsOf([['dirt', 3], ['dirt', 9]])
  ok(scaffoldingItemIds(bag(dup)).length === 1, '同一种方块占两格 → 只留一个 id',
    JSON.stringify(names(scaffoldingItemIds(bag(dup)))))
}

/* ─────────────────────── ④ pickPlaceItem：没给 name 时挑谁 ─────────────────────── */
section('④ pickPlaceItem —— 没指定方块时不能挑到火把/半砖')
{
  const pick = (spec, want = null) => pickPlaceItem(bag(itemsOf(spec)), want)

  ok(pick([['stick', 1], ['torch', 1], ['oak_sapling', 1], ['oak_slab', 1], ['oak_planks', 4]])?.name === 'oak_planks',
    '背包前几格是木棍/火把/树苗/半砖 → 挑到 oak_planks',
    pick([['stick', 1], ['torch', 1], ['oak_sapling', 1], ['oak_slab', 1], ['oak_planks', 4]])?.name)
  ok(pick([['stick', 1], ['torch', 1]]) === null,
    '背包里只有木棍和火把 → null（旧版会拿火把去搭）')
  ok(pick([['chest', 1], ['diamond_block', 1]]) === null,
    '背包里只有箱子和钻石块 → null（家当不当填充块）')
  ok(pick([['oak_slab', 2]], 'oak_slab')?.name === 'oak_slab',
    '显式给 name:"oak_slab" 就给半砖（AI 点名要的，不拦）')
  ok(pick([['torch', 1]], 'torch')?.name === 'torch',
    '显式给 name:"torch" 就给火把')
  ok(pick([['stone', 1]], 'diamond_block') === null,
    '显式点名但背包里没有 → null')
  ok(pick([]) === null, '空背包 → null')
}

/* ─────────────────────── ⑤ 全量扫描：整方块名单里不能混进形状方块 ─────────────────────── */
section('⑤ 全量扫描 1.21.10 —— 认下来的"整方块"里不能混进半砖/楼梯/栅栏/门…')
{
  // 独立词表（故意和 src/place-items.mjs 里的 NON_FULL_BLOCK 写得不一样，才算交叉验证）
  const SHAPE = /(slab|stairs|_wall$|_fence|_fence_gate$|_carpet$|_pane$|_door$|_trapdoor$|_button$|_pressure_plate$|_sign$|_banner$|_bed$|_rail$|_torch$|_candle$|_bars$|_head$|_skull$|_anvil$|_pot$|_sapling$|^farmland$|^dirt_path$)/
  const accepted = []
  for (const it of Object.values(mcData.items)) {
    const n = it?.name
    if (!n || !mcData.blocksByName[n]) continue
    if (isFullBlockItem(bag([]), n)) accepted.push(n)
  }
  const leaked = accepted.filter((n) => SHAPE.test(n))
  ok(accepted.length > 400, `认下来的整方块有 ${accepted.length} 种（够多，不是空扫）`)
  ok(leaked.length === 0, '没有形状方块混进整方块名单', leaked.slice(0, 8).join('、') || '干净')
  // 反方向：常见建材不能被误杀
  for (const n of ['stone', 'cobblestone', 'oak_planks', 'oak_log', 'dirt', 'sand', 'netherrack']) {
    ok(accepted.includes(n), `${n} 没被误杀`)
  }
}

/* ─────────────────────── ⑥ 接线：这些判据现在住在 src/place-items.mjs ─────────────────────── */
section('⑥ 接线（路线图第 ④ 条第六刀）')
{
  const coreSrc = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const placeSrc = readFileSync(new URL('../src/place-items.mjs', import.meta.url), 'utf8')
  ok(/from '\.\/place-items\.mjs'/.test(coreSrc), 'core.mjs 确实从 place-items.mjs 导入（别只搬不接）')
  ok(/export \{ isFullBlockItem, scaffoldingItemIds, pickPlaceItem \} from '\.\/place-items\.mjs'/.test(coreSrc),
    'core.mjs 保留三个公开件的同名导出（外部 import 一行都不用改）')
  ok(/export const NON_FULL_BLOCK = /.test(placeSrc) && /export const NO_SCAFFOLD = /.test(placeSrc),
    '两份名单在新模块里')
  ok(!/^const NON_FULL_BLOCK = /m.test(coreSrc) && !/^export function pickPlaceItem \(/m.test(coreSrc),
    'core.mjs 里没有残留定义（搬干净了）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
