/**
 * 自检：**打包与结构不变量**（MCP 版）。
 *
 * 为什么需要：改名（dsh-mc-agent → mcp-mc-agent）与删文件（client.js / presets / locale /
 * cordis.patch.yml）是一次性手工动作，没有东西钉住它们。最容易复发的三类事故：
 *   ① 改名漏网 —— 字面量替换抓不到**字符类变形**（`/^\.?dsh[-_]mc[-_]agent$/i`
 *      就漏过一次，导致受保护文件判定失效）；
 *   ② 删文件漏网 —— DSH/GUI 专属文件又混回来，`files` 与真实目录不一致；
 *   ③ 宿主字段漏网 —— package.json 又长出 `dsh.bundle.patch` / `engines.dsh` /
 *      `peerDependencies` 里的 dsh 包，干净环境装不上。
 *
 * 另外钉住两条 MCP 移植的**关键接线**（删了就静默失效）：
 *   · `index.js` 末尾的 `ctx.__mcpBridge`（提示词对账 → MCP instructions/resource）；
 *   · `src/watchdog.mjs` 里 `__mcpWake` 分支**必须排在 sessionController 之前**。
 *
 * 🔴 必须从包目录跑：cd <profile>/node_modules/mcp-mc-agent && node tools/check-mcp-package.mjs
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const rd = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const has = (rel) => existsSync(join(ROOT, rel))

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}

const pkg = JSON.parse(rd('package.json'))

/* ── A. package.json ────────────────────────────────────────────────────── */
console.log('\n--- A. package.json ---')
ok(pkg.name === 'mcp-mc-agent', `包名 = mcp-mc-agent（${pkg.name}）`)
ok(typeof pkg.version === 'string' && /^\d+\.\d+\.\d+/.test(pkg.version), `版本号正常（${pkg.version}）`)
ok(pkg.type === 'module', 'type = module')
ok(pkg.main === 'index.js', 'main = index.js（apply() 入口）')
ok(pkg.bin?.['mcp-mc-agent'] === './mcp/server.mjs', `bin.mcp-mc-agent → ./mcp/server.mjs（${pkg.bin?.['mcp-mc-agent']}）`)
for (const [k, v] of Object.entries({ '.': './index.js', './host': './mcp/host.mjs', './server': './mcp/server.mjs' })) {
  ok(pkg.exports?.[k] === v, `exports["${k}"] = ${v}`)
}
ok(typeof pkg.dependencies?.['@modelcontextprotocol/sdk'] === 'string', `dependencies 有 @modelcontextprotocol/sdk（${pkg.dependencies?.['@modelcontextprotocol/sdk']}）`)
ok(typeof pkg.dependencies?.mineflayer === 'string' && typeof pkg.dependencies?.vec3 === 'string', 'dependencies 有 mineflayer + vec3')
ok(pkg.optionalDependencies?.sharp !== undefined, 'sharp 在 optionalDependencies（缺了也能跑）')

/* 宿主字段必须**没有** */
ok(pkg.dsh === undefined, '没有 dsh 字段（不再是 DSH 插件包）')
ok(pkg.engines?.dsh === undefined, 'engines 里没有 dsh（只要 node>=22）')
ok(pkg.engines?.node?.includes('22') || /2[2-9]/.test(pkg.engines?.node ?? ''), `engines.node 要求 Node 22+（${pkg.engines?.node}）`)
const peers = Object.keys(pkg.peerDependencies ?? {})
ok(peers.length === 0, `peerDependencies 里没有宿主包（${peers.join(', ') || '空'}）`)

/* files 里每一项都得真存在；反过来，mcp/ 必须在 files 里 */
console.log('\n--- B. files 与真实目录一致 ---')
for (const f of pkg.files ?? []) {
  ok(has(f), `files 项存在：${f}`)
}
ok((pkg.files ?? []).includes('mcp'), 'files 含 mcp（server/host/credentials 是运行必需）')
ok((pkg.files ?? []).includes('index.js'), 'files 含 index.js')
for (const gone of ['client.js', 'presets', 'locale', 'cordis.patch.yml']) {
  ok(!(pkg.files ?? []).includes(gone), `files 不含已删的 ${gone}`)
}

/* ── C. DSH/GUI 专属文件必须已删 ────────────────────────────────────────── */
console.log('\n--- C. DSH/GUI 专属文件已删 ---')
for (const gone of ['client.js', 'cordis.patch.yml', 'presets', 'locale', 'logs', '备份', '实机验证', 'selfcheck.mjs', 'tools/dev.mjs', 'tools/isolate.mjs']) {
  ok(!has(gone), `已删：${gone}`)
}
for (const keep of ['index.js', 'mcp/server.mjs', 'mcp/host.mjs', 'mcp/credentials.mjs', 'mcp/selfcheck-mcp.mjs', 'src/tool-def.mjs', 'extensions/mc_auto.mjs', 'tools/check-all.mjs']) {
  ok(has(keep), `保留：${keep}`)
}

/* ── D. 改名必须彻底（含字符类变形）────────────────────────────────────── */
console.log('\n--- D. 改名彻底性（含字符类变形）---')
{
  /* 这几个文件里出现旧名是**故意**的：
     · config.mjs —— 给从 DSH 版搬过来的老用户看的迁移说明（老状态目录在哪、怎么手动搬）；
     · perf-monitor.mjs —— 引用一份外部文档的原名（出处）；
     · check-rules-file.mjs —— **反向**断言"旧名 `E:\ws\.dsh-mc-agent\…` 已经不算受保护路径"，
       所以必须把旧名写出来。 */
  const ALLOW = new Set(['src/config.mjs', 'src/perf-monitor.mjs', 'tools/check-rules-file.mjs'])
  const PAT = /dsh[-_]mc[-_]agent|DSH_MC_AGENT|DshMcAgent|dsh_mc_agent/i
  const files = []
  const walk = (dir) => {
    for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name
      if (e.isDirectory()) { if (!['node_modules', '.git', '.out', 'coverage'].includes(e.name)) walk(rel) } else if (/\.(mjs|js|json|md)$/.test(e.name) && e.name !== 'package-lock.json') files.push(rel)
    }
  }
  for (const d of ['', 'src', 'extensions', 'mcp', 'tools']) walk(d)
  const hits = []
  for (const rel of files) {
    if (ALLOW.has(rel)) continue
    if (rel === 'tools/check-mcp-package.mjs') continue      // 本文件自己就含这些字面量
    if (/^(CHANGELOG|README|插件说明|踩坑档案)/.test(rel)) continue  // 文档里讲改名历史是正常的
    const src = rd(rel)
    src.split('\n').forEach((line, i) => { if (PAT.test(line)) hits.push(`${rel}:${i + 1}`) })
  }
  ok(hits.length === 0, `代码里没有 dsh-mc-agent 残留（${hits.length} 处）`, hits.slice(0, 6).join(', '))
  /* 钉死那条漏网的正则：受保护文件判定必须认 .mcp-mc-agent 这一层 */
  const prot = rd('src/protected.mjs')
  ok(/\/\^\\\.\?mcp\[-_\]mc\[-_\]agent\$\/i/.test(prot), '🔴 protected.mjs 的目录段正则已改成 mcp[-_]mc[-_]agent（字符类变形是最容易漏的）')
  const { isProtectedPathArg } = await import('../src/protected.mjs')
  ok(isProtectedPathArg('E:\\ws\\.mcp-mc-agent\\版本提示.md') === true, '受保护文件判定认得 .mcp-mc-agent/ 下的文件')
  ok(isProtectedPathArg('E:\\ws\\.dsh-mc-agent\\版本提示.md') === false, '旧目录名 .dsh-mc-agent/ 已不再被当作受保护（改名后没有自动迁移，这是对的）')
  ok(isProtectedPathArg('RULES.md') === true, '裸名 RULES.md（记忆工具的相对路径写法）仍受保护')
  ok(isProtectedPathArg('E:\\ws\\.mcp-mc-agent\\config.json') === true, '记忆根下的 config.json 受保护')
}

/* ── E. MCP 移植的关键接线 ──────────────────────────────────────────────── */
console.log('\n--- E. MCP 关键接线 ---')
{
  const idx = rd('index.js')
  ok(/ctx\.__mcpBridge/.test(idx), 'index.js 末尾有 ctx.__mcpBridge 桥（提示词对账 → MCP instructions/resource）')
  for (const k of ['reconcileNotices', 'memoryRootFor', 'workspaceRootFor', 'pluginVersion', 'noticesFor']) {
    ok(new RegExp(`${k}\\s*[,:]`).test(idx.slice(idx.indexOf('__mcpBridge'))), `桥上有 ${k}`)
  }

  const wd = rd('src/watchdog.mjs')
  const atWake = wd.indexOf("get?.('__mcpWake')")
  const atSc = wd.lastIndexOf("get('sessionController')")   // 取**最后一次**：前面几处都在注释里
  ok(atWake > 0, 'watchdog.mjs 里有 __mcpWake 分支')
  ok(atWake > 0 && atSc > 0 && atWake < atSc, `🔴 __mcpWake 分支排在 sessionController 兜底之前（wake@${atWake} < sc@${atSc}）`)

  const srv = rd('mcp/server.mjs')
  ok(/StdioServerTransport/.test(srv), 'server.mjs 用 StdioServerTransport（默认 stdio 传输）')
  ok(/StreamableHTTPServerTransport/.test(srv), 'server.mjs 带 StreamableHTTPServerTransport（--http 可选）')
  ok(/for \(const m of \['log', 'info'\]\)[\s\S]{0,80}console\[m\] =/.test(srv), 'server.mjs 把 console.log/info 改道到 stderr（stdout 是 JSON-RPC 通道）')

  const host = rd('mcp/host.mjs')
  ok(/composedPreset:\s*\(\)\s*=>\s*'minecraft'/.test(host), "host.mjs 的 agentPresets 桩返回 'minecraft'（MC 模式判据必须成立，否则看门狗闸门丢光唤醒）")
  ok(/tools:\s*\{/.test(host) && /guard/.test(host), 'host.mjs 提供了 tools.register 与 tools.guard（guard 故意不生效）')
}

/* ── F. 结构不变量：会话事件队列只有一个写入方 ──────────────────────────── */
console.log('\n--- F. 结构不变量：事件队列单一写入方 ---')
{
  /* 曾经的真 bug：McSession.ensureWired 与看门狗 onFire **都**往 sess.events 写，
     同一句聊天进队列两遍（chat/damage/death）。修法是删掉看门狗那一路。
     重复事件会让 AI 误判"对方说了两遍"。 */
  const wdSrc = rd('src/watchdog.mjs')
  const idxSrc = rd('index.js')
  ok(!/this\.onFire\s*\(/.test(wdSrc), '看门狗不写会话事件队列（无 this.onFire 调用）')
  ok(/on\('chat',[\s\S]{0,120}#pushEvent\('chat'/.test(idxSrc), 'ensureWired 仍是唯一写入方（mc_events 事件来源）')
  ok(/ctx\.on\(/.test(idxSrc), 'index.js 仍注册 ctx.on（MCP 桩下不触发，但保住"上游修复能整块搬"）')
}

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
