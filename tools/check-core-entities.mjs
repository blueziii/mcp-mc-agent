#!/usr/bin/env node
/**
 * check-core-entities.mjs —— `entities()`（附近有谁：怪/玩家/生物在哪、多少血）回归检查
 *
 * 背景：用户 2026-10-06 问「可不可以获取附近怪物的位置」。上游**本来就有** `mc_entities`
 * → `bot.entities(radius)`，但只给「名字 / 类型 / 坐标 / 距离」；这次把它补成
 * 「分类 + 血量 + 远程标记 + kind 过滤 + 计数」，**没有另开一个平行工具**（两个重叠的工具
 * 只会让模型挑花眼）。数据全是 mineflayer 内核的 `bot.entities`（服务端 spawn / teleport /
 * relative-move 包喂进去的），**不用扫方块、不用自己算**。
 * 2026-10-08（用户「不要只让 AI 看截图，也不要只让 AI 读取方块坐标」）：`mc_entities`
 * 这个工具**下掉了**，实体列表并进 `mc_observe` 的「② 程序检测到」那段 —— `entities()` 本身没动，
 * 所以这个套件的 ①~⑧ 照旧跑；⑨ 的静态检查改成盯 `mc_observe` 里的感知块。
 *
 * 这个脚本把下面几件事钉死（防止以后改坏）：
 *   ① 自己不算进去；按距离排序；hostile / player / other 分类；
 *   ② `kind` 过滤（all / hostile / player / mob）；radius 过滤 + 钳制（1..128）；
 *   ③ 血量**优先**用 `bot.util.entity.getHealth`；助手缺失/抛错时退回 `e.health`，绝不炸；
 *   ④ 距离**优先**用 `bot.util.entity.entityDistance`（证明用的是现成助手，不是自己算）；
 *   ⑤ `e.kind === 'Hostile mobs'` 也算敌对（名字不在名单里的怪也能认出来）；
 *   ⑥ 静态检查：`index.js` 里**没有**第二个实体工具（`mc_entities` 已并进 `mc_observe`）、
 *      感知块用了 `entities()`、不在看图门禁名单里；
 *      `core.mjs` 的 HOSTILE/RANGED 名单与 `extensions/mc_auto.mjs` 的逐字一致。
 *
 * 用法：node tools/check-core-entities.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/mcp-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖：源码树里没有 node_modules，从包目录借 vec3 ────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,                  // 包内直接就有
    join(PROFILE, 'node_modules', 'mcp-mc-agent', 'index.js'),      // 源码树 → 借包里的
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/mcp-mc-agent）跑，')
  console.log('  或确认已安装 mineflayer。')
  process.exit(2)
}
const Vec3 = req('vec3')
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (bot) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-coreent-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  return mc
}

/** 造一个假实体 */
const ent = (name, x, y, z, extra = {}) => ({
  name, type: extra.type ?? 'mob', position: new Vec3(x, y, z),
  metadata: {}, ...extra,
})

/**
 * 假 bot：只有 `entities()` 会碰的字段。
 * @param o.withUtil 是否挂 `bot.util.entity`（auto-eat 注入的那个现成助手）
 * @param o.utilThrows 助手故意抛错（验证不会把工具炸掉）
 */
const mkBot = ({ me = { x: 0, y: 64, z: 0 }, withUtil = true, utilThrows = false, noPos = false } = {}) => {
  const calls = { dist: 0, health: 0 }
  const entities = {
    1: { type: 'player', username: 'Bluezi', position: new Vec3(2, 64, 0), metadata: {} },
    2: ent('creeper', 5, 64, 0),
    3: ent('cow', 0, 64, 8),
    4: ent('skeleton', 0, 64, 10),
    5: ent('mystery_mob', 0, 67.4, 12, { kind: 'Hostile mobs' }),
  }
  const bot = {
    entity: { position: noPos ? undefined : new Vec3(me.x, me.y, me.z), height: 1.8 },
    entities,
    players: { Bluezi: {} },
  }
  if (withUtil) {
    bot.util = {
      entity: {
        entityDistance: (e) => {
          calls.dist++
          if (utilThrows) throw new Error('助手炸了')
          // 🔴 故意**不是**点到点距离：用来证明 entities() 真的走了这个助手
          if (e.name === 'creeper') return 7.5
          return bot.entity.position.distanceTo(e.position)
        },
        getHealth: (e) => {
          calls.health++
          if (utilThrows) throw new Error('助手炸了')
          if (e.name === 'creeper') return 17.64
          if (e.name === 'skeleton') return 0        // 助手读不到 ⇒ 不该当成 0 血报出来
          return 10
        },
      },
    }
  }
  return { bot, entities, calls }
}

/* ─────────── ① 分类、排序、排除自己 ─────────── */
section('① 分类 / 排序 / 不把自己算进去')
{
  const fake = mkBot()
  const mc = mkMc(fake.bot)
  const r = mc.entities()
  ok(r.me && r.me.x === 0 && r.me.y === 64 && r.me.z === 0, '报了自己的整数坐标', JSON.stringify(r.me))
  ok(r.list.length === 5, '5 个实体都列出来了（不含自己）', `len=${r.list.length}`)
  ok(r.counts.hostile === 3 && r.counts.player === 1 && r.counts.other === 1,
    '分类计数：敌对 3 / 玩家 1 / 其它 1', JSON.stringify(r.counts))
  ok(r.list[0].name === 'Bluezi' && r.list[0].kind === 'player', '最近的排最前（玩家 Bluezi）', r.list[0].name)
  const names = r.list.map((x) => x.name).join(',')
  ok(names === 'Bluezi,creeper,cow,skeleton,mystery_mob', '按距离升序', names)
  ok(r.list.every((x) => !(x.position.x === 0 && x.position.y === 64 && x.position.z === 0 && x.distance === 0)),
    '自己没有出现在列表里')
}

/* ─────────── ② kind 过滤 ─────────── */
section('② kind 过滤（all / hostile / player / mob）')
{
  const mc = mkMc(mkBot().bot)
  const h = mc.entities(24, { kind: 'hostile' })
  ok(h.list.length === 3 && h.list.every((x) => x.kind === 'hostile'), 'kind=hostile 只给敌对', h.list.map((x) => x.name).join(','))
  const p = mc.entities(24, { kind: 'player' })
  ok(p.list.length === 1 && p.list[0].name === 'Bluezi', 'kind=player 只给玩家', p.list.map((x) => x.name).join(','))
  const m = mc.entities(24, { kind: 'mob' })
  ok(m.list.length === 4 && m.list.every((x) => x.kind !== 'player'), 'kind=mob 给生物但不给玩家', m.list.map((x) => x.name).join(','))
  const a = mc.entities(24, { kind: 'ALL' })
  ok(a.list.length === 5, 'kind 大小写不敏感', `len=${a.list.length}`)
}

/* ─────────── ③ radius 过滤与钳制 ─────────── */
section('③ radius 过滤 + 钳制（1..128）')
{
  const mc = mkMc(mkBot().bot)
  const r6 = mc.entities(6)
  ok(r6.list.length === 1 && r6.list[0].name === 'Bluezi',
    'radius=6 只留 6 格内的（creeper 用助手报的 7.5 ⇒ 筛掉，证明筛的是助手那个距离）',
    r6.list.map((x) => `${x.name}:${x.distance}`).join(','))
  const r8 = mc.entities(8)
  ok(r8.list.map((x) => x.name).join(',') === 'Bluezi,creeper,cow',
    'radius=8 ⇒ creeper(7.5) 和 cow(8) 都在，skeleton(10) 不在',
    r8.list.map((x) => `${x.name}:${x.distance}`).join(','))
  ok(mc.entities(9999).radius === 128, 'radius 上限钳到 128')
  ok(mc.entities(0).radius === 24, 'radius 给 0 ⇒ 退回默认 24')
  ok(mc.entities(-5).radius === 1, 'radius 给负数 ⇒ 钳到 1')
}

/* ─────────── ④ 坐标取整 + 上下差 ─────────── */
section('④ 坐标取整 + 上下差 dy')
{
  const mc = mkMc(mkBot().bot)
  const r = mc.entities()
  const my = r.list.find((x) => x.name === 'mystery_mob')
  ok(my.position.y === 67, 'y 取整（67.4 → 67）', String(my.position.y))
  ok(my.dy === 3.4, 'dy = 对方 y − 我的 y（67.4 − 64 = 3.4）', String(my.dy))
  const c = r.list.find((x) => x.name === 'cow')
  ok(c.dy === 0, '同高时 dy 是 0（不是 undefined/NaN）', String(c.dy))
}

/* ─────────── ⑤ 血量 / 距离走现成的 util 助手 ─────────── */
section('⑤ 血量、距离优先用现成的 bot.util.entity.*')
{
  const fake = mkBot()
  const mc = mkMc(fake.bot)
  const r = mc.entities()
  const cr = r.list.find((x) => x.name === 'creeper')
  ok(cr.distance === 7.5, '距离用的是助手报的值（不是自己算的 5）', String(cr.distance))
  ok(cr.health === 17.6, '血量用的是助手报的值（17.64 → 17.6）', String(cr.health))
  ok(fake.calls.dist >= 5 && fake.calls.health >= 5, '每个实体都问了助手', `dist=${fake.calls.dist} health=${fake.calls.health}`)
  const sk = r.list.find((x) => x.name === 'skeleton')
  ok(sk.health === undefined, '助手报 0（读不到血）⇒ 干脆不写 health 字段', String(sk.health))
}

/* ─────────── ⑥ 助手缺失 / 助手抛错：退回自己算，绝不炸 ─────────── */
section('⑥ 没有 util 助手 / 助手抛错 ⇒ 退回自己算，不炸')
{
  const noUtil = mkBot({ withUtil: false })
  const r1 = mkMc(noUtil.bot).entities()
  ok(r1.list.length === 5, '没有 bot.util 也照常列出来', `len=${r1.list.length}`)
  ok(r1.list.find((x) => x.name === 'creeper').distance === 5, '退回点到点距离（5）', String(r1.list.find((x) => x.name === 'creeper').distance))

  const boom = mkBot({ utilThrows: true })
  let threw = null
  let r2 = null
  try { r2 = mkMc(boom.bot).entities() } catch (e) { threw = e }
  ok(threw === null, '助手抛错也不会把 entities() 炸掉', threw ? String(threw.message) : '')
  ok(r2 && r2.list.length === 5, '助手抛错时仍然返回完整列表', r2 ? `len=${r2.list.length}` : 'null')
  ok(r2 && r2.list.find((x) => x.name === 'creeper').distance === 5, '助手抛错时退回点到点距离', r2 ? String(r2.list.find((x) => x.name === 'creeper').distance) : '')
}

/* ─────────── ⑦ e.kind === 'Hostile mobs' 也算敌对；玩家优先 ─────────── */
section('⑦ 分类的兜底：kind=Hostile mobs 也算敌对；有 username 就是玩家')
{
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: {
      1: ent('mystery_mob', 3, 64, 0, { kind: 'Hostile mobs' }),
      2: { type: 'player', username: 'skeleton_fan', position: new Vec3(4, 64, 0), metadata: {} },
      3: ent('skeleton', 5, 64, 0, { kind: 'Passive mobs' }),
    },
  }
  const r = mkMc(bot).entities()
  const my = r.list.find((x) => x.name === 'mystery_mob')
  ok(my.kind === 'hostile' && my.hostile === true, '名字不在名单里，但 kind=Hostile mobs ⇒ 算敌对')
  const fan = r.list.find((x) => x.name === 'skeleton_fan')
  ok(fan.kind === 'player' && fan.player === true, '有 username 就是玩家（不会被名字里的 skeleton 误判成怪）')
  const sk = r.list.find((x) => x.name === 'skeleton')
  ok(sk.kind === 'hostile' && sk.hostile === true, '名字在名单里就够（不看 kind）')
  ok(sk.ranged === true && my.ranged === false, '远程怪名单：skeleton 是，mystery_mob 不是')
}

/* ─────────── ⑧ limit / 没有位置信息 / 掉落物（没有 name）─────────── */
section('⑧ limit 截断 + 还没位置信息时不炸 + 掉落物也能列出来')
{
  const mc = mkMc(mkBot().bot)
  const l2 = mc.entities(24, { limit: 2 })
  ok(l2.list.length === 2 && l2.total === 5, 'limit=2 只列 2 个，但 total 还是 5', `len=${l2.list.length} total=${l2.total}`)
  ok(mc.entities(24, { limit: 999 }).list.length === 5, 'limit 超过总数时不会多给', `len=${mc.entities(24, { limit: 999 }).list.length}`)
  const none = mkMc(mkBot({ noPos: true }).bot).entities()
  ok(none && none.error && /位置/.test(none.error), '没有位置信息时返回 error 字段而不是抛错', String(none.error))

  const dropBot = {
    entity: { position: new Vec3(0, 64, 0) },
    entities: { 1: { type: 'object', name: 'item', position: new Vec3(1, 63, 0), metadata: {} } },
  }
  const rd = mkMc(dropBot).entities()
  ok(rd.list.length === 1 && rd.list[0].name === 'item' && rd.list[0].kind === 'other', '掉落物（type=object）也列出来，归到"其它"')
}

/* ─────────── ⑨ 静态检查：工具注册 + 门禁 + 名单一致性 + 实现位置 ─────────── */
section('⑨ 静态检查（实体工具已并进 mc_observe 感知块、不看图门禁、名单与 mc_auto 一致、实现在 world-scan.mjs）')
{
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const auto = readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8')
  const view = readFileSync(new URL('../extensions/mc_observe.mjs', import.meta.url), 'utf8')

  ok(!/name: 'mc_mobs'/.test(idx), '没有另开平行的 mc_mobs 工具')
  /* 2026-10-08：`mc_entities` 并进 `mc_observe` 的三段式感知（用户要求"一次调用给全"）⇒
   * 这里改成钉"没有第二个实体工具" + "感知块真的用了 entities()" + "不确定清单在"。 */
  ok(!/name: 'mc_entities'/.test(idx), 'mc_entities 不再单独注册（实体信息在 mc_observe 的"程序检测到"里）')
  ok(/程序检测到/.test(view), 'mc_observe 有"程序检测到"那段')
  ok(/bot\.entities\(distance, \{ kind: 'all', limit: 16 \}\)/.test(view), '感知块的实体列表走 core 的 entities()（同一份判据）')
  ok(/不确定/.test(view), 'mc_observe 有"不确定"清单（别把推测当事实）')
  const segAt = view.indexOf('程序侧实体')
  const seg = view.slice(segAt, segAt + 2600)
  ok(segAt > 0 && /kind/.test(seg) && /limit/.test(seg), '感知块里按 kind 分类 + limit 限制条数')

  const gated = (view.match(/DEFAULT_GATED\s*=\s*\[([^\]]*)\]/) ?? [])[1] ?? ''
  ok(!/mc_entities/.test(gated), 'mc_entities 不在看图门禁名单里（只读工具永不拦）', gated.replace(/\s+/g, ' ').slice(0, 90))

  /* 🔴 2026-10-08 第十二刀：`scan()` / `entities()` 的**实现**搬到 `src/world-scan.mjs`
   * （它们是公开方法 ⇒ `core.mjs` 里留同名薄包装）。所以"实现长什么样"要读新文件；
   * 另外补两条"确实接上了"的断言 —— 否则"搬走 + 忘 import"这种错也能绿。 */
  const scanSrc = readFileSync(new URL('../src/world-scan.mjs', import.meta.url), 'utf8')
  ok(/export function entitiesNear \(b, radius = 24, \{ kind = 'all', limit = 40 \} = \{\}\)/.test(scanSrc), 'world-scan.mjs 里有 entitiesNear(b, radius, {kind, limit}) 默认值')
  ok(/export function scanAround \(b, \{ radius = 16, height = 4, name = null, limit = 10 \} = \{\}\)/.test(scanSrc), 'world-scan.mjs 里有 scanAround(b, {radius, height, name, limit}) 默认值（半径默认 16 = 1 区块）')
  ok(/const R = Math\.min\(Math\.max\(radius, 1\), 48\)/.test(scanSrc), 'scanAround 的半径上限是 48')
  ok(/^import \{ scanAround, entitiesNear \} from '\.\/world-scan\.mjs'$/m.test(core), 'core.mjs 确实从 world-scan.mjs 导入（别只搬不接）')
  ok(/entities \(radius = 24, opts = \{\}\) \{ return entitiesNear\(this\.requireBot\(\), radius, opts\) \}/.test(core), 'entities 是薄包装（照样先 requireBot）')
  ok(/scan \(opts = \{\}\) \{ return scanAround\(this\.requireBot\(\), opts\) \}/.test(core), 'scan 是薄包装（照样先 requireBot）')
  ok(!/^  entities \(radius = 24, \{ kind = 'all'/m.test(core) && !/^  scan \(\{ radius = 16/m.test(core), 'core.mjs 里没有残留的 scan/entities 实现')
  ok(/b\?\.util\?\.entity/.test(scanSrc), 'world-scan.mjs 走现成的 bot.util.entity 助手')

  const pick = (src, name) => {
    const m = src.match(new RegExp(`const ${name} = (/[^\\n]*/[a-z]*)`))
    return m ? m[1] : null
  }
  // 🔴 2026-10-08 第四刀：两份名单已搬到 src/entity-names.mjs ⇒ 逐字比对要读新文件
  const names = readFileSync(new URL('../src/entity-names.mjs', import.meta.url), 'utf8')
  const h1 = pick(names, 'HOSTILE_RE'); const h2 = pick(auto, 'HOSTILE')
  const r1 = pick(names, 'RANGED_RE'); const r2 = pick(auto, 'RANGED')
  ok(h1 && h2 && h1 === h2, 'HOSTILE_RE 与 mc_auto 的 HOSTILE 逐字一致（别让两份名单漂移）',
    h1 === h2 ? '' : `core=${String(h1).slice(0, 40)} auto=${String(h2).slice(0, 40)}`)
  ok(r1 && r2 && r1 === r2, 'RANGED_RE 与 mc_auto 的 RANGED 逐字一致',
    r1 === r2 ? '' : `core=${String(r1).slice(0, 40)} auto=${String(r2).slice(0, 40)}`)
  ok(/from '\.\/entity-names\.mjs'/.test(core), 'core.mjs 确实从 entity-names.mjs 导入（别只搬不接）')
}

// ── 收尾 ────────────────────────────────────────────────────────────────────
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\ncheck-core-entities：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
