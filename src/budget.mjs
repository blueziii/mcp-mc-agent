/**
 * 单次工具调用的时间预算（第 ④ 条第九刀从 `core.mjs` 搬出来）。
 *
 * 这里全是**纯常量与纯函数**：不碰 `bot`、不碰 `this`、不 import 游戏库。
 * `McBot` 的 `setCallDeadline()` / `msLeft()` / `callLeft()` 是**实例状态**，留在类里；
 * 它们读的 `CALL_MS` 从这里导入。
 *
 * 🔴 两条不许动的约定：
 *   ① `CALL_MS` / `CALL_BUDGET_MS` / `callBudget` / `callDeadline` 被 `index.js`、4 个扩展
 *      （mc_chest / mc_craft / mc_furnace / mc_observe）和 `tools\check-call-budget.mjs`
 *      从 `core.mjs` 导入 ⇒ `core.mjs` 必须原样 re-export 这七个名字（公开面一行都不能变）。
 *   ② 秒数文案（`callSecText` / `budgetSecText`）跟着常量走，改上限时不用挨个改文案 ——
 *      所以它们必须和常量住在一起。
 */

/** 各类操作的默认超时（ms）；可用 cfg.timeouts 覆盖 */
export const TIMEOUTS = {
  lookAt: 4_000,
  equip: 6_000,
  dig: 25_000,
  place: 6_000,
  flyTo: 30_000,
  digBlock: 25_000,
  give: 8_000,
  act: 6_000,
  toss: 5_000,
  attack: 4_000,
}

/**
 * 单次工具调用的时间上限。
 * 🔴 用户要求：**一次工具调用别挂太久，宁可少量多次** —— 一次挂几分钟的时候
 *    用户看不到消息、也没法插话（"太久根本获取不了消息"）。
 *    一开始定的是 5 秒；后来用户要求"把使用工具 5 秒的限制提高到 11 秒"（2026-10-08）⇒ 改成 11 秒。
 *    所以长动作（走路 / 挖一片 / 搭一片 / 盯熔炉 / 连串步骤）一律改成
 *    **到点就带着进度返回**，由模型再叫一次接着做。
 *    两道闸：① `asTool` 每次调用前设"截止时刻"，`#t` 和各个循环都看它；
 *            ② 工具自己的 `timeoutMs` 也压到 CALL_MS + 1 秒兜底。
 */
export const CALL_MS = 11_000         // 硬上限：一次工具调用最多占这么久
export const CALL_BUDGET_MS = 10_000  // 动作自己的预算（留 1 秒收尾 / 序列化 / 回传）
/** 把预算收进 [200, cap]；没给（或不是正数）就用 def */
export const callBudget = (v, def = CALL_BUDGET_MS, cap = CALL_BUDGET_MS) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(Math.max(Math.round(n), 200), cap)
}
/** 这一轮调用的截止时刻（ms）—— 循环里用它早停，别把整次调用挂死 */
export const callDeadline = (ms = CALL_MS) => Date.now() + ms
/** 给模型看的"这一轮用完了"文案里的秒数（跟着 `CALL_MS` 走，改上限时不用再挨个改文案） */
export const callSecText = () => `${Math.round(CALL_MS / 1000)} 秒`
/** 动作预算的秒数（文案用） */
export const budgetSecText = () => `${Math.round(CALL_BUDGET_MS / 1000)} 秒`
