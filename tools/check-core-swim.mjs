#!/usr/bin/env node
/**
 * check-core-swim.mjs —— "别淹死"的回归检查（上浮换气 + 别去挖水）
 *
 * 背景（用户 2026-10-07 原话：「现在容易被淹死」）：
 *   ① **缺氧不掉血，掉到 0 才开始掉血** —— 所以"掉血但 22 格内看不到怪"很可能根本不是被远程怪
 *      隔着墙射，而是**在水里憋气**。旧版 `mc_status` 只报 `inWater`、不报氧气，AI 看不出自己
 *      快淹死了；`mc_auto` 的文案还把它说成"多半是远程/隔墙"，AI 于是跑去找一个不存在的敌人。
 *   ② **水/岩浆是流体，挖不掉** —— 日志里出现过 `破坏 water 这一轮的时间用完了`：AI 想"挖开水"，
 *      白花一次调用，人还在水里继续沉。
 *   ③ 出水要能**真的做到**：`mc_move {mode:"jump"}` 只按 320ms（爬台阶用），在水里不够；
 *      所以补 `swimUp()`（按住 jump 游泳，一次最多 3 秒，到点如实报 remaining/hint）。
 *
 * 用法：node tools/check-core-swim.mjs
 *   ⚠️ **必须从包目录跑**（`<profile>/node_modules/mcp-mc-agent`）：`src/core.mjs` 顶部
 *      `import ... from 'mineflayer'`，源码树里没有 node_modules，会 ERR_MODULE_NOT_FOUND。
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
  const dir = mkdtempSync(join(tmpdir(), 'wc-swim-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = bot
  mc.mcPlugins = {}
  mc.pfReady = false
  return mc
}

/**
 * 假 bot：只带 `swimUp()` / `dig()` 会碰到的字段。
 * @param {object} o
 *   - `inWater` 一开始在不在水里
 *   - `air`     氧气（0–20；`null` = 这个版本读不到）
 *   - `y`       起始 y
 *   - `after`   `{ms, inWater, air, y}`：到点后改状态（模拟"游上来了/换到气了"）
 */
const mkBot = ({ inWater = true, air = 8, y = 60, after = null } = {}) => {
  const calls = { control: [], jump: 0 }
  const bot = {
    entity: { position: new Vec3(0, y, 0), isInWater: inWater, yaw: 0, pitch: 0 },
    _client: {},
    game: { gameMode: 'survival' },
    registry: { itemsByName: {}, blocksByName: {}, items: {} },
    inventory: { items: () => [] },
    heldItem: null,
    blockAt: () => null,
    findBlocks: () => [],
    findBlock: () => null,
    setControlState: (k, v) => { calls.control.push([k, v]); if (k === 'jump' && v) calls.jump++ },
    on: () => bot,
    removeListener: () => {},
  }
  Object.defineProperty(bot, 'oxygenLevel', { get: () => bot.__air, set: (v) => { bot.__air = v } })
  bot.__air = air
  if (after) {
    setTimeout(() => {
      if (after.inWater !== undefined) bot.entity.isInWater = after.inWater
      if (after.air !== undefined) bot.__air = after.air
      if (after.y !== undefined) bot.entity.position = new Vec3(0, after.y, 0)
    }, after.ms)
  }
  return { bot, calls }
}

const jumpOn = (calls) => calls.control.some(([k, v]) => k === 'jump' && v === true)
const jumpOff = (calls) => calls.control.some(([k, v]) => k === 'jump' && v === false)

/* ─────────── ① 不在水里：立刻返回，别乱按 jump ─────────── */
section('① 不在水里 —— 立刻返回、不按 jump')
{
  const { bot, calls } = mkBot({ inWater: false, air: 20 })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === false, '如实报"不在水里"', JSON.stringify({ inWater: r.inWater, note: r.note }))
  ok(/没在水里/.test(String(r.note ?? '')), 'note 说明这是给"在水里憋气"用的')
  ok(calls.control.length === 0, '一个控制位都没碰', `control=${calls.control.length}`)
  ok(ms < 300, '立刻返回（不白等 3 秒）', `${ms}ms`)
}

/* ─────────── ② 在水里游上来：报 rose、松开 jump ─────────── */
section('② 在水里上浮 —— 出水后立刻停、如实报 rose')
{
  const { bot, calls } = mkBot({ inWater: true, air: 6, y: 60, after: { ms: 260, inWater: false, air: 20, y: 61.2 } })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === false, '报"已经出水"', JSON.stringify({ inWater: r.inWater, rose: r.rose, air: r.air }))
  ok(r.rose >= 1 && r.rose <= 1.5, 'rose 报出涨了几格', String(r.rose))
  ok(r.air === 20, '报出出水后的氧气', String(r.air))
  ok(/已经出水/.test(String(r.note ?? '')), 'note = 已经出水了')
  ok(r.remaining === undefined, '出水了就不给 remaining（不用再叫一次）')
  ok(jumpOn(calls) && jumpOff(calls), 'jump 按下又松开（不会一直举着）')
  ok(ms < 1200, '出水就停，不等满 3 秒', `${ms}ms`)
}

/* ─────────── ③ 一直泡着：到点如实返回 remaining + hint ─────────── */
section('③ 一直泡在水里 —— 到点返回 remaining/hint（让 AI 再叫一次）')
{
  const { bot, calls } = mkBot({ inWater: true, air: 3, y: 60 })
  const mc = mkMc(bot)
  const t0 = Date.now()
  const r = await mc.swimUp()
  const ms = Date.now() - t0
  ok(r.inWater === true, '还在水里就如实报 inWater:true')
  ok(r.remaining === 1, 'remaining:1', String(r.remaining))
  ok(/再叫一次 mc_move/.test(String(r.hint ?? '')), 'hint 教它再叫一次同一个工具')
  ok(/水挖不掉/.test(String(r.hint ?? '')), 'hint 里点明"水挖不掉"（别去 mc_dig 水）')
  ok(r.heldMs >= 2900 && r.heldMs <= 3400, '按满默认的 3 秒', `${r.heldMs}ms`)
  ok(ms >= 2900 && ms <= 3600, '墙钟也在 3 秒量级', `${ms}ms`)
  ok(jumpOff(calls), 'finally 里松开 jump（超时也要松）')
}

/* ─────────── ④ 头露出水面、气在恢复 → 提前跳出 ─────────── */
section('④ 头露出水面、氧气回升 —— 提前跳出（不白按满 3 秒）')
{
  const { bot } = mkBot({ inWater: true, air: 5, y: 60, after: { ms: 150, air: 20, y: 61 } })
  const mc = mkMc(bot)
  const r = await mc.swimUp()
  ok(r.heldMs >= 500 && r.heldMs <= 1500, '在 0.5~1.5 秒内就跳出', `${r.heldMs}ms`)
  ok(r.rose >= 0.9, 'rose 报出涨了约 1 格', String(r.rose))
}

/* ─────────── ⑤ 预算钳制：hold 上限 3 秒、本轮时间不够就少按 ─────────── */
section('⑤ 预算钳制 —— hold 上限 3 秒；这一轮时间不够就少按（下次再叫）')
{
  const a = mkBot({ inWater: true, air: 3 })
  const mcA = mkMc(a.bot)
  const rA = await mcA.swimUp({ hold: 99_999 })
  ok(rA.heldMs <= 3400, 'hold:99999 也只按 3 秒（上限）', `${rA.heldMs}ms`)

  const b = mkBot({ inWater: true, air: 3 })
  const mcB = mkMc(b.bot)
  mcB.setCallDeadline(800)
  const rB = await mcB.swimUp()
  ok(rB.heldMs <= 700, '这一轮只剩 800ms → 只按 ~500ms（留 300ms 余量）', `${rB.heldMs}ms`)
  ok(rB.remaining === 1, '少按了也如实报 remaining:1')
}

/* ─────────── ⑥ dig 拒绝流体（水/岩浆挖不掉） ─────────── */
section('⑥ mc_dig 水/岩浆 —— 直接拒绝，并告诉它怎么出水')
{
  const { bot } = mkBot({ inWater: true, air: 4 })
  const mc = mkMc(bot)
  let err = null
  try { await mc.dig({ name: 'water', count: 1 }) } catch (e) { err = e }
  ok(Boolean(err), 'dig water 抛错（不白跑一趟）')
  ok(/流体，挖不掉/.test(String(err?.message ?? '')), '错误里写清"流体，挖不掉"')
  ok(/mode":"swim"/.test(String(err?.message ?? '')), '错误里给出 mc_move {"mode":"swim"}')

  let err2 = null
  try { await mc.dig({ name: 'lava', count: 1 }) } catch (e) { err2 = e }
  ok(/流体，挖不掉/.test(String(err2?.message ?? '')), 'lava 同样拒绝')

  // 别的方块不能被误伤（stone 找不到时是"附近找不到"，不是流体错误）
  let err3 = null
  let out3 = null
  try { out3 = await mc.dig({ name: 'stone', count: 1 }) } catch (e) { err3 = e }
  ok(!err3, 'dig stone 不抛错（没误伤正常采集）')
  ok(Array.isArray(out3) && out3.some((s) => /附近找不到 stone/.test(s)), 'stone 走正常流程', JSON.stringify(out3))
}

/* ─────────── ⑦ 在水里走路：绕开 pathfinder，直接 forward+jump 游 ─────────── */
section('⑦ 在水里走路 —— 绕开 pathfinder 直接游（实机 2.05~2.27 格/秒；A* 不把水当节点）')
{
  const TIMERS = []
  /**
   * 假 bot：带"游动模拟" —— 按住 forward 时按 2 格/秒朝**当前朝向**（lookAt 的目标）前进。
   * 这样测的是真逻辑（每 250ms 重新对准 + forward + jump），而不是我手写的假位移。
   */
  const mkWalker = ({ inWater = true, onGround = false, pos = [0, 60, 0], pathfinder = true, landAfter = null, gotoArrives = false } = {}) => {
    const calls = { control: [], lookAt: 0, goto: 0, stop: 0, setMovements: 0 }
    const bot = {
      entity: { position: new Vec3(pos[0], pos[1], pos[2]), isInWater: inWater, onGround, yaw: 0, pitch: 0, eyeHeight: 1.62 },
      game: { gameMode: 'survival' },
      registry: { itemsByName: {}, blocksByName: {}, items: {} },
      inventory: { items: () => [] },
      heldItem: null,
      blockAt: () => null,
      findBlocks: () => [],
      setControlState: (k, v) => calls.control.push([k, v]),
      lookAt: async (p) => { calls.lookAt++; bot.__aim = { x: p.x, y: p.y, z: p.z } },
      on: () => bot,
      removeListener: () => {},
      __aim: null,
    }
    if (pathfinder) {
      bot.pathfinder = {
        goto: async (goal) => { calls.goto++; if (gotoArrives && goal) bot.entity.position = new Vec3(goal.x, goal.y, goal.z) },
        stop: () => { calls.stop++ },
        setMovements: () => { calls.setMovements++ },
      }
    }
    const start = bot.entity.position.clone()
    const held = (k) => calls.control.some(([kk, vv]) => kk === k && vv === true && !calls.control.some(([k2, v2]) => k2 === k && v2 === false && calls.control.indexOf([k2, v2]) > calls.control.indexOf([kk, vv])))
    const forwardHeld = () => {
      let on = false
      for (const [k, v] of calls.control) if (k === 'forward') on = v
      return on
    }
    TIMERS.push(setInterval(() => {
      if (!forwardHeld()) return
      const aim = bot.__aim
      if (!aim) return
      const p = bot.entity.position
      const dx = aim.x - p.x, dz = aim.z - p.z
      const d = Math.hypot(dx, dz)
      if (d < 0.05) return
      const step = Math.min(0.2, d)                     // 0.2 格 / 100ms = 2 格/秒
      bot.entity.position = new Vec3(p.x + (dx / d) * step, p.y, p.z + (dz / d) * step)
      // 游出 landAfter 格就算上岸（模拟"到了岸边、脚下是地"）
      if (landAfter != null && start.distanceTo(bot.entity.position) >= landAfter) {
        bot.entity.isInWater = false; bot.entity.onGround = true
      }
    }, 100))
    return { bot, calls }
  }
  const heldAt = (calls, key) => {
    let on = false
    for (const [k, v] of calls.control) if (k === key) on = v
    return on
  }

  // ① 水里游到 4 格外的目标：不走 pathfinder、forward+jump、到点松手
  {
    const { bot, calls } = mkWalker({ inWater: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const t0 = Date.now()
    const r = await mc.walkTo({ x: 0, y: 60, z: 4 }, { arrive: 1.6, budget: 4000 })
    const ms = Date.now() - t0
    ok(r.arrived === true, '游到了（arrived:true）', JSON.stringify({ arrived: r.arrived, moved: r.moved, ms: r.ms }))
    ok(r.via === 'swim', 'via=swim（走的是直接游那条）', String(r.via))
    ok(calls.goto === 0, '**一次都没调 pathfinder.goto**（A* 在水里没用）', `goto=${calls.goto}`)
    ok(calls.lookAt >= 2, '反复重新对准（水流/撞岸会把朝向推偏）', `lookAt=${calls.lookAt}`)
    ok(calls.control.some(([k, v]) => k === 'forward' && v === true) && calls.control.some(([k, v]) => k === 'jump' && v === true),
      '按住 forward + jump（jump 是浮在水面，不是跳）')
    ok(!heldAt(calls, 'forward') && !heldAt(calls, 'jump'), '结束时松开 forward/jump（不留按键卡住）')
    ok(ms < 3000, '4 格的水里路 ~1.2 秒游完（2 格/秒）', `${ms}ms`)
  }

  // ② 连 pathfinder 都没有也照样能游（水里的移动不依赖它）
  {
    const { bot, calls } = mkWalker({ inWater: true, pathfinder: false })
    const mc = mkMc(bot)
    mc.pfReady = false
    const r = await mc.walkTo({ x: 0, y: 60, z: 3 }, { arrive: 1.6, budget: 4000 })
    ok(r.arrived === true && r.via === 'swim', '没挂 pathfinder 也能游到（不再报 pathfinder-unavailable）', JSON.stringify({ via: r.via, arrived: r.arrived }))
    ok(calls.control.length > 0, '确实按了控制位', `control=${calls.control.length}`)
  }

  // ③ 游到岸边 → 交给 pathfinder 走完剩下的
  {
    const { bot, calls } = mkWalker({ inWater: true, landAfter: 3, gotoArrives: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const r = await mc.walkTo({ x: 0, y: 60, z: 30 }, { arrive: 1.6, budget: 6000 })
    ok(r.swam === true, '如实标注"先游了一段"（swam:true）', JSON.stringify({ swam: r.swam, swimMoved: r.swimMoved }))
    ok(r.swimMoved > 0, '报出游了多少格（swimMoved）', String(r.swimMoved))
    ok(calls.goto === 1, '上岸后交回 pathfinder（goto 调了 1 次）', `goto=${calls.goto}`)
    ok(r.via === 'pathfinder' && r.arrived === true, '最终按 pathfinder 的结果返回', JSON.stringify({ via: r.via, arrived: r.arrived }))
  }

  // ④ 这一轮时间不够：如实报"还在水里" + 再叫一次
  {
    const { bot, calls } = mkWalker({ inWater: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class {} }, Movements: class { constructor() {} } }
    mc.setCallDeadline(800)
    const t0 = Date.now()
    const r = await mc.walkTo({ x: 0, y: 60, z: 60 }, { arrive: 1.6, budget: 10_000 })
    const ms = Date.now() - t0
    ok(ms < 1500, '到点就返回（不硬耗到 10 秒）', `${ms}ms`)
    ok(r.arrived === false && r.reason === 'swim-budget', 'reason=swim-budget', String(r.reason))
    ok(r.stuck === true && r.remaining > 0, '如实报 stuck + remaining', JSON.stringify({ stuck: r.stuck, remaining: r.remaining }))
    ok(/再叫一次 mc_move/.test(String(r.hint ?? '')), 'hint 教它"再叫一次 mc_move 接着游"')
    ok(!heldAt(calls, 'forward') && !heldAt(calls, 'jump'), '超时也松开控制位')
  }

  // ⑤ 不在水里：直接走 pathfinder，别乱按 forward
  {
    const { bot, calls } = mkWalker({ inWater: false, gotoArrives: true })
    const mc = mkMc(bot)
    mc.pfReady = true
    mc._pf = { goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } }, Movements: class { constructor() {} } }
    const r = await mc.walkTo({ x: 0, y: 60, z: 3 }, { arrive: 1.6, budget: 4000 })
    ok(r.swam === undefined && r.via === 'pathfinder', '陆地上还是走 pathfinder（没被游泳逻辑抢走）', String(r.via))
    ok(calls.lookAt === 0 && !calls.control.some(([, v]) => v === true), '陆地上一格控制位都没按下去（只可能松开）', `lookAt=${calls.lookAt} control=${calls.control.length}`)
  }

  for (const t of TIMERS) clearInterval(t)
}

/* ─────────── ⑧ 静态接线（防止以后被改回去） ─────────── */
section('⑧ 静态接线：core / index 都在')
{
  const src = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const core = strip(src)
  const index = strip(idx)
  const autoSrc = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))

  /* 🔴 第三十五刀：`jump` / `swimUp` 整段搬进 `src\movement.mjs`（那边去掉 2 格缩进、`this.` → `self.`、
   *    `#beginMove()` → `ctx.bumpGen()`）⇒ 这一组判据改查新模块，core 那边只留"薄包装 + 确实导入了"。 */
  const movSrc = strip(readFileSync(new URL('../src/movement.mjs', import.meta.url), 'utf8'))
  ok(/export async function swimUp \(self, \{ hold = 3_000 \} = \{\}, ctx = \{\}\)/.test(movSrc), 'movement.mjs 有 swimUp(self, {hold=3000}, ctx)')
  ok(/b\.setControlState\('jump', true\)/.test(movSrc), 'swimUp 里按住 jump')
  /* 🔴 2026-10-08 第十刀：`#inWaterNow` 搬进 `src/world-observer.mjs`（改名 `inWaterNow`）
   *    ⇒ 调用点变成 `inWaterNow(b)`，判据要跟着改，并确认 movement.mjs 真的导入了。 */
  ok(/if \(!inWaterNow\(b\)\) break/.test(movSrc), '出水就 break（走 inWaterNow）')
  ok(/if \(!inWaterNow\(b\)\) \{\r?\n    return \{ inWater: false/.test(movSrc),
    'swimUp 开头就用 inWaterNow 判断"我在不在水里"（以前只看 isInWater ⇒ 泡水柱里回"我本来就没在水里"）')
  ok(/from '\.\/world-observer\.mjs'/.test(movSrc), 'movement.mjs：观察层从 world-observer.mjs 导入')
  ok(/export function inWaterNow \(b\)/.test(strip(readFileSync(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))),
    'world-observer：inWaterNow 在新模块里（第十刀搬过去的）')
  ok(!/if \(!e\?\.isInWater\) \{\r?\n      return \{ inWater: false/.test(movSrc), 'swimUp 不再只看 entity.isInWater')
  ok(/const submerged = submergedIn\(b, e\)[\s\S]{0,200}const inWater = submerged \|\| Boolean\(e\?\.isInWater\)/.test(autoSrc),
    'mc_auto 的憋气判据以"头在水下"为主（以前 isInWater 读不到就整条分支不执行）')
  ok(/submergedIn = \(b, e\) => \{\r?\n  try \{\r?\n    if \(!e\?\.position\) return false/.test(autoSrc),
    'mc_auto 的 submergedIn 不再要求 e.isInWater')
  ok(/rose >= 0\.4 && a != null && a >= 20/.test(movSrc), '头露出水面 + 氧气回升也 break')
  ok(/self\.callLeft\(\)[\s\S]{0,700}left - 300/.test(movSrc), 'swimUp 给这一轮留 300ms 余量')
  /* 🔴 2026-10-08 第四份审计报告 ①④⑧：swimUp 以前不认中断、预算归零白送 200ms、`hold:0` 被当 3000。 */
  ok(/if \(self\.abortSignal\?\.aborted\) throw abortError\('上浮'/.test(movSrc), 'swimUp 认中断')
  ok(/raceAbort\(sleep\(100\), self\.abortSignal, '上浮'\)/.test(movSrc), 'swimUp 的 sleep 可中断')
  ok(/const gen = bumpGen\(\)/.test(movSrc) && /if \(self\._moveGen !== gen\) \{ preempted = true; break \}/.test(movSrc),
    'swimUp 领 _moveGen 号、被接管就让位')
  ok(/if \(self\._moveGen === gen\) \{ try \{ b\.setControlState\('jump', false\) \}/.test(movSrc), 'swimUp 只在还是自己时松 jump')
  ok(!/Math\.max\(200, Math\.min\(Number\(hold\)/.test(movSrc), '预算归零时不再白送 200ms')
  ok(/Number\.isFinite\(Number\(hold\)\) \? Number\(hold\) : 3_000/.test(movSrc), 'hold:0 不再被当成 3000')
  /* 第三十五刀接线：core 那边只剩薄包装，私有 `#beginMove` 靠 `ctx.bumpGen` 递进去（迁移规矩第 28 条）。 */
  ok(/from '\.\/movement\.mjs'/.test(core), 'core：movement 从 movement.mjs 导入')
  ok(/async jump \(\) \{ return await jumpImpl\(this, \{ bumpGen: \(\) => this\.#beginMove\(\) \}\) \}/.test(core), 'core 的 jump 是薄包装')
  ok(/async swimUp \(opts = \{\}\) \{ return await swimUpImpl\(this, opts, \{ bumpGen: \(\) => this\.#beginMove\(\) \}\) \}/.test(core), 'core 的 swimUp 是薄包装')
  /* 🔴 第二十二刀：步骤分发（`#runStep`）搬进 `src\sequence.mjs` ⇒ 改成查新模块（那边是 `self.`）。 */
  const seqSrc = strip(readFileSync(new URL('../src/sequence.mjs', import.meta.url), 'utf8'))
  ok(/case 'swim':    return \(s\.x != null && s\.y != null && s\.z != null\) \? self\.walkTo\(s\) : self\.swimUp\(s\)/.test(seqSrc),
    'sequence.mjs 的 op 里有 swim（给坐标=游过去，不给=上浮）')
  // 🔴 水里不能用 pathfinder（它的 A* 明确拒绝水节点，见 #walkSwim 的注释）
  // 路线图第 ④ 条第三十六刀：`walkTo` / `#walkSwim` 的函数体已搬进 `src\movement.mjs`（core 只剩薄包装）。
  ok(/export async function walkSwim \(self, target, \{ arrive = 1\.6, budget = self\.cfg\.moveBudgetMs \} = \{\}, ctx = \{\}\)/.test(movSrc), 'movement.mjs 有 walkSwim（直接游）')
  ok(/if \(inWaterNow\(b\)\) \{\r?\n    const swim = await walkSwim\(self, target, \{ arrive, budget \}, ctx\)/.test(movSrc), 'walkTo 在水里先走 walkSwim（判据同 inWaterNow）')
  ok(/return \{ \.\.\.rest, swam: true, swimMoved: swim\.moved, swimMs: swim\.ms \}/.test(movSrc), '上岸后交回 pathfinder（并标注 swam/swimMoved）')
  ok(/via: 'swim'/.test(movSrc), 'walkSwim 返回 via:swim')
  ok(/b\.setControlState\('forward', true\)\r?\n      b\.setControlState\('jump', true\)/.test(movSrc), 'walkSwim 按住 forward + jump（jump = 浮在水面）')
  ok(/reason: outOfWater \? 'swim-shore' : 'swim-budget'/.test(movSrc), '如实区分"上岸了"与"这一轮用完了"')
  ok(/from '\.\/movement\.mjs'/.test(core), 'core 确实从 movement.mjs 导入（搬走 + 忘接 = 假绿）')
  /* 路线图第 ④ 条第四十刀：`dig()` 已搬进 `src\mining.mjs`。 */
  const mineSrc = strip(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  ok(/const fluid = name \?\?/.test(mineSrc) && /if \(fluid && isLiquid\(fluid\)\)/.test(mineSrc)
    && /from '\.\/mining\.mjs'/.test(core), 'dig() 先拒流体（实现已搬到 src\\mining.mjs）')
  /* 路线图第 ④ 条第十三刀：`status()` 已搬进 `src/status.mjs` —— 下面五条改查那个文件。 */
  const stSrc = strip(readFileSync(new URL('../src/status.mjs', import.meta.url), 'utf8'))
  ok(/air: Number\.isFinite\(b\.oxygenLevel\) \? b\.oxygenLevel : null/.test(stSrc), 'status() 报氧气 air（实现已搬到 src\\status.mjs）')
  // 🔴 实机（2026-10-07）：`bot.oxygenLevel` 只在头入水后才有读数（水面上是 null）⇒ 判据要有"头在水下"
  ok(/submerged: \(\(\) => \{/.test(stSrc), 'status() 报"头在水下"submerged（氧气读不到时的可靠判据）')
  ok(/b\.entity\.position\.offset\(0, b\.entity\.eyeHeight \?\? 1\.62, 0\)/.test(stSrc), 'submerged 用眼睛那一格算')
  ok(/return isLiquid\(b\.blockAt\(eye\)\?\.name\)/.test(stSrc), 'submerged = 眼睛那格是液体')
  ok(!/if \(!b\.entity\.isInWater\) return false/.test(stSrc), 'status().submerged 不再先要求 entity.isInWater（泡水柱时它会漏报）')

  ok(/mode === 'swim'/.test(index), 'index.js 的 mc_move 认 swim')
  ok(/sess\.bot\.swimUp\(\{ hold: args\.budgetMs \}\)/.test(index), 'swim 不给坐标时把 budgetMs 当上浮时间')
  /* 2026-10-15：walkTo 的返回值现在过 `withOutcome(..., { expect: 'moved' })`（结果台账要判得动）。 */
  ok(/sess\.bot\.walkTo\(\{ x: Number\(args\.x\), y: Number\(args\.y\), z: Number\(args\.z\) \}, \{ budget: callBudget\(args\.budgetMs\) \}\)/.test(index),
    'swim 给了坐标就游过去（walkTo 会自动走"直接游"）')
  ok(/在水里会自动改成"直接游"/.test(index), 'mc_move 描述里写明"在水里自动直接游"')
  ok(/在水里（氧气/.test(index), 'mc_status 瘦身视图里带氧气')
  ok(/头在水下/.test(index), 'mc_status 读不到氧气时也说清"头在水下"')
  ok(/mode="swim"/.test(index), 'mc_move 描述里写了 swim')
  ok(/walk \/ fly \/ jump \/ swim/.test(index), 'mode 说明里有 swim')

  const auto = strip(readFileSync(new URL('../extensions/mc_auto.mjs', import.meta.url), 'utf8'))
  ok(/const DROWN_WAKE_GAP_MS = 6_000/.test(auto), 'mc_auto 有憋气叫醒间隔')
  // 氧气只当"加速器"：必须 `submerged`（头真在水下）或"读数正在往下掉"（真的在憋气）才算 ——
  // 读数可能是旧的（潜过水后站在浅水里还是 0/-1，实机 2026-10-07 误报过两次）
  ok(/const byAir = air != null && \(submerged \|\| draining\) && \(air <= DROWN_AIR/.test(auto),
    'mc_auto 有氧气的判据（读得到才用，而且必须头在水下或读数在掉）')
  ok(/const draining = air != null && s\.lastAir != null && air < s\.lastAir/.test(auto),
    'mc_auto 会拿上一次读数比（判断气是不是真的在掉）')
  ok(/const submergedIn = \(b, e\) =>/.test(auto), 'mc_auto 有"头在水下"判据')
  ok(/const DROWN_SUBMERGE_MS = 10_000/.test(auto), '头在水下 10 秒出声')
  ok(/drown: true, air, submerged, subSec/.test(auto), '叫醒时带上 drown/air/submerged/subSec')
  ok(/这不是被打/.test(auto) && /多半不是被打/.test(auto), '文案写清"不是被打"（读不到氧气时是"多半"）')
  ok(/水\/岩浆是\*\*流体，挖不掉\*\*/.test(auto), '文案里点明水挖不掉')
}

/* ─────────── 收尾 ─────────── */
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
