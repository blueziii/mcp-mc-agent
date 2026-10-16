// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / protected.mjs —— **受保护文件**的统一判定（MC 模式只读）
 * ============================================================================
 * 用户 2026-10-03 定：这些住在记忆根**根级**的文件是给 Master / 插件维护的，
 * MC 模式的 AI **可读不可写**：
 *
 *   · `RULES.md` / `AGENTS.md`（老名）——行事准则，在记忆根里的 RULES.md 里改；
 *   · `版本提示.md` —— 本版本的时效性规则（2026-10-08 从硬编码提示词挪成文件，见
 *     src/version-prompt.mjs），同样在记忆根里的 RULES.md 里改；
 *   · `config.json` —— 本插件按工作区的配置（见 src/wsconfig.mjs），插件内部与 mc_admin_config 写。
 *
 * 收编前的散落判定（现已全部走这里）：
 *   · `agentsmd.mjs` 的 `isAgentsMdPath`（对工具参数 JSON 全文匹配——会把 write 正文里
 *     提及文件名也误拒，而且管不到 config.json）；
 *   · `memory.mjs` safePath 里对根级 RULES/AGENTS 与历史 PLUGIN_FILES 的"读写全拒"
 *     （现在改为读放行、写拒绝，与宿主文件工具口径一致）。
 *
 * 适用范围：guard 只对 MC 模式会话生效（非 MC 的 Master 会话本来就能读写这些文件）。
 * ============================================================================
 */

/** 受保护文件名（记忆根根级；大小写不敏感） */
export const PROTECTED_FILES = ['RULES.md', 'AGENTS.md', '版本提示.md', 'config.json']
const NAME_SET = new Set(PROTECTED_FILES.map((n) => n.toLowerCase()))

export function isProtectedName (seg) {
  return NAME_SET.has(String(seg ?? '').trim().toLowerCase())
}

/**
 * guard 用：工具参数里的"路径"是不是受保护文件。
 * 认两种写法：
 *   · 裸名（`RULES.md`）——记忆工具的相对路径就是这种，指记忆根根级；
 *   · 含 `.mcp-mc-agent` / `mcp-mc-agent` 段的路径（`E:\ws\.mcp-mc-agent\config.json`、包内目录）。
 * 嵌套的普通记忆文件（如 `_global/config.json`）**不**算，可以正常读写。
 */
export function isProtectedPathArg (raw) {
  const s = String(raw ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (!s) return false
  const segs = s.split('/').filter(Boolean)
  if (!segs.length || !isProtectedName(segs[segs.length - 1])) return false
  if (segs.length === 1) return true
  return segs.some((x) => /^\.?mcp[-_]mc[-_]agent$/i.test(x))
}

/** 会写文件的宿主工具（read|glob|grep|ls|cat|read_image 是只读的，放行）
 *  🔴 2026-10-15 审计（报告 C 第 3 条）：`ops_replace`（批量正则替换）**真能落盘**，
 *    但原来既不在 `index.js` 的判定白名单里、也不在这里 ⇒ MC 模式可以拿它改写
 *    RULES.md / AGENTS.md / config.json，而且"只能在记忆文件夹内"那条围栏也绕过去了。
 *    凡是会写文件的工具都必须进这个名单。 */
export const WRITE_FILE_TOOLS = /^(write|edit|ops_replace)$/i

/** 会写文件的记忆工具动作（read/index/search/kinds 放行） */
export const MEMORY_WRITE_ACTIONS = new Set(['append', 'write', 'delete', 'put', 'record'])

/** 统一的拒绝文案（guard 用） */
export function rejectionText () {
  return '受保护文件（RULES.md / AGENTS.md / 版本提示.md / config.json）对 MC 模式**只读**，AI 不能改写。'
    + '行事准则与版本提示请在记忆根里的 RULES.md 里改；工作区配置由插件与MC设置页（旧 Web GUI）维护。'
}

/** 记忆工具写受保护文件时的错误文案（safePath 的读放行由各写方法显式拒绝） */
export function protectedWriteError (rel) {
  return `受保护文件（${rel}）对 AI **只读**：不能通过记忆工具修改。行事准则、版本提示与工作区配置请用 mc_accounts 维护。`
}
