/**
 * 世界观察器：把"变化"变成语义事件（看门狗判定唤醒要用）
 * ===========================================================================
 * 路线图第 ④ 条第二十五刀：从 `src\core.mjs` 搬出来的一整层。
 *
 * 每 1s 对比快照，产出 mineflayer 本身**不提供**的语义事件：
 *   `teleport`     位置瞬移（>24 格/秒）= 多半被玩家传送
 *   `pushed`       非自主移动（没按方向键却位移）= 被推 / 水流
 *   `pickup`       背包总数变多 = 捡到物品
 *   `playerJoin` / `playerLeave`
 *
 * 为什么这一层收 `self`（迁移规矩第 27 条）：它要读 `self.bot` / `self._obs` /
 *   `self.position` / `self._selfMovingAt`，还要 `self.emit(...)` —— 都是实例状态。
 *   `invSignature(b)` 只读背包 ⇒ 参数直接是 `b`；定时器回调里的异常上报是**私有**方法
 *   `#reportError`，按第 28 条走 `ctx.reportError`。
 *
 * 🔴 定时器回调自己兜住异常：`setInterval` 回调里抛错 = **uncaughtException** = 整个宿主进程死
 *   （宿主只对 `unhandledRejection` 做 fail-loud，这条通道它不防）。观察 tick 出错最多是少看一眼世界。
 */

/**
 * 启动观察器：每 1s 对比快照，产出 mineflayer 本身**不提供**的语义事件：
 *   'teleport'    位置瞬移（>24 格/秒）= 多半被玩家传送
 *   'pushed'      非自主移动（没按方向键却位移）= 被推/水流
 *   'pickup'      背包总数变多 = 捡到物品
 *   'playerJoin' / 'playerLeave'
 *
 * 为什么放这里而不是看门狗里：这是"世界读取"，属于机器人核心的能力；
 * 看门狗只负责"判定要不要叫醒我"，不该自己解析世界。
 */
export function startObserver (self, ctx = {}) {
  if (self.observerTimer) return
  self._obs = {
    lastPos: self.position,
    lastPlayers: new Set(Object.keys(self.bot?.players ?? {})),
    lastInv: invSignature(self.bot),
  }
  // 🔴 回调自己兜住异常：`setInterval` 回调里抛错 = **uncaughtException** = 整个宿主进程死
  //    （宿主只对 `unhandledRejection` 做 fail-loud，这条通道它不防）。观察 tick 出错最多是少看一眼世界。
  self.observerTimer = setInterval(() => { try { observeTick(self) } catch (e) { ctx.reportError?.(e) } }, 1000)
  self.observerTimer.unref?.()
}

export function stopObserver (self) {
  if (self.observerTimer) { clearInterval(self.observerTimer); self.observerTimer = null }
  self._obs = null
}

export function invSignature (b) {
  const items = b?.inventory?.items?.() ?? []
  let total = 0
  const map = {}
  for (const it of items) {
    const c = it?.count ?? 0
    total += c
    map[it.name] = (map[it.name] ?? 0) + c
  }
  return { total, map }
}

export function observeTick (self) {
  const b = self.bot
  if (!b?.entity || !self._obs) return
  const now = Date.now()
  const pos = self.position
  const obs = self._obs

  // ① 玩家上下线
  const players = new Set(Object.keys(b.players ?? {}))
  for (const p of players) {
    if (!obs.lastPlayers.has(p) && p !== b.username) self.emit('playerJoin', { who: p })
  }
  for (const p of obs.lastPlayers) {
    if (!players.has(p)) self.emit('playerLeave', { who: p })
  }
  obs.lastPlayers = players

  // ② 位置突变（排除我们自己飞/走造成的变化——那由 _selfMovingAt 标记）
  const selfMovedRecently = now - (self._selfMovingAt ?? 0) < 3000
  if (obs.lastPos && pos && !selfMovedRecently) {
    const d = Math.hypot(pos.x - obs.lastPos.x, pos.y - obs.lastPos.y, pos.z - obs.lastPos.z)
    const cs = b.controlState ?? {}
    const pressing = Boolean(cs.forward || cs.back || cs.left || cs.right || cs.jump)
    if (d > 24) self.emit('teleport', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
    else if (d >= 2 && !pressing) self.emit('pushed', { from: obs.lastPos, to: pos, distance: Number(d.toFixed(1)) })
  }
  obs.lastPos = pos

  // ③ 捡到物品（背包总数变多）
  const inv = invSignature(self.bot)
  if (inv.total > obs.lastInv.total) {
    const gained = []
    for (const [n, c] of Object.entries(inv.map)) {
      const delta = c - (obs.lastInv.map[n] ?? 0)
      if (delta > 0) gained.push(`${n}x${delta}`)
    }
    if (gained.length) self.emit('pickup', { items: gained })
  }
  obs.lastInv = inv
}