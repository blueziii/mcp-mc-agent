#!/usr/bin/env node
/**
 * check-core-digtime.mjs —— "挖铁矿要 4.5 秒" 的回归检查（用户 2026-10-08 原话）
 *
 * 病根（**上游数据错**，不是我们的代码）：
 *   mineflayer 的 `dig()` 拿 `waitTime = bot.digTime(block)` 当**实际挖掘时长**
 *   （`lib/plugins/digging.js:27` → `:135 setTimeout(finishDigging, waitTime)` → 才发 STOP_DESTROY_BLOCK）。
 *   而 `bot.digTime` → `block.digTime(heldItem.type)` 只在
 *   `registry.materials[blk.material][itemType]` 有倍率时才把工具速度算进去。
 *   minecraft-data 1.21.9 把 **108 个"要石镐以上"的方块**（铁矿/金矿/钻石矿/黑曜石…）的 `material`
 *   写成了 **`incorrect_for_wooden_tool`** —— 原版的**品级门标签**，那张表里只有木工具
 *   （`{912:2, 913:2, 914:2, 915:2}`）⇒ 拿石/铁/钻石镐查不到倍率 ⇒ 速度按 1 算
 *   ⇒ **铁矿永远 4550ms**（真值：石镐 1150ms、铁镐 750ms）。
 *   这也解释了用户说的"**煤矿正常、铁矿不对**"（`coal_ore` 的 material 是正常的 `mineable/pickaxe`）。
 *
 * 修法（`src/core.mjs`）：
 *   ① `#fixDigMs` 按原版公式重算，只在"数据确实缺这把工具的倍率 + 手上这把确实是这类方块该用的工具
 *      + 品级够采 + 没有药水效果"时才出手（宁可不管，也不能估快 —— 估快会让服务端判"进度不够"
 *      把方块发回来，就是玩家看到的"复原"）；
 *   ② `#patchDigTime` 把 `bot.digTime` 换成修过的值（+8% + 60ms 余量）⇒ 机器人真按真值挖。
 *
 * 用法：node tools/check-core-digtime.mjs
 *   ⚠️ 必须从包目录跑（`<profile>/node_modules/mcp-mc-agent`）：源码树里没有 node_modules。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
/** 补丁统一加的余量：8% + 60ms（服务端按自己的进度判定，STOP 到早了会被判"没挖掉"） */
const withMargin = (ms) => Math.max(50, Math.round(ms * 1.08 + 60))

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'mcp-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/mcp-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const makeReg = req('prismarine-registry')
const makeBlock = req('prismarine-block')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const registry = makeReg('1.21.9')
const Block = makeBlock(registry)
const blockOf = (name) => Block.fromStateId(registry.blocksByName[name].defaultState, 0)
const itemId = (name) => registry.itemsByName[name].id

const TMP = mkdtempSync(join(tmpdir(), 'wc-digtime-'))
const mkMc = (bot) => {
  const mc = new McBot({ logFile: join(TMP, 'core.log'), instanceId: 'wc-digtime' })
  mc.bot = bot
  return mc
}
/** 假 bot：真 registry + 真 prismarine-block，`digTime` 复刻 mineflayer 的实现（`block.digTime(heldItem.type)`） */
const mkBot = ({ held = null, effects = {}, onGround = true } = {}) => {
  const bot = {
    registry,
    game: { gameMode: 'survival' },
    heldItem: held == null ? null : { type: itemId(held), name: held },
    entity: { position: new Vec3(0, 64, 0), onGround, velocity: new Vec3(0, 0, 0), isInWater: false, effects },
    inventory: { slots: [] },
    _getBlockAtEyeLevel: () => ({ name: 'air' }),
    digTime (block) { return block.digTime(this.heldItem?.type ?? null, false, false, false, [], this.entity?.effects ?? {}) },
  }
  return bot
}
/** 打了补丁之后 `bot.digTime` 应该给多少（真值 + 余量） */
const patched = (blkName, tool, upstream) => {
  const bot = mkBot({ held: tool })
  mkMc(bot).patchDigTime(bot)
  return { bot, got: bot.digTime(blockOf(blkName)), want: withMargin(upstream) }
}

// ── ① 修之前：复刻上游的错值（证明这个坑真的存在，套件不会因为上游改了数据而静默失效）──────
section('① 上游原值（证明坑存在：material 是品级门标签，速度按 1 算）')
{
  const iron = blockOf('iron_ore')
  ok(iron.material === 'incorrect_for_wooden_tool', 'iron_ore 的 material 是品级门标签（不是 mineable/pickaxe）', String(iron.material))
  const raw = (tool) => iron.digTime(tool ? itemId(tool) : null, false, false, false, [], {})
  ok(raw('stone_pickaxe') === 4550, '上游：石镐挖铁矿 4550ms（真值 1150ms）', String(raw('stone_pickaxe')))
  ok(raw('iron_pickaxe') === 4550, '上游：铁镐挖铁矿**还是** 4550ms（换镐没用）', String(raw('iron_pickaxe')))
  ok(raw('diamond_pickaxe') === 4550, '上游：钻石镐挖铁矿还是 4550ms', String(raw('diamond_pickaxe')))
  const coal = blockOf('coal_ore')
  ok(coal.material === 'mineable/pickaxe', 'coal_ore 的 material 是正常的 mineable/pickaxe（所以"煤矿正常"）', String(coal.material))
  ok(coal.digTime(itemId('stone_pickaxe'), false, false, false, [], {}) === 1150, '上游：石镐挖煤矿 1150ms（本来就是对的）')
}

// ── ② 修之后：`bot.digTime` 必须按真值给（石镐 1150 / 铁镐 750 / 钻石镐 600 / 下界合金 500）──
section('② 修之后：`bot.digTime` 按原版真值（含 8% + 60ms 余量）')
{
  const cases = [
    ['stone_pickaxe', 1150], ['iron_pickaxe', 750], ['diamond_pickaxe', 600], ['netherite_pickaxe', 500],
  ]
  for (const [tool, truth] of cases) {
    const { got, want } = patched('iron_ore', tool, truth)
    ok(got === want, `铁矿 + ${tool} ⇒ ${got}ms（真值 ${truth} + 余量 ⇒ ${want}）`, '上游原来是 4550ms')
  }
  // 金镐：minecraft-data 的 `iron_ore.harvestTools` **不含金镐** ⇒ canHarvest 假 ⇒ 按"挖不动"处理（不修）
  const gold = patched('iron_ore', 'golden_pickaxe', 15000)
  ok(gold.got === gold.want, '铁矿 + 金镐 ⇒ 按"挖不动"保守处理（数据里 harvestTools 不含金镐）', String(gold.got))
  const goldCoal = patched('coal_ore', 'golden_pickaxe', 400)
  ok(goldCoal.got === goldCoal.want, `煤矿 + 金镐 ⇒ ${goldCoal.got}ms（真值 400 最快的一把）`, `期望 ${goldCoal.want}`)
  const deep = patched('deepslate_iron_ore', 'iron_pickaxe', 1150)
  ok(deep.got === deep.want, '深板岩铁矿 + 铁镐 ⇒ 按真值 1150ms（上游 6750ms）', String(deep.got))
  const obs = patched('obsidian', 'iron_pickaxe', 250000)
  ok(obs.got > 100000, '黑曜石 + 铁镐挖不动 ⇒ 仍是上游那个 250000ms 级别的大值（不许改小）', String(obs.got))
}

// ── ③ 不许"估快"：拿错工具 / 品级不够 / 数据本来就对 —— 一个都不许改小 ──────────────────
section('③ 不许估快（估快 ⇒ 服务端判"进度不够" ⇒ 方块"复原"）')
{
  const cases = [
    ['oak_log', 'stone_pickaxe', 3000, '拿镐砍原木：种类对不上，不修'],
    ['oak_log', 'stone_axe', 750, '拿斧砍原木：数据本来就有倍率，照旧'],
    ['oak_log', null, 3000, '空手砍原木：照旧'],
    ['coal_ore', 'stone_pickaxe', 1150, '煤矿数据正常，照旧'],
    ['iron_ore', 'wooden_pickaxe', 7500, '木镐挖不动铁矿（品级不够）：上游那个 7500ms 是对的，不许改小'],
    ['stone', 'stone_pickaxe', 600, '石头数据正常，照旧'],
    ['dirt', 'stone_pickaxe', 750, '拿镐挖土：种类对不上，照旧'],
    ['grass_block', null, 900, '空手挖草方块，照旧'],
  ]
  for (const [blkName, tool, upstream, why] of cases) {
    const { got, want } = patched(blkName, tool, upstream)
    ok(got === want, `${blkName} + ${tool ?? '空手'} ⇒ ${got}ms（${why}）`, `上游 ${upstream} + 余量 ⇒ ${want}`)
  }
  // 有水：慢 5 倍的那部分也得跟着修（不然水里挖铁矿还是 4.5 秒级）
  const wet = mkBot({ held: 'iron_pickaxe' })
  wet.entity.isInWater = true
  mkMc(wet).patchDigTime(wet)
  ok(wet.digTime(blockOf('iron_ore')) === withMargin(3750), '在水里挖铁矿 ⇒ 真值 750 × 5 = 3750ms + 余量（原来 4550ms）', String(wet.digTime(blockOf('iron_ore'))))
}

// ── ④ 有药水效果时不插手（Haste / 挖掘疲劳都会改速度，宁可退回上游那个值）──────────────────
section('④ 有效果时不插手')
{
  // 注意：prismarine-block 按 **id** 查效果 ⇒ id 3 就是 MiningFatigue（上游 base 因此变成 50000ms）
  const bot = mkBot({ held: 'iron_pickaxe', effects: { 3: { id: 3, amplifier: 1, duration: 100 } } })
  mkMc(bot).patchDigTime(bot)
  const got = bot.digTime(blockOf('iron_ore'))
  ok(got === withMargin(50000), '有药水效果 ⇒ 不插手，用上游算出来的值（+余量）', String(got))
}

// ── ⑤ 边界：挖不动的方块（Infinity）要原样传下去，不能变成 0 / 不许递归 ────────────────────
section('⑤ 边界')
{
  const bot = mkBot({ held: null })
  mkMc(bot).patchDigTime(bot)
  const inf = bot.digTime(blockOf('bedrock'))
  ok(inf === Infinity || inf > 1e6, '基岩（挖不动）⇒ 原样传 Infinity / 超大值，不变成 0', String(inf))
  // 假件（没有 block.digTime）时 `#digMsFor` 走 `__wcOrigDigTime` 兜底 ⇒ 不许递归爆栈
  const fake = mkBot({ held: 'iron_pickaxe' })
  const mc = mkMc(fake)
  mc.patchDigTime(fake)
  const plain = { name: 'iron_ore', hardness: 3, material: 'incorrect_for_wooden_tool', position: new Vec3(0, 64, 0) }
  let err = null
  try { fake.digTime(plain) } catch (e) { err = e }
  ok(err != null, '没有 block.digTime 的假方块 ⇒ 照上游语义抛错（不递归爆栈、也不假装 0ms 能挖）', err ? String(err.message).slice(0, 60) : '没抛')
  // 重复打补丁不许叠（第二次直接 false）
  ok(mc.patchDigTime(fake) === false, '重复 patchDigTime 返回 false（不叠加）')
}

rmSync(TMP, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
