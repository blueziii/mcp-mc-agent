#!/usr/bin/env node
/**
 * check-mc-deps.mjs —— vendor 依赖体检
 *
 * 为什么需要它：DSH 的模块解析器有个地雷（`dsh-app-boot/lib/index.js:1423`）——
 *   对 `require('<内置模块>/')` 这种**带尾斜杠的内置名**，`barePackageName()` 会把斜杠去掉、
 *   得到 `'string_decoder'` 这样的名字，再调 `createRequire(parent).resolve.paths(name)`；
 *   而内置模块名会让它返回 **null**，`for...of null` 直接抛
 *   `TypeError: createRequire.resolve.paths is not a function or its return value is not iterable`。
 *   → 整个 `import()` 失败 → 那一项能力（寻路/挖/换工具/打怪）静默消失。
 *
 * 这个脚本把整棵依赖树里的 require/import 全过一遍，用**和 DSH 一样的判据**找地雷；
 * 再按 `src/plugins.mjs` 的候选路径把 5 个 vendor 依赖 import 一遍验形状；
 * 最后检查 mineflayer-tool 那个**无限递归补丁**还在不在（见第 4 节，会 OOM 的坑）。
 * 每次 `npm install` 之后跑一次（readable-stream 是传递依赖，重装可能把地雷带回来）。
 *
 * 用法：node tools/check-mc-deps.mjs [vendor 目录] [--quick]
 *   --quick 只扫 vendor 树，不扫 profile 的 node_modules（快很多）
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire, isBuiltin } from 'node:module'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const QUICK = process.argv.includes('--quick')

// ── 找 vendor 树 ──────────────────────────────────────────────────────────────
function pickVendor () {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const cands = [
    arg,
    process.env.MCP_MC_AGENT_MC_DEPS,
    resolve(HERE, '../../../vendor/mc-deps'),                                  // 包内：<profile>/node_modules/mcp-mc-agent/tools → <profile>
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'vendor', 'mc-deps'),
  ].filter((p) => typeof p === 'string' && p && existsSync(p))
  return cands[0] ?? null
}

const VENDOR = pickVendor()
if (!VENDOR) {
  console.log('✗ 找不到 vendor 树 —— 用参数指定：node tools/check-mc-deps.mjs <vendor 目录>')
  process.exit(2)
}
const VN = join(VENDOR, 'node_modules')
const PROFILE = resolve(VENDOR, '..', '..')             // <profile>
const PROFILE_NM = join(PROFILE, 'node_modules')

// ── DSH 解析器判据的复刻（dsh-app-boot/lib/index.js:1165 barePackageName）────────
function barePackageName (request) {
  if (!request || request[0] === '.' || request[0] === '/' || request[0] === '\\' || request[0] === '#' || request.includes(':') || isBuiltin(request)) return
  const first = request.indexOf('/')
  if (request[0] !== '@') return first < 0 ? request : request.slice(0, first)
  if (first < 0) return
  const second = request.indexOf('/', first + 1)
  return second < 0 ? request : request.slice(0, second)
}

const SPEC_RE = /(?:require\s*\(\s*|from\s+|import\s*\(\s*)(['"])([^'"\n]+)\1/g

function walkJs (dir, out = []) {
  let ents
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) { if (e.name !== '.git' && e.name !== 'test' && e.name !== 'examples') walkJs(p, out) }
    else if (/\.(js|cjs|mjs)$/.test(e.name)) out.push(p)
  }
  return out
}

// ── 断言小工具 ────────────────────────────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 1. 地雷扫描 ───────────────────────────────────────────────────────────────
section('1. 地雷扫描（DSH 解析器 :1423 会炸的 require/import）')
const roots = [[VN, 'vendor 树']]
if (!QUICK && existsSync(PROFILE_NM)) roots.push([PROFILE_NM, 'profile node_modules'])

let files = 0, specs = 0
const mines = []
for (const [root, label] of roots) {
  const list = walkJs(root)
  for (const f of list) {
    let src
    try {
      if (statSync(f).size > 4_000_000) continue
      src = readFileSync(f, 'utf8')
    } catch { continue }
    files++
    let req
    try { req = createRequire(f) } catch { continue }
    SPEC_RE.lastIndex = 0
    let m
    while ((m = SPEC_RE.exec(src))) {
      const spec = m[2]
      const name = barePackageName(spec)
      if (name === undefined) continue
      specs++
      let paths = null, threw = null
      try { paths = req.resolve.paths(name) } catch (e) { threw = e.code ?? e.message }
      if (paths === null || threw) mines.push({ f, spec, name, label, threw })
    }
  }
}
ok(mines.length === 0, '依赖树里没有会踩 :1423 的 require',
  `扫了 ${files} 个文件 / ${specs} 处裸包请求${mines.length ? `，命中 ${mines.length} 处` : ''}`)
for (const b of mines) {
  console.log(`      ✗ ${b.f}`)
  console.log(`          require("${b.spec}") → barePackageName="${b.name}"${b.threw ? ' THROW ' + b.threw : ''}`)
  console.log(`          改法：把尾斜杠去掉（'${b.name}/' → '${b.name}'）`)
}

// ── 2. 5 个 vendor 依赖能否按 plugins.mjs 的候选路径 import ───────────────────────
section('2. vendor 依赖 import（走 src/plugins.mjs 的候选 2：<profile>/vendor/mc-deps）')
const DEPS = [
  ['pathfinder', 'mineflayer-pathfinder', 'index.js', 'pathfinder'],
  ['collectBlock', 'mineflayer-collectblock', 'lib/index.js', 'plugin'],
  ['tool', 'mineflayer-tool', 'lib/index.js', 'plugin'],
  ['pvp', 'mineflayer-pvp', 'lib/index.js', 'plugin'],
  ['autoEat', 'mineflayer-auto-eat', 'dist/index.js', 'loader'],
]
for (const [key, pkg, entry, want] of DEPS) {
  const file = join(VN, pkg, entry)
  if (!existsSync(file)) { ok(false, `${key}：${pkg} 已装`, '文件不存在'); continue }
  let version = '?'
  try { version = JSON.parse(readFileSync(join(VN, pkg, 'package.json'), 'utf8')).version } catch {}
  try {
    const m = await import(pathToFileURL(file).href)
    const d = m?.default
    const fn = m?.[want] ?? d?.[want]
    if (key === 'pathfinder') {
      const mod = { pathfinder: m.pathfinder ?? d?.pathfinder, Movements: m.Movements ?? d?.Movements, goals: m.goals ?? d?.goals }
      ok(!!(mod.pathfinder && mod.Movements && mod.goals), `pathfinder：import 成功且形状完整（pathfinder/Movements/goals）`, `v${version}`)
    } else {
      ok(typeof fn === 'function', `${key}：import 成功且拿到 ${want}()`, `v${version}`)
    }
  } catch (e) {
    ok(false, `${key}：import 成功`, `${e?.code ?? ''} ${String(e?.message).split('\n')[0]}`)
  }
}

// ── 3. readable-stream 的尾斜杠内置名（这类地雷的历史来源）────────────────────
section('3. readable-stream 里的尾斜杠内置名（历史地雷来源）')
for (const [dir, label] of [[VN, 'vendor 树'], [PROFILE_NM, 'profile']]) {
  const rs = join(dir, 'readable-stream', 'lib', 'internal', 'streams')
  if (!existsSync(rs)) { console.log(`  · ${label}：没有 readable-stream（跳过）`); continue }
  const hits = []
  for (const f of walkJs(rs)) {
    const src = readFileSync(f, 'utf8')
    SPEC_RE.lastIndex = 0
    let m
    while ((m = SPEC_RE.exec(src))) {
      const spec = m[2]
      if (!spec.endsWith('/')) continue
      if (isBuiltin(spec.replace(/\/$/, ''))) hits.push(`${f} → require('${spec}')`)
    }
  }
  ok(hits.length === 0, `${label} readable-stream 里没有 require('<内置名>/')`, hits.join('; '))
}

// ── 4. mineflayer-tool 的无限递归补丁还在不在 ────────────────────────────────
section('4. mineflayer-tool 的无限递归补丁（重装 vendor 树后必须重新打）')
/* 上游 bug：`equipForBlock` 在 itemList 为空时（手上/背包里没有能挖这块的工具）
 * 若 `getFromChest` 为真，就去 retrieveTools 翻箱子；而 chestLocations 为空时
 * retrieveTools **正常返回、什么都没拿到**，第 127 行又原样递归回来 →
 * 每次递归一个新 promise，不报错也不结束，只吃内存。
 * 实机：挖石头（空手）十几秒内 JS 堆涨到几 GB，OOM；而且全在微任务里跑，
 * setTimeout / withTimeout 一律不触发。补丁 = 加一个 `_triedChest` 只翻一次。 */
for (const [dir, label] of [[VN, 'vendor 树'], [PROFILE_NM, 'profile']]) {
  const toolJs = join(dir, 'mineflayer-tool', 'lib', 'Tool.js')
  if (!existsSync(toolJs)) { console.log(`  · ${label}：没有 mineflayer-tool（跳过）`); continue }
  const src = readFileSync(toolJs, 'utf8')
  ok(/_triedChest/.test(src), `${label} mineflayer-tool/lib/Tool.js 有 _triedChest 防递归补丁`,
    '没有的话：手上没有能挖的工具时挖方块会让 JS 堆十几秒涨到几 GB 直接 OOM')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
