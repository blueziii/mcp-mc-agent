/**
 * mc_chest 扩展的自检：用**假 bot / 假箱子窗口 / 假世界**跑真实扩展文件，覆盖
 *   ① 工具注册形状（且确认它**在** mc_observe 的看图门禁名单里）
 *   ② 找箱子：坐标指定、半径搜索（🔴 必须用**方块 id**，不是物品 id）、
 *      `findContainers` 要把 findBlocks 返回的**坐标**转回方块（mineflayer 4.39 的坑）
 *   ③ 文本：背包概览 / 箱子概览 / listText 的两条分支 / hintFor
 *   ④ 端到端 put：点名物品、count 截断、all:true、keep 留一手、没有→报错+建议
 *   ⑤ 端到端 take：点名物品、count 截断、all:true、空箱子、箱子里没有→报错+建议、背包满
 *   ⑥ 放箱子：附近没有→自己放（placeChest:false 可关）、放不下→说清、dryRun 只出计划
 *   ⑦ 边界：开不开、action 写错、put/take 既没 name 也没 all、搬完复核
 * 不连 MC、不需要 DSH。**必须在包目录里跑**（core.mjs 要真 import 到 mineflayer）。
 * 跑法：cd <profile>/node_modules/mcp-mc-agent && node tools/check-mc-chest.mjs
 */
import { readFileSync } from 'node:fs'

const EXT = new URL('../extensions/mc_chest.mjs', import.meta.url).href

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}

const mod = await import(EXT + '?v=' + Date.now())
const {
  CONTAINER_NAMES, findContainerBlock, findContainers, chestInInventory,
  bagText, chestText, listText, hintFor,
} = mod

/* ─────────────────────── 假注册表 / 假背包 / 假世界 ─────────────────────── */

/** 假注册表里"方块 id"的偏移：故意和物品 id 错开，用来抓"拿物品 id 去 findBlock"的 bug */
const BLOCK_ID_BASE = 1000

const NAMES = [
  'air', 'stone', 'grass_block', 'dirt', 'crafting_table', 'furnace',
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box', 'blue_shulker_box',
  'hopper', 'dispenser', 'dropper', 'oak_planks',
  'iron_ingot', 'iron_ore', 'raw_iron', 'coal', 'charcoal', 'cobblestone',
  'oak_log', 'stick', 'diamond', 'wooden_pickaxe', 'stone_sword', 'apple', 'torch',
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
  /* 🔴 2026-10-08 审计 H1：真背包里同一种物品可能有**好几叠**（64+32）。
   *    传 `opts.stacks` 就能造出这种背包（`items()` 一叠一条，`counts` 是总和）。 */
  const stackList = Array.isArray(opts.stacks) ? opts.stacks.filter((s) => idIn(s.name) != null) : null
  if (stackList) for (const s of stackList) counts.set(idIn(s.name), (counts.get(idIn(s.name)) ?? 0) + s.count)
  else for (const [n, c] of Object.entries(inv)) { if (idIn(n) != null) counts.set(idIn(n), c) }
  const world = opts.world ?? mkWorld()
  const pos = opts.pos ?? { x: 0.5, y: 1, z: 0.5 }
  const usedSlots = opts.usedSlots ?? (stackList ? stackList.length : counts.size)
  const bot = {
    registry: reg,
    entity: { position: pos, yaw: 0, pitch: 0 },
    inventory: {
      count: (id, metadata = null) => (id == null ? 0 : (counts.get(id) ?? 0)),
      items: () => (stackList
        ? stackList.map((s) => ({ type: idIn(s.name), name: s.name, count: s.count, metadata: null }))
        : [...counts.entries()].filter(([, c]) => c > 0).map(([id, c]) => ({ type: id, name: nm(id), count: c, metadata: null }))),
      emptySlotCount: () => (opts.emptySlots ?? Math.max(0, 36 - usedSlots)),
    },
    blockAt (p) {
      const { x, y, z } = p.floored()
      if (y < 0) return { name: 'stone', boundingBox: 'block', position: { x, y, z } }
      if (y === 0 && world.get(x, 0, z) == null) return { name: 'grass_block', boundingBox: 'block', position: { x, y, z } }
      const n = world.get(x, y, z)
      if (!n) return { name: 'air', boundingBox: 'empty', position: { x, y, z } }
      return { name: n, boundingBox: 'block', position: { x, y, z } }
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
    // 🔴 真 mineflayer 4.39 的 findBlocks 返回的是**坐标**，不是方块对象 —— 这里故意照抄那个形状
    findBlocks ({ matching, maxDistance = 4, count = 8 }) {
      const out = []
      for (const [k, n] of world.map) {
        if (!matching.includes(blockIdIn(n))) continue
        const [x, y, z] = k.split(',').map(Number)
        const d = Math.hypot(x - pos.x, y - pos.y, z - pos.z)
        if (d > maxDistance) continue
        out.push({ x, y, z })
        if (out.length >= count) break
      }
      return out
    },
  }
  return { bot, counts, world, pos, blockIdIn, nm }
}

/** 假箱子窗口：真的在"背包"和"箱子"之间搬数字，好核对 */
function mkChestWin (fake, opts = {}) {
  const slots = new Map() // name -> count
  for (const [n, c] of Object.entries(opts.contents ?? {})) slots.set(n, c)
  const calls = []
  /* 🔴 假背包 `fake.counts` 是按**物品 id**（数字）存的，箱子 `slots` 是按**名字**存的 ——
   *    2026-10-08 审计前这里两边都用 `nameOf(id)` 去查假背包，结果永远查到 0：
   *    "搬完"箱子还是空的，而套件当时断言的是"报告说放进去了" ⇒ 把假窗口的假动作当成真了。
   *    现在两边都按各自的键真的搬数字（这样才测得出"按箱子数量对账"）。 */
  const takeFromId = (map, id, n) => { const have = map.get(id) ?? 0; const move = Math.min(have, n); if (move > 0) map.set(id, have - move); return move }
  const takeFromName = (map, name, n) => { const have = map.get(name) ?? 0; const move = Math.min(have, n); map.set(name, have - move); if (map.get(name) <= 0) map.delete(name); return move }
  const win = {
    slots,
    calls,
    inventoryStart: opts.size ?? 27,
    inventoryEnd: (opts.size ?? 27) + 36,
    containerItems: () => [...slots.entries()].filter(([, c]) => c > 0).map(([n, c]) => ({ type: idOf(n), name: n, count: c, metadata: null })),
    async deposit (id, md, n) {
      calls.push(['deposit', nameOf(id), n])
      if (opts.depositThrows) throw new Error('Event transfer did not fire within timeout')
      const moved = takeFromId(fake.counts, id, n)
      slots.set(nameOf(id), (slots.get(nameOf(id)) ?? 0) + moved)
    },
    async withdraw (id, md, n) {
      calls.push(['withdraw', nameOf(id), n])
      if (opts.invFull) throw new Error('Unable to withdraw, Bot inventory is full.')
      const moved = takeFromName(slots, nameOf(id), n)
      fake.counts.set(id, (fake.counts.get(id) ?? 0) + moved)
    },
    close () { calls.push(['close']) },
  }
  return win
}

/** 假 McBot */
function mkMc (fake, opts = {}) {
  const placeCalls = []
  const walkCalls = []
  const openCalls = []
  const win = opts.win ?? null
  if (win) fake.bot.openContainer = async () => { if (opts.openThrows) throw new Error('假服务器：窗口没开'); return win }
  return {
    online: opts.online !== false,
    bot: fake.bot,
    requireBot () { if (opts.online === false) throw new Error('机器人不在线（假会话）'); return fake.bot },
    waitForChunks: async () => {},
    inventory: () => fake.bot.inventory.items(),
    walkTo: async (t, o) => { walkCalls.push({ t, o }); if (opts.walkThrows) throw new Error('假走路故障'); return { arrived: true } },
    placeBlock: async ({ x, y, z, name }) => {
      placeCalls.push({ x, y, z, name })
      if (opts.placeFails) return { placed: false, requested: name, at: { x, y, z }, note: '假服务器拒了放置' }
      fake.world.set(x, y, z, name)
      return { placed: name, requested: name, at: { x, y, z } }
    },
    placeCalls,
    walkCalls,
    openCalls,
    win,
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
const spec = registered.get('mc_chest')
async function run (args, { mc, id = 'A1' } = {}) {
  sessions.set(id, { agentId: id, bot: mc })
  const v = await spec.execute(args, { agent: { id } })
  return { text: String(v?.text ?? ''), value: v }
}

/* ─────────────────────── ① 工具注册 ─────────────────────── */
console.log('— ① 工具注册 —')
{
  ok(typeof mod.apply === 'function', '扩展导出 apply(api)')
  ok(mod.name === 'mc_chest', '扩展 name = mc_chest', mod.name)
  ok(Boolean(spec), '注册了 mc_chest')
  ok(typeof spec.execute === 'function', '有 execute')
  ok(spec.timeoutMs > 0 && spec.timeoutMs <= 300_000, 'timeoutMs 是合理正数', String(spec.timeoutMs))
  for (const k of ['action', 'name', 'count', 'all', 'keep', 'x', 'y', 'z', 'radius', 'placeChest', 'dryRun']) {
    ok(Boolean(spec.parameters[k]), `parameters.${k} 存在`)
  }
  ok(spec.parameters.name.type === 'string', 'parameters.name 是 string')
  ok(spec.parameters.count.type === 'number', 'parameters.count 是 number')
  ok(spec.parameters.all.type === 'boolean', 'parameters.all 是 boolean')
  ok(spec.output && spec.output.schema && spec.output.schema.additionalProperties === true, 'output.schema 带 additionalProperties')
  const blocks = spec.output.render({}, { text: 'hi' })
  ok(Array.isArray(blocks) && blocks.length === 1 && blocks[0].text === 'hi', 'render 推一个文字块')
  ok(spec.description.includes('箱子'), '描述里说明是箱子')
  ok(spec.description.includes('put') && spec.description.includes('take'), '描述里说明 put/take')
  ok(spec.description.includes('mc_observe'), '描述里提到受看图门禁限制')
  // 门禁名单
  const viewSrc = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')
  const gatedBlock = viewSrc.slice(viewSrc.indexOf('const DEFAULT_GATED'), viewSrc.indexOf(']', viewSrc.indexOf('const DEFAULT_GATED')))
  ok(gatedBlock.includes('mc_chest'), 'mc_chest 在 mc_observe 门禁名单里（会开世界里的箱子）', gatedBlock.replace(/\s+/g, ' '))
  ok(gatedBlock.includes('mc_furnace'), 'mc_furnace 还在门禁名单里')
  ok(!gatedBlock.includes('mc_craft'), 'mc_craft 不在门禁名单里（只动背包）')
  ok(logs.some((l) => l.includes('mc_chest 已加载')), '加载时记了一行日志')
}

/* ─────────────────────── ② 找箱子 ─────────────────────── */
console.log('— ② 找箱子 —')
{
  const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest', '5,1,5': 'barrel', '0,1,3': 'stone', '-4,1,0': 'blue_shulker_box' }), pos: { x: 0.5, y: 1, z: 0.5 } })
  const b = findContainerBlock(f.bot, { x: 2, y: 1, z: 0 })
  ok(b?.name === 'chest', '给坐标能找到 chest', String(b?.name))
  ok(findContainerBlock(f.bot, { x: 0, y: 1, z: 3 }) === null, '坐标上是石头 → null（不硬开）')
  ok(findContainerBlock(f.bot, { x: 9, y: 9, z: 9 }) === null, '坐标上是空气 → null')
  ok(findContainerBlock(f.bot, { radius: 8 })?.name === 'chest', '半径搜索找最近的（chest 2 格 < barrel 7 格）')
  ok(findContainerBlock(f.bot, { radius: 1 }) === null, '半径太小 → 找不到')
  const all = findContainers(f.bot, { radius: 16 })
  ok(all.length === 3, 'findContainers 找到 3 个（chest/barrel/蓝潜影盒）', String(all.length))
  ok(all.every((x) => typeof x?.name === 'string' && x.position), '🔴 findBlocks 返回坐标也要转回方块对象', JSON.stringify(all.map((x) => x?.name)))
  ok(all.some((x) => x.name === 'blue_shulker_box'), '彩色潜影盒也认')
  ok(!all.some((x) => x.name === 'stone'), '石头不算箱子')
  ok(findContainers(f.bot, { radius: 2 }).length === 1, '半径 2 只找到 chest 一个')
  ok(Array.isArray(CONTAINER_NAMES) && CONTAINER_NAMES.includes('chest') && CONTAINER_NAMES.includes('barrel'), 'CONTAINER_NAMES 有 chest/barrel')
  ok(!CONTAINER_NAMES.includes('crafting_table'), 'CONTAINER_NAMES 里没有工作台')
}

/* ─────────────────────── ③ 文本 ─────────────────────── */
console.log('— ③ 文本 —')
{
  const f = mkBot({ iron_ingot: 12, coal: 3 })
  ok(bagText(f.bot).includes('iron_ingot×12'), 'bagText 列背包', bagText(f.bot))
  ok(bagText(f.bot).includes('空位'), 'bagText 报空位')
  ok(bagText(mkBot({}).bot) === '（空）', '空背包显示（空）')
  const win = mkChestWin(f, { contents: { coal: 5, diamond: 2 } })
  ok(chestText(win).includes('coal×5') && chestText(win).includes('diamond×2'), 'chestText 列内容', chestText(win))
  ok(chestText(win).includes('2 叠') && chestText(win).includes('27 个位置'), 'chestText 报占用叠数 + 总位置数', chestText(win))
  ok(chestText(mkChestWin(f, {})).includes('空'), '空箱子显示（空 …）')
  ok(chestInInventory(f.bot) === null, '背包里没箱子 → null')
  const f2 = mkBot({ chest: 2, barrel: 1 })
  ok(chestInInventory(f2.bot)?.name === 'chest', '背包里有箱子就报它', String(chestInInventory(f2.bot)?.name))
  // listText
  const noBox = listText(f.bot, { radius: 8 })
  ok(noBox.includes('没有箱子'), 'listText：附近没箱子就说清', noBox.split('\n').join(' | '))
  ok(noBox.includes('mc_craft'), 'listText：没箱子也没存货 → 建议做一个')
  const f3 = mkBot({ chest: 1 }, { world: mkWorld({}) })
  const t3 = listText(f3.bot, { radius: 8 })
  ok(t3.includes('背包里有 chest×1') && t3.includes('placeChest:true'), 'listText：附近没箱子但背包有 → 说会自己放', t3.split('\n').join(' | '))
  const f4 = mkBot({}, { world: mkWorld({ '2,1,0': 'chest', '6,1,6': 'barrel' }) })
  const t4 = listText(f4.bot, { radius: 16 })
  ok(t4.includes('chest @ (2,1,0)') && t4.includes('barrel @ (6,1,6)'), 'listText 列位置', t4.split('\n').join(' | '))
  ok(t4.includes('格'), 'listText 报距离')
  // hintFor
  ok(hintFor('cobblestone').includes('mc_dig'), 'hintFor 圆石 → 挖石头')
  ok(hintFor('oak_log').includes('mc_dig'), 'hintFor 原木 → 砍树')
  ok(hintFor('stick').includes('mc_craft'), 'hintFor 木棍 → 合成')
  ok(hintFor('iron_ingot').includes('mc_craft') || hintFor('iron_ingot').includes('mc_furnace'), 'hintFor 铁锭 → 给条路', hintFor('iron_ingot'))
}

/* ─────────────────────── ④ 端到端 put ─────────────────────── */
console.log('— ④ 端到端 put —')
{
  // 点名物品
  {
    const f = mkBot({ iron_ingot: 12, coal: 3 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const mc = mkMc(f, { win })
    const r = await run({ action: 'put', name: 'iron_ingot' }, { mc })
    ok(win.calls.some((c) => c[0] === 'deposit' && c[1] === 'iron_ingot' && c[2] === 12), 'put 点名物品 → deposit(全部 12)', JSON.stringify(win.calls))
    ok(r.text.includes('放进去了') && r.text.includes('iron_ingot×12'), '报告说放进去了', r.text.split('\n').join(' | '))
    ok(r.text.includes('现在里面') && r.text.includes('iron_ingot×12'), '搬完复核箱子内容', r.text.split('\n').join(' | '))
    ok(!win.calls.some((c) => c[0] === 'deposit' && c[1] === 'coal'), '没点名的 coal 不动')
    ok(f.counts.get(idOf('iron_ingot')) === undefined || f.counts.get(idOf('iron_ingot')) === 0, '假背包里 iron_ingot 真被扣掉了（对账的基础）')
    ok(win.calls.some((c) => c[0] === 'close'), '用完关窗口')
  }
  // count 截断
  {
    const f = mkBot({ iron_ingot: 12 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    await run({ action: 'put', name: 'iron_ingot', count: 5 }, { mc: mkMc(f, { win }) })
    ok(win.calls.some((c) => c[0] === 'deposit' && c[2] === 5), 'put count:5 → 只放 5 个', JSON.stringify(win.calls))
  }
  // all:true
  {
    const f = mkBot({ iron_ingot: 4, coal: 2, apple: 1 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', all: true }, { mc: mkMc(f, { win }) })
    const names = win.calls.filter((c) => c[0] === 'deposit').map((c) => c[1]).sort()
    ok(names.join(',') === 'apple,coal,iron_ingot', 'all:true → 全搬', names.join(','))
    ok(r.text.includes('iron_ingot×4') && r.text.includes('coal×2') && r.text.includes('apple×1'), '报告列全', r.text.split('\n').join(' | '))
  }
  // keep 留一手
  {
    const f = mkBot({ iron_ingot: 4, wooden_pickaxe: 1, stone_sword: 1 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', all: true, keep: 'wooden_pickaxe, stone_sword' }, { mc: mkMc(f, { win }) })
    const names = win.calls.filter((c) => c[0] === 'deposit').map((c) => c[1])
    ok(names.length === 1 && names[0] === 'iron_ingot', 'keep 里的工具不动', names.join(','))
    ok(r.text.includes('wooden_pickaxe×1') === false || r.text.includes('背包现在'), '报告里有背包现状')
  }
  // 没有那个东西 → 报错 + 建议
  {
    const f = mkBot({ coal: 2 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', name: 'iron_ingot' }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('没有'), 'put 背包里没有 → ❌', r.text.split('\n').join(' | '))
    ok(r.text.includes('mc_') && /mc_dig|mc_craft|mc_furnace/.test(r.text), '并给一条弄到它的路', r.text.split('\n').join(' | '))
    ok(!win.calls.some((c) => c[0] === 'deposit'), '没东西就不硬塞')
  }
  // 既没 name 也没 all
  {
    const f = mkBot({ coal: 2 }, { world: mkWorld({ '2,1,0': 'chest' }) })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put' }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('all:true'), 'put 没给 name/all → 教它怎么写', r.text.split('\n').join(' | '))
    ok(!win.calls.length, '什么都不做')
  }
}

/* ─────────────────────── ⑤ 端到端 take ─────────────────────── */
console.log('— ⑤ 端到端 take —')
{
  // 点名物品
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 8, diamond: 2 } })
    const r = await run({ action: 'take', name: 'coal' }, { mc: mkMc(f, { win }) })
    ok(win.calls.some((c) => c[0] === 'withdraw' && c[1] === 'coal' && c[2] === 8), 'take 点名物品 → withdraw(8)', JSON.stringify(win.calls))
    ok(r.text.includes('拿出来了') && r.text.includes('coal×8'), '报告说拿出来了', r.text.split('\n').join(' | '))
    ok(r.text.includes('diamond×2'), '复核里还有 diamond', r.text.split('\n').join(' | '))
    ok(f.counts.get(idOf('coal')) === 8, 'coal 真进了假背包')
  }
  // count 截断
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 8 } })
    await run({ action: 'take', name: 'coal', count: 3 }, { mc: mkMc(f, { win }) })
    ok(win.calls.some((c) => c[0] === 'withdraw' && c[2] === 3), 'take count:3 → 只拿 3 个', JSON.stringify(win.calls))
  }
  // all:true
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 8, diamond: 2 } })
    const r = await run({ action: 'take', all: true }, { mc: mkMc(f, { win }) })
    const names = win.calls.filter((c) => c[0] === 'withdraw').map((c) => c[1]).sort()
    ok(names.join(',') === 'coal,diamond', 'all:true → 全拿', names.join(','))
    ok(r.text.includes('coal×8') && r.text.includes('diamond×2'), '报告列全', r.text.split('\n').join(' | '))
  }
  // 空箱子
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'take', name: 'coal' }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('空'), '空箱子 → 说空', r.text.split('\n').join(' | '))
    ok(!win.calls.some((c) => c[0] === 'withdraw'), '空箱子不发 withdraw')
  }
  // 箱子里没有那个东西
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 3 } })
    const r = await run({ action: 'take', name: 'diamond' }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('没有'), '箱子里没有 → ❌', r.text.split('\n').join(' | '))
    ok(r.text.includes('coal×3'), '顺便告诉它箱子里有什么', r.text.split('\n').join(' | '))
    ok(!win.calls.some((c) => c[0] === 'withdraw'), '不硬拿')
  }
  // 背包满
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 8 }, invFull: true })
    const r = await run({ action: 'take', name: 'coal' }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('卡住') || r.text.includes('⚠️'), '背包满 → 如实说', r.text.split('\n').join(' | '))
    ok(r.text.includes('背包满'), '并告诉它是背包满', r.text.split('\n').join(' | '))
  }
}

/* ─────────────────────── ⑥ 放箱子 / dryRun ─────────────────────── */
console.log('— ⑥ 放箱子 / dryRun —')
{
  // 附近没有 + 背包有 → 自己放
  {
    const f = mkBot({ chest: 1, iron_ingot: 5 }, { world: mkWorld({ '1,1,0': 'grass_block', '1,0,0': 'grass_block' }), pos: { x: 0.5, y: 1, z: 0.5 } })
    const mc = mkMc(f)
    const r = await run({ action: 'put', name: 'iron_ingot' }, { mc })
    ok(mc.placeCalls.length === 1 && mc.placeCalls[0].name === 'chest', '附近没箱子 → 自己放一个', JSON.stringify(mc.placeCalls))
    ok(r.text.includes('放到'), '报告里说明自己放了', r.text.split('\n').join(' | '))
    ok(logs.some((l) => l.includes('mc_chest：自动放了 chest')), '日志记了自己放箱子')
  }
  // 没东西可搬 → 不要白放一个箱子（先查背包再找箱子）
  {
    const f = mkBot({ chest: 1 }, { world: mkWorld({ '1,1,0': 'grass_block', '1,0,0': 'grass_block' }), pos: { x: 0.5, y: 1, z: 0.5 } })
    const mc = mkMc(f)
    const r = await run({ action: 'put', name: 'iron_ingot' }, { mc })
    ok(r.text.includes('背包里没有'), '没东西可搬 → 直接说背包里没有', r.text.split('\n').join(' | '))
    ok(mc.placeCalls.length === 0, '🔴 没东西可搬就不要白放一个箱子', JSON.stringify(mc.placeCalls))
  }
  // placeChest:false → 不自己放，教它做
  {
    const f = mkBot({ chest: 1, iron_ingot: 5 }, { world: mkWorld({}), pos: { x: 0.5, y: 1, z: 0.5 } })
    const mc = mkMc(f)
    const r = await run({ action: 'put', name: 'iron_ingot', placeChest: false }, { mc })
    ok(mc.placeCalls.length === 0, 'placeChest:false → 不放')
    ok(r.text.includes('mc_craft') && r.text.includes('chest'), '教它 mc_craft {name:"chest"}', r.text.split('\n').join(' | '))
  }
  // 放不下（假服务器拒了）
  {
    const f = mkBot({ chest: 1 }, { world: mkWorld({ '1,1,0': 'grass_block', '1,0,0': 'grass_block' }), pos: { x: 0.5, y: 1, z: 0.5 } })
    const mc = mkMc(f, { placeFails: true })
    const r = await run({ action: 'put', name: 'chest' }, { mc })
    ok(r.text.includes('没成功') || r.text.includes('失败'), '放箱子失败 → 如实说', r.text.split('\n').join(' | '))
  }
  // dryRun
  {
    const f = mkBot({ iron_ingot: 5 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, {})
    const mc = mkMc(f, { win })
    const r = await run({ action: 'put', name: 'iron_ingot', dryRun: true }, { mc })
    ok(r.text.includes('dryRun') && r.text.includes('iron_ingot×5'), 'dryRun 出计划', r.text.split('\n').join(' | '))
    ok(!win.calls.length, 'dryRun 不动手')
    const r2 = await run({ action: 'take', name: 'coal', dryRun: true }, { mc })
    ok(r2.text.includes('dryRun') && r2.text.includes('coal'), 'take 的 dryRun 也出计划', r2.text.split('\n').join(' | '))
  }
}

/* ─────────────────────── ⑦ list / 边界 ─────────────────────── */
console.log('— ⑦ list / 边界 —')
{
  // list 默认（没给坐标）
  {
    const f = mkBot({ coal: 1 }, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const r = await run({}, { mc: mkMc(f, { win: mkChestWin(f, {}) }) })
    ok(r.text.includes('背包') && r.text.includes('chest @'), '不带参数默认 list', r.text.split('\n').join(' | '))
  }
  // list 给坐标 → 打开看内容
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const win = mkChestWin(f, { contents: { coal: 5, diamond: 2 } })
    const r = await run({ action: 'list', x: 2, y: 1, z: 0 }, { mc: mkMc(f, { win }) })
    ok(r.text.includes('coal×5') && r.text.includes('diamond×2'), 'list 给坐标 → 列内容', r.text.split('\n').join(' | '))
    ok(win.calls.some((c) => c[0] === 'close'), '看完关窗口')
  }
  // list 给坐标但那不是箱子
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'stone' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const r = await run({ action: 'list', x: 2, y: 1, z: 0 }, { mc: mkMc(f, { win: mkChestWin(f, {}) }) })
    ok(r.text.includes('没有箱子'), '坐标不是箱子 → 退回附近搜索的结果', r.text.split('\n').join(' | '))
  }
  // 开不开
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }), pos: { x: 1.5, y: 1, z: 0.5 } })
    const mc = mkMc(f, { win: mkChestWin(f, {}) })
    mc.openCalls.push(1)
    const r = await run({ action: 'list', x: 2, y: 1, z: 0 }, { mc: Object.assign(mc, {}) })
    // 注：这里 openContainer 由 fake bot 提供，见下
    ok(typeof r.text === 'string', 'list 能返回文本')
  }
  // action 写错
  {
    const f = mkBot({}, { world: mkWorld({ '2,1,0': 'chest' }) })
    const r = await run({ action: 'dump', name: 'coal' }, { mc: mkMc(f, { win: mkChestWin(f, {}) }) })
    ok(r.text.includes('list / put / take'), 'action 写错 → 说明合法值', r.text.split('\n').join(' | '))
  }
  // 不在线
  {
    const f = mkBot({}, {})
    let threw = null
    try { await run({ action: 'list' }, { mc: mkMc(f, { online: false, win: mkChestWin(f, {}) }) }) } catch (e) { threw = e }
    ok(threw && /不在线/.test(threw.message), '机器人不在线 → 抛错', String(threw?.message))
  }
}

/* ─────────────────────── ⑧ 多叠 / 简称 / 坐标（2026-10-08 审计 H1·H2·H6） ─────────────────────── */
console.log('— ⑧ count 是总数 / 简称 / 给了坐标就别另放箱子 —')
{
  const world = () => mkWorld({ '2,1,0': 'chest' })
  const near = () => ({ x: 1.5, y: 1, z: 0.5 })

  // H1：背包里 cobblestone 64+32 两叠，count:16 ⇒ 只能搬 16（不是每叠 16、共 32）
  {
    const f = mkBot({}, { world: world(), pos: near(), stacks: [{ name: 'cobblestone', count: 64 }, { name: 'cobblestone', count: 32 }] })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', name: 'cobblestone', count: 16 }, { mc: mkMc(f, { win }) })
    const dep = win.calls.filter((c) => c[0] === 'deposit')
    const total = dep.reduce((s, c) => s + Number(c[2] ?? 0), 0)
    ok(total === 16, '两叠圆石（64+32）+ count:16 ⇒ 一共只搬 16（不是每叠 16）', JSON.stringify(dep))
    ok(dep.length === 1, '够 16 就一次搬完，不按叠重复调用', JSON.stringify(dep))
    ok(String(f.bot.inventory.count(idOf('cobblestone'))) === '80', '背包剩 80（96−16）', String(f.bot.inventory.count(idOf('cobblestone'))))
    ok(/真放进去了/.test(r.text) && /cobblestone×16/.test(r.text), '报告按箱子数量差如实说 16', r.text.split('\n').join(' | '))
  }
  // H1（take 侧）：箱子里 coal 64+32 两叠，count:16 ⇒ 只拿 16
  {
    const f = mkBot({}, { world: world(), pos: near() })
    const win = mkChestWin(f, { contents: { coal: 64 } })
    win.slots.set('coal', 96)              // 假装箱子里是 64+32 两叠（containerItems 会拆成两条）
    win.containerItems = () => [{ type: idOf('coal'), name: 'coal', count: 64, metadata: null }, { type: idOf('coal'), name: 'coal', count: 32, metadata: null }]
    const r = await run({ action: 'take', name: 'coal', count: 16 }, { mc: mkMc(f, { win }) })
    const wd = win.calls.filter((c) => c[0] === 'withdraw')
    const total = wd.reduce((s, c) => s + Number(c[2] ?? 0), 0)
    ok(total === 16, '箱子里两叠煤（64+32）+ count:16 ⇒ 一共只拿 16', JSON.stringify(wd))
    ok(wd.length === 1, '拿够 16 就停手', JSON.stringify(wd))
    ok(String(f.bot.inventory.count(idOf('coal'))) === '16', '背包里正好多 16 个煤', String(f.bot.inventory.count(idOf('coal'))))
  }
  // H2：简称要认（planks → oak_planks；log → oak_log）
  {
    const f = mkBot({ oak_planks: 8, oak_log: 3 }, { world: world(), pos: near() })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', name: 'planks', all: true }, { mc: mkMc(f, { win }) })
    const dep = win.calls.filter((c) => c[0] === 'deposit')
    ok(dep.some((c) => c[1] === 'oak_planks'), '简称 planks ⇒ 认 oak_planks（不是"背包里没有 planks"）', JSON.stringify(dep))
    ok(!/没有 \*\*planks\*\*/.test(r.text), '不再回"背包里没有 planks"', r.text.split('\n').join(' | '))
  }
  {
    const f = mkBot({ oak_log: 3, coal: 2 }, { world: world(), pos: near() })
    const win = mkChestWin(f, {})
    const r = await run({ action: 'put', name: 'log', all: true }, { mc: mkMc(f, { win }) })
    const dep = win.calls.filter((c) => c[0] === 'deposit')
    ok(dep.length === 1 && dep[0][1] === 'oak_log', '简称 log ⇒ 只认 oak_log（不把 coal 也搬进去）', JSON.stringify(dep))
    ok(!/coal/.test(dep.map((c) => c[1]).join()), 'coal 没被误搬', JSON.stringify(dep))
  }
  // H2：精确命中优先（有 oak_planks 就不放宽到 jungle_planks）
  {
    const f = mkBot({ oak_planks: 4, jungle_planks: 4 }, { world: world(), pos: near() })
    const win = mkChestWin(f, {})
    await run({ action: 'put', name: 'oak_planks', all: true }, { mc: mkMc(f, { win }) })
    const names = win.calls.filter((c) => c[0] === 'deposit').map((c) => c[1])
    ok(names.length === 1 && names[0] === 'oak_planks', '精确名字命中就不放宽（只搬 oak_planks）', JSON.stringify(names))
  }
  // H6：给了坐标、那里不是箱子 ⇒ 不许在脚边另放一个新箱子
  {
    const f = mkBot({ chest: 1 }, { world: mkWorld({ '2,1,0': 'stone' }), pos: near() })
    const mc = mkMc(f, { win: mkChestWin(f, {}) })
    const r = await run({ action: 'put', name: 'chest', count: 1, x: 2, y: 1, z: 0 }, { mc })
    ok(mc.placeCalls.length === 0, '坐标上不是箱子 ⇒ 一个方块都没放（不再在脚边造新箱子）', JSON.stringify(mc.placeCalls))
    ok(/不是\*\*箱子|不是\*\*箱子\/木桶|那里\*\*不是\*\*箱子/.test(r.text), '如实说"那个坐标上不是箱子"', r.text.split('\n').join(' | '))
    ok(/没有\*\*另放|我\*\*没有\*\*另放/.test(r.text), '明确说"我没有另放新箱子"', r.text.split('\n').join(' | '))
    ok(String(f.bot.inventory.count(idOf('chest'))) === '1', '背包里的箱子还在（没被放掉）', String(f.bot.inventory.count(idOf('chest'))))
  }
  // H6：没给坐标时，照旧可以自己放（别误伤）
  {
    const f = mkBot({ chest: 1 }, { world: mkWorld(), pos: near() })
    const mc = mkMc(f, { win: mkChestWin(f, {}) })
    const r = await run({ action: 'put', name: 'chest', count: 1 }, { mc })
    ok(mc.placeCalls.length === 1, '没给坐标 ⇒ 照旧自己放一个（这条别误伤）', JSON.stringify(mc.placeCalls))
    ok(/放到/.test(r.text), '报告里说明放了箱子', r.text.split('\n').join(' | '))
  }
  // H6：给的坐标是空/没加载 ⇒ 也如实说，并列出附近真实的箱子
  {
    const f = mkBot({}, { world: mkWorld({ '3,1,0': 'barrel' }), pos: near() })
    const mc = mkMc(f, { win: mkChestWin(f, {}) })
    const r = await run({ action: 'take', name: 'coal', x: 9, y: 9, z: 9 }, { mc })
    ok(/不是\*\*箱子/.test(r.text), '坐标是空气 ⇒ 如实说不是箱子', r.text.split('\n').join(' | '))
    ok(/barrel @ \(3,1,0\)/.test(r.text), '顺手列出附近真实的箱子（barrel）', r.text.split('\n').join(' | '))
    ok(mc.placeCalls.length === 0, '没另放新箱子', JSON.stringify(mc.placeCalls))
  }
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
