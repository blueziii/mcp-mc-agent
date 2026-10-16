/* 验的是行为，不是配置项：`--http` 传输（Streamable HTTP）真能握手、列工具、调工具、拒非法请求。
 *
 * 为什么单独立一个套件：`mcp/selfcheck-mcp.mjs` 走的是 **stdio**（客户端最常见的那条路），
 * 而 `--http` 是完全不同的一段代码（`StreamableHTTPServerTransport` + 手写 `node:http`
 * 路由 + `Mcp-Session-Id` 会话头校验）。stdio 全绿不代表 HTTP 全绿 —— 这段以前没人跑过。
 *
 * 🔴 必须从包目录跑：`node tools\check-mcp-http.mjs`
 *
 * 覆盖：
 *   ① `/health` 与 `/` 的探活响应（server 名 / 版本 / 工具数）
 *   ② initialize 握手（serverInfo、capabilities.tools、回带 `Mcp-Session-Id`）
 *   ③ tools/list（34 个，inputSchema 全是 object）
 *   ④ tools/call（`mc_status` / `mc_events` 真跑通，不是只回个壳）
 *   ⑤ resources/list（四个 `mc://`）
 *   ⑥ 错误路径：不带 `Mcp-Session-Id` 的请求**必须被拒**（不能静默成功）、未知路径 404
 *
 * 端口是**现取空闲口**，不写死 —— 免得和本机真跑着的 server 撞车。 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SERVER = join(ROOT, 'mcp', 'server.mjs')
const stateDir = mkdtempSync(join(tmpdir(), 'mcp-http-probe-'))
const cwd = mkdtempSync(join(tmpdir(), 'mcp-http-ws-'))

/* 现取一个空闲端口：绑 0 让内核挑，拿到就立刻放掉。 */
const PORT = await new Promise((ok, no) => {
  const probe = createServer()
  probe.on('error', no)
  probe.listen(0, '127.0.0.1', () => {
    const p = probe.address().port
    probe.close(() => ok(p))
  })
})

const VERBOSE = ['1', 'true', 'yes'].includes(String(process.env.MCP_MC_AGENT_VERBOSE ?? '').toLowerCase())
const child = spawn(process.execPath, [SERVER, '--http', String(PORT), '--cwd', cwd, '--state-dir', stateDir], {
  cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
})
/* 子进程日志默认咽掉（启动那几十行会淹掉断言），`MCP_MC_AGENT_VERBOSE=1` 时才透传。
 * 不管透不透传，都留一份尾巴 —— 起不来的时候全靠它说清原因。 */
let childTail = ''
const tail = (d) => {
  childTail = (childTail + String(d)).slice(-4000)
  if (VERBOSE) process.stderr.write(`[child] ${d}`)
}
child.stdout.on('data', tail)
child.stderr.on('data', tail)

const base = `http://127.0.0.1:${PORT}`
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let rpcId = 0
let sessionId = null
async function rpc(method, params, { notify = false } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }
  if (sessionId) headers['mcp-session-id'] = sessionId
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params }
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) })
  const sid = res.headers.get('mcp-session-id')
  if (sid) sessionId = sid
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 可能是 SSE */ }
  return { status: res.status, json, text, sessionId: sid }
}

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

try {
  // 等端口起来（子进程要跑完 apply() + 等扩展注册完工具表，通常 ~500ms）
  let health = null
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/health`)
      health = await r.json()
      break
    } catch { await wait(250) }
  }
  if (!health) throw new Error(`HTTP server 15 秒没起来。子进程最后输出：\n${childTail}`)

  console.log('\n【1】健康检查 /health')
  ok(Boolean(health.ok), 'GET /health 回 ok', JSON.stringify(health))
  ok(health.server === 'mcp-mc-agent', 'server 名正确', String(health.server))
  ok(health.tools >= 34, '工具数 >= 34', String(health.tools))
  ok(health.version === '0.1.0', 'version 来自 package.json', String(health.version))

  console.log('\n【2】握手')
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'check-mcp-http', version: '0.0.0' },
  })
  ok(init.status === 200, 'initialize HTTP 200', String(init.status))
  ok(init.json?.result?.serverInfo?.name === 'mcp-mc-agent', 'serverInfo.name', String(init.json?.result?.serverInfo?.name))
  ok(Boolean(init.json?.result?.capabilities?.tools), 'capabilities.tools 存在')
  ok(Boolean(init.json?.result?.capabilities?.resources), 'capabilities.resources 存在')
  ok(Boolean(init.sessionId), '回带了 Mcp-Session-Id', String(init.sessionId))
  const inited = await rpc('notifications/initialized', {}, { notify: true })
  ok(inited.status < 400, 'initialized 通知被接受', String(inited.status))

  console.log('\n【3】tools/list')
  const list = await rpc('tools/list', {})
  const tools = list.json?.result?.tools ?? []
  ok(tools.length === 34, '34 个工具', String(tools.length))
  ok(tools.every((t) => t.inputSchema?.type === 'object'), '每个 inputSchema 都是 object')
  ok(tools.every((t) => t.name.startsWith('mc_')), '工具名都以 mc_ 开头')

  console.log('\n【4】tools/call')
  const st = await rpc('tools/call', { name: 'mc_status', arguments: {} })
  const stText = st.json?.result?.content?.find((c) => c.type === 'text')?.text ?? ''
  ok(st.status === 200 && !st.json?.result?.isError, 'mc_status 成功', stText.slice(0, 40))
  const ev = await rpc('tools/call', { name: 'mc_events', arguments: { limit: 3 } })
  const evText = ev.json?.result?.content?.find((c) => c.type === 'text')?.text ?? ''
  ok(evText.length > 0, 'mc_events 回了非空文本', evText.slice(0, 40))
  /* 非法入参走 HTTP 也要照旧报错，而不是把 500 冒出去 */
  const bad = await rpc('tools/call', { name: 'mc_events', arguments: { limit: 'not-a-number' } })
  ok(bad.status === 200 && bad.json?.result?.isError === true, '非法入参在 HTTP 上也被正确拒绝', `status=${bad.status} isError=${bad.json?.result?.isError}`)

  console.log('\n【5】resources/list')
  const res = await rpc('resources/list', {})
  const uris = (res.json?.result?.resources ?? []).map((r) => r.uri)
  for (const u of ['mc://prompt', 'mc://rules', 'mc://state', 'mc://wake-log']) {
    ok(uris.includes(u), `resources 含 ${u}`)
  }
  const readState = await rpc('resources/read', { uri: 'mc://state' })
  const stateText = readState.json?.result?.contents?.[0]?.text ?? ''
  ok(stateText.includes('mcp-mc-agent'), 'mc://state 能读出来且是 JSON', stateText.slice(0, 40))

  console.log('\n【6】无 session 头 / 错误路径')
  const saved = sessionId
  sessionId = null
  const noSid = await rpc('tools/list', {})
  sessionId = saved
  ok(noSid.status >= 400 || noSid.json?.error, '没有 session 头时被拒（不是静默成功）', `status=${noSid.status} ${noSid.json?.error?.message ?? ''}`)
  const nf = await fetch(`${base}/nope`)
  ok(nf.status === 404, '未知路径 404', String(nf.status))
} catch (e) {
  fail++
  console.log(`  ❌ 套件异常：${e?.stack ?? e}`)
} finally {
  child.kill('SIGTERM')
  await Promise.race([new Promise((r) => child.once('exit', r)), wait(2000)])
  child.kill('SIGKILL')
  try { rmSync(stateDir, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }) } catch { /* ignore */ }
}

console.log(`\n${fail === 0 ? '✅ HTTP 传输全过' : '❌ HTTP 传输有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
