/*
 * 搭建那一层：批量放置（`mc_build` 的正文）。
 *
 * 为什么单独一层：它是"范围 → 一堆坐标 → 逐个 `placeBlock`"的调度，
 * 自己不放方块（真放方块是 core 的 `placeBlock`，会自己走近/垫脚），
 * 只负责**跳过已经放对的、如实报失败、到点就带着已放好的结果收手**。
 *
 * 三条判据（都是 2026-10-08 审计之后钉下的）：
 *   ① 只有 `placeBlock` 回 `placed`（复核过真放上去了）才算 placed —— 旧版无条件 ok.push，
 *      于是 `mc_build` 报的数量是假的；
 *   ② 不给 `name` 时，格子已经有东西（不是空气）就跳过并如实说，别让 placeBlock 一个个抛
 *      "已被 X 占住"攒够 5 个把整次调用报成失败；
 *   ③ 单次调用 ≤11 秒：到点带着已放好的返回，再叫一次同一个范围就行（放对的会跳过）。
 *
 * 形状：要回调实例方法（`placeBlock`）与实例状态（`requireBot` / `callLeft`）⇒ 第一参数收 `self`
 *（迁移规矩第 27 条）。
 */
import vec3pkg from 'vec3'
import { isAir } from './block-names.mjs'
import { heldText } from './inventory.mjs'
import { callSecText } from './budget.mjs'

const Vec3 = vec3pkg.Vec3 ?? vec3pkg
/**
 * 批量放置：从 (x1,y1,z1) 到 (x2,y2,z2) 的实心长方体。
 * 逐个调用 placeBlock（会自己走近/垫脚），count 上限保护。
 */
export async function build (self, { x1, y1, z1, x2, y2, z2, name = null, max = 64 } = {}) {
  const pts = []
  const [ax, bx] = [Math.min(x1, x2), Math.max(x1, x2)]
  const [ay, by] = [Math.min(y1, y2), Math.max(y1, y2)]
  const [az, bz] = [Math.min(z1, z2), Math.max(z1, z2)]
  for (let y = ay; y <= by; y++) for (let z = az; z <= bz; z++) for (let x = ax; x <= bx; x++) pts.push({ x, y, z })
  if (pts.length > max) throw new Error(`要放 ${pts.length} 个方块，超过上限 ${max}（缩小范围或调大 max）`)
  const b = self.requireBot()
  const want = name == null ? null : String(name)
  // 🔴 单次调用 ≤11 秒：到点就带着已放好的结果返回，剩下的下次再叫。
  //    再叫一次时**已经放对的点会跳过**（不报"这格已经有方块"），所以直接重发同一个范围就行。
  // 🔴 `self.callLeft()`：本轮已经用掉的时间要算进去（`mc_sequence` 里"走一段再搭"只剩几秒）。
  const deadline = Date.now() + self.callLeft()
  const ok = []
  const fail = []
  const skipped = []
  const held0 = heldText(b)
  let used = null                       // 实际用了哪种方块（"搭完手里还剩什么"是模型最缺的一条）
  let done = 0
  for (const p of pts) {
    if (deadline - Date.now() < 300) break
    done++
    const at = `${p.x},${p.y},${p.z}`
    try {
      const cur = b.blockAt(new Vec3(p.x, p.y, p.z))?.name ?? null
      // ① 已经是想要的那种方块 ⇒ 跳过（重发同一范围时不算失败）
      if (want && cur === want) { ok.push(at); continue }
      /* ② 没指定方块、但这格已经有东西了 ⇒ 跳过并如实说
       *    （旧版会让 placeBlock 一个个抛"已被 X 占住，放不进去"，攒够 5 个就把整次调用报成失败） */
      if (!want && cur && !isAir(cur)) { skipped.push(`${at}:${cur}`); continue }
      const r = await self.placeBlock({ ...p, name })
      /* 🔴 只有**复核过真放上去了**才算 placed（2026-10-08 审计：旧版无条件 ok.push，
       *    placeBlock 回 placed:false 时也照算 ⇒ mc_build 报的数量是假的） */
      if (r?.placed) { if (!used) used = r.placed; ok.push(at) } else { fail.push(`${at}: 现在那里是 ${r?.now ?? '未加载'}`); if (fail.length >= 5) break }
    } catch (e) { fail.push(`${at}: ${e.message}`); if (fail.length >= 5) break }
  }
  const left = pts.length - done
  const held = heldText(b)
  return {
    requested: pts.length, placed: ok.length, failed: fail.length, failures: fail.slice(0, 5),
    ...(skipped.length ? { skipped: skipped.length, skippedWhy: `这 ${skipped.length} 格本来就有方块（不是我要放的那种），没动它们：${skipped.slice(0, 3).join('、')}` } : {}),
    ...(used ? { used } : {}),
    ...(held !== held0 ? { held, heldBefore: held0 } : { held }),
    ...(left > 0
      ? { remaining: left, hint: `这一轮的 ${callSecText()}用完了，还有 ${left} 个没放 —— 再叫一次 mc_build（同一个范围就行，放对的会跳过）` }
      : {}),
  }
}
