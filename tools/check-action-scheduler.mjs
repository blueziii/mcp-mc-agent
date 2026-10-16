/**
 * 动作调度器自检（`src/action-scheduler.mjs`）
 *
 * 为什么补这一套：`src/action-scheduler.mjs` 是 2026-10-14 用户设计的「统一动作调度」落地，
 * 2026-10-15 全项目审计时发现它**已接线全部工具、却一条测试都没有** —— 一旦有人动
 * `run()` / `#release()` 的生命周期，撞车和父子继承会静默走样，而 `enforce` 模式下
 * 走样的后果是"重连之后什么都动不了"。
 *
 * 这一套**不依赖 mineflayer**（调度器本来就不碰 bot），所以跑得飞快、也不会被 vendor 目录影响。
 *
 *   cd <profile>/node_modules/mcp-mc-agent
 *   node tools/check-action-scheduler.mjs
 */
import { readFileSync } from 'node:fs'

const {
  ActionScheduler, PRIORITY, MODES, DEFAULT_MODE, CANCEL_POINTS, HISTORY_KEEP,
  TOOL_SPEC, normalizeResources, priorityOf, priorityText, resourceSpecOf, modeFromEnv, actionSchedulerOf,
} = await import(new URL('../src/action-scheduler.mjs', import.meta.url))

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')

/* 假的时钟 + 假日志，让断言不依赖真实时间 */
const mk = (opts = {}) => {
  let t = 1000
  const logs = []
  const s = new ActionScheduler({ now: () => t, log: (m) => logs.push(String(m)), ...opts })
  return { s, logs, tick: (ms) => { t += ms }, at: () => t }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ═══════════════ ① 纯函数 ═══════════════ */
section('① 纯函数：资源归一 / 优先级 / 工具 → 资源')
ok(JSON.stringify(normalizeResources(['b', 'a', 'a', ' ', null])) === '["a","b"]', 'normalizeResources 去空去重排序')
ok(JSON.stringify(normalizeResources(null)) === '[]' && JSON.stringify(normalizeResources('movement')) === '["movement"]', 'normalizeResources 认单值 / null')
ok(priorityOf(60) === 60 && priorityOf('user') === 60 && priorityOf('emergency') === 100, 'priorityOf 认数字也认名字')
ok(priorityOf('') === PRIORITY.task && priorityOf(undefined) === PRIORITY.task && priorityOf('nonsense') === PRIORITY.task,
  'priorityOf 空值/垃圾值回 task（🔴 `Number("")` 是 0，不是 NaN —— 这里必须显式拦住）')
ok(priorityOf('10') === 10, 'priorityOf 认数字字符串')
ok(priorityText(60) === '用户' && priorityText(999) === '999', 'priorityText 认得的给中文、认不得的原样')
ok(JSON.stringify(MODES) === '["observe-only","enforce"]' && DEFAULT_MODE === 'observe-only', 'MODES / DEFAULT_MODE')
ok(JSON.stringify(CANCEL_POINTS) === '["safe","cleanup","unknown"]' && HISTORY_KEEP === 30, 'CANCEL_POINTS / HISTORY_KEEP')
ok(PRIORITY.background < PRIORITY.task && PRIORITY.task < PRIORITY.user && PRIORITY.user < PRIORITY.emergency,
  'PRIORITY 四级顺序：后台 < 任务 < 用户 < 紧急')

ok(resourceSpecOf('mc_status') === null && resourceSpecOf('mc_scan') === null && resourceSpecOf('nope') === null,
  '只读工具 / 不认识的工具 ⇒ null（根本不进调度器，读坐标不该阻塞寻路）')
ok(JSON.stringify(resourceSpecOf('mc_move')?.resources) === '["movement"]', 'mc_move ⇒ movement')
ok(JSON.stringify(resourceSpecOf('mc_dig')?.resources) === '["interaction","movement"]', 'mc_dig ⇒ movement + interaction')
ok(resourceSpecOf('mc_act', { mode: 'look' }) === null, 'mc_act {mode:"look"} 不占资源 ⇒ null')
ok(JSON.stringify(resourceSpecOf('mc_act', { mode: 'place' })?.resources) === '["interaction","movement"]', 'mc_act {mode:"place"}')
ok(JSON.stringify(resourceSpecOf('mc_act', { mode: 'attack' })?.resources) === '["combat","movement"]', 'mc_act {mode:"attack"}')
ok(resourceSpecOf('mc_act', { mode: '不存在的模式' }) === null, 'mc_act 认不出的 mode ⇒ 不占资源')
ok(resourceSpecOf('mc_act') === null, 'mc_act 不给 mode 时按默认 "look" ⇒ 不占资源（"看一眼"不该阻塞寻路）')
ok(resourceSpecOf('mc_task', { action: 'list' }) === null && resourceSpecOf('mc_task') === null, 'mc_task 记账动作不占资源')
ok(JSON.stringify(resourceSpecOf('mc_task', { action: 'run' })?.resources) === '["combat","interaction","inventory","movement"]',
  'mc_task {action:"run"} 四种资源全占（它内部什么都能干）')
ok(Object.values(TOOL_SPEC).every((v) => v.priority == null),
  '🔴 TOOL_SPEC 里没有任何条目声明 priority ⇒ resourceSpecOf 不该凭空造这个字段（审计 F9）')
ok(!('priority' in (resourceSpecOf('mc_dig') ?? {})), 'resourceSpecOf 没声明就不带 priority 字段')
ok(!('priority' in (resourceSpecOf('mc_move') ?? {})), '（同上，换个工具再确认一次）')

/* ═══════════════ ② 基本登记 / 释放 ═══════════════ */
section('② 基本登记与释放')
{
  const { s, tick, at } = mk()
  let ran = false
  const r = await s.run({
    name: 'mc_dig', resources: ['movement', 'interaction'], priority: PRIORITY.user,
    execute: async ({ actionId }) => { ran = true; tick(500); return { actionId, dug: 3 } },
  })
  ok(ran && r.status === 'completed' && r.result?.dug === 3, 'run 真的执行了 execute 并把结果带回来')
  ok(r.actionId === 'a1' && r.priority === PRIORITY.user, 'actionId 从 a1 开始、优先级原样带回')
  ok(s.list().length === 0, '动作结束后从活跃表里消失（资源已释放）')
  ok(s.history.length === 1 && s.history[0].ms === 500 && s.history[0].status === 'completed',
    'history 记了耗时与结局（假时钟 500ms）')
  ok(at() === 1500, '（时钟确认：确实推进了 500）')
}
{
  const { s } = mk()
  const r = await s.run({ name: 'boom', resources: ['movement'], execute: async () => { throw new Error('炸了') } })
  ok(r.status === 'failed' && r.error?.message === '炸了', 'execute 抛错 ⇒ status:"failed" + 原错误带回')
  ok(s.list().length === 0, '抛错路径也要释放资源（finally）')
}
{
  const { s } = mk()
  const r = await s.run({ name: 'nores', resources: [], execute: async () => 'ok' })
  ok(r.status === 'completed' && r.actionId === 'a1', '不占资源的动作照样能跑（只是没得记）')
  ok(s.list().length === 0, '跑完不留在表里')
}

/* ═══════════════ ③ 父子：同一个 actionId、只释放自己新占的 ═══════════════ */
section('③ 父子动作（mc_dig 内部 walkTo 这种子步骤）')
{
  const { s } = mk()
  const seen = {}
  const parent = await s.run({
    name: 'mc_dig', resources: ['movement', 'interaction'], priority: PRIORITY.user,
    execute: async ({ actionId }) => {
      seen.parentId = actionId
      const before = s.list()
      /* 子步骤：只要 movement（父已经占了）—— 应该不重复登记 */
      const child = await s.run({
        name: 'mc_move', resources: ['movement'], parent: actionId,
        execute: async ({ actionId: childId }) => { seen.childId = childId; seen.during = s.list(); return 'walked' },
      })
      seen.child = child
      seen.afterChild = s.list()
      seen.before = before
      return 'dug'
    },
  })
  ok(seen.childId === seen.parentId, '🔴 子步骤复用父动作的 actionId（不新开一条）')
  ok(seen.child.actionId === parent.actionId, '子步骤的返回值里也是父的 actionId')
  ok(seen.during.length === 1, '父 + 子同时在跑，活跃表里只有一条记录')
  ok(seen.during[0].frames === 2, 'frames 记到 2（父一帧 + 子一帧）')
  ok(JSON.stringify(seen.afterChild[0].resources) === '["interaction","movement"]',
    '🔴 子步骤退出后父的 movement 还在（子只释放自己"新占"的，而它一个新资源都没占）')
  ok(s.list().length === 0 && s.history.length === 2, '父退出后记录消失；history 里父子各一条')
  ok(s.history.every((h) => h.actionId === 'a1'), 'history 两条都是同一个 actionId')
}
{
  /* 子步骤"新占"了父没有的资源：退出时应该只放掉那一个 */
  const { s } = mk()
  await s.run({
    name: 'mc_task', resources: ['movement'], priority: PRIORITY.task,
    execute: async ({ actionId }) => {
      await s.run({ name: 'mc_chest', resources: ['movement', 'inventory'], parent: actionId, execute: async () => { /* 子步骤 */ } })
      const rec = s.list()[0]
      ok(JSON.stringify(rec.resources) === '["movement"]',
        '子步骤新占的 inventory 被放掉了、父的 movement 留着', JSON.stringify(rec.resources))
      return 1
    },
  })
}
{
  /* parent 指向一个不存在的 actionId ⇒ 当成顶层动作处理（不能炸） */
  const { s } = mk()
  const r = await s.run({ name: 'x', resources: ['movement'], parent: 'a999', execute: async () => 'ok' })
  ok(r.status === 'completed' && r.actionId === 'a1', 'parent 指不到就自己新建一条（不炸）')
}

/* ═══════════════ ④ 撞车：observe-only 只记 / enforce 挡住 ═══════════════ */
section('④ 资源撞车')
/* 🔴 撞车必须发生在**两个各自独立的顶层动作**之间。
 * 以前这里是"在 a1 的 `execute` 里再开一个"，而 P1 给调度器加了 ALS 之后，
 * 那种嵌套会被自动认成**子步骤**（正是为了不自己锁死自己）⇒ 压根不构成撞车。
 * 所以现在改成：先起一个占着不放的顶层动作，再从外面打第二个。
 * `heldBy()` 让占位的那位**被 abort 就叫醒**，不然"抢占"那几条会挂在 gate 上。 */
const heldBy = (s, { name, resources, priority, extra = {} }) => {
  let release
  const gate = new Promise((r) => { release = r })
  const p = s.run({
    name,
    resources,
    priority,
    ...extra,
    execute: async ({ signal }) => {
      await Promise.race([gate, new Promise((r) => { signal?.addEventListener?.('abort', r, { once: true }) })])
      return 'held'
    },
  })
  return { p, release }
}
{
  const { s, logs } = mk()
  let secondRan = false
  const h = heldBy(s, { name: 'mc_dig', resources: ['movement', 'interaction'], priority: PRIORITY.task })
  const r2 = await s.run({
    name: 'mc_move', resources: ['movement'], priority: PRIORITY.user,
    execute: async () => { secondRan = true; return 'moved' },
  })
  ok(r2.status === 'completed' && secondRan, '🔴 observe-only：撞车**不拦**，第二个照旧执行')
  ok(r2.conflicts.length === 1 && r2.conflicts[0].name === 'mc_dig', '返回值里如实带 conflicts')
  ok(r2.outranked === 0, '用户指令撞任务：outranked = 0（没有比我优先级高的在占）')
  h.release()
  await h.p
  ok(s.conflicts === 1 && s.blocked === 0, '计数：撞车 1 次、挡住 0 次')
  ok(logs.some((l) => /撞车（observe-only，不拦）/.test(l)), '日志里记了一笔"撞车（observe-only，不拦）"')
}
{
  /* enforce + 不等（`waitMs: 0`）⇒ 立刻回 busy（P0 的老行为，一条都没丢） */
  const { s } = mk({ mode: 'enforce' })
  let blockedRan = false
  const h = heldBy(s, { name: 'mc_dig', resources: ['movement'], priority: PRIORITY.task })
  const r2 = await s.run({
    name: 'mc_move', resources: ['movement'], priority: PRIORITY.task, waitMs: 0,
    execute: async () => { blockedRan = true },
  })
  ok(r2.status === 'busy' && r2.actionId === null, '🔴 enforce + 不等：撞车 ⇒ status:"busy"、actionId 为 null')
  ok(!blockedRan, 'enforce 下被挡的动作**根本没执行**')
  ok(r2.blockedBy.length === 1 && /a1 mc_dig/.test(r2.blockedBy[0]), 'blockedBy 说清是谁挡的')
  ok(/再叫一次/.test(r2.note ?? ''), 'note 告诉调用方怎么办')
  /* 不冲突的资源照常放行 */
  const r3 = await s.run({ name: 'mc_chest', resources: ['inventory'], priority: PRIORITY.user, execute: async () => 'ok' })
  ok(r3.status === 'completed', 'enforce 只挡冲突的那部分，别的资源照常')
  h.release()
  await h.p
  ok(s.blocked === 1 && s.conflicts === 1, '计数：挡住 1 次')
}
{
  /* 低优先级撞高优先级 ⇒ outranked 记下来，而且**抢不动**（排队等到超时） */
  const { s } = mk({ mode: 'enforce' })
  const h = heldBy(s, { name: 'mc_act', resources: ['combat'], priority: PRIORITY.emergency })
  const r = await s.run({ name: 'mc_move', resources: ['combat'], priority: PRIORITY.background, waitMs: 30, execute: async () => 1 })
  ok(r.outranked === 1, '🔴 低优先级撞高优先级：outranked = 1（"被压的是不是我"记清楚）')
  ok(r.status === 'busy', '低优先级抢不动高优先级 ⇒ 排队等到超时，回 busy')
  ok(!r.preemptedBy, '没抢：`preemptedBy` 不该出现')
  h.release()
  await h.p
}

/* ═══════════════ ④b P1：排队 + 抢占 + 死锁防线 ═══════════════ */
section('④b P1 排队 / 抢占 / 死锁防线')
{
  /* 排队：等前面那位**真的释放**，然后接着跑 */
  const { s } = mk({ mode: 'enforce' })
  const h = heldBy(s, { name: 'mc_dig', resources: ['movement'], priority: PRIORITY.task })
  const t0 = Date.now()
  setTimeout(() => h.release(), 40)
  const r = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.task, waitMs: 2000, execute: async () => 'moved' })
  const dt = Date.now() - t0
  ok(r.status === 'completed' && r.result === 'moved', '🔴 P1 排队：等前面那位释放之后接着跑（不再直接回 busy）')
  ok(dt >= 30, `真的等了（${dt}ms）`)
  ok(s.waited === 1 && s.blocked === 0, '计数：排过 1 次队、没被挡住')
  await h.p
}
{
  /* 抢占：我比它高 ⇒ 叫停它；**但照样要排队等它释放**（abort 是异步的） */
  const { s, logs } = mk({ mode: 'enforce' })
  let sawAbort = false
  const h = s.run({
    name: 'mc_auto',
    resources: ['movement'],
    priority: PRIORITY.background,
    execute: async ({ signal }) => {
      await new Promise((resolve) => {
        if (signal?.aborted) { sawAbort = true; return resolve() }
        signal?.addEventListener('abort', () => { sawAbort = true; resolve() }, { once: true })
        setTimeout(resolve, 2000)   /* 兜底：万一没被叫停也别把测试挂住 */
      })
      return 'stopped'
    },
  })
  const r = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, waitMs: 2000, execute: async () => 'moved' })
  ok(sawAbort, '🔴 P1 抢占：低优先级的动作收到了 abort（`#preempt()` 真的叫停了它）')
  ok(s.preemptions === 1 && r.preemptedBy?.length === 1, '计数：抢过 1 次，返回里说是叫停了谁')
  ok(r.status === 'completed' && r.result === 'moved', '抢完等它释放，然后自己接着跑')
  ok(logs.some((l) => /抢占：/.test(l)), '日志里记了一笔抢占')
  await h
}
{
  /* 说了 `preemptible: false` ⇒ 不抢 */
  const { s } = mk({ mode: 'enforce' })
  const h = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { preemptible: false } })
  const r = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, waitMs: 20, execute: async () => 'moved' })
  ok(r.status === 'busy' && !r.preemptedBy, '🔴 说了 `preemptible:false` 就不抢（排队等到超时）')
  ok(s.preemptions === 0, '抢占计数还是 0')
  h.release()
  await h.p
}
{
  /* 取消边界：`cleanup` / `unknown` 不抢（人家正在等服务器回执）；`safe` 才抢 */
  const { s } = mk({ mode: 'enforce' })
  const h1 = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { cancelPoint: () => 'cleanup' } })
  const r1 = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, waitMs: 20, execute: async () => 'moved' })
  ok(r1.status === 'busy' && !r1.preemptedBy, '🔴 取消边界在 `cleanup` ⇒ 不抢')
  h1.release()
  await h1.p

  const h2 = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { cancelPoint: () => 'unknown' } })
  const r2 = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, waitMs: 20, execute: async () => 'moved' })
  ok(r2.status === 'busy' && !r2.preemptedBy, '取消边界 `unknown` ⇒ 也不抢')
  h2.release()
  await h2.p

  const h3 = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { cancelPoint: () => 'safe' } })
  const r3 = await s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, waitMs: 2000, execute: async () => 'moved' })
  ok(r3.status === 'completed' && r3.preemptedBy?.length === 1, '取消边界是 `safe` ⇒ 抢')
  h3.release()
  await h3.p
}
{
  /* 🔴 死锁防线：子步骤**忘了传 `parent`** 也不会把自己锁死 */
  const { s } = mk({ mode: 'enforce' })
  const r = await s.run({
    name: 'mc_task',
    resources: ['movement', 'interaction', 'inventory', 'combat'],
    priority: PRIORITY.user,
    execute: async () => {
      /* 这就是用户点名的"`mc_dig` 持 `movement` 后内部再申请同一个资源"。
       * 没有 ALS 的话，它会看见"资源被我父亲占着"⇒ 一直等到超时，而父亲正等它返回。 */
      const inner = await s.run({ name: 'mc_dig', resources: ['movement', 'interaction'], priority: PRIORITY.task, waitMs: 3000, execute: async () => 'dug' })
      return inner.status === 'completed' && inner.conflicts.length === 0 && inner.actionId === 'a1' ? 'ok' : `inner=${inner.status}/${inner.conflicts.length}/${inner.actionId}`
    },
  })
  ok(r.status === 'completed' && r.result === 'ok', '🔴 死锁防线：子步骤忘了传 `parent`，ALS 也会把它认出来（不会等到超时）')
  ok(s.seq === 1, 'ALS 认出来的子步骤**不新开** actionId')
  ok(s.waited === 0, '压根没排队（它没把自己当成撞车）')
}
{
  /* 断线：`releaseAll()` 必须叫醒排队的人，否则它们干等到超时 */
  const { s } = mk({ mode: 'enforce' })
  const h = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { preemptible: false } })
  const t0 = Date.now()
  const p = s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.task, waitMs: 5000, execute: async () => 'moved' })
  await sleep(15)
  s.releaseAll('断线')
  const r = await p
  ok(r.status === 'completed' && Date.now() - t0 < 2000, '🔴 断线时 `releaseAll()` 会叫醒排队的人（否则它们干等到超时）')
  h.release()
  await h.p
}
{
  /* 账目：`snapshot()` / `describe()` 要能看见排队与抢占。
   * 占位那位**说了不能被抢**，否则同级不同级都轮不到"排队"这条路（会被抢走）。 */
  const { s } = mk({ mode: 'enforce' })
  const h = heldBy(s, { name: 'mc_auto', resources: ['movement'], priority: PRIORITY.background, extra: { preemptible: false } })
  const p = s.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.task, waitMs: 3000, execute: async () => 'moved' })
  await sleep(10)
  const snap = s.snapshot()
  ok(snap.waited === 1 && snap.waiting === 1, 'snapshot() 里看得见"排过队 / 还在等"')
  ok(/还在等/.test(s.describe()), 'describe() 报"几个还在等"')
  h.release()
  await p
  ok(s.waitMs >= 0 && s.preemptions === 0, '排队总时长记下来了、抢占计数没乱加')
}
{
  /* 显式给了一个找不到的父 id ⇒ 如实说，不再静默新建 */
  const { s, logs } = mk()
  const r = await s.run({ name: 'x', resources: ['movement'], parent: 'a999', execute: async () => 'ok' })
  ok(r.status === 'completed' && r.actionId === 'a1', 'parent 指不到就自己新建一条（不炸）')
  ok(r.parentLost === true, '🔴 但要说清"你给的父动作我没找到"（以前是静默新建）')
  ok(logs.some((l) => /活跃表里没有它/.test(l)), '日志里也记一笔')
}
{
  /* 父子之间不算撞车 */
  const { s } = mk()
  await s.run({
    name: 'mc_dig', resources: ['movement'], execute: async ({ actionId }) => {
      const r = await s.run({ name: 'mc_move', resources: ['movement'], parent: actionId, execute: async () => 1 })
      ok(r.conflicts.length === 0, '🔴 子步骤要父动作已经在占的资源，不算撞车（否则自己锁死自己）')
      return 1
    },
  })
}

/* ═══════════════ ⑤ 中断 / 取消边界 ═══════════════ */
section('⑤ 中断与安全取消边界')
{
  const { s } = mk()
  const ac = new AbortController()
  ac.abort()
  let ran = false
  const r = await s.run({ name: 'mc_move', resources: ['movement'], signal: ac.signal, execute: async () => { ran = true } })
  ok(r.status === 'preempted' && !ran, '🔴 还没开始就被中断 ⇒ status:"preempted"，execute 不跑')
  ok(s.list().length === 0, '中断路径也把资源释放干净（没有"占着不放"的幽灵）')
}
{
  const { s } = mk()
  const ac2 = new AbortController()
  const p = s.run({
    name: 'mc_move', resources: ['movement'], signal: ac2.signal,
    execute: async ({ signal }) => { await sleep(30); return signal?.aborted ? 'aborted' : 'done' },
  })
  setTimeout(() => ac2.abort(), 5)
  const r2 = await p
  ok(r2.status === 'preempted', '🔴 执行中途被中断 ⇒ status:"preempted"（不是 completed）')
  ok(r2.result === undefined, '被抢占的结果不带 result（不能假装成功）')
  ok(s.list().length === 0, '中途中断也释放资源')
}
{
  const { s } = mk()
  let during = null
  await s.run({
    name: 'mc_chest', resources: ['inventory'], cancelPoint: () => 'cleanup',
    execute: async () => { during = s.list()[0]; return 1 },
  })
  ok(during?.cancelPoint === 'cleanup', 'cancelPoint 如实报进 list()')
  ok(during?.preemptible === true, '默认 preemptible = true')
}
{
  const { s } = mk()
  let during = null
  await s.run({
    name: 'x', resources: ['inventory'], cancelPoint: () => { throw new Error('坏了') },
    execute: async () => { during = s.list()[0]; return 1 },
  })
  ok(during?.cancelPoint === 'unknown', 'cancelPoint 自己抛错 ⇒ 当成 unknown（不确定就别假装确定）')
}
{
  const { s } = mk()
  let during = null
  await s.run({
    name: 'x', resources: ['inventory'], cancelPoint: () => '不是这三个之一', preemptible: false,
    execute: async () => { during = s.list()[0]; return 1 },
  })
  ok(during?.cancelPoint === null, 'cancelPoint 认不出的值 ⇒ null')
  ok(during?.preemptible === false, 'preemptible:false 如实报进 list()')
}

/* ═══════════════ ⑥ 模式 / 清理 / 视图 ═══════════════ */
section('⑥ 模式切换、清理与视图')
{
  const { s, logs } = mk()
  ok(s.mode === DEFAULT_MODE, `不传 mode 时跟环境变量走，默认 ${DEFAULT_MODE}`)
  ok(s.setMode('enforce') === 'enforce' && s.mode === 'enforce', 'setMode 切到 enforce')
  ok(logs.some((l) => /模式切到 enforce/.test(l)), '切模式记了日志')
  let threw = false
  try { s.setMode('乱写') } catch { threw = true }
  ok(threw, 'setMode 非法值直接抛（不静默忽略）')
  ok(s.mode === 'enforce', '抛错之后模式没被改坏')
}
{
  const { s } = mk()
  let release = null
  await s.run({
    name: 'long', resources: ['movement'],
    execute: async () => { release = () => s.releaseAll('断线了'); return 1 },
  })
  /* 上面 execute 已结束，改成"在跑的时候清" —— 用一个不 await 的动作 */
  const { s: s2 } = mk()
  const p = s2.run({ name: 'long', resources: ['movement'], execute: () => sleep(30) })
  await sleep(5)
  ok(s2.list().length === 1, '（准备：动作正在跑，表里有 1 条）')
  const n = s2.releaseAll('断线了')
  ok(n === 1 && s2.list().length === 0, '🔴 releaseAll 断线时清空（不清的话重连后什么都动不了）')
  ok(s2.releaseAll() === 0, '表本来就空时 releaseAll 回 0、不报错')
  await p
  ok(s2.list().length === 0, '被清掉的动作结束后不会再冒出来')
}
{
  const { s } = mk({ keep: 3 })
  for (let i = 0; i < 5; i++) await s.run({ name: `a${i}`, resources: ['movement'], execute: async () => i })
  ok(s.history.length === 3 && s.history[2].name === 'a4', 'history 按 keep 截断，留最新的')
}
{
  const { s } = mk()
  await s.run({ name: 'mc_dig', resources: ['movement', 'interaction'], priority: PRIORITY.user, owner: 'sess-1', execute: async () => 1 })
  const snap = s.snapshot()
  ok(snap.mode === 'observe-only' && Array.isArray(snap.active) && snap.recent.length === 1,
    'snapshot() 形状：mode / active / conflicts / blocked / recent')
  ok(snap.recent[0].owner === 'sess-1' && snap.recent[0].name === 'mc_dig', 'recent 里有 owner 和 name')
  const { s: s2, logs: l2 } = mk()
  const p = s2.run({ name: 'mc_move', resources: ['movement'], priority: PRIORITY.user, execute: () => sleep(20) })
  await sleep(5)
  ok(/调度器（observe-only）：1 个动作在跑/.test(s2.describe()), 'describe() 报"几个动作在跑"')
  ok(/a1 mc_move 用户 持 movement/.test(s2.describe()), 'describe() 报动作名 / 优先级 / 持了什么')
  await p
  ok(l2.some((x) => /动作 a1 mc_move（用户）持 movement .* completed/.test(x)),
    '🔴 顶层动作结束时记一行"谁占了什么、多久、什么结局"（用户验收标准第 7 条的落点）')
}
{
  /* 子步骤不记结束账（避免噪音） */
  const { s, logs } = mk()
  await s.run({
    name: 'mc_dig', resources: ['movement'],
    execute: async ({ actionId }) => { await s.run({ name: 'mc_move', resources: ['movement'], parent: actionId, execute: async () => 1 }); return 1 },
  })
  const endLines = logs.filter((l) => /^动作 a\d+ /.test(l))
  ok(endLines.length === 1 && /mc_dig/.test(endLines[0]), '子步骤不记结束账（只有顶层那一条）')
}
{
  const { s } = mk()
  const p = s.run({ name: 'x', resources: ['movement'], execute: () => sleep(20) })
  await sleep(5)
  ok(s.release('a1') === true && s.list().length === 0, 'release(actionId) 手动兜底清一条')
  ok(s.release('a1') === false, '重复清回 false、不报错')
  await p
}
{
  /* mode 显式传 null ⇒ 跟着环境变量现读（不是模块加载时读一次） */
  const old = process.env.MCP_MC_AGENT_SCHEDULER
  process.env.MCP_MC_AGENT_SCHEDULER = 'enforce'
  ok(modeFromEnv() === 'enforce', 'modeFromEnv 认 enforce')
  process.env.MCP_MC_AGENT_SCHEDULER = '乱写'
  ok(modeFromEnv() === DEFAULT_MODE, 'modeFromEnv 认不出就回默认')
  delete process.env.MCP_MC_AGENT_SCHEDULER
  ok(modeFromEnv() === DEFAULT_MODE, '没设环境变量时回默认')
  if (old == null) delete process.env.MCP_MC_AGENT_SCHEDULER; else process.env.MCP_MC_AGENT_SCHEDULER = old
}
{
  const fake = { log: () => {}, _actions: null }
  const a = actionSchedulerOf(fake)
  const b = actionSchedulerOf(fake)
  ok(a === b && a instanceof ActionScheduler, 'actionSchedulerOf 懒建并复用同一个实例')
}

/* ═══════════════ ⑦ 静态接线 ═══════════════ */
section('⑦ 静态接线（谁在用它、有没有接对）')
{
  const idx = strip(read('../index.js'))
  const core = strip(read('../src/core.mjs'))
  ok(/import \{ ActionScheduler/.test(strip(read('../src/action-scheduler.mjs'))) === false, '（调度器模块自己不 import 自己）')
  ok(/actionSchedulerOf/.test(core), 'core.mjs 通过 actionSchedulerOf 懒建（薄包装）')
  ok(/actionScheduler \(\) \{ return actionSchedulerOf\(this\) \}/.test(core), 'core.mjs 的 actionScheduler() 是一行薄包装')
  ok(/actionSpecOf/.test(core), 'core.mjs 有 actionSpecOf 薄包装（index.js 靠它判断要不要进调度器）')
  ok(/const runScheduled = /.test(idx), 'index.js 有 runScheduled 这个统一入口')
  ok(/actionScheduler\(\)\.run\(\{/.test(idx), 'runScheduled 走的是 actionScheduler().run()')
  ok(/const spec = sess\.bot\.actionSpecOf\(name, args\)/.test(idx), 'runScheduled 先问 actionSpecOf（认不出就直接跑，不进调度器）')
  ok(/if \(!spec\) return await fn\(args, exec\)/.test(idx), '🔴 只读工具不进调度器（读坐标不该被动作锁挡住）')
  ok(/PRIORITY\.user/.test(idx) && /PRIORITY\.task/.test(idx),
    '🔴 index.js 按"顶层调用 = 用户 / 任务子步骤 = 任务"定优先级（审计 F9 的修法）')
  ok(/perfWrap\(spec\.name/.test(idx), '工具入口包了 perfWrap（性能监测，异步优化方案第 1 步）')
  ok(/MCP_MC_AGENT_SCHEDULER/.test(strip(read('../src/action-scheduler.mjs'))),
    '模式可以用 MCP_MC_AGENT_SCHEDULER 环境变量切')
  const docs = read('../README.md')
  ok(/MCP_MC_AGENT_SCHEDULER/.test(docs), 'README 的配置速查里写了这个环境变量')

  /* ── 阶段 P1：排队 + 抢占（2026-10-15） ── */
  const sch = strip(read('../src/action-scheduler.mjs'))
  ok(/import \{ AsyncLocalStorage \} from 'node:async_hooks'/.test(sch), '🔴 调度器 import 了 node:async_hooks（死锁防线靠它）')
  ok(/const _current = new AsyncLocalStorage\(\)/.test(sch), '🔴 有 `_current` 这个 ALS 实例')
  ok(/_current\.run\(\{ actionId: rec\.actionId/.test(sch), '🔴 `execute` 被包在 `_current.run()` 里（子步骤才认得出父亲）')
  ok(/_current\.getStore\(\)\?\.actionId/.test(sch), '父 id 的来源里包含 ALS 自动认的那个')
  ok(/const parentLost = Boolean\(parent\) && !parentRec/.test(sch), '`parentLost` 只看**显式**传的父 id（ALS 认的不可能找不到）')
  ok(/export const DEFAULT_WAIT_MS/.test(sch) && /export const PREEMPT_BLOCKED_POINTS/.test(sch),
    '`DEFAULT_WAIT_MS` / `PREEMPT_BLOCKED_POINTS` 都是导出的常量（能被测试与文档引用）')
  ok(/waitMs = null/.test(sch) && /const waitBudget = waitMs == null \? DEFAULT_WAIT_MS/.test(sch),
    '`run()` 认 `waitMs`，默认走 `DEFAULT_WAIT_MS`')
  ok(/#canPreempt \(rec\)/.test(sch) && /#preempt \(blockers, nm, prio\)/.test(sch) && /#awaitFree \(res, except, ms, signal\)/.test(sch) && /#wakeWaiters \(\)/.test(sch),
    '四个私有方法都在：`#canPreempt` / `#preempt` / `#awaitFree` / `#wakeWaiters`')
  ok(/blockers\.every\(\(b\) => b\.c\.priority < prio\)/.test(sch),
    '🔴 抢占要求**严格**高于（同级不抢 —— 否则同优先级的动作互相叫停）')
  ok(/!PREEMPT_BLOCKED_POINTS\.includes/.test(sch), '取消边界在 `cleanup` / `unknown` 时不抢')
  ok(/#release \(rec, added\) \{[\s\S]{0,400}?#wakeWaiters\(\)/.test(sch), '🔴 `#release()` 里叫醒排队的人')
  ok(/releaseAll \(why = ''\) \{[\s\S]{0,600}?#wakeWaiters\(\)/.test(sch), '🔴 `releaseAll()`（断线）也叫醒排队的人')
  ok(/rec\.controller = controller/.test(sch) && /b\.rec\.controller\?\.abort\(\)/.test(sch), '抢占的把手就是 `rec.controller.abort()`')
  ok(/let controller = parentRec\?\.controller \?\? null/.test(sch), '🔴 子步骤**共用父动作的 controller**（抢父 = 抢整棵子树）')
  ok(/waited: this\.waited/.test(sch) && /preemptions: this\.preemptions/.test(sch) && /waiting: this\._waiters\.length/.test(sch),
    '`snapshot()` 里报了排队与抢占的账')
  ok(/import \{ PRIORITY, DEFAULT_WAIT_MS \} from '\.\/src\/action-scheduler\.mjs'/.test(idx), 'index.js 引了 `DEFAULT_WAIT_MS`')
  ok(/const waitMs = parent\s*\?\s*0\s*:/.test(idx),
    '🔴 子步骤一律 `waitMs: 0`（不排队）—— 这是"等自己"那道死锁的结构性防线')
  ok(/Math\.min\(DEFAULT_WAIT_MS, Number\(sess\.bot\.msLeft\?\.\(\) \?\? DEFAULT_WAIT_MS\) - 800\)/.test(idx),
    '顶层动作的排队预算夹在"本轮剩余 − 800ms"以内（不能等穿调用预算）')
  ok(/waitMs,\n?\s*signal: exec\?\.signal/.test(idx) || /waitMs,/.test(idx), '`waitMs` 真的传给了 `run()`')
  ok(/if \(schedSignal\) sess\.bot\.setAbortSignal\(schedSignal\)/.test(idx),
    '🔴 调度器的信号接进了 `bot.setAbortSignal()` —— 不接的话 `#preempt()` 的 abort 谁也看不见')
  ok(/execute: async \(\{ actionId, signal: schedSignal \}\)/.test(idx), '`execute` 从调度器手里拿信号')
  ok(/waitedMs: r\.waitedMs \?\? 0/.test(idx), '`busy` 的返回值里带上"我等了多久"')
  ok(/排队/.test(docs) || /排队/.test(read('../CHANGELOG.md')), '文档里讲了排队这件事')
}

console.log(`\n${'─'.repeat(50)}`)
console.log(`check-action-scheduler：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
