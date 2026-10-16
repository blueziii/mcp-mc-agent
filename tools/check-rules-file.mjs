/**
 * 自检：**规则放在文件里，让每个新会话直接去读文件**
 * （起因 = 用户 m15520 原文：「把规则放在文件里，让每个新会话直接去读文件」）
 *
 * 验的是行为，不是配置项：
 *   ④ 「随版本更新」对 `版本提示.md` 是**文件级**语义：第一次遇到只记版本、
 *      版本变了才替换、开关关着不替换（真跑 `src/version-prompt.mjs`）；
 *   ⑤ 它和 RULES.md 一样是**受保护文件**（AI 可读不可写）；
 *   ⑥ 注入的那两条提示词**只剩一行指针**（文件绝对路径 + 读法），正文不再进提示词
 *      —— 这是省 token 的关键：正文只在"读的那一刻"占上下文。
 *
 * 🔴 MCP 版说明（2026-10-16）：本套件原来还有三段读 `client.js`（已随 Web GUI 一起删掉）
 *    和三段调 `/api/mc/agents-md` HTTP 路由的检查。MCP server 没有 HTTP 层，
 *    那两批断言已全部移除；「新会话播种 版本提示.md」这条行为现在由
 *    `mcp/selfcheck-mcp.mjs` 的真 MCP 客户端从**外部**覆盖（它真起 server、真读 `mc://rules`）。
 *
 * 🔴 必须从包目录跑（源码树里 `import '../index.js'` 会缺 mineflayer 依赖）：
 *      cd <profile>/node_modules/mcp-mc-agent && node tools/check-rules-file.mjs
 */
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 本套件要静态扫的源文件（**按脚本自身定位**，别用 cwd 拼 `..`） */
const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = { index: join(HERE, '..', 'index.js'), agentsmd: join(HERE, '..', 'src', 'agentsmd.mjs') }

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const section = (t) => console.log('\n' + t)

const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }
const rd = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

/* ─────────────── ④ 「随版本更新」的文件级语义（真跑模块） ─────────────── */
section('④ syncVersionPrompt：第一次只记版本、版本变了才替换、开关关着不替换')
const vpm = await import('../src/version-prompt.mjs')
const wsc = await import('../src/wsconfig.mjs')
{
  const d = mk('wc-rulesfile-sync-')
  ok(vpm.VERSION_PROMPT_FILE === '版本提示.md', 'VERSION_PROMPT_FILE = 版本提示.md', vpm.VERSION_PROMPT_FILE)
  ok(vpm.versionPromptPath(d) === join(d, '版本提示.md'), 'versionPromptPath 拼在记忆根根级')
  ok(!existsSync(join(d, '版本提示.md')), '一开始没有文件')
  const s1 = vpm.syncVersionPrompt(d, '0.2.0', { follow: true })
  ok(s1.action === 'created', '第一次 = created（建默认 + 记版本）', JSON.stringify(s1))
  ok(existsSync(join(d, '版本提示.md')), '文件建出来了')
  ok(vpm.readVersionPrompt(d, '0.2.0').source === 'default', '内容 = 内置默认')
  ok(wsc.readVersionPromptVersion(d) === '0.2.0', 'config.json 里记了 versionPromptVersion', String(wsc.readVersionPromptVersion(d)))
  ok(wsc.readRulesVersion(d) === null, 'rulesVersion 没被顺手写上（两个标记独立）', String(wsc.readRulesVersion(d)))

  vpm.writeVersionPrompt(d, '# 我自己改的\n', '0.2.0')
  ok(vpm.readVersionPrompt(d, '0.2.0').source === 'custom', '用户改过 → custom')
  const s2 = vpm.syncVersionPrompt(d, '0.2.0', { follow: true })
  ok(s2.action === 'kept' && String(rd(join(d, '版本提示.md'))).includes('我自己改的'), '版本没变 → kept（不动内容）', JSON.stringify(s2))

  const s3 = vpm.syncVersionPrompt(d, '0.2.1', { follow: true })
  ok(s3.action === 'replaced' && s3.from === '0.2.0' && s3.to === '0.2.1', '版本变了 + 开关开 → replaced', JSON.stringify(s3))
  ok(vpm.readVersionPrompt(d, '0.2.1').source === 'default', '替换后内容 = 本版本的默认（source 回 default）')

  vpm.writeVersionPrompt(d, '# 又改了一次\n', '0.2.1')
  const s4 = vpm.syncVersionPrompt(d, '0.2.2', { follow: false })
  ok(s4.action === 'kept' && String(rd(join(d, '版本提示.md'))).includes('又改了一次'), '开关关着 → kept（保留用户改的）', JSON.stringify(s4))
  ok(wsc.readVersionPromptVersion(d) === '0.2.2', '但版本标记照样更新到 0.2.2', String(wsc.readVersionPromptVersion(d)))

  const d2 = mk('wc-rulesfile-sync2-')
  writeFileSync(join(d2, '版本提示.md'), '# 手工放的\n', 'utf8')
  const s5 = vpm.syncVersionPrompt(d2, '9.9.9', { follow: true })
  ok(s5.action === 'marked' && String(rd(join(d2, '版本提示.md'))).includes('手工放的'), '有文件、没标记 → marked（只记版本，不覆盖）', JSON.stringify(s5))

  const d3 = mk('wc-rulesfile-sync3-')
  vpm.syncVersionPrompt(d3, '0.2.0', { follow: true })                 // 建默认
  vpm.syncVersionPrompt(d3, '0.2.1', { follow: false })               // 升级但开关关着：内容不动
  ok(vpm.readVersionPrompt(d3, '0.2.1').source === 'default', '🔴 升级 + 开关关着：内容还是默认，source 不该被判成 custom（判据跨版本稳定）', vpm.readVersionPrompt(d3, '0.2.1').source)

  let threw = false
  try { vpm.writeVersionPrompt(d2, '   ', '9.9.9') } catch { threw = true }
  ok(threw, '写空内容被拒（想恢复默认要用 resetVersionPrompt）')
  vpm.resetVersionPrompt(d2, '9.9.9')
  ok(vpm.readVersionPrompt(d2, '9.9.9').source === 'default', 'resetVersionPrompt 恢复默认')

  const t0 = vpm.versionPromptText('1.2.3')
  ok(t0.startsWith('# mcp-mc-agent 版本提示'), '默认正文首行是文件标题', t0.split('\n')[0])
  ok(!/v\d+\.\d+\.\d+/.test(t0), '🔴 正文里**没有版本号**（版本由来源行 / 折叠标题 / config.json 标记携带 —— 这样 source 判据跨版本稳定）')
  ok(t0.includes('以本文件为准') || t0.includes('以文件为准'), '正文写明"以本文件为准"')
  ok(t0.includes('/tp') && t0.includes('/setblock') && t0.includes('.express/') && t0.includes('mc_kit_express'), '两条规矩的正文还在（/tp /setblock .express/ mc_kit_express）')
  ok(vpm.versionPromptHash('1.2.3') === vpm.versionPromptHash('1.2.4'), '不同版本的默认正文哈希**相同**（哈希只标记这段文字本身）')
  ok(vpm.versionPromptSource('1.2.3') === 'mcp-mc-agent@1.2.3（版本提示文件）', '来源行标明"版本提示文件"且带版本号', vpm.versionPromptSource('1.2.3'))
}

/* ─────────────── ⑤ 受保护文件（AI 只读） ─────────────── */
section('⑤ `版本提示.md` 与 RULES.md 同一套保护：AI 可读不可写')
const prot = await import('../src/protected.mjs')
{
  ok(prot.PROTECTED_FILES.includes('版本提示.md'), 'PROTECTED_FILES 里有它', prot.PROTECTED_FILES.join('/'))
  ok(prot.isProtectedName('版本提示.md') === true, 'isProtectedName 认它')
  ok(prot.isProtectedPathArg('版本提示.md') === true, '裸名算（记忆工具的相对路径）')
  ok(prot.isProtectedPathArg('E:\\ws\\.mcp-mc-agent\\版本提示.md') === true, '带 .mcp-mc-agent 段的绝对路径也算')
  ok(prot.isProtectedPathArg('E:\\ws\\.dsh-mc-agent\\版本提示.md') === false, '🔴 旧名（.dsh-mc-agent）已经不算了（改名彻底性）')
  ok(prot.isProtectedPathArg('sub/版本提示.md') === false, '嵌套目录里的同名文件不算（可以正常读写）')
  ok(prot.rejectionText().includes('版本提示.md'), '拒绝文案里点名了它', prot.rejectionText().slice(0, 60))
}

/* ─────────────── ⑥ 静态接线：注入只剩指针（正文不再进提示词） ─────────────── */
section('⑥ 注入只剩一行指针：正文不在 index.js 的提示词里')
const stripComments = (s) => s.replace(/\r\n/g, '\n').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
{
  const src = stripComments(rd(SRC.index) ?? '')
  ok(src.includes('const rulesPointerText = ({ abs, fileName, what }) =>'), '有 rulesPointerText() 组装指针')
  ok(src.includes('mc_kit_memory {action:"read", path:"${fileName}"}'), '指针给了 mc_kit_memory 的读法')
  ok(src.includes('read {file_path:"${abs}"}'), '指针给了 read 的读法（绝对路径）')
  ok(src.includes('开工前先读一遍'), '指针写着"开工前先读一遍"')
  ok(src.includes('rel: \'.mcp-mc-agent/RULES.md\',\n        title: \'提示词注入：.mcp-mc-agent/RULES.md\',\n        text: rulesPointerText({'), 'RULES.md 那条投的是指针（不是正文）')
  ok(src.includes('title: versionPromptTitle(PLUGIN_VERSION),\n        text: rulesPointerText({'), '版本提示那条投的也是指针（不是正文）')
  ok(!src.includes('text: versionPromptText()'), '不再把版本提示正文直接塞进提示词')
  ok(!src.includes('【mcp-mc-agent 行事准则（'), '不再把行事准则正文直接塞进提示词')
  ok(src.includes("SESSION_SEED_FILES = ['RULES.md', '版本提示.md', 'config.json', 'auto.json', 'view.json']"), '新会话播种清单里有 版本提示.md')
  ok(src.includes('const vpsync = syncVersionPrompt(root, PLUGIN_VERSION'), '建档时按版本同步它')
  ok(src.includes('已写入默认版本提示：'), '建档日志有它（好排查）')
  /* 下面这几条守的是 index.js 里那段**惰性 HTTP 层**（MCP 下 `ctx.webServer.register` 是 noop，
   * 永远不会被调用）。留着它们是为了保住"上游修复能整块搬过来"这个资产：
   * 上游改了这段逻辑，这些断言会立刻提醒我们同步。 */
  ok(src.includes("const isVersion = String(body.target ?? 'rules') === 'version'"), '[惰性 HTTP] 接口按 target 区分两份文件')
  ok(src.includes('const dir = (scope === \'default\' && !isVersion) ? baseDir : sessionDir'),
    '[惰性 HTTP] 写入目标按 scope 选目录（版本提示不走 default）')
  ok(src.includes('writeVersionPrompt(dir, body.text, PLUGIN_VERSION)'), '[惰性 HTTP] PUT 能改 版本提示.md')
  ok(src.includes('resetVersionPrompt(dir, PLUGIN_VERSION)'), '[惰性 HTTP] DELETE 能恢复它')
  ok(src.includes('const vpPath = root ? versionPromptPath(root) : null'), '[惰性 HTTP] promptInjectionStatus 里报了它的路径')
  ok(src.includes('defaultText: versionPromptText(PLUGIN_VERSION)'), '[惰性 HTTP] 接口回了内置默认（前端"看内置默认"用）')
}

/* ─────────────── 收尾 ─────────────── */
for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
