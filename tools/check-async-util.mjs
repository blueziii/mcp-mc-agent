#!/usr/bin/env node
/**
 * `src/async-util.mjs` 的离线自检（2026-10-15 用户点名的异步方案 ②「统一 waitForEvent」）。
 *
 * 为什么单独一套：`waitUntil` / `waitForEvent` 现在是**全仓库唯一一份"等"的实现** ——
 * 六处手写轮询（`dig-guard.mjs` 等落地、`server-break.mjs` 等回包、`runtime.mjs` 等区块、
 * `world-use.mjs` 等附魔选项 / 等铁砧成品、`wait.mjs` 等在途事件）全部改成调它。
 * 它要是错一点，这六处会**一起**错，所以判据本身必须有断言钉住。
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

const A = await import(new URL('../src/async-util.mjs', import.meta.url))
const { waitUntil, waitForEvent, sleep, withTimeout, raceAbort, abortError } = A

/* ── 假时钟：`sleep` 直接把时间推过去，测试**一秒都不真等** ── */
const mkClock = (t0 = 1000) => {
  const c = { t: t0, ticks: 0 }
  c.now = () => c.t
  c.sleep = async (ms) => { c.ticks++; c.t += ms }
  return c
}

/* ── 假 emitter：只提供 `on` / `off` / `emit`，用来钉"监听器真的摘掉了" ── */
const mkEmitter = () => {
  const m = new Map()
  return {
    on (ev, fn) { if (!m.has(ev)) m.set(ev, new Set()); m.get(ev).add(fn); return this },
    off (ev, fn) { m.get(ev)?.delete(fn); return this },
    emit (ev, v) { for (const fn of [...(m.get(ev) ?? [])]) fn(v) },
    count (ev) { return m.get(ev)?.size ?? 0 },
  }
}

/* ─────────── ① waitUntil：一个轮询循环只写一遍 ─────────── */
section('① waitUntil：已成立 / 会成立 / 等不到 / 被中止')
{
  const c1 = mkClock()
  const r1 = await waitUntil(() => true, { ms: 1000, now: c1.now, sleep: c1.sleep })
  ok(r1.ok === true && r1.reason === 'already', '当场就成立 ⇒ reason=already', JSON.stringify(r1.reason))
  ok(r1.waitedMs === 0 && c1.ticks === 0, '🔴 当场成立时**一次都不睡**（不白等一个 pollMs）', `ticks=${c1.ticks}`)

  const c2 = mkClock()
  let n = 0
  const r2 = await waitUntil(() => (++n >= 3), { ms: 10_000, pollMs: 100, now: c2.now, sleep: c2.sleep })
  ok(r2.ok === true && r2.reason === 'met', '睡几次之后成立 ⇒ reason=met', JSON.stringify(r2.reason))
  ok(r2.waitedMs === 200, 'waitedMs 如实报"等了多久"', String(r2.waitedMs))

  const c3 = mkClock()
  const r3 = await waitUntil(() => false, { ms: 500, pollMs: 100, now: c3.now, sleep: c3.sleep })
  ok(r3.ok === false && r3.reason === 'timeout', '一直不成立 ⇒ reason=timeout', JSON.stringify(r3.reason))
  ok(r3.waitedMs === 500, '🔴 到点就收工，**不会睡穿** deadline（500ms 预算就等 500ms）', String(r3.waitedMs))

  const c4 = mkClock()
  let ran = 0
  const ac = new AbortController()
  ac.abort()
  const r4 = await waitUntil(() => { ran++; return true }, { ms: 1000, now: c4.now, sleep: c4.sleep, signal: ac.signal })
  ok(r4.ok === false && r4.reason === 'aborted', '已经中止 ⇒ reason=aborted', JSON.stringify(r4.reason))
  ok(ran === 0, '🔴 已经中止时**一次 cond 都不跑**（中止优先于"看一眼"）', `ran=${ran}`)

  const c5 = mkClock()
  const ac5 = new AbortController()
  let n5 = 0
  const r5 = await waitUntil(() => (++n5 >= 99), { ms: 10_000, pollMs: 100, now: c5.now, sleep: c5.sleep, signal: ac5.signal, onTick: () => { if (n5 >= 2) ac5.abort() } })
  ok(r5.ok === false && r5.reason === 'aborted', '等的中途被中止 ⇒ reason=aborted', JSON.stringify(r5.reason))
  ok(c5.ticks <= 3, '🔴 中止之后**不再继续轮询**（最多多跑一轮就出来）', `ticks=${c5.ticks}`)

  const c6 = mkClock()
  const r6 = await waitUntil(() => true, { ms: 0, now: c6.now, sleep: c6.sleep })
  ok(r6.ok === true && r6.reason === 'already', '🔴 ms<=0（预算用完了）也**至少看一眼** —— 这是踩坑档案里"谎报没加载好"的教训', JSON.stringify(r6.reason))
  const c7 = mkClock()
  const r7 = await waitUntil(() => false, { ms: -5, now: c7.now, sleep: c7.sleep })
  ok(r7.ok === false && r7.reason === 'timeout' && c7.ticks === 0, 'ms<0 只当场看一次，不睡', `ticks=${c7.ticks}`)

  const c8 = mkClock()
  let ticks8 = 0
  await waitUntil(() => false, { ms: 300, pollMs: 100, now: c8.now, sleep: c8.sleep, onTick: () => { ticks8++ } })
  ok(ticks8 === 3, '🔴 onTick 每轮轮询后跑一次（采样血量这类副作用有地方放）', `ticks=${ticks8}`)

  let threw = ''
  try {
    await waitUntil(() => { throw new Error('判据自己炸了') }, { ms: 100, now: mkClock().now, sleep: mkClock().sleep })
  } catch (e) { threw = String(e?.message ?? e) }
  ok(/判据自己炸了/.test(threw), '🔴 cond 抛错**照样往外抛**（不把真实错误伪装成超时）', threw)

  const c9 = mkClock()
  const r9 = await waitUntil(() => true, { ms: 100, now: c9.now, sleep: c9.sleep, label: '落地' })
  ok(r9.label === '落地', 'label 原样带回（调用方报错时用得上）', String(r9.label))
}

/* ─────────── ② waitForEvent：能等事件就别轮询 ─────────── */
section('② waitForEvent：事件先到 / 过滤 / 超时 / 中止 / 假件')
{
  const em1 = mkEmitter()
  const p1 = waitForEvent(em1, 'blockUpdate', { ms: 5000, label: '方块更新' })
  em1.emit('blockUpdate', { name: 'stone' })
  const r1 = await p1
  ok(r1.ok === true && r1.reason === 'event', '事件响了就收工 ⇒ reason=event', JSON.stringify(r1.reason))
  ok(r1.value?.name === 'stone', '事件载荷原样带回', JSON.stringify(r1.value))
  ok(em1.count('blockUpdate') === 0, '🔴 收工后**监听器摘干净了**（不然跑久了会漏事件/涨内存）', `left=${em1.count('blockUpdate')}`)

  const em2 = mkEmitter()
  const p2 = waitForEvent(em2, 'blockUpdate', { ms: 5000, filter: (v) => v?.name === 'diamond_ore' })
  em2.emit('blockUpdate', { name: 'stone' })
  em2.emit('blockUpdate', { name: 'dirt' })
  em2.emit('blockUpdate', { name: 'diamond_ore' })
  const r2 = await p2
  ok(r2.ok === true && r2.value?.name === 'diamond_ore', '🔴 filter 返回假的事件**不消费**，继续等下一个', String(r2.value?.name))

  const r3 = await waitForEvent(mkEmitter(), 'never', { ms: 60 })
  ok(r3.ok === false && r3.reason === 'timeout', '没人发 ⇒ reason=timeout', JSON.stringify(r3.reason))
  ok(r3.waitedMs >= 50, 'waitedMs 如实报（真等了约 ms 那么久）', String(r3.waitedMs))

  const em4 = mkEmitter()
  const ac4 = new AbortController()
  ac4.abort()
  const r4 = await waitForEvent(em4, 'x', { ms: 5000, signal: ac4.signal })
  ok(r4.ok === false && r4.reason === 'aborted', '已经中止 ⇒ 立刻回 aborted（不挂监听器）', JSON.stringify(r4.reason))
  ok(em4.count('x') === 0, '已中止时不挂监听器', `left=${em4.count('x')}`)

  const em5 = mkEmitter()
  const ac5 = new AbortController()
  const p5 = waitForEvent(em5, 'x', { ms: 5000, signal: ac5.signal })
  setTimeout(() => ac5.abort(), 20)
  const r5 = await p5
  ok(r5.ok === false && r5.reason === 'aborted', '等的中途被中止 ⇒ aborted', JSON.stringify(r5.reason))
  ok(em5.count('x') === 0, '🔴 中途中止也要把监听器摘掉', `left=${em5.count('x')}`)

  const r6 = await waitForEvent(null, 'x', { ms: 100 })
  ok(r6.ok === false && r6.reason === 'no-emitter', '🔴 假件（没有 on）⇒ 回 no-emitter，**不抛**（套件里全是假 bot）', JSON.stringify(r6.reason))

  const em7 = mkEmitter()
  const p7 = waitForEvent(em7, 'a', { ms: 5000 })
  const p8 = waitForEvent(em7, 'a', { ms: 5000 })
  ok(em7.count('a') === 2, '两个等待者各自挂一个监听器', `n=${em7.count('a')}`)
  em7.emit('a', 1)
  await Promise.all([p7, p8])
  ok(em7.count('a') === 0, '两个都收工后监听器归零', `left=${em7.count('a')}`)
}

/* ─────────── ③ 老三样没被改坏 ─────────── */
section('③ sleep / withTimeout / raceAbort / abortError 照旧')
{
  await sleep(1)
  ok(true, 'sleep 还能用')
  const r = await withTimeout(Promise.resolve('ok'), 200, '测试')
  ok(r === 'ok', 'withTimeout 正常路径原样透传')
  let to = null
  try { await withTimeout(new Promise(() => {}), 30, '测试') } catch (e) { to = e }
  ok(to?.mcTimeout === true, 'withTimeout 超时带 mcTimeout', String(to?.mcTimeout))
  const ac = new AbortController()
  ac.abort()
  let ab = null
  try { await raceAbort(new Promise(() => {}), ac.signal, '测试') } catch (e) { ab = e }
  ok(ab?.mcAborted === true, 'raceAbort 已中止时抛 mcAborted 错误', String(ab?.mcAborted))
  ok(abortError('x', ac.signal).mcAborted === true, 'abortError 带 mcAborted')
}

/* ─────────── ④ 接线：六处手写轮询真的都收口了 ─────────── */
section('④ 接线：手写轮询收口（这次改动的**目的**）')
{
  const files = {
    'dig-guard.mjs': read('../src/dig-guard.mjs'),
    'server-break.mjs': read('../src/server-break.mjs'),
    'runtime.mjs': read('../src/runtime.mjs'),
    'world-use.mjs': read('../src/world-use.mjs'),
    'wait.mjs': read('../src/wait.mjs'),
  }
  for (const [f, src] of Object.entries(files)) {
    const no = stripComments(src)
    ok(/import \{[^}]*waitUntil[^}]*\} from '\.\/async-util\.mjs'/.test(no), `${f} 引了 waitUntil`)
    ok(!/while \(Date\.now\(\) - t0 <|while \(now\(\) < deadline\)|while \(!optsReady\(\)/.test(no), `🔴 ${f} 里那手写轮询循环已经没了`)
  }
  ok(/await waitUntil\(\(\) => ent\.onGround !== false/.test(files['dig-guard.mjs']), 'dig-guard：等落地改走 waitUntil')
  ok(/await waitUntil\(\(\) => watch\.hit\(\) \|\| watch\.restored\?\.\(\) != null/.test(files['server-break.mjs']), 'server-break：两个收工条件合成一个判据')
  ok(/await waitUntil\(probe, \{ ms: cap, pollMs: 300/.test(files['runtime.mjs']), 'runtime：等区块改走 waitUntil')
  ok(!/if \(cap <= 0\) return probe\(\)/.test(stripComments(files['runtime.mjs'])), '🔴 runtime 那条 `cap <= 0` 特殊分支**删掉了**（waitUntil 自己就会"至少看一眼"）')
  ok(/await waitUntil\(optsReady, \{ ms: 1_200/.test(files['world-use.mjs']), 'world-use：等附魔选项改走 waitUntil')
  ok(/await waitUntil\(\(\) => slotName\(3\), \{ ms: 1_200/.test(files['world-use.mjs']), 'world-use：等铁砧成品改走 waitUntil')
  ok(/await waitUntil\(\(\) => interruptedNow\(\) \|\| hasFresh\(\)/.test(files['wait.mjs']), 'wait.mjs：mc_events 的等待也收口到 waitUntil')
  ok(/Number\(e\?\.seq \?\? 0\) > fromSeq/.test(files['wait.mjs']), '🔴 队列满 200 条那条老 bug 的修法（按单调 seq 比）没被改掉')

  const order = read('./check-all.mjs')
  ok(/'check-async-util\.mjs'/.test(order), '✅ check-all.mjs 的 ORDER 里登记了这一套')
}

/* ─────────── ⑤ 叶子纪律 ─────────── */
section('⑤ 叶子纪律：这个模块不许长出依赖')
{
  const src = read('../src/async-util.mjs')
  const no = stripComments(src)
  ok(!/from '\.\/core\.mjs'/.test(no), '🔴 不 import core.mjs（会成环）')
  ok(!/from 'mineflayer/.test(no), '🔴 不 import mineflayer')
  ok(!/console\.(log|error)/.test(no), '自己不打 console')
  ok(!/setControlState/.test(no), '不碰控制位（它只管"等"，不管"动"）')
  ok(/export async function waitUntil/.test(no), '导出 waitUntil')
  ok(/export function waitForEvent/.test(no), '导出 waitForEvent')
  ok(/unref/.test(src) === false || /故意不 unref/.test(src), '定时器没有 unref（unref 掉会让"只有它在等"时进程直接退出）')
}

console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
