/**
 * 连串动作的调度层（路线图第 ④ 条第二十二刀）
 *
 * 从 `src\core.mjs` 搬出来的两个成员：
 *   · `runSequence(steps, { stopOnError, budgetMs })` —— 按顺序跑一串步骤，到点/被打断就停下，
 *     并**明确告诉模型从第几步接着发**（`stoppedAt` / `remaining` / `hint`）。
 *   · `#runStep(s)` —— 单个步骤的分发（op → 具体动作）。
 *
 * ## 为什么第一参数是 `self` 而不是 `ctx`（迁移规矩第 17 / 20 条）
 * 这一层**不改**实例状态，但它要**调**一堆实例方法（`self.walkTo` / `self.placeBlock` /
 * `self.dig` / `self.attack` …）和读 `self.msLeft()` / `self.abortSignal` / `self.bot`。
 * 按第 17 条的判据（"只读几项实例状态"才打包成 `ctx`），这里要的东西既多又杂、还得回调回去，
 * 所以直接收 `self`。模块自己不 import `core.mjs`、不 import 任何游戏库（只 import 兄弟叶子模块）。
 *
 * ## 三条容易改回去的语义（都是审计钉过的，改回去就是 bug）
 * 1. **不为没执行的步骤记一条 `ok:false`**（审计⑪）：以前时间到/被打断时也会 push 一条，
 *    于是 `succeeded + failed + remaining > requested`，模型据此以为"那步做失败了"。
 *    现在只记 `next`（重发时从那步开始），不写 `results`。
 * 2. **`move` 的 `ok` 必须看 `arrived`**（审计⑧）：`walkTo` 走不通时返回
 *    `{arrived:false, stuck:true}`，以前 `ok` 硬编码 true，汇总把它算成功，模型以为"我已经到目标点了"。
 * 3. **步骤自己发现预算用尽 ⇒ 一样给 `stoppedAt`**（审计⑦）：`jump` / `flyTo` 开头就查
 *    `msLeft()`，抛出的错带 `mcCallOver`；不能让它变成"整串失败、从第 1 步重来"。
 */

import { CALL_BUDGET_MS, callBudget } from './budget.mjs'
import { sleep, raceAbort } from './async-util.mjs'

/**
 * 这一步**到底成没成**（报告 H3，2026-10-13）。
 *
 * 以前是 `step.op === 'move' ? r?.arrived !== false : r?.ok !== false` —— 只有 `move` 特判，
 * 其余全走 `r?.ok !== false`，而**动作模块没有一个返回 `ok` 字段**：
 *   `place` 回 `{placed: 名|false}`、`break` 回 `{broken: 名|false}`、`dig` 回 `{result:[…]}`、
 *   `attack` 回 `{killed, attacked}` … ⇒ `undefined !== false` 恒真 ⇒ 汇总把失败的
 *   place / break / dig / attack 全算成 `succeeded`，模型据此以为做成了。
 *
 * 判据只认"明确的失败证据"（各 op 自己的成功字段为 `false`，或返回里带 `error`），
 * 拿不准就按成功算 —— 宁可让模型自己看 `results` 里的原文，也不要凭空报失败。
 */
export function stepOk (step, r) {
  const op = step?.op
  if (r == null) return true
  if (r.ok === false || r.error) return false
  switch (op) {
    case 'move':
    case 'swim':
      return r.arrived !== false
    case 'place':
      return r.placed !== false && r.placed != null
    case 'break':
      return r.broken !== false && r.broken != null
    case 'attack':
      return r.killed !== false && r.attacked !== false
    /* 🔴 2026-10-15 审计（报告 C 第 1 条）：下面 equip / toss / use / useitem 四条原来都是
     *   `r.xxx !== false` —— 而那几个字段**要么根本不存在、要么永远是真值**，于是"失败的步骤
     *   被算成成功"，`stopOnError` 也就永远不触发。改成看各动作**真正复核过的**字段
     *   （字段是 2026-10-15 一并补上的：`equipped` / `ok` / `opened` / `toggled`）。 */
    case 'equip':
      if (typeof r.equipped === 'boolean') return r.equipped
      return r.held !== undefined || r.now !== undefined
    case 'give':
      return r.gave !== false
    case 'toss':
      if (typeof r.ok === 'boolean') return r.ok
      if (typeof r.tossed === 'boolean') return r.tossed
      return !/只少了|没丢出去/.test(String(r.note ?? ''))
    case 'use': {
      // 容器看窗口开没开、门/按钮看状态翻没翻（这两条是硬证据）；其它方块服务端不回执，按"拿不准就算成功"
      if (r.usedBlock !== undefined && r.usedBlock !== null) {
        if (r.opened !== undefined) return Boolean(r.opened)
        if (r.toggled !== undefined) return Boolean(r.toggled)
        return true
      }
      if (r.usedEntity !== undefined) return r.reached !== false
      return r.used !== false && r.usedBlock !== false
    }
    case 'useitem':
      return r.used !== false
    case 'dig': {
      const txt = Array.isArray(r.result) ? r.result.join('\n') : String(r.result ?? '')
      return !/没挖成|没挖掉|够不着|没有能挖|不在线|复原|找不到|失败/.test(txt)
    }
    default:
      return true
  }
}

/** 按顺序执行一串步骤。替代"让 AI 写脚本"——我们不给它脚本能力，而是把"走这里→放几个→再走那里"收进一个工具。 */
export async function runSequence (self, steps, { stopOnError = true, budgetMs = CALL_BUDGET_MS } = {}) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps 必须是非空数组')
  if (steps.length > 64) throw new Error(`步骤太多（${steps.length}），上限 64`)
  const t0 = Date.now()
  // 🔴 单次调用 ≤11 秒（用户要求：少量多次）。到点就停，并明确告诉模型**从第几步接着发**。
  //    2026-10-08 审计⑦：`msLeft()` 已经用完时，`Math.max(300, …)` 会白送 300ms。
  const leftMs = self.msLeft()
  const bd = leftMs <= 100 ? 0 : Math.max(0, Math.min(callBudget(budgetMs), leftMs))
  const results = []
  let next = null
  let aborted = false
  for (let i = 0; i < steps.length; i++) {
    /* 🔴 2026-10-08 第四份审计报告 ⑪：这两支以前会为**根本没执行**的那步 push 一条 `ok:false`
     *    ⇒ 汇总里 `succeeded + failed + remaining > requested`（模型据此以为"那步做失败了"）。
     *    现在只记 `next`（那步没做，重发时从它开始），不写 results。 */
    if (self.abortSignal?.aborted) { aborted = true; next = i; break }
    if (Date.now() - t0 > bd) { next = i; break }
    const step = steps[i] ?? {}
    try {
      const r = await runStep(self, step)
      /* 🔴 2026-10-08 审计⑧：`ok: true` 以前是硬编码的 —— 而 move 步骤在"一格没挪"时返回
       *    `{arrived:false, stuck:true, reason:…}`，汇总里 `succeeded` 于是把它也算成功，
       *    模型据此以为"我已经在目标点了"。move 的 ok 必须看 `arrived`。
       * 🔴 报告⑤：`wait` 步骤被本轮预算**静默截断**时也会自报 `ok:false`（没等完），
       *    那时也要如实算失败、并从这一步重发。
       * 🔴 报告 H3：其余 op 以前走 `r?.ok !== false`（动作模块根本不回 `ok`）⇒ 恒真。
       *    现在交给 `stepOk()` 按各 op 的真实成功字段判（见上面那个函数的注释）。 */
      const ok = stepOk(step, r)
      results.push({
        i, op: step.op, ok, ...r,
        ...(ok ? {} : {
          note: step.op === 'move'
            ? '这一步**没走到**（看 arrived / remaining）—— 再叫一次 mc_sequence，从这一步往后发就行'
            : '这一步**没做完**（本轮时间不够）—— 再叫一次 mc_sequence，从这一步往后发就行',
        }),
      })
      if (!ok) { next = i; break }
    } catch (e) {
      results.push({ i, op: step.op, ok: false, error: e.message })
      /* 🔴 2026-10-08 审计⑦：预算用尽也可能是**步骤自己**先发现的（`jump` / `flyTo` 开头就查
       *    `msLeft()`，`#t()` 也会抛带 `mcCallOver` 的错）。那时错误文案是"这一轮的 N 秒用完了"。
       *    不能让它变成"整串失败、从第 1 步重来"：跟循环顶部那支一样记下停在第几步。 */
      const exhausted = e?.mcCallOver === true
        || /这一轮的 [\d.]+ 秒用完了|这一轮的时间已经用完了/.test(String(e?.message ?? ''))
        || self.msLeft() <= 150
      if (exhausted) { next = i; break }
      if (stopOnError) break
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return {
    requested: steps.length, succeeded: okCount, failed: results.length - okCount,
    /* 🔴 报告⑪：`remaining` 从"第一步还没做完的"算起（**含那一步本身**）⇒ 它和 `failed` 会
     *    指向同一步。想让账目不重复，看 `succeeded === stoppedAt`（stoppedAt 之前全成功）。 */
    attempted: results.length,
    elapsedMs: Date.now() - t0, results,
    ...(aborted ? { aborted: true } : {}),
    ...(next == null ? {} : {
      stoppedAt: next, remaining: steps.length - next,
      hint: aborted
        ? `被中断了（第 ${next + 1} 步还没做）—— 要接着做就再叫一次 mc_sequence，steps 从第 ${next + 1} 步往后发。`
        : next === 0
          ? '这一轮的时间已经用完了（前面什么都没做）—— 直接再叫一次 mc_sequence，steps 原样发就行。'
          : `做到第 ${next + 1} 步时这一轮的时间到了 —— 再叫一次 mc_sequence，`
            + `steps 从第 ${next + 1} 步往后发就行（前面已经做完了）。`,
    }),
  }
}

/**
 * 单个步骤的分发。
 *
 * 步骤 op：wait / move / look / turn(toward) / place / break / dig / use / useitem /
 *          attack / equip / give / toss / say / jump / swim
 */
export async function runStep (self, s) {
  const op = String(s.op ?? '')
  switch (op) {
    case 'wait': {
      const rawSec = s.sec != null ? Number(s.sec) : (s.ms != null ? Number(s.ms) / 1000 : 1)
      const sec = Number.isFinite(rawSec) ? rawSec : 1
      const requestedMs = Math.min(Math.max(sec * 1000, 0), 30_000)
      const ms = Math.min(requestedMs, Math.max(0, self.msLeft()))
      /* 🔴 2026-10-08 第四份审计报告 ③⑤：以前 `await sleep(ms)` ——
       *   ③ 完全不可中断（探针：60ms abort 后仍等满 2009ms）；
       *   ⑤ 被本轮预算截断时照样报 `ok:true, waitedMs:300`，汇总说"成功了"，模型以为等够了。 */
      await raceAbort(sleep(ms), self.abortSignal, '等待')
      const short = ms < requestedMs - 50
      return {
        waitedMs: ms,
        ...(short
          ? {
              ok: false, requestedMs,
              note: `只等了 ${(ms / 1000).toFixed(1)} 秒（想要 ${(requestedMs / 1000).toFixed(1)} 秒）—— 这一轮的时间不够，`
                + '再叫一次 mc_sequence 从这一步往后发，接着等',
            }
          : {}),
      }
    }
    case 'move': {
      const target = { x: Number(s.x), y: Number(s.y), z: Number(s.z) }
      const creative = self.bot?.game?.gameMode === 'creative'
      const mode = String(s.mode ?? (creative ? 'fly' : 'walk'))
      // 🔴 2026-10-08 审计⑤：fly 以前**不传 budgetMs** —— AI 写 `budgetMs:2000` 想飞一小段，
      //    实际跑满 callBudget 的 10 秒，把整串步骤的预算全吃掉。
      if (mode === 'fly') return { ...(await self.flyTo(target.x, target.y, target.z, { budget: callBudget(s.budgetMs) })), mode }
      return { ...(await self.walkTo(target, { budget: callBudget(s.budgetMs) })), mode }
    }
    case 'look':    return self.lookAt(s)
    // 'toward' 要与 mc_act{mode:"toward"} 语义一致：**看向并走近**（只 lookAt 是错的）
    case 'toward':  return self.interact({ mode: 'toward', who: s.who, approach: s.approach, budgetMs: s.budgetMs })
    case 'place':   return self.placeBlock(s)
    case 'break':   return self.breakBlock(s)
    case 'dig':     return { result: await self.dig(s) }
    case 'use':     return self.useBlock(s)
    case 'useitem': return self.useItem(s)
    case 'attack':  return self.attack(s)
    case 'equip':   return self.equip(s)
    case 'give':    return self.giveItem(s)
    case 'toss':    return self.tossItem(s)
    case 'say':     return { said: self.chatSay(s.text ?? '') }
    case 'jump':    return self.jump()
    case 'swim':    return (s.x != null && s.y != null && s.z != null) ? self.walkTo(s) : self.swimUp(s)
    default:
      throw new Error(`未知步骤 op："${op}"（可用：wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim）`)
  }
}
