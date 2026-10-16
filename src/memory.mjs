// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / memory.mjs —— 麦块记忆（v3：固定 .mcp-mc-agent + AI 维护的 README.md 索引）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 固定记录在**工作区下的 `.mcp-mc-agent` 文件夹**；
 *   · **仍是让 AI 用 `README.md` 记录索引**（插件不再自动生成索引文件）；
 *   · 建子文件夹记录各服务器相关文件；
 *   · MCAI 可以在记忆文件夹里**读写任何格式文件**（可以把自己读到的图片保存），
 *     但**不能运行脚本**之类（这个模块本身不执行任何东西：没有 spawn、没有 shell）。
 *
 * 目录结构（默认 `<工作区>/.mcp-mc-agent/`）：
 *
 *   .mcp-mc-agent/
 *   ├── README.md              ← **AI 维护**的总索引（插件只读它、不重写）
 *   ├── _global/               ← 通用记忆（不限服务器）
 *   └── mc.example.com/          ← 每个服务器一个文件夹
 *       ├── landmarks.md
 *       └── maps/town-plan.png ← 任何格式都行（图片、json、txt…）
 *
 * 投递给模型的文本 = README.md（AI 写的索引）+ **自动生成的目录树**（`indexText()`）。
 * 两者都给：README 是 AI 的叙述，目录树保证"就算忘了更新 README 也不会失真"。
 * ⚠️ 这段文字由插件以**插件提示行**投进 `agent.inbox.nextStep`（会话开始时一次），
 *    **不再**注册进系统提示词（用户 2026-09-16 定：系统提示词由 preset 交给宿主自动注入）。
 *
 * 安全：所有路径过 safePath()——拒绝绝对路径、`..`、超深路径，且解析后必须仍在
 * `.mcp-mc-agent/` 内。记忆工具**不是**通用文件编辑器的替身，边界就是这个文件夹。
 * 根级的受保护文件（RULES.md / AGENTS.md / config.json，见 src/protected.mjs）**可读不可写**：
 * safePath 放行（标记 protected），写类方法显式拒绝。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync, rmSync, openSync, readSync, closeSync } from 'node:fs'
import { join, resolve, dirname, sep, posix, extname, basename } from 'node:path'
import { isProtectedName, protectedWriteError } from './protected.mjs'

const MAX_FILES = 2000
const MAX_TEXT_BYTES = 256 * 1024          // 文本写入上限
const MAX_BLOB_BYTES = 16 * 1024 * 1024    // 任意文件（含图片）存入上限
const GLOBAL_DIR = '_global'
const README_FILE = 'README.md'
const MAX_DEPTH = 5

/** 目录/文件名允许的字符：中英文、数字、`._-`、空格（首尾空格与点会被拒）。 */
const SAFE_SEGMENT = /^[\w.\-\u4e00-\u9fa5 ]+$/

/* ─────────────── 记忆四分类（用户 2026-10-08 路线图第 ⑤ 条） ───────────────
 * 路线图要求：长期记忆分**四类** —— 世界事实 / 操作经验 / 任务记录 / 用户规则；
 * 每条带**来源 · 更新时间 · 成功次数 · 失败次数 · 适用版本**；
 * 而且"**失败记录要写清发生条件，不能把目标标成永久不可达**"。
 *
 * 落地方式：四类各有一个固定文件（每个服务器一份），条目是**一行一条、带元数据尾巴**：
 *
 *   - **挖铁矿** — 石镐挖 1 个约 4.5 秒　｜　来源 mc_observe · 更新 2026-10-08 · 成功 3 / 失败 1 · 适用 1.21.9 · 条件 背包里没有镐时挖不动
 *
 * 同 key 再记一次**不会新增条目**，而是累加成功/失败次数并刷新更新时间 ——
 * 这样"成功率"才有意义，也才不会把同一个坑记十遍。
 */
export const NOTE_KINDS = [
  { key: 'world', label: '世界事实', file: 'world.md', what: '坐标、地标、基地布局、箱子/熔炉在哪、生物群系 —— "这里有什么"' },
  { key: 'exp', label: '操作经验', file: 'lessons.md', what: '怎么做成的 / 怎么做不成：工具、路线、条件 —— "该怎么办"' },
  { key: 'task', label: '任务记录', file: 'tasks.md', what: '干过什么活、结果如何、还剩什么（机器可读的进度在 tasks.json）' },
  { key: 'rule', label: '用户规则', file: 'RULES.md', what: '用户的长期要求（**受保护文件，只读** —— 要改让用户在记忆根里的 RULES.md 里改）' },
]
const KIND_BY_KEY = new Map(NOTE_KINDS.map((k) => [k.key, k]))
const META_SEP = '　｜　'
const META_RE = /^(.*?)　｜　来源\s*(.*?)\s*·\s*更新\s*(\d{4}-\d{2}-\d{2})\s*·\s*成功\s*(\d+)\s*\/\s*失败\s*(\d+)(?:\s*·\s*适用\s*(.*?))?(?:\s*·\s*条件\s*(.*?))?\s*$/

/** 四类记忆的说明文本（工具 action:"kinds" 与注入用） */
export function memoryKindsText () {
  return [
    '记忆分四类，各有一个固定文件（每服一份）：',
    ...NOTE_KINDS.map((k) => `· **${k.label}**（kind:"${k.key}"）→ \`<服>/${k.file}\`：${k.what}`),
    '用 `mc_kit_memory {action:"record", kind, key, text, source, version, ok, condition}` 记一条：'
      + '**同 key 再记会累加成功/失败次数**，不堆重复条目；`ok:false` 时**必须**给 `condition`（在什么情况下失败）。',
  ].join('\n')
}

/** 今天的日期（本地时区，YYYY-MM-DD） */
export function todayStr (d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 渲染一条带元数据的记忆（一行 bullet） */
export function renderEntry ({ key = null, text, source = null, updatedAt = null, ok = 0, fail = 0, version = null, condition = null } = {}) {
  const k = String(key ?? '').trim()
  const head = k ? `- **${k}** — ${String(text ?? '').trim()}` : `- ${String(text ?? '').trim()}`
  const meta = [
    `来源 ${source ? String(source).trim() : '未记'}`,
    `更新 ${updatedAt || todayStr()}`,
    `成功 ${Math.max(0, Number(ok) || 0)} / 失败 ${Math.max(0, Number(fail) || 0)}`,
  ]
  if (version) meta.push(`适用 ${String(version).trim()}`)
  if (condition) meta.push(`条件 ${String(condition).trim()}`)
  return `${head}${META_SEP}${meta.join(' · ')}`
}

/** 解析一条记忆；不是带元数据的那行就返回 null（老格式的自由 bullet 照旧能用） */
export function parseEntry (line) {
  const s = String(line ?? '').trim()
  const m = /^[-*]\s+(.*)$/.exec(s)
  if (!m) return null
  const mm = META_RE.exec(m[1])
  if (!mm) return null
  const km = /^\*\*(.+?)\*\*\s*[—-]\s*([\s\S]*)$/.exec(mm[1].trim())
  return {
    key: km ? km[1].trim() : null,
    text: km ? km[2].trim() : mm[1].trim(),
    source: mm[2] || null,
    updatedAt: mm[3] || null,
    ok: Number(mm[4]) || 0,
    fail: Number(mm[5]) || 0,
    version: mm[6] ? mm[6].trim() : null,
    condition: mm[7] ? mm[7].trim() : null,
    raw: s,
  }
}

/** 按扩展名判断"这是文本"。判断不了的再按内容嗅探（见 sniffKind）。 */
const TEXT_EXT = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.yml', '.yaml', '.csv', '.tsv', '.log',
  '.ini', '.cfg', '.conf', '.toml', '.svg', '.html', '.htm', '.xml', '.js', '.mjs', '.cjs',
  '.ts', '.css', '.sh', '.ps1', '.py', '.java', '.sql', '.diff', '.patch',
])
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif'])
const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif',
}

export class MemoryStore {
  /**
   * @param {string} root 记忆根目录（绝对路径，通常是 <工作区>/.mcp-mc-agent）
   * @param {{create?: boolean}} [opts] `create:false` = **只读**，不在构造时建目录。
   *   用户 2026-09-16：`.mcp-mc-agent/` 不该被"顺手建出来"——建它只发生在
   *   "首次发起 MC 模式会话"与"打开 MC设置页（旧 Web GUI）"这两个时机（见 index.js `ensureMemoryRoot`）。
   */
  constructor (root, { create = true } = {}) {
    this.root = resolve(root)
    this._textCache = { text: '', at: 0 }
    if (create) this.ensureRoot()
  }

  ensureRoot () {
    try { if (!existsSync(this.root)) mkdirSync(this.root, { recursive: true }) } catch {}
  }

  get readmePath () { return join(this.root, README_FILE) }

  /** README.md 不存在时**只建一次**骨架（之后完全交给 AI 维护，插件不再动它） */
  ensureReadme () {
    if (existsSync(this.readmePath)) return false
    try {
      this.ensureRoot()
      writeFileSync(this.readmePath, [
        '# 麦块记忆 · 总索引（由 AI 维护）',
        '',
        '> 这个文件是**我**（AI）维护的索引，不是插件生成的——新增/改动了记忆文件就顺手更新它。',
        '> 每个服务器一个子文件夹；通用（不限服务器）的放 `_global/`。',
        '> 图片等非文本文件直接放对应文件夹里（例如 `mc.example.com/maps/xxx.png`）。',
        '',
        '## 通用（_global）',
        '',
        '_(待补充)_',
        '',
        '## 按服务器',
        '',
        '_(待补充)_',
        '',
      ].join('\n'), 'utf8')
      return true
    } catch { return false }
  }

  /* ─────────────── 路径安全 ─────────────── */

  /**
   * 相对路径 → 根目录下的绝对路径。
   * 拒绝：绝对路径、`.`/`..` 片段、超深、非法字符、越界。
   * **不限扩展名**（用户要求"读写任何格式文件"）。
   * 根级的受保护文件（RULES.md / AGENTS.md / config.json）在这里**放行**（读允许），
   * 结果带 `protected:true`，由写类方法（append/write/delete/put）显式拒绝。
   */
  safePath (rel) {
    const raw = String(rel ?? '').trim().replace(/\\/g, '/')
    if (!raw) throw new Error('path 不能为空')
    if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) throw new Error('path 必须是相对路径（如 mc.example.com/landmarks.md）')
    const parts = raw.split('/').filter((p) => p !== '')
    if (parts.length === 0) throw new Error('path 不能为空')
    if (parts.some((p) => p === '..' || p === '.')) throw new Error('path 不允许包含 . 或 ..')
    if (parts.length > MAX_DEPTH) throw new Error(`path 太深（最多 ${MAX_DEPTH} 层）`)
    for (const p of parts) {
      if (p.length > 96) throw new Error(`路径片段太长："${p.slice(0, 30)}…"`)
      if (!SAFE_SEGMENT.test(p)) throw new Error(`路径片段不合法："${p}"（只用中英文/数字/空格/._-）`)
      if (/^[.\s]|[.\s]$/.test(p)) throw new Error(`路径片段不能以点或空格开头/结尾："${p}"`)
    }
    const relFull = parts.join('/')
    const abs = resolve(this.root, ...parts)
    if (abs !== this.root && !abs.startsWith(this.root + sep)) throw new Error('path 越界')
    return {
      abs,
      rel: relFull,
      kind: kindOf(parts[parts.length - 1], abs),
      protected: parts.length === 1 && isProtectedName(parts[0]),
    }
  }

  /** 由 topic/server 拼路径：<server>/<topic>.md；server 省略则 _global */
  pathFor ({ topic, server = null } = {}) {
    const t = String(topic ?? '').trim()
    if (!t) throw new Error('需要 topic 或 path')
    const dir = server ? String(server).trim() : GLOBAL_DIR
    // 已经带扩展名就照用，否则补 .md（笔记）
    const file = /\.[A-Za-z0-9]+$/.test(t) ? t : `${t}.md`
    return this.safePath(posix.join(dir, file))
  }

  /* ─────────────── 列表 / 索引 ─────────────── */

  /** 遍历记忆树，返回全部文件（README 以外的都算记忆） */
  list () {
    const out = []
    if (!existsSync(this.root)) return out
    const walk = (dirAbs, dirRel) => {
      let names = []
      try { names = readdirSync(dirAbs) } catch { return }
      for (const name of names) {
        const abs = join(dirAbs, name)
        const rel = dirRel ? `${dirRel}/${name}` : name
        let st
        try { st = statSync(abs) } catch { continue }
        if (st.isDirectory()) { walk(abs, rel); continue }
        if (name === README_FILE && !dirRel) continue       // README 是索引本身，不算记忆条目
        if (!dirRel && isProtectedName(name)) continue      // 受保护文件（行事准则/工作区配置）也不算
        const kind = kindOf(name, abs)
        const group = rel.includes('/') ? rel.slice(0, rel.indexOf('/')) : GLOBAL_DIR
        const item = {
          rel,
          kind,
          group,
          topic: name.replace(/\.[^.]+$/, ''),
          title: name,
          bytes: st.size,
          mtime: st.mtimeMs,
          updatedAt: new Date(st.mtimeMs).toISOString(),
        }
        if (kind === 'text') {
          try {
            const text = readFileSync(abs, 'utf8')
            const lines = text.split('\n')
            const titleLine = lines.find((l) => /^#\s+/.test(l)) ?? ''
            item.title = titleLine.replace(/^#\s+/, '').trim() || item.title
            item.entries = (text.match(/^\s*[-*]\s+\S/gm) ?? []).length
            item.summary = summarize(lines)
            if (out.length < MAX_FILES) out.push(item)
            continue
          } catch { /* 读不了就当二进制 */ }
        }
        item.entries = 1
        item.summary = kind === 'image'
          ? `图片 ${(st.size / 1024).toFixed(0)}KB`
          : `文件 ${(st.size / 1024).toFixed(0)}KB`
        if (out.length < MAX_FILES) out.push(item)
      }
    }
    walk(this.root, '')
    return out.sort((a, b) => a.rel.localeCompare(b.rel))
  }

  /** 自动生成的目录树（注入文本的第二段；README 忘了更新也不会失真） */
  renderTree () {
    const files = this.list()
    if (!files.length) return '_(记忆库还是空的)_'
    const groups = new Map()
    for (const f of files) {
      if (!groups.has(f.group)) groups.set(f.group, [])
      groups.get(f.group).push(f)
    }
    const order = [...groups.keys()].sort((a, b) => (a === GLOBAL_DIR ? -1 : b === GLOBAL_DIR ? 1 : a.localeCompare(b)))
    const lines = ['| 文件 | 类型 | 最后更新 | 提示 |', '| --- | --- | --- | --- |']
    for (const g of order) {
      lines.push(`| **${g === GLOBAL_DIR ? '_global（通用）' : g}** | | | |`)
      for (const f of groups.get(g)) {
        const when = new Date(f.mtime).toISOString().slice(5, 16).replace('T', ' ')
        lines.push(`| \`${f.rel}\` | ${f.kind} | ${when} | ${f.summary || '—'} |`)
      }
    }
    lines.push('', `_共 ${files.length} 个文件_`)
    return lines.join('\n')
  }

  /**
   * 投递给模型的文本（5 秒缓存）：**README.md（AI 维护的索引）+ 自动目录树**。
   * 写操作会清掉缓存（见 append/write/delete），所以投递那一刻读到的总是最新的。
   */
  indexText () {
    if (Date.now() - this._textCache.at < 5000) return this._textCache.text
    let readme = ''
    try {
      this.ensureReadme()
      readme = existsSync(this.readmePath) ? readFileSync(this.readmePath, 'utf8').trim() : ''
    } catch { readme = '' }
    const tree = this.renderTree()
    const text = (readme ? readme + '\n\n' : '')
      + '### 记忆库实况（自动生成，永远准）\n\n' + tree
    this._textCache = { text, at: Date.now() }
    return text
  }

  /* ─────────────── 增删改查 ─────────────── */

  /** 读：文本返回内容；图片返回文件路径（工具层做成附件让模型直接看到）；其它二进制只给元信息 */
  read ({ path = null, topic = null, server = null } = {}) {
    const resolved = path ? this.safePath(path) : this.pathFor({ topic, server })
    const { abs, rel, kind } = resolved
    if (!existsSync(abs)) {
      const files = this.list().map((f) => f.rel)
      throw new Error(`没有这个记忆文件：${rel}。现有文件：${files.length ? files.slice(0, 40).join(', ') : '(空，先用 write/append 建一个)'}`)
    }
    const st = statSync(abs)
    if (st.isDirectory()) {
      const names = readdirSync(abs)
      return { path: rel, kind: 'dir', entries: names, bytes: 0 }
    }
    if (kind === 'image') {
      return {
        path: rel, kind: 'image', file: abs, bytes: st.size,
        mediaType: MIME_BY_EXT[extname(rel).toLowerCase()] ?? 'image/png',
        note: '这是记忆里的图片。工具层会把它作为附件返回，所以你能**直接看到**它。',
      }
    }
    if (kind === 'binary') {
      return {
        path: rel, kind: 'binary', file: abs, bytes: st.size,
        note: '这是二进制文件，不能当文本读（也不内联显示）。要看内容请用 read_image（图片）或在工作区里处理。',
      }
    }
    const content = readFileSync(abs, 'utf8')
    return { path: rel, kind: 'text', content, bytes: st.size }
  }

  /**
   * 存：把工作区里的**任意文件**复制进记忆（图片最常用）。
   * "MCAI 可以把自己读到的图片保存" —— 就是这个。
   */
  put ({ source, name = null, path = null, server = null } = {}) {
    if (!source) throw new Error('需要 source（要存入的文件路径）')
    if (!existsSync(source)) throw new Error(`源文件不存在：${source}`)
    const st = statSync(source)
    if (!st.isFile()) throw new Error(`不是文件：${source}`)
    if (st.size > MAX_BLOB_BYTES) {
      throw new Error(`文件太大（${(st.size / 1048576).toFixed(1)}MB），上限 ${MAX_BLOB_BYTES / 1048576}MB`)
    }
    let target
    if (path) {
      target = this.safePath(path)
    } else {
      const ext = extname(source)
      const base = String(name ?? basename(source).replace(/\.[^.]+$/, '')).replace(/[^\w.\-\u4e00-\u9fa5 ]/g, '_').trim() || 'file'
      const dir = server ? String(server).trim() : GLOBAL_DIR
      target = this.safePath(posix.join(dir, `${base}${ext}`))
    }
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (!existsSync(dirname(target.abs))) mkdirSync(dirname(target.abs), { recursive: true })
    writeFileSync(target.abs, readFileSync(source))
    this._textCache = { text: '', at: 0 }
    return {
      saved: target.rel, bytes: st.size, kind: target.kind,
      note: `已存进记忆（${target.kind}）。想让以后找得到，在 \`README.md\` 的索引里加一行，`
        + `或写进对应服务器的笔记里引用：\`见 ${target.rel}\`。`,
    }
  }

  /** 增/改：追加一条 bullet（只对文本文件）；给 key 则覆盖同 key 的那条 */
  append ({ path = null, topic = null, server = null, text, key = null } = {}) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('text 不能为空——要记什么？')
    if (body.length > 4000) throw new Error(`一条记忆太长（${body.length} 字），上限 4000`)

    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (target.kind !== 'text') throw new Error(`append 只能用在文本文件上（${target.rel} 是 ${target.kind}）`)
    const files = this.list()
    if (!existsSync(target.abs) && files.length >= MAX_FILES) {
      throw new Error(`记忆文件数已达上限 ${MAX_FILES}，先整理或删掉一些`)
    }

    const bullet = key ? `- **${key}** — ${body}` : `- ${body}`
    let content
    if (existsSync(target.abs)) {
      content = readFileSync(target.abs, 'utf8')
      if (key) {
        const re = new RegExp(`^\\s*[-*]\\s+\\*\\*${escapeRe(key)}\\*\\*\\s*[—-]\\s*.*$`, 'm')
        if (re.test(content)) {
          /* 🟡 2026-10-15 审计（报告 E 第 3 条）：`String.replace(re, str)` 会把**替换串**里的
           *   `$&` / `` $` `` / `$'` / `$1` 当特殊记号展开 —— 而 `bullet` 里含着用户给的 `body`，
           *   于是用户写 "cost $& and $` end" 会把整行、甚至前文都插回去，把记忆文件写坏
           *   （实测复现：`- **a** — cost - **a** — old line and  end`）。传函数就没这层解释。 */
          const next = content.replace(re, () => bullet)
          if (Buffer.byteLength(next) > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024}KB 上限`)
          writeFileSync(target.abs, next, 'utf8')
          this._textCache = { text: '', at: 0 }
          return { path: target.rel, replaced: true, entries: countBullets(next), content: next }
        }
      }
      content = content.replace(/\s*$/, '\n') + bullet + '\n'
    } else {
      const dir = dirname(target.abs)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const group = target.rel.includes('/') ? target.rel.slice(0, target.rel.indexOf('/')) : GLOBAL_DIR
      const topicName = target.rel.split('/').pop().replace(/\.[^.]+$/, '')
      content = `# ${group === GLOBAL_DIR ? '通用' : group} / ${topicName}\n\n${bullet}\n`
    }
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) {
      throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024}KB 上限，考虑拆成多个 topic`)
    }
    writeFileSync(target.abs, content, 'utf8')
    this._textCache = { text: '', at: 0 }
    return { path: target.rel, replaced: false, entries: countBullets(content), content }
  }

  /* ─────────────── 四类记忆（带元数据、同 key 累加） ─────────────── */

  /** 四类记忆的落点（每服一份；`rule` 是受保护文件，只能读） */
  kindTarget ({ kind, server = null } = {}) {
    const k = KIND_BY_KEY.get(String(kind ?? '').trim().toLowerCase())
    if (!k) throw new Error(`未知的记忆类别："${kind}"（可用 ${NOTE_KINDS.map((x) => x.key).join(' / ')}）`)
    if (k.key === 'rule') {
      throw new Error('用户规则住在 `RULES.md` 里（**受保护文件，只读**）—— 我看得到、改不了。'
        + '要改请让用户在记忆根里的 RULES.md 里改，或者在对话里直接告诉用户想加哪条。')
    }
    const dir = server ? String(server).trim() : GLOBAL_DIR
    return { kind: k.key, label: k.label, target: this.safePath(posix.join(dir, k.file)) }
  }

  /** 类别指南 + 现在库里各类各有几个文件（工具 action:"kinds"） */
  kinds () {
    const counts = {}
    for (const k of NOTE_KINDS) counts[k.key] = 0
    let other = 0
    for (const f of this.list()) {
      const low = f.rel.toLowerCase()
      const hit = NOTE_KINDS.find((k) => low === k.file.toLowerCase() || low.endsWith('/' + k.file.toLowerCase()))
      if (hit) counts[hit.key] += 1
      else if (low.endsWith('tasks.json')) counts.task += 1
      else other += 1
    }
    return {
      kinds: NOTE_KINDS,
      counts,
      other,
      text: memoryKindsText() + '\n现在库里：'
        + NOTE_KINDS.map((k) => `${k.label} ${counts[k.key]}`).join(' · ') + (other ? ` · 其它 ${other}` : ''),
    }
  }

  /**
   * 记一条**带元数据**的记忆（四类之一）：同 key 累加成功/失败次数，不堆重复条目。
   * 🔴 `ok:false` 时必须给 `condition` —— 用户路线图原话："失败记录要写清发生条件，
   *    不能把目标标成永久不可达"（"夜里在沼泽找不到沙" ≠ "这个世界没有沙"）。
   */
  record ({ kind, key = null, text, source = null, version = null, ok = null, condition = null, server = null } = {}) {
    const body = String(text ?? '').trim()
    if (!body) throw new Error('text 不能为空 —— 要记什么？')
    if (body.length > 1000) throw new Error(`一条记忆太长（${body.length} 字），上限 1000`)
    const k = String(key ?? '').trim()
    if (!k) throw new Error('record 需要 key（这条记忆的名字）：同 key 再记一次会累加成功/失败次数，而不是新增一条')
    if (k.length > 60) throw new Error(`key 太长（${k.length} 字，上限 60）`)
    const failed = ok === false
    const cond = String(condition ?? '').trim()
    if (failed && !cond) {
      throw new Error('失败记录要写清**发生条件**（"在什么情况下失败"），别写成永久结论（"X 不可达"）—— '
        + '补一个 condition，例如 condition:"背包里没有镐 / 隔着水 / 夜里怪太多"。')
    }

    const { kind: kk, label, target } = this.kindTarget({ kind, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (target.kind !== 'text') throw new Error(`${target.rel} 不是文本文件（record 只写 .md 笔记）`)

    const existed = existsSync(target.abs)
    const content0 = existed ? readFileSync(target.abs, 'utf8') : ''
    let merged = null
    const keep = []
    for (const line of content0 ? content0.split('\n') : []) {
      const e = parseEntry(line)
      if (e && String(e.key ?? '').trim().toLowerCase() === k.toLowerCase()) { merged = e; continue }
      keep.push(line)
    }
    const okN = (merged?.ok ?? 0) + (ok === true ? 1 : 0)
    const failN = (merged?.fail ?? 0) + (failed ? 1 : 0)
    const src = source ?? merged?.source ?? null
    const ver = version ?? merged?.version ?? null
    const finalCond = cond || merged?.condition || null
    const entry = renderEntry({ key: k, text: body, source: src, updatedAt: todayStr(), ok: okN, fail: failN, version: ver, condition: finalCond })

    let content
    if (!existed) {
      const group = target.rel.includes('/') ? target.rel.slice(0, target.rel.indexOf('/')) : GLOBAL_DIR
      content = `# ${group === GLOBAL_DIR ? '通用' : group} / ${label}\n\n${entry}\n`
    } else {
      content = keep.join('\n').replace(/\s*$/, '\n') + entry + '\n'
    }
    if (Buffer.byteLength(content) > MAX_TEXT_BYTES) throw new Error(`文件超过 ${MAX_TEXT_BYTES / 1024}KB 上限，考虑拆成多个文件`)
    const dir = dirname(target.abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(target.abs, content, 'utf8')
    this._textCache = { text: '', at: 0 }
    return {
      path: target.rel, kind: kk, label, key: k, text: body, source: src,
      updatedAt: todayStr(), ok: okN, fail: failN, version: ver, condition: finalCond,
      merged: Boolean(merged), entries: countBullets(content),
      note: merged
        ? `同 key 已有那条，累加后：成功 ${okN} / 失败 ${failN}（**没有新增条目**）`
        : `新增一条（${label}）。想让以后找得到，顺手在 \`README.md\` 的索引里加一行。`,
    }
  }

  /** 改：整文件覆盖（重组内容、写小标题/表格；任何文本扩展名都行） */
  write ({ path = null, topic = null, server = null, content } = {}) {
    const body = String(content ?? '')
    if (!body.trim()) throw new Error('content 不能为空（要删文件请用 action:"delete"）')
    if (Buffer.byteLength(body) > MAX_TEXT_BYTES) throw new Error(`内容超过 ${MAX_TEXT_BYTES / 1024}KB 上限`)
    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (target.kind === 'binary' || target.kind === 'image') {
      throw new Error(`${target.rel} 按二进制处理；要存文件请用 action:"put"（它会复制源文件）`)
    }
    const dir = dirname(target.abs)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    /* 🟡 2026-10-15 审计（报告 E 第 7 条）：原来无条件 `created: true` —— 覆盖已有文件时也报"已创建"，
     *   调用方（和模型）分不清"新建"和"覆盖"（覆盖是会丢东西的动作，得说清楚）。 */
    const existed = existsSync(target.abs)
    writeFileSync(target.abs, body.endsWith('\n') ? body : body + '\n', 'utf8')
    this._textCache = { text: '', at: 0 }
    return {
      path: target.rel, bytes: Buffer.byteLength(body), entries: countBullets(body),
      created: !existed, replaced: existed,
      ...(existed ? { note: `这个文件本来就有，这次是**整体覆盖**（原来的内容没了）—— 想追加请用 action:"append"` } : {}),
    }
  }

  /** 删：删文件；path 指向目录时整目录删 */
  delete ({ path = null, topic = null, server = null } = {}) {
    const target = path ? this.safePath(path) : this.pathFor({ topic, server })
    if (target.protected) throw new Error(protectedWriteError(target.rel))
    if (!existsSync(target.abs)) throw new Error(`没有这个文件/目录：${target.rel}`)
    const st = statSync(target.abs)
    if (st.isDirectory()) {
      rmSync(target.abs, { recursive: true, force: true })
      this._textCache = { text: '', at: 0 }
      return { deleted: target.rel, wasDirectory: true }
    }
    unlinkSync(target.abs)
    this._textCache = { text: '', at: 0 }
    return { deleted: target.rel, wasDirectory: false, remaining: this.list().length }
  }

  /** 查：跨文本文件搜索（二进制自动跳过） */
  search ({ query, limit = 30 } = {}) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) throw new Error('query 不能为空')
    const n = Math.min(Math.max(Number(limit) || 30, 1), 100)
    const hits = []
    for (const f of this.list()) {
      if (f.kind !== 'text') continue
      let text = ''
      try { text = readFileSync(join(this.root, ...f.rel.split('/')), 'utf8') } catch { continue }
      for (const [i, line] of text.split('\n').entries()) {
        if (line.toLowerCase().includes(q)) hits.push({ path: f.rel, line: i + 1, text: line.trim() })
        if (hits.length >= n) break
      }
      if (hits.length >= n) break
    }
    return { query, matched: hits.length, hits }
  }

  /** 总览（工具 action:"index" 用） */
  overview () {
    const files = this.list()
    const groups = new Map()
    for (const f of files) {
      if (!groups.has(f.group)) groups.set(f.group, [])
      groups.get(f.group).push(f)
    }
    let readme = ''
    try { readme = existsSync(this.readmePath) ? readFileSync(this.readmePath, 'utf8') : '' } catch {}
    return {
      root: this.root,
      readmePath: this.readmePath,
      totalFiles: files.length,
      totalEntries: files.reduce((n, f) => n + (f.entries ?? 0), 0),
      groups: [...groups.entries()].map(([group, list]) => ({
        group: group === GLOBAL_DIR ? '(通用)' : group,
        files: list.map((f) => ({ path: f.rel, kind: f.kind, entries: f.entries, updatedAt: f.updatedAt, summary: f.summary })),
      })),
      readme,
      tree: this.renderTree(),
    }
  }
}

/* ─────────────── 工具函数 ─────────────── */

/** 判定文件种类：text / image / binary */
function kindOf (name, abs) {
  const ext = extname(String(name)).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (TEXT_EXT.has(ext)) return 'text'
  // 扩展名不认识 → 嗅探前 8KB 有没有 NUL 字节（有 = 二进制）
  try {
    const fd = openSync(abs, 'r')
    try {
      const buf = Buffer.alloc(8192)
      const n = readSync(fd, buf, 0, 8192, 0)
      return buf.subarray(0, n).includes(0) ? 'binary' : 'text'
    } finally { closeSync(fd) }
  } catch { return 'binary' }
}

function summarize (lines) {
  const quote = lines.find((l) => /^>\s*\S/.test(l))
  const src = quote ?? lines.find((l) => /^\s*[-*]\s+\S/.test(l)) ?? ''
  return src.replace(/^[>\s\-*]+/, '').slice(0, 60)
}

const countBullets = (text) => (text.match(/^\s*[-*]\s+\S/gm) ?? []).length
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
