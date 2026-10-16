// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / version-prompt.mjs —— **版本提示**（现在是一个真文件，让会话自己去读）
 * ============================================================================
 * 用户 2026-09-16 定的：
 *   "我们应该加入'版本硬提示词'，是我们硬编码的、随版本发布的提示词，在行事准则之后
 *    注入后固定注入。"
 * 用户 2026-10-08 改的（**本文件的现状**）：
 *   "把规则放在文件里，让每个新会话直接去读文件。"
 *   ⇒ 正文不再塞进注入的提示行，而是写成记忆根里的真文件 `<记忆根>/版本提示.md`：
 *     · 插件只投**一行指针**（路径 + 怎么读），由会话自己 `mc_kit_memory {action:"read"}`
 *       或 `read` 工具去读；
 *     · 文件随版本更新（「随版本更新」开关打开时，插件升级会替换它；关着就只记版本），
 *       也能被用户直接改 —— 规矩以**文件**为准，改了立刻生效、不用重启。
 *
 * 它和另外两份东西的分工：
 *   · `.mcp-mc-agent/RULES.md` —— **Master 维护**的长期规矩（同样是文件，会话自己去读）；
 *   · 本条 —— **这个版本**的时效性事实与劝告（工具成熟度、临时取舍），改版本才改它；
 *   · 记忆（`.mcp-mc-agent/README.md` 等）—— 玩出来的经验。
 *
 * 规矩（照用户一贯的要求）：
 *   · 注入走**插件提示行**（`agent.inbox.nextStep` + `source:{kind:'plugin',form:'notice'}`），
 *     **不碰系统提示词**；而且只投指针、不投正文；
 *   · 排在 `.mcp-mc-agent/RULES.md` **之后**、记忆索引之前；
 *   · **不加开关**：它随版本走；
 *   · 正文里写清交付流程（发布区 → `mc_kit_express` → 按「文件分享」模式拿到 URL/绝对路径/一句提示，
 *     自己拼 markdown 或原样转达用户）。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { readVersionPromptVersion, setVersionPromptVersion } from './wsconfig.mjs'

/** 版本提示在记忆根里的文件名（与 RULES.md 同级） */
export const VERSION_PROMPT_FILE = '版本提示.md'

export function versionPromptPath (dir) { return join(dir, VERSION_PROMPT_FILE) }

/** 两条规矩的**正文**（不含文件头）。改这里 = 改本版本的默认规则。 */
const RULES_BODY = [
  '1. **先自己动手**：`mc_move` / `mc_dig` / `mc_build` / `mc_act` / `mc_sequence` 现在够用'
    + '（寻路、挖矿速度、自动换工具都修过了）——移动、挖、建、用东西直接用它们，别绕道指令。'
    + '指令（`mc_command` 的 `/tp`、`/setblock`、`/fill`、`/clone` 这类）只在两种场合用：'
    + '用户明确让你用，或者自己动手确实做不到。真要用时**可以先试一次**'
    + '（用户在场就问一句，或看记忆里有没有约定）；被白名单或权限拒绝就如实说，然后回到自己动手——'
    + '机器人没有 OP 时这些指令会回 `Unknown or incomplete command`，别反复试。',
  '',
  '2. 要给用户发送图片等文件，你需要先把要分享的文件放在 `.mcp-mc-agent/.express/` 或其子目录下'
    + '（出图时把工具的 `out` 写成 `.mcp-mc-agent/.express/<子目录>/x.png`，'
    + '或用 `mc_kit_memory {action:"put"}` 复制过去），然后调用 `mc_kit_express` 工具传入这个文件的路径'
    + '（工作区相对或绝对都行）。它**只回一行**，回什么由 mc_admin_config 的 expressBase 设置决定：'
    + '（a）**关闭**（默认）—— 回一句"文件分享已关闭…"，那就把文件的**绝对路径**告诉用户，'
    + '让用户自己打开，不要再去试别的办法、也不要编造链接；'
    + '（b）**在线** —— 回**完整 URL**（`base` + 路径），把它嵌进回复：图片（内联显示）`![图片名](url)`，'
    + '任意文件（可点开／下载）`[文件名](url)`，**原样使用**，不要补 `http://…` 或域名。'
    + '没有放在 `.mcp-mc-agent/.express/` 下的文件无法分享；游戏公屏/私聊里看不到图，'
    + '只能说"图发到会话窗口了"。',
].join('\n')

/**
 * 本版本提示文件的**默认正文**（= 插件内置的那份）。
 *
 * 🔴 2026-10-08 起它是一个**给人读的文件**，所以带一级标题与三行说明；
 *    但**标题里不写版本号**（用户 2026-09-16 定的"正文里不写版本号"照旧成立）——
 *    版本由三处携带：提示行的来源行（`mcp-mc-agent@0.2.0（版本提示文件）`）、
 *    设置页的折叠标题（带短哈希）、以及 `config.json` 的 `versionPromptVersion`。
 *    这样 `source` 的判据（"文件内容 == 内置默认"）才**跨版本稳定**：插件升级而开关关着时，
 *    文件仍被判成"默认"而不是"Master 改过"。
 * @param {string} [version] 插件版本（**不写进正文**，只为签名兼容保留）
 * @returns {string}
 */
export function versionPromptText (version) {
  return [
    '# mcp-mc-agent 版本提示',
    '',
    '本文件是**这个插件版本**的时效性注意事项（工具成熟度、临时取舍）。',
    '「随版本更新」打开时，插件升级会用新版本的默认内容替换它；你也可以直接改这个文件。',
    '**规矩以本文件为准** —— 改了立刻生效，不用重启。',
    '',
    RULES_BODY,
    '',
  ].join('\n')
}

/** 默认正文的短哈希（写进折叠标题；只标记这段文字本身，所以跨版本稳定） */
export function versionPromptHash (version) {
  return createHash('sha256').update(versionPromptText(version)).digest('hex').slice(0, 8)
}

/** 折叠标题：`提示词注入：版本提示（读文件，v0.2.0）` */
export function versionPromptTitle (version) {
  const v = String(version ?? '').trim() || 'unknown'
  return `提示词注入：mcp-mc-agent v${v} 版本提示（读文件 · ${versionPromptHash(v)}）`
}

/** 提示行首行的"来源"（照 DSH 原生 `Instructions from: …` 的形状）—— 也是投递台账的去重键 */
export function versionPromptSource (version) {
  return `mcp-mc-agent@${String(version ?? '').trim() || 'unknown'}（版本提示文件）`
}

/**
 * 读当前的版本提示文件。
 * `source` 由**内容**判定（与内置默认逐字相同 = 默认），与 RULES.md 同一口径。
 * @returns {{text:string, source:'default'|'custom', path:string}}
 */
export function readVersionPrompt (dir, version) {
  const p = versionPromptPath(dir)
  try {
    if (existsSync(p)) {
      const raw = readFileSync(p, 'utf8')
      const text = raw.trim() ? raw : versionPromptText(version)
      return { text, source: text.trim() === versionPromptText(version).trim() ? 'default' : 'custom', path: p }
    }
  } catch { /* 读不了就当没有 */ }
  return { text: versionPromptText(version), source: 'default', path: p }
}

/** 写入（用户/接口改）。空内容拒绝 —— 想恢复默认请用 resetVersionPrompt */
export function writeVersionPrompt (dir, text, version) {
  const body = String(text ?? '')
  if (!body.trim()) throw new Error('内容不能为空——想恢复默认请用「恢复默认」')
  const p = versionPromptPath(dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, body.endsWith('\n') ? body : body + '\n', 'utf8')
  return { saved: true, path: p, bytes: Buffer.byteLength(body) }
}

/** 恢复默认（写回内置正文） */
export function resetVersionPrompt (dir, version) {
  const p = versionPromptPath(dir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, versionPromptText(version), 'utf8')
  return { saved: true, path: p, source: 'default' }
}

/**
 * 「随版本更新」：插件版本一变，就用**本版本的默认内容**替换文件里那份。
 *
 * 与 `syncRulesVersion`（RULES.md）**完全同构**，标记存在按工作区的 `config.json` 的
 * `versionPromptVersion` 字段里：
 *   · 文件不存在 → 建默认 + 记版本（`created`）；
 *   · 有文件、没有标记 → **只记版本，不动内容**（`marked`）—— 免得插件一升级就把人家改的冲掉；
 *   · 标记 ≠ 当前版本 且开关**开** → 覆盖成默认 + 记版本（`replaced`）；
 *   · 标记 ≠ 当前版本 但开关**关** → 只更新标记（`kept`）；
 *   · 标记 = 当前版本 → 什么都不做（`kept`）。
 * @param {string} dir 记忆根
 * @param {string} version 当前插件版本
 * @param {{follow?:boolean}} [opts] `follow` = 「随版本更新」开关（缺省视为开）
 * @returns {{action:'created'|'replaced'|'kept'|'marked', from:string|null, to:string, error?:string}}
 */
export function syncVersionPrompt (dir, version, { follow = true } = {}) {
  const to = String(version ?? '').trim() || 'unknown'
  const p = versionPromptPath(dir)
  if (!existsSync(p)) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      writeFileSync(p, versionPromptText(to), 'utf8')
      setVersionPromptVersion(dir, to)
      return { action: 'created', from: null, to }
    } catch (e) {
      return { action: 'kept', from: null, to, error: e.message }
    }
  }
  const from = readVersionPromptVersion(dir)
  if (from === to) return { action: 'kept', from, to }
  if (from === null || follow !== true) {           // 第一次遇到 / 开关关着：只记版本，不动内容
    setVersionPromptVersion(dir, to)
    return { action: from === null ? 'marked' : 'kept', from, to }
  }
  try {
    writeFileSync(p, versionPromptText(to), 'utf8')
    setVersionPromptVersion(dir, to)
    return { action: 'replaced', from, to }
  } catch (e) {
    return { action: 'kept', from, to, error: e.message }
  }
}
