/**
 * src/task-runner.mjs —— **可恢复的任务状态机**（用户 2026-10-08 路线图第 ②③ 条）
 *
 * 要解决的问题（用户原话）：
 *   > 把"去找铁矿"拆成寻找洞穴、探索、发现矿石、抵达目标、换工具、挖掘、捡取、检查背包等阶段。
 *   > 任务有明确进度、失败原因和恢复入口，不必每次从头规划。
 *   > **任务进度不能只保存在 AI 的对话上下文里。**
 *
 * 所以这个模块只做三件事：
 *   ① **记住**：任务（`taskId` / `goal` / `phase` / `progress` / `checkpoint` / `lastError` / `status`）
 *      落到磁盘（`<记忆根>/tasks.json`）—— 掉线、重连、换一轮对话都还在；
 *   ② **分类**：把"失败"拆成 `no-tool` / `no-target` / `unreachable` / `server-refused` /
 *      `budget` / `timeout` / `preempted` / `full` / `aborted` / `unknown`，
 *      每种给出"下一步该干什么"（**超时不算失败**，只是"这一轮时间用完了"）；
 *   ③ **恢复**：`resume()` 用**现场状态**（背包里到底有多少）复核进度，再给出下一个具体动作 ——
 *      不是让模型从"找铁矿"重新规划一遍。
 *
 * 三条边界（写清楚免得以后越界）：
 *   - **不碰 mineflayer**：这个文件不 import 任何游戏库，现场状态由调用方（`src/core.mjs`）喂进来；
 *   - **不抢控制权**：移动编号（`#beginMove`）、控制位租约、11 秒预算、服务端破坏确认都还在 core 里，
 *     这里只记账，绝不下发动作；
 *   - **不猜**：背包数不出来就如实标 `verified: false`，不让"进度"变成假数据。
 *
 * 2026-10-14（用户"任务驱动"设计的第一步）：**只加数据模型，不加执行器**。
 *   · `goalSpec` —— 机器可读的目标 `{ type, item, count, unit }`。`goal` 那句人话**保持字符串不动**
 *     （`taskLine` / `mc_task` / 磁盘上的旧任务文件都还在读它），两份一起存在；
 *   · `steps[]` —— 每一步的状态（`pending` / `running` / `done` / `failed` / `skipped`）+ 自己的重试次数。
 *     以前只有自由文本的 `phase`，"拆到哪一步了"只活在模型的对话上下文里，一压缩就没了；
 *   · `maxAttempts` —— 单步重试上限（默认 3）。超了把任务标 `blocked`（与循环检测同一个语义：
 *     "停下来等指示"，**不是**终态的 `failed`）。
 *   🔴 这一版**仍然不下发任何动作**：`steps` 是台账，谁推进它（模型，还是以后的执行器）由调用方决定。
 *      所以 `start()` **不会**自动塞一套模板步骤 —— 没人推进的步骤表就是假数据。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 任务状态文件（放在记忆根里：按会话分，重连也在同一份） */
export const TASK_FILE = 'tasks.json'
/** 最多留多少个任务（活跃的永远留） */
export const TASK_KEEP = 24
/** 同一个动作 + 同一个原因连着失败几次 = 卡死了（用户要求"循环检测"） */
export const LOOP_LIMIT = 3
/** 历史条目上限（每个任务） */
export const HISTORY_KEEP = 40

export const STATUSES = ['running', 'waiting', 'paused', 'blocked', 'failed', 'done', 'cancelled']
/** "还在做"的状态（`current()` 只认这些） */
export const LIVE_STATUSES = ['running', 'waiting', 'paused', 'blocked']

/* ── 目标 / 步骤的数据模型（2026-10-14 用户"任务驱动"设计第一步） ── */

/** 目标类型：`type` 是"要达成什么"，`kind` 是"怎么干"（一个 kind 只对应一种 type） */
export const GOAL_TYPES = ['obtain_item', 'reach', 'kill', 'custom']
/** 步骤状态（`skipped` 也算走完了） */
export const STEP_STATUSES = ['pending', 'running', 'done', 'failed', 'skipped']
/** 单步重试上限：超了把任务标 `blocked` 等指示（和 `LOOP_LIMIT` 同一个语义） */
export const DEFAULT_MAX_ATTEMPTS = 3

/**
 * 任务"代次"（epoch）的起点。
 * 🔴 干什么用的（2026-10-15，用户点名的异步方案 ⑤）：
 *    `TaskExecutor.run` 会 `await this.call(tool, args, …)` —— 那可能好几秒。
 *    在这几秒里，模型完全可能 `mc_task {action:"plan"}` 重排步骤表、或者 `cancel` 掉任务。
 *    等那个 await 回来，手里那份结果就是**上一代**的了：步骤 id 可能还在，但含义已经变了，
 *    照写就会"把新计划里的某一步标成完成，而它其实没做"。
 *    ⇒ 每次"换了这一代要干什么"（重排步骤表 / 取消 / 收工）就把 `epoch` +1；
 *    执行器在动手前记下代次，写账前对一次，**对不上就整份丢掉**。
 */
export const TASK_EPOCH_START = 1
/** 一个任务最多记多少步（防手滑塞进来几千条） */
export const STEP_MAX = 24

/** `kind`（动作类型）→ `type`（目标类型） */
export function goalTypeOf (kind) {
  switch (String(kind ?? '').toLowerCase()) {
    case 'dig': case 'craft': case 'smelt': case 'chest': case 'gather': case 'collect': return 'obtain_item'
    case 'move': case 'travel': case 'goto': return 'reach'
    case 'attack': case 'kill': case 'hunt': return 'kill'
    default: return 'custom'
  }
}

/** 目标那句人话。`goal` 一直是字符串；万一旧任务没有，就按 `goalSpec` / `kind` 拼一个 */
export function goalTextOf (t) {
  const g = t?.goal
  if (typeof g === 'string' && g) return g
  const s = t?.goalSpec
  if (s?.item) return `${s.type ?? 'obtain_item'} ${s.item}${s.count != null ? ` ×${s.count}` : ''}`
  return String(t?.kind ?? '任务')
}

/** 机器可读的目标规格。旧任务文件里没有 `goalSpec` ⇒ 按 `kind` / `params` / `progress` 现推 */
export function goalSpecOf (t) {
  const s = t?.goalSpec
  if (s && typeof s === 'object') return s
  const n = t?.progress?.total
  return {
    type: goalTypeOf(t?.kind),
    item: t?.params?.item ?? null,
    count: n == null ? null : Number(n),
    unit: t?.progress?.unit ?? '个',
  }
}

/**
 * 这类活的步骤骨架（**只写形状**，材料链条仍然交给 `mc_craft` / `mc_furnace` 的规划器，不在这里重写）。
 * 🔴 现在**没有**任何地方自动套用这张表：等第二步的执行器上来，由它 `setSteps()` 填。
 */
const STEP_TEMPLATE = {
  dig: ['locate', 'approach', 'dig', 'pickup', 'verify'],
  craft: ['check-inventory', 'gather-materials', 'craft', 'verify'],
  smelt: ['check-inventory', 'fuel', 'load', 'wait', 'take', 'verify'],
  chest: ['find-container', 'transfer', 'verify'],
  move: ['plan-route', 'walk', 'arrive'],
  attack: ['locate', 'engage', 'confirm'],
}

export function defaultSteps (kind = null) {
  const ids = STEP_TEMPLATE[String(kind ?? '').toLowerCase()] ?? null
  return ids ? ids.map((id) => ({ id, status: 'pending', attempts: 0 })) : []
}

/** 把外来的步骤数组洗干净（字符串也认；认不出的一律丢掉，别把假数据记进台账） */
export function normSteps (raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const s of raw.slice(0, STEP_MAX)) {
    const o = typeof s === 'string' ? { id: s } : (s && typeof s === 'object' ? s : null)
    const id = String(o?.id ?? o?.label ?? '').trim().slice(0, 40)
    if (!id) continue
    /* `op` / `args`：这一步**交给哪个工具、带什么参数**（2026-10-14 第二步）。
     * 没有 `op` 的步骤是"人工步骤" —— 执行器不替模型猜，原样交回。 */
    const op = o?.op ? String(o.op).trim().slice(0, 40) : null
    const args = o?.args && typeof o.args === 'object' && !Array.isArray(o.args) ? o.args : null
    out.push({
      id,
      op,
      args,
      status: STEP_STATUSES.includes(o.status) ? o.status : 'pending',
      attempts: Math.max(0, Number(o.attempts) || 0),
      note: o.note ? String(o.note).slice(0, 120) : null,
      at: o.at ?? null,
    })
  }
  return out
}

/** 一行"现在走到哪一步了"（没步骤表就返回 null —— 输出跟以前一模一样） */
export function stepLine (t) {
  const steps = t?.steps ?? []
  if (!steps.length) return null
  const cur = steps.find((s) => s.status === 'running') ?? steps.find((s) => s.status === 'pending') ?? null
  const i = cur ? steps.indexOf(cur) + 1 : steps.length
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length
  const failed = steps.filter((s) => s.status === 'failed').length
  return `第 ${i}/${steps.length} 步 ${cur ? cur.id : '（都走完了）'} · 已完成 ${done}${failed ? ` · 失败 ${failed}` : ''}`
}

/** 磁盘上的旧任务补齐新字段（读的时候补，**不要求重写文件**） */
export function migrateTask (t) {
  if (!t || typeof t !== 'object') return t
  if (!t.goalSpec || typeof t.goalSpec !== 'object') t.goalSpec = goalSpecOf(t)
  if (!Array.isArray(t.steps)) t.steps = []
  if (!Number.isFinite(Number(t.maxAttempts))) t.maxAttempts = DEFAULT_MAX_ATTEMPTS
  if (!Number.isFinite(Number(t.epoch)) || Number(t.epoch) < TASK_EPOCH_START) t.epoch = TASK_EPOCH_START
  return t
}

/**
 * 失败分类表。`next` 是"下一步该干什么"，直接变成给模型的建议动作名。
 * 🔴 `budget` / `timeout` / `preempted` **都是 retryable**：它们不代表动作失败 ——
 *    11 秒到点时方块可能已经挖掉了，玩家插一句话也不代表任务黄了。
 */
export const FAIL_KINDS = {
  'no-tool': { retryable: false, next: 'craft-tool', hint: '背包里没有能用的工具 —— 先 mc_craft 一把（木镐 = 3 木板 + 2 木棍）再继续' },
  'no-target': { retryable: false, next: 'scan', hint: '附近找不到目标了 —— mc_scan / mc_move 换个方向或扩大范围，别在原地反复试' },
  unreachable: { retryable: true, next: 'move-closer', hint: '够不着 —— 先 mc_move 走到它旁边（3 格以内）再动手' },
  'server-refused': { retryable: true, next: 'reconnect', hint: '服务端没认这次动作（方块复原 / 没收到回包）—— 先 mc_scan 复核，并且先想一下那格是不是自己垫脚放上去的（别顺手 mc_connect {force:true}，那会让玩家看到你退出游戏）' },
  budget: { retryable: true, next: 'continue', hint: '这一轮的 11 秒用完了（**不是失败**）—— 用同样的参数再叫一次接着做' },
  timeout: { retryable: true, next: 'continue', hint: '超时了（**不等于没做成**：服务端可能已经执行）—— 先复核现场，再决定要不要重做' },
  preempted: { retryable: true, next: 'continue', hint: '被新的指令抢占了 —— 先把玩家要的事做完，再回来看这个任务' },
  full: { retryable: false, next: 'store', hint: '背包满了 —— 先 mc_chest 存一趟，或丢掉没用的' },
  aborted: { retryable: false, next: 'stop', hint: '被叫停了' },
  unknown: { retryable: true, next: 'continue', hint: '说不清为什么没成 —— 先复核现场（mc_observe / mc_inventory）再试' },
}

/** 分类用的判据表（顺序有意义：先匹配到的赢） */
const FAIL_RULES = [
  [/没有能挖|没有能用的工具|需要(一把)?(镐|斧|锹|锄|剑)|先 mc_craft|harvestable tool/i, 'no-tool'],
  [/附近找不到|未加载|找不到 (它|目标)|not loaded/i, 'no-target'],
  [/够不着|走过去也没走到|reach|out of range/i, 'unreachable'],
  [/复原|没收到服务端|服务端没认|还是 air|restored/i, 'server-refused'],
  [/这一轮的 11 秒|时间用完了|预算|budget|剩下的时间不够/i, 'budget'],
  [/超时|timed out|timeout/i, 'timeout'],
  [/抢占|打断|preempt|interrupt/i, 'preempted'],
  [/背包满|没有空位|emptySlot|inventory full/i, 'full'],
  [/叫停|取消|cancel|abort|终止/i, 'aborted'],
]

/**
 * 把一段错误（Error / 字符串 / 已有的 `{kind}`）分类成 `FAIL_KINDS` 里的某一项。
 * @returns {{kind:string, retryable:boolean, next:string, hint:string, reason:string}}
 */
export function classifyFailure (input) {
  const given = String(input?.kind ?? '').trim()
  /* 🔴 `error` 也要认：工具失败时回的就是 `{error:'…'}`（`src\task-exec.mjs` 就是这么喂进来的）。
   *    只认 `reason`/`message` 的话，`String({error:'…'})` 会变成 `'[object Object]'`，
   *    任何分类都匹配不上 ⇒ 明确失败被当成"说不清"（冒烟 I 抓出来的）。 */
  const reason = String(input?.reason ?? input?.error ?? input?.message ?? input ?? '').trim()
  let kind = given && FAIL_KINDS[given] ? given : null
  if (!kind) {
    for (const [re, k] of FAIL_RULES) { if (re.test(reason)) { kind = k; break } }
  }
  if (!kind) kind = 'unknown'
  return { kind, reason, ...FAIL_KINDS[kind] }
}

/** 任务 id：`t-<本地时间戳>-<序号>`，可读、可排序、不会撞 */
export function newTaskId (now = Date.now(), seq = 1) {
  const d = new Date(now)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `t-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(seq, 2)}`
}

/**
 * 方块 → 掉落物（**只用来复核进度**，认不出来就如实说"复核不了"）。
 * 不做全量表：minecraft-data 的 `block.drops` 在运行时才拿得到，这里是离线兜底。
 */
export const DROP_OF = {
  oak_log: 'oak_log', birch_log: 'birch_log', spruce_log: 'spruce_log', jungle_log: 'jungle_log',
  acacia_log: 'acacia_log', dark_oak_log: 'dark_oak_log', mangrove_log: 'mangrove_log',
  cherry_log: 'cherry_log', pale_oak_log: 'pale_oak_log', bamboo_block: 'bamboo',
  stone: 'cobblestone', cobblestone: 'cobblestone', deepslate: 'cobbled_deepslate',
  dirt: 'dirt', grass_block: 'dirt', sand: 'sand', red_sand: 'red_sand', gravel: 'gravel',
  clay: 'clay_ball', coal_ore: 'coal', deepslate_coal_ore: 'coal',
  iron_ore: 'raw_iron', deepslate_iron_ore: 'raw_iron',
  copper_ore: 'raw_copper', deepslate_copper_ore: 'raw_copper',
  gold_ore: 'raw_gold', deepslate_gold_ore: 'raw_gold',
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  emerald_ore: 'emerald', deepslate_emerald_ore: 'emerald',
  lapis_ore: 'lapis_lazuli', deepslate_lapis_ore: 'lapis_lazuli',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  nether_quartz_ore: 'quartz', nether_gold_ore: 'gold_nugget',
  ancient_debris: 'ancient_debris', obsidian: 'obsidian',
  wheat: 'wheat', carrot: 'carrot', potato: 'potato', beetroot: 'beetroot',
  sugar_cane: 'sugar_cane', bamboo: 'bamboo', kelp: 'kelp', seagrass: 'seagrass',
  snow_block: 'snowball', snow: 'snowball', ice: 'ice', packed_ice: 'packed_ice',
  glowstone: 'glowstone_dust', melon: 'melon_slice', pumpkin: 'pumpkin',
  sweet_berry_bush: 'sweet_berries', vine: 'vine', mushroom: 'mushroom',
}

/** 方块名 → 掉落物名（认不出来返回 null，**不要瞎猜**） */
export function dropOf (blockName) {
  const n = String(blockName ?? '').trim().toLowerCase()
  if (!n) return null
  if (DROP_OF[n]) return DROP_OF[n]
  /* 没登记的一律 null。以前这里想"`xx_ore` / `xx_log` 按同名赌一把"，但赌错更糟：
   * 复核进度时把"背包里有 0 个 xx_ore"当成"没挖到"，会把已经挖到的活儿判成没干完。
   * 认不出来就如实说"复核不了"（`resume()` 里 `verified:false`）。 */
  return null
}

/** 一行摘要，给人看（也进工具输出） */
export function taskLine (t) {
  if (!t) return '（没有任务）'
  const p = t.progress ?? {}
  const prog = p.total != null ? `${p.done ?? 0}/${p.total}` : String(p.done ?? 0)
  const st = { running: '进行中', waiting: '等条件', paused: '暂停', blocked: '卡住了', failed: '失败', done: '完成', cancelled: '取消' }[t.status] ?? t.status
  const err = t.lastError ? ` · 上次卡在：${t.lastError.kind}${t.lastError.reason ? `（${String(t.lastError.reason).slice(0, 60)}）` : ''}` : ''
  const sp = stepLine(t)
  return `${t.taskId} · ${t.kind} · ${goalTextOf(t)} · ${prog}${p.unit ?? ''} · ${st}${sp ? ` · ${sp}` : ''}${err}`
}

/** 给工具返回用的紧凑对象（不塞历史） */
export function taskBrief (t) {
  if (!t) return null
  return {
    taskId: t.taskId, kind: t.kind, goal: goalTextOf(t), goalSpec: goalSpecOf(t),
    phase: t.phase, status: t.status, steps: t.steps ?? [], step: stepLine(t),
    maxAttempts: Number(t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
    progress: t.progress, lastError: t.lastError, loopDetected: t.loopDetected ?? null,
    checkpoint: t.checkpoint ?? null, updatedAt: t.updatedAt, startedAt: t.startedAt,
  }
}

/* ─────────────── 三种结局：已确认成功 / 动作失败 / 结果未知（路线图第 ⑥ 条） ───────────────
 * 用户 2026-10-08 路线图："统一任务取消/超时/重连/恢复，区分'动作失败''结果未知''已确认成功'"。
 *
 * 为什么必须分开：**时间到了 ≠ 没做成**。`mc_dig` 被 11 秒预算截断时，那一镐可能已经挖下去了；
 * `mc_move` 被抢占时，人可能已经挪了两格。把"未知"当成"失败"会让 AI 重做（浪费一轮、
 * 甚至把刚放好的方块再挖掉），当成"成功"又会让它以为东西到手了。所以只认**证据**：
 *   · confirmed —— 有服务端/世界状态的证据（那格变 air 且服务端回包确认、placed>0、arrived、killed…）
 *   · failed    —— 明确被拒/明确没做成（没有工具、够不着、服务端复原、NoPath…）
 *   · unknown   —— 时间到/被抢占/超时，读不到证据（**服务器可能已经做了**）
 */
export const OUTCOMES = ['confirmed', 'failed', 'unknown']
export const OUTCOME_LABEL = { confirmed: '已确认成功', failed: '动作失败', unknown: '结果未知', stale: '这一步作废了' }

/** 把一个动作的返回值判成四种结局之一（判不出就如实说 unknown，绝不硬判成成功） */
export function outcomeOf (res, { expect = null } = {}) {
  const r = res ?? {}
  const s = (x) => String(x ?? '')
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : null)
  const blob = `${s(r.error)} ${s(r.reason)} ${s(r.note)} ${s(r.why)} ${s(r.hint)}`

  /* 🔴 代次过期（2026-10-15，用户点名的异步方案 ⑤）：这一步的结果属于**上一代**。
   *    它既不是成功、也不是失败，更不是"结果未知、服务器可能已经做了" ——
   *    而是**作废**（执行器压根没往台账上写）。必须排在所有判据最前面：
   *    否则它会掉进下面的 `unknown`，被说成"先 mc_observe 看一眼再决定"，
   *    而实际上这一步在新计划里可能**根本不存在**。 */
  if (r.stale === true) return 'stale'

  // ① 明确失败：被拒 / 够不着 / 服务端复原 / 路不通
  if (r.restored === true) return 'failed'
  if (r.broken === false && r.refused === true) return 'failed'
  if (r.placed === 0 && r.refused === true) return 'failed'
  /* 🔴 报告 H4（2026-10-13）：`placeBlock` 只在"放完复核没过"时回 `placed:false`（`place.mjs:189`），
   *    那是明确失败 —— 以前它落到最后变成"结果未知"，模型会以为还有机会。 */
  if (r.placed === false) return 'failed'
  /* 🔴 审计 F2：**结构化**的"时间到 / 被抢占"必须排在下面那条**文本**失败正则之前。
   *    原来顺序反了 ⇒ `mc_move` 带着 `{mcTimeout:true}` 回来时，只要 note 里出现"够不着"
   *    之类字样就先被判成 'failed'，"结果未知"那条永远走不到。 */
  if (r.mcTimeout === true || r.cutByCall === true || r.preempted === true) return 'unknown'
  if (/复原|够不着|没有能挖|不在线|NoPath|unreachable|refused|拒绝|缺少|先 mc_craft|没挖成|没挖掉/i.test(blob)) return 'failed'

  // ② 明确成功：有证据
  /* 🔴 报告 H4：`placed` / `broken` 成功时是**方块名字符串**（`place.mjs:189` / `mining.mjs:145`），
   *    而这里以前用 `num(...) > 0` ⇒ `Number('cobblestone')` 是 NaN ⇒ 成功的放置/挖掘一路掉到
   *    "结果未知"，模型以为没做成、可能重做。名字符串同样算成功证据。 */
  const pos = (x) => (typeof x === 'string' && x.length > 0 ? 1 : (num(x) ?? 0))
  /* 🔴 审计 F1：`mc_dig` 回的是字符串数组（`index.js` 里包成 `{result, text}`），
   *    没有 `dug`/`broken` 这类字段 ⇒ 挖成功了也一路掉到"结果未知"，被任务执行器记成失败。
   *    它唯一的成功证据就是这一句（`mining.mjs` 只在**收到服务端破坏包**时才写）。 */
  if (/（服务端已确认/.test(blob)) return 'confirmed'
  if (Array.isArray(r.dug) && r.dug.length > 0) return 'confirmed'
  if (pos(r.dug) > 0 || pos(r.placed) > 0 || pos(r.got) > 0) return 'confirmed'
  if (r.broken === true || pos(r.broken) > 0) return 'confirmed'
  if (r.arrived === true || r.killed === true || r.done === true || r.ok === true) return 'confirmed'

  // ③ 时间到 / 被抢占 / 超时 → 结果未知（不是失败）
  if (/budget|timeout|preempted|时间不够|用完了|被打断|抢占/i.test(blob + ' ' + s(r.status))) return 'unknown'

  if (expect != null && pos(r[expect]) === 0) return 'failed'
  return 'unknown'
}

/** 结局的统一文案（附在动作输出末尾，让模型不用猜） */
export function verdictText (outcome, detail = null) {
  const label = OUTCOME_LABEL[outcome] ?? outcome
  const tail = detail ? `（${detail}）` : ''
  if (outcome === 'confirmed') return `✅ ${label}${tail}`
  if (outcome === 'failed') return `❌ ${label}${tail}`
  /* 代次过期：**别叫模型去复核现场** —— 那一步已经不在新计划里了，看一眼也是白看。
   * 要做的是"看现在的步骤表"。 */
  if (outcome === 'stale') {
    return `♻️ ${label}${tail} —— 你在这中间把任务改过了（重排步骤 / 取消），`
      + '这一份结果**没往台账上写**：先 `mc_task {action:"get"}` 看**现在**的步骤表，再决定要不要接着跑。'
  }
  return `❓ ${label}${tail} —— 时间到了/被打断，但**服务器可能已经做了**：先看一眼`
    + '（`mc_observe` / `mc_inventory` / `mc_status`）再决定，别直接重做。'
}


/**
 * 任务状态机。一个 `McBot` 一个实例；文件是 `<记忆根>/tasks.json`。
 *
 * 用法（`src/core.mjs` 里）：
 *   const t = this.tasks.auto({ kind: 'dig', item: 'oak_log', total: 16 })
 *   this.tasks.progress(t.taskId, { add: 1 })
 *   this.tasks.fail(t.taskId, { action: 'dig', reason: '...' })
 *   this.tasks.resume(null, { countOf: (name) => this.#countOf(name) })
 */
export class TaskRunner {
  constructor ({ file = null, now = () => Date.now(), log = () => {} } = {}) {
    this.now = now
    this.log = log
    this.file = null
    this.data = { version: 1, seq: 0, tasks: [] }
    this.loaded = false
    if (file) this.setFile(file)
  }

  /** 换文件（index.js 每次工具调用都会喂一次记忆根；路径没变就是空操作） */
  setFile (file) {
    const f = file ? String(file) : null
    if (f === this.file) return this
    this.file = f
    this.loaded = false
    return this
  }

  /* ── 落盘 ── */

  #load () {
    if (this.loaded) return this.data
    this.loaded = true
    if (!this.file) return this.data
    try {
      if (!existsSync(this.file)) return this.data
      const raw = JSON.parse(readFileSync(this.file, 'utf8'))
      if (raw && Array.isArray(raw.tasks)) this.data = { version: 1, seq: Number(raw.seq ?? 0) || 0, tasks: raw.tasks.map(migrateTask) }
    } catch (e) {
      // 文件坏了不能让整个插件崩：留一条日志，从空任务表开始
      this.log(`任务文件读不了（${String(e?.message ?? e).slice(0, 80)}）—— 从空表开始：${this.file}`)
      this.data = { version: 1, seq: 0, tasks: [] }
    }
    return this.data
  }

  save () {
    if (!this.file) return false
    try {
      const d = dirname(this.file)
      if (!existsSync(d)) mkdirSync(d, { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 1), 'utf8')
      renameSync(tmp, this.file)      // 原子替换：写到一半掉线也不会留半截 JSON
      return true
    } catch (e) {
      this.log(`任务文件写不进去：${String(e?.message ?? e).slice(0, 120)}`)
      return false
    }
  }

  /** 只留最近 `TASK_KEEP` 个（活跃的一个都不丢） */
  #prune () {
    const d = this.#load()
    if (d.tasks.length <= TASK_KEEP) return
    const live = d.tasks.filter((t) => LIVE_STATUSES.includes(t.status))
    const dead = d.tasks.filter((t) => !LIVE_STATUSES.includes(t.status))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    d.tasks = [...live, ...dead.slice(0, Math.max(0, TASK_KEEP - live.length))]
  }

  /* ── 查 ── */

  list ({ limit = 10, all = false } = {}) {
    const d = this.#load()
    const arr = all ? [...d.tasks] : d.tasks.filter((t) => LIVE_STATUSES.includes(t.status))
    return arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, Math.max(1, Number(limit) || 10))
  }

  /** 最近一个"还在做"的任务（`mc_dig` 靠它把进度接到同一个任务上） */
  current () { return this.list({ limit: 1 })[0] ?? null }

  get (taskId) {
    const d = this.#load()
    const id = String(taskId ?? '').trim()
    if (!id) return null
    return d.tasks.find((t) => t.taskId === id) ?? null
  }

  /* ── 写 ── */

  start ({ kind = 'task', goal = null, item = null, total = null, unit = '个', params = {}, meta = {}, phase = 'planning', steps = null } = {}) {
    const d = this.#load()
    const now = this.now()
    const t = {
      taskId: newTaskId(now, ++d.seq),
      kind, goal: goal ?? (item ? `${kind} ${item}` : kind), phase,
      /* 机器可读的目标 + 步骤台账（2026-10-14）：`steps` 只有调用方明确给了才写 ——
       * 没人推进的模板步骤表就是假数据（见文件头）。 */
      goalSpec: { type: goalTypeOf(kind), item: item ?? params.item ?? null, count: total == null ? null : Number(total), unit },
      steps: steps ? normSteps(steps) : [],
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      progress: { done: 0, total: total == null ? null : Number(total), unit },
      checkpoint: null, lastError: null, loopDetected: null,
      status: 'running', params: { ...params, item: item ?? params.item ?? null },
      attempts: {}, history: [], meta: { ...meta },
      /* 代次：见 `TASK_EPOCH_START` 的注释 —— 换了这一代要干什么就 +1 */
      epoch: TASK_EPOCH_START, epochWhy: null, epochAt: now,
      startedAt: now, updatedAt: now,
    }
    d.tasks.push(t)
    this.note(t.taskId, `开工：${t.goal}${t.progress.total != null ? `（目标 ${t.progress.total}${unit}）` : ''}`, { save: false })
    this.#prune()
    this.save()
    this.log(`任务开工 ${taskLine(t)}`)
    return t
  }

  /** 找到匹配的活跃任务就接着用，否则新建 —— `mc_dig` 的"同一件事接着做"就靠这个 */
  auto ({ kind, item = null, total = null, params = {} } = {}) {
    /* 🔴 找的是"**同一件事**的活跃任务"，不是"最近那个活跃任务"：
     *    挖原木挖到一半跑去挖石头，原木那条任务仍然算数 —— 回头再挖原木应该接着它，
     *    而不是又开一条新任务（否则任务表里会堆一串同名任务，进度也各自从 0 开始）。 */
    const d = this.#load()
    const cur = d.tasks
      .filter((t) => LIVE_STATUSES.includes(t.status) && t.kind === kind && (item == null || t.params?.item === item))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0] ?? null
    if (cur) {
      cur.updatedAt = this.now()
      if (total != null) cur.progress.total = Number(total)
      /* 又叫了一次 = 人还在管这件事：从"卡住/暂停/等条件"回到"进行中" */
      cur.status = 'running'
      this.save()
      return cur
    }
    return this.start({ kind, item, total, params })
  }

  touch (taskId, patch = {}) {
    const t = this.get(taskId)
    if (!t) return null
    Object.assign(t, patch, { updatedAt: this.now() })
    this.save()
    return t
  }

  /**
   * 换一代（见 `TASK_EPOCH_START`）。**只该在"这一代要干什么"变了的时候调** ——
   * 重排步骤表、取消、收工。普通的记进度 / 记失败 / 换状态**不算**换代，
   * 否则执行器每轮都会被自己刚写的账判成"过期"。
   */
  #bump (t, why = null) {
    if (!t) return null
    t.epoch = (Number(t.epoch) || TASK_EPOCH_START) + 1
    t.epochWhy = why == null ? null : String(why).slice(0, 120)
    t.epochAt = this.now()
    return t.epoch
  }

  /** 当前代次（任务不存在 ⇒ `null`） */
  epochOf (taskId) {
    const t = this.get(taskId)
    return t ? (Number(t.epoch) || TASK_EPOCH_START) : null
  }

  /**
   * 手里这份结果是哪一代的？给执行器写账前对一次。
   * @returns {{stale:boolean, epoch:number|null, why:string|null, at:number|null}}
   */
  staleOf (taskId, epoch) {
    const t = this.get(taskId)
    const now = t ? (Number(t.epoch) || TASK_EPOCH_START) : null
    const want = Number(epoch) || null
    return {
      stale: !t || want == null || now !== want,
      epoch: now,
      why: t?.epochWhy ?? null,
      at: t?.epochAt ?? null,
    }
  }

  progress (taskId, { add = 0, done = null, total = null, note = null } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    if (done != null) t.progress.done = Math.max(0, Number(done) || 0)
    if (add) t.progress.done = Math.max(0, (Number(t.progress.done) || 0) + Number(add))
    if (total != null) t.progress.total = Number(total)
    if (t.progress.total != null && t.progress.done > t.progress.total) t.progress.done = t.progress.total
    t.updatedAt = this.now()
    if (note) this.note(taskId, note, { save: false })
    if (t.progress.total != null && t.progress.done >= t.progress.total) {
      t.status = 'done'; t.endedAt = t.updatedAt; t.phase = 'done'
      this.note(taskId, '目标达成', { save: false })
      this.log(`任务完成 ${taskLine(t)}`)
    }
    this.save()
    return t
  }

  /** 记一次检查点：位置 + 背包 + 正在盯的目标（重连后靠它判断"我在哪一步"） */
  checkpoint (taskId, extra = {}) {
    const t = this.get(taskId)
    if (!t) return null
    t.checkpoint = { at: this.now(), ...(t.checkpoint ?? {}), ...extra }
    t.updatedAt = t.checkpoint.at
    this.save()
    return t.checkpoint
  }

  /** 记一次失败：分类 + 循环检测（同一动作同一原因连着 3 次 ⇒ `blocked`） */
  fail (taskId, { action = null, reason = null, kind = null, detail = null } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    const c = classifyFailure({ kind, reason })
    const now = this.now()
    t.lastError = { kind: c.kind, reason: c.reason || c.hint, detail: detail ?? null, action: action ?? null, at: now, retryable: c.retryable }
    /* 🔴 "这一轮时间用完了 / 超时 / 被抢占"**不进循环检测**：一个长活儿跑三轮很正常，
     *    把它们算成"同一个动作连着失败 3 次"会让任务莫名其妙变成"卡住"（假警报）。
     *    真正的失败（够不着 / 服务端不认 / 没工具 / 找不到目标）才计数。 */
    const counted = !['budget', 'timeout', 'preempted'].includes(c.kind)
    const key = `${action ?? 'action'}:${c.kind}`
    if (counted) {
      const a = (t.attempts[key] ??= { count: 0, lastReason: null, firstAt: now })
      if (a.lastReason === c.reason) a.count += 1
      else { a.lastReason = c.reason; a.count = 1 }
      a.at = now
      if (a.count >= LOOP_LIMIT) {
        t.loopDetected = { key, count: a.count, reason: c.reason, at: now }
        t.status = 'blocked'
        this.note(taskId, `同一个动作（${key}）连着失败 ${a.count} 次 ⇒ 停下来等指示`, { save: false })
        this.log(`任务卡住 ${taskLine(t)}`)
      } else if (t.status === 'running') {
        t.status = c.retryable ? 'running' : 'waiting'
      }
    } else {
      t.attempts[key] = { count: 1, lastReason: c.reason, firstAt: now, at: now, uncounted: true }
      /* 时间不够不是"卡住"，别让任务一直挂在 blocked。
       * 🔴 审计 F10：这里把 blocked 拉回 running 时必须**顺手清掉 `loopDetected`** ——
       *    那个字段是"卡住了"的凭据，留着的话下一次 `list()`/`get()` 还会把它当成卡住的
       *    原因报给模型（`mc_task` 的输出里就带着 `loopDetected`），自相矛盾。 */
      if (t.status === 'blocked') { t.status = 'running'; t.loopDetected = null }
    }
    t.updatedAt = now
    this.save()
    return { task: t, ...c }
  }

  note (taskId, text, { save = true } = {}) {
    const t = this.get(taskId)
    if (!t) return null
    t.history = [...(t.history ?? []), { at: this.now(), text: String(text).slice(0, 300) }].slice(-HISTORY_KEEP)
    t.updatedAt = this.now()
    if (save) this.save()
    return t
  }

  /** 被抢占 / 等条件：**不是失败**，进度留着 */
  pause (taskId, why = '被新的指令抢占') {
    const t = this.get(taskId)
    if (!t || t.status === 'done') return t
    t.status = 'paused'
    t.pauseReason = String(why)
    this.note(taskId, `暂停：${why}`, { save: false })
    t.updatedAt = this.now()
    this.save()
    return t
  }

  /** 等条件（缺工具、背包满）：AI 处理完外部条件回来就能接着做 */
  wait (taskId, why = '等条件') {
    const t = this.get(taskId)
    if (!t || t.status === 'done') return t
    t.status = 'waiting'
    t.pauseReason = String(why)
    this.note(taskId, `等条件：${why}`, { save: false })
    t.updatedAt = this.now()
    this.save()
    return t
  }

  finish (taskId, { ok = true, note = null } = {}) {
    const t = this.get(taskId)
    if (!t) return t
    t.status = ok ? 'done' : 'failed'
    t.phase = ok ? 'done' : 'failed'
    t.endedAt = this.now()
    t.updatedAt = t.endedAt
    this.#bump(t, ok ? '任务已收工' : '任务已判失败')
    if (note) this.note(taskId, note, { save: false })
    this.log(`任务${ok ? '完成' : '失败'} ${taskLine(t)}`)
    this.save()
    return t
  }

  cancel (taskId, why = '取消') {
    const t = this.get(taskId)
    if (!t) return t
    t.status = 'cancelled'
    t.endedAt = this.now()
    t.updatedAt = t.endedAt
    this.#bump(t, `任务被取消：${why}`)
    this.note(taskId, `取消：${why}`, { save: false })
    this.save()
    return t
  }

  forget (taskId) {
    const d = this.#load()
    const before = d.tasks.length
    d.tasks = d.tasks.filter((t) => t.taskId !== String(taskId))
    if (d.tasks.length !== before) this.save()
    return before - d.tasks.length
  }

  /* ── 步骤台账（只记账，不下发动作 —— 2026-10-14） ── */

  /**
   * 当前那步：`stepId` 不给就先看 `phase`（那才是"做到哪了"的权威），
   * 再依次找 running / failed / 第一个 pending。
   * 🔴 一定要先认 `phase`：`stepFail` 会把还能重试的步骤放回 `pending`，
   *    只按"第一个 pending"找会退回到更早那一步上去重试。
   */
  #stepOf (t, stepId = null) {
    const steps = t?.steps ?? []
    if (!steps.length) return null
    const id = stepId ? String(stepId) : null
    if (id) return steps.find((s) => s.id === id) ?? null
    const ph = t.phase ? steps.find((s) => s.id === t.phase) : null
    if (ph && ph.status !== 'done' && ph.status !== 'skipped') return ph
    return steps.find((s) => s.status === 'running')
      ?? steps.find((s) => s.status === 'failed')
      ?? steps.find((s) => s.status === 'pending')
      ?? null
  }

  /** 某一步**后面**第一个还没做的（找不到再从头找 —— 乱序推进也别卡死） */
  #nextStep (t, from) {
    const steps = t?.steps ?? []
    const i = steps.indexOf(from)
    const after = i >= 0 ? steps.slice(i + 1).find((x) => x.status === 'pending') : null
    return after ?? steps.find((x) => x.status === 'pending') ?? null
  }

  /** 一次列全步骤（字符串数组也认）；空数组 = 清掉。执行器将来就靠这个填计划 */
  setSteps (taskId, steps = []) {
    const t = this.get(taskId)
    if (!t) return null
    t.steps = normSteps(steps)
    /* 🔴 重排步骤表 = 换了一代：在飞的那一步的结果不能再往新表上写 */
    this.#bump(t, '步骤表被重排')
    t.updatedAt = this.now()
    this.note(taskId, `步骤：${t.steps.map((s) => s.id).join(' → ') || '（清空）'}`, { save: false })
    this.save()
    return t
  }

  /**
   * 只读地问一句"现在该做哪一步"（执行器 `src\task-exec.mjs` 用它选步）。
   * 判据与 `#stepOf` 完全一致：先认 `phase` → running → failed → 第一个 pending。
   * @returns {object|null} 步骤对象（**原件的引用**，别在外面改它）
   */
  currentStep (taskId = null, stepId = null) {
    const t = this.get(taskId)
    if (!t) return null
    return this.#stepOf(t, stepId)
  }

  /**
   * 把某一步放回"还没做"（**结果未知**时用）。
   * 为什么单独一个方法：`stepFail` 会记一次失败、`stepDone` 会记成做过，
   * 而"时间到了 / 被抢占"这两种情况**两样都不是** —— 服务器可能已经做了，
   * 也可能没做，得先复核现场。所以这里既不记失败也不记成功，只把状态收回来。
   */
  stepReset (taskId, stepId = null, note = null) {
    const t = this.get(taskId)
    if (!t) return null
    const s = this.#stepOf(t, stepId)
    if (!s) return null
    s.status = 'pending'
    if (note) s.note = String(note).slice(0, 120)
    t.updatedAt = this.now()
    this.save()
    return { task: t, step: s, stepLine: stepLine(t) }
  }

  /** 把某一步标成"正在做"（顺手把别的 running 收回 pending） */
  stepBegin (taskId, stepId = null) {
    const t = this.get(taskId)
    if (!t) return null
    const s = this.#stepOf(t, stepId)
    if (!s) return null
    for (const x of t.steps) if (x !== s && x.status === 'running') x.status = 'pending'
    s.status = 'running'
    s.at = this.now()
    t.phase = s.id
    /* 🔴 审计 F10：拉回 running 时一并清 `loopDetected`（它是"卡住了"的凭据，
     *    不清的话 `mc_task` 的输出里会同时说"正在跑"和"同一个动作连着失败 N 次"。 */
    if (t.status === 'blocked' || t.status === 'waiting') { t.status = 'running'; t.loopDetected = null }
    t.updatedAt = s.at
    this.save()
    /* `epoch` 一起回给调用方：执行器拿它当"我这一步是哪一代的"，写账前对一次 */
    return { task: t, step: s, stepLine: stepLine(t), epoch: Number(t.epoch) || TASK_EPOCH_START }
  }

  /** 这步做完了 ⇒ 推进到下一步 */
  stepDone (taskId, stepId = null, note = null) {
    const t = this.get(taskId)
    if (!t) return null
    const s = this.#stepOf(t, stepId)
    if (!s) return null
    s.status = 'done'
    s.at = this.now()
    if (note) s.note = String(note).slice(0, 120)
    const nx = this.#nextStep(t, s)
    t.phase = nx ? nx.id : t.phase
    t.updatedAt = s.at
    this.note(taskId, `步骤 ${s.id} 完成${nx ? ` ⇒ 下一步 ${nx.id}` : '（没有下一步了）'}`, { save: false })
    this.save()
    return { task: t, step: s, next: nx ? nx.id : null, stepLine: stepLine(t) }
  }

  /**
   * 这步没成：记一次重试。超上限 ⇒ 把任务标 `blocked`（**停下来等指示**，不是终态 `failed`）。
   * 和 `fail()` 的循环检测是同一个语义，只是粒度落到"步骤"上。
   */
  stepFail (taskId, stepId = null, reason = null) {
    const t = this.get(taskId)
    if (!t) return null
    const s = this.#stepOf(t, stepId)
    if (!s) return null
    const max = Math.max(1, Number(t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS)
    s.attempts = Math.max(0, Number(s.attempts) || 0) + 1
    s.at = this.now()
    if (reason) s.note = String(reason).slice(0, 120)
    const exhausted = s.attempts >= max
    s.status = exhausted ? 'failed' : 'pending'
    t.updatedAt = s.at
    if (exhausted) {
      t.status = 'blocked'
      t.loopDetected = { key: `step:${s.id}`, count: s.attempts, reason: s.note ?? '这一步反复没做成', at: s.at }
      this.note(taskId, `步骤 ${s.id} 试了 ${s.attempts} 次都没成 ⇒ 停下来等指示`, { save: false })
      this.log(`任务卡住 ${taskLine(t)}`)
    } else {
      this.note(taskId, `步骤 ${s.id} 第 ${s.attempts}/${max} 次没成${s.note ? `：${s.note}` : ''}`, { save: false })
    }
    this.save()
    return { task: t, step: s, attempts: s.attempts, max, exhausted, stepLine: stepLine(t) }
  }

  /** 跳过这步（比如"手上已经有熔炉，不用再合成"） */
  stepSkip (taskId, stepId = null, why = null) {
    const t = this.get(taskId)
    if (!t) return null
    const s = this.#stepOf(t, stepId)
    if (!s) return null
    s.status = 'skipped'
    s.at = this.now()
    if (why) s.note = String(why).slice(0, 120)
    const nx = this.#nextStep(t, s)
    if (nx) t.phase = nx.id
    t.updatedAt = s.at
    this.note(taskId, `跳过步骤 ${s.id}${why ? `：${why}` : ''}`, { save: false })
    this.save()
    return { task: t, step: s, next: nx ? nx.id : null, stepLine: stepLine(t) }
  }

  /* ── 恢复 ── */

  /**
   * 用**现场状态**复核进度，给出下一个具体动作。
   *
   * 🔴 这里的关键是**不重新规划**：任务还是那个任务、目标还是那个目标，
   *    只把"还剩多少 / 上次卡在哪 / 下一步该调哪个工具"算出来。
   *
   * @param {string|null} taskId 不给就用最近一个活跃任务
   * @param {{countOf?: (item:string)=>number|null}} opts 现场状态：背包里某样东西有几个
   */
  resume (taskId = null, { countOf = null } = {}) {
    const t = taskId ? this.get(taskId) : this.current()
    if (!t) return { ok: false, reason: '没有可以恢复的任务', next: 'start', task: null }
    if (t.status === 'done') return { ok: true, done: true, next: 'done', task: taskBrief(t), note: '这个任务已经完成了' }
    if (t.status === 'cancelled') return { ok: false, reason: '这个任务已经被取消', next: 'start', task: taskBrief(t) }

    const item = t.params?.item ?? null
    const total = t.progress?.total ?? null
    let have = Number(t.progress?.done ?? 0)
    let verified = false
    let verifyNote = null
    if (countOf && item) {
      try {
        const c = countOf(item)
        if (c != null && Number.isFinite(Number(c))) { have = Number(c); verified = true }
        else verifyNote = `背包里数不出 ${item}（认不出掉落物），进度按记录算`
      } catch { verifyNote = '读背包出错，进度按记录算' }
    } else if (item) verifyNote = '这次没给现场状态，进度按记录算'

    const need = total == null ? null : Math.max(0, total - have)
    const le = t.lastError
    const cls = le ? (FAIL_KINDS[le.kind] ?? FAIL_KINDS.unknown) : null
    const next = need === 0 && total != null ? 'done' : (cls?.next ?? 'continue')
    /* 步骤台账：卡在哪一步比"上次失败原因"更具体，有就说它 */
    const cur = this.#stepOf(t)
    const max = Math.max(1, Number(t.maxAttempts ?? DEFAULT_MAX_ATTEMPTS) || DEFAULT_MAX_ATTEMPTS)
    const stepHint = cur && cur.status === 'failed'
      ? `第 ${t.steps.indexOf(cur) + 1} 步「${cur.id}」试了 ${cur.attempts}/${max} 次都没成 —— 换个做法，或者问一下玩家`
      : null

    return {
      ok: true, task: taskBrief(t), have, need, verified, verifyNote,
      next, hint: stepHint ?? cls?.hint ?? '接着做（用同样的参数再叫一次就好）',
      action: suggestAction(t, need),
      loopDetected: t.loopDetected ?? null,
      step: stepLine(t), stepId: cur?.id ?? null,
      stepAttempts: cur ? `${cur.attempts}/${max}` : null,
    }
  }
}

/** 由任务推出"下一个具体动作"（只是**建议**，下不下发由模型决定） */
export function suggestAction (t, need = null) {
  const item = t?.params?.item ?? null
  if (!item) return null
  const n = need == null ? null : Math.max(1, Number(need))
  switch (t.kind) {
    case 'dig':
      return { tool: 'mc_dig', args: { name: item, count: n ?? 8, maxDistance: t.params?.maxDistance ?? 16 } }
    case 'craft':
      /* 🔴 审计 F3：`mc_craft` 的参数叫 `count`，**没有** `times` —— 传 `times:8` 会被
       * `extensions\mc_craft.mjs` 静默忽略（`Number(args.count) || 1` ⇒ 只保证 1 个）。
       * 和下面 `smelt` 那条口径对齐。 */
      return { tool: 'mc_craft', args: { name: item, ...(n ? { count: n } : {}) } }
    case 'smelt':
      return { tool: 'mc_furnace', args: { name: item, ...(n ? { count: n } : {}) } }
    case 'chest':
      return { tool: 'mc_chest', args: { ...(t.params?.chest ? { chest: t.params.chest } : {}) } }
    case 'move':
      return { tool: 'mc_move', args: { ...(t.params?.to ? { x: t.params.to.x, y: t.params.to.y, z: t.params.to.z } : {}) } }
    default:
      return null
  }
}
