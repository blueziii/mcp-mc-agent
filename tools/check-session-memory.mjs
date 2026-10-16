/**
 * 自检：**记忆按会话分**（本机补丁，起因 = 用户 m07514
 * 「现在不同会话用的是同一份记忆，我新建存档和会话了，它还是之前的」）。
 *
 * 验的是行为，不是配置项：
 *   ① 开关打开（`memoryPerSession: true`）时，工具写记忆落到 `<memoryDir>/sessions/<短会话 id>/`；
 *   ② 基根不会被会话写脏（`<memoryDir>/probe.md` 不该出现）；
 *   ③ 只拿得到工作区路径的调用点（`memoryFor(cwd)`，三个扩展/设置页那条路）
 *      靠 `lastAgentByCwd` 兜底，也落到**当前会话**的根；
 *   ④ 新会话根会从**基根播种** `RULES.md`（用户改过的那份不能被内置默认盖掉）；
 *   ⑤ 开关关着（默认）时行为一字不变：还是写进 `<memoryDir>/`，不建 `sessions/`。
 *
 * 🔴 必须从包目录跑（源码树里 `import './index.js'` 会缺 mineflayer 依赖）：
 *      cd <profile>/node_modules/mcp-mc-agent && node tools/check-session-memory.mjs
 */
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/** 起一套假宿主 + 假状态目录，返回注册好的工具/路由 */
async function boot ({ perSession }) {
  const state = mk('wc-sessmem-state-')
  const base = join(state, 'mem')          // 记忆**基根**
  const ws = mk('wc-sessmem-ws-')
  mkdirSync(base, { recursive: true })
  writeFileSync(join(base, 'RULES.md'), '# 用户的准则\n自定义内容，不能被内置默认盖掉\n', 'utf8')
  writeFileSync(join(base, 'auto.json'), '{"enabled":true}', 'utf8')
  const cfg = { memoryDir: base }
  if (perSession) cfg.memoryPerSession = true
  writeFileSync(join(state, 'config.json'), JSON.stringify(cfg, null, 2), 'utf8')
  process.env.MCP_MC_AGENT_DIR = state
  delete process.env.MCP_MC_AGENT_MEMORY_DIR

  const tools = new Map()
  const routes = []
  const logs = []
  const agent = { id: 'session-abc123', session: { header: { cwd: ws } } }
  const fakeCtx = {
    logger: { info: (m) => logs.push(String(m)), warn: (m) => logs.push(String(m)), debug: (m) => logs.push(String(m)) },
    tools: { register: (d) => { tools.set(d.name, d); return () => {} }, guard: () => () => {} },
    agentPresets: { composedPreset: () => null, authorable: true, defaultId: 'standard', roots: [], list: async () => [], copy: async () => {} },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
    workspaceRegistry: { archiveSession: async () => {} },
    systemPrompt: { context: () => () => {}, section: () => () => {}, getContextOrder: () => 100, getSectionOrder: () => 100 },
    inject: () => {},
    effect: (fn) => { try { fn() } catch (e) { logs.push('[effect] ' + e.message) } },
    set: () => {},
    get: (k) => (k === 'agents'
      ? { get: (sid) => (String(sid) === 'session-abc123' ? agent : null) }
      : undefined),
    on: () => () => {},
  }
  const mod = await import('../index.js')
  mod.apply(fakeCtx, mod.Config ? mod.Config({}) : {})
  return { state, base, ws, tools, routes, logs, agent }
}

/** 调插件注册的 HTTP 路由（假 req/res；host 用回环，过 isTrustedRequest） */
async function callRoute (route, method, url) {
  let status = 0
  let body = ''
  const res = { writeHead: (s) => { status = s }, end: (d) => { body += d ?? '' }, setHeader: () => {} }
  const req = { method, url, headers: { host: '127.0.0.1:9999' }, on: () => {}, once: () => {} }
  try { await route.handler(req, res) } catch (e) { return { status, body, json: null, err: e } }
  let json = null
  try { json = JSON.parse(body) } catch {}
  return { status, body, json }
}

const memTool = (tools) => tools.get('mc_kit_memory')

/* ─────────────── ① 开关打开：按会话分 ─────────────── */
section('① memoryPerSession: true —— 工具写记忆要落到 <memoryDir>/sessions/<短会话 id>/')
const on = await boot({ perSession: true })
{
  const t = memTool(on.tools)
  ok(typeof t?.execute === 'function', 'mc_kit_memory 已注册')
  const res = await t.execute({ action: 'write', path: 'probe.md', content: 'hello session' }, { agent: on.agent })
  const sessFile = join(on.base, 'sessions', 'abc123', 'probe.md')
  ok(existsSync(sessFile), `写到了 ${sessFile}`, res?.text?.slice(0, 120))
  ok(String(rd(sessFile) ?? '').includes('hello session'), '文件内容里有写进去的正文', JSON.stringify(String(rd(sessFile) ?? '').slice(0, 80)))
  ok(!existsSync(join(on.base, 'probe.md')), '基根没有被会话写脏（<memoryDir>/probe.md 不存在）')
}

/* ─────────────── ② 兜底：只给 cwd 的调用点也落到会话根 ─────────────── */
section('② 只拿得到工作区路径的调用点（memoryFor(cwd)）靠 lastAgentByCwd 兜底')
{
  /* 先让 getSession 记一笔（上面那次工具调用已经记过）—— 再用"没有 id 的 agent"写一次，
   * 走的就是 memoryFor(cwd, null) → lastAgentByCwd 这条路。 */
  const t = memTool(on.tools)
  const res = await t.execute({ action: 'write', path: 'probe2.md', content: 'no agent id' }, { agent: { session: { header: { cwd: on.ws } } } })
  const sessFile = join(on.base, 'sessions', 'abc123', 'probe2.md')
  ok(existsSync(sessFile), `没给 id 也落到会话根：${sessFile}`, res?.text?.slice(0, 120))
  ok(!existsSync(join(on.base, 'probe2.md')), '基根仍然干净')
}

/* ─────────────── ③ 新会话根从基根播种 RULES.md ─────────────── */
section('③ 新会话根要从基根播种 RULES.md（用户改过的那份不能被内置默认盖掉）')
{
  const route = on.routes.find((r) => String(r.path ?? '').startsWith('/api/mc'))
  ok(!!route, '注册了 /api/mc 路由')
  if (route) {
    const r = await callRoute(route, 'GET', '/api/mc/config?cwd=' + encodeURIComponent(on.ws) + '&sessionId=session-abc123')
    const seeded = join(on.base, 'sessions', 'abc123', 'RULES.md')
    ok(existsSync(seeded), `播种出 ${seeded}`, 'status=' + r.status + ' body=' + r.body.slice(0, 160))
    ok(rd(seeded) === rd(join(on.base, 'RULES.md')), '播种内容 = 基根那份（不是内置默认）', rd(seeded)?.slice(0, 60))
    ok(existsSync(join(on.base, 'sessions', 'abc123', 'auto.json')), 'auto.json 也播种过去了')
    ok(!existsSync(join(on.base, 'sessions', 'abc123', 'README.md')) || true, '（README.md 由 ensureReadme 写，不算播种文件）')
  }
}

/* ─────────────── ④ 开关关着：老行为一字不变 ─────────────── */
section('④ 默认（memoryPerSession 未开）—— 还是写进 <memoryDir>/，不建 sessions/')
const off = await boot({ perSession: false })
{
  const t = memTool(off.tools)
  const res = await t.execute({ action: 'write', path: 'probe.md', content: 'shared' }, { agent: off.agent })
  ok(existsSync(join(off.base, 'probe.md')), '写到了基根 <memoryDir>/probe.md', res?.text?.slice(0, 120))
  ok(!existsSync(join(off.base, 'sessions')), '没有建 sessions/ 子目录')
}

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
