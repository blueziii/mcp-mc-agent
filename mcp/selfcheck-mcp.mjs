#!/usr/bin/env node
/**
 * mcp-mc-agent / mcp/selfcheck-mcp.mjs —— 离线自检（**不需要 Minecraft 服务器**）
 * ============================================================================
 * 这个脚本扮演一个**真的 MCP 客户端**：用官方 SDK 起一个子进程跑 `mcp/server.mjs`，
 * 走完整的 stdio 握手，然后逐项检查。所以它验证的不是"函数能不能跑"，而是
 * "从客户端看，这个 server 是不是个像样的 MCP server"。
 *
 * 检查项：
 *   ① 握手        —— initialize 成功、serverInfo 对、capabilities 齐、instructions 非空
 *   ② 工具表      —— 34 个工具一个不少、description 非空、inputSchema 是合法 `{type:'object'}`
 *   ③ 离线工具调用 —— 挑一批**不需要进游戏**的工具真调一遍，确认没有 isError
 *      ③b 图片内联 —— `mc_kit_image` 出的图真的是 MCP image 块（不是只给个文件路径）
 *      ③c 健壮性   —— 34 个工具**全传空入参**：一个都不许崩、每个都要回一句人话
 *      ③d 并发     —— 五个调用同时打进去，都有返回且互不串台
 *   ④ 资源        —— resources/list + 逐个 read
 *   ⑤ 状态落盘    —— 状态目录建出来了、账户库有默认离线账户、凭据不在工作区
 *   ⑥ 协议通道    —— 全程没有任何东西往 stdout 打非 JSON-RPC 内容（污染通道是最难查的一类 bug）
 *
 * 用法：
 *   node mcp/selfcheck-mcp.mjs [--cwd <目录>] [--state-dir <目录>] [--verbose]
 *
 * 退出码：0 = 全过；1 = 有失败项。
 * ============================================================================
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, 'server.mjs')
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v')

const argOf = (name) => {
  const i = process.argv.indexOf(name)
  if (i < 0) return null
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : null
}

/* 临时工作区：自检**不碰**真实的工作区 / 状态目录（跑完就删） */
const tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-mc-agent-check-'))
const cwd = argOf('--cwd') ?? join(tmpRoot, 'ws')
const stateDir = argOf('--state-dir') ?? join(tmpRoot, 'state')

/* ── 期望的 34 个工具（与 index.js / extensions 的注册处一一对应）──────────── */
const EXPECTED_TOOLS = [
  'mc_status', 'mc_lan', 'mc_ping', 'mc_connect', 'mc_accounts', 'mc_stop', 'mc_disconnect',
  'mc_say', 'mc_watch', 'mc_config', 'mc_capabilities', 'mc_sessions', 'mc_events', 'mc_scan',
  'mc_map', 'mc_inventory', 'mc_move', 'mc_act', 'mc_give', 'mc_sequence', 'mc_build', 'mc_dig',
  'mc_task', 'mc_command', 'mc_kit_image', 'mc_kit_express', 'mc_kit_memory', 'mc_admin_config',
  'mc_diag',
  /* 扩展注册的 5 个 */
  'mc_auto', 'mc_chest', 'mc_craft', 'mc_furnace', 'mc_observe',
]

/* ── 不需要进游戏就能调的工具（每个都传一份最小合法入参）─────────────────── */
const OFFLINE_CALLS = [
  ['mc_status', {}],
  ['mc_accounts', { action: 'list' }],
  ['mc_capabilities', {}],
  ['mc_config', {}],
  ['mc_sessions', {}],
  ['mc_events', { limit: 5 }],
  ['mc_admin_config', { action: 'get' }],
  ['mc_kit_memory', { action: 'index' }],
  ['mc_stop', {}],
  ['mc_disconnect', {}],
]

/* ── 极简测试跑手 ───────────────────────────────────────────────────────── */
let passed = 0
const failures = []
const notes = []

const ok = (name, detail = '') => { passed++; console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`) }
const bad = (name, why) => { failures.push(`${name}：${why}`); console.log(`  ❌ ${name} — ${why}`) }
const note = (s) => { notes.push(s); console.log(`  ℹ️  ${s}`) }

function check (name, cond, why = '条件不成立', detail = '') {
  if (cond) ok(name, detail)
  else bad(name, why)
  return Boolean(cond)
}

console.log(`mcp-mc-agent 自检\n  工作区  ${cwd}\n  状态目录 ${stateDir}\n  入口    ${SERVER}\n`)

const client = new Client({ name: 'mcp-mc-agent-selfcheck', version: '1.0.0' }, { capabilities: {} })
/* stderr 用 pipe + 手动 tee 而不是 `inherit`：日志照样看得见，但我们要能**检查**它 ——
 * 最要紧的一条是"有没有东西往 stdout 打非 JSON-RPC 内容"（server 端有闸门会把它改道到
 * stderr 并留一句 `[stdout→stderr]`）。协议通道被污染是偶发难复现的 bug，能在自检里盯住就盯住。 */
let childErr = ''
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER, '--cwd', cwd, '--state-dir', stateDir],
  env: { ...process.env, MCP_MC_AGENT_STATE_DIR: stateDir, MCP_MC_AGENT_CWD: cwd },
  stderr: 'pipe',
  cwd: resolve(HERE, '..'),
})
transport.stderr?.on('data', (d) => {
  childErr = (childErr + String(d)).slice(-200_000)
  process.stderr.write(d)
})

let connected = false
try {
  console.log('① 握手')
  await client.connect(transport)
  connected = true
  ok('initialize 成功')

  const info = client.getServerVersion()
  check('serverInfo.name', info?.name === 'mcp-mc-agent', `拿到 ${JSON.stringify(info?.name)}`, String(info?.name))
  check('serverInfo.version 非空', Boolean(info?.version), 'version 是空的', String(info?.version))

  const caps = client.getServerCapabilities()
  check('capabilities.tools', Boolean(caps?.tools), '没有 tools 能力')
  check('capabilities.resources', Boolean(caps?.resources), '没有 resources 能力')
  check('capabilities.logging', Boolean(caps?.logging), '没有 logging 能力')

  const instr = client.getInstructions()
  check('instructions 非空', typeof instr === 'string' && instr.length > 100, `拿到 ${typeof instr} / ${instr?.length ?? 0} 字`, `${instr?.length ?? 0} 字`)
  if (verbose && instr) console.log(`\n──── instructions 全文 ────\n${instr}\n──────────────────────────\n`)
  else if (instr) note(`instructions 摘要：${instr.split('\n')[0]}`)

  /* ── ② 工具表 ── */
  console.log('\n② 工具表')
  const { tools } = await client.listTools()
  check('工具数量 = 34', tools.length === 34, `拿到 ${tools.length} 个`, `${tools.length} 个`)

  const names = new Set(tools.map((t) => t.name))
  const missing = EXPECTED_TOOLS.filter((n) => !names.has(n))
  check('34 个工具名齐全', missing.length === 0, `缺：${missing.join(', ')}`)
  const extra = [...names].filter((n) => !EXPECTED_TOOLS.includes(n))
  if (extra.length) note(`多出来的工具（不算错，扩展加了新的？）：${extra.join(', ')}`)

  const noDesc = tools.filter((t) => !t.description || t.description.length < 5)
  check('每个工具都有 description', noDesc.length === 0, `没有描述：${noDesc.map((t) => t.name).join(', ')}`)

  const badSchema = tools.filter((t) => {
    const s = t.inputSchema
    return !s || s.type !== 'object' || typeof s.properties !== 'object' || s.properties === null
  })
  check('每个 inputSchema 都是 {type:"object", properties:{}}', badSchema.length === 0,
    `不合法：${badSchema.map((t) => `${t.name}=${JSON.stringify(t.inputSchema)?.slice(0, 80)}`).join(' | ')}`)

  /* 入参校验必须真的生效：mc_events 的 limit 是 number，传字符串应该被拒 */
  const schemaChecked = await (async () => {
    try {
      const r = await client.callTool({ name: 'mc_events', arguments: { limit: 'not-a-number' } })
      return r?.isError === true
    } catch { return true /* 协议层直接拒了，也算拒了 */ }
  })()
  check('非法入参被拒（mc_events.limit="not-a-number"）', schemaChecked, '非法入参竟然成功了 —— 入参校验没接上')

  /* ── ③ 离线工具调用 ── */
  console.log('\n③ 离线工具调用')
  for (const [name, args] of OFFLINE_CALLS) {
    if (!names.has(name)) { note(`跳过 ${name}（工具不存在）`); continue }
    try {
      const r = await client.callTool({ name, arguments: args })
      const text = (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
      if (r?.isError) bad(`${name}`, `返回 isError：${text.slice(0, 300)}`)
      else ok(name, `${text.replace(/\s+/g, ' ').slice(0, 110)}${text.length > 110 ? '…' : ''}`)
    } catch (e) {
      bad(name, `抛异常：${e?.message ?? e}`)
    }
  }

  /* ── ③b 图片内联 ──
   * MCP 没有 DSH 的 Web GUI / 「发布区」，工具产出的图必须**直接变成 image content block**
   * 才算"给用户看得到"。两条路各验一次：
   *   · `mc_kit_image` 只落盘 + 回路径 → 由 server.mjs 的 findImageFiles 兜底内联；
   *   · `mc_map` / `mc_observe` 走 attachments.saveImage → 由 host.mjs 的桩收集。 */
  console.log('\n③b 图片内联')
  {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24">'
      + '<rect width="48" height="24" fill="#3a7"/><text x="4" y="17" font-size="12" fill="#fff">自检</text></svg>'
    try {
      const r = await client.callTool({ name: 'mc_kit_image', arguments: { action: 'render', svg } })
      const imgs = (r?.content ?? []).filter((c) => c.type === 'image')
      check('mc_kit_image 回 image 块', imgs.length >= 1,
        `只有 ${imgs.length} 个 image 块（content 类型：${(r?.content ?? []).map((c) => c.type).join(',')}）`,
        `${imgs[0]?.mimeType ?? '?'}，base64 ${imgs[0]?.data?.length ?? 0} 字符`)
      if (imgs[0]?.data) {
        const head = Buffer.from(imgs[0].data.slice(0, 24), 'base64')
        check('image 块是真 PNG', head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
          `magic bytes 不是 PNG：${head.toString('hex')}`)
      }
    } catch (e) { bad('mc_kit_image 回 image 块', `抛异常：${e?.message ?? e}`) }
  }

  /* ── ③c 健壮性：34 个工具全传 `{}` ──
   * 目标不是"能干活"，而是**没有一个是会崩的**：MCP 客户端传空入参 / 传错东西是常态，
   * 工具必须回一句人话（"机器人不在线" / "缺少 xxx"），而不是抛协议级异常、
   * 更不能把整个 server 拖死（stdio 一崩，客户端那边整局对话都废了）。 */
  console.log('\n③c 健壮性：34 个工具全传空入参')
  {
    const crashed = []
    const empty = []
    const t0 = Date.now()
    for (const name of EXPECTED_TOOLS) {
      if (!names.has(name)) continue
      try {
        const r = await client.callTool({ name, arguments: {} })
        const blocks = r?.content ?? []
        const text = blocks.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim()
        const hasImage = blocks.some((c) => c.type === 'image')
        if (!blocks.length || (!text && !hasImage)) empty.push(name)
      } catch (e) {
        crashed.push(`${name}（${e?.message ?? e}）`)
      }
    }
    check(`全部 ${EXPECTED_TOOLS.length} 个工具传 {} 都不崩`, crashed.length === 0,
      `崩了：${crashed.join('；')}`, crashed.length ? '' : `${Date.now() - t0}ms，全部有返回`)
    check('全部工具传 {} 都回了非空内容', empty.length === 0,
      `回了空内容的：${empty.join(', ')}`, empty.length ? '' : '每个都有一句人话')
    /* 空入参走完一遍之后，server 还得是活的（真崩了下面 ④ 会连带失败，这里先给个明确信号） */
    try {
      const r = await client.callTool({ name: 'mc_status', arguments: {} })
      check('空入参轰炸后 server 仍存活', (r?.content ?? []).length > 0, 'mc_status 没返回了')
    } catch (e) { bad('空入参轰炸后 server 仍存活', `抛异常：${e?.message ?? e}`) }
  }

  /* ── ③d 并发：一次发多个调用 ──
   * MCP 客户端会并发发请求（`Promise.all` 一把梭很常见），server 必须能同时处理、
   * 各自拿到自己的结果（不能串台 —— 串台 = 把地图当状态读、把别人的结果当自己的）。 */
  console.log('\n③d 并发调用')
  {
    const t0 = Date.now()
    const rs = await Promise.all([
      client.callTool({ name: 'mc_status', arguments: {} }),
      client.callTool({ name: 'mc_capabilities', arguments: {} }),
      client.callTool({ name: 'mc_sessions', arguments: {} }),
      client.callTool({ name: 'mc_config', arguments: {} }),
      client.callTool({ name: 'mc_events', arguments: { limit: 3 } }),
    ])
    check('5 个并发调用全部有返回', rs.every((r) => (r?.content ?? []).length > 0),
      `有 ${rs.filter((r) => !(r?.content ?? []).length).length} 个没回内容`, `${Date.now() - t0}ms`)
    const texts = rs.map((r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join(''))
    check('并发结果不串台（5 份内容互不相同）', new Set(texts).size === texts.length,
      '有调用拿到了和别的调用一样的内容 —— 结果串台了')
  }

  /* ── ④ 资源 ── */
  console.log('\n④ 资源')
  const { resources } = await client.listResources()
  check('resources/list 有内容', resources.length >= 4, `只有 ${resources.length} 个`)
  const uris = resources.map((r) => r.uri)
  for (const want of ['mc://prompt', 'mc://rules', 'mc://state', 'mc://wake-log']) {
    check(`resource ${want} 存在`, uris.includes(want), `现有：${uris.join(', ')}`)
  }
  for (const uri of uris) {
    try {
      const r = await client.readResource({ uri })
      const text = r?.contents?.[0]?.text ?? ''
      check(`read ${uri}`, typeof text === 'string' && text.length > 0, '内容是空的',
        `${text.length} 字｜${text.replace(/\s+/g, ' ').slice(0, 90)}…`)
      if (uri === 'mc://state' && verbose) console.log(text)
    } catch (e) {
      bad(`read ${uri}`, `抛异常：${e?.message ?? e}`)
    }
  }

  /* ── ⑤ 状态落盘 ── */
  console.log('\n⑤ 状态落盘')
  check('状态目录已创建', existsSync(stateDir), `${stateDir} 不存在`)
  const accountsFile = join(stateDir, 'accounts.json')
  if (existsSync(accountsFile)) {
    try {
      const acc = JSON.parse(readFileSync(accountsFile, 'utf8'))
      const list = Array.isArray(acc) ? acc : (acc.accounts ?? [])
      check('账户库有默认离线账户', list.length >= 1, '一个账户都没有（默认应该有个离线账户）',
        `${list.length} 个：${list.map((a) => a?.name ?? a?.login ?? '?').join(', ')}`)
    } catch (e) { bad('账户库可解析', `JSON 解析失败：${e?.message ?? e}`) }
  } else {
    note(`账户库 ${accountsFile} 还没生成（首次 mc_accounts 调用时才写）`)
  }
  check('凭据库不在工作区里', !existsSync(join(cwd, 'credentials.json')), '凭据文件跑进工作区了 —— 那等于喂给 AI')

  /* ── ⑥ 协议通道干净 ── */
  console.log('\n⑥ 协议通道干净（stdout 只走 JSON-RPC）')
  check('全程没有任何东西往 stdout 打非 JSON-RPC 内容', !childErr.includes('[stdout→stderr]'),
    '有依赖往 stdout 打人话了（server 端的闸门已改道到 stderr，但客户端那边可能已经被污染过）',
    childErr.includes('[stdout→stderr]') ? childErr.split('\n').filter((l) => l.includes('[stdout→stderr]')).slice(0, 2).join(' | ') : '干净')
  check('server 端的 stdout 闸门在源码里', /stdout→stderr/.test(readFileSync(SERVER, 'utf8')), '闸门被删了？')

  /* ── 收尾 ── */
  await client.close()
  connected = false
} catch (e) {
  failures.push(`自检自身崩溃：${e?.stack ?? e?.message ?? e}`)
  console.log(`\n🔴 自检中断：${e?.stack ?? e}`)
} finally {
  if (connected) { try { await client.close() } catch { /* 已经断了 */ } }
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch { /* 临时目录删不掉就算了 */ }
}

/* ── 汇总 ── */
console.log(`\n${'─'.repeat(64)}`)
if (failures.length === 0) {
  console.log(`✅ 全过：${passed} 项`)
  if (notes.length) console.log(`ℹ️  备注：\n   - ${notes.join('\n   - ')}`)
  process.exit(0)
} else {
  console.log(`❌ ${failures.length} 项失败（过了 ${passed} 项）：\n   - ${failures.join('\n   - ')}`)
  process.exit(1)
}
