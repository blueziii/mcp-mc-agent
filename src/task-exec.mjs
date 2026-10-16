/**
 * 任务执行器：一轮只推进**一个可验证的步骤**
 * ===========================================================================
 * 2026-10-14 用户"任务驱动"设计第二步。三层分工（用户原话）：
 *   · 自主层 `extensions\mc_auto.mjs` —— 决定何时唤醒、有没有危险，**不**执行一串动作
 *   · 任务层 `src\task-runner.mjs`（台账）+ **本文件**（执行器）—— 目标、步骤、验证、重试、恢复
 *   · 动作层 `src\core.mjs` + 各 `mc_*` 工具 —— 真的下发动作，回真实结果
 *
 * 🔴 本文件**不 import 任何游戏库**，也不碰 `bot.setControlState()`：
 *    · 看世界 —— 调用方给 `observe()`
 *    · 干活   —— 调用方给 `call(tool, args)`
 *    · 收手   —— 调用方给 `cancelStep()`
 *    · 记账   —— 交给 `ledger`（`TaskRunner`）
 *    这样"谁来推"是可换的：模型、执行器、以后的定时任务都走同一套记账。
 *
 * 四条硬约束（用户点名要求的四条细节）：
 *   ① **每轮有预算和超时** —— `budgetMs` + `maxRounds`，到点带着进度返回，绝不无限等。
 *   ② **`waiting` 不占执行锁** —— 只记一个复查时刻（`waitUntil`）就返回；
 *      什么时候再叫由外面决定（事件、下一次工具调用、定时任务都行）。
 *   ③ **取消要停掉底下那件事** —— 先 `cancelStep()`（停寻路/停采集/松控制位）再改状态；
 *      反了就变成"状态说取消了，动作还在跑"。
 *   ④ **目标达成看真实状态** —— `goalDone()` 读的是 `observe()` 给的现场（背包/坐标），
 *      不是上一步返回了 `ok:true`。判不出来就如实说"复核不了"，绝不硬判成功。
 *
 * 另外两条是这个项目自己的规矩：
 *   · **超时 ≠ 失败**：`outcomeOf()` 判成 `unknown` 的一律不记成步骤失败
 *     （用户原话"超时不能自动当作失败，因为服务器可能已经执行了动作"）。
 *   · **不替模型做没有 `op` 的步骤**：步骤没写 `op` 就原样交回（`manual:true`）——
 *     台账里记着"这一步做了"必须是真的做了，不能由执行器猜。
 */
import {
  classifyFailure, dropOf, goalSpecOf, outcomeOf, taskBrief,
} from './task-runner.mjs'
/* `taskObserveOf` 要读背包（"目标达成没"看的是真实背包/坐标，不是上一步返回的 ok:true） */
import { invCounts, heldText } from './inventory.mjs'

/** 执行器的默认参数（`budgetMs` 还会被本轮的 `msLeft()` 再夹一次） */
export const RUN_DEFAULTS = {
  budgetMs: 8000,     // 一轮最多跑多久（真正的上限是 `min(这个, 本轮剩余 - 900ms)`）
  /* 审计 F12：原来这里还有个 `reserveMs: 900`，本文件里**从没被读过**
   * （`index.js` 的 mc_task handler 自己硬编码 `left - 900`）—— 删掉，免得看着像可调的旋钮。 */
  maxRounds: 6,       // 一轮最多推进几步
  waitMs: 5000,       // `waiting` 的复查间隔（到点再由外面叫）
}

/**
 * 步骤的 `op` → 工具名。
 * `op` 可以直接写工具名（`mc_dig`），也可以用这里的动词简写（`dig`）。
 * 动词表故意很短：**执行器不解释语义**，它只负责"把这一步交给哪个工具 + 看结果"。
 */
export const OP_TOOL = {
  dig: 'mc_dig', mine: 'mc_dig',
  craft: 'mc_craft',
  smelt: 'mc_furnace', smelting: 'mc_furnace',
  move: 'mc_move', goto: 'mc_move', travel: 'mc_move',
  store: 'mc_chest', take: 'mc_chest', chest: 'mc_chest',
  scan: 'mc_scan', status: 'mc_status', observe: 'mc_observe',
  inventory: 'mc_inventory',
  equip: 'mc_act', attack: 'mc_act', place: 'mc_act', break: 'mc_act',
  use: 'mc_act', toss: 'mc_act', look: 'mc_act', useitem: 'mc_act',
  give: 'mc_give',
}

/** `mc_act` 的动词简写要顺手补上 `mode`（不然 `mc_act` 只会转头看一眼） */
export const OP_MODE = {
  equip: 'equip', attack: 'attack', place: 'place', break: 'break',
  use: 'use', toss: 'toss', look: 'look', useitem: 'useitem',
}

/** 这一步交给哪个工具（认不出返回 `null` ⇒ 这一步没有可执行的动作） */
export function opToolOf (step) {
  const raw = String(step?.op ?? '').trim()
  if (!raw) return null
  if (/^mc_[a-z0-9_]+$/.test(raw)) return raw
  return OP_TOOL[raw.toLowerCase()] ?? null
}

/** 这一步的参数（`op` 是动词简写时补 `mode`；显式写了 `args.mode` 就不覆盖） */
export function opArgsOf (step) {
  const args = { ...(step?.args ?? {}) }
  const mode = OP_MODE[String(step?.op ?? '').toLowerCase()]
  if (mode && args.mode == null) args.mode = mode
  return args
}

/**
 * 目标达成没？读的是**现场状态**（`observe()` 给的），不是上一步的返回值。
 * @returns {boolean|null} `null` = 复核不了（不硬判）
 */
export function goalDone (task, state) {
  if (!task || !state) return null
  const spec = goalSpecOf(task)
  if (spec.type === 'reach') {
    const to = task.params?.to
    if (!to || !state.position) return null
    const d = Math.hypot(
      Number(state.position.x) - Number(to.x),
      Number(state.position.y) - Number(to.y),
      Number(state.position.z) - Number(to.z),
    )
    return Number.isFinite(d) ? d <= 2 : null
  }
  if (spec.type === 'kill') return null          // 怪死没死要现场看实体，这里判不了
  const item = spec.item ?? task.params?.item ?? null
  const want = spec.count ?? task.progress?.total ?? null
  if (!item || want == null) return null
  /* 🔴 `counts` 读不到（`null`）和"背包里确实没有这样东西"是两回事：
   *    前者判不了（回 `null`），后者就是 0（回 `false`）。 */
  if (!state.counts || typeof state.counts !== 'object') return null
  const have = Number(state.counts[item] ?? 0)
  if (!Number.isFinite(have)) return null
  return have >= Number(want)
}

/**
 * 这一步是不是**已经不用做了**（前置条件已经满足）。
 * 例：要挖 16 根原木，但背包里已经有 16 个掉落物；要合成工作台，但背包里已经有一张。
 * 只认能确定的两类（挖 / 合成）；别的交给工具自己判断。
 */
export function stepSatisfied (step, state) {
  const tool = opToolOf(step)
  const args = step?.args ?? {}
  if (!tool || !state?.counts) return { skip: false, why: null }
  if (tool === 'mc_dig') {
    const item = args.name ?? null
    const want = Number(args.count ?? 1)
    if (!item || !Number.isFinite(want) || want <= 0) return { skip: false, why: null }
    const drop = dropOf(item) ?? item
    const have = Number(state.counts[drop] ?? 0)
    if (have >= want) return { skip: true, why: `背包里已经有 ${drop} ×${have}（这一步要 ${want}）` }
    return { skip: false, why: null }
  }
  if (tool === 'mc_craft') {
    const item = args.name ?? null
    /* 🔴 参数名是 `count`（`extensions\mc_craft.mjs` 只认 count；`times` 会被静默忽略、
     *    只保证 1 个）。旧写法读 `args.times` ⇒ 建议动作"做 8 个"实际只做 1 个。
     *    还认 `times` 只是为兼容已经落盘的老任务步骤。 */
    const want = Number(args.count ?? args.times ?? 1)
    if (!item || !Number.isFinite(want) || want <= 0) return { skip: false, why: null }
    const have = Number(state.counts[item] ?? 0)
    if (have >= want) return { skip: true, why: `背包里已经有 ${item} ×${have}（这一步要 ${want}）` }
    return { skip: false, why: null }
  }
  return { skip: false, why: null }
}

/** 一行"这一轮干了什么"（给工具输出用）—— `index.js` 的 `mc_task {action:"run"}` 就调它 */
export function runText (r) {
  if (!r) return '（没有结果）'
  const head = r.done ? '✅ 任务完成' : (r.blocked ? '⛔ 卡住了' : (r.manual ? '✋ 交回给你' : '⏳ 这一轮先到这'))
  const body = (r.lines ?? []).length ? `\n${(r.lines ?? []).join('\n')}` : ''
  const why = r.reason ? `\n（${r.reason}）` : ''
  const tail = r.hint ? `\n${r.hint}` : ''
  return `${head}（推进 ${r.rounds ?? 0} 步）${body}${why}${tail}`
}

/**
 * 任务执行器。一个 `McBot` 一个实例（懒建）。
 *
 * ```js
 * const ex = new TaskExecutor({ ledger: bot.tasks, observe, call, cancelStep, log })
 * await ex.run({ taskId, budgetMs, maxRounds, force, signal })
 * ```
 */
export class TaskExecutor {
  constructor ({ ledger, observe = null, call = null, cancelStep = null, log = () => {}, now = () => Date.now() } = {}) {
    this.ledger = ledger
    this.observe = observe
    this.call = call
    this.cancelStep = cancelStep
    this.log = log
    this.now = now
    this.running = false
  }

  /** 看世界（失败不当成"世界是空的"，返回 `null` 让上层如实说复核不了） */
  async #look (signal) {
    if (typeof this.observe !== 'function') return null
    try {
      return await this.observe({ signal })
    } catch (e) {
      this.log(`看世界失败：${String(e?.message ?? e).slice(0, 120)}`)
      return null
    }
  }

  /**
   * 跑一轮。**一轮只推进一个可验证的步骤**，到预算/步数上限就带着进度返回。
   * @returns {{ok:boolean, done?:boolean, rounds:number, task:object|null, lines:string[],
   *            manual?:boolean, blocked?:boolean, outcome?:string, stopped?:string,
   *            reason?:string, hint?:string, waitSec?:number}}
   */
  async run ({ taskId = null, budgetMs = null, maxRounds = null, force = false, signal = null, call = null } = {}) {
    if (call && typeof call === 'function') this.call = call
    const t = taskId ? this.ledger.get(taskId) : this.ledger.current()
    const brief = () => (t ? taskBrief(this.ledger.get(t.taskId) ?? t) : null)
    const lines = []
    if (!t) return { ok: false, rounds: 0, task: null, lines, reason: '没有可执行的任务' }

    if (t.status === 'done') return { ok: true, done: true, rounds: 0, task: brief(), lines, reason: '这个任务已经完成了' }
    if (t.status === 'cancelled') return { ok: false, rounds: 0, task: brief(), lines, reason: '这个任务已经取消了' }
    if (t.status === 'failed') return { ok: false, rounds: 0, task: brief(), lines, reason: '这个任务已经失败了' }
    if (t.status === 'blocked' && !force) {
      return { ok: false, blocked: true, rounds: 0, task: brief(), lines, loopDetected: t.loopDetected ?? null, reason: '这条任务卡住了（同一个动作连着失败）—— 等指示；要再试一次就传 force' }
    }
    if (t.status === 'paused' && !force) {
      return { ok: false, rounds: 0, task: brief(), lines, reason: `这条任务暂停中${t.pauseReason ? `（${t.pauseReason}）` : ''} —— 玩家的事优先；要接着做就传 force` }
    }
    if (t.status === 'waiting' && !force) {
      const left = Math.ceil((Number(t.waitUntil ?? 0) - this.now()) / 1000)
      if (left > 0) {
        return { ok: false, rounds: 0, task: brief(), lines, waitSec: left, reason: `还没到复查时间（还要 ${left} 秒）—— 到点再叫一次，或者传 force 立刻试` }
      }
    }
    /* 🔴 重入保护：执行器自己不做定时器、不做并发 —— 同一时刻只跑一条。
     *    `waiting` 的任务不占锁（上面已经直接返回了），所以不会把别人堵住。 */
    if (this.running) return { ok: false, rounds: 0, task: brief(), lines, reason: '上一条任务还在跑（一次只推进一条）' }

    const cap = Math.max(1, Number(maxRounds) || RUN_DEFAULTS.maxRounds)
    const budget = Math.max(500, Number(budgetMs) || RUN_DEFAULTS.budgetMs)
    const deadline = this.now() + budget
    let rounds = 0
    /* 🔴 轮内退出原因：`waiting` 之外还有"掉线"这种**不是步数用完**的收场（审计 F6） */
    let stoppedWhy = null
    /* 🔴 代次（2026-10-15，用户点名的异步方案 ⑤）：见 `src\task-runner.mjs` 的 `TASK_EPOCH_START`。
     *    每次 `await` 之前记下"我在哪一代"，回来之后对一次 —— 对不上就说明模型在这中间
     *    `plan` 重排了步骤表 / `cancel` 掉了任务，手里这份活儿已经属于上一代，
     *    **立刻停手、绝不往新表上写账**。两处 await 各有一次检查：
     *      · `#look`（看现场）之后 —— 别在**已经作废的计划**下再动手；
     *      · `this.call`（干活）之后 —— 结果作废，丢掉。 */
    let epoch0 = this.ledger.epochOf(t.taskId)
    this.running = true
    try {
      while (rounds < cap) {
        if (signal?.aborted) { lines.push('被叫停了'); break }
        if (this.now() >= deadline) break
        const cur = this.ledger.get(t.taskId)
        if (!cur || cur.status === 'done' || cur.status === 'cancelled' || cur.status === 'failed') break
        /* 🔴 轮内复查状态（审计 F4）：断线时 `src\connection.mjs` 会 `tasks.pause(...)`、
         *    被抢占时 `src\mining.mjs` 也会 pause —— 这些都发生在**本轮循环内部**，
         *    上面那行只看了 done/cancelled/failed，所以 paused/blocked 的任务会继续动手。
         *    一次 run 最多 6 轮、每轮 1~2 秒，模型看不见"我已经被暂停了"还会继续挖。 */
        if (cur.status === 'paused' || cur.status === 'waiting' || cur.status === 'blocked') {
          lines.push(`⏸ 任务现在是 ${cur.status}（${cur.note ?? '没有说明'}）—— 这一轮先停手`)
          break
        }

        const state = await this.#look(signal)
        if (!state) { lines.push('看不了现场（读不到游戏状态）—— 先 mc_observe 看一眼'); break }
        /* 🔴 看现场那一下也 await 了：这中间模型完全可能把步骤表重排 / 把任务取消。
         *    那就不该再按**旧计划**往下动手 —— 停手，并且说清是"被改过"，
         *    不能让模型看到 `rounds`（"步数用完了"）那种误导性的理由。 */
        const staleLook = this.ledger.staleOf(t.taskId, epoch0)
        if (staleLook.stale) {
          lines.push(`♻️ 任务在我看现场的时候被改过（${staleLook.why ?? '重新规划 / 取消'}）—— 这一轮先不做`)
          stoppedWhy = 'epoch'
          break
        }
        if (!state.online) {
          this.ledger.wait(t.taskId, '掉线了 —— 重连之后再继续')
          lines.push('掉线了，先等重连')
          stoppedWhy = 'offline'
          break
        }

        /* ① 目标达成？（看现场，不看上一步返回了什么） */
        const done = goalDone(cur, state)
        if (done === true) {
          const spec = goalSpecOf(cur)
          const item = spec.item ?? cur.params?.item ?? null
          const have = item ? Number(state.counts?.[item] ?? 0) : null
          if (spec.count != null) {
            this.ledger.progress(t.taskId, { done: Number(spec.count), note: `复核现场：${item} ×${have}` })
          } else {
            this.ledger.finish(t.taskId, { ok: true, note: '复核现场：目标达成' })
          }
          lines.push(`✅ 目标达成（现场：${item ?? '—'}${have == null ? '' : ` ×${have}`}）`)
          return { ok: true, done: true, rounds, task: brief(), lines }
        }

        /* ② 选下一步：认 `phase`（`stepFail` 会把还能重试的步骤放回 pending，只找"第一个 pending"会退回上一步） */
        const step = this.ledger.currentStep(t.taskId)
        if (!step) {
          const all = cur.steps ?? []
          const pending = all.filter((s) => s.status === 'pending' || s.status === 'running')
          if (all.length && !pending.length) {
            /* 步骤都走完了，但**现场复核目标还没达成**（`done === false`）：
             * 不能因为"步骤打完了"就宣布完成 —— 用户定的口径是"completed = 已验证目标达成"。 */
            if (done === false) {
              const spec = goalSpecOf(cur)
              const item = spec.item ?? cur.params?.item ?? null
              const have = item ? Number(state.counts?.[item] ?? 0) : null
              lines.push(`⚠️ 步骤都走完了，但现场复核还没达成（${item ?? '目标'}${have == null ? '' : ` ×${have}`} / 要 ${spec.count ?? '?'}）`)
              return {
                ok: false, manual: true, rounds, task: brief(), lines,
                reason: '步骤都走完了，但现场复核目标还没达成',
                hint: '先 mc_observe / mc_inventory 复核；确实没达成就在 mc_task {action:"plan"} 里补一步，或者自己动手做完再 mc_task {action:"done"}',
              }
            }
            this.ledger.finish(t.taskId, { ok: true, note: '步骤都走完了（目标没法自动复核，按步骤算完成）' })
            lines.push('✅ 步骤都走完了')
            return { ok: true, done: true, rounds, task: brief(), lines }
          }
          return {
            ok: false, manual: true, rounds, task: brief(), lines,
            reason: '这条任务没有可执行的步骤（步骤表是空的）',
            hint: '自己动手做，做完用 mc_task {action:"step", step:"…", status:"done"} 记账；或者用 mc_task {action:"plan"} 写一张带 op 的步骤表',
          }
        }

        /* ③ 这一步是不是已经不用做了（前置条件已满足 ⇒ 跳过，别重复干） */
        const sat = stepSatisfied(step, state)
        if (sat.skip) {
          this.ledger.stepSkip(t.taskId, step.id, sat.why)
          lines.push(`⏭ ${step.id}：${sat.why}`)
          rounds += 1
          continue
        }

        /* ④ 交给哪个工具（没写 op 的步骤不替模型猜 —— 原样交回） */
        const tool = opToolOf(step)
        if (!tool || typeof this.call !== 'function') {
          const i = (cur.steps ?? []).indexOf(step) + 1
          return {
            ok: false, manual: true, rounds, task: brief(), lines,
            reason: `第 ${i} 步「${step.id}」没有可执行的动作${tool ? '（这一轮没给动作通道）' : '（步骤里没写 op）'}`,
            hint: `自己动手做这一步，做完用 mc_task {action:"step", step:"${step.id}", status:"done"} 记账`,
          }
        }
        const args = opArgsOf(step)
        const began = this.ledger.stepBegin(t.taskId, step.id)
        /* 用 `stepBegin` 回的那一代（它和 `epoch0` 正常情况下相等；不等说明**这一步还没开始就已经过期**） */
        if (began?.epoch != null) epoch0 = began.epoch
        const i = (cur.steps ?? []).indexOf(step) + 1
        lines.push(`▶ 第 ${i}/${(cur.steps ?? []).length} 步「${step.id}」→ ${tool}`)

        /* ⑤ 干一步，读**实际结果** */
        let res = null
        try {
          res = await this.call(tool, args, { deadline, signal, task: cur, step })
        } catch (e) {
          res = { error: String(e?.message ?? e) }
        }
        /* 🔴 写账之前先对代次：上面那个 `await` 可能好几秒，模型完全可能在这中间
         *    `mc_task {action:"plan"}` 把步骤表换了（或直接 `cancel`）。
         *    这时 `step.id` 也许还在新表里，但**含义已经变了** ——
         *    照写就会"把新计划里的某一步标成完成，而它其实没做"。
         *    所以整份丢掉：不 `stepDone`、不 `stepFail`、不 `stepReset`、不 `fail`。 */
        const staleNow = this.ledger.staleOf(t.taskId, epoch0)
        if (staleNow.stale) {
          lines.push(`♻️ 「${step.id}」的结果是上一代的（${staleNow.why ?? '任务被改过'}）—— 丢掉，不记账`)
          return {
            ok: false, stale: true, rounds, task: brief(), lines,
            reason: `这一步（${step.id}）跑完时任务已经被改过了（${staleNow.why ?? '重新规划 / 取消'}）—— 结果作废，没往台账上写`,
            hint: '按**现在**的步骤表重来：先 mc_task {action:"get"} 看一眼，再 mc_task {action:"run"}',
          }
        }
        const out = res && typeof res === 'object' ? res : {}
        /* 失败原因可能落在好几个字段里（工具回的是 `{text:'❌ 没挖成 …'}`，
         * 底层异常回的是 `{error:'…'}`）—— 全拼起来再分类，别漏。
         * 🔴 `result` 也要算进来（审计 F1）：`mc_dig` 回的是 `{ result: [一行行文本] }`
         * （`index.js` 的 mc_dig handler），旧写法只看 reason/error/note/why/hint/text
         * ⇒ 这 6 个字段全是 undefined ⇒ `why` 恒空 ⇒ "挖成功 / 被服务端拒 / 时间到"
         * 三种情况在台账里长得一模一样，每轮都记一次失败，3 轮后任务被误判成 blocked。 */
        const why = [
          out.reason, out.error, out.note, out.why, out.hint, out.text,
          Array.isArray(out.result) ? out.result.join(' ') : (typeof out.result === 'string' ? out.result : ''),
        ].filter(Boolean).map((x) => String(x)).join(' ')
        const c = classifyFailure({ kind: out.kind, reason: why })
        /* 🔴 顺序很讲究（冒烟 H/I/P 抓出来的真 bug）：
         * `outcomeOf()` 的最后一行是"判不出就回 `unknown`"—— 那是给**报告层**用的兜底。
         * 直接拿它当"超时"用，会把"附近找不到 / 背包满 / 底层抛异常"这些**明确的失败**
         * 全判成"结果未知"，于是既不重试也不等条件，任务永远原地打转。
         * 所以这里先问 `classifyFailure`：只有**真的**是预算 / 超时 / 被抢占才算"未知"。 */
        const soft = out.mcTimeout === true || out.cutByCall === true || out.preempted === true
          || c.kind === 'budget' || c.kind === 'timeout' || c.kind === 'preempted'
        const outcome = outcomeOf(out)

        if (outcome === 'confirmed') {
          this.ledger.stepDone(t.taskId, step.id, `${tool} 已确认`)
          lines.push(`✅ ${step.id} 完成`)
          rounds += 1
          continue
        }

        /* 结果未知：**不记失败、不记做过**，把步骤收回 pending 等复核（用户原话"超时不能自动当作失败"） */
        if (soft && outcome !== 'failed') {
          this.ledger.stepReset(t.taskId, step.id, '结果未知：时间到/被抢占，还没复核')
          this.ledger.fail(t.taskId, { action: tool, reason: out.mcTimeout ? '时间到' : '被抢占 / 超时', kind: 'timeout' })
          lines.push(`❓ ${step.id} 结果未知（时间到或被抢占 —— 服务器可能已经做了）`)
          return {
            ok: false, outcome: 'unknown', rounds, task: brief(), lines,
            hint: '先 mc_observe / mc_inventory 复核现场，再 mc_task {action:"run"} 接着做（别直接重做）',
          }
        }

        /* ⑥ 失败：分类 → 能重试就下一步再来，不能重试就等条件 / 卡住 */
        if (!c.retryable) {
          this.ledger.stepReset(t.taskId, step.id, `等条件：${c.kind}`)
          this.ledger.fail(t.taskId, { action: tool, reason: c.reason, kind: c.kind })
          this.ledger.wait(t.taskId, c.hint)
          lines.push(`⛔ ${step.id}：${c.hint}`)
          return { ok: false, outcome: 'failed', rounds, task: brief(), lines, hint: c.hint }
        }
        const sf = this.ledger.stepFail(t.taskId, step.id, c.reason || c.hint)
        if (!sf) {
          /* 🔴 别静默（审计 F5）：`stepFail` 找不到这一步（步骤表被改过 / 步 id 对不上）
           *    会返回 null，旧写法直接 break、收场原因还算成 'rounds'（"步数用完了"）——
           *    模型看到的是"再叫一次接着做"，其实什么都没推进。 */
          lines.push(`⚠️ 第 ${step.id} 步记不上账（台账里找不到这一步了）—— 先 mc_task {action:"get"} 看一眼步骤表`)
          stoppedWhy = 'ledger'
          break
        }
        lines.push(`⚠️ ${step.id} 第 ${sf.attempts}/${sf.max} 次没成：${String(c.reason || c.hint).slice(0, 80)}`)
        if (sf.exhausted) {
          return { ok: false, outcome: 'failed', blocked: true, rounds, task: brief(), lines, hint: c.hint }
        }
        rounds += 1
      }

      const stopped = stoppedWhy ?? (signal?.aborted ? 'aborted' : (this.now() >= deadline ? 'budget' : 'rounds'))
      const hint = stopped === 'budget'
        ? '这一轮的时间用完了（**不是失败**）—— 同样的参数再叫一次接着做'
        : (stopped === 'aborted' ? '被叫停了'
          : (stopped === 'offline' ? '掉线了 —— 连回来之后再 mc_task {action:"run"} 接着做'
            : (stopped === 'ledger' ? '台账对不上了 —— 先 mc_task {action:"get"} 看一眼步骤表，别直接重跑'
              : (stopped === 'epoch' ? '任务中途被改过（步骤表重排 / 取消）—— 先 mc_task {action:"get"} 看**现在**的步骤表，再决定要不要接着跑'
                : '这一轮的步数用完了 —— 再叫一次接着做'))))
      return { ok: true, done: false, rounds, stopped, task: brief(), lines, hint }
    } finally {
      this.running = false
    }
  }

  /**
   * 取消：**先停底下那件事**（寻路 / 挖掘 / 采集），再改状态。
   * 反过来的话，任务状态说"已取消"，机器人还在挖 —— 下一个动作就会跟它抢控制位。
   */
  async cancel (taskId = null, why = '取消') {
    const t = taskId ? this.ledger.get(taskId) : this.ledger.current()
    if (!t) return null
    if (typeof this.cancelStep === 'function') {
      try {
        await this.cancelStep({ task: t, reason: why })
      } catch (e) {
        this.log(`取消时收手失败（状态照改）：${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
    return this.ledger.cancel(t.taskId, why)
  }
}

/* ───────────── 会话上的懒建入口（`src\core.mjs` 只留一行薄包装） ─────────────
 * 🔴 2026-10-15 审计：这段（含 `#taskObserve` / `#taskCancelStep`）原来写在 `core.mjs` 里，
 *    把外壳顶过了 `core.mjs ≤ 1000 行` 的规矩。搬进来时行为一字未改 —— 只是把
 *    `this.` 换成了显式传进来的 `self`（README 迁移规矩第 20/27 条：要读要改就收 `self`）。
 * ------------------------------------------------------------------------- */

/**
 * 取（必要时建）这只机器人对应的执行器。`core.mjs` 的 `taskRun()` / `taskRunCancel()` 调它。
 *
 * 注入的三件事都在这里备好：
 *   · `observe()`    —— 看现场（在线 / 坐标 / 背包计数 / 手持）
 *   · `cancelStep()` —— 收手（停寻路 / 停采集 / 松控制位）
 *   · `ledger`       —— 记账（`TaskRunner`）
 * `call(tool, args, ctx)` **不**在这里 —— 那是宿主每轮现给的（工具处理器表）。
 */
export function taskExecOf (self) {
  if (!self._taskExec) {
    self._taskExec = new TaskExecutor({
      ledger: self.tasks,
      observe: () => taskObserveOf(self),
      cancelStep: (o) => taskCancelStepOf(self, o),
      log: (m) => self.log(`[任务执行器] ${m}`),
    })
  }
  return self._taskExec
}

/** 执行器要的"现场"：只读，读不到就如实回 `null`（判不出来比判错好） */
export function taskObserveOf (self) {
  const p = self.online ? self.position : null
  return {
    online: self.online,
    position: p ? { x: p.x, y: p.y, z: p.z } : null,
    counts: invCounts(self.bot),
    held: self.online ? heldText(self.bot) : null,
  }
}

/** 取消任务前先把底下那件事停掉（停寻路 / 停采集 / 松控制位），再改状态 */
export async function taskCancelStepOf (self, { reason = '取消' } = {}) {
  await self.interruptMove(reason)
}
