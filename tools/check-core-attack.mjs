#!/usr/bin/env node
/**
 * check-core-attack.mjs —— 「打怪 / 采集挑目标 / 真重连」的回归检查
 *
 * 背景（用户 2026-10-08 转来游戏里 AI 的四条实机反馈）：
 *   ① `mc_act {mode:"attack", who:"zombie"}` 报 `附近找不到 "zombie"`，不给 who 才打得着；
 *   ② `mc_dig` 挑到够不着的目标就把整轮 11 秒吃光（只能自己改用 mc_sequence 连着 break）；
 *   ③ 挖着挖着报"那里本来就是空气"，重连也清不掉 —— 因为**已连着时 mc_connect 是空操作**。
 *   ④ 顺手抓到的：不给 who 时会先打到脚边的掉落物（AI 自己都发现了）。
 *
 * 这个脚本把修好的行为钉死：
 *   A. who 匹配看所有名字字段（username/name/displayName/type/kind）+ 中文别名；
 *      找不到时**列出半径内实际有谁**（别只丢一句"附近找不到"）。
 *   B. 不给 who：敌对 > 玩家 > 动物 > 掉落物；**只追怪**（动物/玩家仍限 4.5 格内，
 *      否则会跑 6 格去揍玩家拴着的马）。
 *   C. dig：目标按距离升序；单个目标最多吃掉"剩余时间的一大半"；寻路 thinkTimeout 临时压低并还原。
 *   D. connect({force:true}) 才真重连（先 quit 旧连接 → 再 createBot）；不带 force 且已连着 = 空操作。
 *
 * 用法：node tools/check-core-attack.mjs
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { EventEmitter } from 'node:events'

// ── 断言小工具（和别的 check-*.mjs 一致）────────────────────────────────────────
let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

// ── 借依赖 ────────────────────────────────────────────────────────────────────
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(DSH_HOME, 'profiles', 'desktop')
const req = (() => {
  const bases = [
    new URL('../index.js', import.meta.url).href,
    join(PROFILE, 'node_modules', 'mcp-mc-agent', 'index.js'),
    join(PROFILE, 'index.js'),
  ]
  for (const base of bases) {
    try { const r = createRequire(base); r('mineflayer'); return r } catch {}
  }
  return null
})()
if (!req) {
  console.log('✗ 拿不到 mineflayer —— 请从包目录（<profile>/node_modules/mcp-mc-agent）跑。')
  process.exit(2)
}
const Vec3 = req('vec3')
const mineflayer = (await import('mineflayer')).default
const { McBot } = await import(new URL('../src/core.mjs', import.meta.url))

const TMP_DIRS = []
const mkMc = (fake) => {
  const dir = mkdtempSync(join(tmpdir(), 'wc-coreatk-'))
  TMP_DIRS.push(dir)
  const mc = new McBot({ logFile: join(dir, 'check.log') })
  mc.bot = fake.bot
  mc.mcPlugins = fake.plugins ?? {}
  mc.pfReady = true
  mc._pf = {
    goals: { GoalNear: class { constructor(x, y, z, r) { Object.assign(this, { x, y, z, r }) } } },
    Movements: class { constructor() {} },
  }
  mc.cfg.collectBudgetMs = 300
  return mc
}

/** 造一个实体（只要 attack 会读到的字段）—— `pos:{x,y,z}` 或直接 x/y/z 都行 */
const ent = (o) => {
  const { pos, x, y, z, ...rest } = o
  const p = pos ?? { x: x ?? 0, y: y ?? 64, z: z ?? 0 }
  return { position: new Vec3(p.x, p.y, p.z), ...rest }
}

/** 造一个"能被打"的假 bot：pvp 插件记录打了谁 */
const mkFightBot = (entities, { withPvp = true, me = [0, 64, 0] } = {}) => {
  const calls = { attack: [], stop: 0 }
  const bot = {
    entity: { position: new Vec3(me[0], me[1], me[2]) },
    _client: {},
    entities: Object.fromEntries(entities.map((e, i) => [e.id ?? `e${i}`, e])),
    game: { gameMode: 'survival' },
    inventory: { items: () => [] },
    setControlState: () => {},
    on: () => bot,
  }
  bot.entity.id = 'me'
  if (withPvp) {
    bot.pvp = {
      attack: (t) => { calls.attack.push(t); return Promise.resolve() },
      stop: () => { calls.stop++ },
    }
  }
  return { bot, calls, plugins: withPvp ? { pvp: true } : {} }
}

/* ─────────── ① who 匹配：所有名字字段 + 中文别名 ─────────── */
section('① who 匹配 —— 英文名 / 大小写 / displayName / 中文别名 / 玩家的 username')
{
  const mob = (o) => ent({ id: o.id, name: o.name, displayName: o.displayName, type: o.type ?? 'hostile', kind: o.kind ?? 'Hostile mobs', ...o.pos })
  const zombie = mob({ id: 'z1', name: 'zombie', displayName: 'Zombie', pos: { x: 0, y: 64, z: 8 } })
  const skel = mob({ id: 's1', name: 'skeleton', displayName: 'Skeleton', pos: { x: 0, y: 64, z: 10 } })
  const player = ent({ id: 'p1', name: 'player', username: 'Bluezi', displayName: 'Bluezi', type: 'player', kind: 'Other', pos: { x: 2, y: 64, z: 0 } })

  for (const [who, want] of [['zombie', 'z1'], ['ZOMBIE', 'z1'], ['僵尸', 'z1'], ['Zombie', 'z1']]) {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    const r = await mc.attack({ who, budget: 200 })
    ok(f.calls.attack[0]?.id === want && r.attacked === 'zombie', `who:${JSON.stringify(who)} 打到 ${want}`, `attacked=${r.attacked}`)
  }
  {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    const r = await mc.attack({ who: 'Bluezi', budget: 200 })
    ok(f.calls.attack[0]?.id === 'p1' && r.attacked === 'Bluezi',
      '玩家按 username 匹配、且如实报玩家名（不是注册表里的 "player"）', `attacked=${r.attacked}`)
  }
  {
    const f = mkFightBot([zombie, skel, player])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ who: 'enderman', budget: 200 }) } catch (e) { err = e }
    const msg = String(err?.message ?? '')
    ok(/附近找不到 "enderman"/.test(msg), '找不到时如实说找不到', msg.slice(0, 60))
    ok(/24 格内实际有/.test(msg), '把半径内实际有谁列出来（模型能自己改名重试）', msg.slice(0, 160))
    ok(/zombie/.test(msg) && /Bluezi/.test(msg), '列表里有怪也有玩家（玩家显示 username）', msg.slice(0, 160))
    ok(f.calls.attack.length === 0, '找不到就不动手')
  }
}

/* ─────────── ② 不给 who：怪优先，且只追怪 ─────────── */
section('② 不给 who —— 敌对 > 玩家 > 动物 > 掉落物；只追怪（不追 6 格外的马）')
{
  const item = ent({ id: 'i1', name: 'item', type: 'object', kind: 'Other', pos: { x: 0, y: 64, z: 1 } })
  const cow = ent({ id: 'c1', name: 'cow', type: 'animal', kind: 'Passive mobs', pos: { x: 0, y: 64, z: 2 } })
  const horse = ent({ id: 'h1', name: 'horse', type: 'animal', kind: 'Passive mobs', pos: { x: 0, y: 64, z: 6.8 } })
  const zombie = ent({ id: 'z1', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 3 } })
  const farZombie = ent({ id: 'z2', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 20 } })
  const player = ent({ id: 'p1', name: 'player', username: 'Bluezi', type: 'player', kind: 'Other', pos: { x: 0, y: 64, z: 12 } })

  {   // 掉落物最近，但旁边有怪 ⇒ 打怪
    const f = mkFightBot([item, zombie, cow])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z1', '掉落物在脚边也不先打它（怪优先）', `attacked=${r.attacked}`)
  }
  {   // 只有掉落物 + 动物 ⇒ 打动物
    const f = mkFightBot([item, cow])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'c1', '没有怪时打动物（不是掉落物）', `attacked=${r.attacked}`)
  }
  {   // 只有 6.8 格外的马 ⇒ 不许跑过去揍它
    const f = mkFightBot([horse])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ budget: 200 }) } catch (e) { err = e }
    const msg = String(err?.message ?? '')
    ok(f.calls.attack.length === 0, '不会跑 6 格去揍玩家拴着的马（动物只在 4.5 格内）', msg.slice(0, 80))
    ok(/4\.5 格内没有能打的实体/.test(msg) && /horse 6\.8 格/.test(msg), '如实说没得打、并报最近的是谁', msg.slice(0, 140))
  }
  {   // 20 格外的怪 ⇒ 会追（pvp 自己走过去）
    const f = mkFightBot([farZombie])
    const mc = mkMc(f)
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z2' && r.attacked === 'zombie', '24 格内的怪会追（不再只限 4.5 格）', `distance=${r.distance}`)
  }
  {   // 12 格外的玩家（没怪）⇒ 不追
    const f = mkFightBot([player])
    const mc = mkMc(f)
    let err = null
    try { await mc.attack({ budget: 200 }) } catch (e) { err = e }
    ok(f.calls.attack.length === 0 && /4\.5 格内没有能打的实体/.test(String(err?.message ?? '')),
      '远处的玩家不主动追（要打就点名）', String(err?.message ?? '').slice(0, 90))
  }
  {   // 没有 pvp 插件 ⇒ 退回 4.5 格内挥一下
    const near = ent({ id: 'z9', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 3 } })
    const f = mkFightBot([near], { withPvp: false })
    const mc = mkMc(f)
    f.bot.attack = (t) => { f.calls.attack.push(t); return Promise.resolve() }
    const r = await mc.attack({ budget: 200 })
    ok(f.calls.attack[0]?.id === 'z9' && r.via === undefined, '没有 pvp 插件时退回"挥一下"', `attacked=${r.attacked}`)
  }
}

/* ─────────── ③ dig：目标按距离升序 + 别让一个目标吃光整轮 ─────────── */
section('③ dig —— 按距离升序、单个目标预算封顶、thinkTimeout 压低后还原')
{
  const mkDigBot = (specs, { hangFirst = false, at = { x: 0, y: 64, z: 0 } } = {}) => {
    const calls = { collect: [], think: [] }
    const blocks = new Map()
    for (const s of specs) {
      const p = new Vec3(s.x, s.y, s.z)
      blocks.set(`${s.x},${s.y},${s.z}`, { name: 'oak_log', type: 100, boundingBox: 'block', position: p })
    }
    const bot = {
      entity: { position: new Vec3(at.x, at.y, at.z) },
      _client: {},
      game: { gameMode: 'survival' },
      inventory: { items: () => [] },
      heldItem: null,
      registry: { itemsByName: {} },
      blockAt: (p) => blocks.get(`${p.x},${p.y},${p.z}`) ?? null,
      // 原地挖也要**真改世界**：`dig()` 现在会复核"方块还在不在"，假 bot 不删方块就只会报"没挖成"
      dig: async (blk) => { const q = blk?.position; if (q) blocks.delete(`${q.x},${q.y},${q.z}`) },
      findBlocks: () => specs.map((s) => ({ x: s.x, y: s.y, z: s.z })),
      setControlState: () => {},
      on: () => bot,
      pathfinder: {
        thinkTimeout: 8000,
        goto: async () => {},
        stop: () => {},
        setMovements: () => {},
      },
      collectBlock: {
        targets: { empty: true },
        collect: (list) => {
          const t = list[0]
          calls.collect.push({ at: `${t.position.x},${t.position.y},${t.position.z}`, think: bot.pathfinder.thinkTimeout })
          if (hangFirst && calls.collect.length === 1) return new Promise(() => {})   // 第一个永远挖不成
          blocks.delete(`${t.position.x},${t.position.y},${t.position.z}`)
          return Promise.resolve()
        },
        cancelTask: () => { bot.collectBlock.targets.empty = true; return Promise.resolve() },
      },
    }
    return { bot, calls, blocks, plugins: { collectBlock: true } }
  }

  {
    // findBlocks 故意"远的在前"：修好之后必须先挖近的
    // 🔴 2026-10-08：近的（眼到方块中心 2.78 格）走"够得着就原地挖"，远的（20.5 格）**不再交给
    //    collectBlock**（它会从看得见的地方硬挖 ⇒ 服务端拒收、画面"挖完又复原"），而是如实说够不着。
    const f = mkDigBot([{ x: 0, y: 64, z: 20 }, { x: 0, y: 64, z: 2 }])
    const mc = mkMc(f)
    const out = await mc.dig({ name: 'oak_log', count: 2, maxDistance: 24 })
    ok(/挖掉 oak_log @ \(0, 64, 2\)/.test(out[0] ?? ''), '先挖最近的（不再按 findBlocks 的返回顺序）', out[0])
    ok(out.some((l) => /够不着 oak_log @ \(0, 64, 20\)/.test(l)), '远的够不着就如实说（不再硬挖）',
      out.join(' ｜ ').slice(0, 200))
    ok(f.calls.collect.length === 0, 'dig() 全程不调 collectBlock（"挖完又复原"的根因）',
      f.calls.collect.map((c) => c.at).join(' → '))
  }
  {
    // 两个目标都够不着（站位 (0,64,-10)，眼到中心 12 / 14 格）：一个报完不能吃掉另一个
    const f = mkDigBot([{ x: 0, y: 64, z: 2 }, { x: 0, y: 64, z: 4 }], { hangFirst: true, at: { x: 0, y: 64, z: -10 } })
    const mc = mkMc(f)
    const t0 = Date.now()
    const out = await mc.dig({ name: 'oak_log', count: 2, maxDistance: 24 })
    const ms = Date.now() - t0
    ok(f.calls.collect.length === 0, '够不着也不交给 collectBlock', `collect=${f.calls.collect.length}`)
    ok(ms < 3000, '不会被一个目标拖满整轮（这里用 300ms 预算）', `${ms}ms`)
    ok(out.some((l) => /够不着 oak_log @ \(0, 64, 2\)/.test(l))
      && out.some((l) => /够不着 oak_log @ \(0, 64, 4\)/.test(l)),
      '两个够不着的都报到了（一个不影响下一个）', out.join(' ｜ ').slice(0, 200))
    ok(out.some((l) => /先 `mc_move` 到它旁边/.test(l)), '告诉模型先走过去再挖', out.join(' ｜ ').slice(0, 200))
    ok(f.bot.pathfinder.thinkTimeout === 8000, 'dig 不再改插件的 thinkTimeout（以前会临时压低再还原）',
      String(f.bot.pathfinder.thinkTimeout))
  }
}

/* ─────────── ④ connect({force}) 才真重连 ─────────── */
section('④ connect —— 已连着时不重连；force:true 先断开再真连一次')
{
  const mkFakeBot = (seq, tag) => {
    const b = new EventEmitter()
    b.tag = tag
    b.entity = { position: new Vec3(0, 64, 0), id: tag }
    b._client = {}
    b.game = { gameMode: 'survival' }
    b.health = 20
    b.inventory = { items: () => [] }
    b.quit = () => { seq.push(`quit:${tag}`) }
    b.setControlState = () => {}
    b.chat = () => {}
    b._createdAt = Date.now()
    setTimeout(() => b.emit('spawn'), 5)
    return b
  }
  const mkConnMc = (seq) => {
    const dir = mkdtempSync(join(tmpdir(), 'wc-coreatk-'))
    TMP_DIRS.push(dir)
    const mc = new McBot({ logFile: join(dir, 'check.log') })
    mc.setupPlugins = async () => {}
    mc.startObserver = () => {}
    mc.writeLock = () => {}
    mc.cfg.connectTimeoutMs = 2000
    mc.cfg.lockDir = dir
    return mc
  }
  const AUTH = { mode: 'offline', name: 'wc_check_bot' }

  // ① 已连着（不带 force）：空操作，不许再 createBot / quit
  {
    const seq = []
    const mc = mkConnMc(seq)
    const old = mkFakeBot(seq, 'old')
    old.emit('spawn')
    mc.bot = old
    mc.sub = ''
    mc._lastHost = '127.0.0.1'
    /* 🔴 2026-10-15 审计：空操作判据现在还会比 port / version / 账户（以前只比 host+sub，
     * 于是"同一个 host 换个账户再 mc_connect"会静默什么都不做、还谎报新账户）。
     * 手工摆状态时要把"上次成功连接的参数"一起摆好，否则这段状态不真实。 */
    mc._connectOpts = { host: '127.0.0.1', port: 25565, subserver: '', version: false, auth: AUTH }
    let created = 0
    const origCreate = mineflayer.createBot
    mineflayer.createBot = () => { created++; return mkFakeBot(seq, 'new') }
    try {
      const got = await mc.connect({ host: '127.0.0.1', port: 25565, auth: AUTH })
      ok(got === old && created === 0 && seq.length === 0, '已连着时 connect 是空操作（不重连、不 quit）',
        `created=${created} seq=${seq.join(',')}`)
    } finally { mineflayer.createBot = origCreate }
  }

  // ② force:true：必须先 quit 旧连接，再 createBot 一个新的
  {
    const seq = []
    const mc = mkConnMc(seq)
    const old = mkFakeBot(seq, 'old')
    old.emit('spawn')
    mc.bot = old
    mc.sub = ''
    mc._lastHost = '127.0.0.1'
    let created = 0
    const origCreate = mineflayer.createBot
    mineflayer.createBot = () => { created++; seq.push('createBot'); return mkFakeBot(seq, 'new') }
    try {
      const got = await mc.connect({ host: '127.0.0.1', port: 25565, auth: AUTH, force: true })
      ok(created === 1, 'force:true 真的重新建了连接（不是空操作）', `created=${created}`)
      ok(seq[0] === 'quit:old' && seq.indexOf('createBot') > 0, '顺序对：先断开旧连接、再连新的', seq.join(' → '))
      ok(got !== old && mc.bot === got, '换成新 bot（世界/实体重新收一遍）', `same=${got === old}`)
      ok(mc.autoReconnect === true, '连上之后自动重连恢复开启')
    } finally { mineflayer.createBot = origCreate }
  }
}

/* ─────────── ⑥ pvp.attack() 立刻 resolve ⇒ 必须自己等，别报"attacked"却一下没打 ─────────── */
section('⑥ 真打得到 —— 等目标死 / 等预算用完（旧写法 await 完就 stop ⇒ 一下都没打）')
{
  /** 装一个"像真 pvp 一样立刻 resolve"的假 pvp：可选过一会儿把目标删掉（= 打死）、可选 stop() 挂住 */
  const arm = (f, { wasInRange = true, killAfter = null, stopHangs = false, onAttack = null, noDamage = false } = {}) => {
    f.bot.pvp = {
      wasInRange,
      attack: (t) => {
        f.calls.attack.push(t)
        /* 🔴 2026-10-15 审计：`killed` 现在要求"消失前**读到过**它掉血" —— 以前只看实体没了，
         *    于是怪走出服务端追踪距离 / 区块卸载也会被报成"我打死了它"（还会顺带报掉落物）。
         *    所以这里要模拟真实过程：先掉一次血（轮询每 120ms 采一次，必须留够时间被采到），
         *    再让实体消失（= 真被打死）。 */
        if (killAfter != null) {
          const dropAt = Math.max(0, killAfter - 200)
          if (!noDamage) setTimeout(() => { if (f.bot.entities[t.id]) f.bot.entities[t.id].health = 8 }, dropAt)
          setTimeout(() => { delete f.bot.entities[t.id] }, killAfter)
        }
        if (onAttack) onAttack(t)
        return Promise.resolve()          // 真 PVP.js:60-76 就是这样：设完 goal 立刻 resolve
      },
      stop: () => { f.calls.stop++; return stopHangs ? new Promise(() => {}) : Promise.resolve() },
    }
    return f
  }
  /* `health` 是 2026-10-15 加的：`killed` 现在要求"消失前**读到过**掉血"，
   * 所以假实体必须有血量，否则 `entityHealth()` 回 null、永远判不出打死。 */
  const zombie = () => ent({ id: 'z1', name: 'zombie', type: 'hostile', kind: 'Hostile mobs', pos: { x: 0, y: 64, z: 2 }, health: 20 })

  {   // 打死 ⇒ killed:true、没有 note、不等满预算
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { killAfter: 300 })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const t0 = Date.now()
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    const ms = Date.now() - t0
    ok(r.killed === true && r.via === 'pvp', '目标从 entities 里没了 ⇒ killed:true', JSON.stringify(r))
    ok(!r.note, '打死了就不该再说"还没打死"', JSON.stringify(r))
    ok(ms < 2_500, '目标一没就立刻返回（不等满预算）', `${ms}ms`)
    ok(f.calls.stop >= 1, '结束时确实停了 pvp（不然会一直追着打）')
    ok(r.waitedMs >= 60, 'waitedMs 是真实等待时间', `waitedMs=${r.waitedMs}`)
    ok(!r.pickup, '附近没有掉落物就不该多嘴', JSON.stringify(r.pickup))
  }
  {   /* 🔴 2026-10-15 审计：实体**没掉血就消失**（怪走出服务端实体追踪距离 / 区块卸载）
       * 不能说成"我打死了它" —— 旧代码是 `killed: gone`，于是这种情况会谎报 killed:true，
       * 还会顺手报一份根本不存在的掉落物提示。这里必须如实说"说不清"。 */
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { killAfter: 300, noDamage: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    ok(r.killed === false && r.gone === true, '没读到掉血就消失 ⇒ killed:false、gone:true（别当成打死了）', JSON.stringify(r))
    ok(/没读到过它掉血/.test(String(r.note)), '如实说"说不清是我打死的还是它走远/区块卸载了"', String(r.note))
    ok(!r.pickup, '没打死就不该报"地上有掉落物去捡"', JSON.stringify(r.pickup))
  }
  {   /* 打死 + 东西掉在附近 ⇒ 必须点一句"走过去捡"。
       * 用户 2026-10-08 原话："挖完方块或者打完动物以后老是忘记走过去拾取" ——
       * 捡东西是决策，插件替不了，但结果里得让它知道这活还没完。 */
    const drop = ent({ id: 'd1', name: 'item', displayName: 'Item', type: 'other', pos: { x: 0.5, y: 64, z: 2.5 } })
    const cow = ent({ id: 'c1', name: 'cow', displayName: 'Cow', type: 'mob', pos: { x: 1, y: 64, z: 2 } })
    const f = arm(mkFightBot([zombie(), drop, cow], { withPvp: false }), { killAfter: 300 })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 4_000 })
    ok(r.killed === true && !r.note, '打死仍然 killed:true，note 里不写"还没打死"', JSON.stringify(r))
    ok(/地上还有 1 个掉落物没捡/.test(String(r.pickup)),
      '东西掉在附近 ⇒ 点一句"地上还有 N 个没捡"（牛不算掉落物）', String(r.pickup))
    ok(/mc_move/.test(String(r.pickup)) && /几分钟就消失/.test(String(r.pickup)),
      '提示要写清"走过去站上去"和"东西会消失"', String(r.pickup))
  }
  {   // 没打死 + 进了攻击距离 ⇒ 如实报"还没打死，再叫一次"
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { wasInRange: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(r.killed === false && r.via === 'pvp', '还在 ⇒ killed:false', JSON.stringify(r))
    ok(/还没打死/.test(String(r.note)) && /再叫一次 mc_act\{attack\}/.test(String(r.note)),
      '在攻击距离内 ⇒ 报"打了 N 秒还没打死，再叫一次接着打"', String(r.note))
    ok(r.waitedMs >= 350, '确实等到了预算用完', `waitedMs=${r.waitedMs}`)
  }
  {   // 没打死 + 一直没进攻击距离 ⇒ 报"追不上"，别让它以为在挨打
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { wasInRange: false })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(/还没进到攻击距离/.test(String(r.note)) && /mc_move/.test(String(r.note)),
      '一直没进距离 ⇒ 报"追不上"（走不过去 / 被挡住 / 目标太快）', String(r.note))
  }
  {   // stop() 挂住也不能拖住这一轮（旧写法 await stop 最多等 5 秒）
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { stopHangs: true })
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const t0 = Date.now()
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    const ms = Date.now() - t0
    ok(Boolean(r.attacked) && ms < 1_600, 'pvp.stop() 挂住也照样按时返回（绝不 await stop）', `${ms}ms`)
  }
  {   // 打掉多少血要如实报；读不到就不报
    const f = arm(mkFightBot([zombie()], { withPvp: false }), { onAttack: () => { hp = 4 } })
    let hp = 10
    f.bot.util = { entity: { getHealth: () => hp } }
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(r.targetHealth === '10 → 4', '血量有变就如实报 targetHealth', String(r.targetHealth))
  }
  {
    const f = arm(mkFightBot([zombie()], { withPvp: false }), {})
    const mc = mkMc(f); mc.mcPlugins = { pvp: true }
    const r = await mc.attack({ who: 'zombie', budget: 400 })
    ok(!('targetHealth' in r), '读不到血量就不报（不许编）', JSON.stringify(r))
  }
  {   // 没有 pvp 插件：按预算多挥几下（上游原版是单挥，这里不能只挥一次就回"打了"）
    const f = mkFightBot([zombie()], { withPvp: false })
    f.bot.attack = (t) => { f.calls.attack.push(t); return Promise.resolve() }
    const mc = mkMc(f)
    const r = await mc.attack({ who: 'zombie', budget: 1_300 })
    ok(r.swings >= 2 && r.via === undefined, '没有 pvp 时按预算多挥几下', `swings=${r.swings}`)
  }
}

/* ─────────── ⑤ 静态接线（防以后改回去）─────────── */
section('⑤ 静态接线')
{
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const core = readFileSync(new URL('../src/core.mjs', import.meta.url), 'utf8')
  const coreNo = strip(core)
  const idx = readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  const idxNo = strip(idx)
  const has = (s, t, label) => ok(s.includes(t), label, t)

  has(coreNo, "from './entity-names.mjs'", 'core：实体名字与分类从 entity-names.mjs 导入（路线图第 ④ 条第四刀）')
  // 🔴 2026-10-08 第四刀：这四个定义已搬到 src/entity-names.mjs ⇒ 断言要跟着搬
  //    （搬家才会暴露的坑：断言按"这个文件里有没有这段文字"来判，代码一换文件就红，红的样子和"功能坏了"一样）
  const namesNo = strip(readFileSync(new URL('../src/entity-names.mjs', import.meta.url), 'utf8'))
  has(namesNo, 'const JUNK_RE =', 'entity-names：掉落物名单 JUNK_RE')
  has(namesNo, 'const NAME_ALIAS =', 'entity-names：中文别名表 NAME_ALIAS')
  has(namesNo, 'const entityNameOf = (e) => String(e?.username ?? e?.name', 'entity-names：玩家优先 username')
  has(namesNo, 'const nameFieldsOf = (e) =>', 'entity-names：所有名字字段一起匹配')
  /* 🔴 2026-10-08 第二十一刀：整个 `attack()` 搬进 `src/attack.mjs` ⇒ 下面这些"按文本找实现"的
   *    断言全部改成读新模块，并补一条"core 的薄包装 + 确实 import 了"的接线断言。 */
  const atkNo = strip(readFileSync(new URL('../src/attack.mjs', import.meta.url), 'utf8'))
  /* 🔴 2026-10-15 审计：`dig()` / `connect()` 早就搬到 `src/mining.mjs`、`src/dig-guard.mjs`、
   *    `src/connection.mjs` 了，但下面这些断言还在 `core.mjs` 里找原文 ⇒ 一直红着。
   *    修法同第十刀：断言指向真正实现它的文件。 */
  const minNo = strip(readFileSync(new URL('../src/mining.mjs', import.meta.url), 'utf8'))
  const dgNo = strip(readFileSync(new URL('../src/dig-guard.mjs', import.meta.url), 'utf8'))
  const connNo = strip(readFileSync(new URL('../src/connection.mjs', import.meta.url), 'utf8'))
  const auNo = strip(readFileSync(new URL('../src/async-util.mjs', import.meta.url), 'utf8'))
  has(atkNo, '24 格内实际有：', 'attack.mjs：找不到时列出半径内实际有谁')
  has(atkNo, 'const inReach = needle ? all : all.filter((x) => x.d <= 4.5 || rankOf(x) === 0)',
    'attack.mjs：不给 who 时只追怪（动物/玩家限 4.5 格）')
  has(minNo, 'Math.max(2500, Math.floor(left * 0.6))', 'mining：dig 单个目标预算封顶')
  /* 🔴 2026-10-08：`dig()` 不再把方块交给 collectBlock（"挖完又复原 + 之后几分钟走不了路"的根因），
   *    那条路上的"临时压低 thinkTimeout 再还原"也就跟着删了。这里改成钉死"不碰插件配置"。 */
  ok(!/pf\.thinkTimeout = Math\.max\(/.test(coreNo), 'core：dig 不再改插件的 thinkTimeout（那条路已删）')
  /* 🔴 2026-10-08 第十刀：`#reachOf` / `#entityHealth` 搬进 `src/world-observer.mjs`
   *    （改名 `blockReachOf` / `entityHealth`）⇒ 判据要跟着指向新文件，并确认 core 真的导入了。 */
  const woNo = strip(readFileSync(new URL('../src/world-observer.mjs', import.meta.url), 'utf8'))
  has(minNo, 'if (blockReachOf(b, fresh) > reachMax) {', 'mining：够不着先自己走过去（不再交给 collectBlock）')
  has(coreNo, "from './world-observer.mjs'", 'core：观察层从 world-observer.mjs 导入（第十刀）')
  has(dgNo, 'b.collectBlock?.targets?.clear?.()', 'dig-guard：采集任务卡死时清空僵尸队列兜底')
  has(minNo, 'const pinned = pos ? targets[0] : null', 'mining：dig 目标按距离升序（显式 pos 仍第一）')
  has(connNo, 'if (force && self.bot) {', 'connection：connect 的 force 分支')
  has(connNo, 'if (!force && sameAsLive) return self.bot',
    'connection：不带 force 且已连着 = 空操作（还要比 port/version/账户）')
  has(connNo, 'await sleep(600)', 'connection：force 重连前等一下（服务端放掉旧会话）')
  /* 🔴 2026-10-15：挖方块报"复原"的文案以前主动教模型 `mc_connect {force:true}` 刷区块 ——
   *    那是**真的退出游戏再进服**，服务器会向全服广播"你离开了游戏"，玩家会看到它消失几秒
   *    （实机取证：10-13 / 10-14 / 10-15 共 15 次强制重连，玩家两次在公屏问"怎么退游戏了"）。
   *    现在改成先怀疑"是不是我自己垫脚/搭高放上去的方块"，并明确劝退 force 重连。
   *    这里钉"不再推荐"这件事，而不是钉某一句原文。 */
  ok(!/重连刷新区块/.test(minNo), 'mining：不再教模型"用 mc_connect {force:true} 重连刷新区块"')
  has(auNo, '垫脚', 'async-util：DESYNC_HINT 让模型先怀疑"那格是不是我自己垫脚/搭高放上去的"')
  has(minNo, 'DESYNC_HINT', 'mining：失步文案统一走 DESYNC_HINT（劝退 force 重连）')
  has(idxNo, 'if (args.force)     opts.force     = true', 'index：mc_connect 把 force 传下去')
  has(idxNo, 'force:     { type:', 'index：mc_connect 暴露 force 参数')
  has(idxNo, '中英文都认', 'index：mc_act 描述写明 attack 认中英文名')
  has(atkNo, 'await b.pvp.attack(target)', 'attack.mjs：pvp 还是用 attack(target) 设目标（会自己追过去）')
  has(atkNo, 'if (!b.entities?.[target.id] || target.isValid === false) break',
    'attack.mjs：自己等目标消失（pvp.attack 立刻 resolve，不能 await 完就 stop）')
  has(atkNo, 'Promise.resolve(b.pvp.stop()).catch(() => {})',
    'attack.mjs：pvp.stop() 不 await（它最多等 5 秒 path_stop，会把预算吃光）')
  has(woNo, 'export function entityHealth (b, e)', 'world-observer：血量助手 entityHealth（第十刀搬过去的）')
  has(atkNo, 'const hpBefore = entityHealth(b, target)', 'attack.mjs：动手前先记目标血量')
  has(atkNo, 'b.pvp?.wasInRange', 'attack.mjs：用 wasInRange 区分"没打死"和"没追上"')
  /* 🔴 2026-10-15 审计：`killed: gone` 把"怪走出服务端实体追踪距离 / 区块卸载"当成"我打死了它"
   *    （还会顺带报一份不存在的掉落物提示）。现在只有**消失前读到过掉血**才算打死。 */
  has(atkNo, 'const killed = gone && sawDamage', 'attack.mjs：只有消失前读到过掉血才算打死（旧写法是 killed: gone）')
  has(atkNo, 'const gone = !b.entities?.[target.id]', 'attack.mjs：单独如实报 gone（不见了 ≠ 我打死的）')
  has(atkNo, '还没进到攻击距离', 'attack.mjs：追不上时的文案')
  ok(!/await b\.pvp\.stop\(\)/.test(atkNo), 'attack.mjs：不许 await b.pvp.stop()')
  ok(!/withTimeout\(b\.pvp\.attack/.test(atkNo) && !/raceAbort\(\s*withTimeout\(b\.pvp\.attack/.test(atkNo),
    'attack.mjs：不再把 pvp.attack 当同步动作 await（旧写法的病根）')
  ok(!/附近找不到 "?\$\{who\}?"?\)/.test(atkNo), 'attack.mjs：不再只有干巴巴一句"附近找不到"')
  /* 接线：第二十一刀把整个 attack() 搬走 ⇒ core 里只剩薄包装，且必须真的 import 了 */
  has(coreNo, "import { attack } from './attack.mjs'", 'core：确实 import 了 attack')
  ok(/async attack \(opts = \{\}\) \{[\s\S]{0,420}return await attack\(this\.requireBot\(\), opts, \{/.test(coreNo),
    'core：attack 是薄包装（把 bot + t/callLeft/abortSignal/hasPvp 传进去）')
  ok(!/b\.pvp\.attack\(/.test(coreNo) && !/inReach = needle/.test(coreNo),
    'core：没有残留的选目标 / pvp.attack 实现')
}

// ── 收尾 ──────────────────────────────────────────────────────────────────────
for (const d of TMP_DIRS) { try { rmSync(d, { recursive: true, force: true }) } catch {} }
console.log(`\ncheck-core-attack：pass=${pass} fail=${fail}`)
process.exit(fail ? 1 : 0)
