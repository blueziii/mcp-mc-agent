/**
 * 一次把所有自检跑完（省得一条条敲）。
 *
 *   cd <profile>/node_modules/mcp-mc-agent
 *   node tools/check-all.mjs            # 全部（含 MCP 端到端自检，慢）
 *   node tools/check-all.mjs --fast     # 跳过 MCP 端到端自检（只跑各工具套件）
 *   node tools/check-all.mjs --only mc  # 只跑文件名含 "mc" 的套件
 *
 * 每个套件都用**子进程 + stdio inherit** 跑（不做管道抓取：受限沙箱里 Node 的管道
 * 会被 EPERM 挡掉，inherit 不受影响），所以套件自己的输出会原样打在下面，
 * 这里只汇总"退出码 + 耗时"。任何一个非 0 就以非 0 退出。
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')

/**
 * 端到端自检：真起一个 MCP server（stdio 子进程）+ 真 MCP 客户端握手，
 * 验的是**整条链路**（工具表 / 34 个工具调用 / 图片内联 / resources / 状态落盘）。
 * 它在 `mcp/` 下，不在 `tools/` 下，所以路径与其它套件不同，单独拎出来。
 * 🔴 上游的 `selfcheck.mjs`（DSH 插件的 fake-ctx 集成检查）已删 —— 它的覆盖面
 *    现在由 `tools/check-*.mjs` 各套件 + 这个端到端自检一起承担。
 */
const E2E = 'mcp/selfcheck-mcp.mjs'

const args = process.argv.slice(2)
const fast = args.includes('--fast')
const onlyIdx = args.indexOf('--only')
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] ?? '') : ''

/** 跑的顺序：先核心，再工具，最后会话/日志这类横切的；结构性检查（改名/打包）与端到端放最后。 */
const ORDER = [
  'check-core-dig.mjs', 'check-core-digtime.mjs', 'check-core-place.mjs', 'check-core-entities.mjs', 'check-core-attack.mjs', 'check-core-useitem.mjs',
  'check-core-swim.mjs', 'check-core-map.mjs', 'check-core-inventory.mjs', 'check-core-equip.mjs', 'check-core-evidence.mjs',
  'check-call-budget.mjs', 'check-token-budget.mjs', 'check-async-util.mjs', 'check-worker-pool.mjs', 'check-mc-pathfinder.mjs',
  'check-action-scheduler.mjs', 'check-perf-monitor.mjs', 'check-move-progress.mjs', 'check-bridge.mjs', 'check-terrain.mjs',
  'check-water-navigation.mjs', 'check-water-recovery.mjs', 'check-task-epoch.mjs', 'check-msa.mjs',
  'check-mc-craft.mjs', 'check-mc-furnace.mjs', 'check-mc-chest.mjs',
  'check-mc-observe-host.mjs', 'check-mc-view-render.mjs', 'check-mc-skin.mjs',
  'check-mc-auto.mjs', 'check-mc-deps.mjs',
  'check-session-memory.mjs', 'check-rules-file.mjs', 'check-logging.mjs', 'check-watch-chat.mjs', 'check-audit-session.mjs',
  'check-tool-def.mjs', 'check-watchdog-mcp.mjs', 'check-accounts-store.mjs',
  'check-module-load.mjs',
  'check-core.mjs',
  'check-mcp-package.mjs',
  'check-mcp-content.mjs',
  'check-mcp-cli.mjs',
  'check-mcp-http.mjs',
  'check-standalone-import.mjs',
]

const all = readdirSync(HERE).filter((f) => /^check-.*\.mjs$/.test(f) && f !== 'check-all.mjs')
const ordered = [...ORDER.filter((f) => all.includes(f)), ...all.filter((f) => !ORDER.includes(f)).sort()]
const suites = ordered.filter((f) => (only ? f.includes(only) : true))
// 端到端自检慢（要起真 server），`--fast` 跳过；`--only` 时按子串决定要不要带上它
if (!fast && (only ? E2E.includes(only) : true)) suites.push(E2E)

const results = []
for (const f of suites) {
  const label = f.replace(/\.mjs$/, '')
  console.log(`\n\x1b[36m━━ ${label} ${'─'.repeat(Math.max(2, 46 - label.length))}\x1b[0m`)
  const t0 = Date.now()
  // 5 分钟上限：2026-10-08 真发生过一次 —— selfcheck 的 ❌ 记录器把"打印失败清单"也记了一遍，
  // 边遍历边长 ⇒ 死循环，输出涨到 2.7 GB、堆 OOM（exit 134），而且是**边跑边涨**：
  // 没人掐它就会把磁盘写满。超时一律按失败报（spawnSync 会 kill 掉子进程）。
  const r = spawnSync(process.execPath, [f === E2E ? E2E : join('tools', f)], {
    cwd: ROOT, stdio: 'inherit', timeout: 5 * 60_000, killSignal: 'SIGKILL',
  })
  const ms = Date.now() - t0
  const code = r.status ?? (r.error ? 1 : 0)
  results.push({ f: label, code, ms, err: r.error ? String(r.error.message) : '' })
}

const bad = results.filter((r) => r.code !== 0)
console.log(`\n${'═'.repeat(60)}`)
for (const r of results) {
  const mark = r.code === 0 ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'
  console.log(`  ${mark} ${r.f.padEnd(24)} ${(r.ms / 1000).toFixed(1)}s${r.code === 0 ? '' : `   exit=${r.code} ${r.err}`}`)
}
console.log(`${'═'.repeat(60)}`)
console.log(bad.length === 0
  ? `\x1b[32m全部通过\x1b[0m：${results.length}/${results.length}`
  : `\x1b[31m有失败\x1b[0m：${results.length - bad.length}/${results.length} 通过，失败 ${bad.map((b) => b.f).join(', ')}`)
process.exit(bad.length === 0 ? 0 : 1)
