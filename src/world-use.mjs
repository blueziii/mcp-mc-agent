/**
 * "使用/交互"那一层（路线图第 ④ 条第二十刀）。
 *
 * 搬走 `McBot` 的四个成员（第二十刀两个，第二十七刀又补两个）：
 *   · `useBlock ({x,y,z,who})` —— 右键**方块或实体**（`activateBlock` / `activateEntity`）：
 *     开箱子、按按钮、拉杆、开门、喂动物、上船…
 *   · `useItem ({hold})`       —— 对着**空气**用**手上的东西**（`activateItem` / `deactivateItem`）：
 *     扔末影之眼/珍珠/雪球/鸡蛋、拉弓射箭、喝药水。
 *
 * 两者的共同点：**服务端都不回执**（上游 `mineflayer\lib\plugins\inventory.js` 只 `await lookAt`
 * 再写一个包），所以这一层的全部价值在"**怎么复核**"：容器看窗口开没开、门/按钮看方块状态翻没翻、
 * 骑乘看 `bot.vehicle`、物品看用完之后还剩几个。
 *
 * 三条约定（跟前面几刀一样）：
 *   ① **不反向 import `core.mjs`** —— 只吃传进来的 `b`（mineflayer bot）。
 *   ② 只借 `vec3` 与兄弟模块（`camera.mjs` / `block-names.mjs` / `entity-names.mjs` / `async-util.mjs`），
 *      **不直接 import mineflayer**，依赖方向保持"叶子 → 上层"。
 *   ③ 属于插件实例状态的东西走 `ctx`（迁移规矩第 17 / 24 条）：
 *      `ctx.t(promise, kind, label)` 是本轮 11 秒闸门 + 中断（`core.mjs` 的 `#t`）；
 *      `ctx.callLeft()` 是"这一轮还剩多少毫秒"（`useItem` 要留 400ms 给松手包）。
 *      `t` 的兜底写成"直接 await"，自写冒烟就不必造真闸门。
 */
import { Vec3 } from 'vec3'
import { sleep, waitUntil } from './async-util.mjs'
/* 🔴 报告 H1（2026-10-13）：`toward` 那条路用了 `callBudget(...)` 却**没 import** ——
 *    `mc_act {mode:"toward"}` 必抛 `ReferenceError: callBudget is not defined`。
 *    拆分时（第二十/二十七刀）漏掉的。 */
import { callBudget } from './budget.mjs'
import { aimAt } from './camera.mjs'
import { CONTAINER_RE, TOGGLE_RE } from './block-names.mjs'
import { entityNameOf, pickEntity } from './entity-names.mjs'
import { heldText, equipDestOf } from './inventory.mjs'

/**
 * 使用/激活方块或实体（开门、按按钮、拉杆、开箱子、喂动物…）。
 *
 * 🔴 2026-10-08 审计改了两处：
 *   ① 交互**到底成没成要复核**：`activateBlock`/`activateEntity` 内部只 `await lookAt` +
 *      写一个包（`mineflayer\lib\plugins\inventory.js:195-258`），**服务端不会回执** ——
 *      旧版无条件 `return { usedBlock }`，等于"包发出去了"就报成功。
 *      现在：容器看窗口开没开、门/按钮看方块状态翻没翻、骑乘看 `bot.vehicle`。
 *   ② `who` 用和 `attack()` 同一套匹配（中文别名/displayName 都认），找不到时列出附近实际有谁。
 */
export async function useBlock (b, { x, y, z, who = null } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  if (who) {
    const me = b.entity?.position
    const list = Object.values(b.entities ?? {}).filter((e) => e !== b.entity).map((e) => {
      let d = Infinity
      try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
      return { e, d }
    })
    const { hit, near } = pickEntity(list, who)
    if (!hit) {
      throw new Error(`附近找不到实体 "${who}"（附近实际有：${near.length ? near.join('、') : '什么都没有'}）`
        + '—— 名字要跟 mc_observe "程序检测到"里显示的一致（中文叫法也认）')
    }
    const ent = hit.e
    const dist = Number.isFinite(hit.d) ? Number(hit.d.toFixed(1)) : null
    if (dist != null && dist > 4.5) {
      return {
        usedEntity: entityNameOf(ent), distance: dist, reached: false,
        note: `太远了（${dist} 格，交互要 4.5 格内）—— 先 mc_move 到它旁边（或者 mc_act {mode:"toward", who:"${who}"}）再 use`,
      }
    }
    aimAt(b, { x: ent.position.x, y: ent.position.y + 1, z: ent.position.z })
    await t(Promise.resolve(b.activateEntity(ent)), 'act', `与 ${who} 交互`)
    await sleep(220)
    const riding = b.vehicle && b.vehicle.id === ent.id
    return {
      usedEntity: entityNameOf(ent), ...(dist != null ? { distance: dist } : {}),
      ...(riding ? { riding: entityNameOf(ent) } : {
        note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认它生效（`activateEntity` 内部只瞄一下再发包）。'
          + '如果没反应：确认它在 4.5 格内、你没被方块挡住、它不是别人拴着的/有主人的',
      }),
    }
  }
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const blk = b.blockAt(pos)
  if (!blk) throw new Error(`${pos.x},${pos.y},${pos.z} 未加载`)
  const at = { x: pos.x, y: pos.y, z: pos.z }
  const props0 = { ...(blk.getProperties?.() ?? {}) }
  aimAt(b, new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5))
  /* 🔴 2026-10-15 审计（报告 C 第 7 条）：容器类必须记"使用**之前**是哪个窗口" ——
   *   本来就已经开着别的窗口时，服务端会忽略这次使用（本文件下面 `:286-287` 的注释自己写着），
   *   于是旧代码会拿"上一次留下的旧窗口"当成本次的证据。**必须在 activateBlock 之前取快照**。 */
  const win0 = b.currentWindow
  await t(Promise.resolve(b.activateBlock(blk)), 'act', `使用 ${blk.name}`)
  // ① 容器类：窗口该弹出来 —— 这是唯一硬证据
  if (CONTAINER_RE.test(blk.name)) {
    for (let i = 0; i < 10; i++) {
      await sleep(120)
      const w = b.currentWindow
      if (w && w !== b.inventory && w !== win0) {
        return {
          usedBlock: blk.name, at, opened: w.type,
          ...(typeof w.containerItems === 'function' ? { slots: w.containerItems().length } : {}),
        }
      }
    }
    return {
      usedBlock: blk.name, at, opened: false,
      note: `${blk.name} 的窗口**没有打开**（等了 1.2 秒）—— 包发出去了但服务端没回应：`
        + '够不着（要 4.5 格内、看得见）/ 被别的玩家占着 / 位置读错了。别当成开成功了。'
        + '先 mc_move 走近再试，或者 mc_scan 看一眼那格到底是什么',
    }
  }
  // ② 门/活板门/栅栏门/按钮/拉杆：方块状态应该翻转
  if (TOGGLE_RE.test(blk.name)) {
    await sleep(280)
    const after = b.blockAt(pos)
    const props1 = { ...(after?.getProperties?.() ?? {}) }
    const changed = Object.keys(props1).filter((k) => props0[k] !== props1[k])
    return {
      usedBlock: blk.name, at,
      ...(changed.length
        ? { toggled: true, changed: changed.map((k) => `${k}: ${props0[k]} → ${props1[k]}`) }
        : { toggled: false, note: `${blk.name} 的状态**一点没变**（${Object.entries(props0).map(([k, v]) => `${k}=${v}`).join(' ') || '没有可读状态'}）—— 交互没生效：够不着（4.5 格内、看得见）或被红石/插件锁着` }),
    }
  }
  // ③ 其它（床、蛋糕、炼药锅…）：只能如实说"包发出去了"
  await sleep(280)
  const after2 = b.blockAt(pos)
  const props2 = { ...(after2?.getProperties?.() ?? {}) }
  const changed2 = Object.keys(props2).filter((k) => props0[k] !== props2[k])
  return {
    usedBlock: blk.name, at,
    ...(changed2.length ? { changed: changed2.map((k) => `${k}: ${props0[k]} → ${props2[k]}`) } : {}),
    note: '交互包已经发出去了 —— 服务端**不会回执**，我没法确认生效（`activateBlock` 内部只瞄一下再发包）。'
      + '如果没反应：确认 4.5 格内、看得见、没被挡住',
  }
}

/**
 * 对着**空气**用**手上的东西**（右键）：扔末影之眼 / 末影珍珠 / 雪球 / 鸡蛋，拉弓射箭，喝药水。
 *
 * 为什么单独一个动作：`useBlock` 只能右键**方块或实体**（`activateBlock` / `activateEntity`），
 * 而上面这些用的是 `activateItem`（对着空气用物品）。2026-10-06 用户问"现在能通关吗"时
 * 定位到的硬缺口就是它 —— 没有它**找不到要塞**（扔末影之眼是原版唯一办法），也射不掉
 * 末影水晶、射不了烈焰人。补之前全仓一次 `activateItem` 都没有。
 *
 * `hold`：按住多少毫秒再松手（`deactivateItem`）。
 *   - 拉弓**必须给**（弦拉满约 1000ms，不给就只是"举起弓"不射箭）；
 *   - 喝药水约 1600ms；
 *   - 可扔物（眼睛 / 珍珠 / 雪球）给了也无害，松手包是幂等的。
 */
export async function useItem (b, { hold = 0 } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const item = b.heldItem
  if (!item) {
    throw new Error('手上没东西 —— 先用 mc_act{mode:"equip",name:"…"} 拿到手上（mc_inventory 看背包里有什么）')
  }
  // 别把一轮 11 秒全用来"按住不放"：最多 3 秒，且**给松手留 400ms 余量**。
  // 🔴 这个余量是必需的：松手包（`deactivateItem`）也要过 `#t` 的预算闸门，
  //    如果按住把这一轮吃干，松手会被拒 ⇒ 拉弓变成"一直举着弓、箭永远不出去"
  //    （实测就是被自己的回归套件 check-core-useitem ⑤ 抓到的）。
  const raw = ctx.callLeft ? Number(ctx.callLeft()) : 11_000
  const left = Number.isFinite(raw) ? raw : 11_000
  const want = Math.max(0, Number(hold) || 0)
  const ms = Math.max(0, Math.min(want, 3_000, Math.max(0, left - 400)))
  await t(Promise.resolve(b.activateItem()), 'act', `使用 ${item.name}`)
  if (ms > 0) await sleep(ms)
  if (want > 0 && typeof b.deactivateItem === 'function') {
    await t(Promise.resolve(b.deactivateItem()), 'act', `松开 ${item.name}`)
  }
  const out = { used: item.name, count: item.count, heldMs: ms }
  /* 🔴 2026-10-08 第五份审计报告 ⑦：`count` 是**使用前**的快照 —— 末影珍珠/雪球扔出去后
   *    仍报旧数量，模型以为手上还有 N 个。这里补一个"用完之后还剩多少"。 */
  const after = (() => {
    try {
      const h = b?.heldItem
      if (h && h.name === item.name) return h.count
      const all = b.inventory.items().filter((i) => i.name === item.name)
      return all.reduce((s, i) => s + i.count, 0)
    } catch { return null }
  })()
  if (after != null) {
    out.left = after
    if (after >= item.count && item.name !== 'bow' && item.name !== 'crossbow') {
      out.note = `手上还是 ${after} 个（没少）—— 这一下可能没真用出去（服务端不回执这类动作，用 mc_inventory 复核）`
    }
  }
  if (want > ms) {
    out.note = [out.note, `这一轮剩下的时间不够按住 ${want}ms（只按了 ${ms}ms）—— 过一会儿再叫一次 mc_act{useitem} 补`].filter(Boolean).join('；')
  }
  return out
}

/** 统一交互入口：mode = look / place / break / toward */
export async function interact (self, args = {}) {
  const mode = String(args.mode ?? 'look')
  if (mode === 'look') return { mode, ...(await self.lookAt(args)) }
  if (mode === 'place') return { mode, ...(await self.placeBlock(args)) }
  if (mode === 'break') return { mode, ...(await self.breakBlock(args)) }
  if (mode === 'toward') {
    const b = self.requireBot()
    if (!args.who) throw new Error('toward 需要 who（玩家名）')
    const r = await self.lookAt({ who: args.who })
    if (args.approach !== false) {
      /* 🟡 2026-10-15 审计（报告 C 第 8 条）：这里原来写 `const target = b.entity.position.clone()`
       *   —— 那是**机器人自己**的坐标，于是走过去的 y 用的是"我脚下那一格"，目标在楼上/楼下时会走错层。
       *   `lookAt()` 返回的 `lookingAt` 才是目标的实际坐标（`src/camera.mjs:96`），直接用它的 y。
       *   另外原来在这里和后面各 `lookAt` 了一次、最后 return 又调一次（共 3 次），中间那次是多余的。 */
      const eye = { x: r.lookingAt.x, y: r.lookingAt.y, z: r.lookingAt.z }
      await self.walkTo(eye, { arrive: 3, budget: callBudget(args.budgetMs) })
    }
    return { mode, ...(await self.lookAt({ who: args.who })), position: self.position }
  }
  throw new Error(`未知 mode：${mode}（可用 look / place / break / toward）`)
}

/**
 * 穿/换装备。
 *
 * `to` 不传就按物品名猜（`equipDestOf`）：头盔→头、胸甲→身、护腿→腿、靴子→脚、盾/图腾→副手，
 * 其余照旧"拿到手上"。**只给 `to` 不给 `name` = 脱下那一格**（`bot.unequip`）。
 *
 * 为什么会有这一版（2026-10-13 用户："它现在看不到自己身上的装备，增加装备栏，让它能通过装备栏
 * 装备装备"）：旧版只会 `b.equip(item, 'hand')` —— 盔甲也能"拿到手上"，但**永远穿不到身上**；
 * 而 `bot.inventory.items()` 又只回背包那 9–44 格（`inventory.mjs` 的 `equipmentOf` 注释里写了
 * 为什么），所以 AI 既看不见自己穿没穿、也没法把头盔真戴上。
 *
 * 复核方式：手上那格看 `b.heldItem`；盔甲那格看 `b.inventory.slots[5/6/7/8/45]`（上游对非
 * `hand` 的目标走 `moveSlotItem`，是**换位**——原来穿着的那件会回到背包，所以带 `swappedOut`）。
 */
export async function equip (self, { name = null, to = null } = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const b = self.requireBot()
  const DEST_OK = new Set(['hand', 'head', 'torso', 'legs', 'feet', 'off-hand'])
  const dest = to == null ? null : String(to).toLowerCase() === 'offhand' ? 'off-hand' : String(to).toLowerCase()
  if (dest && !DEST_OK.has(dest)) {
    throw new Error(`to 只能是 hand / head / torso / legs / feet / off-hand（给的是 ${to}）`)
  }
  const slotOf = (d) => { try { return b.getEquipmentDestSlot?.(d) ?? null } catch { return null } }
  const readSlot = (s) => (s != null && Array.isArray(b.inventory?.slots) ? b.inventory.slots[s] : null)

  /* 只给 to ⇒ 脱掉那一格 */
  if (name == null && dest) {
    if (typeof b.unequip !== 'function') throw new Error('这个 mineflayer 版本没有 unequip；要脱装备只能用 mc_chest 之类手动换')
    const slot = slotOf(dest)
    const was = readSlot(slot)
    if (!was) return { to: dest, now: '空', note: `${dest} 那一格本来就是空的` }
    await t(b.unequip(dest), 'equip', `脱下 ${dest}（${was.name}）`)
    const now = readSlot(slot)
    return {
      to: dest,
      equipped: !now,                     // 🟡 2026-10-15 审计（报告 C 第 1 条）：脱成功了 = 那一格空了
      now: now ? `${now.name}x${now.count}` : '空',
      tookOff: `${was.name}x${was.count}`,
      held: heldText(b),
      ...(now ? { note: `那一格现在还是 ${now.name} —— 没脱下来，再叫一次试试` } : {}),
    }
  }
  if (name == null) throw new Error('要给 name（如 iron_helmet / diamond_sword）；只想脱装备就只给 to')

  const item = b.inventory.items().find((i) => i.name === String(name))
  if (!item) throw new Error(`背包里没有 ${name}（用 mc_inventory 看有什么；**身上穿着的在"装备栏"那一行**）`)
  const d = dest ?? equipDestOf(item.name)
  const isHand = d === 'hand'
  const slot = slotOf(d)
  const before = readSlot(slot)
  const beforeHeld = heldText(b)
  await t(b.equip(item, d), 'equip', isHand ? `手持 ${name}` : `${d} ← ${name}`)
  const now = readSlot(slot)
  const got = isHand ? b.heldItem?.name === item.name : now?.name === item.name
  const held = heldText(b)
  return {
    to: d,
    /* 🟡 2026-10-15 审计（报告 C 第 1 条）：`equip()` 原来**没有任何"成没成"的字段**，
     *   调用方只能看 `held` 猜（`src/sequence.mjs` 的 `stepOk` 就是因此恒判成功）。
     *   这里把已经复核过的结论如实写出来。 */
    equipped: got,
    ...(isHand ? {} : { now: now ? `${now.name}x${now.count}` : '空' }),
    ...(before && before.name !== now?.name ? { swappedOut: `${before.name}x${before.count}` } : {}),
    ...(beforeHeld !== held ? { beforeHeld } : {}),
    held,
    ...(got
      ? {}
      : {
          note: isHand
            ? `换手没成功（现在手上是 ${held}）—— 那一叠可能被占用了，或刚被用掉；再叫一次 mc_act{mode:"equip",name:"${name}"}，先用 mc_inventory 看还剩什么`
            : `没穿上 ${d}（那一格现在是 ${now ? now.name : '空'}）—— 那一叠可能被占用了，或刚被用掉；先 mc_inventory 看一眼还剩什么`,
        }),
  }
}

/**
 * 附魔台：看三个选项 / 选一个附魔。
 *
 * 为什么单独有这个动作（2026-10-13 用户贴游戏里 AI 的话："附魔台能打开（窗口类型 enchantment，
 * 38 格），但我这边没有『选附魔』的工具"）：`mc_act {mode:"use"}` 只是 `bot.activateBlock`，
 * 服务端把窗口开了，但**没有 mineflayer 的附魔助手** —— 三个选项（`table.enchantments`）、
 * `ready` 事件、`table.enchant(choice)` 全是 `bot.openEnchantmentTable(block)` 挂上去的
 * （上游 `mineflayer\lib\plugins\enchantment_table.js`）。所以这里要自己把窗口"正规地"开一遍。
 *
 * 🔴 `bot.openBlock(block)`（`inventory.js:405`）= `bot.activateBlock` + `await once(bot,'windowOpen')`
 * ⇒ **已经有窗口开着时服务端会忽略这次使用，`openBlock` 就挂死**。所以先关掉别的窗口。
 *
 * 用法：`mc_act {mode:"enchant"}` 只看选项；`{mode:"enchant", option:0}` 真附魔。
 * 自动做四件事：① 关掉别的窗口再 `openEnchantmentTable`；② 槽 0 空就把手上那件（或 `item`
 * 点名的那件）放进去；③ 槽 1 空就从背包补一块青金石；④ 附完把附魔好的那件拿回背包
 * （青金石不用管，关窗口时服务端会自己退回背包）。
 */
export async function enchantTable (self, args = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const b = self.requireBot()
  const raw = args.option
  const option = raw == null || raw === '' ? null : Number(raw)
  if (option != null && (!Number.isInteger(option) || option < 0 || option > 2)) {
    throw new Error(`option 只能是 0 / 1 / 2（附魔台从上到下三个选项），给的是 ${raw}`)
  }
  if (typeof b.openEnchantmentTable !== 'function') {
    throw new Error('这个 mineflayer 没有 openEnchantmentTable —— 附魔台用不了')
  }

  // ① 找附魔台：给了坐标用坐标，没给就在 4 格内找最近的一座
  let blk = null
  if (args.x != null && args.y != null && args.z != null) {
    blk = b.blockAt(new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z)))
    if (!blk) throw new Error(`(${args.x},${args.y},${args.z}) 还没加载，我看不到那里是什么`)
    if (blk.name !== 'enchanting_table') throw new Error(`(${args.x},${args.y},${args.z}) 是 ${blk.name}，不是附魔台`)
  } else {
    blk = b.findBlock({ matching: (x) => x?.name === 'enchanting_table', maxDistance: 4 })
    if (!blk) throw new Error('附近 4 格内没有附魔台 —— 先 mc_scan {name:"enchanting_table"} 找一座，或者把 x/y/z 给我')
  }
  const at = `${blk.position.x},${blk.position.y},${blk.position.z}`

  // ② 要一个"带助手"的附魔窗口（已经正规开着就复用；别的窗口先关掉，否则 openBlock 会挂死）
  let table = null
  let note = null
  const cur = b.currentWindow
  if (cur && cur !== b.inventory && typeof cur.enchant === 'function' && /enchant/.test(String(cur.type ?? ''))) {
    table = cur
  } else {
    if (cur && cur !== b.inventory && typeof b.closeWindow === 'function') {
      try { await t(Promise.resolve(b.closeWindow(cur)), 'act', '关掉上一个窗口') } catch { /* 关不掉就让下面那次超时如实报 */ }
    }
    table = await t(b.openEnchantmentTable(blk), 'act', `打开附魔台 (${at})`)
  }

  // 窗口里"我的背包"从哪一格开始（上游 `putAway` 用的是 `window.inventoryStart`，跟着它走）
  const start = Number.isFinite(table?.inventoryStart) ? table.inventoryStart : 2
  const end = Number.isFinite(table?.inventoryEnd) ? table.inventoryEnd : Math.max(start, (table?.slots?.length ?? start) - 1)
  const slotName = (i) => table.slots?.[i]?.name ?? null
  const findInv = (name) => {
    for (let i = start; i <= end; i++) {
      const it = table.slots?.[i]
      if (it && it.name === name) return { item: it, slot: i }
    }
    return null
  }
  // 手上那件在窗口 0 里是 36..44（快捷栏）、9..35 是主背包；容器窗口里玩家背包从
  // `inventoryStart` 起，前 27 格是主背包、后 9 格才是快捷栏 ⇒ 要按这个布局平移。
  const heldSlot = () => {
    const h = b.heldItem
    const hs = Number(h?.slot)
    if (!h || !Number.isFinite(hs)) return null
    const idx = hs >= 36 && hs <= 44 ? 27 + (hs - 36) : (hs >= 9 && hs <= 35 ? hs - 9 : null)
    if (idx == null) return null
    const s = start + idx
    return s >= start && s <= end ? s : null
  }

  // ③ 槽 0 要有待附魔的东西
  if (!slotName(0)) {
    const want = args.item ? String(args.item) : null
    const pick = want ? findInv(want) : null
    const slot = pick?.slot ?? heldSlot()
    if (slot == null) {
      throw new Error(want
        ? `背包里没有 ${want} —— 要附魔的东西得先在手边（或者名字写对：mc_inventory 看一眼）`
        : '附魔台槽 0 是空的：先用手拿着要附魔的东西，或者点名 item（如 item:"iron_pickaxe"）')
    }
    await t(Promise.resolve(b.moveSlotItem(slot, 0)), 'act', '把待附魔的那件放进附魔槽')
  }

  // ④ 槽 1 要有青金石
  if (!slotName(1)) {
    const l = findInv('lapis_lazuli')
    if (l) await t(Promise.resolve(b.moveSlotItem(l.slot, 1)), 'act', '补一块青金石')
  }

  // ⑤ 等三个选项到位（服务端用 craft_progress_bar 的属性包填，通常一个 tick 就到）
  const shortName = (s) => String(s ?? '?').replace(/^minecraft:/, '')
  const enName = (id) => (id == null || Number(id) < 0 ? '?' : shortName(b.registry?.enchants?.[id]?.name ?? `#${id}`))
  /* 🔴 2026-10-15 审计（报告 C 第 2 条）：这里原来要求三个选项 `level >= 0` **全成立**才算"到齐"，
   *   而 vanilla 用 `level = -1` 表示"这一项不可用"（经验不够 / 没青金石 / 这件东西不能附魔）——
   *   同文件下面的 `optLine` 自己就是这么解释 `level < 0` 的。于是"经验不够"（极常见）时
   *   `ready()` 恒假 ⇒ 真附魔分支**永远走不到**，只会反复回"三个选项还没到齐，再叫一次"。
   *   到齐的判据改成"三个槽位都在"；具体那一项能不能用，留到 ⑦ 按所选项单独判。 */
  const optsReady = () => Array.isArray(table.enchantments) && table.enchantments.length === 3
  /* 2026-10-15 异步方案 ②：手写轮询收口到 `waitUntil`（同一个"等到某条件成立"只写一遍） */
  await waitUntil(optsReady, { ms: 1_200, pollMs: 80, label: '等附魔选项' })

  const opts = Array.isArray(table.enchantments) ? table.enchantments : []
  const optLine = (x, i) => (Number(x?.level) < 0
    ? `  ${i}. 这一项不可用（经验不够 / 没有青金石 / 这件东西不能附魔）`
    : `  ${i}. 要 ${x.level} 级经验 → ${enName(x?.expected?.enchant)}${Number(x?.expected?.level) > 0 ? ' ' + x.expected.level : ''}`)
  const target = slotName(0)
  const lapis = slotName(1)
  const base = {
    at,
    target,
    lapisIn: lapis,
    options: opts.map((x, i) => ({
      option: i,
      level: Number(x?.level) ?? -1,
      enchant: enName(x?.expected?.enchant),
      enchantLevel: Number(x?.expected?.level) ?? -1,
    })),
  }

  // ⑥ 没给 option：只看选项
  if (option == null) {
    return {
      ...base,
      ...(optsReady() ? {} : { note: '三个选项还没全到（窗口刚开，服务端要一个 tick 才发属性包）—— 再叫一次 mc_act {mode:"enchant"}' }),
      text: `🔮 附魔台 (${at})：槽 0 = ${target ?? '空'}，槽 1 = ${lapis ?? '空'}\n${opts.map(optLine).join('\n')}`,
    }
  }

  // ⑦ 真附魔
  if (!optsReady()) {
    return {
      ...base,
      enchanted: false,
      note: '三个选项还没到齐（窗口刚开，服务端要一个 tick 才发属性包），这一轮没动手 —— 再叫一次 mc_act {mode:"enchant", option:' + option + '}（窗口还开着）',
    }
  }
  /* 🔴 2026-10-15 审计（报告 C 第 2 条）：到齐 ≠ 这一项能用。`level < 0` = 服务端说"这一项不可用"，
   *   这时候调 `table.enchant(option)` 会白忙（上游会拒/报错）。如实说清是哪种不可用。 */
  const chosen = opts[option] ?? null
  if (!chosen) {
    return {
      ...base,
      enchanted: false,
      note: `没有 ${option} 号选项（现在只有 ${opts.length} 个：0..${Math.max(0, opts.length - 1)}）`,
    }
  }
  if (Number(chosen?.level) < 0) {
    return {
      ...base,
      enchanted: false,
      option,
      note: `${option} 号这一项**不可用**（经验不够 / 没有青金石 / 这件东西不能附魔）—— 这一轮没动手。`
        + '换一个选项，或者先去攒经验/补青金石再回来。',
    }
  }
  const newItem = await t(Promise.resolve(table.enchant(option)), 'act', `附魔选项 ${option}`)

  // ⑧ 把附魔好的那件拿回背包（拿不回就靠关窗退回）
  try {
    if (table.slots?.[0] && typeof table.takeTargetItem === 'function') {
      await t(Promise.resolve(table.takeTargetItem()), 'act', '把附魔好的那件拿回来')
    }
  } catch (e) {
    note = `没能自动把槽 0 那件拿回背包（${e.message}）—— 关窗口时服务端会把它退回背包，用 mc_inventory 确认一下`
  }
  try { if (typeof b.closeWindow === 'function') await t(Promise.resolve(b.closeWindow(table)), 'act', '关掉附魔台') } catch { /* 关不掉不影响结果 */ }

  const en = Array.isArray(newItem?.enchants) ? newItem.enchants : []
  const enText = en.length
    ? en.map((x) => `${shortName(x?.name ?? x?.ench)} ${x?.lvl ?? x?.level ?? ''}`.trim()).join('、')
    : null
  return {
    ...base,
    enchanted: true,
    option,
    got: newItem?.name ?? null,
    ...(enText ? { enchants: enText } : {}),
    ...(note ? { note } : {}),
    text: `🔮 附魔完成（选项 ${option}）：${newItem?.name ?? target ?? '那件'}`
      + (enText ? ` → **${enText}**` : '（没读回附魔属性，用 mc_inventory 看一眼那件）')
      + (lapis ? '\n槽 1 剩的青金石在关窗时已退回背包。' : ''),
  }
}

/* ───────── 铁砧 / 锻造台（2026-10-13：用户问"铁砧 锻造台都可以用吗"） ───────── */

/**
 * 找一个"要右键打开的工作方块"：给了坐标用坐标（并校验名字），没给就在 radius 格内找最近的。
 *
 * 🔴 `findBlock` 的匹配函数只能看 `.name`（它内部走 `findBlocks`，喂进来的方块原型没有 position）。
 */
function findWorkBlock (b, args, re, label, radius = 4) {
  const ok = (n) => re.test(String(n ?? ''))
  if (args.x != null && args.y != null && args.z != null) {
    const blk = b.blockAt(new Vec3(Math.floor(args.x), Math.floor(args.y), Math.floor(args.z)))
    if (!blk) throw new Error(`(${args.x},${args.y},${args.z}) 还没加载，我看不到那里是什么`)
    if (!ok(blk.name)) throw new Error(`(${args.x},${args.y},${args.z}) 是 ${blk.name}，不是${label}`)
    return blk
  }
  const blk = b.findBlock({ matching: (x) => ok(x?.name), maxDistance: radius })
  if (!blk) throw new Error(`附近 ${radius} 格内没有${label} —— 先 mc_scan 找一座，或者把 x/y/z 给我`)
  return blk
}

/**
 * 要一个"能干活"的窗口：已经正规开着就复用；别的窗口先关掉。
 *
 * 🔴 `bot.openBlock` = `bot.activateBlock` + 等 `windowOpen`（上游 `inventory.js:405`）⇒
 * **已经有窗口开着时服务端会忽略这次使用，`openBlock` 就挂死**。所以先关掉别的窗口。
 *
 * `helper` 给了就要求窗口上有那个助手函数（附魔台的 `enchantments`/`enchant()` 是
 * `openEnchantmentTable` 挂上去的，`activateBlock` 开出来的没有）；锻造台没有助手，给 null 即可。
 */
async function openWorkWindow (b, t, blk, { helper = null, typeRe, label, open }) {
  const cur = b.currentWindow
  const reusable = cur && cur !== b.inventory && typeRe.test(String(cur.type ?? ''))
    && (!helper || typeof cur[helper] === 'function')
    && Number.isFinite(cur.inventoryStart)
  if (reusable) return cur
  if (cur && cur !== b.inventory && typeof b.closeWindow === 'function') {
    try { await t(Promise.resolve(b.closeWindow(cur)), 'act', '关掉上一个窗口') } catch { /* 关不掉就让下面那次超时如实报 */ }
  }
  return await t(open(blk), 'act', `打开${label}`)
}

/** 窗口里的"我的背包"范围 + 查格子的助手（附魔台 / 铁砧 / 锻造台三处布局一样）。 */
function winSlots (b, win) {
  const start = Number.isFinite(win?.inventoryStart) ? win.inventoryStart : 2
  const end = Number.isFinite(win?.inventoryEnd) ? win.inventoryEnd : Math.max(start, (win?.slots?.length ?? start) - 1)
  const slotName = (i) => win?.slots?.[i]?.name ?? null
  const findInv = (name, skip = -1) => {
    for (let i = start; i <= end; i++) {
      const it = win?.slots?.[i]
      if (it && it.name === name && i !== skip) return { item: it, slot: i }
    }
    return null
  }
  // 手上那件在窗口里是第几格：窗口 0 里快捷栏是 36..44、主背包 9..35；容器窗口里玩家背包从
  // `inventoryStart` 起，前 27 格是主背包、后 9 格才是快捷栏 ⇒ 按这个布局平移。
  const heldSlot = () => {
    const h = b.heldItem
    const hs = Number(h?.slot)
    if (!h || !Number.isFinite(hs)) return null
    const idx = hs >= 36 && hs <= 44 ? 27 + (hs - 36) : (hs >= 9 && hs <= 35 ? hs - 9 : null)
    if (idx == null) return null
    const s = start + idx
    return s >= start && s <= end ? s : null
  }
  return { start, end, slotName, findInv, heldSlot }
}

/** 一件东西的人话：名字 + 自定义名 + 附魔 + 还剩多少耐久。 */
function describeItem (it) {
  if (!it) return null
  const en = Array.isArray(it.enchants) ? it.enchants.filter(Boolean) : []
  const enText = en.length
    ? en.map((e) => `${String(e.name ?? e.ench ?? '?').replace(/^minecraft:/, '')} ${e.lvl ?? e.level ?? ''}`.trim()).join('、')
    : null
  const dmg = Number(it.durabilityUsed)
  const max = Number(it.maxDurability)
  const dur = Number.isFinite(dmg) && Number.isFinite(max) && max > 0 ? `耐久 ${max - dmg}/${max}` : null
  return [it.name, it.customName ? `「${it.customName}」` : null, enText, dur].filter(Boolean).join(' · ')
}

/**
 * 铁砧：合并/修复两件装备，或者给一件改名。
 *
 * 为什么不用 `mc_act {mode:"use"}`（2026-10-13 用户问"铁砧 锻造台都可以用吗"）：`use` 只是
 * `bot.activateBlock` —— 窗口开得出来，但**没有 mineflayer 的铁砧助手**：`combine`（自己算经验、
 * 挑划算的方向、发 `MC|ItemName` 改名包、把成品拿出来）和 `rename` 都是 `bot.openAnvil(block)`
 * 挂上去的（上游 `mineflayer\lib\plugins\anvil.js`）。
 *
 * 用法：
 *   `{mode:"anvil", action:"combine", item:"iron_pickaxe", name:"iron_pickaxe"}` —— 两把合成一把更耐久的
 *   `{mode:"anvil", action:"rename",  item:"diamond_sword", name:"屠龙刀"}` —— 改名
 * 经验不够 / 这两件根本合不了，上游会直接抛错（不会白扣等级）。
 */
export async function anvilTable (self, args = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const b = self.requireBot()
  const action = String(args.action ?? 'combine').toLowerCase()
  if (action !== 'combine' && action !== 'rename') {
    throw new Error(`action 只能是 combine（合并/修复两件）或 rename（改名），给的是 ${args.action}`)
  }
  if (typeof b.openAnvil !== 'function') throw new Error('这个 mineflayer 没有 openAnvil —— 铁砧用不了')

  const blk = findWorkBlock(b, args, /^(chipped_|damaged_)?anvil$/, '铁砧')
  const at = `${blk.position.x},${blk.position.y},${blk.position.z}`
  const table = await openWorkWindow(b, t, blk, {
    helper: 'combine', typeRe: /anvil/, label: `铁砧 (${at})`, open: (x) => b.openAnvil(x),
  })
  const { findInv, heldSlot } = winSlots(b, table)

  // 第一件：点名的那件，或者手上那件
  const want1 = args.item ? String(args.item) : null
  const pick1 = want1 ? findInv(want1) : null
  const s1 = pick1?.slot ?? heldSlot()
  if (s1 == null) {
    throw new Error(want1
      ? `背包里没有 ${want1} —— 要放进铁砧的东西得在手边（名字写对没：mc_inventory 看一眼）`
      : '铁砧槽 0 是空的：先用手拿着要处理的东西，或者点名 item（如 item:"iron_pickaxe"）')
  }
  const first = table.slots[s1]

  const close = async () => {
    try { if (typeof b.closeWindow === 'function') await t(Promise.resolve(b.closeWindow(table)), 'act', '关掉铁砧') } catch { /* 关不掉不影响结果 */ }
  }

  if (action === 'rename') {
    const newName = args.name == null ? '' : String(args.name).trim()
    if (!newName) throw new Error('rename 要给 name（新名字），例如 {mode:"anvil", action:"rename", item:"diamond_sword", name:"屠龙刀"}')
    if (newName.length > 35) throw new Error(`名字太长（${newName.length} 个字），铁砧最多 35 个`)
    let err = null
    try { await t(Promise.resolve(table.rename(first, newName)), 'act', `改名成「${newName}」`) } catch (e) { err = e }
    await sleep(200)
    const got = b.inventory.items().find((it) => it.customName === newName) ?? null
    await close()
    if (err && !got) throw new Error(`改名没成：${err.message}`)
    return {
      at, action, from: first?.name ?? null, name: newName, got: got?.name ?? null, renamed: Boolean(got),
      ...(err ? { note: `服务端那边报了 ${err.message}，但背包里确实有一件叫「${newName}」的` } : {}),
      text: `⚒️ 铁砧改名：${first?.name ?? '那件'} → **「${newName}」**`
        + (got ? `（背包里那件是 ${got.name}）` : '（没能从背包里复核到，用 mc_inventory 看一眼）'),
    }
  }

  // combine：第二件（跳过第一件那格，免得两件挑到同一格）
  const want2 = args.name ? String(args.name) : null
  if (!want2) {
    throw new Error('combine 要给 name（第二件），例如 {mode:"anvil", action:"combine", item:"iron_pickaxe", name:"iron_pickaxe"}（两把合成一把更耐久的）')
  }
  const pick2 = findInv(want2, s1)
  if (!pick2) throw new Error(`背包里没有第二件 ${want2}（第一件在槽 ${s1}）`)
  const second = pick2.item
  let err = null
  try { await t(Promise.resolve(table.combine(first, second, null)), 'act', '铁砧合并') } catch (e) { err = e }
  await sleep(250)
  // 上游 `combine` 不返回成品 ⇒ 从背包里挑"附魔最多、耐久最好"的那件同名物来报
  const cands = b.inventory.items().filter((it) => it.name === first?.name)
  cands.sort((a, c) => (c.enchants?.length ?? 0) - (a.enchants?.length ?? 0) || ((a.durabilityUsed ?? 0) - (c.durabilityUsed ?? 0)))
  const got = cands[0] ?? null
  await close()
  if (err) {
    return {
      at, action, first: first?.name ?? null, second: want2, combined: false,
      note: `铁砧没认这次合并：${err.message}`,
      text: `⚒️ 铁砧合并失败：${err.message}`,
    }
  }
  const desc = describeItem(got)
  return {
    at, action, first: first?.name ?? null, second: want2, combined: true, got: desc,
    ...(got ? {} : { note: '合并命令发出去了，但没能在背包里复核到结果 —— 用 mc_inventory 看一眼' }),
    text: `⚒️ 铁砧合并完成：${first?.name ?? ''} + ${want2}`
      + (desc ? ` → **${desc}**` : '（没复核到结果，用 mc_inventory 看一眼）'),
  }
}

/**
 * 锻造台：模板 + 底座 + 附加 → 成品（下界合金升级、盔甲纹饰都走它）。
 *
 * 🔴 mineflayer **没有**锻造台助手（`lib\plugins\` 里只有 `anvil.js`、`enchantment_table.js`）
 * ⇒ 这里自己按槽位来：槽 0 = 模板、槽 1 = 底座、槽 2 = 附加，成品在槽 3（`minecraft:smithing`）。
 * 三样都放好之后服务端一个 tick 就把成品算出来，我们读出来再 `putAway(3)` 拿回背包。
 *
 * 用法：`{mode:"smithing", item:"diamond_chestplate", name:"netherite_ingot"}` —— 模板没给就自己
 * 从背包里挑（优先下界合金升级模板；背包里只有一种纹饰模板时用它；有多种就报错让你点名 template）。
 */
export async function smithingTable (self, args = {}, ctx = {}) {
  const t = ctx.t ?? ((p) => p)
  const b = self.requireBot()
  if (typeof b.openBlock !== 'function') throw new Error('这个 mineflayer 没有 openBlock —— 锻造台用不了')

  const blk = findWorkBlock(b, args, /^smithing_table$/, '锻造台')
  const at = `${blk.position.x},${blk.position.y},${blk.position.z}`
  const table = await openWorkWindow(b, t, blk, {
    typeRe: /smithing/, label: `锻造台 (${at})`, open: (x) => b.openBlock(x),
  })
  const { start, end, slotName, findInv, heldSlot } = winSlots(b, table)
  const close = async () => {
    try { if (typeof b.closeWindow === 'function') await t(Promise.resolve(b.closeWindow(table)), 'act', '关掉锻造台') } catch { /* 关不掉不影响结果 */ }
  }

  // 底座：点名的那件，或者手上那件
  const wantBase = args.item ? String(args.item) : null
  const base = wantBase ? findInv(wantBase) : null
  const baseSlot = base?.slot ?? heldSlot()
  if (baseSlot == null) {
    throw new Error(wantBase
      ? `背包里没有 ${wantBase}（底座）—— 名字写对没：mc_inventory 看一眼`
      : '锻造台底座槽是空的：先用手拿着要升级/纹饰的那件，或者点名 item（如 item:"diamond_chestplate"）')
  }
  // 附加材料
  const wantAdd = args.name ? String(args.name) : null
  if (!wantAdd) {
    throw new Error('要给 name（附加材料），例如 name:"netherite_ingot"（下界合金升级）或 name:"redstone"（盔甲纹饰）')
  }
  const add = findInv(wantAdd, baseSlot)
  if (!add) throw new Error(`背包里没有 ${wantAdd}（附加材料）`)
  // 模板
  const wantTpl = args.template ? String(args.template) : null
  let tpl = wantTpl ? findInv(wantTpl) : null
  if (wantTpl && !tpl) throw new Error(`背包里没有 ${wantTpl}（模板）`)
  if (!tpl) {
    const kinds = []
    for (let i = start; i <= end; i++) {
      const it = table.slots?.[i]
      if (it && /_smithing_template$/.test(it.name)) kinds.push(it.name)
    }
    const uniq = [...new Set(kinds)]
    const pickName = uniq.includes('netherite_upgrade_smithing_template')
      ? 'netherite_upgrade_smithing_template'
      : (uniq.length === 1 ? uniq[0] : null)
    if (!pickName) {
      throw new Error(uniq.length === 0
        ? '背包里没有锻造模板（*_smithing_template）—— 下界合金升级要 netherite_upgrade_smithing_template，盔甲纹饰要对应的纹饰模板'
        : `背包里有多种模板（${uniq.join('、')}）—— 用 template 点名要哪一种`)
    }
    tpl = findInv(pickName)
  }

  // 三样按槽位放好（模板 0 / 底座 1 / 附加 2）
  const move = async (slot, dest, what) => {
    await t(Promise.resolve(b.moveSlotItem(slot, dest)), 'act', `把 ${what} 放进槽 ${dest}`)
    await sleep(120)
  }
  await move(tpl.slot, 0, tpl.item.name)
  await move(baseSlot, 1, base?.item?.name ?? wantBase ?? '底座')
  await move(add.slot, 2, wantAdd)

  // 等成品（服务端一个 tick 就算出来）—— 2026-10-15 异步方案 ②：收口到 `waitUntil`
  await waitUntil(() => slotName(3), { ms: 1_200, pollMs: 80, label: '等铁砧成品' })
  const out = table.slots?.[3] ?? null
  if (!out) {
    await close()
    return {
      at, base: base?.item?.name ?? wantBase ?? null, addition: wantAdd, template: tpl.item.name,
      smithed: false,
      note: '锻造台槽 3 一直是空的 —— 这三样搭不起来（模板 / 底座 / 附加对不上），或者缺经验（下界合金升级要 1 级）。放进槽里的东西关窗口时会退回背包。',
      text: `🔨 锻造台 (${at}) 没给出成品：${base?.item?.name ?? wantBase} + ${wantAdd}（模板 ${tpl.item.name}）搭不起来，或经验不够`,
    }
  }
  const desc = describeItem(out)
  let takeErr = null
  try { await t(Promise.resolve(b.putAway(3)), 'act', '把成品拿回背包') } catch (e) { takeErr = e }
  await sleep(150)
  const gotName = out.name
  const inBag = b.inventory.items().some((it) => it.name === gotName)
  await close()
  return {
    at, base: base?.item?.name ?? wantBase ?? null, addition: wantAdd, template: tpl.item.name,
    smithed: true, got: desc, inBag,
    ...(takeErr || !inBag
      ? { note: `成品是 ${desc}，但${takeErr ? `没拿回背包（${takeErr.message}）` : '没能从背包里复核到'} —— 关窗口时服务端会把它退回背包，用 mc_inventory 确认一下` }
      : {}),
    text: `🔨 锻造台完成：${base?.item?.name ?? wantBase} + ${wantAdd}（模板 ${tpl.item.name}）→ **${desc}**`,
  }
}


