/**
 * "打谁 / 怎么打"那一层（路线图第 ④ 条第二十一刀）。
 *
 * 搬走 `McBot.attack({ who, budget })`（原 116 行，`core.mjs` 里第二大的"动作"方法）。
 * 只认一个 bot + 一个 `ctx = { t, callLeft, abortSignal, hasPvp }`：
 *   · `ctx.t`           —— 预算闸门（只有"没有 pvp 退回挥手"那条路才发包，要过闸门）
 *   · `ctx.callLeft()`  —— 这一轮还剩多少毫秒（决定"等多久"和"挥几下"）
 *   · `ctx.abortSignal` —— 玩家新命令抢占（`mc_stop` / 新一轮工具调用）
 *   · `ctx.hasPvp`      —— 插件实例状态（`this.mcPlugins.pvp`），不是 bot 的
 *
 * 这里踩过的坑（`踩坑档案.md` 第 12 / 26 / 27 条）：
 *   ① `bot.pvp.attack(target)` **立刻** resolve（上游 `mineflayer-pvp\lib\PVP.js:60-76`
 *      只做三件事：设 target、`GoalFollow` 追过去、发 `startedAttacking`），真正挥拳的是
 *      `physicTick` 上的后台循环 ⇒ 旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回、
 *      紧接着 `finally` 里 `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
 *      所以这里必须自己等：等到目标从 `bot.entities` 消失 / `isValid === false` / 这一轮的时间用完。
 *   ② `pvp.stop()` **不能 await**：它内部 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
 *      会把这一轮的预算整段吃光（pathfinder 的 stop 在它第一行就已经做了）。
 *   ③ 名字匹配要看**所有**名字字段（`username` / `name` / `displayName` / `type` / `kind`）
 *      + 中文别名；找不到时**列出半径内实际有谁**，别只丢一句"附近找不到"。
 *   ④ 不带 `who` 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
 *      否则"打最近的"会跑过去揍玩家 6 格外的马。
 */
import { sleep } from './async-util.mjs'
import { callBudget } from './budget.mjs'
import { HOSTILE_RE, JUNK_RE, NAME_ALIAS, entityNameOf, nameFieldsOf } from './entity-names.mjs'
import { dropHint, entityHealth } from './world-observer.mjs'

export async function attack (b, { who = null, budget = 20_000 } = {}, ctx = {}) {
  const me = b.entity.position
  const needle = who ? String(who).trim().toLowerCase() : null
  const alias = needle ? NAME_ALIAS[needle] : null
  const hasPvp = Boolean(ctx.hasPvp) && typeof b.pvp?.attack === 'function'
  const distOf = (e) => { try { return e.position.distanceTo(me) } catch { return Infinity } }
  const all = Object.values(b.entities ?? {})
    .filter((e) => e && e !== b.entity && e.position)
    .map((e) => ({ e, d: distOf(e), nm: entityNameOf(e) }))
    .filter((x) => x.d <= 24)
  const rankOf = (x) => {
    if (JUNK_RE.test(x.nm)) return 3                                  // 掉落物 / 经验球 / 箭
    if (HOSTILE_RE.test(x.nm) || x.e.kind === 'Hostile mobs') return 0
    if (x.e.username || x.e.type === 'player') return 1
    return 2                                                          // 动物之类
  }
  const hit = (x) => {
    if (!needle) return true
    const fields = nameFieldsOf(x.e)
    if (fields.some((v) => v.includes(needle))) return true
    return Boolean(alias) && fields.some((v) => v.includes(alias))
  }
  // 🔴 不给 who 时**只追怪**（24 格内的敌对也追），动物/玩家仍只在 4.5 格内 ——
  //    否则"打最近的"会跑过去揍玩家 6 格外的马（2026-10-08 探针实测附近就有 horse 6.8 格）。
  const inReach = needle ? all : all.filter((x) => x.d <= 4.5 || rankOf(x) === 0)
  const list = inReach.filter(hit).sort((a, c) => (rankOf(a) - rankOf(c)) || (a.d - c.d))
  const near = all.slice().sort((a, c) => a.d - c.d).slice(0, 6)
    .map((x) => `${x.nm} ${x.d.toFixed(1)} 格`).join('、')
  const pick = list[0]
  // 半径内只剩掉落物（且不在手边）就别动手：打到一个 item 是白费一轮
  /* 🔴 2026-10-15 审计：点名点到掉落物时，旧文案是"附近找不到 X（24 格内实际有：X）"——
   *    同一句话里自相矛盾（找不到却列出来了）。这里单独说清"它是掉落物、而且够不着"。 */
  const dropOutOfReach = Boolean(pick && rankOf(pick) === 3 && pick.d > 4.5)
  const target = pick && !dropOutOfReach ? pick.e : null
  if (!target) {
    if (needle && dropOutOfReach) {
      throw new Error(`"${who}" 是**掉落物**，而且离我 ${pick.d.toFixed(1)} 格（超过 4.5 格）—— 我不打掉落物。`
        + '要捡它就先 `mc_move` 走过去站上去（一两秒就自己飞进背包）。')
    }
    if (needle) {
      throw new Error(`附近找不到 "${who}"（24 格内实际有：${near || '什么都没有'}）`
        + ' —— 名字要跟 `mc_observe` "程序检测到"里显示的一致（中文叫法也认）；'
        + '要打远处那只就先 `mc_move` 过去，怪跑远了同样找不到。')
    }
    throw new Error(`4.5 格内没有能打的实体${near ? `（24 格内最近的是 ${near}）` : ''}`
      + ' —— 掉落物 / 经验球不算，动物与玩家要贴到 4.5 格内；'
      + '要打远处的怪就先 `mc_move` 过去（或 `mc_act {mode:"attack", who:"zombie"}`，那个会追 24 格）。')
  }
  const label = entityNameOf(target)
  const d = Number(distOf(target).toFixed(1))
  const hpBefore = entityHealth(b, target)

  if (hasPvp) {
    /* 🔴 `bot.pvp.attack(target)` **立刻** resolve（它只做三件事：设 target、`GoalFollow` 追过去、
     *    发 `startedAttacking` 事件），真正挥拳的是 `physicTick` 上的后台循环 ⇒
     *    旧写法 `await withTimeout(b.pvp.attack(...))` 一毫秒就返回，紧接着 `finally` 里
     *    `b.pvp.stop()` 又把追过去的 goal 停掉 ⇒ **一下都没打，却回 "attacked: X"**。
     *    所以这里必须自己等：等到目标没了 / 这一轮的时间用完，再停。 */
    // 2026-10-08 审计⑦：`Math.max(300, …)` 在本轮已经用完时会白送 300ms（见 walkTo 同类注释）。
    const left = ctx.callLeft() - 600
    const bd = left <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget, 4_000), left))
    const t0 = Date.now()
    let note = null
    let pvpErr = null
    /* 🔴 2026-10-15 审计：`killed: gone` 把"怪走出服务端实体追踪距离（destroy 包）/ 区块卸载"
     *    当成"我打死了它" ⇒ 后面还会据此报掉落物。只有**消失前读到过血量下降**才算打死。 */
    let sawDamage = false
    let lastHp = hpBefore
    try {
      await b.pvp.attack(target)
      while (Date.now() - t0 < bd) {
        if (ctx.abortSignal?.aborted) break
        if (!b.entities?.[target.id] || target.isValid === false) break
        const hp = entityHealth(b, target)
        if (hp != null) {
          if (lastHp != null && hp < lastHp) sawDamage = true
          lastHp = hp
        }
        await sleep(120)
      }
    } catch (e) {
      if (e?.mcAborted) throw e
      pvpErr = String(e?.message ?? e)
    } finally {
      /* 🔴 这里**不能 await**：`pvp.stop()` 里 `onceWithTimeout('path_stop', 5000)` 最多等 5 秒，
       *    会把这一轮的预算整段吃光（而且 pathfinder 的 stop 在它第一行就已经做了）。 */
      try { Promise.resolve(b.pvp.stop()).catch(() => {}) } catch { /* 停不掉也不影响 */ }
    }
    const gone = !b.entities?.[target.id] || target.isValid === false
    const killed = gone && sawDamage
    const inRange = Boolean(b.pvp?.wasInRange)
    const hpAfter = gone ? (killed ? 0 : null) : entityHealth(b, target)
    const waitedMs = Date.now() - t0
    if (gone && !killed && !pvpErr) {
      note = `目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）`
    }
    /* 打死了 ⇒ 掉落物就掉在原地。用户 2026-10-08 原话："打完动物以后老是忘记走过去拾取" ——
     * 只**点一句**，不替它走过去（先捡哪个、走多远是决策，而且这一轮的预算基本已经花完了）。 */
    const pickup = killed ? dropHint(b) : null
    if (!gone && !pvpErr) {
      note = inRange
        ? `打了 ${(waitedMs / 1000).toFixed(1)} 秒还没打死（这一轮的时间到了）—— 再叫一次 mc_act{attack} 接着打`
        : `追了 ${(waitedMs / 1000).toFixed(1)} 秒还没进到攻击距离（3.5 格）—— 走不过去 / 被方块挡住 / 目标跑太快；`
          + '先 mc_move 到它旁边，或者换个近一点的目标'
    }
    return {
      attacked: label, distance: d, killed, gone, health: b.health, via: 'pvp', waitedMs,
      ...(hpBefore != null && hpAfter != null && hpBefore !== hpAfter ? { targetHealth: `${hpBefore} → ${hpAfter}` } : {}),
      ...(note ? { note } : {}),
      ...(pickup ? { pickup } : {}),
      ...(pvpErr ? { error: pvpErr } : {}),
    }
  }

  /* 没有 pvp 插件：退化成原地挥（上游原版就是一次 `b.attack`，这里按预算多挥几下） */
  const t0 = Date.now()
  const leftMs2 = ctx.callLeft() - 400
  const bd = leftMs2 <= 100 ? 0 : Math.max(0, Math.min(callBudget(budget, 4_000), leftMs2))
  let swings = 0
  let sawDamage2 = false
  let lastHp2 = hpBefore
  const sample = () => {
    const hp = entityHealth(b, target)
    if (hp == null) return
    if (lastHp2 != null && hp < lastHp2) sawDamage2 = true
    lastHp2 = hp
  }
  while (Date.now() - t0 < bd) {
    if (ctx.abortSignal?.aborted) break
    if (!b.entities?.[target.id] || target.isValid === false) break
    if (distOf(target) > 4.5) break
    await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`)
    swings++
    await sleep(620)
    sample()
  }
  // 没有 pvp 时至少挥一下（bd=0 说明这一轮已经用完了，那就别再拖）
  if (swings === 0 && b.entities?.[target.id] && target.isValid !== false && distOf(target) <= 4.5 && !ctx.abortSignal?.aborted) {
    try { await ctx.t(Promise.resolve(b.attack(target)), 'attack', `攻击 ${label}`); swings = 1 } catch {}
    await sleep(200)
    sample()
  }
  const gone = !b.entities?.[target.id] || target.isValid === false
  /* 🔴 同 pvp 分支：`gone` ≠ `killed`（怪可能只是走远/区块卸载）。 */
  const killed = gone && sawDamage2
  const pickup = killed ? dropHint(b) : null
  return {
    attacked: label, distance: d, swings, killed, gone, health: b.health,
    ...(gone && !killed ? { note: '目标不见了，但**没读到过它掉血** —— 说不清是我打死的还是它走远/区块卸载了（别当成打死了）' } : {}),
    ...(pickup ? { pickup } : {}),
  }
}
