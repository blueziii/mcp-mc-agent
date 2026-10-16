#!/usr/bin/env node
/**
 * check-mc-pathfinder.mjs —— vendor 里那份 mineflayer-pathfinder 的补丁体检
 *
 * 补的是哪个坑（实机复现于 2026-10-14，用户原话「还是动不了」）：
 *   机器人被 1 格台阶 / 墙角挡住时，`lib/physics.js` 的 `canStraightLine` 会给出**假阳性** ——
 *   直走模拟是从机器人**当前**位置起算的，而机器人被自己的 forward 顶在墙上时，真实位置
 *   已经扎进方块几个百分点；prismarine-physics 在「起点已穿模」的情况下拦不住继续往墙里走，
 *   于是模拟报告「我能直着走到下一个节点」。执行器（`index.js:614`）据此把 jump 关掉，
 *   机器人就直着撞墙角，3.5 秒后 `resetPath('stuck')`，重算同一条路，永远磨在那里。
 *
 * 补丁（三处）：
 *   ① 新增 `collides(pos)` —— 按 `block.shapes` 判玩家 AABB 是否**真正**与实体方块重叠
 *      （碰着不算；用 shapes 而不是 `boundingBox === 'block'`，免得把半砖/台阶误判成墙）。
 *   ② 新增 `simulateStraight()`，并在 `canStraightLine` 里用它 —— 第 0 刻不查（起点本来
 *      就可能贴着墙），从第 1 刻起一旦扎进方块就立刻停下并标 `blocked`；`blocked` 的模拟
 *      不算「能直走」，于是执行器落到 `canSprintJump` / `canWalkJump` 分支，真的跳一下。
 *   ③ `lib/movements.js` 的 `getMoveDiagonal` 里加 `if (cost1 > 0 || cost2 > 0) return` ——
 *      **不许「斜切拐角」**。① ② 只是把「假阳性」修掉，实机验证证明光这样还不够：执行器改成
 *      跳之后，机器人在半空扎进台阶角，落地时 x/z 两个轴的 clip 一起变 0，反而卡死。
 *      真正的病根是 `getMoveDiagonal` 会从 (-3,66,5) 直接给出对角节点 (-2,66,4)，绕过实体方块
 *      (-2,66,5) —— 真人会沿墙滑（x 挡住、z 继续）走出去，**mineflayer 不会**：AABB 一旦扎进
 *      方块 0.01 格，两个轴同时锁死。禁掉斜切后 A* 改走「先北后东」，执行器瞄的是正交节点，
 *      实机朝北 2 秒能走 8.37 格 ⇒ 走得出去。
 *
 * 用法：node tools/check-mc-pathfinder.mjs [vendor 目录]
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── 找 vendor 树（和 check-mc-deps.mjs 同一套候选）──────────────────────────────
function pickVendor () {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'))
  const cands = [
    arg,
    process.env.MCP_MC_AGENT_MC_DEPS,
    resolve(HERE, '../../../vendor/mc-deps'),
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'desktop', 'vendor', 'mc-deps'),
  ].filter((p) => typeof p === 'string' && p && existsSync(p))
  return cands[0] ?? null
}

const VENDOR = pickVendor()
if (!VENDOR) {
  console.log('✗ 找不到 vendor 树 —— 用参数指定：node tools/check-mc-pathfinder.mjs <vendor 目录>')
  process.exit(2)
}
const PF_DIR = join(VENDOR, 'node_modules', 'mineflayer-pathfinder')

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 1. 补丁在不在（源码文本）───────────────────────────────────────────────────
section('1. 补丁在不在')
const physicsSrc = existsSync(join(PF_DIR, 'lib', 'physics.js')) ? readFileSync(join(PF_DIR, 'lib', 'physics.js'), 'utf8') : ''
const indexSrc = existsSync(join(PF_DIR, 'index.js')) ? readFileSync(join(PF_DIR, 'index.js'), 'utf8') : ''
const coreSrc = existsSync(join(HERE, '..', 'src', 'core.mjs')) ? readFileSync(join(HERE, '..', 'src', 'core.mjs'), 'utf8') : ''
// 第二十九刀起 `movements()`（`walkAllowParkour` 的读点）搬进了 src/plugins.mjs；
// 导航 P2（2026-10-15）起那几行权重改由 `src/terrain.mjs` 的地形档案铺上去，
// 配置键登记在 `TERRAIN_CFG_KEYS` —— 所以两处都要看。
const plugSrc = existsSync(join(HERE, '..', 'src', 'plugins.mjs')) ? readFileSync(join(HERE, '..', 'src', 'plugins.mjs'), 'utf8') : ''
const terrainSrc = existsSync(join(HERE, '..', 'src', 'terrain.mjs')) ? readFileSync(join(HERE, '..', 'src', 'terrain.mjs'), 'utf8') : ''

ok(/collides\s*\(pos\)/.test(physicsSrc), 'physics.js 有 collides(pos)（按 shapes 判真正重叠）')
ok(/simulateStraight\s*\(/.test(physicsSrc), 'physics.js 有 simulateStraight()')
ok(/straight\.blocked/.test(physicsSrc), 'canStraightLine 里认 blocked（撞进方块就不算能直走）')
ok(/block\.shapes/.test(physicsSrc), 'collides 用 block.shapes 判（半砖/台阶不会误判成墙）')
ok(/allowSprinting\s*&&\s*physics\.canSprintJump\(path\)/.test(indexSrc), 'index.js 里 canSprintJump → jump=true 的分支还在（返回 false 才会走到这里）')
ok(/profileFor\(terrain\?\.kind/.test(plugSrc), 'movements() 按地形取权重（导航 P2）')
ok(/allowParkour: 'walkAllowParkour'/.test(terrainSrc), 'walkAllowParkour 配置键登记在 terrain.mjs 的 TERRAIN_CFG_KEYS 里（默认关）')
ok(/from '\.\/plugins\.mjs'/.test(coreSrc), 'core.mjs 确实从 plugins.mjs 取装配（搬走 + 忘接 = 这条会红）')

// ── 假世界：一小片地板 + 那个 1 格台阶 + 一块半砖 + 一条 1 格宽走廊 ────────────────
const FULL = [[0, 0, 0, 1, 1, 1]]
const grid = new Map()
const put = (x, y, z, shapes, name = 'grass_block') => grid.set(`${x},${y},${z}`, { name, shapes, boundingBox: 'block' })
for (let x = -6; x <= 3; x++) for (let z = 2; z <= 8; z++) put(x, 65, z, FULL)   // 地板 y=65
put(-2, 66, 5, FULL)                                                             // 那个 1 格台阶（实机卡点）
put(2, 65, 5, [[0, 0, 0, 1, 0.5, 1]], 'stone_slab')                              // 半砖
put(-1, 66, 5, FULL)                                                             // 走廊左墙
put(1, 66, 5, FULL)                                                              // 走廊右墙

const V = (x, y, z) => ({
  x, y, z,
  clone () { return V(this.x, this.y, this.z) },
  minus (o) { return { x: this.x - o.x, y: this.y - o.y, z: this.z - o.z } },
  offset (dx, dy, dz) { return V(this.x + dx, this.y + dy, this.z + dz) },
  floored () { return V(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
})

let step = 0.25
const makeBot = (pos) => ({
  entity: { position: V(pos.x, pos.y, pos.z) },
  controlState: { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false },
  blockAt: (p) => grid.get(`${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`) ?? null,
  physics: {
    // 假模拟器：每刻朝当前控制器瞄的那个点挪 step 格（x/z 各一步）。
    // 真 physics 在「起点已穿模」时就是这样一路挪进墙里的。
    simulatePlayer (state, world) {
      const dx = state._tx - state.pos.x
      const dz = state._tz - state.pos.z
      if (Math.abs(dx) > 1e-6) state.pos.x += Math.sign(dx) * Math.min(step, Math.abs(dx))
      if (Math.abs(dz) > 1e-6) state.pos.z += Math.sign(dz) * Math.min(step, Math.abs(dz))
      state.onGround = true
      state.isInWater = false
      state.isInLava = false
    }
  }
})

const req = createRequire(join(PF_DIR, 'index.js'))
const Physics = req(join(PF_DIR, 'lib', 'physics.js'))

// 给第 5 节用的真 registry（Movements 的构造函数要它；版本随便挑一个能加载的）
let mcData = null
for (const v of ['1.21.9', '1.21.4', '1.21.1', '1.20.4', '1.16.5']) {
  try { mcData = req('minecraft-data')(v); break } catch { /* 换下一个 */ }
}
if (!mcData) {
  console.log('✗ 加载不了 minecraft-data，第 5 节没法跑')
  process.exit(2)
}

// 真 getController 只设 yaw / control，假模拟器需要知道「朝哪个点走」——在实例上补一层，
// 这样 Physics 内部自己造的控制器（canSprintJump / canWalkJump）也会带上目标点。
const makePhys = (bot) => {
  const phys = new Physics(bot)
  phys.newPlayerState = () => ({ pos: bot.entity.position.clone(), control: {}, onGround: true, isInWater: false, isInLava: false })
  const realGetController = phys.getController.bind(phys)
  phys.getController = (target, jump, sprint, jumpAfter = 0) => {
    const ctrl = realGetController(target, jump, sprint, jumpAfter)
    return (state, tick) => { ctrl(state, tick); state._tx = target.x; state._tz = target.z }
  }
  return phys
}

// ── 2. collides() ─────────────────────────────────────────────────────────────
section('2. collides()：贴墙穿模算、正常站着不算')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  ok(phys.collides(V(-2.06, 66, 5.5)) === true, '身体扎进台阶 0.06 格 → 算碰撞（实机假阳性的起点）')
  ok(phys.collides(V(-2.30, 66, 5.5)) === false, '贴着台阶但没穿模（AABB 正好擦到）→ 不算')
  ok(phys.collides(V(-3.00, 66, 5.5)) === false, '台阶左边一格 → 不算')
  ok(phys.collides(V(2.5, 65.5, 5.5)) === false, '站在半砖顶面 → 不算（shapes 判据的用处）')
  ok(phys.collides(V(0.5, 66, 5.5)) === false, '1 格宽走廊正中 → 不算')
  ok(phys.collides(V(0.8, 66, 5.5)) === true, '同一走廊里往右挤到 0.8 → 算（右边是墙）')
}

// ── 3. simulateStraight() 的 blocked 标记 ─────────────────────────────────────
section('3. simulateStraight()：撞进方块就标 blocked')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  const path = [V(-1.5, 66, 4.5)]
  const reached = phys.getReached(path)
  const straight = phys.simulateStraight(reached, phys.getController(path[0], false, true), 200)
  ok(straight.blocked === true, '朝台阶斜着走 → blocked=true')
  ok(reached(straight.state) === false, '撞进方块时模拟就停了，没把这次当成「到了」')
  ok(reached(phys.simulateUntil(reached, phys.getController(path[0], false, true), 200)) === true,
    '同一段路若不管穿模，模拟确实会「到」 —— 这就是假阳性的来源')

  const bot2 = makeBot(V(-4.5, 66, 5.5))
  const phys2 = makePhys(bot2)
  const path2 = [V(-3.0, 66, 5.5)]
  const reached2 = phys2.getReached(path2)
  const clear = phys2.simulateStraight(reached2, phys2.getController(path2[0], false, true), 200)
  ok(clear.blocked === false, '空地上直着走 → blocked=false')
  ok(reached2(clear.state) === true, '空地上直着走 → 到得了')
}

// ── 4. canStraightLine() 不再假阳性 ───────────────────────────────────────────
section('4. canStraightLine()：补丁前误判、补丁后不误判')
{
  const bot = makeBot(V(-2.3, 66, 5.5))
  const phys = makePhys(bot)
  const path = [V(-1.5, 66, 4.5)]
  const reached = phys.getReached(path)

  // 补丁前的老写法：simulateUntil + reached
  const oldWay = reached(phys.simulateUntil(reached, phys.getController(path[0], false, true), 200))
  ok(oldWay === true, '老写法（simulateUntil+reached）在实机卡点上会误判成「能直走」')
  ok(phys.canStraightLine(path, true) === false, '补丁后 canStraightLine 说「不能直走」→ 执行器会跳')

  // 跳一下真的能到（执行器下一步就会走这个分支）
  ok(phys.canSprintJump(path) === true, 'canSprintJump 为真 → index.js:617 分支会 setControlState(jump,true)')

  const bot2 = makeBot(V(-4.5, 66, 5.5))
  const phys2 = makePhys(bot2)
  const path2 = [V(-3.0, 66, 5.5)]
  ok(phys2.canStraightLine(path2, true) === true, '空地上走还是照旧算「能直走」（没把正常走路改坏）')
}

// ── 5. getMoveDiagonal() 不再「斜切拐角」──────────────────────────────────────
section('5. getMoveDiagonal()：斜切拐角被禁（这才是实机真正的病根）')
{
  const Movements = req(join(PF_DIR, 'lib', 'movements.js'))
  const Block = req('prismarine-block')(mcData)
  const Vec3 = req('vec3').Vec3 ?? req('vec3')

  const cells = new Map()
  const key = (x, y, z) => `${x},${y},${z}`
  const fill = (x, y, z, name) => {
    const b = Block.fromStateId(mcData.blocksByName[name].defaultState, 0)
    b.position = new Vec3(x, y, z)
    cells.set(key(x, y, z), b)
  }
  for (let x = -7; x <= 3; x++) for (let y = 64; y <= 68; y++) for (let z = 1; z <= 9; z++) fill(x, y, z, 'air')
  for (let x = -7; x <= 3; x++) for (let z = 1; z <= 9; z++) fill(x, 65, z, 'grass_block')

  const mvBot = {
    registry: mcData,
    username: 'check',
    entity: { position: V(-2.5, 66, 5.5), username: 'check', effects: [] },
    entities: {},
    pathfinder: { bestHarvestTool: () => null },
    blockAt: (p) => cells.get(key(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))) ?? null
  }
  const mv = new Movements(mvBot)
  const node = { x: -3, y: 66, z: 5, remainingBlocks: 0 }
  const NE = { x: 1, z: -1 }

  fill(-2, 66, 5, 'grass_block')                     // 实机那个 1 格台阶（东边）
  const nb1 = []
  mv.getMoveDiagonal(node, NE, nb1)
  ok(nb1.length === 0, '台阶角上：往东北的斜切被禁掉（老版本会给出一个对角节点）')
  const nbF = []
  mv.getMoveForward(node, { x: 0, z: -1 }, nbF)
  ok(nbF.length === 1, '同一位置往北的正交走法还在 → A* 会改走「先北后东」（实机朝北 2 秒走 8.37 格）')

  fill(-2, 66, 5, 'air')                             // 把台阶换成空气（真世界里 blockAt 也不会返回 null）
  const nb2 = []
  mv.getMoveDiagonal(node, NE, nb2)
  ok(nb2.length === 1, '拐角空着时斜着走照旧允许（没把正常的斜走改坏）')
}

console.log(`\n${fail === 0 ? '✓ 全部通过' : '✗ 有失败项'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
