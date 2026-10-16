/**
 * 连接信息与状态视图 —— 从 `src/core.mjs` 搬出来的"感知"那一层（路线图第 ④ 条第十三刀）。
 *
 * 约定（每一刀都照这个来）：
 *   ① **不反向 import `core.mjs`**；② 不直接 import mineflayer（只往下依赖 `block-names.mjs`
 *   与 `world-observer.mjs`）；③ **只读、同步、不改状态**。
 *
 * 🔴 这两个视图是**公开方法**（`index.js` 的状态条与 `mc_status`/`mc_diag`、`extensions\mc_observe.mjs`
 *    的"程序检测到"、`selfcheck.mjs` 都从**实例**上调 `bot.status()` / `bot.connectionView()`）
 *    ⇒ `core.mjs` 里留**同名薄包装**，调用方一行都不用改。
 *
 * 为什么 `statusOf()` 的签名多一个 `ctx`：它要读**实例状态**（子服名、连接参数、上次错误、
 * 是否在重连、连上时间）—— 这些不属于 `bot`。所以由薄包装把实例字段打包成 `ctx` 传进来，
 * 模块自己保持"只吃参数"的纯形状。
 */
import { isLiquid } from './block-names.mjs'
import { inWaterNow } from './world-observer.mjs'

/**
 * 给前端 / 工具看的**连接信息**：只有地址三件套。
 *
 * 🔴 用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址。"
 *    `_connectionProfile` 里还带着 `authMode` / `account`（账号名）—— 那是给日志与诊断用的，
 *    **不该跟着这个视图发到浏览器**，所以统一从这里出（`status()` 与 `modeView()` 共用）。
 * @param {{host?: string, port?: number, subserver?: string}|null} profile `_connectionProfile`
 * @returns {{host: string|null, port: number|null, subserver: string|null}|null}
 */
export function connectionViewOf (profile) {
  const p = profile
  if (!p) return null
  return { host: p.host ?? null, port: p.port ?? null, subserver: p.subserver || null }
}

/**
 * 状态视图：离线（可能带 `ghost`/`reconnecting`）或在线（坐标/朝向/游戏模式/血量/饥饿/氧气/手持/在线时长）。
 *
 * @param {object|null} b mineflayer bot
 * @param {{sub?: string|null, connection?: object|null, lastError?: string|null,
 *          reconnecting?: boolean, reconnectPending?: boolean, connectedAt?: number}} ctx
 */
export function statusOf (b, ctx = {}) {
  // 连的哪个服（用户 2026-09-16："状态条别只写'在游戏中'，要显示服务器地址"）。
  // 只回地址/端口/子服，**不含账号与凭据**；前端负责"太长就截断"。
  const connection = ctx.connection ?? null
  // 🔴 「幽灵在线」（2026-09-19）：断线/被踢后 `bot.entity` 会残留，光看它就把死连接报成在线。
  //    连接已结束就按离线报，并明确标出 ghost，免得 AI 与用户都以为还在游戏里。
  const ended = b?._client?.ended === true
  if (!b?.entity || ended) {
    const reconnecting = Boolean(ctx.reconnecting || ctx.reconnectPending)
    return {
      online: false, sub: ctx.sub, connection, lastError: ctx.lastError,
      ...(reconnecting ? { reconnecting: true } : {}),
      ...(ended && b?.entity
        ? {
            ghost: true,
            hint: reconnecting
              ? '连接已经断了（bot.entity 是 mineflayer 的残留），插件正在自动重连——重连成功会自动告诉你'
              : '连接已经结束了（bot.entity 是 mineflayer 的残留）——要回到游戏里请重新 mc_connect',
          }
        : {}),
    }
  }
  const p = b.entity.position
  return {
    online: true, sub: ctx.sub, connection,
    position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
    yaw: b.entity.yaw, pitch: b.entity.pitch,
    gamemode: b.game?.gameMode, dimension: b.game?.dimension, time: b.time?.timeOfDay,
    health: b.health, food: b.food, players: Object.keys(b.players ?? {}),
    held: b.heldItem ? `${b.heldItem.name}x${b.heldItem.count}` : null,
    uptimeSec: Math.round((Date.now() - ctx.connectedAt) / 1000),
    inWater: inWaterNow(b),
    // 氧气（0–20，20 = 满）。在水里憋气会一路掉到 0，然后开始掉血 —— 淹死就是这么来的。
    // 🔴 实机教训（2026-10-07）：**头在水面上的时候这项是 null** —— mineflayer 只在服务端
    // 发 `air_supply` 元数据时才设 `bot.oxygenLevel`，而那条元数据是头入水、气开始掉之后才来的。
    // 所以判据不能只看它：下面的 `submerged`（眼睛那一格是不是液体 = 头在水下）才是直接信号，
    // 氧气读数有就一起报、没有就照实说。
    air: Number.isFinite(b.oxygenLevel) ? b.oxygenLevel : null,
    submerged: (() => {
      try {
        /* 🔴 2026-10-08 实机：这里以前先看 `entity.isInWater` —— 而它泡在水柱里会读出
         *    undefined（实测机器人 (-31,59,261) 脚/头两格都是 water 却报"没在水里"）。
         *    头在水下就是头在水下，直接看眼睛那一格。 */
        const eye = b.entity.position.offset(0, b.entity.eyeHeight ?? 1.62, 0)
        return isLiquid(b.blockAt(eye)?.name)
      } catch { return false }
    })(),
  }
}
