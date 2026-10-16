#!/usr/bin/env node
/**
 * scan-moved-assertions.mjs —— 拆分 `src/core.mjs` 时的"漏改断言"扫描器（顾问型，不判红）
 *
 * 为什么要它（2026-10-08，路线图第 ④ 条）：静态断言里有一大类是"**按文件找代码**"——
 * `ok(/const R = Math\.min\(…\)/.test(CORE), …)` 这种。模块一搬走，这类断言就红，
 * 而红的是**断言**不是行为；更麻烦的是"你只改了想到的那个套件，另一个套件里还有一条同款"。
 * 实测：第十二刀（world-scan）改了 `check-core-entities.mjs`，却漏了
 * `check-token-budget.mjs` 第 5 节的两条同款断言 —— 直到第十六刀做全仓扫描才发现。
 *
 * 它做三件事：
 *   ① 把 `src/*.mjs` 的**导出名**收集起来（= 已经从 core 搬走的候选）；
 *   ② 扫 `tools/check-*.mjs` + `selfcheck.mjs` 里所有 `.test(CORE|core|coreSrc|src|INDEX)` 的断言；
 *   ③ 挑出"提到这些导出名 **且** 正则里带实现细节（`const`/`return`/`=>`/`if (`/`===`/`Math.`…）"的，
 *      按文件分组列出来 —— 这些就是要人工确认的：**它是在断言薄包装（没事），还是在断言已经搬走的方法体（要改成查新模块）**。
 *
 * 它**不判红、不影响退出码**：结果需要人看（薄包装与真实现的区别，机器分不清）。
 * 用法：node tools/scan-moved-assertions.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')

/* ① 收集 src/*.mjs 的导出名（core.mjs 自己不算） */
const moved = new Map()   // name → module
for (const f of readdirSync(SRC).filter((x) => x.endsWith('.mjs') && x !== 'core.mjs')) {
  const text = readFileSync(join(SRC, f), 'utf8')
  for (const m of text.matchAll(/^export (?:async )?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!moved.has(m[1])) moved.set(m[1], f)
  }
  // 也要 `export { a, b }` 这种
  for (const m of text.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim()
      if (/^[A-Za-z_$][\w$]*$/.test(n) && !moved.has(n)) moved.set(n, f)
    }
  }
}
const names = [...moved.keys()]

/* ②③ 扫断言 */
const suites = [
  ...readdirSync(join(ROOT, 'tools')).filter((f) => /^check-.*\.mjs$/.test(f)).map((f) => 'tools/' + f),
  'selfcheck.mjs',
]
const IMPL = /const |=>|\breturn\b|if \(|= |\.push\(|\.splice\(|\.slice\(|Math\.|\.map\(|\bawait\b|new |\.\w+\(|\?\?|\|\|/
const rows = []
for (const f of suites) {
  const lines = readFileSync(join(ROOT, f), 'utf8').split('\n')
  lines.forEach((line, i) => {
    const m = /\.test\((CORE|core|coreSrc|src|INDEX|idx)\)/.exec(line)
    if (!m) return
    const hit = names.filter((n) => new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(line))
    if (!hit.length) return
    /* 🔴 2026-10-08 第十七刀补的：原来只把**第一个** `.test(...)` 之前的部分拿去判"有没有实现细节"，
     *    于是 `ok(/#aimAt \(b, point\)/.test(coreSrc) && /b\.entity\.yaw = yaw/.test(coreSrc), …)`
     *    这种"**同一个 ok 里两条正则**"的断言会漏掉（后半条 `= yaw` 才是被搬走的实现）。
     *    现在把整行里所有 `.test(<ident>)` 抠掉再判，并且把 `= `、`.方法(`、`??`、`||` 也算实现细节。 */
    const probe = line.replace(/\.test\((CORE|core|coreSrc|src|INDEX|idx)\)/g, '')
    if (!IMPL.test(probe)) return
    rows.push({ f, line: i + 1, mods: [...new Set(hit.map((n) => moved.get(n)))], names: hit, text: line.trim().slice(0, 170) })
  })
}

console.log(`src/ 里的非 core 模块共导出 ${names.length} 个名字；`)
console.log(`扫到 ${rows.length} 条"按文本找 core、且提到这些名字、且正则带实现细节"的断言 —— 逐条确认它断言的是薄包装还是已搬走的方法体：\n`)
let last = ''
for (const r of rows) {
  if (r.f !== last) { console.log(`── ${r.f}`); last = r.f }
  console.log(`  :${r.line}  [${r.names.join(', ')} → src/${r.mods.join(', src/')}]`)
  console.log(`      ${r.text}`)
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 第二遍（2026-10-08 第二十三刀补）：**不认名字，直接拿正则去目标文件里试**。
 *
 * 为什么非要有这一遍：第一遍要求"这一行里出现某个已搬走的导出名"，于是
 *   `ok(/budgetMs: 300/.test(src), '#grabDrops 捡不到时收尾…')` 这种**断言里没提名字**的
 *   （名字只写在旁边的注释里）一条也扫不到 —— 而 `budgetMs: 300` 正是随着 `#grabDrops`
 *   一起搬进 `src/pickup.mjs` 的。判据很朴素：**这条断言的正则，在它断言的那个文件里还找得到吗？**
 *   找不到、却能在别的 `src/*.mjs` 里找到 ⇒ 基本可以断定"代码搬走了，断言没跟着搬"。
 *
 * 只报"在别的模块里找到了"的（这是强信号）；负向断言（`!/…/.test(x)`）本来就该找不到，跳过。
 * ───────────────────────────────────────────────────────────────────────────── */
const coreRaw = readFileSync(join(SRC, 'core.mjs'), 'utf8')
const coreStripped = coreRaw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
const modFiles = readdirSync(SRC).filter((x) => x.endsWith('.mjs') && x !== 'core.mjs')
const modText = new Map()
for (const f of modFiles) {
  const t = readFileSync(join(SRC, f), 'utf8')
  modText.set(f, { raw: t, stripped: t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') })
}
/* 变量 → 它到底读的是哪个文件：`const src = readFileSync(new URL('../src/core.mjs'…))`，
 * 以及 `const src = raw.replace(…)` 这种从别的变量派生的（派生两三轮就够）。
 * 认不出的变量按"可能是 core"处理（宁可多报，别漏报）。 */
const targetOf = (text) => {
  const t = new Map()
  for (const m of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*readFileSync\(\s*new URL\(\s*'(\.\.?\/[^']+)'/g)) t.set(m[1], m[2].replace(/^\.\.?\//, ''))
  for (let k = 0; k < 3; k++) {
    for (const m of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*([A-Za-z_$][\w$]*)\b/g)) {
      if (!t.has(m[1]) && t.has(m[2])) t.set(m[1], t.get(m[2]))
    }
  }
  return t
}
let skippedOther = 0
const stale = []
const RE_LIT = /(\/)((?:\\.|[^/\\\n])*)(\/)\.test\((CORE|core|coreSrc|src|INDEX|idx)\)/g
for (const f of suites) {
  const text = readFileSync(join(ROOT, f), 'utf8')
  const targets = targetOf(text)
  const lines = text.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(RE_LIT)) {
      if (line[m.index - 1] === '!') continue            // 负向断言，本来就该找不到
      const tgt = targets.get(m[4])                       // 这个变量读的是哪个文件
      if (tgt && !/src\/core\.mjs$/.test(tgt)) { skippedOther++; continue }   // 断言的是 index.js / 扩展 / 别的 src 模块 ⇒ 与 core 无关
      if (/^\^?\s*\/\//.test(m[2])) continue
      let re = null
      try { re = new RegExp(m[2]) } catch { continue }
      if (re.test(coreStripped) || re.test(coreRaw)) continue   // 在 core 里还找得到 ⇒ 没事
      const where = modFiles.filter((g) => re.test(modText.get(g).stripped) || re.test(modText.get(g).raw))
      if (where.length) stale.push({ f, line: i + 1, pat: m[2].slice(0, 90), where })
    }
  })
}
console.log(`\n【第二遍】正则"在 core 里已经找不到、却在别的模块里找得到"的断言：${stale.length} 条`)
console.log(`（另有 ${skippedOther} 条断言的是 index.js / 扩展 / 别的 src 模块，已跳过）`)
for (const r of stale) {
  console.log(`  ${r.f}:${r.line}  → src/${r.where.join(', src/')}`)
  console.log(`      /${r.pat}/`)
}
if (!stale.length) console.log('  （没有：每一条按文本找 core 的断言，在 core 里都还找得到）')
console.log('\n（薄包装 = 没事；方法体 = 把断言改成查新模块，并补一条"core 确实 import 了"的接线断言）')
