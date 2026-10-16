/* `src\server-break.mjs` —— "服务端到底认没认这次破坏"的判决监听（路线图第 ④ 条第十八刀）
 *
 * 为什么单独一层：这一层只干一件事 —— **把服务端的原始包翻译成三态**（真挖掉 / 复原 / 没证据），
 * 不碰插件实例状态（`b` 和 `pos` 就够；等包的那 10 行才需要"这一轮还剩多少时间"和停止键，
 * 由调用方打包成参数传进来）。`core.mjs` 里留两个同名薄包装
 * （`#watchServerBreak` / `#awaitServerBreak`），调用点一行没改。
 *
 * 🔴 2026-10-08 第五份审计报告 ①（当初做这一层最值钱的一条）：**`bot.blockAt()` 是客户端预测世界**。
 *    上游 `mineflayer/lib/plugins/digging.js` 的本地计时器到点后，`finishDigging()`
 *    **不看服务端认没认**就 `bot._updateBlockState(pos, 0)`（`digging.js:143-159`），
 *    `blocks.js` → `prismarine-world` 直接改 chunk 并 emit `blockUpdate`，
 *    该事件又被 `digging.js` 接住 ⇒ `diggingTask.finish()`。所以**服务端拒绝时 `await bot.dig()` 照样正常返回**，
 *    而此刻 `blockAt(pos)` 已经变成 air ⇒ `now !== name` 恒真 = 自己跟自己核对。
 *    （作者旧注释把"连着两次 break 都回『那里本来就是空气』"归因成"mineflayer 挖矿循环还在发包"，归因不准。）
 *    修法：只把**服务端发的破坏包**当"真挖掉了"，`blockAt` 只用来描述"我这边现在读到什么"。
 *
 * 🔴 2026-10-08 实机第二轮（用户 m19917「挖矿还是会[复原]」→ m20106「煤矿正常、铁矿不对」）：
 *    光看"有没有包"还不够 —— 服务端**拒绝**破坏时，原版会把这个位置的**真实方块**
 *    （也就是原方块本身）用 `block_change` 发回来纠正客户端（`ServerPlayerGameMode` 的 reach 检查
 *    失败分支），mineflayer `blocks.js:396-399` 照着把客户端世界改回原方块 ⇒ **玩家看到"方块复原"**。
 *    旧代码把这个**复原包**也当成"服务端认了" ⇒ 报「挖掉 … （服务端已确认）」，紧接着方块在眼前回来。
 *    所以现在区分三态：`hit()` = 服务端说这块变**空气**了（真挖掉）、`restored()` = 服务端把方块**改回来**了、
 *    其它（只有 multi_block_change 或什么都没收到）= 没有证据，调用方如实说"没收到回包"。
 *
 * 🔴 2026-10-13 第二轮（用户转来游戏里 AI 的话「我这边客户端把湖面看成冰，服务端说是水，方块对不上」）：
 *    "非空气回包"里还混着**另一种完全正常的情况** —— 在冰面上挖冰，冰没了、**水立刻露出来**，服务端
 *    把那一格发成 `water`。旧代码把"非空气"一律当"复原（服务端没认）" ⇒ 好端端挖掉的冰被报成拒绝，
 *    AI 只能顺着这句话去猜"客户端和服务端方块对不上"，还去跟玩家解释。
 *    判据改成**看是不是同一个方块**（`classifyRestore()`）：同一个 ⇒ 真拒绝；液体 ⇒ 破坏成功；别的 ⇒ 客户端区块旧了。
 *
 * 本模块不 import `core.mjs`（只认 `{ _client }` 这一样）。
 */
import { sleep, abortError, waitUntil } from './async-util.mjs'
import { isLiquid } from './block-names.mjs'
import { stateNameOf } from './world-observer.mjs'

/**
 * 挂一个"服务端到底认没认这次破坏"的监听。
 *
 * @param {object} b   mineflayer bot（只要有 `_client.on('packet', …)` 就够）
 * @param {{x:number,y:number,z:number}} pos 要盯的方块坐标
 * @returns {{hit:()=>boolean, restored:()=>number|null, sawMulti:()=>number, watching:boolean, stop:()=>void}}
 *   `watching === false` 说明这个 bot 挂不上监听（套件里的假 bot）⇒ 调用方**别下结论**。
 */
export function watchServerBreak (b, pos) {
  const want = `${pos.x},${pos.y},${pos.z}`
  let air = false          // 服务端把这个位置改成**空气** ⇒ 真挖掉了
  let restored = 0         // 服务端把这个位置改成**非空气** ⇒ 要看是"复原"还是"液体涌进来"（见 classifyRestore）
  let multi = 0            // 看到几个 multi_block_change 记录（只用于排查）
  /* 动手**之前**客户端以为这一格是什么。用来区分两种"非空气回包"：
   *   · 服务端发回来的还是**同一个方块** ⇒ 真拒绝（复原）
   *   · 发回来的是**别的**（尤其水/岩浆）⇒ 破坏其实成功了，只是液体涌了进来
   * 🔴 2026-10-13 实机教训（用户转来游戏里 AI 的话「我这边客户端把湖面看成冰，服务端说是水，方块对不上」）：
   *   在冰面上挖冰，服务端会把那一格发成 **water**（冰没了、水露出来了）—— 旧代码把"非空气"一律当复原，
   *   于是好端端挖掉的冰被报成「服务端把这块改回了 water（复原）—— 这次破坏服务端没认」，
   *   AI 只能按这句话去猜"客户端和服务端方块对不上"，还去跟玩家解释。**判据要看是不是同一个方块，不是看空不空。** */
  const wasName = (() => { try { return b?.blockAt?.(pos)?.name ?? null } catch { return null } })()
  const mark = (stateId) => {
    const st = Number(stateId)
    if (!Number.isFinite(st)) return
    if (st === 0) { air = true; restored = 0 }
    else if (!air) restored = st
  }
  /* 位段格式照抄 mineflayer `lib/plugins/blocks.js:363-394`（别自己猜）：1.18+ 每个 record 是一个数字，
   *   `y = record & 0x0f`、`z = (record >> 4) & 0x0f`、`x = (record >> 8) & 0x0f`、方块状态 = `record >> 12`；
   *   老格式是 `{horizontalPos, y, blockId}` + `chunkX/chunkZ`。 */
  const decodeMulti = (data) => {
    const records = Array.isArray(data?.records) ? data.records : []
    const cc = data?.chunkCoordinates ?? null
    for (const rec of records) {
      let x, y, z, st
      if (rec && typeof rec === 'object') {
        x = (Number(rec.horizontalPos) >> 4) & 0x0f
        y = Number(rec.y) & 0x0f
        z = Number(rec.horizontalPos) & 0x0f
        st = rec.blockId
      } else {
        const n = Number(rec)
        if (!Number.isFinite(n)) continue
        y = n & 0x0f
        z = (n >> 4) & 0x0f
        x = (n >> 8) & 0x0f
        st = n >> 12
      }
      const ox = Number(cc?.x ?? data?.chunkX ?? 0) * 16
      const oy = Number(cc?.y ?? 0) * 16
      const oz = Number(cc?.z ?? data?.chunkZ ?? 0) * 16
      if (`${ox + x},${oy + y},${oz + z}` !== want) continue
      multi++
      mark(st)
    }
  }
  const onPacket = (data, meta) => {
    try {
      const nm = String(meta?.name ?? '')
      if (nm === 'multi_block_change') { decodeMulti(data); return }
      if (nm !== 'block_change' && nm !== 'block_update') return
      const p = data?.location ?? data?.position
      /* 🔴 没有坐标就**不当证据**（旧代码在这里 `hit = true`：任何格式不认识的包都会变成"服务端认了"）。 */
      if (!p || typeof p !== 'object') return
      if (`${p.x},${p.y},${p.z}` !== want) return
      mark(data?.type)
    } catch { /* 忽略：包格式不认识就不当证据 */ }
  }
  let watching = false
  try { b._client?.on?.('packet', onPacket); watching = typeof b?._client?.on === 'function' } catch { watching = false }
  return {
    /** 服务端确实把这个位置改成空气了吗 */
    hit: () => air,
    /** 服务端把这个位置改成**非空气**了 —— 返回方块状态 id，没发生返回 null */
    restored: () => (restored > 0 ? restored : null),
    /** 上面那个状态 id 是什么方块（服务端包里的状态 id 是权威的；查不到返回 null） */
    restoredName: () => (restored > 0 ? stateNameOf(b, restored) : null),
    /** 动手**之前**客户端以为这一格是什么（判"是不是同一个方块"用） */
    wasName,
    /** 有没有看到 multi_block_change（排查用；它也可能是"复原"） */
    sawMulti: () => multi,
    /** 有没有真挂上监听：假 bot（套件里没有 `_client.on`）时为 false ⇒ 调用方**别下结论** */
    watching,
    stop: () => { try { b._client?.removeListener?.('packet', onPacket) } catch { /* 忽略 */ } },
  }
}

/**
 * 把"服务端发回来的那个非空气状态"翻译成人话 —— **别再把"液体涌进来"当成"复原"**。
 *
 * @param {object} watch `watchServerBreak()` 的返回值
 * @returns {null|{kind:'same'|'liquid'|'other', name:string|null, wasName:string|null}}
 *   · `kind === 'same'`   服务端把**原方块**发回来了 ⇒ 真拒绝（复原）
 *   · `kind === 'liquid'` 那一格变成**液体**了 ⇒ 破坏其实**成功**了（冰挖掉就是水；海草/海带也是）
 *   · `kind === 'other'`  服务端说那一格是别的方块 ⇒ 多半是客户端区块旧了（desync），建议 force 重连
 *   `null` = 没有复原包，调用方按原来的三态走。
 */
export function classifyRestore (watch) {
  if (!watch?.watching) return null
  const st = watch.restored?.() ?? null
  if (st == null) return null
  const name = watch.restoredName?.() ?? null
  const wasName = watch.wasName ?? null
  if (name && wasName && name === wasName) return { kind: 'same', name, wasName }
  if (name && isLiquid(name)) return { kind: 'liquid', name, wasName }
  return { kind: 'other', name, wasName }
}

/**
 * 等**服务端的判决**（最多 `maxMs`，服务端说"这块变空气了"就提前收手）。
 *
 * 🔴 2026-10-08 实机定论（`实机验证\挖方块\live-restore.mjs` B 段）：`bot.dig()` 的 resolve 来自
 *    **客户端预测**（`digging.js:158` 自己写 air），而服务端的 `block_change{air}` **可以晚到约 1 秒**
 *    —— 实测眼距 4.61 格的一次挖掘：`mc.dig` 204ms 就"完事"了，服务端的包在 ~970ms 才到。
 *    以前只 `sleep(200)` 就下结论 ⇒ 好端端挖掉的方块被报成"没收到服务端的破坏回包"（骗自己人）。
 *
 * @param {object} b
 * @param {object} watch `watchServerBreak()` 的返回值
 * @param {{maxMs?:number, callLeft?:number|Function, signal?:AbortSignal}} opts
 *   `callLeft` = 这一轮还剩多少毫秒（给函数就现取）；缺省按 11 秒算。
 */
export async function awaitServerBreak (b, watch, { maxMs = 1_200, callLeft = null, signal = null } = {}) {
  if (!watch?.watching) return null
  const raw = typeof callLeft === 'function' ? callLeft() : callLeft
  const left = Number.isFinite(Number(raw)) ? Number(raw) : 11_000
  const cap = Math.max(0, Math.min(Number(maxMs) || 0, left - 500))
  /* 🔴 2026-10-15 审计：服务端已经发了**复原包**（`restored()` 非 null）就说明这次破坏被拒了，
   *    再等满 `cap` 只是白花预算（`dig` 里每个失败目标约 1.2s）—— 提前收工。
   * 2026-10-15 异步方案 ②：手写轮询收口到 `waitUntil`（两个收工条件合成一个判据）。 */
  const r = await waitUntil(() => watch.hit() || watch.restored?.() != null,
    { ms: cap, pollMs: 60, signal, label: '等挖掘回包' })
  if (r.reason === 'aborted') throw abortError('等挖掘回包')
  return watch.hit()
}
