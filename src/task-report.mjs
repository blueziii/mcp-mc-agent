/**
 * 任务报告与门面层：现场进度 / 三种结局 / 一轮收工结算 / 任务门面（开列查续记完撤忘）
 * ===========================================================================
 * 路线图第 ④ 条第二十四刀：从 `src\core.mjs` 搬出来的三个成员。
 *
 * 第四十二刀又把**任务门面**（`taskStart` / `taskList` / `taskGet` / `taskResume` / `taskNote` /
 * `taskDone` / `taskCancel` / `taskForget`）并了进来：它们全是"读 `self.tasks` 记一笔"的记账动作，
 * 与下面三个是同一层（收工报告要知道这一轮属于哪条任务）。
 *
 * 2026-10-14（用户"任务驱动"设计第一步）再加两个：`taskPlan`（写/看步骤表）与 `taskStep`
 * （推进当前那一步）。它们**只记账、不下发动作** —— 谁来推进由调用方（模型或以后的执行器）决定。
 *
 * 为什么这三个放一起：它们是同一条链上的三件事 ——
 *   干活前看"现在手里有几个"（`taskHave`）→ 收工时判"这一轮成了没"（`verdictLine`）
 *   → 再把结果记到任务上、附一行进度（`taskSettle`）。
 *
 * 形状（迁移规矩第 17 / 27 / 28 条用在这里 —— **同一个模块里三种形状并存**）：
 *   - `taskHave(b, item)` 只读 bot 的背包 ⇒ 参数直接是 `b`（不需要 `self`）。
 *   - `verdictLine(out, okCount, wantTotal)` 一个实例状态都不碰 ⇒ 纯函数。
 *   - `taskSettle(self, …)` 要读 `self.tasks` / `self.position`、要调 `self.tasks.fail/
 *     checkpoint/get` ⇒ 按第 27 条收 `self`。
 *
 * 🔴 进度（`progress.done`）**不在这里记**：由 `dig()` 的每个"复核过的挖掉"成功点自己
 *    `tasks.progress(taskId, { add: 1 })`（`TaskRunner.progress()` 会在 `done >= total` 时
 *    把状态改成 `done`）。这里只做 `checkpoint`（现场锚点）与失败分类 —— 所以
 *    `taskSettle` 里 `now.status === 'done'` 那个分支，只有在成功点已经记满、或 AI 手动
 *    `mc_task {action:"done"}` 过之后才走得到。
 */
import { countOf } from './inventory.mjs'
import { dropOf, taskBrief, taskLine, outcomeOf, verdictText } from './task-runner.mjs'

/** 现场进度：方块名 → 掉落物名 → 背包数量（认不出掉落物就如实回 null） */
export function taskHave (b, item) {
  const it = String(item ?? '').trim()
  if (!it) return null
  const direct = countOf(b, it)
  if (direct != null && direct > 0) return direct
  const drop = dropOf(it)
  if (drop && drop !== it) return countOf(b, drop)
  return direct
}

/**
 * 把"这一轮到底成了没"写成三种结局之一（用户 2026-10-08 路线图第 ⑥ 条）。
 * ---------------------------------------------------------------------------
 * 🔴 为什么要单独判、而且**必须放在 `taskSettle` 之后**：
 *   - 时间到 / 被抢占 = **结果未知**，不是失败：那一镐可能已经挖下去了、人可能已经挪了两格。
 *     把"未知"写成"失败"会让模型重做一遍（重做有时比不动更糟）。
 *   - 判决行里含"动作失败"四个字，而 `taskSettle` 是靠扫 `out` 里的关键词判失败的 ——
 *     先 push 判决行会让**没失败的那一轮**被记成失败。所以顺序是"先结算、后写判决"。
 */
export function verdictLine (out, okCount, wantTotal) {
  const txt = out.join('\n')
  const outcome = outcomeOf({
    dug: okCount,
    restored: /复原/.test(txt),
    reason: /11 秒用完了|时间不够|没开始挖/.test(txt) ? 'budget' : null,
    note: /失败|够不着|没有能挖|找不到|不在线/.test(txt) ? 'refused' : null,
  })
  out.push(verdictText(outcome, `挖到 ${okCount}${wantTotal ? `/${wantTotal}` : ''} 个`))
}

/**
 * 一轮 `mc_dig` 收工：把这一轮的结果**分类**记到任务上，并在输出末尾附一行进度。
 * ---------------------------------------------------------------------------
 * 为什么统一在收工处判、而不是在每条 `out.push` 旁边各写一次：
 *   - `dig()` 里的失败分支有十来处，散着写容易漏（以后加分支还会漏）；
 *   - 判据只有一份（`classifyFailure` 的正则表），改一处就全改；
 *   - 🔴 **"这一轮的 11 秒用完了"不算失败**（走 `budget` 分类）：服务端可能已经把方块挖掉了。
 *     用户 2026-10-08 路线图原话"超时不能自动当作失败，因为服务器可能已经执行了动作"。
 *     只有真正的失败才进循环检测（`fail()` 里对 budget/timeout/preempted 免疫）。
 */
export function taskSettle (self, task, out, okCount, wantTotal) {
  if (!task) return
  const bad = out.find((l) => /失败|够不着|没挖成|没挖掉|没有能挖|找不到|复原/.test(String(l))) ?? null
  if (bad) self.tasks.fail(task.taskId, { action: 'dig', reason: String(bad).slice(0, 160) })
  else if (okCount < wantTotal) self.tasks.fail(task.taskId, { action: 'dig', reason: '这一轮的 11 秒用完了' })
  self.tasks.checkpoint(task.taskId, {
    position: self.position,
    have: taskHave(self.bot, task.params?.item),
    dug: okCount,
  })
  const now = self.tasks.get(task.taskId)
  if (!now) return
  if (now.status === 'done') {
    out.push(`📋 ${taskLine(now)} ✅ 这件活儿干完了`)
    return
  }
  const tail = now.status === 'blocked'
    ? ' —— 同一个原因连着失败太多次，先停一下：换个目标 / 换工具 / 或者 `mc_task {action:"cancel"}` 取消'
    : '（再叫一次 mc_dig 接着挖；不想做了就 `mc_task {action:"cancel"}`）'
  out.push(`📋 ${taskLine(now)}${tail}`)
}

/* ───────────── 任务门面（路线图第 ④ 条第四十二刀） ─────────────
 * 八个记账动作：开工 / 列出 / 看明细 / 恢复复核 / 记一笔 / 完成 / 取消 / 忘掉。
 * 形状：全是"读 self.tasks、读 self.position、必要时读一下现场背包"⇒ 按迁移规矩第 27 条收 `self`；
 * `self.#taskHave` 是私有方法，模块里直接调同模块的 `taskHave(self.bot, …)`（不需要 ctx）。
 */
export function taskStart (self, { kind = 'task', goal = null, item = null, total = null, unit = '个', params = {}, steps = null } = {}) {
  const t = self.tasks.start({ kind, goal, item, total, unit, params, steps })
  // 开工时把现场也记下来：以后 resume 才有"我从哪开始"的锚点
  self.tasks.checkpoint(t.taskId, {
    position: self.position,
    have: taskHave(self.bot, item ?? params?.item),
    note: '开工',
  })
  return taskBrief(t)
}

export function taskList (self, { limit = 10, all = false } = {}) {
  return self.tasks.list({ limit, all }).map((t) => ({ ...taskBrief(t), line: taskLine(t) }))
}

/** 单个任务的明细（含最近几条历史）—— `mc_task {action:"get"}` */
export function taskGet (self, { taskId = null } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId
  if (!id) return null
  const t = self.tasks.get(id)
  if (!t) return null
  return { ...taskBrief(t), line: taskLine(t), history: (t.history ?? []).slice(-8) }
}

/** 恢复：用**现场背包**复核进度，给出下一个动作（不重新规划） */
export function taskResume (self, { taskId = null } = {}) {
  const r = self.tasks.resume(taskId, { countOf: (name) => taskHave(self.bot, name) })
  if (r?.task?.taskId) {
    self.tasks.checkpoint(r.task.taskId, {
      position: self.position,
      have: r.have ?? null,
      verified: Boolean(r.verified),
      note: '恢复时复核',
    })
  }
  return r
}

/**
 * 步骤台账（2026-10-14 "任务驱动"第一步）：`steps` 给了就**重写**计划，没给就当"看一眼"。
 * 只记账，不下发动作。
 */
export function taskPlan (self, { taskId = null, steps = null } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId ?? null
  if (!id) return { ok: false, reason: '现在没有在做的事' }
  const t = steps ? self.tasks.setSteps(id, steps) : self.tasks.get(id)
  if (!t) return { ok: false, reason: '没有这个任务' }
  return { ok: true, task: taskBrief(t), wrote: Boolean(steps) }
}

/**
 * 推进当前那一步。`status`：`done`（默认）/ `running` / `failed` / `skipped` / `pending`。
 * `failed` 只是**记一次重试**，超上限（`maxAttempts`）才把任务标 `blocked`。
 * `pending` = 把这一步**放回"还没做"**（不记失败、也不记完成）—— 给"动作被打断 / 结果未知"用。
 */
export function taskStep (self, { taskId = null, step = null, status = 'done', why = null } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId ?? null
  if (!id) return { ok: false, reason: '现在没有在做的事' }
  const t0 = self.tasks.get(id)
  if (!t0) return { ok: false, reason: '没有这个任务' }
  if (!(t0.steps ?? []).length) return { ok: false, reason: '这个任务还没有步骤表（先 mc_task {action:"plan", steps:[…]} 写一张）' }
  const st = String(status ?? 'done').toLowerCase()
  if (!['running', 'done', 'failed', 'skipped', 'pending'].includes(st)) {
    return { ok: false, reason: `status 只能是 running / done / failed / skipped / pending（给的是 ${st}）` }
  }
  const r = st === 'running' ? self.tasks.stepBegin(id, step)
    : st === 'done' ? self.tasks.stepDone(id, step, why)
      : st === 'failed' ? self.tasks.stepFail(id, step, why)
        : st === 'skipped' ? self.tasks.stepSkip(id, step, why)
          : self.tasks.stepReset(id, step, why)
  if (!r) return { ok: false, reason: step ? `没有这一步：${step}` : '没有可推进的步骤' }
  return { ok: true, status: st, ...r, task: taskBrief(r.task) }
}

export function taskNote (self, { taskId = null, text = '' } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId
  if (!id) return null
  const t = self.tasks.note(id, text)
  return t ? taskBrief(t) : null
}

export function taskDone (self, { taskId = null, note = null } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId
  if (!id) return null
  const t = self.tasks.finish(id, { ok: true, note })
  return t ? taskBrief(t) : null
}

export function taskCancel (self, { taskId = null, why = '取消' } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId
  if (!id) return null
  const t = self.tasks.cancel(id, why)
  return t ? taskBrief(t) : null
}

export function taskForget (self, { taskId = null } = {}) {
  const id = taskId ?? self.tasks.current()?.taskId
  if (!id) return 0
  return self.tasks.forget(id)
}
