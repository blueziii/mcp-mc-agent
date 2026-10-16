/**
 * mc_furnace 扩展的自检：用**假 bot / 假熔炉窗口 / 假世界**跑真实扩展文件，覆盖
 *   ① 工具注册形状（且确认它**在** mc_observe 的看图门禁名单里）
 *   ② 熔炼表：正向查表（矿石/粗矿/沙/圆石/原木/生肉/工具盔甲→粒）、反向查表、边界（烧不出来的必须 null）
 *   ③ 名字解析：写烧炼物、写产物名（优先背包里真有的）、没给名字 / 不认识 → 报错说人话
 *   ④ 燃料：只认真燃料、按"浪费最少"挑、指定燃料、排除产物本身、不够时的兜底
 *   ⑤ 找熔炉：坐标指定、半径搜索（🔴 必须用**方块 id**，不是物品 id）、背包里有没有
 *   ⑥ waitForOutput：烧完 / 输入空了 / 没燃料 / 能补燃料 / 超时
 *   ⑦ 端到端 execute：附近有熔炉、没有就自己放、都没有→让人做、缺料、缺燃料、
 *      list、dryRun、takeOnly、槽里是别的东西→拒绝、开不了熔炉→报错
 * 不连 MC、不需要 DSH。**必须在包目录里跑**（core.mjs 要真 import 到 mineflayer）。
 * 跑法：cd <profile>/node_modules/mcp-mc-agent && node tools/check-mc-furnace.mjs
 */
import { readFileSync } from 'node:fs'

const EXT = new URL('../extensions/mc_furnace.mjs', import.meta.url).href

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}
const throws = (label, fn, match = null) => {
  try { const r = fn(); if (r && typeof r.then === 'function') { fail++; console.log('  FAIL ' + label + '  <<< 返回了 Promise，应该同步抛错'); return } fail++; console.log('  FAIL ' + label + '  <<< 没有抛错') } catch (e) {
    if (match && !match.test(e.message)) { fail++; console.log('  FAIL ' + label + '  <<< 错误信息不对：' + e.message) } else { pass++; console.log('  ok   ' + label) }
  }
}

const mod = await import(EXT + '?v=' + Date.now())
const {
  SMELT_EXACT, FUELS, smeltTargetOf, smeltInputsFor, resolveSmelt,
  fuelListOf, pickFuel, findFurnaceBlock, furnaceInInventory, hintFor, listText,
  waitForOutput, whyText,
} = mod

/* ─────────────────────── 假注册表 / 假背包 / 假世界 ─────────────────────── */

/** 假注册表里"方块 id"的偏移：故意和物品 id 错开，用来抓"拿物品 id 去 findBlock"的 bug */
const BLOCK_ID_BASE = 1000

const NAMES = [
  'air', 'furnace', 'blast_furnace', 'smoker', 'cobblestone', 'stone', 'smooth_stone', 'deepslate',
  'raw_iron', 'iron_ore', 'deepslate_iron_ore', 'iron_ingot', 'iron_nugget',
  'raw_copper', 'copper_ingot', 'raw_gold', 'gold_ingot', 'gold_nugget',
  'diamond', 'diamond_ore', 'netherite_scrap', 'ancient_debris',
  'sand', 'red_sand', 'glass', 'clay_ball', 'brick', 'netherrack', 'nether_brick',
  'oak_log', 'spruce_wood', 'stripped_oak_log', 'oak_planks', 'stick', 'coal', 'charcoal', 'coal_block',
  'blaze_rod', 'dried_kelp_block', 'lava_bucket', 'bamboo',
  'beef', 'cooked_beef', 'porkchop', 'cooked_porkchop', 'potato', 'baked_potato', 'kelp', 'dried_kelp',
  'iron_pickaxe', 'golden_sword', 'chainmail_chestplate', 'diamond_sword', 'wooden_axe',
  'apple', 'dirt',
]
const itemsByName = {}
const items = {}
NAMES.forEach((n, i) => { const it = { id: i + 1, name: n }; itemsByName[n] = it; items[i + 1] = it })
const idOf = (n) => itemsByName[n]?.id
const nameOf = (id) => items[id]?.name ?? ('#' + id)

function mkWorld (blocks = {}) {
  const map = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const set = (x, y, z, name) => { if (name === 'air') map.delete(key(x, y, z)); else map.set(key(x, y, z), name) }
  const get = (x, y, z) => map.get(key(x, y, z)) ?? null
  for (const [k, v] of Object.entries(blocks)) { const [x, y, z] = k.split(',').map(Number); set(x, y, z, v) }
  return { map, set, get, key }
}

function mkBot (inv = {}, opts = {}) {
  const reg = {
    items,
    itemsByName,
    blocksByName: Object.fromEntries(Object.entries(itemsByName).map(([n, it]) => [n, { id: BLOCK_ID_BASE + it.id, name: n }])),
  }
  const idIn = (n) => reg.itemsByName[n]?.id
  const nm = (id) => reg.items[id]?.name ?? ('#' + id)
  const blockIdIn = (n) => reg.blocksByName?.[n]?.id ?? idIn(n)
  const counts = new Map()
  for (const [n, c] of Object.entries(inv)) { if (idIn(n) != null) counts.set(idIn(n), c) }
  const world = opts.world ?? mkWorld()
  const pos = opts.pos ?? { x: 0.5, y: 1, z: 0.5 }
  const bot = {
    registry: reg,
    entity: { position: pos, yaw: 0, pitch: 0 },
    inventory: {
      count: (id, metadata = null) => (id == null ? 0 : (counts.get(id) ?? 0)),
      items: () => [...counts.entries()].filter(([, c]) => c > 0).map(([id, c]) => ({ type: id, name: nm(id), count: c })),
      /* 审计 H5 要用：背包满（emptySlotCount()===0）时不该取成品（取出来会掉地上） */
      emptySlotCount: () => (Number.isFinite(Number(opts.emptySlots)) ? Number(opts.emptySlots) : 36),
    },
    blockAt (p) {
      const { x, y, z } = p.floored()
      if (y < 0) return { name: 'stone', boundingBox: 'block', position: { x, y, z } }
      if (y === 0 && world.get(x, 0, z) == null) return { name: 'grass_block', boundingBox: 'block', position: { x, y, z } }
      const n = world.get(x, y, z)
      if (!n) return { name: 'air', boundingBox: 'empty', position: { x, y, z } }
      return { name: n, boundingBox: 'block', position: { x, y, z } }
    },
    /* 🔴 2026-10-15：`extensions/mc_furnace.mjs:480` 用 `bot.findBlocks(...)`（复数）扫
     *    "给的坐标上不是熔炉，附近还有哪些熔炉" —— 假 bot 原来只实现了 `findBlock`（单数）
     *    ⇒ 那条分支一跑到就 `TypeError: bot.findBlocks is not a function`。
     *    真 mineflayer 两个都有：复数版返回**坐标数组**（`{x,y,z}[]`，不是方块对象），
     *    `matching` 既可以是 id 数组、也可以是 `(block) => boolean`。这里照实模拟。 */
    findBlocks ({ matching, maxDistance = 4, count = 1 } = {}) {
      const isFn = typeof matching === 'function'
      const arr = Array.isArray(matching) ? matching : null
      const out = []
      for (const [k, n] of world.map) {
        const [x, y, z] = k.split(',').map(Number)
        const d = Math.hypot(x - pos.x, y - pos.y, z - pos.z)
        if (d > maxDistance) continue
        const blk = { name: n, boundingBox: 'block', position: { x, y, z } }
        if (isFn ? !matching(blk) : (arr ? !arr.includes(blockIdIn(n)) : false)) continue
        out.push({ x, y, z, d })
      }
      out.sort((a, b) => a.d - b.d)
      return out.slice(0, Math.max(1, Number(count) || 1)).map(({ x, y, z }) => ({ x, y, z }))
    },
    findBlock ({ matching, maxDistance = 4 }) {
      let best = null
      let bestD = Infinity
      for (const [k, n] of world.map) {
        if (!matching.includes(blockIdIn(n))) continue
        const [x, y, z] = k.split(',').map(Number)
        const d = Math.hypot(x - pos.x, y - pos.y, z - pos.z)
        if (d > maxDistance) continue
        if (d < bestD) { bestD = d; best = { name: n, boundingBox: 'block', position: { x, y, z } } }
      }
      return best
    },
  }
  return { bot, counts, world, pos, blockIdIn, lastCounts: (lastCounts = counts) }
}

/** 假熔炉窗口：行为靠 opts 调 */
/* 🔴 2026-10-08 审计 H4/H5：`takeOutput`（真身是 `putAway`）**会把成品放进玩家背包**。
 *    以前假窗口只清空输出槽、不动背包 ⇒ 套件看不出"报了收到、背包里其实 0 个"这类 bug。
 *    这里默认记账到"最近创建的那个假机器人"（绝大多数用例都是先 mkBot 再 mkWin）。 */
let lastCounts = null
function mkWin (opts = {}) {
  const counts = opts.counts ?? lastCounts
  const st = {
    input: opts.preInput ?? null,
    fuel: opts.preFuel ?? null,
    output: opts.preOutput ?? null,
    fuelTicks: opts.preFuel ? 999 : 0,
  }
  const calls = []
  const win = {
    st,
    calls,
    inputItem: () => st.input,
    fuelItem: () => st.fuel,
    outputItem: () => st.output,
    get fuel () { return st.fuelTicks },
    get progress () { return 0 },
    async putInput (id, md, count) {
      calls.push(['putInput', id, count])
      if (opts.putInputThrows) throw new Error('假服务器：输入槽塞不进去')
      /* 真的 `putInput` 会从玩家背包里把东西搬进炉子 —— 假件也要扣，否则看不出"装了多少" */
      if (counts && id != null) counts.set(id, Math.max(0, (counts.get(id) ?? 0) - count))
      st.input = { type: id, name: nameOf(id), count }
    },
    async putFuel (id, md, count) {
      calls.push(['putFuel', id, count])
      if (opts.putFuelThrows) throw new Error('假服务器：燃料槽塞不进去')
      if (counts && id != null) counts.set(id, Math.max(0, (counts.get(id) ?? 0) - count))
      st.fuelTicks = 999
      st.fuel = { type: id, name: nameOf(id), count: (st.fuel?.count ?? 0) + count }
      // 假装"燃料一进去就烧好了"（省得测试真等 10 秒）
      if (opts.cook !== false && st.input) {
        st.output = { type: opts.outId ?? st.input.type, name: opts.outName ?? nameOf(opts.outId ?? st.input.type), count: st.input.count }
        st.input = null
      }
    },
    async takeOutput () {
      calls.push(['takeOutput'])
      if (!st.output) throw new Error('assert.ok(item) —— 空槽不能取') // 真 mineflayer 就是这个行为
      const got = st.output
      st.output = null
      /* 真的 `takeOutput`（内部 `putAway`）会把成品放进玩家背包 —— 假件也记账，
       * 否则"报了收到、背包里其实 0 个"这类 bug 永远测不出来。 */
      if (counts && got?.type != null) {
        const put = () => counts.set(got.type, (counts.get(got.type) ?? 0) + (got.count ?? 0))
        /* 审计 H4：真服务端的 `set_slot` 会晚到 —— 用 takeCreditDelayMs 模拟"背包晚一拍才更新" */
        if (Number(opts.takeCreditDelayMs) > 0) setTimeout(put, Number(opts.takeCreditDelayMs))
        else put()
      }
      opts.onTake?.(got)
    },
    close () { calls.push(['close']) },
  }
  return win
}

/** 假 McBot（core.mjs 的 McBot 的替身） */
function mkMc (fake, opts = {}) {
  const placeCalls = []
  const walkCalls = []
  return {
    online: opts.online !== false,
    bot: fake.bot,
    requireBot () { if (opts.online === false) throw new Error('机器人不在线（假会话）'); return fake.bot },
    waitForChunks: async () => {},
    inventory: () => ({ held: null, items: fake.bot.inventory.items().map((i) => ({ name: i.name, count: i.count })) }),
    walkTo: async (t, o) => { walkCalls.push({ t, o }); if (opts.walkThrows) throw new Error('假走路故障'); return { arrived: true } },
    placeBlock: async ({ x, y, z, name }) => {
      placeCalls.push({ x, y, z, name })
      const failUntil = Number(opts.placeFailsFirst ?? 0)
      if (opts.placeFails || placeCalls.length <= failUntil) return { placed: false, requested: name, at: { x, y, z }, note: '假服务器拒了放置' }
      fake.world.set(x, y, z, name)
      return { placed: name, requested: name, at: { x, y, z } }
    },
    placeCalls,
    walkCalls,
  }
}

/* ─────────────────────── 假宿主 ctx / api ─────────────────────── */

const registered = new Map()
const logs = []
const sessions = new Map()
const ctx = {
  tools: { register: (def) => { registered.set(def.name, def) }, guard: () => {}, get: () => undefined },
  on: () => () => {},
  get: () => undefined,
  logger: { info: (m) => logs.push('info ' + m), warn: (m) => logs.push('warn ' + m) },
}
const api = {
  ctx,
  config: {},
  registry: { peek: (id) => sessions.get(String(id)), listSessions: () => [...sessions.values()] },
  asTool: (spec) => spec,
  getSession: (exec) => {
    const id = exec?.agent?.id
    if (!id) throw new Error('拿不到当前会话（exec.agent 不可用）')
    return sessions.get(String(id))
  },
  memory: {},
  memoryFor: () => ({}),
  workspaceOf: () => null,
  logLine: (l) => logs.push('logLine ' + l),
  Watchdog: class {},
  ensureWatchdog: () => {},
}

await mod.apply(api)
const spec = registered.get('mc_furnace')
async function run (args, { mc, id = 'A1' } = {}) {
  sessions.set(id, { agentId: id, bot: mc })
  const v = await spec.execute(args, { agent: { id } })
  return { text: String(v?.text ?? ''), value: v }
}

/* ─────────────────────── ① 工具注册 ─────────────────────── */
console.log('— ① 工具注册 —')
{
  ok(typeof mod.apply === 'function', '扩展导出 apply(api)')
  ok(mod.name === 'mc_furnace', '扩展 name = mc_furnace', mod.name)
  ok(Boolean(spec), '注册了 mc_furnace')
  ok(typeof spec.execute === 'function', '有 execute')
  ok(spec.timeoutMs > 0 && spec.timeoutMs <= 12_000, 'timeoutMs 是合理正数', String(spec.timeoutMs))
  ok(spec.timeoutMs >= 11_000 && spec.timeoutMs <= 12_000, 'timeoutMs 压在 12 秒内（单次调用 ≤11 秒 + 1 秒余量）', String(spec.timeoutMs))
  for (const k of ['name', 'count', 'fuel', 'x', 'y', 'z', 'radius', 'placeFurnace', 'takeOnly', 'maxWaitSec', 'list', 'dryRun']) {
    ok(Boolean(spec.parameters[k]), `parameters.${k} 存在`)
  }
  ok(spec.parameters.name.type === 'string', 'parameters.name 是 string')
  ok(spec.parameters.count.type === 'number', 'parameters.count 是 number')
  ok(spec.parameters.list.type === 'boolean', 'parameters.list 是 boolean')
  ok(spec.output && spec.output.schema && spec.output.schema.additionalProperties === true, 'output.schema 带 additionalProperties')
  const blocks = spec.output.render({}, { text: 'hi' })
  ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0].text === 'hi', 'render 推一个文字块')
  ok(spec.description.includes('熔炼'), '描述里说明是熔炼')
  ok(spec.description.includes('燃料'), '描述里说明会挑燃料')
  ok(spec.description.includes('mc_observe 门禁'), '描述里说明受看图门禁限制')
  ok(spec.description.includes('产物名'), '描述里说明可以写产物名')
  ok(/默认\s*0\s*=\s*不盯|默认不盯|不用盯着/.test(spec.description), '描述里说明默认不盯熔炉', spec.description.slice(0, 400))
  ok(spec.parameters.maxWaitSec.description.includes('默认 0'), 'maxWaitSec 说明默认 0（不盯）', spec.parameters.maxWaitSec.description)
  ok(logs.some((l) => l.includes('mc_furnace 已加载')), 'apply 打了加载日志', JSON.stringify(logs))
  // 门禁名单：熔炉会动世界，**该**进门禁
  const viewSrc = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')
  const gatedBlock = viewSrc.slice(viewSrc.indexOf('const DEFAULT_GATED'), viewSrc.indexOf(']', viewSrc.indexOf('const DEFAULT_GATED')))
  ok(gatedBlock.includes('mc_furnace'), 'mc_furnace 在 mc_observe 门禁名单里（会动世界里的熔炉）', gatedBlock.replace(/\s+/g, ' '))
  ok(!gatedBlock.includes('mc_craft'), 'mc_craft 仍然不在门禁名单里', gatedBlock.replace(/\s+/g, ' '))
}

/* ─────────────────────── ② 熔炼表 ─────────────────────── */
console.log('— ② 熔炼表 —')
{
  const cases = [
    ['iron_ore', 'iron_ingot'], ['raw_iron', 'iron_ingot'], ['deepslate_iron_ore', 'iron_ingot'],
    ['raw_copper', 'copper_ingot'], ['raw_gold', 'gold_ingot'], ['nether_gold_ore', 'gold_ingot'],
    ['ancient_debris', 'netherite_scrap'], ['diamond_ore', 'diamond'], ['coal_ore', 'coal'],
    ['cobblestone', 'stone'], ['cobbled_deepslate', 'deepslate'],
    ['sand', 'glass'], ['red_sand', 'glass'],
    ['clay_ball', 'brick'], ['netherrack', 'nether_brick'],
    ['beef', 'cooked_beef'], ['porkchop', 'cooked_porkchop'], ['potato', 'baked_potato'],
    ['kelp', 'dried_kelp'], ['cactus', 'green_dye'], ['wet_sponge', 'sponge'],
    ['oak_log', 'charcoal'], ['spruce_wood', 'charcoal'], ['stripped_oak_log', 'charcoal'],
    ['iron_pickaxe', 'iron_nugget'], ['golden_sword', 'gold_nugget'],
    ['chainmail_chestplate', 'iron_nugget'], ['copper_axe', 'copper_nugget'],
  ]
  for (const [inn, out] of cases) ok(smeltTargetOf(inn) === out, `${inn} → ${out}`, String(smeltTargetOf(inn)))
  // 边界：烧不出来的一律 null（宁可不烧，也不能瞎烧）
  for (const n of ['diamond', 'apple', 'dirt', 'iron_ingot', 'gold_nugget', 'coal', 'charcoal',
    'diamond_sword', 'wooden_axe', 'smooth_stone', 'oak_planks', 'iron_block', 'glass', 'brick']) {
    ok(smeltTargetOf(n) === null, `${n} 烧不出来 → null`, String(smeltTargetOf(n)))
  }
  ok(smeltTargetOf('') === null && smeltTargetOf(null) === null && smeltTargetOf(undefined) === null, '空名字 → null')
  ok(smeltTargetOf('minecraft:raw_iron') === 'iron_ingot', '带 minecraft: 前缀也认')
  ok(smeltTargetOf('RAW_IRON') === 'iron_ingot', '大小写不敏感')
  ok(SMELT_EXACT.smooth_stone === undefined, 'smooth_stone 这个"自己指向自己"的条目已被删掉')
  // 表里不能有"产物=自己"的死循环
  const selfLoop = Object.entries(SMELT_EXACT).filter(([k, v]) => k === v)
  ok(selfLoop.length === 0, '表里没有 烧炼物=产物 的死循环', JSON.stringify(selfLoop))
}

/* ─────────────────────── ③ 反向查表 / 名字解析 ─────────────────────── */
console.log('— ③ 反向查表 / 名字解析 —')
{
  const { bot } = mkBot({})
  const ironIns = smeltInputsFor(bot, 'iron_ingot')
  ok(ironIns.includes('raw_iron') && ironIns.includes('iron_ore') && ironIns.includes('deepslate_iron_ore'),
    '反查 iron_ingot → 粗铁 + 两种铁矿石', JSON.stringify(ironIns))
  const glassIns = smeltInputsFor(bot, 'glass')
  ok(glassIns.includes('sand') && glassIns.includes('red_sand'), '反查 glass → 沙子', JSON.stringify(glassIns))
  const charIns = smeltInputsFor(bot, 'charcoal')
  ok(charIns.includes('oak_log') && charIns.includes('spruce_wood') && charIns.includes('stripped_oak_log'),
    '反查 charcoal → 各种原木/木头（从注册表里枚举）', JSON.stringify(charIns))
  const nugIns = smeltInputsFor(bot, 'iron_nugget')
  ok(nugIns.includes('iron_pickaxe') && nugIns.includes('chainmail_chestplate'),
    '反查 iron_nugget → 铁工具 + 锁链甲', JSON.stringify(nugIns))
  ok(!nugIns.includes('diamond_sword') && !nugIns.includes('wooden_axe'),
    '反查 iron_nugget 不会带上钻石/木工具', JSON.stringify(nugIns))
  const goldIns = smeltInputsFor(bot, 'gold_nugget')
  ok(goldIns.includes('golden_sword'), '反查 gold_nugget → 金工具（golden_ 前缀）', JSON.stringify(goldIns))
  ok(smeltInputsFor(bot, 'apple').length === 0, '反查 apple → 空（没这回事）')
  ok(smeltInputsFor(bot, 'minecraft:iron_ingot').length > 0, '反查也认 minecraft: 前缀')

  // resolveSmelt
  const r1 = resolveSmelt(bot, 'raw_iron')
  ok(r1.input === 'raw_iron' && r1.output === 'iron_ingot' && r1.note === null, '写烧炼物 → 直接查表')
  const r2 = resolveSmelt(bot, 'iron_ingot')
  ok(r2.output === 'iron_ingot' && /raw_iron|iron_ore/.test(r2.input), '写产物名 → 反查到烧炼物', JSON.stringify(r2))
  // 背包里有的优先
  const { bot: bot2 } = mkBot({ raw_iron: 3 })
  const r3 = resolveSmelt(bot2, 'iron_ingot')
  ok(r3.input === 'raw_iron', '背包里有 raw_iron 时优先选它', JSON.stringify(r3))
  const { bot: bot3 } = mkBot({ iron_ore: 2 })
  const r4 = resolveSmelt(bot3, 'iron_ingot')
  ok(r4.input === 'iron_ore', '背包里只有 iron_ore 时选它', JSON.stringify(r4))
  const { bot: bot4 } = mkBot({})
  const r5 = resolveSmelt(bot4, 'iron_ingot')
  ok(r5.input != null && typeof r5.note === 'string' && r5.note.includes('没有'),
    '背包里都没有 → 给 note 提醒', JSON.stringify(r5))
  const { bot: bot5 } = mkBot({ raw_iron: 1, iron_ore: 1 })
  const r6 = resolveSmelt(bot5, 'iron_ingot')
  ok(typeof r6.note === 'string' && r6.note.includes('按背包里有的选了'),
    '多个候选都在背包里 → note 说明选了哪个', JSON.stringify(r6))
  throws('没给名字 → 抛错（提示怎么写）', () => resolveSmelt(bot, ''), /要烧什么/)
  throws('不认识的名字 → 抛错（提示 list）', () => resolveSmelt(bot, 'apple'), /既不是能烧的东西/)
  ok(smeltTargetOf('oak_log') === 'charcoal' && resolveSmelt(bot, 'charcoal').input === 'oak_log',
    '写 charcoal 也能反查到原木', JSON.stringify(resolveSmelt(bot, 'charcoal')))
}

/* ─────────────────────── ④ 燃料 ─────────────────────── */
console.log('— ④ 燃料 —')
{
  const { bot } = mkBot({ coal: 3, stick: 8, oak_planks: 4, blaze_rod: 1, coal_block: 1, dried_kelp_block: 1, lava_bucket: 1, apple: 5 })
  const list = fuelListOf(bot)
  ok(list.length === 7, 'fuelListOf 认出 7 种燃料（苹果不算）', String(list.length))
  ok(!list.some((f) => f.name === 'apple'), 'fuelListOf 不会把苹果当燃料')
  ok(list.find((f) => f.name === 'coal').per === 8, '煤炭 per = 8')
  ok(list.find((f) => f.name === 'coal').kind === 0, '煤炭算"正经燃料"（kind 0）')
  ok(list.find((f) => f.name === 'stick').kind === 1, '木棍算"建材"（kind 1，只在没正经燃料时才烧）')
  ok(list.find((f) => f.name === 'oak_planks').kind === 1, '木板也算建材（kind 1）')
  ok(list.find((f) => f.name === 'stick').per === 0.5, '木棍 per = 0.5')
  ok(list.find((f) => f.name === 'coal_block').per === 80, '煤炭块 per = 80（不会被当成普通煤）')
  ok(list.find((f) => f.name === 'oak_planks').per === 1.5, '木板 per = 1.5')
  ok(FUELS.every((f) => f.per > 0 && f.re instanceof RegExp), 'FUELS 每一项都有正 per 和正则')

  // 🔴 用户实测反馈：背包里明明有煤，却先放了木棍、而且只放一个。
  //    现在：① 有正经燃料（煤/木炭/煤炭块/烈焰棒/熔岩桶/干海带块）就先烧它，木棍/原木/木板只在没有正经燃料时才烧；
  //          ② 数量按"要烧几个"算够（`ceil(need / per)`），一次放够，别让炉子烧一半就断火。
  const f1 = pickFuel(bot, 1)
  ok(f1.name === 'coal' && f1.count === 1, '烧 1 个 → 有煤就放 1 块煤（不再拿木棍顶）', JSON.stringify(f1))
  const { bot: onlyStick } = mkBot({ stick: 8 })
  const f1b = pickFuel(onlyStick, 1)
  ok(f1b.name === 'stick' && f1b.count === 2, '没有正经燃料时，烧 1 个 → 2 根木棍（0.5 个/根，够烧 1 个）', JSON.stringify(f1b))
  const f1c = pickFuel(onlyStick, 4)
  ok(f1c.name === 'stick' && f1c.count === 8, '烧 4 个 → 木棍要放够 8 根（按数量算，不是固定放 1 个）', JSON.stringify(f1c))
  const { bot: onlyCoal } = mkBot({ coal: 3 })
  const f2b = pickFuel(onlyCoal, 9)
  ok(f2b.name === 'coal' && f2b.count === 2, '烧 9 个 → 煤要放 2 块（1 块只够 8 个）', JSON.stringify(f2b))
  const f2c = pickFuel(bot, 9)
  ok(f2c.name === 'blaze_rod' && f2c.count === 1, '烧 9 个（有烈焰棒时）→ 1 根烈焰棒更省（浪费 3 < 煤的 7）', JSON.stringify(f2c))
  // 要烧 8 个 → 1 块煤（浪费 0）
  const f2 = pickFuel(bot, 8)
  ok(f2.name === 'coal' && f2.count === 1, '烧 8 个 → 挑 1 块煤（浪费 0）', JSON.stringify(f2))
  // 要烧 12 个 → 1 根烈焰棒（浪费 0）而不是 2 块煤（浪费 4）
  const f3 = pickFuel(bot, 12)
  ok(f3.name === 'blaze_rod' && f3.count === 1, '烧 12 个 → 挑 1 根烈焰棒（浪费 0）', JSON.stringify(f3))
  // 要烧 20 个 → 干海带块（浪费 0）
  const f4 = pickFuel(bot, 20)
  ok(f4.name === 'dried_kelp_block' && f4.count === 1, '烧 20 个 → 挑 1 块干海带（浪费 0）', JSON.stringify(f4))
  // 要烧 100 个 → 熔岩桶（浪费 0）
  const f5 = pickFuel(bot, 100)
  ok(f5.name === 'lava_bucket' && f5.count === 1, '烧 100 个 → 挑 1 桶熔岩（浪费 0）', JSON.stringify(f5))
  // 煤炭块 80 个：烧 20 个时不该用（浪费 60），烧 80 个时该用（浪费 0）
  const { bot: b2 } = mkBot({ coal_block: 1, coal: 3 })
  ok(pickFuel(b2, 20).name === 'coal', '只有煤炭块和煤时，烧 20 个用煤（不浪费整块）', JSON.stringify(pickFuel(b2, 20)))
  ok(pickFuel(b2, 80).name === 'coal_block', '烧 80 个才动用煤炭块', JSON.stringify(pickFuel(b2, 80)))
  // 排除产物本身
  const { bot: b3 } = mkBot({ charcoal: 5, coal: 5 })
  const ex = pickFuel(b3, 8, idOf('charcoal'))
  ok(ex.name === 'coal', '产物是木炭时不会拿木炭当燃料', JSON.stringify(ex))
  // 指定燃料
  const forced = pickFuel(bot, 5, null, 'coal')
  ok(forced.name === 'coal', 'forceName 能指定燃料', JSON.stringify(forced))
  const forced2 = pickFuel(bot, 5, null, 'charcoal')
  ok(forced2.name !== 'charcoal' && forced2 != null, '指定的燃料背包里没有 → 退回自动挑', JSON.stringify(forced2))
  // 别把"要烧的原料"当燃料：烧原木成木炭时，原木本身不能拿去烧
  const { bot: b6 } = mkBot({ oak_log: 4, oak_planks: 4 })
  const inLog = idOf('oak_log')
  const exIn = pickFuel(b6, 2, [idOf('charcoal'), inLog])
  ok(exIn.name !== 'oak_log', '烧原木成木炭时不会把原木本身当燃料', JSON.stringify(exIn))
  ok(exIn.name === 'oak_planks', '排除原木之后会挑木板', JSON.stringify(exIn))
  ok(pickFuel(b6, 2, inLog).name === 'oak_planks', 'excludeId 传单个数字也认（不要求数组）', JSON.stringify(pickFuel(b6, 2, inLog)))
  const forcedIn = pickFuel(b6, 2, [idOf('charcoal'), inLog], 'oak_log')
  ok(forcedIn.name === 'oak_log', 'forceName 优先于排除 —— AI 明确要用原木当燃料就听它的', JSON.stringify(forcedIn))
  const { bot: b7 } = mkBot({ oak_log: 4 })
  ok(pickFuel(b7, 2, idOf('oak_log')) === null, '唯一能当燃料的东西正好被排除 → null（别烧原料）')
  // 不够时的兜底：挑"总热量最大"的那种，并标 enough=false
  const { bot: b4 } = mkBot({ stick: 2, coal: 1 })
  const f6 = pickFuel(b4, 40)
  ok(f6 != null && f6.enough === false, '燃料都不够时也返回一个（enough=false），让调用方补', JSON.stringify(f6))
  ok(f6.name === 'coal', '不够时挑总热量最大的（煤 8 > 木棍 1）', JSON.stringify(f6))
  // 一个都没有
  const { bot: b5 } = mkBot({ apple: 3, iron_ingot: 3 })
  ok(pickFuel(b5, 1) === null, '没有任何燃料 → null')
  ok(fuelListOf(b5).length === 0, 'fuelListOf 空背包 → []')
}

/* ─────────────────────── ⑤ 找熔炉 ─────────────────────── */
console.log('— ⑤ 找熔炉 —')
{
  // 坐标指定
  const w = mkWorld({ '2,1,0': 'furnace' })
  const { bot } = mkBot({}, { world: w })
  const b1 = findFurnaceBlock(bot, { x: 2, y: 1, z: 0 })
  ok(b1 && b1.name === 'furnace', '按坐标找到熔炉')
  ok(findFurnaceBlock(bot, { x: 3, y: 1, z: 0 }) === null, '坐标上不是熔炉 → null')
  ok(findFurnaceBlock(bot, { x: 2, y: 2, z: 0 }) === null, '坐标是空气 → null')
  // 半径搜索 —— 🔴 这里必须走**方块 id**
  const b2 = findFurnaceBlock(bot, { radius: 6 })
  ok(b2 && b2.position.x === 2, '半径搜索找到最近的熔炉', JSON.stringify(b2?.position))
  const w2 = mkWorld({ '1,1,0': 'blast_furnace', '3,1,0': 'furnace' })
  const { bot: bot2 } = mkBot({}, { world: w2 })
  ok(findFurnaceBlock(bot2, { radius: 6 }).name === 'blast_furnace', '高炉也算熔炉')
  const w3 = mkWorld({ '1,1,0': 'smoker' })
  const { bot: bot3 } = mkBot({}, { world: w3 })
  ok(findFurnaceBlock(bot3, { radius: 6 }).name === 'smoker', '烟熏炉也算熔炉')
  // 太远找不到
  const w4 = mkWorld({ '9,1,0': 'furnace' })
  const { bot: bot4 } = mkBot({}, { world: w4 })
  ok(findFurnaceBlock(bot4, { radius: 6 }) === null, '超出半径就找不到')
  // 不相关方块不会被当成熔炉
  const w5 = mkWorld({ '1,1,0': 'cobblestone' })
  const { bot: bot5 } = mkBot({}, { world: w5 })
  ok(findFurnaceBlock(bot5, { radius: 6 }) === null, '圆石不会被当成熔炉')
  // 背包里有没有
  const { bot: bot6 } = mkBot({ furnace: 2 })
  const fi = furnaceInInventory(bot6)
  ok(fi && fi.name === 'furnace' && fi.have === 2, 'furnaceInInventory 认出背包里的熔炉', JSON.stringify(fi))
  ok(furnaceInInventory(mkBot({}).bot) === null, '背包里没有熔炉 → null')
  ok(furnaceInInventory(mkBot({ blast_furnace: 1 }).bot).name === 'blast_furnace', '高炉也算')
  // hintFor
  ok(hintFor('raw_iron').includes('iron_ore'), '缺粗铁 → 提示挖铁矿石')
  ok(hintFor('iron_ore').includes('mc_dig'), '缺铁矿石 → 提示 mc_dig')
  ok(hintFor('sand').includes('mc_dig'), '缺沙子 → 提示 mc_dig')
  ok(hintFor('beef').includes('attack'), '缺生牛肉 → 提示去打猎')
  ok(hintFor('whatever').includes('mc_dig'), '不认识的 → 给通用提示')
  // listText
  const { bot: bot7 } = mkBot({ raw_iron: 3, sand: 5, coal: 2, apple: 1 })
  const lt = listText(bot7, null)
  ok(lt.includes('raw_iron') && lt.includes('sand'), 'listText 列出背包里能烧的', lt.slice(0, 80))
  ok(!lt.includes('apple'), 'listText 不会列出苹果')
  ok(lt.includes('coal') && lt.includes('够烧 16 个'), 'listText 列出燃料和能烧几个', lt.slice(-120))
  ok(listText(bot7, 'raw_iron').includes('iron_ingot'), 'listText 给单个名字 → 说烧成什么')
  ok(listText(bot7, 'iron_ingot').includes('raw_iron'), 'listText 给产物名 → 反查')
  ok(listText(bot7, 'apple').includes('不在熔炼表里'), 'listText 不认识 → 直说')
  // whyText
  for (const w of ['done', 'noinput', 'nofuel', 'timeout', 'closed']) ok(whyText(w).length > 1, `whyText(${w}) 有话说`)
  ok(whyText('nofuel').includes('燃料'), 'whyText(nofuel) 提到燃料')
  ok(whyText('zzz').length > 0, 'whyText 未知值也不炸')
}

/* ─────────────────────── ⑥ waitForOutput ─────────────────────── */
console.log('— ⑥ waitForOutput —')
{
  // 已经烧好
  const w1 = { outputItem: () => ({ count: 5 }), inputItem: () => null, fuelItem: () => null, fuel: 0 }
  const r1 = await waitForOutput(w1, 5, { budgetMs: 1000 })
  ok(r1.why === 'done' && r1.got === 5, '够数就直接 done', JSON.stringify(r1))
  // 输入槽空了、还没够
  const w2 = { outputItem: () => ({ count: 0 }), inputItem: () => null, fuelItem: () => ({ count: 1 }), fuel: 100 }
  const r2 = await waitForOutput(w2, 5, { budgetMs: 1000 })
  ok(r2.why === 'noinput', '输入槽空了 → noinput', JSON.stringify(r2))
  // 没火了、没给 refill
  const w3 = { outputItem: () => ({ count: 0 }), inputItem: () => ({ count: 3 }), fuelItem: () => null, fuel: 0 }
  const r3 = await waitForOutput(w3, 5, { budgetMs: 1000 })
  ok(r3.why === 'nofuel', '火灭了又没有 refill → nofuel', JSON.stringify(r3))
  // 没火了、有 refill
  let n = 0
  const w4 = {
    outputItem: () => ({ count: n >= 2 ? 5 : 0 }),
    inputItem: () => ({ count: 3 }),
    fuelItem: () => (n >= 2 ? { count: 1 } : null),
    fuel: 0,
  }
  const r4 = await waitForOutput(w4, 5, { budgetMs: 3000, refill: async () => { n++; return true } })
  ok(r4.why === 'done' && n >= 1, '火灭了但能补燃料 → 补上后烧完', JSON.stringify({ r4, n }))
  // refill 说补不了
  const w5 = { outputItem: () => ({ count: 0 }), inputItem: () => ({ count: 3 }), fuelItem: () => null, fuel: 0 }
  const r5 = await waitForOutput(w5, 5, { budgetMs: 3000, refill: async () => false })
  ok(r5.why === 'nofuel', 'refill 失败 → nofuel', JSON.stringify(r5))
  // refill 次数上限
  let calls = 0
  const w6 = { outputItem: () => ({ count: 0 }), inputItem: () => ({ count: 3 }), fuelItem: () => null, fuel: 0 }
  const r6 = await waitForOutput(w6, 5, { budgetMs: 5000, refill: async () => { calls++; return true }, maxRefill: 2 })
  ok(r6.why === 'nofuel' && calls === 2, 'refill 最多补 maxRefill 次就放弃', JSON.stringify({ r6, calls }))
  // 超时（一直在烧但没够）
  const w7 = { outputItem: () => ({ count: 1 }), inputItem: () => ({ count: 3 }), fuelItem: () => ({ count: 1 }), fuel: 100 }
  const t0 = Date.now()
  const r7 = await waitForOutput(w7, 5, { budgetMs: 600 })
  ok(r7.why === 'timeout' && r7.got === 1, '烧不完 → timeout，并带回已产出数', JSON.stringify(r7))
  ok(Date.now() - t0 < 3000, '超时不会拖太久', String(Date.now() - t0))
  // 窗口方法抛错（熔炉被关了）也不能炸，而且要如实说"关了"，别瞎报"输入槽空了"
  const w8 = { outputItem: () => { throw new Error('窗口关了') }, inputItem: () => { throw new Error('窗口关了') }, fuelItem: () => { throw new Error('窗口关了') } }
  const r8 = await waitForOutput(w8, 5, { budgetMs: 3000 })
  ok(r8.why === 'closed' && r8.got === 0, '窗口方法抛错 → 报 closed，不炸', JSON.stringify(r8))
  ok(whyText(r8.why).includes('关'), 'closed 的文案是"熔炉被关掉了"', whyText(r8.why))
}

/* ─────────────────────── ⑦ 端到端 execute ─────────────────────── */
console.log('— ⑦ 端到端 execute —')
{
  /* 附近有熔炉：raw_iron ×3 → iron_ingot ×3 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, coal: 2 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 3 }, { mc })
    ok(r.text.includes('这一轮收到') && r.text.includes('iron_ingot ×3'), '端到端：烧出 3 个铁锭', r.text.replace(/\n/g, ' | '))
    ok(r.value.output === 'iron_ingot' && r.value.got === 3, '返回值带 output/got', JSON.stringify(r.value))
    ok(win.calls.some((c) => c[0] === 'putInput' && c[2] === 3), '往输入槽放了 3 个', JSON.stringify(win.calls))
    ok(win.calls.some((c) => c[0] === 'putFuel'), '放了燃料', JSON.stringify(win.calls))
    ok(win.calls.some((c) => c[0] === 'takeOutput'), '取走了成品', JSON.stringify(win.calls))
    // 🔴 `mc.inventory()` 回的是 `{ held, items }`：旧代码用 `Array.isArray(inv)` 判断，
    //    永远为假 ⇒ 这行"背包：…"从来没打印过（假件以前返回数组，把这个 bug 藏住了）。
    ok(r.text.includes('背包：'), '成功报告里带上背包一览（不再是永不打印的死代码）', r.text.replace(/\n/g, ' | '))
    ok(win.calls[win.calls.length - 1][0] === 'close', '最后关了熔炉', JSON.stringify(win.calls))
    ok(mc.placeCalls.length === 0, '附近有熔炉就不用自己放')
    ok(r.text.includes('背包里现在有'), '报告里写了背包数量')
  }
  /* 附近没有熔炉，但背包里有 → 自己放 */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 2 }, { mc })
    ok(mc.placeCalls.length === 1 && mc.placeCalls[0].name === 'furnace', '附近没有就自己放一个熔炉', JSON.stringify(mc.placeCalls))
    ok(r.text.includes('我把背包里的 furnace 放到'), '报告里说明自己放了熔炉', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('这一轮收到'), '放完接着烧成功', r.text.replace(/\n/g, ' | '))
    ok(fake.world.map.get(`${mc.placeCalls[0].x},${mc.placeCalls[0].y},${mc.placeCalls[0].z}`) === 'furnace', '熔炉真的进了假世界')
  }
  /* 没有熔炉、背包里也没有 → 让人去做 */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1 })
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(r.text.includes('没有熔炉'), '没有熔炉就直说', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('mc_craft {name:"furnace"}'), '告诉怎么做一个熔炉', r.text.replace(/\n/g, ' | '))
    ok(mc.placeCalls.length === 0, '没得放就不放')
  }
  /* placeFurnace:false → 不放 */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 })
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', placeFurnace: false }, { mc })
    ok(mc.placeCalls.length === 0, 'placeFurnace:false 就不放熔炉')
    ok(r.text.includes('没有熔炉'), '还是如实说没有熔炉', r.text.replace(/\n/g, ' | '))
  }
  /* 放熔炉失败 → 如实报告（试了 3 个点位都不行） */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 })
    const mc = mkMc(fake, { placeFails: true })
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(/想放熔炉，试了 3 个点位都没成功/.test(r.text) && r.text.includes('假服务器拒了放置'), '放熔炉全失败要说清试了几个点位、为什么', r.text.replace(/\n/g, ' | '))
    ok(mc.placeCalls.length === 3, '一个点位被拒就换下一个，最多试 3 个', `placeCalls=${JSON.stringify(mc.placeCalls)}`)
  }
  /* 第一个点位被拒 → 换下一个点位再放，成功（实机 2026-10-08 见过） */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 })
    const mc = mkMc(fake, { placeFailsFirst: 1 })
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(mc.placeCalls.length === 2, '第一个点位被拒后换了个点位重试', `placeCalls=${JSON.stringify(mc.placeCalls)}`)
    const a = mc.placeCalls[0]
    const b = mc.placeCalls[1]
    ok(a && b && (a.x !== b.x || a.z !== b.z), '换的确实是**另一个**点位', JSON.stringify(mc.placeCalls))
    ok(/前 1 个点位服务端没收/.test(r.text), '如实说明"前 N 个点位服务端没收"', r.text.replace(/\n/g, ' | '))
  }
  /* 缺料：没有 raw_iron */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ coal: 2 }, { world: w })
    const win = mkWin({ cook: true })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 3 }, { mc })
    ok(r.text.includes('背包里没有') && r.text.includes('raw_iron'), '缺料要直说', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('iron_ore'), '缺料给下一步提示', r.text.replace(/\n/g, ' | '))
    ok(!win.calls.some((c) => c[0] === 'putInput'), '缺料就不装料（会先开炉子看一眼输入槽，但什么都不放）', JSON.stringify(win.calls))
  }
  /* 缺燃料 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, apple: 2 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 3 }, { mc })
    ok(r.text.includes('没有能当燃料的东西'), '没燃料要直说', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('coal_ore'), '没燃料给挖煤的提示', r.text.replace(/\n/g, ' | '))
    ok(!win.calls.some((c) => c[0] === 'putInput'), '没燃料就不塞东西', JSON.stringify(win.calls))
    ok(win.calls.some((c) => c[0] === 'close'), '没烧成也要关熔炉', JSON.stringify(win.calls))
  }
  /* list:true */
  {
    const fake = mkBot({ raw_iron: 3, coal: 2 })
    const mc = mkMc(fake)
    const r = await run({ list: true }, { mc })
    ok(r.text.includes('背包里现在能烧的') && r.text.includes('raw_iron'), 'list 列出能烧的', r.text.replace(/\n/g, ' | ').slice(0, 120))
    ok(!r.text.includes('熔炼完成'), 'list 不真烧')
  }
  /* dryRun:true —— 不放、不开、不烧 */
  {
    const fake = mkBot({ raw_iron: 3, coal: 2, furnace: 1 })
    const win = mkWin({ cook: true })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 3, dryRun: true }, { mc })
    ok(r.text.includes('熔炼计划') && r.text.includes('iron_ingot ×3'), 'dryRun 出计划', r.text.replace(/\n/g, ' | '))
    ok(mc.placeCalls.length === 0, 'dryRun 不放熔炉')
    ok(win.calls.length === 0, 'dryRun 不开熔炉')
    ok(r.text.includes('这一轮装 3 个'), 'dryRun 说清烧几个', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('燃料：coal'), 'dryRun 说清用啥燃料', r.text.replace(/\n/g, ' | '))
  }
  /* dryRun 缺料也要提醒 */
  {
    const fake = mkBot({ coal: 2, furnace: 1 })
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', dryRun: true }, { mc })
    ok(r.text.includes('一个 raw_iron 都没有'), 'dryRun 缺料也提醒', r.text.replace(/\n/g, ' | '))
  }
  /* takeOnly:true */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({}, { world: w })
    const win = mkWin({ preOutput: { type: idOf('iron_ingot'), name: 'iron_ingot', count: 4 } })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'iron_ingot', takeOnly: true }, { mc })
    ok(r.text.includes('收走了') && r.text.includes('×4'), 'takeOnly 只收成品', r.text.replace(/\n/g, ' | '))
    const realCalls = win.calls.filter((c) => c[0] !== 'close')
    ok(realCalls.length === 1 && realCalls[0][0] === 'takeOutput', 'takeOnly 只调 takeOutput（另加关窗）', JSON.stringify(win.calls))
  }
  /* takeOnly 但熔炉是空的 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({}, { world: w })
    const win = mkWin({})
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'iron_ingot', takeOnly: true }, { mc })
    ok(r.text.includes('没有烧好的东西'), '空熔炉 takeOnly 如实说', r.text.replace(/\n/g, ' | '))
  }
  /* 槽里是别的东西 → 拒绝，不乱动 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, coal: 2 }, { world: w })
    const win = mkWin({ preInput: { type: idOf('sand'), name: 'sand', count: 5 } })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(r.text.includes('熔炉里已经有') && r.text.includes('sand'), '输入槽是别的东西 → 拒绝', r.text.replace(/\n/g, ' | '))
    ok(!win.calls.some((c) => c[0] === 'putInput'), '拒绝时不硬塞', JSON.stringify(win.calls))
  }
  /* 成品槽是别的东西 → 拒绝 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, coal: 2 }, { world: w })
    const win = mkWin({ preOutput: { type: idOf('glass'), name: 'glass', count: 5 } })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(r.text.includes('熔炉里已经有') && r.text.includes('glass'), '成品槽是别的东西 → 拒绝', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('takeOnly'), '并提示可以只收成品')
  }
  /* 开不了熔炉 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, coal: 2 }, { world: w })
    fake.bot.openFurnace = async () => { throw new Error('假服务器：太远了') }
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(r.text.includes('打不开熔炉') && r.text.includes('太远了'), '开不了熔炉要说清原因', r.text.replace(/\n/g, ' | '))
  }
  /* 写产物名也能烧 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 2, coal: 1 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'iron_ingot', count: 2 }, { mc })
    ok(r.text.includes('这一轮收到') && r.text.includes('iron_ingot ×2'), '写产物名也能烧', r.text.replace(/\n/g, ' | '))
    ok(win.calls.some((c) => c[0] === 'putInput' && c[1] === idOf('raw_iron')), '实际烧的是 raw_iron', JSON.stringify(win.calls))
  }
  /* 不认识的名字 → ❌ 不炸 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ apple: 3 }, { world: w })
    const mc = mkMc(fake)
    const r = await run({ name: 'apple' }, { mc })
    ok(r.text.startsWith('❌') && r.text.includes('既不是能烧的东西'), '不认识的名字 → ❌ 说人话', r.text.replace(/\n/g, ' | '))
  }
  /* 没给名字 → ❌ 不炸 */
  {
    const fake = mkBot({ raw_iron: 3, coal: 1 })
    const mc = mkMc(fake)
    const r = await run({}, { mc })
    ok(r.text.startsWith('❌') && r.text.includes('要烧什么'), '没给名字 → ❌ 提示', r.text.replace(/\n/g, ' | '))
  }
  /* 一次最多装 MAX_LOAD=8 个（🔴 单次调用 ≤11 秒：少量多次，剩下的下次再装） */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 60, coal: 20 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 60, maxWaitSec: 20 }, { mc })
    const put = win.calls.find((c) => c[0] === 'putInput')
    ok(put && put[2] === 8, '一次最多装 8 个（maxWaitSec 给多大也只装 8 个）', JSON.stringify(put))
    ok(r.text.includes('还想要 52 个'), '并告诉还剩多少、再叫一次', r.text.replace(/\n/g, ' | '))
  }
  /* 🔴 轮询取货：炉子里已经装着料 → 这一轮不再装，只看一眼能收就收（"少量多次"的核心用法） */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 8, coal: 2 }, { world: w })
    const win = mkWin({
      cook: false, outId: idOf('iron_ingot'),
      preInput: { type: idOf('raw_iron'), name: 'raw_iron', count: 6 },
      preFuel: { type: idOf('coal'), name: 'coal', count: 1 },
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 6, maxWaitSec: 2 }, { mc })
    ok(!win.calls.some((c) => c[0] === 'putInput'), '炉子里已经有料 → 不再装料', JSON.stringify(win.calls))
    ok(!win.calls.some((c) => c[0] === 'putFuel'), '燃料也够 → 不再加燃料', JSON.stringify(win.calls))
    ok(r.text.includes('炉子里还在烧'), '报告里说清炉子里还剩多少、大概还要多久', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('不用再装料'), '提示下次只取货、不用装料', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('⏳'), '没烧好时说"还在烧"，不报失败', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('大概还要 **60 秒**'), 'ETA 不把"正在烧的那个"算两遍（6 个 0% = 60 秒，不是 70）', r.text.replace(/\n/g, ' | '))
  }
  /* 🔴 默认**不盯**（用户要求：熔炉不用一直看着）—— 装好料就返回，报告里给出"过一会儿再来取" */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 3, coal: 2 }, { world: w })
    const win = mkWin({ cook: false, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const t0 = Date.now()
    const r = await run({ name: 'raw_iron', count: 3 }, { mc })
    const ms = Date.now() - t0
    ok(ms < 1_000, '不给 maxWaitSec → 装好料立刻返回（不盯炉子）', `${ms}ms`)
    ok(!r.text.includes('盯了'), '没盯就别写"盯了 Ns"', r.text.replace(/\n/g, ' | '))
    const put = win.calls.find((c) => c[0] === 'putInput')
    ok(put && put[2] === 3, '按要烧的数量装料（3 个）', JSON.stringify(win.calls))
    ok(win.calls.some((c) => c[0] === 'putFuel' && c[2] === 1), '烧 3 个 → 放 1 块煤（够烧 8 个）', JSON.stringify(win.calls))
    ok(r.text.includes('炉子里还在烧') && r.text.includes('大概还要'), '报告里给出"还要多久"', r.text.replace(/\n/g, ' | '))
    ok(r.text.includes('不用再装料'), '提示下次只取货、不用装料', r.text.replace(/\n/g, ' | '))
  }
  /* 不盯也不等：炉子里已经有料、成品没好的时候，默认也是看一眼就走 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 8, coal: 2 }, { world: w })
    const win = mkWin({
      cook: false, outId: idOf('iron_ingot'),
      preInput: { type: idOf('raw_iron'), name: 'raw_iron', count: 6 },
      preFuel: { type: idOf('coal'), name: 'coal', count: 1 },
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const t0 = Date.now()
    const r = await run({ name: 'raw_iron', count: 6 }, { mc })
    const ms = Date.now() - t0
    ok(ms < 1_000, '默认不盯：不等待就返回', `${ms}ms`)
    ok(!win.calls.some((c) => c[0] === 'putInput'), '炉子里已经有料 → 不再装料', JSON.stringify(win.calls))
    ok(r.text.includes('还在烧') && r.text.includes('不用再装料'), '还是告诉模型"在烧 + 下次只取货"', r.text.replace(/\n/g, ' | '))
  }
  /* 高炉烧得快一倍 */
  {
    const w = mkWorld({ '2,1,0': 'blast_furnace' })
    const fake = mkBot({ raw_iron: 60, coal: 20 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 60, maxWaitSec: 20 }, { mc })
    const put = win.calls.find((c) => c[0] === 'putInput')
    ok(put && put[2] === 8, '高炉也是一次最多装 8 个', JSON.stringify(put))
    ok(r.text.includes('烧得快一倍'), '报告里说明用的是高炉', r.text.replace(/\n/g, ' | '))
  }
  /* 离熔炉太远会先走过去 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 2, coal: 1 }, { world: w })
    // 给 position 一个带 distanceTo 的假 Vec3，模拟"离得远"
    fake.bot.entity.position = { x: 30.5, y: 1, z: 0.5, distanceTo: () => 28 }
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    await run({ name: 'raw_iron' }, { mc })
    ok(mc.walkCalls.length === 1, '离得远会先走过去', JSON.stringify(mc.walkCalls))
    ok(mc.walkCalls[0].o.arrive === 2.2, '走到 2.2 格内（openFurnace 要 4.5 格内）', JSON.stringify(mc.walkCalls[0].o))
  }
  /* 走路失败也还是试着开 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 2, coal: 1 }, { world: w })
    fake.bot.entity.position = { x: 30.5, y: 1, z: 0.5, distanceTo: () => 28 }
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake, { walkThrows: true })
    const r = await run({ name: 'raw_iron' }, { mc })
    ok(r.text.includes('这一轮收到'), '走不过去也还是试着开熔炉', r.text.replace(/\n/g, ' | '))
  }
  /* 烧的是原木 → 木炭 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ oak_log: 4, coal: 1 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('charcoal') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'oak_log', count: 4 }, { mc })
    ok(r.text.includes('charcoal ×4'), '原木烧成木炭', r.text.replace(/\n/g, ' | '))
  }
  /* 不在线 → 抛错（不吞） */
  {
    const fake = mkBot({ raw_iron: 1, coal: 1 })
    const mc = mkMc(fake, { online: false })
    let threw = null
    try { await run({ name: 'raw_iron' }, { mc }) } catch (e) { threw = e }
    ok(threw && /不在线/.test(threw.message), '机器人不在线 → 抛错', String(threw?.message))
  }
}

/* ─────────────────────── ⑨ 装料量 / 收成品（2026-10-08 审计 H3·H4·H5） ─────────────────────── */
console.log('— ⑨ 该补料就补料、取货要等背包、背包满不许取 —')
{
  /* H3：炉里已有 3 个、想要 8 个 ⇒ 还要**补 5 个**（旧代码一个都不装，却报 loaded=5） */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 8, coal: 3 }, { world: w })
    const win = mkWin({
      cook: false, outId: idOf('iron_ingot'),
      preInput: { type: idOf('raw_iron'), name: 'raw_iron', count: 3 },
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 8 }, { mc })
    const put = win.calls.filter((c) => c[0] === 'putInput')
    ok(put.length === 1 && put[0][2] === 5, '炉里已有 3 个 + 想要 8 个 ⇒ 补装 5 个（不再一个都不装）', JSON.stringify(win.calls))
    ok(r.value.loaded === 5, 'loaded 报的是**真装进去的** 5 个', JSON.stringify(r.value))
    ok(String(fake.bot.inventory.count(idOf('raw_iron'))) === '3', '背包真少了 5 个（8→3）', String(fake.bot.inventory.count(idOf('raw_iron'))))
  }
  /* H3：炉里已经有 8 个（够了）⇒ 一个都不装，loaded 报 0 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 5, coal: 2 }, { world: w })
    const win = mkWin({
      cook: false, outId: idOf('iron_ingot'),
      preInput: { type: idOf('raw_iron'), name: 'raw_iron', count: 8 },
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 8 }, { mc })
    ok(!win.calls.some((c) => c[0] === 'putInput'), '炉里的已经够了 ⇒ 一个都不装', JSON.stringify(win.calls))
    ok(r.value.loaded === 0, 'loaded 报 0（不再把 batch 当装进去的量）', JSON.stringify(r.value))
    ok(r.text.includes('不用再装料'), '还是如实告诉它"不用再装料"', r.text.replace(/\n/g, ' | '))
  }
  /* H3：一次最多装 MAX_LOAD(8) —— 炉里已有 4 个、想要 20 个 ⇒ 只能补 4 个（凑满 8） */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 20, coal: 4 }, { world: w })
    const win = mkWin({
      cook: false, outId: idOf('iron_ingot'),
      preInput: { type: idOf('raw_iron'), name: 'raw_iron', count: 4 },
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 20 }, { mc })
    const put = win.calls.filter((c) => c[0] === 'putInput')
    ok(put.length === 1 && put[0][2] === 4, '炉里已有 4 个、想要 20 ⇒ 只补 4 个（一次最多装 8 个）', JSON.stringify(win.calls))
    ok(r.value.loaded === 4, 'loaded = 4', JSON.stringify(r.value))
  }
  /* H4：takeOnly 要等背包同步再报数（set_slot 晚 400ms） */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ coal: 1 }, { world: w })
    const win = mkWin({
      preOutput: { type: idOf('iron_ingot'), name: 'iron_ingot', count: 4 },
      takeCreditDelayMs: 400,
    })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', takeOnly: true }, { mc })
    ok(/✅ 收走了熔炉里的 \*\*iron_ingot ×4\*\*/.test(r.text), 'takeOnly 如实说收走 ×4', r.text.replace(/\n/g, ' | '))
    ok(/背包里现在有 4 个/.test(r.text), '背包数量等同步后再报（不再自相矛盾地说"0 个"）', r.text.replace(/\n/g, ' | '))
    ok(!/背包里现在有 0 个/.test(r.text), '不再出现"收走了 ×4（背包里现在有 0 个）"', r.text.replace(/\n/g, ' | '))
  }
  /* 🔴 实机（2026-10-08）：服务端 `set_slot` 比 1.2 秒还晚 ⇒ 旧代码报"只多出 0 个"，其实东西到手了。
   *    两件事：① 等同步的窗口要够长（20×150ms）；② 真没等到、但**输出槽已经空了**就如实说"收走了、背包慢一拍"。 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 2, coal: 1 }, { world: w })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot'), takeCreditDelayMs: 2500 })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 2, maxWaitSec: 20 }, { mc })
    ok(/✅ 这一轮收到 \*\*iron_ingot ×2\*\*/.test(r.text), '背包晚 2.5 秒才同步 ⇒ 照样报"这一轮收到 ×2"', r.text.replace(/\n/g, ' | '))
    ok(!/只多出/.test(r.text), '不因为同步慢就报"只多出 0 个"', r.text.replace(/\n/g, ' | '))
  }
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ coal: 1 }, { world: w })
    /* counts 是个"记账黑洞" ⇒ 模拟"输出槽清了、背包一直没同步" */
    const win = mkWin({ preOutput: { type: idOf('iron_ingot'), name: 'iron_ingot', count: 4 }, counts: { get: () => 0, set: () => {} } })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', takeOnly: true }, { mc })
    ok(/✅ 收走了熔炉里的 \*\*iron_ingot ×4\*\*/.test(r.text), '输出槽空了就说"收走了"（不谎报失败）', r.text.replace(/\n/g, ' | '))
    ok(/输出槽已经空了/.test(r.text) && !/只多出/.test(r.text), '并说清"背包同步慢一拍"，不吓唬模型', r.text.replace(/\n/g, ' | '))
  }
  /* H5：背包满了 ⇒ 不许取（取出来会掉地上），并如实说 */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ coal: 1 }, { world: w, emptySlots: 0 })
    const win = mkWin({ preOutput: { type: idOf('iron_ingot'), name: 'iron_ingot', count: 4 } })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', takeOnly: true }, { mc })
    ok(!win.calls.some((c) => c[0] === 'takeOutput'), '背包满 ⇒ 一个都不取（不把成品丢地上）', JSON.stringify(win.calls))
    ok(/背包满了/.test(r.text) && /我没取/.test(r.text), '如实说"背包满了、我没取"', r.text.replace(/\n/g, ' | '))
    ok(/mc_chest/.test(r.text), '给出腾位置的办法', r.text.replace(/\n/g, ' | '))
  }
  /* H5（主路径）：背包满 ⇒ 同样不取，也不谎报"这一轮收到" */
  {
    const w = mkWorld({ '2,1,0': 'furnace' })
    const fake = mkBot({ raw_iron: 2, coal: 1 }, { world: w, emptySlots: 0 })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 2 }, { mc })
    ok(!win.calls.some((c) => c[0] === 'takeOutput'), '主路径背包满 ⇒ 不取', JSON.stringify(win.calls))
    ok(/背包满了/.test(r.text), '主路径也如实说背包满了', r.text.replace(/\n/g, ' | '))
    ok(!/这一轮收到/.test(r.text), '不许谎报"这一轮收到"', r.text.replace(/\n/g, ' | '))
  }
  /* H6：给了坐标、那里不是熔炉 ⇒ 不许在脚边另放一个 */
  {
    const w = mkWorld({ '2,1,0': 'stone' })
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 }, { world: w })
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', x: 2, y: 1, z: 0 }, { mc })
    ok(mc.placeCalls.length === 0, '坐标上不是熔炉 ⇒ 一个方块都没放', JSON.stringify(mc.placeCalls))
    ok(/不是\*\*熔炉/.test(r.text) && /没有\*\*另放/.test(r.text), '如实说"那里不是熔炉、我没另放"', r.text.replace(/\n/g, ' | '))
    ok(String(fake.bot.inventory.count(idOf('furnace'))) === '1', '背包里的熔炉还在', String(fake.bot.inventory.count(idOf('furnace'))))
  }
  /* H6：没给坐标 ⇒ 照旧自己放（别误伤） */
  {
    const fake = mkBot({ raw_iron: 2, coal: 1, furnace: 1 })
    const win = mkWin({ cook: true, outId: idOf('iron_ingot') })
    fake.bot.openFurnace = async () => win
    const mc = mkMc(fake)
    const r = await run({ name: 'raw_iron', count: 2 }, { mc })
    ok(mc.placeCalls.length === 1, '没给坐标 ⇒ 照旧自己放熔炉', JSON.stringify(mc.placeCalls))
  }
}

console.log('')
console.log(`结果：${pass}/${fail === 0 ? pass : pass + fail} 通过，${fail} 失败`)
if (fail > 0) process.exit(1)
