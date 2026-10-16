/**
 * 挖完/打完顺手把掉落物捡回来（`#grabDrops` 从 `core.mjs` 搬出来的，路线图第 ④ 条第二十三刀）。
 * ---------------------------------------------------------------------------
 * 为什么要单独一个模块：这一层**不改实例状态，但要回调实例方法**（`self.callLeft()` 的预算、
 *   `self.walkTo()` 的兜底走路），按迁移规矩第 27 条 ⇒ 第一参数收 `self`。
 *
 * 🔴 唯一一个必须从外面递进来的东西：`ctx.cancelCollect`。它对应 `McBot` 的**私有**方法
 *   `#cancelCollect`，模块外面够不着（私有名不能用字符串取），所以由 `core.mjs` 的薄包装塞进来。
 *   为什么非要收尾：`collectBlock.collect(entity)` 走的是 `GoalFollow` + `waitForPickup`，物品卡在
 *   方块里 / 走不过去时会一直挂着 ⇒ `collectBlock_finished` 不 emit ⇒ 采集队列恒"忙" ⇒ 之后几分钟
 *   走不了路（和挖方块那条路同一个病，见 `dig-guard.mjs`）。
 */

import { sleep, withTimeout } from './async-util.mjs'
import { dropsNear } from './world-observer.mjs'

/**
 * 捡起刚挖出来的掉落物。
 *
 * 🔴 2026-10-08 实机（熔炼验证）：`dig()` 的"够得着就原地挖"分支直接 `bot.dig()`，
 *    **绕过了 collectBlock**，而 collectBlock 平时是"挖完还会把掉落物捡回来"的
 *    ⇒ 原地挖 3 根原木，背包里只有 1 根（服务端只把身边约 1 格内的掉落物塞给你）。
 *    这里补上：找半径内最近的一两个掉落物，交给 collectBlock 去捡（没有 collectBlock
 *    就自己走过去）。捡不到不算失败 —— 别把"挖到了但没捡到"说成"没挖到"。
 */
export async function grabDrops (self, b, { radius = 8, budgetMs = 3_000 } = {}, ctx = {}) {
  /* 掉落物的判据在模块级 `isDropEntity`（`#dropsNear` 共用同一份）。 */
  const me = b?.entity?.position
  if (!me) return 0
  const drops = dropsNear(b, radius)
  if (!drops.length) return 0
  /* 🔴 报"捡回几个"要按**背包变化**算，不能按 `entity.isValid`：
   *    实机探针 `probe-drop.mjs` 里 `isValid` 根本来不及变 false（实体被移出 `bot.entities`
   *    的时机和我们数它的时机不重合）⇒ 明明捡到了也报 0（实机：原木 1 → 3，却一条
   *    "顺手捡回"都没有）。 */
  const invCount = () => {
    try { return (b.inventory?.items?.() ?? []).reduce((s, i) => s + (Number(i?.count) || 0), 0) } catch { return 0 }
  }
  const before = invCount()
  const t0 = Date.now()
  for (const { e } of drops) {
    const left = Math.min(budgetMs - (Date.now() - t0), self.callLeft() - 300)
    if (left < 400) break
    if (typeof b?.collectBlock?.collect === 'function') {
      try { await withTimeout(b.collectBlock.collect(e, { ignoreNoPath: true }), Math.min(left, 2_000), '捡东西') } catch {
        /* 🔴 超时/中断**不代表底层采集任务停了**：Entity 目标走的是 `GoalFollow` + `waitForPickup`，
         *    物品卡在方块里 / 走不过去时会一直挂着 ⇒ `collectBlock_finished` 不 emit
         *    ⇒ `#collectBusy` 恒真 ⇒ 之后几分钟走不了路（和挖方块那条路同一个病）。
         *    这里显式收尾：`#cancelCollect` 最多再花 300ms，收不掉它还会清空僵尸队列。 */
        try { await ctx.cancelCollect?.(b, { budgetMs: 300 }) } catch { /* 收不掉也继续捡下一个 */ }
      }
    } else {
      try { await self.walkTo({ x: e.position.x, y: e.position.y, z: e.position.z }, { arrive: 0.8, budget: Math.min(left, 1_500) }) } catch { /* 忽略 */ }
    }
  }
  await sleep(120)          // 服务端把物品塞进背包有一点点延迟
  return Math.max(0, invCount() - before)
}
