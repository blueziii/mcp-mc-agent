/* `src/camera.mjs` —— 朝向 / 相机层（路线图第 ④ 条第十七刀）
 *
 * 为什么单独一层：这三件事都只跟"眼睛朝哪儿"有关，而且**不碰插件实例状态** ——
 * 给一个 bot 就能算、能改。core.mjs 里留同名薄包装（`static lookAnglesTo` / `#aimAt` /
 * `async lookAt`），调用点一行没改。
 *
 * 🔴 这一层存在的主要理由（2026-10-08 审计）：**不要用 mineflayer 的 `bot.lookAt()`**。
 *   真 mineflayer 的 `look()`（`mineflayer\lib\plugins\physics.js:331-357`）在不带 `force` 时
 *   `await lookingTask.promise`，而那个 promise 只在物理循环真的发出 `look` 包时才 finish
 *   （`bot.on('move')`，physics.js:306-312）；机器人**站着不动 / 骑在船里 / 刚死**时物理循环
 *   整个 early return（physics.js:158-162）⇒ 那个 await **永远挂着**
 *   （实机：`mc_act {mode:"use",who:"oak_boat"}` 卡到 5000ms 超时）。
 *   所以 `aimAt()` 直接写 `bot.entity.yaw/pitch` —— 物理循环下一 tick 会算出**同样的角度**，
 *   走它自己的 `yawChange === 0` 快速返回分支，再也不会挂。
 *
 * 本模块**不 import core.mjs**（只认 `{ entity, players }` 这几样）。
 */
import vec3pkg from 'vec3'
import { pickEntity } from './entity-names.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg

/** 目标点 → mineflayer 的 yaw/pitch（mineflayer yaw = 反方向 + PI） */
export function lookAnglesTo (from, to) {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const ground = Math.hypot(dx, dz)
  const yaw = Math.atan2(-dx, -dz)          // atan2(西, 北)
  const pitch = Math.atan2(dy, ground)      // 抬头看上面的东西为正
  return { yaw, pitch }
}

/**
 * 把朝向**立刻**拧到某个点（**不等物理 tick**）。
 *
 * 🔴 为什么必须自己做（2026-10-08 审计）：mineflayer 的 `bot.lookAt()` 内部
 *    `await lookingTask.promise`，而那个 promise 只在**物理 tick 真的发出朝向包**
 *    时才 resolve（`mineflayer\lib\plugins\physics.js:306-312` 的 `bot.on('move')`）。
 *    机器人**站着不动 / 骑在船里 / 刚死**时物理循环不发包 ⇒ `lookAt` 永远挂着
 *    （实机：`mc_act {mode:"use",who:"oak_boat"}` 卡到 5000ms 超时，见会话 step 790）。
 *
 * 这里直接写 `bot.entity.yaw/pitch`（和 `bot.look` 第 347-348 行做的事一样，只是不 await），
 * 之后 mineflayer 内部那次 `lookAt` 会算出**同样的角度** ⇒ 走它的 `yawChange === 0` 快速返回
 * 分支（`physics.js:343-345`），再也不会挂。
 */
export function aimAt (b, point) {
  const eye = b?.entity?.position
  if (!eye || !point) return null
  try {
    const dx = Number(point.x) - eye.x
    const dy = Number(point.y) - (eye.y + (b.entity.eyeHeight ?? 1.62))
    const dz = Number(point.z) - eye.z
    const yaw = Math.atan2(-dx, -dz)
    const pitch = Math.atan2(dy, Math.hypot(dx, dz))
    b.entity.yaw = yaw
    b.entity.pitch = pitch
    return { yaw: Number(yaw.toFixed(3)), pitch: Number(pitch.toFixed(3)) }
  } catch { return null }
}

/** 看向坐标或某个玩家/实体（who 传名字；英文名/玩家名/中文别名都认） */
export async function lookAt (b, { x, y, z, who = null } = {}) {
  let target = null
  if (who) {
    const me = b.entity?.position
    const list = Object.values(b.entities ?? {}).filter((e) => e !== b.entity).map((e) => {
      let d = Infinity
      try { d = e.position.distanceTo(me) } catch { /* 假 bot 没有 position */ }
      return { e, d }
    })
    const { hit, near, needle, alias } = pickEntity(list, who)
    if (hit) target = hit.e.position
    else {
      // 兜底：实体表里没有（超过渲染距离），但玩家列表里有
      const name = Object.keys(b.players ?? {}).find((n) => n.toLowerCase().includes(needle) || (alias ? n.toLowerCase().includes(alias) : false))
      if (name) {
        target = b.players[name]?.entity?.position ?? null
        if (!target) throw new Error(`${name} 在玩家列表里，但看不到它的实体位置（离得太远 / 区块还没加载）`)
      } else {
        throw new Error(`附近找不到 "${who}"（附近实际有：${near.length ? near.join('、') : '什么都没有'}）`
          + '—— 名字要跟 mc_observe "程序检测到"里显示的一致（中文叫法也认）；实在没有就先 mc_observe 看一眼')
      }
    }
  } else if (x !== undefined && y !== undefined && z !== undefined) {
    target = new Vec3(Number(x), Number(y), Number(z))
  } else throw new Error('要么给 who（玩家名/怪物名），要么给 x/y/z')
  /* 🔴 2026-10-08 审计：不用 `b.lookAt(...)` —— 真 mineflayer 的 `look()`（physics.js:331-357）
   *    在不带 force 时 `await lookingTask.promise`，而那个 promise 只在物理循环发出 `look` 包
   *    时才 finish（`bot.on('move')`，physics.js:306-312）；机器人站着不动 / 骑在船里 / 刚死时
   *    物理循环整个 early return（physics.js:158-162）⇒ **永远挂着**。
   *    `aimAt` 直接写 `bot.entity.yaw/pitch`，让物理循环自己发包（和 useBlock 同一套）。 */
  const aimed = aimAt(b, target)
  if (!aimed) throw new Error('算不出要转的角度（实体位置读不到）—— 先 mc_status 看看我在哪')
  return {
    lookingAt: { x: target.x, y: target.y, z: target.z },
    myEye: { x: b.entity.position.x, y: b.entity.position.y + 1.62, z: b.entity.position.z },
    yaw: Number(b.entity.yaw.toFixed(3)), pitch: Number(b.entity.pitch.toFixed(3)),
    note: '已经转头了（包由物理循环发出）—— 服务端不回执；没转过去就再叫一次或先 mc_diag 看控制位',
  }
}
