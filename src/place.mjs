/* ============================================================================
 * 放置 —— 把背包里的方块放到某个坐标（`mc_act {mode:"place"}` / `mc_build` 的正文）
 *
 * 路线图第 ④ 条第三十九刀从 `src\core.mjs` 搬出来（`#placeRef` + `placeBlock`）。
 * 六条判据（都是 2026-10-08 那几轮实机换来的）：
 *   ① 选料只挑**整方块**（`pickPlaceItem`）：火把/门/半砖放下去站不住，别当填充块
 *   ② 创造模式背包没有就自动取（协议级 `set_creative_slot`，不需要 OP）
 *   ③ 够不着先走近（`self.walkTo` / 创造 `self.flyTo`）；接近失败**不许吞** ——
 *      服务端按**眼睛→方块中心** 4.5（生存）/ 5.0（创造）判，超了直接报"够不着"
 *   ④ 目标格必须 `canPlaceInto`（空气/液体/草花藤蔓）；悬空就先垫一块踩上去（"搭高"）
 *   ⑤ 上游 `place_block.js` 抛的英文 `Server refused to place …` 翻译成人话
 *   ⑥ 放完**必须复核** `b.blockAt`：旧版不管成没成都报 `placed`，真机被投诉"报假成功"
 *
 * 参数：`self` = McBot（读 `requireBot` / `giveItem` / `walkTo` / `flyTo` / `equip`，
 *       写 `_selfMovingAt`），`ctx` = `{ t }`（预算闸门 `#t`，唯一的私有件）。
 * 判据：模块不 import `core.mjs`、不 import 游戏库（只认 `b.blockAt` / `b.placeBlock` / `b.lookAt` / `b.entity`）。
 * ========================================================================== */

import vec3pkg from 'vec3'
const Vec3 = vec3pkg.Vec3 ?? vec3pkg

import { sleep } from './async-util.mjs'
import { isAir, isLiquid, canPlaceInto } from './block-names.mjs'
import { pickPlaceItem, isFullBlockItem } from './place-items.mjs'
import { heldText } from './inventory.mjs'
import { standableY } from './movement.mjs'

/**
 * 在目标周围找一块**能站的地面**当落脚点（"走过去放"用）。找不到返回 `null`。
 *
 * 🔴 为什么不能直接朝 `pos.y` 走（用户 2026-10-13 实机报的"搭路一直搭到空气上"）：
 *    搭桥 / 搭高的目标 y 本来就在半空，而 `mc_map`/`mc_scan` 给的"地表高度"在树林里是树冠、
 *    山上是最高的石头 —— 朝那个 y 走过去，pathfinder 会一路**垫方块把自己顶上去**。
 *    改成"站到目标旁边的地面上，再伸手放"。
 */
function approachSpot (b, pos) {
  const cands = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (!dx && !dz) continue
      const x = pos.x + dx; const z = pos.z + dz
      const y = standableY(b, x, pos.y + 2, z)
      // `standableY` 找不到能站的地方会**原样返回**传进去的 y ⇒ 那种"半空"不算落脚点
      let under = null
      try { under = b.blockAt(new Vec3(x, y - 1, z)) } catch { under = null }
      if (!under || isAir(under.name) || isLiquid(under.name)) continue
      const d = Math.hypot(x + 0.5 - (pos.x + 0.5), y - pos.y, z + 0.5 - (pos.z + 0.5))
      if (d > 6.5) continue
      cands.push({ x, y, z, d })
    }
  }
  cands.sort((a, c) => a.d - c.d)
  return cands[0] ?? null
}

/** 找一个能对着放的相邻实体方块 */
export function placeRef (self, pos) {
  const b = self.requireBot()
  for (const [dx, dy, dz] of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
    const nb = b.blockAt(new Vec3(pos.x + dx, pos.y + dy, pos.z + dz))
    if (nb && nb.boundingBox === 'block') return { ref: nb, face: { x: -dx, y: -dy, z: -dz } }
  }
  return null
}

/** 把背包里的方块放到某个坐标（先走近、必要时往上搭） */
export async function placeBlock (self, { x, y, z, name = null } = {}, ctx = {}) {
  const b = self.requireBot()
  const pos = new Vec3(Math.floor(x), Math.floor(y), Math.floor(z))
  const want = name ? String(name) : null
  // 选方块：指定名字就给那个；没指定就**只挑整方块**（旧版直接 items[0]，见 pickPlaceItem 注释）
  const pick = () => pickPlaceItem(b, want)
  let item = pick()

  // 创造模式：背包里没有就**自动取**（协议级 set_creative_slot，不需要 OP）。
  // 不这么做的话"给个方块名就能建"不成立——AI 得先想起来调 mc_give，
  // 否则 mc_build 直接报"背包是空的"。生存模式没这福利（得自己挖/合成）。
  if (!item && want && b.game?.gameMode === 'creative') {
    await self.giveItem({ name: want })
    item = pick()
  }
  if (!item) {
    if (want) {
      throw new Error(`背包里没有 ${want}（生存模式请先挖或合成；创造模式本应自动取物，若仍失败请看上一条错误）`)
    }
    let all = []
    try { all = b.inventory.items() } catch {}
    if (!all.length) {
      throw new Error('背包是空的——**给 name 指定要放哪种方块**（创造模式下会自动取物），或先挖方块')
    }
    // 能走到这里 = 背包里有东西，但没有"能当填充块的整方块"
    const junk = [...new Set(all.filter((i) => !isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
    const kept = [...new Set(all.filter((i) => isFullBlockItem(b, i.name)).map((i) => i.name))].slice(0, 6)
    throw new Error('背包里没有能当**实体方块**放的东西'
      + (junk.length ? `（只有 ${junk.join('、')} —— 火把/门/半砖这些放下去站不住）` : '')
      + (kept.length ? `（${kept.join('、')} 是家当，不拿来当填充块；真要放就显式给 name）` : '')
      + '。先 mc_dig 挖点泥土/圆石，或 mc_craft 做点木板。')
  }

  // 走/飞到够得着的位置（reach 约 4.5 格）
  /* 🔴 2026-10-08 第五份审计报告 ⑤：以前用"脚 → 方块角点"的距离、阈值 5.5 ——
   *    服务端是按**眼睛 → 方块中心**判的（生存 4.5 / 创造 5.0），角点到中心差最多 ~0.87 格
   *    ⇒ 4.6–5.5 格的方块能过我们的检查、然后被服务端拒（`place_block.js:42` 抛英文
   *    `Server refused to place …`，原样冒泡成工具错误）。现在按眼→中心算、阈值对齐服务端。 */
  const reachMax = b.game?.gameMode === 'creative' ? 5.0 : 4.5
  /* 🔴 2026-10-13 实机：眼睛位置原来只算**一次**（走路之前），走完还用那个旧坐标判距离
   *    ⇒ 明明已经走到跟前，仍然报"够不着 … 41.3 格"（报的是出发那一刻的距离）。
   *    必须**每次现算**。 */
  const eyeNow = () => {
    try {
      const p = b.entity.position
      return new Vec3(p.x, p.y + (b.entity.eyeHeight ?? 1.62), p.z)
    } catch { return b.entity.position }
  }
  const dist = () => eyeNow().distanceTo(pos.offset(0.5, 0.5, 0.5))
  let approachError = null
  if (dist() > 4) {
    self._selfMovingAt = Date.now()
    try {
      if (b.game?.gameMode === 'creative') await self.flyTo(pos.x + 2, pos.y + 1.5, pos.z + 2)
      else {
        // 站到目标旁边的**地面**上，别朝半空的 y 走（见 approachSpot 注释）
        const spot = approachSpot(b, pos)
        if (!spot) {
          throw new Error(`(${pos.x},${pos.y},${pos.z}) 周围 2 格内没有能站的地面（目标悬空）——`
            + '我不会朝半空一路垫方块爬过去。想搭桥 / 搭路请用 `mc_build`（它按范围一块块放），'
            + '想放这一块就先 `mc_move` 走到它旁边能站的地方。')
        }
        await self.walkTo({ x: spot.x, y: spot.y, z: spot.z }, { arrive: 2.5, budget: 25_000 })
      }
    } catch (e) { approachError = e.message }
    self._selfMovingAt = Date.now()
    await sleep(250)
  }
  // 🔴 够不着就别硬放。旧版把接近失败 `catch {}` 吞掉、照样往下走，
  //    结果服务端拒了放置，而工具还报"placed: X"——真机被投诉的"报假成功"。
  if (dist() > reachMax) {
    throw new Error(`够不着 (${pos.x},${pos.y},${pos.z})：眼睛到方块中心 ${dist().toFixed(1)} 格，`
      + `${b.game?.gameMode === 'creative' ? '创造 5' : '生存 4.5'} 格以内才放得下`
      + (approachError ? `（接近失败：${approachError}）` : '')
      + '。先用 mc_move 靠近，或换更近的点位。')
  }

  // 目标位置必须"能放"：不占空间才放得进去。
  // 判据是 canPlaceInto（boundingBox==='empty'）——覆盖空气三兄弟、**液体**、草/花/藤蔓等可替换物。
  const targetBlock = b.blockAt(pos)
  if (!targetBlock) {
    throw new Error(`(${pos.x},${pos.y},${pos.z}) 未加载（区块还没到）——先 mc_map 看看，或换近一点的点位`)
  }
  if (!canPlaceInto(targetBlock)) {
    throw new Error(`(${pos.x},${pos.y},${pos.z}) 已被 ${targetBlock.name} 占住，放不进去——`
      + '换个位置，或先 mc_act{mode:"break"} 清掉')
  }
  let ref = placeRef(self, pos)
  if (!ref) {
    // 悬空：先在自己脚下垫一块，站上去，再放目标（等于"搭高"）
    const below = b.entity.position.floored().offset(0, -1, 0)
    const underFeet = b.blockAt(below)
    if (underFeet && !isAir(underFeet.name)) {
      await ctx.t(b.equip(item, 'hand'), 'equip', '手持垫脚方块')
      await ctx.t(b.lookAt(below.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向脚下')
      await ctx.t(b.placeBlock(underFeet, { x: 0, y: 1, z: 0 }), 'place', '垫脚')
      await sleep(250)
    }
    ref = placeRef(self, pos)
    if (!ref) throw new Error('目标位置悬空且脚下没有可依附方块（先走到有方块的地方，或先放一个垫脚方块）')
  }
  await ctx.t(b.equip(item, 'hand'), 'equip', '手持方块')
  await ctx.t(b.lookAt(ref.ref.position.offset(0.5, 0.5, 0.5), true), 'lookAt', '看向放置面')
  try {
    await ctx.t(b.placeBlock(ref.ref, new Vec3(ref.face.x, ref.face.y, ref.face.z)), 'place', '放置方块')
  } catch (e) {
    /* 🔴 报告⑤：上游 `place_block.js:42` 抛的是英文 `Server refused to place …`，
     *    以前原样冒泡给模型。翻译成它能用的话。 */
    const m = String(e?.message ?? '')
    if (/Server refused to place/i.test(m)) {
      throw new Error('服务端拒了这次放置（太远 / 目标格被占 / 手上有别的 / 失步）——'
        + '先用 `mc_move` 靠近或换个点位，**别当成放成功了**。')
    }
    throw e
  }
  await sleep(200)

  // 🔴 必须**验证**：旧版不管成没成都是 `placed: item.name` → 真机被投诉的"报假成功"
  //    （mc_build 说 placed，mc_scan 复查一格没放下）
  const now = b.blockAt(pos)?.name ?? null
  const ok = now === item.name
  return {
    placed: ok ? item.name : false,
    requested: item.name,
    at: { x: pos.x, y: pos.y, z: pos.z },
    now,
    held: heldText(b),
    ...(ok ? {} : {
      note: `方块**没有出现**（现在那里是 ${now ?? '未加载'}）——服务端可能拒了这次放置`
        + '（领地保护 / 权限 / 反作弊 / 失步）。不要当成放成功了。',
    }),
  }
}
