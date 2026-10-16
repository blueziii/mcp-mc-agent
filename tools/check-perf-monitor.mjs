/**
 * 性能监测自检（`src/perf-monitor.mjs`）
 *
 * 这一套要钉死三件事：
 *   ① **关掉时零成本、零副作用**（`MCP_MC_AGENT_PERF=off` ⇒ `perfWrap()` 只多一次函数调用）；
 *   ② **判据是 `cpuRatio` 不是 `loop*`** —— `perfVerdict()` 是纯函数，各种数字组合都要试一遍，
 *      免得哪天把"在等服务器"误判成"该搬 Worker"，那就白折腾一轮；
 *   ③ **同步调用的 `loopMax` 记成墙钟** —— 直方图的采样定时器要等事件循环转一圈才触发，
 *      同步函数一返回就读 `h.max` 必然是 0（会把"堵了 120ms"报成"没阻塞"）。
 *
 *   cd <profile>/node_modules/mcp-mc-agent
 *   node tools/check-perf-monitor.mjs
 */
import { readFileSync } from 'node:fs'

const mod = await import(new URL('../src/perf-monitor.mjs', import.meta.url))
const { perfEnabled, perfResolution, perfKeep, perfWrap, perfSnapshot, perfVerdict, perfText, perfReset } = mod

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}`) } else { fail++; console.log(`  ❌ ${label}${extra ? `  → ${extra}` : ''}`) }
}
const section = (t) => console.log(`\n── ${t} ──`)
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const OLD_ENV = { ...process.env }
const restore = () => {
  for (const k of ['MCP_MC_AGENT_PERF', 'MCP_MC_AGENT_PERF_RESOLUTION', 'MCP_MC_AGENT_PERF_KEEP']) {
    if (OLD_ENV[k] == null) delete process.env[k]; else process.env[k] = OLD_ENV[k]
  }
}

/* ═══════════════ ① 纯函数：判据 ═══════════════ */
section('① perfVerdict：把数字翻成"该不该搬 Worker"（纯函数）')
{
  const heavy = perfVerdict([{ name: 'mc_map', wallMs: 180, cpuMs: 170, cpuRatio: 0.94, sync: true }])
  ok(heavy.length === 1 && /值得搬 Worker/.test(heavy[0]) && /mc_map/.test(heavy[0]),
    'CPU 密集（cpuMs≥30 且占比≥0.5）⇒ 判"值得搬 Worker"', JSON.stringify(heavy))
  const wait = perfVerdict([{ name: 'mc_move', wallMs: 9000, cpuMs: 12, cpuRatio: 0.001 }])
  ok(wait.length === 1 && /不要.*搬 Worker/.test(wait[0]) && /mc_move/.test(wait[0]),
    '🔴 在等服务器（墙钟≥1000ms 但 CPU 占比<0.2）⇒ 判"**不要**搬 Worker"', JSON.stringify(wait))
  const small = perfVerdict([{ name: 'mc_status', wallMs: 3, cpuMs: 1, cpuRatio: 0.33 }])
  ok(small.length === 1 && /还没有够多、够大的样本/.test(small[0]), '样本太小 ⇒ 明确说"还没有够多、够大的样本"')
  ok(perfVerdict([]).length === 1, '空数组也给一句结论（不返回空）')
  const both = perfVerdict([
    { name: 'mc_map', wallMs: 180, cpuMs: 170, cpuRatio: 0.94, sync: true },
    { name: 'mc_move', wallMs: 9000, cpuMs: 12, cpuRatio: 0.001 },
  ])
  ok(both.length === 2 && /值得搬 Worker/.test(both[0]) && /不要/.test(both[1]), '两种都有时两条都给')
  ok(/整段是同步的/.test(perfVerdict([{ name: 'x', wallMs: 100, cpuMs: 100, cpuRatio: 1, sync: true }])[0]),
    '同步调用在结论里额外点名"整段是同步的"（那是它比异步更该搬的理由）')
  /* 边界：cpuMs 够大但占比低 ⇒ 不算 CPU 密集（在等 I/O） */
  ok(/不要/.test(perfVerdict([{ name: 'x', wallMs: 5000, cpuMs: 60, cpuRatio: 0.012 }])[0]),
    'cpuMs 有 60 但占比 1.2% ⇒ 归"在等 I/O"，不是 CPU 密集')
  /* 边界：墙钟刚好 1000、占比刚好 0.2 ⇒ 不算"等 I/O"（阈值是 `< 0.2`） */
  ok(/还没有够多/.test(perfVerdict([{ name: 'x', wallMs: 1000, cpuMs: 200, cpuRatio: 0.2 }])[0]),
    '墙钟 1000ms / 占比正好 0.2 ⇒ 两边都不算（阈值是严格小于）')
}

/* ═══════════════ ② 采集：同步 / 异步 / 抛错 ═══════════════ */
section('② 采集：同步、异步、抛错都认')
{
  perfReset()
  await perfWrap('sync-block', () => { const t = Date.now(); while (Date.now() - t < 80) {} return 'done' })
  await perfWrap('async-wait', async () => { await sleep(120); return 'done' })
  let threw = false
  try { await perfWrap('boom', () => { throw new Error('炸了') }) } catch { threw = true }
  ok(threw, '同步抛错照原样往外抛（不吞）')
  const s = perfSnapshot()
  const by = Object.fromEntries(s.calls.map((c) => [c.name, c]))
  ok(s.enabled === true && s.calls.length === 3, '三个动作各一条样本')
  ok(by['sync-block'].wallMs >= 70 && by['sync-block'].cpuRatio >= 0.5,
    `同步阻塞 ⇒ 墙钟与 CPU 都记上了（${by['sync-block'].wallMs}ms / 占比 ${by['sync-block'].cpuRatio}）`)
  ok(by['sync-block'].sync === true, '🔴 同步调用打了 sync 标记')
  ok(by['sync-block'].loopMaxMs >= 70,
    `🔴 同步调用的 loopMax 记成墙钟（不是 0）—— 实测 ${by['sync-block'].loopMaxMs}ms`)
  ok(by['async-wait'].sync === false, '异步调用 sync = false')
  ok(by['async-wait'].wallMs >= 110 && by['async-wait'].cpuRatio < 0.2,
    `等 I/O 的墙钟在但 CPU 占比很低（${by['async-wait'].wallMs}ms / 占比 ${by['async-wait'].cpuRatio}）`)
  ok(by['boom'].n === 1 && by['boom'].cpuRatio == null,
    '抛错的动作照样记一条样本（墙钟≈0 ⇒ 占比记 null，不编个 0 出来骗人）')
  /* 🔴 短样本的占比是噪声：Windows 上 `process.cpuUsage()` 是 ~15.6ms 的节拍，
     实测 5ms 忙循环报 16ms、**20ms 忙循环报 0** —— 拿它算占比会得到 0%/150% 这种假数字。
     所以墙钟不足 RATIO_MIN_WALL_MS(32ms) 一律记 null。这条断言以前是**看运气**的：
     判据 `wallMs && …` 靠四舍五入落到 0 才成立，`new Error()` 抓栈耗时刚好在 0.05ms 上下抖。 */
  await perfWrap('too-short', () => { const t = Date.now(); while (Date.now() - t < 6) {} return 'x' })
  const short = Object.fromEntries(perfSnapshot().calls.map((c) => [c.name, c]))
  ok(short['too-short'].wallMs < 32 && short['too-short'].cpuRatio == null,
    `墙钟 < 32ms 的样本不给占比（实测 ${short['too-short'].wallMs}ms ⇒ 占比 ${short['too-short'].cpuRatio}）`)
  ok(/样本太短/.test(perfText()),
    'perfText 把 "?" 解释清楚（不是坏了，是样本太短）')
  perfReset()
  ok(s.calls[0].wallMs >= s.calls[s.calls.length - 1].wallMs, 'calls 按墙钟从大到小排（先看最慢的）')
  ok(Array.isArray(s.verdict) && s.verdict.length >= 1, 'snapshot 带 verdict')
}
{
  /* 多次调用 ⇒ 取平均，并且 n 计数 */
  perfReset()
  for (let i = 0; i < 3; i++) await perfWrap('rep', () => 1)
  const c = perfSnapshot().calls.find((x) => x.name === 'rep')
  ok(c.n === 3, '同一个动作调 3 次 ⇒ n = 3')
}
{
  /* keep 上限：样本只留最近 N 次 */
  process.env.MCP_MC_AGENT_PERF_KEEP = '2'
  perfReset()
  for (let i = 0; i < 5; i++) await perfWrap('capped', () => 1)
  const c = perfSnapshot().calls.find((x) => x.name === 'capped')
  ok(c.n === 5, 'n 记的是总次数（5）')
  restore()
}
{
  /* 并发：两个动作同时在跑 ⇒ 谁都别记 loop*（直方图是全局的，宁可缺不要假） */
  perfReset()
  const a = perfWrap('p1', async () => { await sleep(60) })
  const b = perfWrap('p2', async () => { await sleep(60) })
  await Promise.all([a, b])
  const calls = perfSnapshot().calls
  const withLoop = calls.filter((c) => c.loopMaxMs != null)
  ok(calls.length === 2 && withLoop.length <= 1,
    `🔴 并发时最多只有"第一个进来的"记 loop*（实测 ${withLoop.length} 条记了）`)
}

/* ═══════════════ ③ 开关与参数 ═══════════════ */
section('③ 开关（关掉必须零成本、零副作用）')
{
  process.env.MCP_MC_AGENT_PERF = 'off'
  ok(perfEnabled() === false, 'MCP_MC_AGENT_PERF=off ⇒ 关掉')
  perfReset()
  const r = await perfWrap('should-not-be-recorded', async () => 42)
  ok(r === 42, '关掉之后 perfWrap 照样把返回值透传')
  const s = perfSnapshot()
  ok(s.enabled === false && s.calls === undefined, '关掉之后 snapshot 说 enabled:false，不记样本')
  ok(/关掉/.test(perfText(s)), '关掉之后 perfText 说清楚是关掉的')
  for (const v of ['0', 'false', 'no', 'none', 'OFF', ' off ']) {
    process.env.MCP_MC_AGENT_PERF = v
    if (perfEnabled() !== false) { ok(false, `MCP_MC_AGENT_PERF=${JSON.stringify(v)} 应该关掉`); break }
  }
  ok(true, '0 / false / no / none / OFF / " off " 都认（大小写与空格都吃掉）')
  process.env.MCP_MC_AGENT_PERF = '1'
  ok(perfEnabled() === true, '不设 / 设成 1 ⇒ 默认开')
  restore()
}
{
  process.env.MCP_MC_AGENT_PERF_RESOLUTION = '25'
  ok(perfResolution() === 25, 'MCP_MC_AGENT_PERF_RESOLUTION 生效')
  process.env.MCP_MC_AGENT_PERF_RESOLUTION = '3'
  ok(perfResolution() === 100, '🔴 分辨率低于 10ms ⇒ 回默认 100（太密会自己变成负担）')
  process.env.MCP_MC_AGENT_PERF_RESOLUTION = '乱写'
  ok(perfResolution() === 100, '分辨率非法 ⇒ 回默认')
  restore()
  process.env.MCP_MC_AGENT_PERF_KEEP = '5'
  ok(perfKeep() === 5, 'MCP_MC_AGENT_PERF_KEEP 生效')
  process.env.MCP_MC_AGENT_PERF_KEEP = '0'
  ok(perfKeep() === 20, 'keep 为 0 ⇒ 回默认 20（不能一个都不留）')
  restore()
}
{
  perfReset()
  await perfWrap('x', () => 1)
  ok(perfReset() === true && perfSnapshot().calls.length === 0, 'perfReset() 清空样本')
  const s = perfSnapshot()
  ok(/📊 性能监测/.test(perfText(s)) && /还没采到样本/.test(perfText(s)), 'perfText 在没样本时给一句"还没采到样本"')
}
{
  perfReset()
  await perfWrap('x', () => 1)
  const t = perfText()
  ok(/动作 ｜ 次数 ｜ 墙钟\(均\) ｜ CPU\(均\) ｜ CPU占比/.test(t), 'perfText 有表头')
  ok(/· x ｜ 1 ｜/.test(t), 'perfText 每个动作一行')
}

/* ═══════════════ ④ 静态接线 ═══════════════ */
section('④ 静态接线')
{
  const idx = strip(read('../index.js'))
  const self = strip(read('../src/perf-monitor.mjs'))
  ok(/import \{ perfWrap, perfSnapshot, perfText, perfReset \} from '\.\/src\/perf-monitor\.mjs'/.test(idx),
    'index.js 从 src/perf-monitor.mjs 导入（不往 core.mjs 加薄包装 —— 它贴着 1000 行上限）')
  ok(/perfWrap\(spec\.name, \(\) => runScheduled\(/.test(idx),
    '🔴 唯一的工具入口 asTool.execute 包了 perfWrap（这样"每个工具"都被量到）')
  ok(/const perf = perfSnapshot\(\)/.test(idx) && /perf,/.test(idx), 'mc_diag 的返回里带 perf')
  ok(/resetPerf/.test(idx), 'mc_diag 支持 resetPerf（换场景重测）')
  ok(!/require\(|import .*mineflayer|prismarine/.test(self), '🔴 perf-monitor 不 import 任何游戏库（纯 Node，好测）')
  ok(!/from '\.\/core\.mjs'/.test(self), '🔴 perf-monitor 不反向 import core.mjs（会循环导入）')
  ok(/if \(!perfEnabled\(\)\) return fn\(\)/.test(self), '🔴 关掉时零成本：直接 return fn()，连 hrtime 都不取')
  ok(!/console\.log/.test(self), 'perf-monitor 自己不打 console（输出走 mc_diag / 日志）')
  const docs = read('../README.md')
  ok(/MCP_MC_AGENT_PERF/.test(docs), 'README 的配置速查里写了这几个环境变量')
  const all = read('./check-all.mjs')
  ok(/check-perf-monitor\.mjs/.test(all) && /check-action-scheduler\.mjs/.test(all),
    'check-all.mjs 的 ORDER 里登记了这两套（跑的顺序稳定）')
}

restore()
console.log(`\n${'─'.repeat(50)}`)
console.log(`check-perf-monitor：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
