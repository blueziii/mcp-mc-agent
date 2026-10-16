#!/usr/bin/env node
/**
 * 任务代次（epoch）的离线自检（2026-10-15 用户点名的异步方案 ⑤「丢弃旧任务的迟到结果」）。
 *
 * 为什么单独一套：`TaskExecutor.run` 会 `await this.call(tool, args, …)` —— 那可能好几秒。
 * 在这几秒里模型完全可能 `mc_task {action:"plan"}` 重排步骤表、或者 `cancel` 掉任务。
 * 等那个 await 回来，手里那份结果就是**上一代**的了：步骤 id 可能还在，但含义已经变了，
 * 照写就会"把新计划里的某一步标成完成，而它其实没做"。
 *
 * 所以钉住两件事：
 *   ① 台账层：**只有**"重排步骤表 / 取消 / 收工"才换代，普通的记进度、记失败、换状态**不算**；
 *   ② 执行器：两个 `await`（看现场 / 干活）回来之后各对一次代次，对不上就**整份丢掉**。
 *
 * 不需要 MC、不需要 DSH；时间靠注入的假时钟，**不真等**。
 */

import { readFileSync } from 'node:fs'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

const R = await import(new URL('../src/task-runner.mjs', import.meta.url))
const { TaskRunner, migrateTask, outcomeOf, verdictText, TASK_EPOCH_START, OUTCOME_LABEL } = R
const { TaskExecutor } = await import(new URL('../src/task-exec.mjs', import.meta.url))

const runnerSrc = read('../src/task-runner.mjs')
const execSrc = read('../src/task-exec.mjs')

/* ── 假时钟：`now` 手动推 ── */
const mkClock = (t0 = 10_000) => {
  const c = { t: t0 }
  c.now = () => c.t
  c.advance = (ms) => { c.t += ms; return c.t }
  return c
}

/** 台账：`file: null` ⇒ 不落盘（`save()` 直接回 false） */
const mkLedger = (clock = mkClock()) => new TaskRunner({ file: null, now: clock.now, log: () => {} })

const STEPS2 = [{ id: 's1', op: 'observe' }, { id: 's2', op: 'observe' }]

const mkState = (extra = {}) => ({ online: true, position: { x: 0, y: 64, z: 0 }, counts: {}, held: null, ...extra })

const mkExec = (ledger, { call, observe = null, clock = null } = {}) => new TaskExecutor({
  ledger,
  observe: observe ?? (async () => mkState()),
  call,
  log: () => {},
  now: clock ? clock.now : () => 10_000,
})

const stepOf = (ledger, id, stepId) => (ledger.get(id)?.steps ?? []).find((s) => s.id === stepId) ?? null

/* ═══════════════ ① 台账层：谁换代、谁不换 ═══════════════ */
section('① 台账层：epoch 从 1 开始；只有"换了一代要干什么"才 +1')

{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  ok(t.epoch === TASK_EPOCH_START, '开工就是第 1 代', `epoch=${t.epoch}`)
  ok(TASK_EPOCH_START === 1, '起点常量就是 1')
  ok(t.epochWhy === null, '刚开工没有"为什么换代"')
  ok(L.epochOf(t.taskId) === 1, 'epochOf 读得到')

  /* 这些是"这一代之内的正常记账"，**一律不许换代** ——
   * 换了的话执行器每轮都会被自己刚写的账判成"过期"，等于自锁。 */
  const before = t.epoch
  L.progress(t.taskId, { add: 1, total: 8 })
  L.fail(t.taskId, { action: 'mc_dig', reason: '够不着' })
  L.note(t.taskId, '随便记一笔')
  L.pause(t.taskId, '玩家的事优先')
  L.wait(t.taskId, '等条件')
  L.checkpoint(t.taskId, { x: 1, y: 2, z: 3 })
  L.stepBegin(t.taskId, 's1')
  L.stepDone(t.taskId, 's1')
  L.stepReset(t.taskId, 's2', '结果未知')
  L.stepSkip(t.taskId, 's2', '不用做')
  L.stepFail(t.taskId, 's2', '没成')
  L.touch(t.taskId, { meta: { a: 1 } })
  ok(t.epoch === before, '记进度 / 记失败 / 备忘 / 暂停 / 等条件 / 检查点 / 步骤记账 都**不**换代', `epoch=${t.epoch}`)

  L.setSteps(t.taskId, STEPS2)
  ok(t.epoch === before + 1, '重排步骤表 ⇒ 换代', `epoch=${t.epoch}`)
  ok(/重排/.test(String(t.epochWhy)), '换代原因记下来了', `why=${t.epochWhy}`)
  ok(t.epochAt === 10_000, '换代时间也记下来了', `at=${t.epochAt}`)

  L.cancel(t.taskId, '用户改主意了')
  ok(t.epoch === before + 2, '取消 ⇒ 换代', `epoch=${t.epoch}`)
  ok(/取消/.test(String(t.epochWhy)), '取消的原因记下来了', `why=${t.epochWhy}`)

  const t2 = L.start({ kind: 'custom', steps: STEPS2 })
  L.finish(t2.taskId, { ok: true })
  ok(t2.epoch === 2, '收工 ⇒ 换代', `epoch=${t2.epoch}`)
  ok(/收工/.test(String(t2.epochWhy)), '收工的原因记下来了', `why=${t2.epochWhy}`)
}

section('①b staleOf：对不上就说过期（含"任务没了"）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  ok(L.staleOf(t.taskId, 1).stale === false, '代次对得上 ⇒ 不过期')
  ok(L.staleOf(t.taskId, 1).epoch === 1, '回的是**现在**的代次')
  L.setSteps(t.taskId, STEPS2)
  const s = L.staleOf(t.taskId, 1)
  ok(s.stale === true, '代次对不上 ⇒ 过期')
  ok(s.epoch === 2 && /重排/.test(String(s.why)), '过期时把"现在是第几代 + 为什么"一起回', `epoch=${s.epoch} why=${s.why}`)
  ok(L.staleOf('没有这个任务', 1).stale === true, '任务都不在了 ⇒ 也算过期')
  ok(L.staleOf(t.taskId, null).stale === true, '手里没有代次（null）⇒ 宁可算过期')
  ok(L.epochOf('没有这个任务') === null, 'epochOf 对不存在的任务回 null')
  ok(L.staleOf(t.taskId, 2).stale === false, '换代之后用新代次对 ⇒ 不过期')
}

section('①c migrateTask：磁盘上的老任务补 epoch')
{
  const old = migrateTask({ taskId: 't-old', status: 'running', steps: [], attempts: {} })
  ok(old.epoch === 1, '老任务读进来补成第 1 代', `epoch=${old.epoch}`)
  const bad = migrateTask({ taskId: 't-bad', epoch: 0 })
  ok(bad.epoch === 1, 'epoch=0 这种坏值也补成 1')
  const bad2 = migrateTask({ taskId: 't-bad2', epoch: 'abc' })
  ok(bad2.epoch === 1, 'epoch 不是数字也补成 1')
  const keep = migrateTask({ taskId: 't-keep', epoch: 7 })
  ok(keep.epoch === 7, '已经有的好值不许覆盖')
  ok(migrateTask(null) === null, 'null 原样回（不炸）')
}

/* ═══════════════ ② 执行器：干活的时候被重排 ⇒ 结果作废 ═══════════════ */
section('② 干到一半被重排步骤表 ⇒ 结果**丢掉**，新表一步都不许标完成')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  let inFlight = false
  let sawPlan = false
  const E = mkExec(L, {
    call: async () => {
      inFlight = true
      /* 模拟"这一步在飞的时候，模型重排了步骤表"（新表里 s1 还在，但含义已经变了） */
      L.setSteps(t.taskId, [{ id: 's1', op: 'mc_dig', args: { name: 'stone', count: 64 } }, { id: 's9', op: 'observe' }])
      sawPlan = true
      return { ok: true, note: '我这一镐挖完了' }      // 一个**看起来成功**的结果
    },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 3 })

  ok(inFlight && sawPlan, '前提：call 真的在飞的时候重排了步骤表')
  ok(r.stale === true, '执行器如实说"这一份过期了"', `stale=${r.stale}`)
  ok(/上一代/.test(r.lines.join('\n')), '过程里说清了是"上一代的结果"')
  ok(/没往台账上写|丢掉/.test(r.lines.join('\n')), '过程里说清了"没记账"')
  ok(/被改过|重排/.test(String(r.reason)), 'reason 里点明"任务被改过"', `reason=${r.reason}`)
  ok(/mc_task/.test(String(r.hint)) && /步骤表/.test(String(r.hint)), 'hint 让模型去看**现在**的步骤表', `hint=${r.hint}`)

  const after = L.get(t.taskId)
  ok(stepOf(L, t.taskId, 's1').status === 'pending', '🔴 新表里 s1 **还是 pending**（没被上一代的"成功"标成完成）', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(stepOf(L, t.taskId, 's9').status === 'pending', '新加进来的 s9 也没被碰')
  ok(Object.keys(after.attempts ?? {}).length === 0, '🔴 一次失败都没往台账上记（`fail()` 没被调）', `attempts=${JSON.stringify(after.attempts)}`)
  ok(after.history.length === 2, '历史里只有"开工"和"重排步骤表"两条', `history=${after.history.map((h) => h.text).join(' | ')}`)
  ok(!after.history.some((h) => /完成/.test(h.text)), '🔴 历史里**没有**假的"步骤 s1 完成"')

  ok(outcomeOf(r) === 'stale', 'outcomeOf 判成 stale（不是 unknown）', `outcome=${outcomeOf(r)}`)
  const vt = verdictText('stale')
  ok(/♻️/.test(vt) && /没往台账上写/.test(vt), 'verdictText 说"没往台账上写"')
  ok(!/服务器可能已经做了/.test(vt), '🔴 stale **不许**套用"服务器可能已经做了"那句话（那会叫模型去复核一个不存在的步骤）')
  ok(/mc_task/.test(vt), 'stale 的文案指向"看现在的步骤表"')
  ok(OUTCOME_LABEL.stale === '这一步作废了', '结局标签是"作废"')
}

section('②b 被取消 ⇒ 同样作废（而且任务状态不许被改成"完成"）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, {
    call: async () => { L.cancel(t.taskId, '用户改主意了'); return { ok: true } },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.stale === true, '取消也算"这一份过期了"')
  ok(L.get(t.taskId).status === 'cancelled', '🔴 任务状态还是 cancelled（没被结果改成 done）', `status=${L.get(t.taskId).status}`)
  ok(stepOf(L, t.taskId, 's1').status !== 'done', '🔴 步骤**没被标成完成**（这一步没记账）', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(/取消/.test(String(r.reason)) || /取消/.test(String(r.hint)), '话里点到了"取消"')
}

/* ═══════════════ ③ 执行器：看现场的时候被重排 ⇒ 立刻停手 ═══════════════ */
section('③ 看现场（observe）的时候被重排 ⇒ 停手，不再按旧计划动手')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: STEPS2 })
  let calls = 0
  const E = mkExec(L, {
    observe: async () => {
      L.setSteps(t.taskId, [{ id: 'z1', op: 'observe' }])   // 就在"看现场"这一下里被改
      return mkState()
    },
    call: async () => { calls++; return { ok: true } },
  })
  const r = await E.run({ taskId: t.taskId, maxRounds: 3 })
  ok(r.stopped === 'epoch', '收场原因就是 epoch（不是 rounds）', `stopped=${r.stopped}`)
  ok(calls === 0, '🔴 一步都没动手（旧计划下不许再动手）', `call 次数=${calls}`)
  ok(/被改过/.test(r.lines.join('\n')), '过程里说清了"被改过"')
  ok(/步骤表/.test(String(r.hint)), 'hint 让模型去看现在的步骤表')
  ok(r.ok === true && r.done === false, '这不是失败（`ok:true` / `done:false`）')
}

/* ═══════════════ ④ 不误伤：正常一轮照旧 ═══════════════ */
section('④ 不误伤：正常跑（没人改计划）一切照旧')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ ok: true, note: '服务端已确认' }) })
  /* `maxRounds: 1` ⇒ 跑完一步就停在"步数用完"，不会走到"步骤都走完 ⇒ 收工"那条路
   *（那条路**会**换代 —— 收工本来就算换代，见 ①）。 */
  const r = await E.run({ taskId: t.taskId, maxRounds: 1 })
  ok(!r.stale, '没过期')
  ok(stepOf(L, t.taskId, 's1').status === 'done', '步骤正常记成完成', `status=${stepOf(L, t.taskId, 's1').status}`)
  ok(L.get(t.taskId).epoch === 1, '正常一轮里代次一次都没变', `epoch=${L.get(t.taskId).epoch}`)
  ok(r.stopped === 'rounds', '收场原因是"步数用完"（不是 epoch）', `stopped=${r.stopped}`)
}

section('④c 不误伤：走到"步骤都走完 ⇒ 收工"那条路（收工**会**换代，但收场是 done）')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ ok: true, note: '服务端已确认' }) })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(r.done === true && !r.stale, '正常收工，没被判成过期', `done=${r.done} stale=${r.stale}`)
  ok(L.get(t.taskId).status === 'done', '任务状态是 done')
  ok(L.get(t.taskId).epoch === 2, '收工那一下把代次推到 2（这正是"换了这一代要干什么"）', `epoch=${L.get(t.taskId).epoch}`)
}

section('④b 不误伤：结果未知（时间到）走原来的路，不会被当成过期')
{
  const L = mkLedger()
  const t = L.start({ kind: 'custom', steps: [{ id: 's1', op: 'observe' }] })
  const E = mkExec(L, { call: async () => ({ mcTimeout: true, note: '时间到' }) })
  const r = await E.run({ taskId: t.taskId, maxRounds: 2 })
  ok(!r.stale, '没过期')
  ok(r.outcome === 'unknown', '还是"结果未知"', `outcome=${r.outcome}`)
  ok(stepOf(L, t.taskId, 's1').status === 'pending', '步骤被收回 pending（等复核）')
  ok(L.get(t.taskId).epoch === 1, '代次没变')
}

/* ═══════════════ ⑤ 静态接线 ═══════════════ */
section('⑤ 静态接线')
{
  const rn = stripComments(runnerSrc)
  const ex = stripComments(execSrc)

  ok(/export const TASK_EPOCH_START = 1/.test(rn), 'task-runner 导出 TASK_EPOCH_START')
  ok(/#bump \(t, why = null\)/.test(rn), '有私有的 #bump')
  ok(/epochOf \(taskId\)/.test(rn), '有 epochOf')
  ok(/staleOf \(taskId, epoch\)/.test(rn), '有 staleOf')
  ok(/epoch: TASK_EPOCH_START, epochWhy: null, epochAt: now/.test(rn), 'start() 里给新任务写了 epoch/epochWhy/epochAt')
  ok(/if \(!Number\.isFinite\(Number\(t\.epoch\)\) \|\| Number\(t\.epoch\) < TASK_EPOCH_START\) t\.epoch = TASK_EPOCH_START/.test(rn), 'migrateTask 给老任务补 epoch')
  ok(/stepLine\(t\), epoch: Number\(t\.epoch\) \|\| TASK_EPOCH_START/.test(rn), 'stepBegin 把代次回给调用方')
  ok(/if \(r\.stale === true\) return 'stale'/.test(rn), 'outcomeOf 认 stale')
  ok(/OUTCOME_LABEL = \{[^}]*stale:/.test(rn), 'OUTCOME_LABEL 里有 stale')

  /* 换代只发生在三处 —— 多一处就要有人解释为什么 */
  const bumps = [...rn.matchAll(/this\.#bump\(/g)].length
  ok(bumps === 3, '🔴 全文件只有 3 处 #bump（重排步骤表 / 取消 / 收工）', `实际 ${bumps} 处`)
  ok(/#bump\(t, '步骤表被重排'\)/.test(rn), 'setSteps 换代')
  ok(/#bump\(t, `任务被取消：\$\{why\}`\)/.test(rn), 'cancel 换代')
  ok(/#bump\(t, ok \? '任务已收工' : '任务已判失败'\)/.test(rn), 'finish 换代')

  ok(/let epoch0 = this\.ledger\.epochOf\(t\.taskId\)/.test(ex), '执行器在开跑时记下代次')
  ok(/const began = this\.ledger\.stepBegin\(t\.taskId, step\.id\)/.test(ex), 'stepBegin 的返回值收下了')
  ok(/if \(began\?\.epoch != null\) epoch0 = began\.epoch/.test(ex), 'stepBegin 回了代次就用它（这一步是哪一代的）')
  const checks = [...ex.matchAll(/this\.ledger\.staleOf\(t\.taskId, epoch0\)/g)].length
  ok(checks === 2, '🔴 两处 await 之后各对一次代次（看现场 / 干活）', `实际 ${checks} 处`)
  ok(/const staleLook = this\.ledger\.staleOf/.test(ex), '看现场之后那次检查在')
  ok(/const staleNow = this\.ledger\.staleOf/.test(ex), '干活之后那次检查在')
  /* 顺序：看现场那次必须在 `state.online` 之前，干活那次必须在写账（stepDone/stepFail）之前 */
  ok(ex.indexOf('staleLook') < ex.indexOf('if (!state.online)'), '看现场那次检查排在"在线判断"之前')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.stepDone'), '🔴 干活那次检查排在**任何写账之前**')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.stepReset'), '也排在 stepReset 之前')
  ok(ex.indexOf('staleNow') < ex.indexOf('this.ledger.fail'), '也排在 fail 之前')
  ok(/stoppedWhy = 'epoch'/.test(ex), '停手时记的是 epoch 原因')
  ok(/stale: true, rounds, task: brief\(\), lines/.test(ex), '返回值里带 stale:true')
}

console.log(`\n${pass} ✅ / ${fail} ❌`)
process.exit(fail ? 1 : 0)
