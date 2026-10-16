/**
 * 自检：**看门狗唤醒投递** —— 两条路都要钉死。
 *
 * 背景（dsh 版真机 bug 回归，2026-09-15）：看门狗检测正常（woke:true）、但注入报
 *   `Cannot read properties of undefined (reading 'throwIfAborted')`
 * 根因：`sessionController.prompt` 是 @Remote 方法，签名 (request, signal)，
 *   内部第一行就是 `signal.throwIfAborted()` —— 只传 1 个参数必炸。
 * 那条路是**空闲时唯一的叫醒通道**，一炸就等于永远叫不醒。
 *
 * MCP 版（2026-10-16）新增第二条路：MCP 里既没有 `agent.steer` 也没有
 * `sessionController`，唤醒只能靠 `ctx.__mcpWake(text, kind, running)`
 * （server.mjs 把它接到「会话事件队列 + MCP logging notification」）。
 * 这一段**必须排在 sessionController 兜底之前**，否则 MCP 下永远记成"注入失败"。
 *
 * 覆盖：
 *   A. `__mcpWake` 路径（MCP 正常情况）：空闲/运行中都能投、闸门能挡能放、disarm 生效
 *   B. `sessionController.prompt` 兜底（真机 bug 回归）：必须带 signal，空闲走 steer
 *   C. 两条路都没有 → 必须把"投不出去"塞进会话事件队列（不能只写看门狗自己的 log）
 *
 * 🔴 必须从包目录跑（源码树里 import 会缺 minecraft 依赖）：
 *      cd <profile>/node_modules/mcp-mc-agent && node tools/check-watchdog-mcp.mjs
 */
import { EventEmitter } from 'node:events'

const { Watchdog } = await import('../src/watchdog.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假会话：只需要 bot(EventEmitter) / events / pushEvent / interruptWait */
function makeSess () {
  const events = []
  const sess = {
    bot: new EventEmitter(),
    events,
    agentId: 'sess-w',
    config: {},
    pushEvent: (kind, text) => events.push({ kind, text }),
    interruptWait: (kind) => events.push({ kind: 'interrupted', text: kind }),
  }
  return sess
}

function makeWd ({ ctx, sess, status = 'idle' }) {
  const wd = new Watchdog({
    ctx,
    sess,
    agent: { id: 'sess-w', status },
    onFire: () => {},
    promptSignal: new AbortController().signal,
  })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  wd.arm()
  return wd
}

/** 往游戏里说一句话，等看门狗跑完（观察窗 + 冷却） */
async function fire (wd, sess, text) {
  sess.bot.emit('chat', { who: '<user>', text })
  await sleep(1400)
}

/* ── A. MCP 路径：ctx.__mcpWake ─────────────────────────────────────────── */
console.log('\n--- A. MCP 唤醒路径（ctx.__mcpWake）---')
{
  const delivered = []
  const wake = (text, kind, running) => delivered.push({ text, kind, running })
  const sess = makeSess()
  const wd = makeWd({
    ctx: { logger: { info: () => {}, warn: () => {} }, get: (k) => (k === '__mcpWake' ? wake : undefined) },
    sess,
  })

  await fire(wd, sess, 'deepseek，你在这里建一座地标塔')
  ok(delivered.length === 1, `空闲时把唤醒投给了 __mcpWake（${delivered.length} 次）`)
  ok(/deepseek/.test(delivered[0]?.text ?? ''), '投出去的正文带上原始消息')
  ok(typeof delivered[0]?.kind === 'string' && delivered[0].kind.length > 0, `带上事件种类：${delivered[0]?.kind}`)
  ok(delivered[0]?.running === false, '空闲时 running=false（server 侧据此决定通知级别）')
  ok(wd.stats.injected >= 1, `注入计数已累加（${wd.stats.injected}）`)
  ok(sess.events.some((e) => e.kind === 'interrupted'), '投递成功后才打断等待（interruptWait 被调用）')

  delivered.length = 0
  wd.agent = { id: 'sess-w', status: 'running' }
  await fire(wd, sess, 'deepseek 在吗')
  ok(delivered.length === 1 && delivered[0]?.running === true, '运行中也能投（running=true），不打断生成')

  // 🔴 闸门：会话切出 MC 模式后不许再投（同类残留）
  delivered.length = 0
  const droppedBefore = wd.stats.dropped
  wd.gate = () => false
  await fire(wd, sess, 'deepseek 又在吗')
  ok(delivered.length === 0, `闸门关着 → 一次都不投（实际 ${delivered.length} 次）`)
  ok(wd.stats.dropped > droppedBefore, `被丢弃的注入记进 stats.dropped（${wd.stats.dropped}）`)

  wd.gate = () => true
  await fire(wd, sess, 'deepseek 回来了吗')
  ok(delivered.length >= 1, `闸门打开 → 立刻恢复投递（${delivered.length} 次；不用重新 arm）`)

  wd.disarm('自检结束')
  ok(wd.armed === false, 'disarm 后停止监听')
}

/* ── B. sessionController 兜底（真机 bug 回归）───────────────────────────── */
console.log('\n--- B. sessionController 兜底（prompt 必须带 signal）---')
{
  const deliver = []
  const hostLike = {
    // 照抄 api/session-controller/src/index.ts:346 的行为
    prompt: (request, signal) => { signal.throwIfAborted(); deliver.push(request); return Promise.resolve({ accepted: true }) },
    cancel: () => ({ accepted: true }),
  }
  const sess = makeSess()
  // 注意：**没有** __mcpWake —— 模拟"宿主桩没接上"的降级情形
  const wd = makeWd({
    ctx: { logger: { info: () => {}, warn: () => {} }, get: (k) => (k === 'sessionController' ? hostLike : undefined) },
    sess,
  })

  await fire(wd, sess, 'deepseek，你在这里建一座地标塔')
  const got = deliver[0]
  ok(got, `空闲时能真正投递出去（${deliver.length} 次）`)
  ok(got?.mode === 'steer', `空闲也走 steer（宿主语义：idle 会起一轮=唤醒）：mode=${got?.mode}`)
  ok(/deepseek/.test(got?.content?.[0]?.text ?? ''), '注入正文带上原始消息')
  ok(got?.sessionId === 'sess-w', '绑定到正确会话')
  ok(sess.events.every((e) => e.kind !== 'lifecycle' || !/注入没投出去/.test(e.text)), '没有记成"注入失败"')
  wd.disarm('自检结束')
}

/* ── C. 两条路都没有 → 必须落到会话事件队列 ─────────────────────────────── */
console.log('\n--- C. 两条路都没有 → 失败原因必须进会话事件队列 ---')
{
  const sess = makeSess()
  const wd = makeWd({ ctx: { logger: { info: () => {}, warn: () => {} }, get: () => undefined }, sess })

  await fire(wd, sess, 'deepseek，你在这里建一座地标塔')
  const life = sess.events.filter((e) => e.kind === 'lifecycle')
  ok(life.some((e) => /注入没投出去/.test(e.text)), '失败原因塞进了会话事件队列（AI 能看见"刚才想叫你、没投出去"）')
  ok(life.some((e) => /没有 agent\.steer，也没有 sessionController\.prompt/.test(e.text)), `失败原因文案明确：${life.map((e) => e.text).join(' / ').slice(0, 90)}`)
  ok(wd.stats.injected === 0, `一次也没算成注入成功（injected=${wd.stats.injected}）`)
  wd.disarm('自检结束')
}

/* ── D. 看门狗 job 必须能结算（隐患：job 卡在 stopping）────────────────────── */
// 根因：`_resolveJob` 存了但从没调用 → done 永不 resolve → job_list 里永远挂着。
// 2026-09-16 真机 bug：**主动** disarm 那条路漏了结算 → UI 一直显示"还有 1 个后台任务 / 正在停止"。
console.log('\n--- D. 看门狗 job 结算（宿主 jobs 桩）---')
{
  let hooks = null
  let startSpec = null
  const kills = []
  const killCallers = []
  const wdCtx = {
    logger: { info: () => {}, warn: () => {} },
    get: (k) => (k === 'jobs'
      ? {
          start: (spec) => { startSpec = spec; hooks = spec.run(); return 'job-1' },
          kill: (id, caller) => { killCallers.push(caller); kills.push(id) },
        }
      : undefined),
  }
  const mk = () => new Watchdog({
    ctx: wdCtx,
    sess: { bot: new EventEmitter(), events: [], agentId: 's', config: {} },
    agent: { id: 's' },
    onFire: () => {},
  })

  const wd = mk()
  wd.arm()
  ok(!!hooks, `job 已挂上（${wd.jobId}）`)
  // 🔴 owner 必须是**会话 id 字符串**：宿主 `resolveOwner()` 拿它查 agents 注册表
  //    （`agents.get(session)`，按 id 索引）——传 agent 对象必炸
  //    `session "[object Object]" has no live agent`，job 挂不上、静默降级成"无 job 模式"。
  ok(typeof startSpec?.owner === 'string' && startSpec.owner === 's', `🔴 start 的 owner 是会话 id 字符串（收到：${JSON.stringify(startSpec?.owner)}）`)

  let settled = null
  hooks.done.then((v) => { settled = v })
  hooks.cancel('宿主取消')
  await sleep(30)
  ok(!!settled, `done 被结算（不再永远挂在 stopping）：status=${settled?.status}`)
  ok(kills.length === 0, `不回头 kill 自己（避免自我递归）：kill 调用 ${kills.length} 次`)
  ok(wd.armed === false, 'job 被取消后看门狗也已停')

  // 反向：AI 主动 disarm → 应该真去 kill 那个 job **并且把 done 结算掉**
  const wd2 = mk()
  wd2.arm()
  const hooks2 = hooks
  let settled2 = null
  hooks2.done.then((v) => { settled2 = v })
  kills.length = 0
  wd2.disarm('AI 主动关闭')
  await sleep(30)
  ok(kills.includes('job-1'), `AI 主动 disarm 会去 kill job（${kills.join(',') || '没调'}）`)
  ok(!!settled2, `🔴 **主动** disarm 也结算了 done（否则宿主的 job 永远停在 stopping）：status=${settled2?.status}`)

  // 宿主随后回调 cancel()（我们 kill 之后宿主一定会走这一步）→ 幂等
  let cancelThrew = null
  try { hooks2.cancel('宿主随后取消') } catch (e) { cancelThrew = e }
  await sleep(30)
  ok(!cancelThrew, `再次进 disarm（已停用状态）不抛错：${cancelThrew ? cancelThrew.message : 'ok'}`)
  ok(kills.length === 1, `已停用后不再重复 kill（kill 调用仍 ${kills.length} 次）`)

  // 极端：没 arm 过就直接 disarm（例如重复点"强制停止"）也不能抛
  let threw = null
  try { mk().disarm('没在跑也要能调') } catch (e) { threw = e }
  ok(!threw, '未启动时 disarm 幂等不抛错')

  // 🔴 kill 的 caller 也必须是会话 id 字符串
  //    （宿主 `assertAccess`：`job.owner.id !== caller → throw "belongs to another session"`）
  ok(killCallers.length > 0 && killCallers.every((c) => c === 's'), `🔴 kill 的 caller 是会话 id 字符串（收到：${JSON.stringify(killCallers)}）`)

  // 🔴 拿不到会话 id → **不许挂"无主 job"**（无主 job 对**所有会话**可见）：降级 + 留档
  const wdNoId = new Watchdog({ ctx: wdCtx, sess: { bot: new EventEmitter(), events: [], config: {} }, onFire: () => {} })
  wdNoId.arm()
  ok(wdNoId.jobId === null && (wdNoId.log ?? []).some((e) => /拿不到会话 id/.test(e.text)), '拿不到会话 id：不挂无主 job（降级 + 留档）')
  wdNoId.disarm('自检结束')
}

/* ── E. MCP 宿主桩的 jobs 服务必须真的能挂 job ────────────────────────────── */
// 🔴 2026-10-16 自查抓到的真 bug：`mcp/host.mjs` 的 `makeJobRegistry()` 原来只有
//    `register`，没有宿主 `jobs-local` 真正的 `start(spec)` ⇒ 每次 `arm()` 都撞
//    TypeError 被 catch 吞掉、静默降级成"无 job 模式"（`mc_stop` 就清不掉看门狗）。
console.log('\n--- E. MCP 宿主桩的 jobs 服务 ---')
{
  const { createHost } = await import('../mcp/host.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-wd-jobs-'))
  const host = createHost({ cwd, onWake: () => {}, log: () => {} })
  const jobs = host.ctx.get('jobs')

  ok(typeof jobs?.start === 'function', 'host.ctx.get("jobs") 有 start()（宿主 jobs-local 的真接口）')
  ok(typeof jobs?.list === 'function' && typeof jobs?.kill === 'function', 'jobs 有 list() / kill()')

  const sess = { bot: new EventEmitter(), events: [], agentId: 'mcp', config: {}, pushEvent: () => {}, interruptWait: () => {} }
  const wd = new Watchdog({ ctx: host.ctx, sess, agent: { id: 'mcp', status: 'idle' }, onFire: () => {} })
  wd.arm()
  ok(typeof wd.jobId === 'string' && wd.jobId.length > 0, `看门狗真挂上了 job（${wd.jobId}）`)
  ok(!(wd.log ?? []).some((e) => /挂 job 失败/.test(e.text)), `没有降级成"无 job 模式"（${(wd.log ?? []).map((e) => e.text).filter((t) => /job/.test(t)).join(' | ').slice(0, 80)}）`)
  ok(jobs.list('mcp').length === 1, `jobs.list("mcp") 能看到它（${jobs.list('mcp').length} 个）`)
  ok(jobs.list('别的会话').length === 0, '别的会话看不到它（不是无主 job）')

  // 模拟 mc_stop 的强清路径：list → 按 owner 过滤 → kill
  const mine = jobs.list('mcp').filter((j) => String(j.owner) === 'mcp')
  ok(mine.length === 1 && typeof mine[0].id === 'string', 'mc_stop 的强清路径能认出"本会话的 job"')
  jobs.kill(mine[0].id, 'mcp', 'mc_stop 强清')
  await sleep(30)
  ok(wd.armed === false, 'kill 之后看门狗真的停了')
  ok(jobs.list('mcp').length === 0, '已结算的 job 自动从 list 里摘掉（不会永远挂着）')

  host.dispose()
  try { rmSync(cwd, { recursive: true, force: true }) } catch {}
}

// ---------------------------------------------------------------------------
// F. 伪 agent 上的 `steer` —— MCP 版的"叫醒"通道
//
//    真机风险：DSH 下"叫醒 AI"唯一的通道是宿主给的 `agent.steer()`。MCP 没有这个能力，
//    所以桩上必须补一个、并接到 onWake。**没有它的话**，全仓那些守卫式的调用点
//    （`src/watchdog.mjs:660` 的 `typeof agent.steer === 'function'`、
//      `extensions/mc_auto.mjs:818` 的 `return 'none'`、`:1134` 的"没人值守就只记档"）
//    会**静默退化**：自主层的"被怪打叫醒 AI"、"水下恢复报账"、"空闲决策层叫醒"
//    一条都发不出去，而且不报错、不写日志。这个坑只能靠断言盯住。
// ---------------------------------------------------------------------------
console.log('\n--- F. 伪 agent 的 steer → onWake（MCP 版的"叫醒"） ---')
{
  const { createHost } = await import('../mcp/host.mjs')
  const { userMessage } = await import('../src/user-message.mjs')
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const cwd = mkdtempSync(join(tmpdir(), 'mcp-wd-steer-'))
  const woken = []
  const host = createHost({ cwd, onWake: (text, kind, running) => woken.push({ text, kind, running }), log: () => {} })

  ok(typeof host.agent?.steer === 'function', '伪 agent 有 steer()（否则自主层的叫醒通道全哑）')

  /* ① 标准形状：`userMessage()`（mc_auto / 看门狗都这么造） */
  host.agent.steer(userMessage({
    content: [{ type: 'text', text: '有僵尸贴脸（8 格）' }],
    source: { kind: 'plugin:mcp-mc-agent', form: 'danger', summary: '危险' },
  }))
  ok(woken.length === 1 && woken[0].text === '有僵尸贴脸（8 格）', 'steer(userMessage) 把正文送到了 onWake', JSON.stringify(woken[0]?.text))
  ok(woken[0]?.kind === 'danger', 'source.form 当 kind 传下去（日志里看得出是哪类唤醒）', String(woken[0]?.kind))

  /* ② 裸字符串也认（有的调用点图省事） */
  host.agent.steer('  水下憋气 10 秒了  ')
  ok(woken.length === 2 && woken[1].text === '水下憋气 10 秒了', 'steer("字符串") 也认（且 trim 过）', JSON.stringify(woken[1]?.text))

  /* ③ 多段 content 拼起来；空 content 不发（别往队列里塞空行） */
  host.agent.steer({ content: [{ type: 'text', text: '第一行' }, { type: 'image', data: 'x' }, { type: 'text', text: '第二行' }] })
  ok(woken.length === 3 && woken[2].text === '第一行\n第二行', '多段 content 拼接，非文本块跳过', JSON.stringify(woken[2]?.text))
  const before = woken.length
  host.agent.steer({ content: [] })
  host.agent.steer({ content: [{ type: 'image', data: 'x' }] })
  host.agent.steer('')
  host.agent.steer(undefined)
  ok(woken.length === before, '空正文不往事件队列里塞（4 次空调用一个都没发）', `发了 ${woken.length - before} 条`)

  /* ④ 关键：真看门狗 + 桩的 ctx/agent ⇒ `#inject` 走 agent.steer 这条路，
   *    但仍然必须到达 onWake（不能因为"桩上有 steer 了"就把唤醒吞在半路）。 */
  const sess = { bot: new EventEmitter(), events: [], agentId: 'mcp', config: {}, pushEvent: () => {}, interruptWait: () => {} }
  const wd = new Watchdog({ ctx: host.ctx, sess, agent: host.agent, onFire: () => {} })
  wd.updateConfig({ observeWindowMs: 100, maxWakePerMinute: 100 })
  const base = woken.length
  wd.arm()
  sess.bot.emit('chat', { who: '<user>', text: 'deepseek，过来一下' })
  await sleep(1400)
  const got = woken.slice(base)
  ok(got.length >= 1, '看门狗唤醒经 agent.steer 也照样到 onWake（没被吞）', `${got.length} 条`)
  ok(got.some((w) => w.text.includes('deepseek')), '唤醒正文带原消息', got.map((w) => w.text.slice(0, 40)).join(' | '))
  ok(wd.stats.injected >= 1, 'stats.injected 记上了（不是"注入失败"）', String(wd.stats.injected))
  ok(!(wd.log ?? []).some((e) => /注入没投出去/.test(e.text)), '没有被记成"注入失败"')
  wd.disarm('测试收尾')

  host.dispose()
  try { rmSync(cwd, { recursive: true, force: true }) } catch {}
}

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
