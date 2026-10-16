/**
 * 统一动作调度器 —— **阶段 P0：只记账，不拦人**（2026-10-14，用户设计「统一动作调度」）
 * * 用户给的分层是：`mc_auto`（何时唤醒 / 有没有危险）／任务台账（目标与步骤）／**调度器（谁有权动）**／
 * `core.mjs` + 工具（真的动手）。这一层只做四件事：
 *
 *   ① 给每个**写**动作一个统一编号（`actionId`）与统一返回格式；
 *   ② 登记它占了哪些**资源**（`movement` / `controls` / `interaction` / `inventory` / `combat`）；
 *   ③ 资源撞车时**记一笔**（`observe-only`）或**挡住**（`enforce`）；
 *   ④ 父子动作复用同一个 `actionId`，子步骤不重复登记父动作已经持有的资源。
 *
 * ─────────────────────────── 阶段 P0 的硬约束 ───────────────────────────
 * 🔴 用户原话：**资源登记不等于立即加锁**。所以这一阶段：
 *   · 默认模式 `observe-only`：冲突**只记日志 + 记在返回值里**，动作照旧执行；
 *   · **不许碰** `interruptMove()` / `_moveGen` / `_ctrlLease` —— 抢占仍然只有 `interruptMove` 一条路，
 *     这一层不自己造第二套"移动代次"（用户点名的第 4 条）；
 *   · 只读工具（`mc_observe` / `mc_status` / `mc_inventory` / `mc_scan` / `mc_map` …）**根本不进来**
 *     （`resourceSpecOf()` 认不出就不包）—— 读坐标不该阻塞寻路。
 *
 * ─────────────────────────── 为什么要有它 ───────────────────────────
 * 现在真有的资源冲突，靠各模块自己的局部守卫顶着，而且**只管自己**：
 * `mc_craft` 有 `craftBusy` WeakMap，但 `mc_craft` / `mc_furnace` / `mc_chest` 是三个模块，
 * 而 `bot.currentWindow` 只有一个槽 —— 谁先开窗谁赢，另外两个的 `windowOpen` 会挂死。
 * 这是"interaction / inventory 必须协调"最实的一个理由。
 *
 * ⚠️ 本模块 import 了 `node:async_hooks`（只为一个 `AsyncLocalStorage`，见文件末尾的 `_current`）。
 *
 * ─────────────────────────── 资源的生命周期（用户点名的坑）───────────────────────────
 * 父动作（`mc_dig`）持 `movement + interaction` 覆盖整个采集流程；它内部走近 / 挖掘是**子步骤**，
 * 用同一个 `actionId`、**不重复登记**已经持有的资源。所以：
 *   · `run()` 记的是"这一帧（frame）**新占**了哪些资源"（`added`），退出时**只释放自己新占的**；
 *   · 动作记录按 `actionId` 复用，`frames` 计数归零才从活跃表里删掉 —— 子步骤先退出不会把父动作的资源放掉。
 *
 * ⚠️ 阶段 P0 **不接** `controls`（那是反射层 `holdControl()` 的按键租约，它不走工具层，暂时没人登记）
 *    和 `observe`（只读不申请）。资源名先列全，等 P1 再逐个接。
 *
 * ─────────────────────────── 阶段 P1：排队 + 抢占（2026-10-15）───────────────────────────
 * P0 的 `enforce` 是"撞车立刻回 `busy`"。P1 把它拆成三步，**顺序不能颠倒**：
 *
 *   ① **够不够格抢**：我严格比它高，它说自己能被抢，它现在不在 `cleanup` / `unknown` 边界上
 *      ⇒ 给它的 `AbortController` 发 abort（**只是"叫停"，不是"已经停了"**）；
 *   ② **排队等它真的放**：abort 是异步的 —— 对方要在自己的 `finally` 里释放资源。
 *      所以抢占之后**照样进队列**，等 `#release()` 把资源让出来（`#wakeWaiters()` 会叫醒）；
 *   ③ **等不到就如实说**：超过 `waitMs` 回 `busy`，并且把"我等过多久、等的是谁"写在返回里。
 *
 * ─────────────────────────── 排队最怕的那件事：等自己（用户点名的死锁）───────────────────────────
 * 用户原话：**"`mc_dig` 持有 `movement` 之后内部再申请同一个资源 —— 加抢占会重新踩上去"**。
 *
 * 今天这条路是靠"**父子复用同一个 `actionId`**"绕开的：`mc_task {action:"run"}` 是个顶层动作，
 * 它调出去的子工具（`mc_dig` / `mc_move` …）从 `exec.__actionId` 拿到父动作 id 传进来，
 * `conflictsOf(res, selfId)` 把父动作自己排除掉 ⇒ 子步骤看到的冲突里**没有自己的父亲**。
 *
 * 但这只在"父 id 传对了"时成立。一旦哪个子步骤把 `parent` 丢了，它会看见"资源被自己的父亲占着"
 * —— P0 里这只会多回一个 `busy`，**P1 里它会一直等到 `waitMs` 超时**（还白占着队列）。
 * 所以 P1 补了两道结构性防线：
 *   · **`parent` 传了但找不到活跃记录 ⇒ 记 `parentLost`**，在返回里明说（以前是静默新建一条记录）；
 *   · **`waitMs` 一定有上限**，且调用方（`index.js` 的 `runScheduled`）对**子步骤一律传 `0`**
 *     —— 子步骤只记账、不排队。子步骤要等的是它自己的父动作，而父动作不会在它退出前释放。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

/** 运行时优先级（**和开发阶段编号 P0–P3 是两套东西**，用户特意提醒过别混用） */
export const PRIORITY = { background: 10, task: 30, user: 60, emergency: 100 }

const PRIORITY_TEXT = { 10: '后台', 30: '任务', 60: '用户', 100: '紧急' }

/** 两种模式：`observe-only` 只记账；`enforce` 撞车就挡住 */
export const MODES = ['observe-only', 'enforce']
export const DEFAULT_MODE = 'observe-only'

/**
 * 动作自己声明的**安全取消边界**（用户第 3 点：不要把"等待中的操作"一律当成不可抢占）。
 *   · `safe`    —— 还没发出交互请求，可以直接取消；
 *   · `cleanup` —— 请求已发出、正在等服务器事件，要先做清理和状态核对；
 *   · `unknown` —— 服务器状态不确定：释放可释放的资源，结果记 `failed` / `unknown`，**不能假装完成**。
 */
export const CANCEL_POINTS = ['safe', 'cleanup', 'unknown']

/** 历史里留多少条（给"从真实运行日志里确认资源模型"用） */
export const HISTORY_KEEP = 30

/**
 * 撞车之后**默认愿意等多久**（阶段 P1，2026-10-15）。
 *
 * `enforce` 模式以前是"撞车立刻回 `busy`，让模型自己过一会儿再叫一次" —— 那等于把
 * "排队"这件事推给了模型，而模型手里**没有时钟**：它要么立刻重试（继续撞），要么干脆放弃。
 * 现在调度器自己排队：等前面那位释放，等到了就接着跑。
 *
 * `0` = 不排队（回到 P0 的行为）。
 */
export const DEFAULT_WAIT_MS = 3_000

/**
 * **什么情况下可以抢**（阶段 P1）。
 *
 * 用户给的判据是"P0 只记，P1 才用"，而抢占的**唯一**依据就是这两个数字加一条边界声明：
 *   · 我的优先级**严格高于**占着的那位（同级不抢 —— 用户第 5 条"低优先级动作不能无条件覆盖高优先级动作"）；
 *   · 那位声明了自己**能被抢**（`preemptible !== false`）；
 *   · 那位现在**不在"别碰我"的边界上** —— `cancelPoint()` 不是 `cleanup` / `unknown`。
 *     没声明（`null`）按"可以抢"算：`preemptible` 默认就是 `true`，不声明等于没意见。
 */
export const PREEMPT_BLOCKED_POINTS = ['cleanup', 'unknown']

/**
 * **"我现在正跑在哪个动作里"** —— `AsyncLocalStorage` 让"父子复用同一个 `actionId`"这件事
 * **不可能因为调用方忘了传 `parent` 而丢掉**。
 *
 * 为什么非要有它（用户点名的死锁）：`mc_dig` 持 `movement`，它内部再要一次 `movement`
 * （`mc_task {action:"run"}` 调子工具就是这条路）。P0 里这靠调用方传 `parent` 绕开；
 * **P1 加了排队之后，"没传 `parent` 的子步骤"会看见"资源被我自己的父亲占着"**，
 * 于是它一直等到 `waitMs` 超时 —— 而它的父亲正等着它返回。**这就是死锁**，
 * 只不过被 `waitMs` 盖成了"超时"。ALS 让它**结构上不可能发生**：
 * 只要这段代码是在某个 `execute` 里跑的，它自动就是那个动作的子步骤。
 */
const _current = new AsyncLocalStorage()

/** 读环境变量拿初始模式（**现读**，不是模块加载时读一次） */
export function modeFromEnv () {
  const v = String(process.env.MCP_MC_AGENT_SCHEDULER ?? '').trim().toLowerCase()
  return MODES.includes(v) ? v : DEFAULT_MODE
}

/** `mc_act` 十几个动作共用一个工具名 ⇒ 按 `mode` 分资源 */
const ACT_MODE_RES = {
  look: [],
  toward: ['movement'],
  place: ['interaction', 'movement'],
  break: ['interaction'],
  use: ['interaction'],
  useitem: ['interaction'],
  attack: ['combat', 'movement'],
  equip: ['inventory'],
  toss: ['inventory'],
  enchant: ['inventory', 'interaction'],
  anvil: ['inventory', 'interaction'],
  smithing: ['inventory', 'interaction']
}

/**
 * 工具 → 资源。**只列写动作**：认不出的工具（含全部只读工具）根本不进调度器。
 *
 * 为什么按**工具**而不是按 `core.mjs` 的方法分：工具层就是"AI / 用户看得见的一个动作"的边界，
 * 正好对应优先级里的"用户指令 / 任务步骤"；`dig()` 内部的 `walkTo()` 是**同一次动作的子步骤**，
 * 不该单独登记（见文件头的生命周期那节）。
 */
export const TOOL_SPEC = {
  mc_move: { resources: ['movement'] },
  mc_dig: { resources: ['movement', 'interaction'] },
  mc_build: { resources: ['movement', 'interaction'] },
  /* 一串步骤什么都能干 ⇒ 四种资源全占（保守但诚实：它在跑的时候别人不该插进来） */
  mc_sequence: { resources: ['movement', 'interaction', 'inventory', 'combat'] },
  mc_craft: { resources: ['inventory', 'interaction'] },
  mc_furnace: { resources: ['inventory', 'interaction'] },
  mc_chest: { resources: ['inventory', 'interaction'] },
  mc_give: { resources: ['inventory'] },
  mc_act: { pick: (args) => ACT_MODE_RES[String(args?.mode ?? 'look').trim().toLowerCase()] ?? [] },
  /* 台账动作（list/get/plan/step/…）是纯记账，不占资源；只有 `run` 真的会动手，
   * 而它内部又是**子步骤**（同一个 actionId），所以这里占的是"任务执行中"这块地。 */
  mc_task: {
    pick: (args) => (String(args?.action ?? 'list').trim().toLowerCase() === 'run'
      ? ['movement', 'interaction', 'inventory', 'combat']
      : [])
  }
}

/** 资源名归一：去空、去重、排序；认不出的名字保留（可能是我漏登记的新资源） */
export function normalizeResources (raw) {
  const list = Array.isArray(raw) ? raw : (raw == null ? [] : [raw])
  const out = new Set()
  for (const r of list) {
    const s = String(r ?? '').trim()
    if (s) out.add(s)
  }
  return [...out].sort()
}

/** 优先级归一：认数字也认名字（`'task'` / `PRIORITY.task`）；认不出回 `task` */
export function priorityOf (v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  const s = String(v ?? '').trim().toLowerCase()
  /* 🔴 空值必须先拦住：`Number('')` 是 **0**，不是 NaN —— 直接往下走会把"没写 priority"
   * 的工具悄悄降成 0（比 `background` 还低），排序全反。冒烟 A7 就是这么抓到的。 */
  if (!s) return PRIORITY.task
  if (PRIORITY[s] != null) return PRIORITY[s]
  const n = Number(s)
  return Number.isFinite(n) ? n : PRIORITY.task
}

export function priorityText (v) {
  const p = priorityOf(v)
  return PRIORITY_TEXT[p] ?? String(p)
}

/**
 * 查一个工具（带它的参数）该登记哪些资源。
 * @returns {{resources: string[], priority: number}|null} `null` = 只读工具 / 不认识的工具 ⇒ 不包
 */
export function resourceSpecOf (name, args = {}) {
  const spec = TOOL_SPEC[String(name ?? '')]
  if (!spec) return null
  const resources = normalizeResources(typeof spec.pick === 'function' ? (spec.pick(args) ?? []) : (spec.resources ?? []))
  /* 一个资源都不占的动作（`mc_act {mode:"look"}`、`mc_task {action:"list"}` 这种纯读/纯记账）
   * 也回 `null` —— 不占资源就没有"谁在占什么"可记，进调度器只会让表变脏。 */
  if (!resources.length) return null
  /* 🔴 审计 F9：`TOOL_SPEC` 里**没有一个**条目写过 `priority` ⇒ 这里以前恒回 `task`(30)，
   *    于是"用户直接下的指令"和"任务执行器推进的子步骤"优先级一模一样，`enforce` 模式下
   *    用户的 `mc_move` 抢不动任务正在跑的 `mc_dig`。现在只有**显式声明**才带这个字段，
   *    没声明的交给调用方按"顶层调用 = 用户 / 子步骤 = 任务"来定（见 `index.js` 的 runScheduled）。 */
  return spec.priority != null
    ? { resources, priority: priorityOf(spec.priority) }
    : { resources }
}

/* 审计 F11：这里原来有个 `labelOf(a)`（`a3 mc_dig 任务 movement,interaction`），
 * 全仓零调用 —— `run()` / `finish()` 的日志早就把同样的字段各自拼好了，删掉免得两套格式漂移。 */

/**
 * 动作调度器。**每个 bot 一个实例**（`McBot.actionScheduler()` 懒建）。
 *
 * ⚠️ 它不碰 `bot`，也不碰 `_moveGen` / `_ctrlLease` —— 只维护一张"谁在占什么"的表。
 */
export class ActionScheduler {
  /**
   * @param {{mode?: string|null, log?: Function, now?: Function, keep?: number}} [opts]
   *   `mode` 传 `null` 表示"跟着环境变量走"（`MCP_MC_AGENT_SCHEDULER`，现读）。
   */
  constructor ({ mode = null, log = () => {}, now = () => Date.now(), keep = HISTORY_KEEP } = {}) {
    this._mode = mode
    this.log = log
    this.now = now
    this.keep = keep
    /** @type {Map<string, object>} actionId → 动作记录（含它当前持有的资源） */
    this.active = new Map()
    this.history = []
    this.seq = 0
    this.conflicts = 0
    this.blocked = 0
    /** 阶段 P1：排队与抢占的账 */
    this.waited = 0
    this.waitMs = 0
    this.preemptions = 0
    /** @type {Array<{res: string[], except: string|null, finish: Function, done: boolean}>} 等资源的人 */
    this._waiters = []
  }

  /** 当前模式（`setMode()` 优先，其次环境变量，最后默认） */
  get mode () { return this._mode ?? modeFromEnv() }

  /** 切模式（`observe-only` / `enforce`）；不合法就抛 */
  setMode (m) {
    const v = String(m ?? '').trim().toLowerCase()
    if (!MODES.includes(v)) throw new Error(`调度器模式只能是 ${MODES.join(' / ')}（给的是 ${JSON.stringify(m)}）`)
    this._mode = v
    this.log(`模式切到 ${v}`)
    return v
  }

  /** 活跃动作列表（快照，改不到内部记录） */
  list () {
    const now = this.now()
    return [...this.active.values()].map((a) => ({
      actionId: a.actionId,
      name: a.name,
      owner: a.owner,
      priority: a.priority,
      priorityText: priorityText(a.priority),
      resources: [...a.resources].sort(),
      parent: a.parent,
      preemptible: a.preemptible !== false,
      cancelPoint: this.#cancelPointOf(a),
      frames: a.frames,
      since: a.since,
      heldMs: Math.max(0, now - a.since)
    }))
  }

  /** 谁在占这个资源 */
  occupants (resource) {
    const r = String(resource ?? '').trim()
    return this.list().filter((a) => a.resources.includes(r))
  }

  /** 给定一组资源，找出**别人**正在占的部分（排除 `except` 这个 actionId，父子继承用） */
  conflictsOf (resources, except = null) {
    const want = normalizeResources(resources)
    const out = []
    for (const a of this.active.values()) {
      if (except && a.actionId === except) continue
      const hit = want.filter((r) => a.resources.has(r))
      if (hit.length) out.push({ actionId: a.actionId, name: a.name, owner: a.owner, priority: a.priority, resources: hit })
    }
    return out
  }

  /** 给 `mc_diag` / 日志看的一眼视图 */
  snapshot () {
    return {
      mode: this.mode,
      active: this.list(),
      conflicts: this.conflicts,
      blocked: this.blocked,
      waited: this.waited,
      waitMs: this.waitMs,
      waiting: this._waiters.length,
      preemptions: this.preemptions,
      recent: this.history.slice(-8)
    }
  }

  /** 多行文本（`mc_diag` / 日志用） */
  describe () {
    const list = this.list()
    const extra = [
      this.waited ? `排过 ${this.waited} 次队（共 ${this.waitMs}ms）` : null,
      this._waiters.length ? `${this._waiters.length} 个还在等` : null,
      this.preemptions ? `抢过 ${this.preemptions} 次` : null
    ].filter(Boolean).join('｜')
    const head = `调度器（${this.mode}）：${list.length} 个动作在跑，累计撞车 ${this.conflicts} 次${extra ? `｜${extra}` : ''}`
    if (!list.length) return head
    return [head, ...list.map((a) => `  · ${a.actionId} ${a.name} ${a.priorityText} 持 ${a.resources.join(',') || '（无）'} 已 ${(a.heldMs / 1000).toFixed(1)}s${a.cancelPoint ? `（取消边界 ${a.cancelPoint}）` : ''}`)].join('\n')
  }

  /**
   * 跑一个动作。**这是唯一的入口**。
   *
   * @param {object} o
   * @param {string} o.name 动作名（工具名，如 `mc_dig`）
   * @param {string|null} [o.owner] 谁发起的（会话 id / 任务 id）
   * @param {string[]} [o.resources] 要占的资源
   * @param {number|string} [o.priority] 运行时优先级（`PRIORITY.*` 或名字）
   * @param {string|null} [o.parent] 父动作的 `actionId`：子步骤传它 ⇒ **复用同一个 actionId、不重复登记**
   * @param {boolean} [o.preemptible] 能不能被抢（P0 只记，P1 才用）
   * @param {Function|null} [o.cancelPoint] `() => 'safe'|'cleanup'|'unknown'`，动作自己声明安全取消边界
   * @param {number|null} [o.waitMs] 撞车之后愿意等多久（`null` = `DEFAULT_WAIT_MS`；`0` = 不等，回 `busy`）。
   *   **子步骤一律传 `0`** —— 子步骤要等的是它自己的父动作，而父动作不会在它退出前释放（见文件头）。
   * @param {AbortSignal|null} [o.signal] 调用方的中断信号
   * @param {Function} o.execute `async ({actionId, signal, scheduler}) => 结果`
   * @returns {Promise<{status: 'completed'|'failed'|'preempted'|'busy', actionId: string|null, name: string,
   *   resources: string[], priority: number, conflicts: object[], blockedBy: string[], result?: any,
   *   error?: Error, note?: string, waitedMs?: number, preemptedBy?: string[], parentLost?: boolean}>}
   */
  async run ({ name, owner = null, resources = [], priority = PRIORITY.task, parent = null, preemptible = true, cancelPoint = null, waitMs = null, signal = null, execute } = {}) {
    const res = normalizeResources(resources)
    const prio = priorityOf(priority)
    const nm = String(name ?? 'action')
    const waitBudget = waitMs == null ? DEFAULT_WAIT_MS : Math.max(0, Number(waitMs) || 0)

    /* ① 找父动作（父子复用同一个 actionId）。
     * 🔴 父 id 的来源有两个：调用方**显式**传的 `parent`，以及 ALS 里"我现在正跑在谁里面"。
     * 后者是 P1 的死锁防线（见 `_current` 的注释）—— 忘了传 `parent` 也不会把自己锁死。 */
    const autoParent = _current.getStore()?.actionId ?? null
    const parentId = parent ? String(parent) : autoParent
    const parentRec = parentId ? this.active.get(parentId) ?? null : null
    const selfId = parentRec ? parentRec.actionId : null
    /* 🔴 阶段 P1：父 id **显式**传了却找不到活跃记录 —— 以前是**静默**新建一条记录，于是
     * "子步骤丢了父亲"这件事在日志里一点痕迹都没有，只表现为"莫名其妙多占了一份资源"。
     * 现在明说：返回里带 `parentLost`，日志也记一笔。**不抛错**（动作本身还能做，
     * 只是它从"子步骤"退化成了"顶层动作"）。
     * 注意判据只看**显式**传的那个：ALS 自动认的父不可能"找不到"（它就是活跃表里的）。 */
    const parentLost = Boolean(parent) && !parentRec

    /* ② 撞车检查：先**全部**查完再决定（不能抢了一半才发现另一个抢不动 —— 用户第 3 点） */
    let conflicts = this.conflictsOf(res, selfId)
    /* 用户验收标准第 5 条"低优先级动作不能无条件覆盖高优先级动作"的落法：
     * `outranked > 0` ⇒ 撞上的人里**有比我高的** ⇒ 我不但抢不动，还得老实排队。 */
    let outranked = conflicts.filter((c) => c.priority > prio).length
    let preemptedBy = []
    let waitedMs = 0

    if (conflicts.length && this.mode === 'enforce') {
      this.conflicts++
      const blockers = conflicts.map((c) => ({ c, rec: this.active.get(c.actionId) })).filter((b) => b.rec)

      /* ③ 够不够格抢：**我严格比它高 + 它说自己能被抢 + 它不在"别碰我"的边界上**。
       * 🔴 "严格"这两个字是必须的：同级不抢（用户第 5 条）—— 否则两个同优先级的动作
       * 会互相叫停，先来的那个反而被后来的踢掉，行为变成"谁后叫谁赢"。
       * 注意这是"叫停"，不是"已经停了" —— 所以后面照样要排队等它真的释放。 */
      if (!outranked && blockers.length && blockers.every((b) => b.c.priority < prio)) {
        const can = blockers.every((b) => this.#canPreempt(b.rec))
        if (can) preemptedBy = this.#preempt(blockers, nm, prio)
      }

      /* ④ 排队等它真的放（`preemptedBy` 非空时就是在等被我叫停的那些人收尾） */
      if (waitBudget > 0) {
        const t0 = this.now()
        const got = await this.#awaitFree(res, selfId, waitBudget, signal)
        waitedMs = Math.max(0, this.now() - t0)
        if (got) {
          conflicts = this.conflictsOf(res, selfId)
          outranked = conflicts.filter((c) => c.priority > prio).length
        } else {
          this.blocked++
          const blockedBy = conflicts.map((c) => `${c.actionId} ${c.name}（${c.resources.join(',')}）`)
          const who = preemptedBy.length ? `（已经叫停 ${preemptedBy.join(' / ')} 了，但它还没放）` : ''
          this.log(`等不到：${nm}（${priorityText(prio)}）想要 ${res.join(',') || '（无）'}，等了 ${waitedMs}ms，${blockedBy.join(' / ')} 还占着${who}`)
          return {
            status: 'busy',
            actionId: null,
            name: nm,
            resources: res,
            priority: prio,
            conflicts,
            outranked,
            blockedBy,
            waitedMs,
            ...(preemptedBy.length ? { preemptedBy } : {}),
            ...(parentLost ? { parentLost } : {}),
            note: `资源被占，我排队等了 ${waitedMs}ms 还是没等到（${blockedBy.join(' / ')}）—— 过一会儿再叫一次`
          }
        }
      } else {
        this.blocked++
        const blockedBy = conflicts.map((c) => `${c.actionId} ${c.name}（${c.resources.join(',')}）`)
        this.log(`挡住：${nm}（${priorityText(prio)}）想要 ${res.join(',') || '（无）'}，但 ${blockedBy.join(' / ')} 正占着`)
        return {
          status: 'busy',
          actionId: null,
          name: nm,
          resources: res,
          priority: prio,
          conflicts,
          outranked,
          blockedBy,
          waitedMs: 0,
          ...(parentLost ? { parentLost } : {}),
          note: '资源被占，等它结束再叫一次'
        }
      }
    } else if (conflicts.length) {
      /* observe-only：只记一笔，照旧执行（P0 的验收标准：现有动作行为不变） */
      this.conflicts++
      const who = conflicts.map((c) => `${c.actionId} ${c.name}（${priorityText(c.priority)}）占着 ${c.resources.join(',')}`).join('；')
      this.log(`撞车（${this.mode}，不拦）：${nm}（${priorityText(prio)}）想要 ${res.join(',') || '（无）'}，${who}${outranked ? `｜其中 ${outranked} 个优先级比它高` : ''}`)
    }

    if (parentLost) this.log(`⚠️ ${nm} 说自己的父动作是 ${parent}，但活跃表里没有它 —— 这一条按**顶层动作**登记`) 

    /* ③ 登记：只记"这一帧**新占**的"，父动作已经持有的不重复登记 */
    let rec = parentRec
    if (!rec) {
      this.seq++
      /* `parent` 恒为 null —— **不是 bug**（审计 F8 曾按 bug 报过，核对后是设计）：
       * 子步骤不新建记录，而是**复用父动作的 rec**（上面 `let rec = parentRec`），
       * 活跃表和 history 里因此只有顶层动作；`list()` 回 `parent: a.parent` 就是 `null`。 */
      rec = { actionId: `a${this.seq}`, name: nm, owner, priority: prio, resources: new Set(), parent: null, preemptible: preemptible !== false, cancelPoint: null, frames: 0, since: this.now(), depth: 0, controller: null }
      this.active.set(rec.actionId, rec)
    }
    rec.frames++
    if (cancelPoint) rec.cancelPoint = cancelPoint
    const added = []
    for (const r of res) {
      if (rec.resources.has(r)) continue        // 父动作已经占了 ⇒ 不重复登记
      rec.resources.add(r)
      added.push(r)
    }

    /* ④ 跑。信号有两个来源要合起来：调用方的 `signal`（宿主的中断）与调度器自己的
     * `controller`（**抢占的把手**）。子步骤（`parentRec` 在）**共用父动作的 controller**
     * —— 否则"抢父动作"只叫停了父，子步骤还在跑，而它占着的正是父动作那份资源（同一个 rec）。 */
    let controller = parentRec?.controller ?? null
    let own = false
    if (!controller && typeof AbortController === 'function') {
      controller = new AbortController()
      own = true
      rec.controller = controller
    }
    const onAbort = () => { try { controller?.abort() } catch { /* 忽略 */ } }
    if (own && signal && controller && typeof signal.addEventListener === 'function') {
      if (signal.aborted) onAbort()
      else { try { signal.addEventListener('abort', onAbort, { once: true }) } catch { /* 忽略 */ } }
    }
    if (controller?.signal?.aborted) {
      this.#release(rec, added)
      return { status: 'preempted', actionId: rec.actionId, name: nm, resources: res, priority: prio, conflicts, outranked, blockedBy: [], waitedMs, ...(preemptedBy.length ? { preemptedBy } : {}), ...(parentLost ? { parentLost } : {}), note: '还没开始就被中断了' }
    }

    const t0 = this.now()
    let status = 'completed'
    let result
    let error
    try {
      result = await _current.run({ actionId: rec.actionId, name: nm }, () => execute({ actionId: rec.actionId, signal: controller?.signal ?? signal ?? null, scheduler: this }))
      if (controller?.signal?.aborted) status = 'preempted'
    } catch (err) {
      error = err
      status = controller?.signal?.aborted ? 'preempted' : 'failed'
    } finally {
      if (own && signal && controller && typeof signal.removeEventListener === 'function') {
        try { signal.removeEventListener('abort', onAbort) } catch { /* 忽略 */ }
      }
      this.#release(rec, added)
      const entry = { actionId: rec.actionId, name: nm, owner, priority: prio, resources: res, parent: parentRec ? parentRec.actionId : null, since: t0, ms: Math.max(0, this.now() - t0), status }
      this.history.push(entry)
      while (this.history.length > this.keep) this.history.shift()
      /* 用户验收标准第 7 条"从真实运行日志里确认资源模型"：**顶层动作**各记一行结束账。
       * 子步骤（`parentRec` 非空）不记 —— 它们是父动作内部的事，记了只是噪音。
       * 这一行就是事后复盘"谁占了什么、占了多久、有没有撞车"的全部依据。 */
      if (!parentRec) {
        this.log(`动作 ${entry.actionId} ${nm}（${priorityText(prio)}）持 ${res.join(',') || '（无）'} ${entry.ms}ms ${status}${conflicts.length ? `｜撞车 ${conflicts.length}` : ''}${waitedMs ? `｜排队 ${waitedMs}ms` : ''}${preemptedBy.length ? `｜叫停了 ${preemptedBy.join(' / ')}` : ''}`)
      }
    }

    return {
      status,
      actionId: rec.actionId,
      name: nm,
      resources: res,
      priority: prio,
      conflicts,
      outranked,
      blockedBy: [],
      ...(waitedMs ? { waitedMs } : {}),
      ...(preemptedBy.length ? { preemptedBy } : {}),
      ...(parentLost ? { parentLost } : {}),
      ...(error ? { error } : {}),
      ...(status === 'completed' ? { result } : {})
    }
  }

  /* ───────────────────────── 阶段 P1：抢占与排队 ───────────────────────── */

  /** 这一条现在**能不能被抢**（我比它高是调用方的判据，这里只看它自己） */
  #canPreempt (rec) {
    if (!rec || rec.preemptible === false) return false
    const cp = this.#cancelPointOf(rec)
    return !PREEMPT_BLOCKED_POINTS.includes(String(cp ?? ''))
  }

  /**
   * 叫停一批动作。**只是"叫停"，不是"已经停了"** —— 对方要在自己的 `finally` 里释放资源，
   * 所以调用方拿到返回值之后**照样要排队**（`#awaitFree`）。
   */
  #preempt (blockers, nm, prio) {
    const out = []
    for (const b of blockers) {
      const cp = this.#cancelPointOf(b.rec) ?? '没声明'
      this.log(`抢占：${nm}（${priorityText(prio)}）叫停 ${b.rec.actionId} ${b.rec.name}（${priorityText(b.rec.priority)}，取消边界 ${cp}）`)
      try { b.rec.controller?.abort() } catch { /* 忽略 */ }
      out.push(`${b.rec.actionId} ${b.rec.name}`)
    }
    this.preemptions++
    return out
  }

  /**
   * 排队等这批资源被让出来。
   *
   * @returns {Promise<boolean>} `true` = 等到了（可以接着登记）；`false` = 超时 / 被中断
   */
  async #awaitFree (res, except, ms, signal) {
    if (!this.conflictsOf(res, except).length) return true
    if (!(ms > 0)) return false
    if (signal?.aborted) return false
    this.waited++
    const t0 = this.now()
    const ok = await new Promise((resolve) => {
      const w = { res, except, done: false, finish: null, timer: null, onAbort: null }
      w.finish = (v) => {
        if (w.done) return
        w.done = true
        if (w.timer) { try { clearTimeout(w.timer) } catch { /* 忽略 */ } }
        if (w.onAbort && signal && typeof signal.removeEventListener === 'function') {
          try { signal.removeEventListener('abort', w.onAbort) } catch { /* 忽略 */ }
        }
        this._waiters = this._waiters.filter((x) => x !== w)
        resolve(v)
      }
      w.timer = setTimeout(() => w.finish(false), ms)
      /* ⚠️ **不要 `unref()` 这个定时器** —— 我一开始 unref 了，结果 `check-action-scheduler`
       * 直接报 "Detected unsettled top-level await"：整个进程没有任何东西还活着了，
       * 于是它在"等超时"这件事发生**之前**就退出了，那个 Promise 永远不 resolve。
       * 这个定时器是"这次排队的上限"，**必须算数**（和 `withTimeout()` 里那个同理）。 */
      if (signal && typeof signal.addEventListener === 'function') {
        w.onAbort = () => w.finish(false)
        try { signal.addEventListener('abort', w.onAbort, { once: true }) } catch { /* 忽略 */ }
      }
      this._waiters.push(w)
      this.#wakeWaiters()
    })
    this.waitMs += Math.max(0, this.now() - t0)
    return ok
  }

  /** 谁要的资源已经空出来了 ⇒ 叫醒它（`#release` / `release` / `releaseAll` 都会调） */
  #wakeWaiters () {
    if (!this._waiters.length) return
    for (const w of [...this._waiters]) {
      if (w.done) continue
      if (!this.conflictsOf(w.res, w.except).length) w.finish(true)
    }
  }

  /**
   * 只释放**这一帧自己新占的**资源（用户约束：旧动作只能释放自己持有的）。
   * `frames` 归零才把动作记录从活跃表删掉 —— 子步骤先退出不会放掉父动作的资源。
   */
  #release (rec, added) {
    for (const r of added) rec.resources.delete(r)
    rec.frames = Math.max(0, rec.frames - 1)
    if (rec.frames <= 0) {
      this.active.delete(rec.actionId)
      /* 只有"整条动作真的退出了"才叫醒等资源的人 —— 子步骤退出不算（父动作还占着）。 */
      this.#wakeWaiters()
    }
  }

  /** 兜底：手动清掉一条动作记录（异常路径用；正常路径别调） */
  release (actionId) {
    const rec = this.active.get(String(actionId ?? ''))
    if (!rec) return false
    this.active.delete(rec.actionId)
    this.#wakeWaiters()
    return true
  }

  /**
   * 全部清掉（**断线 / 重连时调**）。
   *
   * 为什么必须有：连接断了之后，上一个连接上"谁在占什么"这件事**已经不作数了** ——
   * 那些动作的 promise 可能永远不 resolve（服务端不会回执）。不清的话，重连后表里会留着
   * 一堆早就结束的动作，等 P1 真的开始拦人时就变成"重连之后什么都动不了"。
   *
   * @returns {number} 清掉了几条
   */
  releaseAll (why = '') {
    const n = this.active.size
    if (n) {
      this.active.clear()
      this.log(`清空 ${n} 条动作记录${why ? `（${why}）` : ''}`)
    }
    /* 🔴 断线时**必须**叫醒排队的人：它们等的那条记录已经没了，再等下去就是干等到超时。
     * 叫醒之后它们会看到"资源空了" ⇒ 接着往下跑 ⇒ 自己撞上"连接没了"的错，如实报出去。 */
    this.#wakeWaiters()
    return n
  }

  /** 动作自己声明的安全取消边界（它抛错就当"不确定"） */
  #cancelPointOf (a) {
    if (typeof a.cancelPoint !== 'function') return null
    try {
      const v = String(a.cancelPoint() ?? '').trim().toLowerCase()
      return CANCEL_POINTS.includes(v) ? v : null
    } catch { return 'unknown' }
  }
}

/* ───────────── 会话上的懒建入口（`src\core.mjs` 只留一行薄包装） ─────────────
 * 🔴 2026-10-15 审计：这段原来写在 `core.mjs` 里，把外壳顶过了 `core.mjs ≤ 1000 行`
 *    （`tools\check-module-load.mjs` ④ 的规矩）。搬进来时行为一字未改。
 * ------------------------------------------------------------------------- */

/**
 * 取（必要时建）这只机器人对应的调度器。
 *
 * 懒建：它只维护"谁在占什么"的一张表，不碰 `_moveGen` / `_ctrlLease` / `interruptMove`
 * —— 抢占仍然只有那一条路。
 *
 * 模式默认 `observe-only`（撞车只记日志），可用环境变量 `MCP_MC_AGENT_SCHEDULER=enforce`
 * 切成"撞车就挡住"；也可以直接 `actionScheduler().setMode('enforce')` 当场切。
 */
export function actionSchedulerOf (self) {
  if (!self._actions) self._actions = new ActionScheduler({ log: (m) => self.log(`[调度器] ${m}`) })
  return self._actions
}
