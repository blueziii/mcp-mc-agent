/**
 * mc_chest —— 存取箱子（mcp-mc-agent 扩展）
 *
 * 为什么需要它：插件原来 32 个工具里**没有"把东西存起来/从箱子里拿"**。
 * 后果很实际：背包只有 36 格，挖一趟矿就满了；死了装备全掉；家当没法攒。
 * "像正常玩家一样发展、最后打末影龙"这条长期目标走到中期必然卡在**没有仓库**上。
 *
 * 有没有现成的？
 *   · **高层插件：没有。** npm 上搜 `mineflayer chest / container / storage / inventory`
 *     返回的全是已经在用的那几个包（collectblock / pathfinder / tool / pvp / auto-eat / armor-manager）。
 *   · **底层原语：现成的。** mineflayer **自带** `lib/plugins/chest.js` + `inventory.js`：
 *     `bot.openContainer(block)` 之后窗口上有 `deposit(itemType, metadata, count)`（背包 → 箱子）、
 *     `withdraw(itemType, metadata, count)`（箱子 → 背包）、`containerItems()`（箱子里的东西）、`close()`。
 *     协议层的活一点不用自己写。
 *
 * 本文件做的事（都是 mineflayer 没做的"编排"）：
 *   ① **找箱子 / 没有就自己放一个**（复用 mc_util 的 findPlaceSpot）。
 *   ② **put / take 两种动作**，可以点名物品，也可以 `all:true` 全搬；`keep` 可以留一手。
 *   ③ **诚实的边界**：背包满（`Unable to withdraw, Bot inventory is full.`）、箱子满、
 *      开不开（被别人占着/隔墙）都如实说，并给下一步建议。
 *   ④ **搬完核对**：重新读一遍箱子和背包，报告"现在箱子里有什么、背包里还有什么"。
 *
 * 装法：放在 `<profile>/node_modules/mcp-mc-agent/extensions/` 下即自动加载（插件 index.js:4089 的扩展点）。
 *
 * 门禁：**加进** mc_observe 的 `DEFAULT_GATED` —— 存取会开世界里的箱子、挪里面的东西，
 * 属于"要动手之前先看一眼"那一类（门禁默认关，只有强制模式才拦）。
 *
 * 环境变量：无。参数都在工具调用里。
 */
import { blockIdOf, itemIdOf, itemNameOf, findPlaceSpot, blockAtXYZ, clamp, countOf } from './mc_util.mjs'
import { withTimeout, CALL_MS, callBudget } from '../src/core.mjs'

export const name = 'mc_chest'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 能当仓库开的方块（chest.js 的 allowedWindowTypes 里挑出来的；末影箱也算） */
export const CONTAINER_NAMES = [
  'chest', 'trapped_chest', 'barrel', 'ender_chest',
  'shulker_box', 'white_shulker_box', 'orange_shulker_box', 'magenta_shulker_box',
  'light_blue_shulker_box', 'yellow_shulker_box', 'lime_shulker_box', 'pink_shulker_box',
  'gray_shulker_box', 'light_gray_shulker_box', 'cyan_shulker_box', 'purple_shulker_box',
  'blue_shulker_box', 'brown_shulker_box', 'green_shulker_box', 'red_shulker_box',
  'black_shulker_box', 'hopper', 'dispenser', 'dropper',
]
/** 能放在脚边当仓库的东西（有就先不合成箱子） */
const PLACEABLE = ['chest', 'trapped_chest', 'barrel', 'shulker_box', 'ender_chest']

/* ───────────────────────── 基础小工具 ───────────────────────── */

function invItems (bot) {
  try { return bot.inventory.items() } catch { return [] }
}

/** 背包一行概览 */
export function bagText (bot, limit = 20) {
  const items = invItems(bot)
  if (!items.length) return '（空）'
  const byName = new Map()
  for (const it of items) byName.set(it.name, (byName.get(it.name) ?? 0) + it.count)
  const all = [...byName.entries()].sort((a, b) => b[1] - a[1])
  const shown = all.slice(0, limit).map(([n, c]) => `${n}×${c}`)
  const free = bot.inventory.emptySlotCount?.() ?? '?'
  return `${shown.join(' ')}${all.length > limit ? ` …（共 ${all.length} 种）` : ''}　【空位 ${free}】`
}

/** 箱子内容一行概览 */
export function chestText (win) {
  let items = []
  try { items = win.containerItems() } catch { items = [] }
  const free = typeof win.inventoryStart === 'number' ? win.inventoryStart : '?'
  if (!items.length) return `（空　共 ${free} 个位置）`
  const byName = new Map()
  for (const it of items) byName.set(it.name, (byName.get(it.name) ?? 0) + it.count)
  const all = [...byName.entries()].sort((a, b) => b[1] - a[1])
  /* 🔴 2026-10-08 第五份审计旁注：`items.length` 是**叠数**（一叠一条），写"N/free 格"会让模型
   *    以为"箱子里只剩 free-N 个空位"。改成"叠 / 个位置"。 */
  return `${all.map(([n, c]) => `${n}×${c}`).join(' ')}　（${items.length} 叠，共 ${free} 个位置）`
}

/* 🔴 2026-10-08 审计：`win.deposit()` / `win.withdraw()` **resolve 了不等于服务端真搬了**
 *    （它们底层就是 `clickWindow` 等窗口回包，1.17.1+ 的服务端会忽略"它认为没必要回"的点击）。
 *    所以搬完要拿**箱子里的数量差**对账，不能把计划当结果（就是用户抱怨的"报假成功"）。 */
export function chestSnap (win) {
  const m = new Map()
  try {
    for (const it of win.containerItems()) m.set(it.name, (m.get(it.name) ?? 0) + it.count)
  } catch { /* 假窗口 / 没打开 */ }
  return m
}

/* 🔴 2026-10-08 审计 H2：描述里承诺"英文 id **或简称**"，实现却是精确 `it.name === wantName`
 *    ⇒ `name:"planks"` / `name:"log"` 直接回"背包里没有 planks"，AI 以为家里没木板/原木，转头去砍树。
 *    这里跟 `mc_craft` 的 `resolveItem` 用同一套宽松匹配：先精确命中（有就不放宽），再 `_q` 结尾 / 包含。 */
export function pickNamed (list, want) {
  const q = String(want ?? '').trim().toLowerCase().replace(/^minecraft:/, '').replace(/\s+/g, '_')
  if (!q) return list
  const exact = list.filter((it) => String(it?.name ?? '').toLowerCase() === q)
  if (exact.length) return exact
  return list.filter((it) => {
    const n = String(it?.name ?? '').toLowerCase()
    return n.endsWith('_' + q) || n.includes(q)
  })
}

/* ───────────────────────── 找箱子 ───────────────────────── */

/** 附近找一个能开的仓库方块（给 x/y/z 就直接认那一个） */
export function findContainerBlock (bot, { x, y, z, radius = 8 } = {}) {
  if (Number.isFinite(Number(x)) && Number.isFinite(Number(y)) && Number.isFinite(Number(z))) {
    const b = blockAtXYZ(bot, x, y, z)
    return b && CONTAINER_NAMES.includes(b.name) ? b : null
  }
  // 🔴 必须用**方块 id**（blocksByName），不是物品 id —— findBlock 比的是 block.type
  const ids = CONTAINER_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return null
  try {
    return bot.findBlock({ matching: ids, maxDistance: clamp(Number(radius) || 8, 1, 32) }) ?? null
  } catch { return null }
}

/**
 * 附近所有仓库方块（给 list 用）。
 * 🔴 mineflayer 4.39 的 `findBlocks` 返回的是**坐标**（`{x,y,z}`）不是方块对象
 * （`blocks.js:212`，只有 `findBlock` 才 `blockAt(blocks[0])`），所以这里必须自己转回方块。
 */
export function findContainers (bot, { radius = 16, limit = 24 } = {}) {
  const ids = CONTAINER_NAMES.map((n) => blockIdOf(bot, n)).filter((v) => v != null)
  if (!ids.length) return []
  let raw = []
  try {
    raw = bot.findBlocks({ matching: ids, maxDistance: clamp(Number(radius) || 16, 1, 32), count: clamp(limit, 1, 64) }) ?? []
  } catch { return [] }
  const out = []
  for (const r of raw) {
    const b = r?.name ? r : blockAtXYZ(bot, r?.x, r?.y, r?.z)
    if (b && CONTAINER_NAMES.includes(b.name)) out.push(b)
  }
  return out
}

/** 背包里有没有能当仓库放的东西 */
export function chestInInventory (bot) {
  for (const n of PLACEABLE) {
    const id = itemIdOf(bot, n)
    const have = countOf(bot, id)
    if (have > 0) return { name: n, id, have }
  }
  return null
}

/* ───────────────────────── 文本 ───────────────────────── */

export function listText (bot, { radius = 16 } = {}) {
  const lines = [`🎒 背包：${bagText(bot)}`]
  const boxes = findContainers(bot, { radius })
  if (!boxes.length) {
    lines.push(`📦 ${radius} 格内没有箱子/木桶。`)
    const inv = chestInInventory(bot)
    if (inv) lines.push(`　→ 背包里有 ${inv.name}×${inv.have}，说一声我就放到脚边（\`mc_chest {action:"put",name:"…",placeChest:true}\`）。`)
    else lines.push('　→ 想攒东西就先做一个：`mc_craft {name:"chest"}`（8 个木板），然后叫我（我会自己放）。')
    return lines.join('\n')
  }
  lines.push(`📦 ${radius} 格内的仓库（${boxes.length} 个）：`)
  const me = bot.entity?.position
  for (const b of boxes.slice(0, 12)) {
    const d = me?.distanceTo ? me.distanceTo(b.position).toFixed(1) : '?'
    lines.push(`　· ${b.name} @ (${b.position.x},${b.position.y},${b.position.z})　${d} 格`)
  }
  if (boxes.length > 12) lines.push(`　…还有 ${boxes.length - 12} 个`)
  lines.push('　→ 看某个箱子里有什么：`mc_chest {action:"list",x:…,y:…,z:…}`')
  return lines.join('\n')
}

/** 缺东西时的下一步建议 */
export function hintFor (name) {
  const n = String(name ?? '')
  if (/^raw_/.test(n)) return `粗矿：\`mc_dig {name:"${n.replace(/^raw_/, '')}_ore",count:3}\`（要用对镐子），再 \`mc_furnace\` 烧`
  if (/_ore$/.test(n)) return `矿石：\`mc_dig {name:"${n}",count:3}\`（要用对镐子），再 \`mc_furnace\` 烧`
  if (n === 'cobblestone') return '圆石：`mc_dig {name:"stone",count:8}`（要用镐子）'
  if (/_log$|_wood$/.test(n)) return `原木：\`mc_dig {name:"${n}",count:3}\`（砍树）`
  if (n === 'stick') return '木棍：`mc_craft {name:"stick"}`（2 个木板 → 4 根）'
  if (/_planks$/.test(n)) return `木板：\`mc_craft {name:"${n}"}\`（1 个原木 → 4 块）`
  return '先想办法弄到它（`mc_dig` 挖 / `mc_craft` 合成 / `mc_furnace` 烧 / 打怪掉落）'
}

/* ───────────────────────── 工具 ───────────────────────── */

export async function apply (api) {
  const { ctx, asTool, getSession, logLine } = api

  ctx.tools.register(asTool({
    name: 'mc_chest',
    description: '📦 **存取箱子**（真·仓库，走服务端的箱子/木桶，不是作弊给物）。背包只有 36 格，攒家当就靠它。\n'
      + '· `action:"list"`（默认）：看背包里有什么、附近有哪些箱子；给 x/y/z 就打开那个箱子列内容。\n'
      + '· `action:"put"`：把背包里的东西放进箱子（`name:"iron_ingot", count:16`，或 `all:true` 全放）。\n'
      + '· `action:"take"`：从箱子里拿出来（`name:"coal", count:8`，或 `all:true` 全拿）。\n'
      + '· 附近没有箱子、但背包里有，就**自己放到脚边**再用（`placeChest:false` 可关）；'
      + '都没有会告诉你去 `mc_craft {name:"chest"}` 做一个（8 个木板）。\n'
      + '· `all:true` 是**真的全搬**（工具也会被放进去！想留东西就写 `name`，或者用 `keep:"wooden_pickaxe,stone_sword"` 留一手）。\n'
      + '· 背包满 / 箱子满 / 开不开都会如实说；搬完会重新读一遍箱子，告诉你现在里面有什么。\n'
      + '🔴 会动世界里的箱子，所以**受 mc_observe 门禁限制**（强制模式下要先看一眼）。',
    parameters: {
      action: { type: 'string', description: 'list（看，默认）/ put（放进去）/ take（拿出来）' },
      name: { type: 'string', description: '物品英文 id 或简称，如 iron_ingot / coal / cobblestone / oak_log；put/take 不给就要 all:true' },
      count: { type: 'number', description: '搬几个（默认：点名物品就全搬，all:true 也全搬）' },
      all: { type: 'boolean', description: 'put/take 时全搬（默认 false）' },
      keep: { type: 'string', description: '逗号分隔的物品名，put 时绝不动它们（可选）' },
      x: { type: 'number', description: '指定箱子坐标 x（可选，和 y/z 一起给）' },
      y: { type: 'number', description: '指定箱子坐标 y（可选）' },
      z: { type: 'number', description: '指定箱子坐标 z（可选）' },
      radius: { type: 'number', description: '找箱子的半径（默认 8，最大 32）' },
      placeChest: { type: 'boolean', description: '附近没箱子时自己放一个（默认 true）' },
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
      // 🔴 等区块 / 走近 / 开关窗口都算进"这一轮 11 秒"（用户要求：单次调用别超过 11 秒）
      await withTimeout(mc.waitForChunks(), CALL_MS, '等待区块加载')

      const action = String(args.action ?? 'list').toLowerCase()
      const radius = clamp(Number(args.radius) || 8, 1, 32)

      /* ① 只看 */
      if (action === 'list') {
        const one = findContainerBlock(bot, { x: args.x, y: args.y, z: args.z, radius })
        if (!one) return { text: listText(bot, { radius }) }
        const at = one.position
        const lines = [`🎒 背包：${bagText(bot)}`, `📦 ${one.name} @ (${at.x},${at.y},${at.z})`]
        let win = null
        try {
          const p = bot.entity.position
          if (p && p.distanceTo?.(at) > 4) await mc.walkTo({ x: at.x, y: at.y, z: at.z }, { arrive: 2.2, budget: callBudget(20_000) })
          win = await withTimeout(bot.openContainer(one), callBudget(10_000), '开箱子')
          lines.push(`　里面：${chestText(win)}`)
        } catch (e) {
          lines.push(`　❌ 打不开：${e?.message ?? e}`)
          lines.push('　→ 可能被别人占着、或者被方块挡住了；换个箱子或清一下周围。')
        } finally {
          try { win?.close?.() } catch {}
        }
        return { text: lines.join('\n') }
      }

      if (action !== 'put' && action !== 'take') {
        return { text: `❌ action 只能是 list / put / take（给的是 “${args.action}”）` }
      }

      const wantName = args.name == null || args.name === '' ? null : String(args.name).trim().toLowerCase().replace(/^minecraft:/, '')
      if (!wantName && args.all !== true) {
        return { text: `❌ ${action} 要么写 name（如 name:"iron_ingot"），要么写 all:true 全搬。\n　（想先看看有什么：\`mc_chest {action:"list"}\`）` }
      }
      const keepSet = new Set(String(args.keep ?? '').split(/[,，\s]+/).map((s) => s.trim().toLowerCase().replace(/^minecraft:/, '')).filter(Boolean))

      /* ② put 先算清要搬哪些 —— 没有就不白放一个箱子 */
      const plan = []
      if (action === 'put') {
        for (const it of pickNamed(invItems(bot), wantName)) {
          /* 注意：这里**不能**再写 `if (it.name !== wantName) continue` ——
           * `pickNamed` 已经做过匹配（精确优先、否则按简称），再卡一次精确就把简称全废了（审计 H2）。 */
          if (keepSet.has(it.name)) continue
          plan.push({ name: it.name, type: it.type, metadata: it.metadata ?? null, have: it.count, move: it.count })
        }
        if (!plan.length) {
          const lines = [`❌ 背包里${wantName ? `没有 **${wantName}**` : '没有能搬的东西'}。`]
          if (wantName) lines.push(`　→ ${hintFor(wantName)}`)
          lines.push(`　（背包现在：${bagText(bot)}）`)
          return { text: lines.join('\n') }
        }
      }
      const wantCount = Number(args.count)
      /* 🔴 2026-10-08 审计 H1：`count` 是"这一趟要搬的**总数**"——`bot.transfer` 内部就是
       *    `count -= movedItems`（`mineflayer/lib/plugins/inventory.js:275-363`），不是"每叠搬多少"。
       *    旧代码在循环里对**每一叠**都 `Math.min(n, count)` ⇒ 背包里 64+32 两叠圆石、`count:16`
       *    会真搬 32 个（16+16）。改成总额在循环外扣减。 */
      const wantTotal = Number.isFinite(wantCount) && wantCount > 0 ? Math.round(wantCount) : Infinity
      let left = wantTotal

      /* ③ 找箱子（没给坐标、附近也没有才放一个） */
      const wantPos = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) && Number.isFinite(Number(args.z))
      let box = findContainerBlock(bot, { x: args.x, y: args.y, z: args.z, radius })
      let placedNote = null
      /* 🔴 2026-10-08 审计 H6：**给了坐标却在那里找不到箱子**时，以前会照走"没箱子就放一个"这条路
       *    ⇒ 在脚边另造一个新箱子，然后对着它存/取。AI 从 `mc_scan` 拿到坐标、y 记错一格，
       *    就会把家当存进一个自己不知道的新箱子，或者对着新箱子说"箱子里没有 coal"。
       *    给了坐标就**只认那个坐标**：找不到就如实说，并列出附近真实的箱子。 */
      if (!box && wantPos) {
        const near = findContainers(bot, { radius })
        const me = bot.entity?.position
        const show = near.slice(0, 6).map((b) => {
          const d = me?.distanceTo ? me.distanceTo(b.position).toFixed(1) : '?'
          return `${b.name} @ (${b.position.x},${b.position.y},${b.position.z}) ${d} 格`
        })
        const lines = [
          `❌ (${args.x},${args.y},${args.z}) 那里**不是**箱子/木桶（读到的是 ${blockAtXYZ(bot, args.x, args.y, args.z)?.name ?? '空气/没加载'}）。`,
          '　→ 我**没有**另放新箱子（免得你把东西存进一个自己不知道的箱子）。',
        ]
        lines.push(near.length ? `　附近 ${radius} 格内真实的箱子：${show.join('、')}` : `　附近 ${radius} 格内也没有箱子。`)
        lines.push('　→ 坐标用 `mc_scan` 或 `mc_chest {action:"list"}` 里报的那一个；不想给坐标就直接 `mc_chest {action:"put",name:"…"}`（我会用最近的箱子，没有就放一个）。')
        logLine(`mc_chest：给的坐标 (${args.x},${args.y},${args.z}) 上没有箱子，没另放`)
        return { text: lines.join('\n') }
      }
      if (!box && args.placeChest !== false) {
        const inv = chestInInventory(bot)
        if (inv) {
          const spot = findPlaceSpot(bot, { radius: 2 })
          if (spot && args.dryRun === true) {
            placedNote = `（dryRun：附近没箱子，真跑的时候我会把背包里的 ${inv.name} 放到 (${spot.x},${spot.y},${spot.z})）`
            box = { position: spot, name: inv.name, virtual: true }
          } else if (spot) {
            try {
              const r = await mc.placeBlock({ x: spot.x, y: spot.y, z: spot.z, name: inv.name })
              if (r?.placed) {
                /* 客户端收到方块更新会晚一拍：立刻查常常还是 null（审计旁注）。
                 * 放完轮询几百毫秒再认，免得"说放好了但找不到箱子"。 */
                for (let i = 0; i < 6 && !box; i++) {
                  box = findContainerBlock(bot, { x: spot.x, y: spot.y, z: spot.z })
                  if (!box) await sleep(150)
                }
                placedNote = box
                  ? `（附近本来没有箱子，我把背包里的 ${inv.name} 放到 (${spot.x},${spot.y},${spot.z}) 了）`
                  : `（方块放出去了，但客户端还没收到方块更新，读不到 (${spot.x},${spot.y},${spot.z}) 上的箱子 —— 过一会儿再叫我一次）`
                logLine(`mc_chest：自动放了 ${inv.name} (${spot.x},${spot.y},${spot.z})${box ? '' : '（还没读到）'}`)
              } else {
                placedNote = `（想放箱子但没成功：${r?.note ?? '未知原因'}）`
              }
            } catch (e) {
              placedNote = `（想放箱子但失败：${e.message}）`
            }
          } else {
            placedNote = '（想放箱子，但脚边找不到能放的空位）'
          }
        }
      }
      if (!box) {
        const inv = chestInInventory(bot)
        const lines = []
        if (placedNote) lines.push(placedNote)
        lines.push(`❌ 附近 ${radius} 格没有箱子/木桶，背包里${inv ? `有 ${inv.name}×${inv.have} 但放不下` : '也没有'}。`)
        lines.push('　→ 先做一个：`mc_craft {name:"chest"}`（8 个木板），然后叫我（我会自己放）；')
        lines.push('　　或者你自己 `mc_act {mode:"place",name:"chest",x:…,y:…,z:…}` 放到脚边。')
        logLine(`mc_chest：找不到箱子`)
        return { text: lines.join('\n') }
      }

      const at = box.position
      const head = []
      if (placedNote) head.push(placedNote)
      head.push(`📦 ${box.name} @ (${at.x},${at.y},${at.z})`)

      /* ④ 走/飞到够得着（openContainer 要 4.5 格内） */
      if (!box.virtual) {
        try {
          const p = bot.entity.position
          if (p && p.distanceTo?.(at) > 4) await mc.walkTo({ x: at.x, y: at.y, z: at.z }, { arrive: 2.2, budget: callBudget(20_000) })
        } catch (e) {
          logLine(`mc_chest：靠近箱子没成功（${e.message}），还是试着开一下`)
        }
      }

      /* ⑤ dryRun：先把计划写出来，不动手 */
      if (args.dryRun === true) {
        const lines = [...head]
        if (action === 'put') {
          let acc = wantTotal
          const shown = plan.map((p) => {
            const n = acc === Infinity ? p.move : Math.min(p.move, acc)
            if (acc !== Infinity) acc -= n
            return `${p.name}×${n}`
          })
          lines.push(`（dryRun）会把 ${shown.join('、')} 放进去。`)
        } else {
          lines.push('（dryRun）现在**没开箱子**，所以看不到里面有什么 —— 去掉 dryRun 真跑一次才知道能拿什么。')
          if (wantName) lines.push(`　计划：从箱子里拿 **${wantName}**${Number.isFinite(wantCount) ? ` ×${Math.round(wantCount)}` : '（全部）'}。`)
        }
        return { text: lines.join('\n') }
      }

      /* ⑥ 开箱子干活 */
      let win = null
      try {
        win = await withTimeout(bot.openContainer(box), callBudget(10_000), '开箱子')
      } catch (e) {
        const lines = [...head]
        lines.push(`❌ 打不开：${e?.message ?? e}`)
        lines.push('　→ 可能被别人占着、或者被方块挡住了；换个箱子或清一下周围。')
        return { text: lines.join('\n') }
      }

      const before = chestText(win)
      const snapBefore = chestSnap(win)
      let snapAfter = null
      const moved = []
      const failed = []
      let cut = null          // 🔴 这一轮 11 秒用完时的说明（不是失败，是"下次接着搬"）
      try {
        if (action === 'put') {
          for (const p of plan) {
            if ((mc.msLeft?.() ?? Infinity) < 300) { cut = '这一轮的 11 秒用完了，剩下的下次再搬（再叫一次 mc_chest 就行）'; break }
            let n = p.move
            if (left !== Infinity) n = Math.min(n, left)
            if (n <= 0) { if (left !== Infinity) break; continue }
            try {
              await withTimeout(win.deposit(p.type, p.metadata, n), callBudget(15_000), `放进箱子 ${p.name}`)
              moved.push(`${p.name}×${n}`)
              if (left !== Infinity) left -= n
            } catch (e) {
              failed.push(`${p.name}：${e?.message ?? e}`)
              break // 箱子满了就别再试下一个
            }
          }
        } else {
          let items = []
          try { items = win.containerItems() } catch { items = [] }
          if (!items.length) {
            const lines = [...head, `　里面：${before}`, '❌ 箱子是空的，没东西可拿。']
            return { text: lines.join('\n') }
          }
          const picks = pickNamed(items, wantName)
          if (!picks.length) {
            const lines = [...head, `　里面：${before}`, `❌ 箱子里没有 **${wantName}**。`, `　→ ${hintFor(wantName)}`]
            return { text: lines.join('\n') }
          }
          for (const it of picks) {
            if ((mc.msLeft?.() ?? Infinity) < 300) { cut = '这一轮的 11 秒用完了，剩下的下次再拿（再叫一次 mc_chest 就行）'; break }
            let n = it.count
            if (left !== Infinity) n = Math.min(n, left)
            if (n <= 0) { if (left !== Infinity) break; continue }
            try {
              await withTimeout(win.withdraw(it.type, it.metadata ?? null, n), callBudget(15_000), `拿出 ${it.name}`)
              moved.push(`${it.name}×${n}`)
              if (left !== Infinity) left -= n
            } catch (e) {
              failed.push(`${it.name}：${e?.message ?? e}`)
              break // 背包满了就别再试下一个
            }
          }
        }
      } finally {
        try { snapAfter = chestSnap(win) } catch {}
        try { win?.close?.() } catch {}
      }

      /* ⑥ 报告（先按**箱子里的数量差**对账，再说话） */
      const real = []
      if (snapAfter) {
        const names = new Set([...snapBefore.keys(), ...snapAfter.keys()])
        for (const nm of names) {
          const d = (snapAfter.get(nm) ?? 0) - (snapBefore.get(nm) ?? 0)
          const delta = action === 'put' ? d : -d      // put：箱子里多了算成功；take：箱子里少了算成功
          if (delta > 0) real.push(`${nm}×${delta}`)
        }
      }
      const lines = [...head]
      lines.push(`　搬之前：${before}`)
      if (real.length) lines.push(`　✅ ${action === 'put' ? '真放进去了' : '真拿出来了'}（按箱子数量核对）：${real.join('、')}`)
      else if (moved.length) lines.push(`　⚠️ 动作发出去了（${moved.join('、')}），但**箱子里的数量没变** —— 服务端可能没认这次点击：再叫一次 mc_chest，或用 mc_diag 看窗口`)
      else lines.push(`　⚠️ 一个都没搬动`)
      if (cut) lines.push(`　⏳ ${cut}`)
      if (failed.length) {
        lines.push(`　⚠️ 卡住：${failed.join('；')}`)
        lines.push(`　→ ${/inventory is full/i.test(failed.join(' ')) ? '背包满了：先 `mc_chest {action:"put",all:true}` 存一批，或者丢掉没用的东西' : '箱子满了：换一个箱子，或者先拿走一些'}`)
      }
      // 复核
      let after = null
      try {
        const w2 = await withTimeout(bot.openContainer(box), callBudget(10_000), '开箱子复核')
        try { after = chestText(w2) } finally { try { w2?.close?.() } catch {} }
      } catch {}
      if (after) lines.push(`　现在里面：${after}`)
      lines.push(`　背包现在：${bagText(bot)}`)
      logLine(`mc_chest：${action} ${moved.join('、') || '（没搬动）'}`)
      return { text: lines.join('\n') }
    },
  }))

  logLine('mc_chest 已加载：工具 mc_chest（找/放箱子、put/take、背包满会说；受看图门禁限制）')
}
