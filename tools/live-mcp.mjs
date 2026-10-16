#!/usr/bin/env node
/**
 * mcp-mc-agent / tools/live-mcp.mjs —— **实机**验收（需要一台真开着的 MC 服务器）
 * ============================================================================
 * 与 `mcp/selfcheck-mcp.mjs` 的分工：
 *   · selfcheck-mcp 是**离线**的（不需要服务器）——它证明"这个 server 是个像样的 MCP server"；
 *   · 本脚本证明"连上真服务器以后，那些**非离线工具**真的能用"。
 *
 * 它扮演一个真的 MCP 客户端：起子进程跑 `mcp/server.mjs`（stdio），走完整握手，
 * 然后 `mc_connect` 进本地服，把主要工具挨个调一遍，最后断开。
 *
 * 用法：
 *   node tools/live-mcp.mjs [--host 127.0.0.1] [--port 25565] [--name mcp_live] [--verbose]
 *
 * 退出码：0 = 全过；1 = 有失败项。
 * ============================================================================
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SERVER = join(ROOT, 'mcp', 'server.mjs')
const verbose = process.argv.includes('--verbose') || process.argv.includes('-v')

const argOf = (name, dflt) => {
  const i = process.argv.indexOf(name)
  if (i < 0) return dflt
  const v = process.argv[i + 1]
  return v && !v.startsWith('--') ? v : dflt
}
const HOST = argOf('--host', '127.0.0.1')
const PORT = Number(argOf('--port', '25565'))
const NAME = argOf('--name', 'mcp_live')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'mcp-mc-agent-live-'))
const cwd = join(tmpRoot, 'ws')
const stateDir = join(tmpRoot, 'state')

const client = new Client({ name: 'mcp-live-probe', version: '1.0.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [SERVER, '--stdio', '--cwd', cwd, '--state-dir', stateDir],
  cwd: ROOT,
  stderr: 'pipe',
})

/** 调一个工具，把返回里的文本块拼起来（图片块只记类型）。 */
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args })
  const texts = []
  const kinds = []
  for (const c of r.content ?? []) {
    kinds.push(c.type)
    if (c.type === 'text') texts.push(String(c.text ?? ''))
    else texts.push(`[${c.type}]`)
  }
  const text = texts.join('\n')
  if (verbose) console.log(`\n--- ${name} ${JSON.stringify(args)}\n${text.slice(0, 1200)}`)
  return { isError: r.isError === true, text, kinds }
}

const main = async () => {
  console.log(`\n=== mcp-mc-agent 实机验收（${HOST}:${PORT}，账号 ${NAME}）===\n`)

  /* ── ① 握手 ─────────────────────────────────────────────────────────── */
  await client.connect(transport)
  ok(true, 'stdio 握手成功')
  const tools = await client.listTools()
  ok(tools.tools.length === 34, '工具表 34 个', String(tools.tools.length))

  /* ── ② 账户：用状态目录里那份默认离线账户 ───────────────────────────── */
  let r = await call('mc_accounts', { action: 'list' })
  ok(!r.isError, 'mc_accounts list 不报错', r.text.slice(0, 80).replace(/\n/g, ' '))

  const innerID = (r.text.match(/acc-[0-9a-z]+/i) ?? [])[0]
  ok(Boolean(innerID), '账户库里有默认离线账户（新状态目录自动建）', innerID ?? '（没匹配到）')
  if (innerID) {
    const u = await call('mc_accounts', { action: 'use', innerID })
    ok(!u.isError, 'mc_accounts use 选中它', u.text.split('\n')[0].slice(0, 80))
  }

  /* ── ③ 连接 ─────────────────────────────────────────────────────────── */
  r = await call('mc_connect', { host: HOST, port: PORT, account: innerID ?? undefined })
  ok(!r.isError, 'mc_connect 进服成功', r.text.split('\n')[0].slice(0, 110))

  r = await call('mc_status')
  const online = /🟢\s*active|🟢|online/i.test(r.text)
  ok(!r.isError && online, 'mc_status 说在线', r.text.split('\n')[0].slice(0, 130))
  const posM = r.text.match(/(-?\d+\.?\d*)\s*[,/ ]\s*(-?\d+\.?\d*)\s*[,/ ]\s*(-?\d+\.?\d*)/)
  const pos = posM ? { x: Math.floor(Number(posM[1])), y: Math.floor(Number(posM[2])), z: Math.floor(Number(posM[3])) } : null
  ok(Boolean(pos), 'mc_status 给了坐标', pos ? `${pos.x},${pos.y},${pos.z}` : '（没匹配到）')

  /* ── ④ 感知类工具 ───────────────────────────────────────────────────── */
  for (const [name, args] of [
    ['mc_scan', {}],
    ['mc_inventory', {}],
    ['mc_capabilities', {}],
    ['mc_events', {}],
    ['mc_watch', { action: 'status' }],
    ['mc_task', { action: 'list' }],
    ['mc_sessions', {}],
    ['mc_config', {}],
  ]) {
    const x = await call(name, args)
    ok(!x.isError, `${name} 不报错`, x.text.split('\n')[0].slice(0, 90))
  }

  /* ── ⑤ 地图：俯视 + 竖列 ────────────────────────────────────────────── */
  r = await call('mc_map', {})
  ok(!r.isError, 'mc_map（默认 floor）出图', `${r.text.split('\n').length} 行`)

  r = await call('mc_map', { mode: 'column' })
  ok(!r.isError && /竖列|脚底/.test(r.text), 'mc_map {mode:"column"} 出竖列图', r.text.split('\n').slice(0, 2).join(' | ').slice(0, 130))

  /* 🔴 这一步是**回归**：`mc_observe` 默认参数就会画图，而工具自带的 render 是照 DSH 宿主
   * 的约定写图片块的（`{type:'image', attachment}`）—— MCP 不认那个形状。
   * 2026-10-16 实机就是这里报 `MCP error -32602: Invalid tools/call result`。
   * 注意：**SDK 客户端会校验返回的 content**，所以"这一句没抛异常"本身就等于"块全合规"。 */
  r = await call('mc_observe', {})
  ok(!r.isError && r.kinds.includes('image'), 'mc_observe 第一人称感知（含内联图，且块合规）',
    `${r.kinds.join(',')} ｜ ${r.text.split('\n')[0].slice(0, 60)}`)

  r = await call('mc_map', { format: 'image' })
  ok(!r.isError && r.kinds.includes('image'), 'mc_map {format:"image"} 的图块也合规', r.kinds.join(','))

  /* ── ⑥ 说话（会真的发进游戏聊天）────────────────────────────────────── */
  r = await call('mc_say', { message: '[mcp-live] 实机验收中，马上就好' })
  ok(!r.isError, 'mc_say 发出一条', r.text.split('\n')[0].slice(0, 90))

  /* ── ⑦ 真动作：挖/走（在脚下原地小范围，不改别人世界）──────────────── */
  if (pos) {
    r = await call('mc_move', { x: pos.x, y: pos.y, z: pos.z, mode: 'walk' })
    ok(!r.isError, 'mc_move 走到自己那一格（寻路器空转也得正常返回）', r.text.split('\n')[0].slice(0, 90))
  }
  r = await call('mc_act', { mode: 'look', x: 0, y: 0, z: 0 })
  ok(!r.isError, 'mc_act {mode:"look"}', r.text.split('\n')[0].slice(0, 90))

  /* ── ⑧ 图片通道（离线自检 ③b 也覆盖，这里只是确认实机路径一致）────────── */
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="24">'
    + '<rect width="48" height="24" fill="#3a7"/><text x="4" y="17" font-size="12" fill="#fff">实机</text></svg>'
  r = await call('mc_kit_image', { action: 'render', svg })
  ok(!r.isError && r.kinds.includes('image'), 'mc_kit_image 回的是 MCP image 块', r.kinds.join(','))

  /* ── ⑨ 事件队列：看门狗是不是真在记 ─────────────────────────────────── */
  r = await call('mc_events', { waitSec: 2 })
  ok(!r.isError, 'mc_events 等待式取事件不报错', r.text.split('\n')[0].slice(0, 90))

  r = await call('mc_diag', {})
  ok(!r.isError && /perf|terrainCache|worker/i.test(r.text), 'mc_diag 带上诊断字段', r.text.slice(0, 90).replace(/\n/g, ' '))

  /* ── ⑩ 断开 ─────────────────────────────────────────────────────────── */
  r = await call('mc_disconnect', {})
  ok(!r.isError, 'mc_disconnect 断开', r.text.split('\n')[0].slice(0, 90))

  r = await call('mc_status')
  ok(!/🟢\s*active/i.test(r.text), '断开后 mc_status 不再说在线', r.text.split('\n')[0].slice(0, 110))
}

try {
  await main()
} catch (e) {
  fail++
  console.error(`\n❌ 实机验收崩了：${e?.stack ?? e}`)
} finally {
  try { await client.close() } catch {}
  try { rmSync(tmpRoot, { recursive: true, force: true }) } catch {}
  console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}\n`)
  process.exit(fail === 0 ? 0 : 1)
}
