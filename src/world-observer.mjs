/**
 * 只读观察：我在哪、我周围有什么、我离它多远。
 *
 * 路线图第 ④ 条第十刀从 `src/core.mjs` 搬出来的（原来是类里的私有方法 `#x`）。
 * 头注释里那几条约定与前几刀一样：
 *   · 不反向 import `core.mjs`（这一层只往下依赖 `entity-names.mjs`）；
 *   · 不 import mineflayer / vec3 这类游戏库 —— 收 `bot` 当参数，只用它现成的字段；
 *   · **只读**：不看世界、不发包、不改状态、不 await（所以搬出来不会动到异步流程）。
 *
 * 搬家时唯一动过的地方：`#reachOf` 改名 `blockReachOf`（`extensions/mc_craft.mjs` 里有一个
 * 同名的 `reachOf`，那个是"这个材料我够不够得着做"，跟"我离这块方块多远"不是一回事）。
 */
import { isDropEntity } from './entity-names.mjs'

/**
 * 读一个实体的血量（读不到就 null）。
 *
 * 优先用现成的 `bot.util.entity.getHealth()`（`@nxg-org/mineflayer-util-plugin`，`mc_observe` 的"程序检测到"也用这个），
 * 退到 `entity.health`。**读不到不要编**：`attack()` 靠它报"打掉多少血"，编了就等于谎报。
 */
export function entityHealth (b, e) {
  try {
    const h = Number(b?.util?.entity?.getHealth?.(e))
    if (Number.isFinite(h) && h > 0) return Math.round(h * 10) / 10
  } catch { /* 助手不可用就往下退 */ }
  const h2 = Number(e?.health)
  return Number.isFinite(h2) && h2 > 0 ? Math.round(h2 * 10) / 10 : null
}

/** 我现在在水里吗（脚在水的 AABB 里，或眼睛那格是水）。
 *  🔴 `bot.entity.isInWater` 在**浮在水面**时读出来是 false（prismarine-physics 入水 AABB 从底部缩了 0.401）
 *  ⇒ 两个判据都要看（2026-10-08 实机，水里游不动那次）。 */
export function inWaterNow (b) {
  try { if (b?.entity?.isInWater) return true } catch { /* 往下退 */ }
  try {
    const eye = b?._getBlockAtEyeLevel?.()?.name
    return eye === 'water' || eye === 'flowing_water'
  } catch { return false }
}

/** 我**真在下落**吗（空中挖慢 5 倍的那个判据）。
 *  🔴 不能只看 `entity.onGround === false`：走路下台阶、贴着斜坡边缘时它也会瞬间为 false
 *  （2026-10-08 实机把"木镐挖石头"估成 5650ms，真实只要 1125ms ⇒ 白拒一次本来挖得完的挖掘）。
 *  ⇒ 判据是"离地 **且** 竖直速度明显为负"。
 *  ⚠️ 这个判据必须和 `src\dig-speed.mjs` 里估时用的那个**是同一个** —— 2026-10-15 审计发现
 *  `slowDigWhy` 说"我在空中，挖方块慢 5 倍"时，那个 ms 其实根本没乘 5，文案在骗模型。 */
export function fallingNow (b) {
  const vY = Number(b?.entity?.velocity?.y ?? 0)
  return b?.entity?.onGround === false && vY < -0.02
}

/** 挖得慢的现成理由（水里 / 空中各慢 5 倍）—— 用来把"时间不够"说清楚 */
export function slowDigWhy (b) {
  const parts = []
  if (inWaterNow(b)) parts.push('我在水里')
  if (fallingNow(b)) parts.push('我在空中')
  return parts.length ? `（${parts.join('、')}，挖方块慢 5 倍）` : ''
}

/**
 * 附近**还没捡**的掉落物（离我多远，近的在前）。判据与 `#grabDrops` 共用 `isDropEntity`。
 */
export function dropsNear (b, radius = 12) {
  const me = b?.entity?.position
  if (!me) return []
  return Object.values(b?.entities ?? {})
    .filter((e) => isDropEntity(e))
    .map((e) => ({ e, d: me.distanceTo(e.position) }))
    .filter((x) => Number.isFinite(x.d) && x.d <= radius)
    .sort((a, c) => a.d - c.d)
}

/**
 * "东西还掉在地上"的一句话（没有就返回 null）。
 *
 * why（用户 2026-10-08 原话）："挖完方块或者打完动物以后老是忘记走过去拾取" ——
 * 这是**决策**，插件替不了；但插件至少能在结果里**点一句**，让模型别把这活当成干完了。
 * 只在"没捡到东西 / 打死怪之后"调用，捡到手就不提醒（服务端把掉落物实体移出视野有延迟，
 * 刚捡完那一下它还挂在 `bot.entities` 里，提醒会变成假警报）。
 */
export function dropHint (b, { radius = 12 } = {}) {
  const drops = dropsNear(b, radius)
  if (!drops.length) return null
  const d = drops[0].d
  /* 背包满的时候"走过去"是白跑：服务端不会把东西塞给你（准则「干活习惯」里那条也是这么写的）。 */
  let full = false
  try { full = b?.inventory?.emptySlotCount?.() === 0 } catch { full = false }
  return `地上还有 ${drops.length} 个掉落物没捡（最近 ${d.toFixed(1)} 格）—— `
    + '先 `mc_move` 走过去站上去，一两秒就飞进背包（掉落物几分钟就消失）'
    + (full ? '；**背包满了**：先 `mc_chest` 存一趟，或丢掉没用的' : '')
}

/**
 * 我离这块方块**真正**有多远（服务端/上游的判据）。
 *
 * 🔴 2026-10-08 实机（熔炼验证，探针定论）：上游 `canDigBlock` 和服务端用的都是
 *    **眼睛 → 方块中心**（`digging.js`：`block.position.offset(.5,.5,.5).distanceTo(
 *    bot.entity.position.offset(0,1.65,0)) <= 5.1`，生存 reach 4.5），
 *    而插件以前算的是 **脚 → 方块坐标**。两者差得远：脚边 4 格**正下方**的石头，
 *    脚距 4.0（判"够得着"、原地挖）而眼距 5.6（服务端直接忽略）
 *    ⇒ 客户端预测把方块写成 air、插件报"挖掉"，**服务端没认、也没掉任何东西**。
 *    实机证据：`mc_dig stone` 连报 5 个"挖掉 … → 现在 air"，背包里圆石 = 0，
 *    `bot.entities` 里一个掉落物都没有（探针 `probe-drop.mjs`）。
 */
export function blockReachOf (b, blk) {
  try {
    const p = blk?.position
    const pos = b?.entity?.position
    if (!p || !pos) return Infinity
    const ex = Number(pos.x)
    const ey = Number(pos.y) + Number(b.entity.eyeHeight ?? 1.62)
    const ez = Number(pos.z)
    const cx = Number(p.x) + 0.5
    const cy = Number(p.y) + 0.5
    const cz = Number(p.z) + 0.5
    if (![ex, ey, ez, cx, cy, cz].every(Number.isFinite)) return Infinity
    return Math.hypot(ex - cx, ey - cy, ez - cz)
  } catch { return Infinity }
}

/** 方块状态 id → 名字（查不到就 null，别抛） */
export function stateNameOf (b, stateId) {
  try {
    const e = b?.registry?.blocksByStateId?.[Number(stateId)]
    return e?.name ?? null
  } catch { return null }
}
