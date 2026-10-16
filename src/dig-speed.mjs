/**
 * 挖掘速度层（第十四刀：从 `src\core.mjs` 搬出来的）。
 *
 * 只做一件事：**算"拿某件工具挖这块要多久"**，以及把 `bot.digTime` 换成修过的估值。
 *
 * 为什么单独一层：上游 `minecraft-data` 1.21.9 有 108 个方块的 `material` 写成了
 * `incorrect_for_wooden_tool`（品级门标签，表里只有木工具）⇒ 拿石/铁/钻石镐时查不到倍率
 * ⇒ `blockBreakingSpeed` 按 1 算 ⇒ 铁矿永远 4550ms。这一层按原版公式重算，并保证
 * **只往"更快"修**、判定不了就返回 null（估快会让服务端判进度不够，把方块发回来）。
 *
 * 规矩（和其它 `src\*.mjs` 一样）：
 *   · 不 import `core.mjs`（反向依赖），只用参数里的 `b` / `blk` / `reg`；
 *   · 不碰 `this`，全是纯函数（`patchDigTime` 会改传进来的 `b`，这是它的本职工作）；
 *   · 判定不了就返回 null，不抛。
 */
import { inWaterNow, fallingNow } from './world-observer.mjs'

/** 方块名/工具名 → 工具种类（`stone_pickaxe` → `pickaxe`）。认不出返回 null。 */
export function digToolKindOf (name) {
  const n = String(name ?? '')
  for (const k of ['pickaxe', 'axe', 'shovel', 'hoe', 'shears', 'sword']) {
    if (n === k || n.endsWith('_' + k)) return k
  }
  return null
}

/** 一件物品上的附魔列表（认不出就返回空数组）。mineflayer 里可能是数组也可能是对象。 */
export function enchantsOfItem (it) {
  try {
    const arr = Array.isArray(it?.enchants) ? it.enchants : (it?.enchants ? Object.values(it.enchants) : [])
    return arr.filter((x) => x && typeof x.name === 'string').map((x) => ({ name: x.name, lvl: x.lvl ?? x.level ?? 1 }))
  } catch { return [] }
}

/** 🔴 2026-10-15 审计：`fixDigMs` 重算的是**没有附魔**的原版公式。
 *
 *  **效率（Efficiency）是手持物附魔，不进 `b.entity.effects`** —— 原来只查药水效果，
 *  拿效率镐时 `fixDigMs` 照样返回那个"没算效率"的偏快值，`digMsFor` 的 `Math.min(...cands)`
 *  又让偏快值胜出 ⇒ `patchDigTime` 喂给 `bot.digTime` ⇒ mineflayer 按偏快时长 STOP ⇒
 *  服务端判进度不够、把方块发回来 = 用户看到的"挖完又复原"。
 *  ⇒ 只要这件工具（或头盔）带附魔，`fixDigMs` 就一律不修，退回上游那个把附魔算进去的值。 */
function enchantedFor (b, itemType) {
  try {
    if (itemType == null) return false
    const held = b?.heldItem ?? null
    if (held && held.type === itemType && enchantsOfItem(held).length) return true
    const items = b?.inventory?.items?.() ?? []
    for (const it of items) if (it?.type === itemType && enchantsOfItem(it).length) return true
  } catch {}
  return false
}

/** 这把工具的"品级速度"：从 registry 里**所有** material 表里取它的最大倍率
 *  （`mineable/pickaxe` 里 stone_pickaxe=4、iron_pickaxe=6、diamond=8、netherite=9、golden=12…）。 */
export function digToolSpeedOf (reg, itemType) {
  let best = 0
  try {
    for (const t of Object.values(reg?.materials ?? {})) {
      const v = t?.[itemType]
      if (Number.isFinite(v) && v > best) best = v
    }
  } catch {}
  return best
}

/** 🔴 上游数据坑的兜底（2026-10-08 用户报「挖铁矿还是 4.5 秒」）：
 *
 *  `block.digTime()` 只在 `registry.materials[blk.material][itemType]` 有倍率时才把**工具速度**算进去。
 *  而 minecraft-data 1.21.9 把 **108 个"要石镐以上"的方块**（铁矿/金矿/钻石矿/红石矿/青金石矿/绿宝石矿、
 *  深板岩变种、铁块金块钻石块、黑曜石…）的 `material` 写成了 **`incorrect_for_wooden_tool`** ——
 *  那是原版的**品级门标签**（"木工具挖不动"），不是挖掘标签，那张表里**只有木工具**：
 *  `{wooden_sword:2, wooden_pickaxe:2, wooden_axe:2, wooden_shovel:2}`。
 *  ⇒ 拿石/铁/钻石/下界合金镐时查不到倍率 ⇒ `blockBreakingSpeed` 按 1 算 ⇒ **铁矿永远 4550ms**
 *  （真值：石镐 1150ms、铁镐 750ms、钻石镐 600ms）。这也是"**煤矿正常、铁矿不对**"的原因
 *  —— `coal_ore` 的 material 是正常的 `mineable/pickaxe`。
 *
 *  这里按原版公式重算一遍：速度用**这把工具在别处登记过的倍率**，判定顺序保证不会把"拿错工具"
 *  算快（例如拿石镐砍原木：`mineable/axe` 表里没有镐，且种类对不上 ⇒ 不修，仍是 3000ms）。
 *  只有"手上这把确实是这类方块该用的那种工具 + 品级够采它 + 没有效果/附魔干扰"时才出手；
 *  判定不了就返回 null（宁可不管，也不能估快 —— 估快会让服务端判"进度不够"把方块发回来）。
 */
export function fixDigMs (b, blk, itemType) {
  try {
    if (itemType == null) return null
    const reg = b?.registry
    if (!reg?.materials) return null
    if (b?.game?.gameMode === 'creative') return null
    const hardness = Number(blk?.hardness)
    if (!(hardness > 0)) return null
    // 有药水效果 / 附魔时不算（Haste、效率、水下速掘都会改速度，宁可退回上游那个保守值）
    const eff = b?.entity?.effects
    if (eff && typeof eff === 'object' && Object.keys(eff).length > 0) return null
    // 🔴 效率是**手持物附魔**，不在 entity.effects 里（见 enchantedFor 的注释）
    if (enchantedFor(b, itemType)) return null
    const have = reg.materials[blk?.material]?.[itemType]
    if (Number.isFinite(have) && have > 1) return null        // 数据没问题，上游算得对
    const heldKind = digToolKindOf(reg.items?.[itemType]?.name)
    if (!heldKind) return null
    // 这类方块该用哪种工具？先看 material 名（mineable/pickaxe…），看不到再从 harvestTools 反推
    let needKind = null
    const m = String(blk?.material ?? '').match(/mineable\/(pickaxe|axe|shovel|hoe)/)
    if (m) needKind = m[1]
    else if (blk?.harvestTools) {
      for (const id of Object.keys(blk.harvestTools)) {
        const k = digToolKindOf(reg.items?.[id]?.name)
        if (k) { needKind = k; break }
      }
    }
    if (!needKind || needKind !== heldKind) return null
    let can = false
    try { can = Boolean(blk.canHarvest?.(itemType)) } catch {}
    if (!can) return null                                      // 品级不够 ⇒ 上游那个慢值是对的
    const speed = digToolSpeedOf(reg, itemType)
    if (!(speed > 1)) return null
    const inWater = inWaterNow(b)
    const aqua = Number(b?.inventory?.slots?.[5]?.enchants?.find?.((x) => x?.name === 'aqua_affinity')?.lvl ?? 0)
    let sp = speed
    if (inWater && !aqua) sp /= 5
    if (fallingNow(b)) sp /= 5
    const delta = sp / hardness / 30
    if (!(delta > 0)) return null
    return Math.ceil(1 / delta) * 50
  } catch { return null }
}

/**
 * 拿 `itemType` 挖这块要多久（ms）；算不出来返回 null。
 *
 * 走 prismarine-block 的 `block.digTime(itemType, creative, inWater, notOnGround, enchants, effects)`
 * —— mineflayer 自己的 `bot.digTime(block)` 就是拿**手上**那件这样算的（digging.js:228-256）。
 * 能直接算"换成背包里那把会快多少"，不用真换到手上试。
 */
export function digMsFor (b, blk, itemType = null) {
  try {
    if (typeof blk?.digTime !== 'function') {
      /* 兜底：只有 `bot.digTime(block)` 的环境（老 prismarine-block / 测试假件）——
       * 它只看**手上**那件，所以只有问"手上这件"的时候才敢用。
       * ⚠️ 必须走 `__wcOrigDigTime`（`patchDigTime` 存的原函数）：`b.digTime` 已经被我们换掉了，
       *    直接调会递归。 */
      const fb = b?.__wcOrigDigTime ?? b?.digTime
      if (typeof fb === 'function' && (itemType == null || itemType === b?.heldItem?.type)) {
        const fallback = fb.call(b, blk)
        return Number.isFinite(fallback) && fallback > 0 ? Math.round(fallback) : null
      }
      return null
    }
    const creative = b?.game?.gameMode === 'creative'
    const inWater = inWaterNow(b)
    /* 🔴 空中挖会慢 5 倍（`prismarine-block` 的 `if (notOnGround) blockBreakingSpeed /= 5.0`）。
     *    但**不能**直接用 `!b.entity.onGround`：`onGround` 在走路下台阶/贴着斜坡边缘时也会
     *    瞬间为 false ⇒ 实机（2026-10-08）出现过"木镐挖石头估成 5650ms"（真实只要 1125ms
     *    = 5650/5），把"其实一秒能挖掉"的方块判成"这一轮时间不够，我没开始挖"，白拒一次。
     *    ⇒ 判据取"**真在下落**"：离地 **且** 竖直速度明显为负。
     *    🔴 另一半也是实机（2026-10-08 熔炼验证）栽过的：机器人掉进 7 格深的坑、在下落途中
     *    `mc_dig oak_log` —— 真 digTime 是 3 秒 ×5 = **15 秒**，这里按站着估成 3 秒 ⇒ 放行 ⇒
     *    `bot.dig()` 挂满 11 秒预算（连 `finishDigging` 都没到点，方块还在），只回一句"超时"。
     *    正解是落地再挖（见 `#waitGrounded`）。 */
    const notOnGround = fallingNow(b)
    /* 🔴 2026-10-08 第五份审计报告 ④：以前**附魔传空数组** —— 上游 `bot.digTime`（digging.js:228-256）
     *    会把**手持物品的附魔**和**头盔的附魔**（水下速掘 Aqua Affinity）都算进去。
     *    漏掉附魔 ⇒ 拿效率镐时我们估的 ms 偏大 ⇒ `breakBlock`/`dig` 会**白拒**一次本来挖得完的挖掘
     *    （"我没开始挖"）。这里补上：手上那件（只在问"手上这件"时）+ 头盔槽 5。 */
    const enchantsOf = enchantsOfItem
    const held = b?.heldItem ?? null
    const sameAsHeld = Boolean(held && (itemType == null || itemType === held.type))
    const helmet = (() => { try { return b?.inventory?.slots?.[5] ?? null } catch { return null } })()
    const enchants = [...(sameAsHeld ? enchantsOf(held) : []), ...enchantsOf(helmet)]
    const ms = blk.digTime(itemType, creative, inWater, notOnGround, enchants, b?.entity?.effects ?? {})
    const fixed = fixDigMs(b, blk, itemType)
    const cands = [ms, fixed].filter((x) => Number.isFinite(x) && x > 0)
    if (!cands.length) return null
    return Math.round(Math.min(...cands))
  } catch { return null }
}

/** 🔴 把 `bot.digTime(block)` 换成**修过的**估值（见 `fixDigMs`）。
 *
 *  为什么必须动它：mineflayer 的 `dig()` 拿 `waitTime = bot.digTime(block)` 当**实际挖掘时长**
 *  （`lib/plugins/digging.js:27` → `:135 setTimeout(finishDigging, waitTime)` → 才发 STOP_DESTROY_BLOCK）。
 *  也就是说这个估值不只是"估算"，它就是**机器人站着挖多久**。铁矿按上游那个 4550ms 挖，
 *  真人拿铁镐只要 750ms —— 用户看到的就是"挖铁矿还是 4.5 秒"。
 *
 *  留 8% + 60ms 余量：原版服务端按**自己的进度**判定，STOP 到早了（进度 < 阈值）会被判成"没挖掉"，
 *  并把那个方块发回来纠正客户端（就是玩家看到的"复原"）。宁可慢一点点，不能早。
 */
export function patchDigTime (b) {
  if (typeof b?.digTime !== 'function' || b.__wcDigTimePatched) return false
  const orig = b.digTime.bind(b)
  b.__wcOrigDigTime = orig
  b.digTime = (block) => {
    let base = null
    let baseErr = null
    try { base = orig(block) } catch (e) { baseErr = e }
    let fixed = null
    try { fixed = digMsFor(b, block, b?.heldItem?.type ?? null) } catch {}
    const cands = [base, fixed].filter((x) => Number.isFinite(x) && x > 0)
    if (!cands.length) {
      if (baseErr) throw baseErr          // 上游本来会抛（例如传进来的不是方块）⇒ 照抛，别吞
      return base ?? 0                    // Infinity（挖不动的方块）照原样传下去
    }
    return Math.max(50, Math.round(Math.min(...cands) * 1.08 + 60))
  }
  try { b.__wcDigTimePatched = true } catch {}
  return true
}

/** 背包里挖这块**最快**的那件（只考虑挖得动的；算不出时间的跳过） */
export function bestToolFor (b, blk) {
  const items = (() => { try { return b?.inventory?.items?.() ?? [] } catch { return [] } })()
  const need = Object.keys(blk?.harvestTools ?? {})
  let best = null
  for (const it of items) {
    if (need.length && !blk.harvestTools[it.type]) continue
    const ms = digMsFor(b, blk, it.type)
    if (ms == null) continue
    if (!best || ms < best.ms) best = { item: it, ms }
  }
  return best
}
