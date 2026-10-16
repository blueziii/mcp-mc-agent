// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / wait.mjs —— `mc_events {waitSec}` 的**阻塞等待**那一小段（抽出来才能离线单测）
 * ============================================================================
 * 🔴 为什么要有"打断"（2026-09-19 用户实测反馈）：
 *   "等到消息，但是发了消息、就算提及它也没有唤醒，让用户空等特别久；
 *     反倒是等完之后看门狗才注入提示词。"
 *
 *   链路上是这样的：看门狗命中唤醒 → `agent.steer(...)` 注入，
 *   而宿主的语义是「**运行中** 在下一次 **step 边界** 消费」——
 *   step 边界要等**当前这一步的工具调用返回**才算到。
 *   于是 `mc_events {waitSec:120}` 一堵，唤醒文案就被压在这个工具后面，
 *   直到等待超时才投出去：**等待堵住了它正在等的那件事**。
 *
 *   解法：把"要唤醒你"变成一个**能打断等待的信号**——看门狗一注入就置位，
 *   这里每 250ms 看一眼，见到就立刻收工返回。工具一返回，step 就结束，唤醒文案当场投出去。
 * ============================================================================
 */

import { waitUntil } from './async-util.mjs'

/**
 * 等在途事件。四种收工条件：
 *   ① 该来事件了（新事件里有一条符合 `kind`）
 *   ② **被唤醒打断**（`sess.waitInterruptedAt` 在本次等待期间动过）—— 见文件头
 *   ③ 用户按了停止（`signal.aborted`）
 *   ④ 时间到
 *
 * @param {object} o
 * @param {object} o.sess            会话（读 `events` / `eventSeq` / `waitInterruptedAt`）
 * @param {number} [o.fromSeq]       开始等待时已见过的**最大 seq**（只看这之后新增的）
 * @param {number} [o.from]          老写法：队列长度（队列没满时等价，满了会漏事件 —— 见下）
 * @param {string|null} [o.kind]     只关心这一类事件
 * @param {number} [o.waitSec]       最多等几秒（<=0 就直接返回）
 * @param {AbortSignal|null} [o.signal]
 * @param {number} [o.pollMs]        轮询间隔
 * @param {Function} [o.now] / [o.sleep]  测试注入用
 * @returns {Promise<{waitedMs:number, interrupted:boolean, reason:string|null}>}
 *
 * 🔴 2026-10-08 审计报告 F2：原来只按 `events.length` 判断"有没有新事件"，而 `#pushEvent`
 *    队列满 200 条时**从头部 splice** ⇒ 饱和后 `length` 恒等于 200、`slice(from)` 恒空，
 *    `mc_events {waitSec}` 在长挂机会话里**永远漏事件**（探针：199 条时还灵，200 条时
 *    `{waitedMs:1057, reason:null}`）。现在按单调 `seq` 比：`e.seq > fromSeq`。
 */
export async function waitForEvents ({
  sess, fromSeq = null, from = null, kind = null, waitSec = 0, signal = null, pollMs = 250,
  now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const startedAt = now()
  if (!(Number(waitSec) > 0)) return { waitedMs: 0, interrupted: false, reason: null }
  const hasFresh = () => {
    const evs = sess?.events ?? []
    if (fromSeq != null) return evs.some((e) => Number(e?.seq ?? 0) > fromSeq && (!kind || e.kind === kind))
    return evs.slice(Number(from) || 0).some((e) => !kind || e.kind === kind)   // 老写法（会漏，仅兼容）
  }
  const interruptedNow = () => Number(sess?.waitInterruptedAt ?? 0) > startedAt
  /* 2026-10-15 异步方案 ②：这个手写轮询循环也收口到 `waitUntil` ——
   * "查中止 / 算 deadline / 睡多久 / 什么时候收工"全仓库只有一份实现。
   * ⚠️ 判据里**中断排在前面**：原实现在循环里也是先看中断再看事件，
   *    "同一轮里既被唤醒又来了事件"要报"被唤醒"（那才是用户看到的原因）。 */
  const r = await waitUntil(() => interruptedNow() || hasFresh(), {
    ms: Number(waitSec) * 1000, pollMs, signal, label: '等在途事件', now, sleep,
  })
  const waitedMs = now() - startedAt
  if (r.reason === 'aborted') return { waitedMs, interrupted: false, reason: '用户停止' }
  if (interruptedNow()) return { waitedMs, interrupted: true, reason: sess?.waitInterruptReason ?? '唤醒' }
  if (hasFresh()) return { waitedMs, interrupted: false, reason: '有事件' }
  return { waitedMs, interrupted: false, reason: null }
}
