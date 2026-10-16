/**
 * mc_auto.mjs —— 自主行为层：让它像正常玩家一样，不等指令也有动作、也会自己想事做
 * ============================================================================
 * 用户诉求（2026-10-05 m01304）："现在机器人等指令的时候很少动，能不能让它像正常玩家一样，有自主决策"
 * 用户补充（m01412）："没事做的时候，看看玩家在干什么，可以询问，观察，理解并帮助玩家"
 * 用户选择（m01305）：① 两层都要，**默认只做无害动作**；② 空闲就叫醒 AI 一次。
 * 用户改（m02357）："待机时间改成5秒触发" ⇒ idleWakeSec / minIdleGapSec / idleWakeNearPlayerSec 默认 5s。
 *
 * 两层：
 *   ① **反射层**（不花 token，常开）：
 *      环顾（附近有人时**一直盯着他/她看**）、自动吃、捡掉落物、
 *      躲岩浆/火/仙人掌、低血逃离敌对、跟随指定玩家。
 *      · 只在"AI 没在调工具"时动手（任何工具调用后静默 quietAfterToolMs，默认 6s）；
 *      · **走路类**（跟随/捡东西）额外要求 `agent.status !== 'running'`
 *        —— AI 这一轮还没跑完（可能在思考/等事件）时不许挪窝，免得它按旧画面行动；
 *      · 定时器回调里**绝不抛错**（setInterval 回调抛错 = uncaughtException = 整个宿主进程死）。
 *   ② **空闲决策层**（花 token）：闲着 idleWakeSec（默认 **5s**；旁边有人时 idleWakeNearPlayerSec，默认 5s）后，
 *      用 `agent.steer(plugin notice)` 把 AI 叫醒（宿主语义："空闲起一轮、运行中下一步插话"）。
 *      叫醒文案**先给观察结果**（附近玩家：距离/在动还是站着/手持什么/面向哪边/y、最近聊天、自己的位置血量饥饿），
 *      再要求它"按长期目标 standing 自己动手做 2~4 个动作 → 简短汇报"（**不许反问 Master**），
 *      **看图不强制**：叫醒文案只把 `mc_observe` 列成"需要就看一眼"的可选项，什么时候看由它自己判断
 *      （Master m05647「那个获取第一视角不要强制的，让 ai 自主获取」）。
 *      默认长期目标是"像正常玩家一样发展、最后打末影龙、和玩家一起玩"（见 DEFAULT_STANDING），
 *      文案里还带一条**正常生存路线**（木头→石→铁→钻石→下界→末地）当台阶，免得它一上来就想冲末地。
 *      45s 还没动手再补一条"别问了，直接做"的催促。
 *      · 上限：每小时 idleWakeMaxPerHour 次 + 最小间隔 minIdleGapSec；
 *      · **退避**：叫醒后 AI 什么也没做（没调任何工具）→ 下次间隔翻倍（封顶 30 分钟），
 *        做了事立刻复位 —— 这是"用户不在电脑前整夜烧 token"的保险丝。
 *
 * 边界与约定：
 *   · **不改 index.js / src/****（那些是 pnpm store 的硬链接，改了会被重装覆盖）；
 *     本文件是自主层的唯一入口，配置落**记忆根**下的 `auto.json`
 *     （默认 `<工作区>/.mcp-mc-agent/auto.json`；Master 设了 `config.memoryDir` 就跟着挪）。
 *   · **不开新会话**（单脑约束）：叫醒永远 steer 到当前会话，与看门狗同一条通道。
 *   · 与看门狗不打架：看门狗刚叫醒过（minIdleGapSec 内）就不再叫。
 *   · 与 mc_observe 门禁无关（mc_auto 不在 gated 集合里，随时可调）；叫醒文案**也不强制**它看图 ——
 *     第一视角是它自己的工具，什么时候用由它判断（Master m05647）。
 *   · 只依赖 `../src/user-message.mjs`（宿主消息工厂），其余全部自带 —— 便于离线自检。
 * ============================================================================
 */
import { userMessage } from '../src/user-message.mjs'
import { clamp } from './mc_util.mjs'
import { BRIDGE_FATAL } from '../src/bridge.mjs'
import { floorMapOf, hazardCellsOf } from '../src/map-render.mjs'
import { recoverFromWater, waterReportText } from '../src/water-recovery.mjs'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'mc-auto'

/**
 * 默认长期目标（`mc_auto set {"standing":"..."}` 可改，最长 240 字）。
 * 为什么要有这一条：AI 被叫醒时如果只看到"你可以自己找点事做"，它就会反问 Master
 * "要我做什么？"然后干等 —— 实测日志（session-8d80cd31）里连着好几轮都是这个模式。
 * 给一条明确的行动纲领，它才会自己开工。
 * 2026-09-18 Master 改的方向（m05559）：不再是"活下来、盖个小屋"就算完，而是
 * **像正常玩家一样从头发展、一路打到末影龙**，并且**和玩家一起玩**。
 * 具体该按什么顺序推进（木头→石→铁→钻石→下界→末地）写在叫醒文案里，不塞进这一行 ——
 * 这行是给 Master 随手改的目标原文，短一点才看得清。
 */
export const DEFAULT_STANDING = '和正常玩家一样发展，最后击败末影龙。和玩家一起玩我的世界。'

/* ─────────────────────────── 默认配置 ─────────────────────────── */

export const AUTO_DEFAULTS = {
  /** 反射层总开关（关掉=只有空闲决策层还会叫醒 AI） */
  enabled: true,
  /** 空闲决策层：闲着这么久就叫醒 AI（秒）。用户要求：待机 5 秒就触发 */
  idleWake: true,
  idleWakeSec: 5,
  /** 每小时最多叫醒几次（硬上限，防刷屏烧 token）。5s 间隔下自然节奏约 1 次/分钟 ⇒ 给足余量 */
  idleWakeMaxPerHour: 120,
  /** 两次叫醒之间至少隔多久（秒） */
  minIdleGapSec: 5,
  /** 叫醒后 AI 没动作 → 间隔翻倍退避（封顶 30 分钟） */
  idleWakeBackoff: true,
  /**
   * 长期自主目标：Master 不在时按它自己玩（写进每次叫醒文案，最长 240 字）。
   * 这条是**给 AI 的行动纲领**，不是待确认事项 —— 用户明确要求"不要一直反问我"。
   */
  standing: DEFAULT_STANDING,

  /** 反射项（逐项可关） */
  lookAround: true,   // 环顾 / 看附近的玩家
  autoEat: true,      // 饿了自动吃（交给现成的 mineflayer-auto-eat）
  pickup: true,       // 走过去捡附近掉落物（交给现成的 mineflayer-collectblock）
  avoid: true,        // 躲岩浆/火/仙人掌 + 被怪打/怪贴上来时**叫醒 AI**（不自己跑、不还手）
  wearArmor: true,    // 空着的盔甲位就从背包里穿上（"变强"里最便宜的一步；不动位置、不打怪）
  follow: null,       // 跟随的玩家名（null = 不跟随）
  followDistance: 3,  // 跟到这个距离就停

  /** 附近有人时"看着他/她在干什么"（只转头看，不动位置、不碰东西） */
  watchPlayers: true,
  /** 观察附近玩家的半径（格） */
  playerNearRadius: 24,
  /** 附近有玩家时，空闲叫醒改用这个更短的间隔（秒）——有人在旁边就勤看着点 */
  idleWakeNearPlayerSec: 5,

  /** 任何工具调用后，反射层静默多久（毫秒）——把控制权让给 AI */
  quietAfterToolMs: 6000,

  /**
   * 自保叫醒时**先停下手里的事**（默认开）。用户 2026-10-14 任务驱动第三步：
   * "先停止采集，再由 AI 决定逃跑、战斗还是继续任务"。
   *
   * 🔴 只"停手"，**不跑、不还手** —— 那是用户 2026-10-06 定的（自保层不替 AI 做决策）。
   * 关掉它 = 回到"只叫醒、什么都不动"的老行为。
   */
  dangerStopWork: true,
}

/** 数值项的合法区间（越界就夹住，不报错） */
const RANGES = {
  idleWakeSec: [5, 3600],
  idleWakeMaxPerHour: [1, 720],
  minIdleGapSec: [5, 3600],
  idleWakeNearPlayerSec: [5, 3600],
  playerNearRadius: [4, 64],
  followDistance: [1, 10],
  quietAfterToolMs: [500, 60_000],
}

/** 退避封顶（毫秒） */
const MAX_BACKOFF_MS = 30 * 60_000
/** 叫醒间隔的硬下限（秒）：用户要求待机 5 秒就能触发，所以下限也是 5 */
const MIN_IDLE_SEC = 5
/** 叫醒后多久还没动手就补一条催促（毫秒） */
const NUDGE_AFTER_MS = 45_000
/** 跟随走路的预算（毫秒） */
const WALK_BUDGET = 2600
/** 被怪贴上时的"急事"叫醒最短间隔（毫秒）：不受空闲间隔/退避限制，但别一秒一条 */
const DANGER_WAKE_GAP_MS = 15_000
/** 怪贴到几格内算"急事"（AI 正在动手也要抢控制权先跑） */
const URGENT_RADIUS = 4
/** 憋气叫醒的最短间隔（毫秒）：氧气见底后每秒都在掉血，等 15 秒太久，所以比 DANGER_WAKE_GAP_MS 短 */
const DROWN_WAKE_GAP_MS = 6_000
/** 氧气低于这个值就该出声（20 = 满；掉到 0 之后开始掉血） */
const DROWN_AIR = 6
/** 头在水下多久就出声（毫秒）。🔴 读不到氧气时（1.21.9/1.21.10 上是 null）靠这条：
 *  人在水里憋气 15 秒开始掉血，10 秒出声留出换气的时间。 */
const DROWN_SUBMERGE_MS = 10_000
/** "头在水下"这条的重复叫醒间隔（毫秒）：比掉血那条宽，免得潜水时一秒一条 */
const DROWN_SUBMERGE_GAP_MS = 20_000
/** 🔴 水下自动救援的最短间隔（毫秒）：一次"搜出口 + 走一条路线"最多 12 秒，别叠着跑 */
const WATER_RECOVER_GAP_MS = 15_000
/** 🔴 水下自动救援一次的墙钟上限（毫秒）：超了就放弃这一轮（`recoverFromWater` 自己也有 12 秒预算） */
const WATER_RECOVER_MAX_MS = 15_000

/* ─────────────────────────── 小工具 ─────────────────────────── */

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const randBetween = (rng, a, b) => a + rng() * (b - a)

/** 带超时的 await：超时 reject，迟到结果被丢掉（照抄 src/core.mjs 的语义） */
const withTimeout = (p, ms, label) => new Promise((resolve, reject) => {
  let done = false
  const t = setTimeout(() => {
    if (done) return
    done = true
    reject(new Error(`${label}超时（${ms}ms）`))
  }, ms)
  t.unref?.()
  Promise.resolve(p).then(
    (v) => { if (done) return; done = true; clearTimeout(t); resolve(v) },
    (e) => { if (done) return; done = true; clearTimeout(t); reject(e) },
  )
})

/** 一次性定时器（unref，回调里吞异常） */
const later = (ms, fn) => {
  const t = setTimeout(() => { try { fn() } catch { /* 定时器里绝不抛 */ } }, ms)
  t.unref?.()
  return t
}

/**
 * 按住一个控制位一小会儿 —— **优先走 `McBot.holdControl()`**（会声明租约，
 * 让 `#releaseControls()` 不要"顺手"松掉我们正按着的键，见 core.mjs 审计⑨）。
 * 没有这个 API（老版本 / 假 bot）就退回"直接按 + later 松"。
 */
const holdCtl = (sess, key, ms, off) => {
  const hold = sess?.bot?.holdControl
  if (typeof hold === 'function') {
    try { hold.call(sess.bot, key, ms); return } catch { /* 落到兜底 */ }
  }
  try { sess?.bot?.bot?.setControlState?.(key, true) } catch { /* 忽略 */ }
  later(ms, off)
}

/** 极简 Vec3 替身：mineflayer 的 world.getBlock 只用到 floored()/x/y/z */
const mkPos = (x, y, z) => ({
  x, y, z,
  floored () { return { x: Math.floor(this.x), y: Math.floor(this.y), z: Math.floor(this.z) } },
  offset (dx, dy, dz) { return mkPos(this.x + dx, this.y + dy, this.z + dz) },
})

/** 危险方块（踩上去/碰到就吃亏）—— **名单的唯一出处是 `src/bridge.mjs` 的 `BRIDGE_FATAL_NAMES`**。
 *  这里原来自己写了一份正则，漏了 `soul_fire` / `soul_campfire`（灵魂火也是火），
 *  而且两份名单迟早会走岔。搭路那边认的危险方块，反射层这边就该认同一批。 */
const DANGER = BRIDGE_FATAL
/** 敌对生物（名字/类型里出现就躲） */
const HOSTILE = /zombie|skeleton|creeper|spider|witch|enderman|slime|pillager|vindicator|ravager|phantom|drowned|husk|stray|blaze|ghast|hoglin|piglin|wither|warden|silverfish|guardian|shulker/i
/** 不是"掉落物"的实体（船/矿车/展示框…），捡东西时跳过 */
const NOT_DROP = /boat|minecart|armor_stand|item_frame|painting|arrow|snowball|egg|ender_pearl|eye_of_ender|fireball|fishing_bobber|potion|tnt|falling_block|leash|knot|shulker_bullet|llama_spit|wind_charge/i

/* ── 谁算"远程怪"（用户 2026-10-06：别忘了还有远程攻击的怪物）─────────────────
 * 它们隔着十几格就能打到你，所以威胁半径放宽（见 RANGED_NEAR_RADIUS）。
 * 🔴 这里**只用来判威胁半径**，不判"打不打得过" —— 反射层不还手了（见下）。
 */
const RANGED = /skeleton|stray|bogged|pillager|vindicator|witch|blaze|ghast|guardian|shulker|llama|illusioner|evoker|breeze|wither|drowned/i
/** 远程怪的威胁半径：它们从 16~22 格就开始开火，只按 8 格扫根本来不及 */
const RANGED_NEAR_RADIUS = 22
/** 盔甲槽：mineflayer 玩家背包里 5=头 6=胸 7=腿 8=脚 */
const ARMOR_SLOTS = [
  ['head', 5, /(_helmet|_cap|turtle_helmet|_skull)$/],
  ['torso', 6, /(_chestplate|_tunic)$/],
  ['legs', 7, /(_leggings|_pants)$/],
  ['feet', 8, /_boots$/],
]
/** 挡不住视线、可以站进去的方块（找落脚点用） */
const AIRY = /^(air|cave_air|void_air|short_grass|grass|tall_grass|fern|large_fern|dandelion|poppy|blue_orchid|torch|wall_torch|soul_torch|redstone_torch|vine|snow|rail|lily_pad|dead_bush|seagrass)$/
/** 液体（不能当落脚点） */
const LIQUID = /water|lava|bubble_column|kelp/

const blockNameAt = (b, pos) => {
  try {
    if (!pos) return null
    // 🔴 真 mineflayer 的 `bot.blockAt()` 只认真 Vec3（喂普通 `{x,y,z}` 会 `pos.floored is not a function`）。
    // `eyeOf()` 给的正是普通对象，所以这里自己包一层 —— 否则 `blockNameAt(b, eyeOf(…))` 永远 null
    // （`losBlocked()` 就会恒为"没挡住"，远程怪那条过滤静默失效）。
    const v = typeof pos.floored === 'function' ? pos : asVec(b, pos)
    return b?.blockAt?.(v)?.name ?? null
  } catch { return null }
}

/** 把普通 `{x,y,z}` 包成"像 Vec3 的东西"：能用真 bot 的 Vec3 类就用，否则给个带 `floored()` 的壳 */
const asVec = (b, pos) => {
  const C = b?.entity?.position?.constructor
  if (typeof C === 'function' && C !== Object) {
    try { return new C(pos.x, pos.y, pos.z) } catch { /* 落到下面 */ }
  }
  const o = { x: pos.x, y: pos.y, z: pos.z }
  o.floored = () => o
  return o
}

/** 头在水下吗（眼睛那一格是液体）。这是"憋气"的直接判据：
 *  `bot.oxygenLevel` 只在**头入水之后**才有读数（mineflayer 收到 `air_supply` 元数据才设它，
 *  实机验证：水面上是 null、头一埋进水里就有 7/20），所以判据要两条一起看。
 *  🔴 2026-10-08 实机：这里以前先要求 `e.isInWater` —— 而 prismarine-physics 的入水 AABB
 *  从底部缩了 0.401，**泡在水柱里**（脚/头两格都是 water）时它读出来是 undefined
 *  ⇒ 反射层判不出憋气、AI 会一声不响地淹死。头在水下就是头在水下，只看眼睛那一格。 */
const submergedIn = (b, e) => {
  try {
    if (!e?.position) return false
    return LIQUID.test(String(blockNameAt(b, eyeOf(e.position)) ?? ''))
  } catch { return false }
}

/** 附近有没有玩家（用来避免挤人 / 决定要不要看他） */
const playersNear = (b, radius) => {
  const me = b?.entity?.position
  if (!me) return []
  const out = []
  for (const p of Object.values(b?.players ?? {})) {
    const pos = p?.entity?.position
    if (!p?.username || !pos) continue
    // 跳过自己：mineflayer 的 bot.players 里也有自己（否则会"盯着自己看"、把自己算成"旁边有人"）
    if (p.entity === b.entity || (b.username && p.username === b.username)) continue
    const d = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z)
    if (d <= radius) out.push({ username: p.username, position: pos, distance: d })
  }
  return out.sort((a, c) => a.distance - c.distance)
}

/** 附近的敌对实体（按距离排序） */
const hostilesNear = (b, radius) => {
  const me = b?.entity?.position
  if (!me) return []
  const out = []
  for (const e of Object.values(b?.entities ?? {})) {
    if (e === b.entity || !e?.position) continue
    const nm = String(e.name ?? e.username ?? '')
    const hostile = HOSTILE.test(nm) || e.kind === 'Hostile mobs'
    if (!hostile) continue
    const d = e.position.distanceTo(me)
    if (d <= radius) out.push({ entity: e, distance: d, name: nm || String(e.type ?? '?') })
  }
  return out.sort((a, c) => a.distance - c.distance)
}

/* 🟢 2026-10-15 审计（报告 H 第 10 条）：这里原来有
 *    `const nearestHostile = (b, radius) => hostilesNear(b, radius)[0] ?? null`
 *    —— 注释写着"别处还在用"，但全仓库（含 tools/check-mc-auto.mjs、selfcheck.mjs）
 *    只有它自己的定义、**零调用点**。删掉。`hostilesNear` 还有 `:1007` 在用，保留。 */

/* 🔴 这里原来有 weaponInHand / weaponInBag / judgeFight（"叫不醒 AI 就自己判断打得过打不过"）。
 * 用户 2026-10-06："反射层兜底还手：judgeFight() 不需要了" ⇒ 整段删掉。
 * 反射层**永不还手**：挨打只叫醒 AI，打不打由 AI 自己定（它用 mc_observe 的"程序检测到"拿坐标/血量，
 * 用 mc_act {"mode":"attack"} 动手）。 */

/** a→c 的视线有没有被方块挡住（每 0.5 格取一次方块名；粗粒度够用了） */
const losBlocked = (b, a, c) => {
  const dx = c.x - a.x
  const dy = c.y - a.y
  const dz = c.z - a.z
  const n = Math.max(2, Math.ceil(Math.hypot(dx, dy, dz) / 0.5))
  for (let i = 1; i < n; i++) {
    const t = i / n
    const nm = blockNameAt(b, mkPos(Math.floor(a.x + dx * t), Math.floor(a.y + dy * t), Math.floor(a.z + dz * t)))
    if (nm && !AIRY.test(nm)) return true
  }
  return false
}

/** 眼睛位置（射线起点/终点） */
const eyeOf = (p) => ({ x: p.x, y: p.y + 1.6, z: p.z })

/** 空着的盔甲位就把包里的甲穿上（"变强"里最便宜的一步：有甲就穿） */
const wearArmor = async (b) => {
  const inv = b?.inventory
  if (!inv?.slots || typeof b?.equip !== 'function' || typeof inv.items !== 'function') return 0
  let n = 0
  for (const [dest, slot, re] of ARMOR_SLOTS) {
    if (inv.slots[slot]) continue                       // 这个位置已经有甲，不折腾
    const item = inv.items().find((i) => re.test(String(i?.name ?? '')))
    if (!item) continue
    try { await b.equip(item, dest); n++ } catch { /* 忽略：穿不上就算了 */ }
  }
  return n
}

/** 是不是掉落物（含经验球） */
const isDrop = (e) => {
  if (!e?.position) return false
  const n = String(e.name ?? '')
  const dn = String(e.displayName ?? '')
  /* 🔴 `minecraft-data`（1.21.9）里：掉落物实体是 `name: 'item'` / `displayName: 'Item'`，
   *    经验球是 `name: 'experience_orb'` / `displayName: 'Experience Orb'` ——
   *    但它们的 **`type` 都是 `'other'`**，**不是 `'object'`**！
   *    原来那句 `if (e.type !== 'object') return false` 让这条判据**永远返回 false**
   *    （2026-10-08 实机：`mc_dig` 挖掉 3 根原木、地上掉落物一个没捡，就是同一个坑）。
   *    ⇒ 只按**实体名**认，不碰 `type`。 */
  if (!/^(item|experience_orb)$/i.test(n) && !/^(item|experience orb)$/i.test(dn)) return false
  return !NOT_DROP.test(n) && !NOT_DROP.test(dn)
}

/** yaw → 罗盘方位（跟 MC 一致：0=北(-Z)，-90=东(+X)，90=西(-X)，180=南(+Z)） */
const FACING = ['南', '东南', '东', '东北', '北', '西北', '西', '西南', '南']
const facingOf = (yaw) => {
  const y = Number(yaw)
  if (!Number.isFinite(y)) return null
  const deg = (((y + 180) % 360) + 360) % 360
  return FACING[clamp(Math.round(deg / 45), 0, 8)]
}

/* ─────────────────────────── 控制器 ─────────────────────────── */
/**
 * 造一个自主层控制器（**不碰定时器**，tick 由调用方驱动 —— 便于自检里手动跑）。
 * @param {object} o
 * @param {object} o.registry   McRegistry（要 listSessions）
 * @param {Function} [o.logLine]
 * @param {Function} [o.workspaceOf] agent → 工作区绝对路径
 * @param {Function} [o.memRootOf]  工作区路径 → 记忆根绝对路径（`config.memoryDir` 生效时就不在工作区里了）
 * @param {Function} [o.rng]    随机源（自检里换成定值）
 * @param {Function} [o.now]    时钟（自检里换成假表）
 */
export function createAuto ({ registry, logLine = () => {}, workspaceOf = null, memRootOf = null, rng = Math.random, now = () => Date.now() } = {}) {
  /** sid → 会话状态 */
  const sessions = new Map()
  /** 工作区 key → 配置 */
  const configs = new Map()

  /* ── 配置 ── */

  const wsKeyOf = (agent) => {
    try { return String(workspaceOf?.(agent) ?? 'default') } catch { return 'default' }
  }

  /** agent → 记忆根目录（auto.json 就放这里）。
   *  🔴 不能写死 `<工作区>/.mcp-mc-agent`：Master 一旦设了 `config.memoryDir`（记忆可以挪到插件
   *  自己的家），记忆根就不在工作区里了；写死会把 auto.json 劈到另一个地方去，状态一分为二。
   *  拿不到记忆根（老宿主没给 memoryFor）才退回 `<工作区>/.mcp-mc-agent`。 */
  const memDirOf = (agent) => {
    const ws = wsKeyOf(agent)
    if (!ws || ws === 'default') return null
    try { const r = memRootOf?.(ws); if (r) return r } catch { /* 退回工作区 */ }
    return join(ws, '.mcp-mc-agent')
  }

  /** 夹取/类型转换一个配置项；非法返回 undefined */
  const coerce = (key, raw) => {
    const def = AUTO_DEFAULTS[key]
    if (def === undefined) return undefined
    if (typeof def === 'boolean') {
      if (typeof raw === 'boolean') return raw
      return !/^(false|0|no|off|关|否)$/i.test(String(raw).trim())
    }
    if (typeof def === 'number') {
      const n = Number(raw)
      if (!Number.isFinite(n)) return undefined
      const [a, b] = RANGES[key] ?? [-Infinity, Infinity]
      return clamp(n, a, b)
    }
    if (def === null || typeof def === 'string') {
      if (raw === null || raw === undefined || raw === '' || /^(null|none|off|关|不跟)$/i.test(String(raw))) return null
      // 长期目标是长句子，别被 32 字上限截断
      const limit = key === 'standing' ? 240 : 32
      return String(raw).trim().slice(0, limit)
    }
    return undefined
  }

  /** 载入记忆根下的配置（一次），失败就用默认值。dir = 记忆根目录（不是工作区） */
  const loadConfig = (dir) => {
    const cfg = { ...AUTO_DEFAULTS }
    try {
      if (!dir) return cfg
      const file = join(dir, 'auto.json')
      if (!existsSync(file)) return cfg
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [k, v] of Object.entries(raw ?? {})) {
        const c = coerce(k, v)
        if (c !== undefined) cfg[k] = c
      }
    } catch { /* 配置文件坏了不影响运行 */ }
    return cfg
  }

  const saveConfig = (dir, cfg) => {
    try {
      if (!dir) return false
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'auto.json'), JSON.stringify(cfg, null, 2), 'utf8')
      return true
    } catch { return false }
  }

  const cfgFor = (agent) => {
    const key = wsKeyOf(agent)
    if (!configs.has(key)) configs.set(key, loadConfig(memDirOf(agent)))
    return configs.get(key)
  }

  const setConfig = (agent, patch = {}, { persist = true } = {}) => {
    const cfg = cfgFor(agent)
    const applied = {}
    const rejected = []
    for (const [k, v] of Object.entries(patch ?? {})) {
      const c = coerce(k, v)
      if (c === undefined) { rejected.push(k); continue }
      cfg[k] = c
      applied[k] = c
    }
    if (persist && Object.keys(applied).length) saveConfig(memDirOf(agent), cfg)
    return { cfg, applied, rejected }
  }

  /* ── 会话状态 ── */

  const stateOf = (sid) => {
    let s = sessions.get(sid)
    if (!s) {
      s = {
        sid,
        agent: null,
        startedAt: now(),
        lastToolAt: now(),   // 新会话先给一个完整窗口，别刚连上就叫醒
        inFlight: 0,
        busy: false,
        escaping: 0,
        baseYaw: null,
        basePitch: null,
        nextLookAt: 0,
        /** 观察到的附近玩家（给空闲叫醒的文案用） */
        playerObs: [],
        nearPlayers: 0,
        prevPlayerPos: null,
        lastEatAt: 0,
        lastPickupAt: 0,
        /** 自保提醒的限流（这套字段原来叫"逃跑"名 —— 那时候还会自己跑，现在只叫醒 AI） */
        lastAlertAt: 0,
        lastAlertName: null,
        lastAlertLoggedAt: 0,
        /** 最近一次"自己被咬"的时间（`entityHurt` 且挨打的是自己）—— 被攻击的判据 */
        lastHurtAt: 0,
        /** 上一次看到的血量（掉血也算挨打，见 avoid） */
        lastHealth: 20,
        /** 最近一次威胁的位置（挨打却看不到怪时，报给 AI 让它去定位） */
        lastThreatPos: null,
        /** 自保叫醒（被怪贴上来）的限流时间戳 + 有没有挂上 entityHurt */
        lastDangerWakeAt: 0,
        hooked: false,
        /** 憋气（溺水）相关：日志限流 + 濒死时"按住 jump 抬一下"的限流 + 头在水下的起点时刻 + 上一次氧气读数 */
        lastDrownLoggedAt: 0,
        drownJumpAt: 0,
        submergedSince: 0,
        lastAir: null,
        /** 🔴 水下自动救援（2026-10-15 用户点名的"水下寻路"）：限流时间戳 + 正在跑 + 上一次结果。
         *  **绝不偷偷接管** —— 每次跑完都 `agent.steer` 报一条，并记进 stats。 */
        waterRecoverAt: 0,
        waterRecoverBusy: false,
        waterRecoverLast: null,
        lastArmorAt: 0,
        lastWakeAt: 0,
        wakeTimes: [],
        noActionStreak: 0,
        /** 叫醒后"只说话没动手"时补的第二条催促（每次叫醒最多一条） */
        nudgedAt: 0,
        lastError: null,
        lastAction: null,
        stats: { wakes: 0, dangerWakes: 0, alerts: 0, nudges: 0, looks: 0, watches: 0, eats: 0, pickups: 0, escapes: 0, follows: 0, denied: 0, waterRecovers: 0, waterEscapes: 0 },
      }
      sessions.set(sid, s)
    }
    return s
  }

  /** 工具调用开始：重置空闲计时（"AI 在开车"） */
  const noteToolStart = (agentId) => {
    const sid = String(agentId ?? '')
    if (!sid) return
    const s = stateOf(sid)
    s.lastToolAt = now()
    s.inFlight++
    // 🔴 叫醒后只要 AI 真的动了手，退避**当场清零**（不能等下次叫醒才算）：
    //    否则上一轮的 2^n 长间隔会把"AI 已经开始干活"这件事一直挡在门外，退避再也回不来。
    if (s.lastWakeAt > 0 && s.lastToolAt > s.lastWakeAt) s.noActionStreak = 0
    return s
  }

  const noteToolEnd = (agentId) => {
    const sid = String(agentId ?? '')
    if (!sid) return
    const s = stateOf(sid)
    s.lastToolAt = now()
    s.inFlight = Math.max(0, s.inFlight - 1)
  }

  /* ── 反射动作 ── */

  /**
   * 观察附近的玩家：谁在、多远、在动还是站着、手里拿什么、朝哪边看。
   * 每 tick 只读更新一次，空闲叫醒时把这些写进文案 ——
   * 这样 AI 一睁眼就知道"玩家正在干什么"，而不是只知道"附近有人"。
   */
  const observePlayers = (s, sess, cfg, t) => {
    const b = sess?.bot?.bot
    if (!b?.entity?.position) { s.nearPlayers = 0; s.playerObs = []; return }
    const near = playersNear(b, cfg.playerNearRadius)
    s.nearPlayers = near.length
    if (!s.prevPlayerPos) s.prevPlayerPos = new Map()
    const prev = s.prevPlayerPos
    const seen = new Set()
    s.playerObs = near.slice(0, 6).map((p) => {
      const key = p.username
      seen.add(key)
      const old = prev.get(key)
      const moved = old ? Math.hypot(p.position.x - old.x, p.position.y - old.y, p.position.z - old.z) : 0
      prev.set(key, { x: p.position.x, y: p.position.y, z: p.position.z })
      const ent = b.players?.[key]?.entity
      return {
        username: key,
        distance: p.distance,
        moving: moved > 0.12,
        held: ent?.heldItem?.name ?? null,
        facing: facingOf(ent?.yaw),
        y: Math.round(p.position.y),
      }
    })
    for (const k of [...prev.keys()]) if (!seen.has(k)) prev.delete(k)
  }

  /** 环顾：附近有人就盯着他看（看他/她在干什么），没人就在"基础朝向"附近晃 */
  const lookAround = (s, sess, cfg, t) => {
    if (t < s.nextLookAt) return
    const b = sess?.bot?.bot
    const e = b?.entity
    if (!e?.position) return
    const near = playersNear(b, cfg.watchPlayers ? cfg.playerNearRadius : 14)
    if (near.length && (cfg.watchPlayers || rng() < 0.45)) {
      s.nextLookAt = t + (cfg.watchPlayers ? 2000 : randBetween(rng, 2500, 6000))
      const p = cfg.watchPlayers ? near[0] : near[Math.min(near.length - 1, Math.floor(rng() * near.length))]
      try { b.lookAt?.(mkPos(p.position.x, p.position.y + 1.55, p.position.z), false)?.catch?.(() => {}) } catch { return }
      s.stats.looks++
      if (cfg.watchPlayers) s.stats.watches++
      s.lastAction = `看着 ${p.username}`
      return
    }
    s.nextLookAt = t + randBetween(rng, 2500, 6000)
    const by = Number.isFinite(s.baseYaw) ? s.baseYaw : e.yaw
    const bp = Number.isFinite(s.basePitch) ? s.basePitch : e.pitch
    const yaw = by + randBetween(rng, -0.5, 0.5)
    const pitch = clamp(bp + randBetween(rng, -0.28, 0.28), -1.0, 0.55)
    try { b.look?.(yaw, pitch, false)?.catch?.(() => {}) } catch { return }
    s.stats.looks++
    s.lastAction = '环顾'
  }

  /**
   * 饿了自动吃 —— 交给现成的 **mineflayer-auto-eat**（它自己挑食物、吃完换回原来手上的东西）。
   *
   * 这里**不再手写**"翻背包找 FOOD → equip → consume"那一套（用户 2026-10-06 要求用现成项目）。
   * 本函数只负责：按开关 enable/disable、把插件的事件记进统计。插件没挂上就什么都不做。
   */
  const autoEat = async (s, sess, cfg, t) => {
    const b = sess?.bot?.bot
    const ae = b?.autoEat
    if (!ae?.enableAuto) return
    if (!s.eatHooked) {
      s.eatHooked = true
      try {
        b.on?.('eatFinish', () => { s.stats.eats++; s.lastAction = '吃饱了' })
        b.on?.('eatFail', (e) => { s.lastError = `吃饭失败：${e?.message ?? e}` })
      } catch { /* 假 bot 没有 on */ }
    }
    try {
      if (cfg.autoEat && !ae.enabled) { ae.enableAuto(); s.lastAction = '自动吃：开' }
      else if (!cfg.autoEat && ae.enabled) { ae.disableAuto(); s.lastAction = '自动吃：关' }
    } catch (e) { s.lastError = `自动吃开关失败：${e?.message ?? e}` }
  }

  /**
   * 停掉还在后台跑的 mineflayer-collectblock 任务，并松掉控制位。
   *
   * 🔴 为什么必须做（2026-10-06 实机定位，用户原话「现在机器人走不了了」）：
   *   `withTimeout` 只是让 await 提前 reject，**不会取消底层的 collect 任务**。
   *   超时后它继续在后台按着 `forward`、占着 pathfinder 反复寻路 ⇒ 机器人"物理冻住"
   *   （`mc_diag`：`forward:true` 而 `velocity` 全 0、位置一格不动，之后的 `mc_move`
   *   全部失败，只有重连才恢复）。`cancelTask()` 内部就是 `pathfinder.stop()` + 等
   *   `collectBlock_finished`，正好让采集循环停下来。core.mjs 的 `#cancelCollect` 同理。
   */
  const cancelCollect = async (b) => {
    try {
      const t = b?.collectBlock?.targets
      if (!t || t.empty) return
      if (typeof b.collectBlock.cancelTask === 'function') {
        await Promise.race([
          Promise.resolve(b.collectBlock.cancelTask()).catch(() => {}),
          new Promise((r) => setTimeout(r, 1500)),
        ])
      }
    } catch {}
    try { b?.pathfinder?.stop?.() } catch {}
    try {
      for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) b?.setControlState?.(k, false)
    } catch {}
  }

  /* ─────────────── 任务层桥（2026-10-14 任务驱动第三步） ───────────────
   * 用户给的三层分工：**自主层**（本文件，决定"什么时候该看一眼"）/ **任务层**（`src\task-runner.mjs`
   * 的目标与步骤台账）/ **动作层**（`src\core.mjs` + 工具）。
   *
   * 这里只做**桥**：读台账、把"手里还有事"写进叫醒文案、急事时先停手。
   * 🔴 不自己推任务（推一步是 `mc_task {action:"run"}` 或模型的事），也不绕过 core 下发动作。
   */

  /** 会话的任务台账（McBot 的薄包装）；这个 bot 没有台账就 null。 */
  const ledgerOf = (sess) => {
    const bot = sess?.bot
    return bot && typeof bot.taskList === 'function' ? bot : null
  }

  /**
   * 最近一条还没做完的事（进行中/等条件/暂停/卡住）。
   * 返回：任务对象 / `null`（台账确实没有）/ **`undefined`（台账读不出来）**。
   * 🔴 必须把"没有"和"读不出来"分开 —— 混成 null 就会在叫醒文案里对 AI 说
   *    "台账上没有没做完的事"这句假话（2026-10-14 冒烟抓到的）。
   */
  const activeTaskOf = (sess) => {
    try {
      const bot = ledgerOf(sess)
      if (!bot) return null
      const list = bot.taskList({ limit: 10, all: false }) ?? []   // 按 updatedAt 倒序
      return list[0] ?? null
    } catch { return undefined }
  }

  /** 一条任务的"一行话"：`t-… · dig · oak_log · 6/16个 · 进行中（第 2/4 步 做木板）` */
  const taskBriefLine = (t) => {
    if (!t) return ''
    const p = t.progress ?? {}
    const prog = p.total == null
      ? `${p.done ?? 0}${p.unit ?? ''}`
      : `${p.done ?? 0}/${p.total}${p.unit ?? ''}`
    const st = {
      running: '进行中', waiting: '在等条件', paused: '暂停了（断过线）',
      blocked: '卡住了', done: '做完了', cancelled: '已取消',
    }[t.status] ?? t.status
    return `${t.taskId} · ${t.kind} · ${t.goal ?? t.params?.item ?? ''} · ${prog} · ${st}`
      + (t.step ? `（${t.step}）` : '')
      + (t.loopDetected ? ' ⚠️ 反复失败' : '')
      + (t.lastError ? ` ｜上次：${String(t.lastError).slice(0, 60)}` : '')
  }

  /**
   * 自保"先停手"：真的把手里那件事停下 —— `interruptMove()`（推移动号 + 停采集 + 松控制位），
   * 并把台账里"正在做"的那一步放回"还没做"。
   *
   * 为什么必须真停：`mc_dig` / `mc_move` 的超时只是"我们不等了"，底层**还在跑**
   * （`withTimeout` 不取消 promise），不停就变成"AI 在决定撤，机器人还按着 forward 往前走"。
   *
   * 🔴 只停手，**不跑、不还手**（用户 2026-10-06 定的：自保层不替 AI 做决策）。
   * 返回一句人话（停了什么）或 null（本来就没在干什么）。
   */
  const stopWork = (s, sess) => {
    const bot = sess?.bot
    const b = bot?.bot
    if (!bot || !b) return null
    const moving = Boolean(b?.pathfinder?.goal)
    if (!(s.busy === true || s.inFlight > 0 || moving)) return null
    try { Promise.resolve(bot.interruptMove?.('自保：先停手')).catch(() => {}) } catch { /* 忽略 */ }
    s.busy = false
    let stepTxt = ''
    try {
      const t = activeTaskOf(sess)
      const cur = (t?.steps ?? []).find((x) => x.status === 'running') ?? null
      if (t && cur) {
        bot.taskStep?.({ taskId: t.taskId, step: cur.id, status: 'pending', why: '自保叫醒时中断了这一步' })
        stepTxt = `（台账里"${cur.id}"那一步已放回"还没做"）`
      }
    } catch { /* 忽略 */ }
    return stepTxt
  }

  /**
   * 反射层的写动作也走**统一动作调度器**（用户 2026-10-14 设计第一轮：
   * "自动拾取、自动换装备通过相同调度器执行，不能绕开锁直接改状态"）。
   *
   * 没有调度器（老 core / 独立脚本）就照旧直接跑；`enforce` 模式下被占着就**这轮不做** ——
   * 反射层做的是后台活（`priority: background`），被任务或用户占着就让位，不跟它们抢。
   *
   * @returns {Promise<'done'|'busy'>} `'busy'` = 被挡住了，调用方直接跳过这一轮
   */
  const viaScheduler = async (sess, name, resources, run) => {
    const sch = sess?.bot?.actionScheduler?.()
    if (!sch) { await run(); return 'done' }
    const r = await sch.run({ name, owner: 'auto', resources, priority: 'background', execute: run })
    if (r.status === 'busy') return 'busy'
    if (r.status === 'failed') throw r.error
    return 'done'
  }

  /**
   * 走过去捡最近的掉落物 —— 交给现成的 **mineflayer-collectblock**（它会走到跟前把东西收进背包）。
   *
   * 不再手写"walkTo 到掉落物坐标"（那条路是 `mc_move` 的老逻辑）。插件没挂上就不动。
   */
  const pickup = async (s, sess, cfg, t) => {
    if (t - s.lastPickupAt < 6000) return
    const b = sess?.bot?.bot
    const me = b?.entity?.position
    if (!me) return
    if (typeof b?.collectBlock?.collect !== 'function') return
    let drops = []
    try {
      drops = Object.values(b?.entities ?? {})
        .filter((e) => e !== b.entity && e?.position && isDrop(e)
          && e.position.distanceTo(me) <= 6 && Math.abs(e.position.y - me.y) <= 3)
        .sort((a, c) => a.position.distanceTo(me) - c.position.distanceTo(me))
    } catch { return }
    if (!drops.length) return
    if (playersNear(b, 1.8).length) return          // 别从人身上踩过去
    s.lastPickupAt = t
    s.busy = true
    /* 顺手把"捡到东西"记进台账（用户 2026-10-14 任务驱动第三步："发现掉落物 → 判断是否值得拾取，
     * 并更新当前任务"）。只对**这条任务要的那件东西**记，数量从背包差算 —— 算不出就不记
     * （宁可不说，也不编一个数）。 */
    let pickBot = null
    let pickTask = null
    let pickItem = null
    let pickBefore = null
    try {
      pickBot = ledgerOf(sess)
      pickTask = activeTaskOf(sess)
      pickItem = pickTask?.goalSpec?.item ?? pickTask?.params?.item ?? null
      if (pickBot && pickTask && pickItem) pickBefore = pickBot.countOf(pickItem)
    } catch { pickBefore = null }
    try {
      /* 统一动作调度器（阶段 P0：只记账）：反射层的自动拾取也是"占 interaction + movement"的写动作，
       * 走同一条路 —— 用户第一轮要求"自动拾取 / 自动换装备不能绕开锁直接改状态"。
       * 没接上调度器（老 core / 独立脚本）就照旧直接跑。 */
      const st = await viaScheduler(sess, 'auto:pickup', ['interaction', 'movement'], async () => {
        await withTimeout(b.collectBlock.collect(drops[0], { ignoreNoPath: true }), 8000, '捡东西')
      })
      if (st === 'busy') return                       // enforce 模式下被占着：这轮不捡，让位给任务
      s.stats.pickups++
      s.lastAction = '捡掉落物'
      if (pickBefore != null && pickItem) {
        const after = pickBot.countOf(pickItem)
        if (Number.isFinite(after) && after > pickBefore) {
          pickBot.taskNote?.({ taskId: pickTask.taskId, text: `捡掉落物：${pickItem} ${pickBefore} → ${after}` })
        }
      }
    } catch (e) {
      s.lastError = `捡东西失败：${e?.message ?? e}`
    } finally {
      // 🔴 超时/报错都**不代表底层采集停了** —— 不显式 cancel，它会继续按着 forward
      //    在后台跑，机器人当场"物理冻住"。详见 cancelCollect 的注释。
      await cancelCollect(b)
      s.busy = false
    }
  }

  /**
   * 被怪打/被怪贴上来的"急事"叫醒：**不受空闲间隔和退避限制**（只受 DANGER_WAKE_GAP_MS
   * 和每小时配额），因为这时候不动手会掉血甚至死。
   *
   * 🔴 反射层**不自己跑、也不还手**（用户 2026-10-06："既然选择可以获取怪物位置，把受到攻击自动跑离开去掉"；
   *    随后"反射层兜底还手：judgeFight() 不需要了"）：它不抢控制权、不替 AI 做任何决策，只把
   *    "谁在哪、多少血、离我多远"报上去，还手 / 撤 / 躲 / 垒墙全由 AI 定（要位置就用 mc_observe 的"程序检测到"，数据同源）。
   *
   * 返回 'steered'（已叫醒）/ 'throttled'（有人值守但刚叫过，听 AI 的）/ 'none'（**没人值守**，
   * 调用方只记档、不做别的 —— 反射层已经没有兜底动作了）。
   */
  const wakeForDanger = (s, sess, cfg, t, info) => {
    const agent = s.agent
    if (!agent || typeof agent.steer !== 'function') return 'none'
    const { threat = null, foes = [], health = 20, ranged = false, hurt = false, blind = false,
      drown = false, air = null, submerged = false, subSec = 0, gap = DANGER_WAKE_GAP_MS,
      waterRecover = false } = info ?? {}
    if (t - num(s.lastDangerWakeAt, 0) < gap) return 'throttled'
    s.wakeTimes = s.wakeTimes.filter((x) => t - x < 3_600_000)
    if (s.wakeTimes.length >= cfg.idleWakeMaxPerHour) { s.stats.denied++; return 'throttled' }
    const b = sess?.bot?.bot
    const me = b?.entity?.position
    const held = String(b?.heldItem?.name ?? '空手')
    const L = []
    /* 自保第一步：**先停下手里的事**（用户 2026-10-14 任务驱动第三步："先停止采集，再由 AI
     * 决定逃跑、战斗还是继续任务"）。只停手 —— 不跑、不还手。 */
    const stopped = cfg.dangerStopWork !== false ? stopWork(s, sess) : null
    const stopLine = stopped === null
      ? ''
      : `⏸ 我已经先把手里的活停下了（寻路 / 采集 / 控制位都松开了${stopped}）—— 现在你说了算。`
    if (drown) {
      /* 憋气（溺水）：**必须和"被打"分开报**。以前这种"掉血但看不到怪"会被当成远程怪隔墙射，
       * AI 于是跑去找一个不存在的敌人，人还在水里继续沉 —— 用户 2026-10-07："现在容易被淹死"。 */
      L.push(air == null
        ? `【自保：我在水底下（憋气）｜血 ${Math.round(health)}/20】`
        : `【自保：我在水里快憋死了｜氧气 ${air}/20｜血 ${Math.round(health)}/20】`)
      L.push('')
      L.push(air == null
        ? '**多半不是被打** —— 是**憋气**。这会儿读不到氧气数字（`bot.oxygenLevel` 要头入水、'
          + `服务端发 air_supply 之后才有），我按"头在水下"判断：已经在下面 ${subSec || '几'} 秒了。水底待够 15 秒就开始掉血。`
        : '**这不是被打** —— 是**憋气**（氧气掉到 0 之后才开始掉血），别去找什么远程怪。')
      if (stopLine) L.push(stopLine)
      if (air == null && submerged) {
        L.push('（也可能水里有怪：溺尸/守卫者/鱿鱼群。要是想确认，先 `mc_observe {"distance":16}` 看"程序检测到"那段。）')
      }
      L.push(`我：血 ${Math.round(health)}/20，`
        + (air == null ? `氧气读不到${submerged ? '（头在水下）' : ''}` : `氧气 ${air}/20`)
        + (subSec ? `，头在水下 ${subSec} 秒` : '')
        + `，在 ${me ? `${Math.round(me.x)} ${Math.round(me.y)} ${Math.round(me.z)}` : '?'}`)
      L.push('')
      L.push(waterRecover
        ? '**下一步你来定**（我**同时在试着自己找出口**：局部扫一圈 → 挑一个能换气 / 能上岸的目标 → 走不通就换下一条；'
          + '**找到没找到都会再给你发一条**，说清我为什么动、往哪游、结果如何 —— 我不会偷偷接管）：'
        : '**下一步你来定**（我这次只在水里按了一下 jump 想把你抬上来，没横向跑、也没还手）：')
      L.push('· 上浮换气：`mc_move {"mode":"swim"}`（按住 jump 游上来，一次最多 3 秒；没上来就再叫一次同一个参数）')
      L.push('· 出水之后往岸上走：`mc_move` 到最近的干燥方块；不知道岸在哪就先 `mc_scan {"radius":16}` 看一圈')
      L.push('· 水/岩浆是**流体，挖不掉** —— 别 `mc_dig` 水（白花一次调用）')
      L.push('· 血少（< 8）就先浮上来换气、再吃/躲；别在水下跟怪纠缠')
      L.push('选一个**直接做**，不用问我。')
    } else {
      L.push(hurt
        ? `【自保：我刚挨了打｜血 ${Math.round(health)}/20】`
        : `【自保：${threat?.name ?? '有怪'} 贴上来了｜血 ${Math.round(health)}/20】`)
      L.push('')
      if (blind) {
        L.push(`威胁：**看不到怪**（${RANGED_NEAR_RADIUS} 格内没有能打到我的敌对实体）—— 多半是远程怪隔着墙、或者站得很远在射我。`)
        if (b?.entity?.isInWater || submergedIn(b, b?.entity)) L.push('（注意：**我现在在水里** —— 掉血也可能是**憋气**（头在水下），先看 `mc_status` 里"在水里"那行）')
        const lp = s.lastThreatPos
        if (lp) L.push(`（上次看到怪在 ${Math.round(lp.x)} ${Math.round(lp.y)} ${Math.round(lp.z)} 附近）`)
        L.push('· 先 `mc_observe {"distance":48}` 看"程序检测到"那段找它在哪（给坐标/距离/血量，隔墙也能定位）；'
          + '定位到了再决定是绕过去打、还是往反方向走。')
      } else {
        // 带上坐标：AI 现在能拿到怪的位置，报数比只说"几格外"有用得多
        const list = foes.slice(0, 4)
          .map((f) => {
            const q = f.entity?.position
            const at = q ? `(${Math.round(q.x)}, ${Math.round(q.y)}, ${Math.round(q.z)})` : '（坐标未知）'
            return `${f.name} ${f.distance.toFixed(0)} 格 ${at}${RANGED.test(f.name) ? '（远程）' : ''}`
          })
          .join('、')
        L.push(`威胁：${list}${foes.length > 4 ? ` 等 ${foes.length} 个` : ''}`)
      }
      L.push(`我：血 ${Math.round(health)}/20，手上 ${held}，在 ${me ? `${Math.round(me.x)} ${Math.round(me.y)} ${Math.round(me.z)}` : '?'}`)
      L.push('')
      if (stopLine) L.push(stopLine)
      L.push('**下一步你来定**（我这次**没有自己跑、也没还手**'
        + (stopLine ? '，只把手里那件事停了' : '、也没打断你手上的动作')
        + ' —— 打、撤、躲、垒墙都由你定）：')
      if (ranged) {
        L.push('· 远程怪**要看得见你才打得到你**：`mc_build` 在它和你之间垒两格方块挡视线，或钻到墙后/树后/坑里；'
          + '血够（≥16）也可以贴上去打（贴近了它反而不好射）。')
      }
      L.push(`· 还手：\`mc_act {"mode":"attack","who":"${threat?.name ?? '怪名'}"}\``
        + '（血 < 14、苦力怕/女巫/烈焰人、两只以上 → 别打，接着撤）')
      L.push('· 继续撤：`mc_move` 到更远的安全点；旁边有玩家就跑过去（`mc_act {"mode":"toward","who":"玩家名"}`）')
      L.push('· 看不清就先 `mc_observe {"distance":48}` 看"程序检测到"那段（坐标/距离/血量，隔墙也能定位），再决定。')
      L.push('选一个**直接做**，不用问我。')
    }
    try {
      try { sess.interruptWait?.('danger') } catch { /* 打断等待失败不影响注入 */ }
      agent.steer(userMessage({
        content: [{ type: 'text', text: L.join('\n') }],
        source: {
          kind: 'plugin:mcp-mc-agent', form: 'notice',
          summary: drown
            ? `MC 自保：快淹死了（${air == null ? '头在水下' : `氧气 ${air}/20`}）`
            : `MC 自保：${blind ? '被远程打' : threat?.name ?? '有怪'}`,
        },
      }))
      s.lastDangerWakeAt = t
      s.lastWakeAt = t
      s.nudgedAt = 0
      s.wakeTimes.push(t)
      s.stats.dangerWakes++
      logLine(drown
        ? `mc_auto：在水里憋气（${air == null ? `头在水下 ${subSec || '?'} 秒` : `氧气 ${air}/20`}，血 ${Math.round(health)}/20）→ 已叫醒 AI 上浮`
        : `mc_auto：${blind ? '挨了打但看不到怪' : `${threat?.name}${ranged ? '（远程）' : ''} 贴上来`}`
          + ` → 已叫醒 AI 定策略（血 ${Math.round(health)}/20）`)
      return 'steered'
    } catch (e) {
      s.stats.denied++
      s.lastError = `自保叫醒失败：${e?.message ?? e}`
      return 'throttled'
    }
  }

  /**
   * 🔴 用户 2026-10-15 点名的"水下寻路"：**自动接管，但绝不偷偷接管**。
   *
   * 反射层发现"我在水里快憋死了"时，除了叫醒 AI，还会**自己去搜一个出口、走一条路线**：
   * `recoverFromWater` 负责只读扫描 + 分层 BFS 挑出口（干燥落脚点 > 空气口袋 > 可通行水道）、
   * 选路线、**复核进度**（不能仅凭移动函数返回成功就恢复原任务）。
   * **执行仍然走现有接口**（`bot.walkTo` / `bot.swimUp`）—— 用户："实际移动仍通过现有接口执行，
   * 避免另起一套按键控制、移动代次或资源锁"。并发安全靠现有的**移动代次**（`_moveGen`）：
   * AI 随后自己叫一次 `mc_move` 会把代次顶掉，这边在飞的路线自己会让位。
   *
   * 走完**无论成没成**都给 AI 发一条 `agent.steer`，说清"我为什么动了、往哪游、结果如何" ——
   * 用户原话（问"这个会不会遇到，反射层执行，AI 不知道的情况"）就是这条要求。
   *
   * @returns {boolean} 这次有没有真的启动（用来在叫醒文案里说实话）
   */
  const startWaterRecover = (s, sess, cfg, t, info) => {
    if (s.waterRecoverBusy) return false
    if (t - num(s.waterRecoverAt, 0) < WATER_RECOVER_GAP_MS) return false
    const bot = sess?.bot
    if (!bot || typeof bot.walkTo !== 'function') return false
    s.waterRecoverBusy = true
    s.waterRecoverAt = t
    const trigger = info?.trigger ?? null
    void (async () => {
      let res = null
      try {
        res = await withTimeout(
          recoverFromWater(bot, {}, {
            walkTo: (self, p, o) => bot.walkTo({ x: p.x, y: p.y, z: p.z }, o ?? {}),
            swimUp: (self, o) => bot.swimUp(o ?? {}),
          }),
          WATER_RECOVER_MAX_MS, '水下自救',
        )
      } catch (e) {
        res = { ok: false, reason: 'error', note: `自救过程出错：${e?.message ?? e}`, tried: [], log: [] }
      }
      s.waterRecoverBusy = false
      s.waterRecoverLast = { ...(res ?? {}), at: t }
      s.stats.waterRecovers++
      if (res?.ok) s.stats.waterEscapes++
      try {
        logLine(`mc_auto：水下自救 ${res?.ok ? '出来了' : '没出来'}（${res?.reason ?? '?'}）—— ${res?.note ?? ''}`)
      } catch { /* 日志失败不影响 */ }
      const agent = s.agent
      if (!agent || typeof agent.steer !== 'function') return
      try {
        agent.steer(userMessage({
          content: [{ type: 'text', text: waterReportText(res, trigger) }],
          source: {
            kind: 'plugin:mcp-mc-agent',
            form: 'notice',
            summary: res?.ok ? 'MC 自保：我自己从水里出来了一趟' : 'MC 自保：在水里没找到出口',
          },
        }))
      } catch (e) { s.lastError = `水下自救通知失败：${e?.message ?? e}` }
    })()
    return true
  }

  /** 危险回避：踩到岩浆/火/仙人掌 → 后退（这个还是要动的，站里面会死）；
   *  有怪/挨打 → **只叫醒 AI**（报怪的位置、血量、距离），反射层不自己跑、不抢控制权。
   *  用户 2026-10-06："既然选择可以获取怪物位置，把受到攻击自动跑离开去掉。" */
  const avoid = (s, sess, cfg, t) => {
    /* 🔴 2026-10-08 审计：以前这里是 `if (s.busy) return` —— `busy` 由 `pickup`（最长 8 秒）与
     *   `follow`（最长 3.4 秒）置位，那 8 秒里岩浆/挨打/憋气**全都不检测**，AI 一边挨打一边走 6 格
     *   去捡东西时反射层一声不吭。`busy` 只该挡住"反射层替你按控制位"，不该挡住"看一眼并叫你"，
     *   所以现在只把**动作**（按 back/jump）关掉，检测与 `wakeForDanger` 照跑。 */
    const busy = Boolean(s.busy)
    const b = sess?.bot?.bot
    const e = b?.entity
    if (!e?.position) return
    const p = e.position
    const here = [blockNameAt(b, p), blockNameAt(b, p.offset(0, 1, 0)), blockNameAt(b, p.offset(0, -1, 0))]
    const bad = here.find((n) => n && DANGER.test(n))
    if (bad) {
      // 只在"刚开始脱离"时计数 + 记日志：危险没消失时每 tick 都按后退，
      // 但不要每 tick 都 +1（否则统计里 escapes 会被同一滩岩浆刷爆）
      if (s.escaping === 0) {
        s.stats.escapes++
        logLine(`mc_auto：${bad} 就在脚下/身上，${busy ? '先提醒 AI（我这一步还没跑完，不抢控制位）' : '后退脱离'}`)
      }
      s.escaping = Math.max(s.escaping, 8)
    }
    if (s.escaping > 0) {
      s.escaping--
      if (busy) return              // 忙着就不抢控制位（但上面的检测与日志照样做）
      /* 🔴 2026-10-08 审计⑨：任何一次移动收尾都会 `#releaseControls()` 把七个控制位全松掉 ——
       *    直接按 back 会被"顺手"松掉（脚边就是岩浆也照松）。用 `holdControl()` 声明**租约**：
       *    没过期谁都别松，到期它自己松。没有这个 API（老版本/假 bot）就退回原来的写法。 */
      holdCtl(sess, 'back', 320, () => { try { b.setControlState('back', false) } catch { /* 忽略 */ } })
      if (/lava|fire/.test(bad ?? '')) {
        holdCtl(sess, 'jump', 200, () => { try { b.setControlState('jump', false) } catch { /* 忽略 */ } })
      }
      s.lastAction = '脱离危险'
      return
    }
    if (t - s.lastAlertAt < 5000) return
    let health = 20
    try { health = num(sess.bot?.status?.()?.health, 20) } catch { return }
    // 掉血 = 挨打了（entityHurt 万一没挂上，这条兜底；远程怪的箭也是这么发现的）
    if (num(s.lastHealth, health) - health >= 0.5) s.lastHurtAt = t
    s.lastHealth = health
    const hurtRecently = t - num(s.lastHurtAt, 0) < 4000
    /* 憋气（溺水）：氧气掉到 0 之后开始掉血 —— 表现出来和"被远程怪隔墙射"一模一样
     * （掉血、22 格内看不到怪），所以**必须在水里先判一次**，否则 AI 会被派去找一个不存在的敌人，
     * 人还泡在水里继续沉（用户 2026-10-07："现在容易被淹死"）。
     * 🔴 判据两条一起看：氧气读数（`bot.oxygenLevel`）**头在水面上时是 null**（mineflayer 只在收到
     *    `air_supply` 元数据时才设它，实机验证：水面 null、头入水 7/20），所以主判据是 `submerged`
     *    （眼睛那格是液体 = 头在水下）：头在水下 + 掉血 ⇒ 立刻出声，头在水下超过 DROWN_SUBMERGE_MS ⇒ 也出声。
     *    氧气读数有就一起报，没有就照实说读不到。 */
    /* 🔴 2026-10-08 实机：这里以前 `inWater = Boolean(e.isInWater)` —— 而泡在水柱里它读出来是
     *    undefined ⇒ 整个憋气分支（下面那条 `if (inWater && …)`）直接不执行，AI 淹死都不出声。
     *    现在 `inWater` 以"头在水下"为主判据，`isInWater` 只当补充。 */
    const submerged = submergedIn(b, e)
    const inWater = submerged || Boolean(e?.isInWater)
    const air = Number.isFinite(b?.oxygenLevel) ? b.oxygenLevel : null
    if (submerged) { if (!s.submergedSince) s.submergedSince = t } else s.submergedSince = 0
    const subMs = s.submergedSince ? t - s.submergedSince : 0
    const subSec = Math.round(subMs / 1000)
    /* 🔴 氧气读数可能是**旧的**：mineflayer 不在客户端让它自己往下走，只在服务端发 `air_supply`
     * 时才更新 —— 所以潜过水之后站在浅水里，`air` 可能还是 0/-1（实机 2026-10-07 就这样误报过两次）。
     * 因此三条判据都要求 `submerged`（头真在水下）或者"读数正在往下掉"（真的在憋气）。 */
    const draining = air != null && s.lastAir != null && air < s.lastAir
    s.lastAir = air
    const byAir = air != null && (submerged || draining) && (air <= DROWN_AIR || (air < 12 && hurtRecently))
    const byHurt = submerged && hurtRecently
    const byTime = submerged && subMs >= DROWN_SUBMERGE_MS
    if (inWater && (byAir || byHurt || byTime)) {
      s.lastAlertAt = t
      // 濒死（氧气 ≤ 4 / 头在水下且已经在掉血或超过 12 秒）时**只按住 jump 抬一下**：
      // 和"脚下是岩浆/火"那条同类（站里面会死），不横向移动、不抢 AI 的决策；出水路线仍由 AI 定。
      const desperate = (air != null && air <= 4) || (submerged && (hurtRecently || subSec >= 12))
      if (desperate && t - num(s.drownJumpAt, 0) > 1_500) {
        s.drownJumpAt = t
        holdCtl(sess, 'jump', 600, () => { try { b.setControlState('jump', false) } catch { /* 忽略 */ } })
      }
      if (t - num(s.lastDrownLoggedAt, 0) > 10_000) {
        s.lastDrownLoggedAt = t
        logLine(`mc_auto：在水里憋气（${air == null ? `头在水下 ${subSec} 秒` : `氧气 ${air}/20`}，血 ${Math.round(health)}/20）→ 叫醒 AI 上浮`)
      }
      s.stats.alerts++
      // 急事（气快没了 / 已经在掉血）⇒ 6 秒就能再提醒；只是"头在水下有点久了" ⇒ 20 秒一次，别刷屏
      const urgent = hurtRecently || byHurt || (air != null && air <= DROWN_AIR)
      /* 🔴 用户点名的"水下寻路"：叫醒 AI 的同时，反射层**自己也去搜出口、走一条路线**
       *    （自动接管，但走完一定 `agent.steer` 报一条 —— 绝不偷偷接管）。 */
      const recovering = startWaterRecover(s, sess, cfg, t, {
        trigger: {
          why: (air != null && air <= DROWN_AIR) ? 'oxygen-low'
            : hurtRecently ? 'taking-damage'
              : draining ? 'oxygen-dropping' : 'no-progress',
          detail: air == null ? `头在水下 ${subSec || '?'} 秒` : `氧气 ${air}/20`,
        },
      })
      wakeForDanger(s, sess, cfg, t, {
        health, hurt: hurtRecently, drown: true, air, submerged, subSec, foes: [],
        gap: urgent ? DROWN_WAKE_GAP_MS : DROWN_SUBMERGE_GAP_MS,
        waterRecover: recovering,
      })
      return
    }
    /**
     * 威胁清单：
     *   · 8 格内的任何敌对生物 —— 都算。
     *   · 远程怪（骷髅/掠夺者/女巫…）到 RANGED_NEAR_RADIUS 格 —— 它们从十几格外就开火，
     *     但**得看得见我才算**（中间有墙/树就暂时不算，否则隔墙的骷髅会一直神经质地报警）。
     */
    const foes = hostilesNear(b, RANGED_NEAR_RADIUS).filter((f) => {
      if (f.distance <= 8) return true
      if (!RANGED.test(f.name)) return false
      return !losBlocked(b, eyeOf(f.entity.position), eyeOf(e.position))
    })
    const threat = foes[0] ?? null

    // 挨了打却看不到怪（隔墙/超远射）：不自己动，把"上次看到它在哪"报给 AI 让它定位
    if (!threat) {
      if (!hurtRecently) return
      s.lastAlertAt = t
      if (t - num(s.lastAlertLoggedAt, 0) > 30_000) {
        s.lastAlertLoggedAt = t
        logLine(`mc_auto：挨了打但 ${RANGED_NEAR_RADIUS} 格内看不到怪（多半是远程/隔墙）→ 叫醒 AI 定位`)
      }
      s.stats.alerts++
      wakeForDanger(s, sess, cfg, t, { health, hurt: true, blind: true, foes: [] })
      return
    }

    const ranged = RANGED.test(threat.name)
    // AI 正在动手、怪也没贴上来（没挨打）→ 不打扰它，等它这一轮跑完
    if (s.inFlight > 0 && !(hurtRecently || threat.distance <= URGENT_RADIUS)) return

    const tp = threat.entity.position
    s.lastThreatPos = { x: tp.x, y: tp.y, z: tp.z }
    s.lastAlertAt = t
    // 日志别每 5 秒刷一遍：同一个怪 30 秒内只记一次
    if (s.lastAlertName !== threat.name || t - num(s.lastAlertLoggedAt, 0) > 30_000) {
      s.lastAlertName = threat.name
      s.lastAlertLoggedAt = t
      logLine(`mc_auto：${threat.name}${ranged ? '（远程）' : ''} ${threat.distance.toFixed(1)} 格，血 ${health}/20 → 叫醒 AI 定策略`)
    }
    s.stats.alerts++
    // 叫醒 AI，剩下（还手/继续撤/躲起来/垒墙）全由它定。
    // 🔴 反射层**永不还手**（用户 2026-10-06："反射层兜底还手：judgeFight() 不需要了"）：
    //    原来这里还有一段"叫不醒 AI 就自己上"的兜底（judgeFight → wearArmor → holdWeapon →
    //    sess.bot.attack），连判断函数一起删掉了。没人值守时（没有 steer 通道）就只记档 ——
    //    AI 不在，自己动手更容易白送，而且它下次上线能看到 mc_observe "程序检测到"里的怪。
    wakeForDanger(s, sess, cfg, t, { threat, foes, health, ranged, hurt: hurtRecently })
  }

  /** 跟随指定玩家（反射层里优先级最高的"移动"） */
  const follow = (s, sess, cfg, t) => {
    const b = sess?.bot?.bot
    const me = b?.entity?.position
    if (!me || !cfg.follow) return false
    const near = playersNear(b, 64)
    const target = near.find((p) => p.username.toLowerCase().includes(String(cfg.follow).toLowerCase()))
    if (!target) return false
    if (target.distance <= cfg.followDistance) return true
    s.busy = true
    withTimeout(sess.bot.walkTo({ x: target.position.x, y: target.position.y, z: target.position.z },
      { arrive: cfg.followDistance, budget: WALK_BUDGET }), WALK_BUDGET + 800, '跟随')
      .then(() => { s.stats.follows++; s.lastAction = `跟上 ${target.username}` })
      .catch((err) => { s.lastError = `跟随失败：${err?.message ?? err}` })
      .finally(() => { s.busy = false })
    return true
  }

  /* ── 空闲决策层 ── */

  const effectiveIdleMs = (s, cfg) => {
    // 附近有人 → 用更短的间隔（取两者较小值，永远比没人在时更勤快地看着）
    const sec = s.nearPlayers > 0 ? Math.min(cfg.idleWakeNearPlayerSec, cfg.idleWakeSec) : cfg.idleWakeSec
    const base = Math.max(MIN_IDLE_SEC, sec) * 1000
    if (!cfg.idleWakeBackoff) return base
    return Math.min(base * 2 ** Math.min(s.noActionStreak, 5), MAX_BACKOFF_MS)
  }

  /**
   * 距下次该叫醒还有多久（毫秒，0 = 现在就该叫）。
   * 🔴 两个条件都要满足：**距上次工具调用**够久 **且** **距上次叫醒**够久。
   *    只算前者的话，"叫醒了但 AI 什么都没做"时下一个 tick 就又满足条件 ⇒ 退避形同虚设，
   *    实际会退化成"每 minIdleGapSec 叫一次"（整夜烧 token 的元凶）。
   */
  const wakeWaitMs = (s, cfg, t) => {
    const eff = effectiveIdleMs(s, cfg)
    const gap = Math.max(eff, Math.max(MIN_IDLE_SEC, cfg.minIdleGapSec) * 1000)
    const dueByTool = s.lastToolAt + eff
    const dueByWake = s.lastWakeAt ? s.lastWakeAt + gap : 0
    return Math.max(0, Math.max(dueByTool, dueByWake) - t)
  }

  /** 给空闲简报加一行"脚边长什么样"（mc_map 第二轮：让自主层也吃结构化地图数据）。
   *
   *  **只在叫醒 AI 时算一次**，半径压到 8 格 —— `floorMapOf()` 是逐列扫描（默认半径 32 ⇒ 4000+ 列），
   *  每 tick 跑一次会拖慢主循环。这里要的是"我大概站在什么样的地方"，不是精确地图。
   *  拿不到世界（没连上 / 假 bot / 区块没加载）就什么都不加，绝不因为"想多写一行"把叫醒搞崩。 */
  const NAV_RADIUS = 8
  const navLineOf = (sess) => {
    try {
      const b = sess?.bot?.bot
      if (!b?.entity?.position) return ''
      const map = floorMapOf(b, { radius: NAV_RADIUS })
      const c = map?.counts
      if (!c) return ''
      const cells = (Number(map.radius) * 2) ** 2
      const pct = cells ? Math.round(((c.walkable ?? 0) / cells) * 100) : 0
      const bits = [`可站 ${c.walkable ?? 0}/${cells} 格（${pct}%）`]
      if (c.drop) bits.push(`会掉下去 ${c.drop}`)
      if (c.liquid) bits.push(`液体 ${c.liquid}`)
      if (c.unknown) bits.push(`未加载 ${c.unknown}`)
      let hzTxt = ''
      try {
        const hz = hazardCellsOf(map, { limit: 3 })
        if (hz.length) {
          hzTxt = '｜⚠️ 附近有危险：' + hz.map((h) => `${h.kind} 在 (${h.x}, ${h.z}) 约 ${h.d} 格`).join('、')
        }
      } catch { hzTxt = '' }
      const bd = map.bounds ?? {}
      return `🧭 脚下一层（x ${bd.minX}…${bd.maxX} · z ${bd.minZ}…${bd.maxZ}，半径 ${map.radius} 格）：`
        + bits.join(' ｜ ') + hzTxt
    } catch { return '' }
  }

  /** 拼一段"该自己找点事做"的提示（带现状，省得 AI 先查一遍） */
  const idleText = (s, sess, cfg, t) => {
    const parts = []
    let where = '（位置未知）'
    let chatLines = []
    try {
      const st = sess.bot?.status?.() ?? {}
      if (st.position) where = `(${st.position.x}, ${st.position.y}, ${st.position.z})`
      parts.push(`现状：位置 ${where}｜血量 ${num(st.health, '?')}/20｜饥饿 ${num(st.food, '?')}/20`
        + `｜手上 ${st.held ?? '空手'}｜${st.dimension ?? 'overworld'} 时间 ${num(st.time, '?')}`)
      // 最近聊天：玩家可能在跟我说话 / 在说他在干嘛
      try {
        chatLines = (sess.bot?.recentChat?.(6) ?? [])
          .filter((c) => c?.text && t - num(c.at, 0) < 5 * 60_000)
          .slice(-4)
      } catch { chatLines = [] }
    } catch { /* 状态拿不到就不写 */ }

    // 反射层刚观察到的玩家（在干什么）
    if (s.playerObs?.length) {
      parts.push('👀 我看到的玩家（反射层观察，可能不完整）：')
      for (const p of s.playerObs) {
        parts.push(`　· ${p.username}：${p.distance.toFixed(1)} 格，${p.moving ? '正在走动/干活' : '站着没动'}`
          + `，${p.held ? `手持 ${p.held}` : '空手'}，面向${p.facing ?? '未知'}，y=${p.y}`)
      }
    } else {
      parts.push(`附近（${cfg.playerNearRadius} 格内）没有别的玩家`)
    }
    /* 脚下一层的结构化摘要（mc_map 第二轮）：让 AI 不用先调 mc_map 就知道
     * "我站在平地/沟边/岩浆边、哪边有危险"。算不出来就整段不加。 */
    const navLine = navLineOf(sess)
    if (navLine) parts.push(navLine)
    if (chatLines.length) {
      parts.push('💬 最近聊天：' + chatLines.map((c) => `${c.who ?? c.kind ?? '?'}：${c.text}`).join('｜'))
    }

    const idleSec = Math.round((t - s.lastToolAt) / 1000)
    const hasPlayer = (s.nearPlayers ?? 0) > 0
    const goal = (typeof cfg.standing === 'string' && cfg.standing.trim()) ? cfg.standing.trim() : DEFAULT_STANDING
    /* 手上还有没有一条没做完的事（用户 2026-10-14 任务驱动第三步："待机计时到期 → 检查有没有
     * 待执行的长期目标"）。台账落在磁盘上，**不依赖对话上下文** —— 断线、压缩、换一轮都还在。 */
    let taskBlock = ''
    try {
      const at = activeTaskOf(sess)
      if (at === undefined) {
        taskBlock = '⚠️ 台账这次读不出来（磁盘/权限问题）—— **别当成"没有任务"**：'
          + '先 `mc_task {action:"list"}` 自己看一眼再决定。\n'
      } else if (at) {
        taskBlock = `📋 我手上还有一条没做完的事：${taskBriefLine(at)}\n`
          + '　接着做就 `mc_task {action:"run"}`（**一次推一步**，推完就回来，别想一口气干完）；'
          + '也可以自己动手做，做完用 `mc_task {action:"step", status:"done"}` 记一笔。\n'
          + '　改计划：`mc_task {action:"plan", steps:[{id:"…", op:"mc_dig", args:{…}}, …]}`；'
          + '先看明细：`mc_task {action:"get"}`；不做了：`mc_task {action:"cancel"}`。\n'
          + (at.status === 'paused'
            ? '　⚠️ 这条是**断线前留下的**：先 `mc_task {action:"resume"}` 用背包复核一下再接着干，别从头重做。\n'
            : '')
          + (at.loopDetected || at.status === 'blocked'
            ? '　⚠️ 它已经反复失败过：**别再用同样的参数重试** —— 换个地方 / 换个工具，或者先干别的。\n'
            : '')
      } else {
        /* 🔴 2026-10-15 审计（报告 H 第 2 条）：这里原来教模型
         *    `mc_task {action:"start", kind:"dig", item:"oak_log", total:16}` —— 但 `mc_task`
         *    **根本没有 `start` 这个 action**（合法表见 `index.js`：list/run/get/resume/note/done/
         *    cancel/forget/plan/step），未知 action 会被静默当成 `list`（不报错）⇒ 模型以为开了任务，
         *    其实什么都没发生。开任务的正确姿势是**直接动手**：挖 4 个以上会自动开一条。 */
        taskBlock = '📋 台账上没有没做完的事（`mc_task {action:"list"}` 自己看）—— 这一轮起个头：'
          + '挑一件按长期目标该做的事，**直接动手**就行（比如 `mc_dig {name:"oak_log", count:16}` —— '
          + '挖 4 个以上会自动开一条任务，不用先 start；想自己排步骤才用 `mc_task {action:"plan", steps:[…]}`）。\n'
      }
    /* 🟡 2026-10-15 审计（报告 H 第 11 条）：内层已经仔细区分了"读不出来(undefined)"与
     *    "真没有(null)"，这里再空 catch 成 '' 就白费了 —— 一旦 `taskBriefLine` 之类抛错，
     *    模型看到的是"完全没有任务段落"，会以为台账是空的。如实写出来。 */
    } catch (e) {
      taskBlock = `⚠️ 台账这次读不出来（${e?.message ?? e}）—— **别当成"没有任务"**：`
        + '先 `mc_task {action:"list"}` 自己看一眼再决定。\n'
    }
    return `【自主行动轮｜我已经 ${idleSec}s 没被安排了】Master 没在派活，这段时间归你自己安排。\n`
      + parts.join('\n') + '\n\n'
      + (taskBlock ? `${taskBlock}\n` : '')
      + `🎯 长期目标（Master 随时可改，以最新的为准）：${goal}\n`
      + '　（Master 刚发话给了新指令/新目标 → 先 `mc_auto set {"standing":"<他那句新的>"}` 把长期目标改过来，再按新目标动手；他没发话就别自己改。）\n'
      + '　按**正常玩家的发育路线**一台阶一台阶往前推，别跳级：木头/石具 → 铁 → 钻石 → 下界（烈焰粉）→ 末地传送门 → 末影龙；装备没跟上就别急着去下界/末地。\n'
      + '　**先保命再发育**（Master 2026-10-06 定）：血少（< 12）、身边有两只以上怪、或者碰上**苦力怕 / 骷髅 / 女巫 / 末影人**这种不好惹的 → **不硬打，撤**（往 Master 那边跑，或者退到有光、有掩体、能封口的地方）；血满、手上有剑、只有一只近战小怪（僵尸/蜘蛛/史莱姆）才上去打。\n'
      + '　**出门前先看装备**：手上没剑就先做一把（木剑 → 石剑），有铁就做铁剑/盾/盔甲；天黑了别在露天乱走，进矿洞先插火把再往里走（黑的地方一定有怪）。被怪打死是**最亏的** —— 掉的东西要跑回去捡，还要重新做装备。\n\n'
      + '这一轮**按顺序做**：① 需要就先 `mc_observe` 看一眼（**不强制** —— 什么时候看你自己判断：要动手之前、找路、看不清周围、刚被卡住时看一眼最划算；心里有数就直接跳过，别为了看图而看图）；'
      + '② 接着上一步的进度干（**先看台账**：`mc_task {action:"run"}` 把手上那条推进一步，或者 `get` 看明细；'
      + '台账在磁盘上，断线 / 压缩都不会丢 —— 别每轮从零想）；'
      + '③ **真的动手做 2~4 个会改变世界的动作**（`mc_move` / `mc_dig` / `mc_build` / `mc_act` / `mc_give`）；'
      + '④ 干完往记忆里记一句"干到哪了"（`mc_kit_memory`），下次接着干。\n'
      + '　**走不动 / 卡住 / 掉坑里上不来**（`mc_move` 报 arrived 但人没动、或原地打转）→ 相信 `mineflayer-pathfinder` 的寻路结果；失败就换一个可达目标，别反复撞墙或盲跳。\n\n'
      + '🔴 三条硬规矩（Master 明确要求过）：\n'
      + '· **不要问他"要我做什么"** —— 他不回话就是默认让你自己决定；你要的是"在做事"，不是"在等指令"。\n'
      + '· **不要用 `mc_events waitSec` 干等回复** —— 等回复不算行动；要等就让反射层等，你先把事做了。\n'
      + '· 观察类工具（`mc_observe` / `mc_status` / `mc_scan` / `mc_inventory`）**不算行动**，只有 ③ 那类才算。\n'
      + (s.noActionStreak
        ? `\n⚠️ 你已经连着 ${s.noActionStreak} 轮只是说话/站着，没有任何实际行动。`
          + '这一轮**先动手再说话**：立刻挑最近的一棵树/一块石头开始挖，别再汇报、别再问。\n'
        : '')
      + '\n'
      + (hasPlayer
        ? '👥 旁边有人（**和他一起玩**）：先看清他**在干什么**（挖矿/砍树/盖房/打怪/站着），然后**直接上手帮**'
          + '（他挖你搬、他盖你递材料、他被怪打你上）—— 不用先问；'
          + '只有要动他的箱子/建筑/东西时才 `mc_say` 问一句，**而且问完别停下等**，继续干自己的。\n'
        : '')
      + '做完**简短**说一句你干了什么（一句话，别写报告；**不要以问句结尾**）。\n'
      + '默认约束（Master 定的）：**别拆别人盖的东西、别动别人的箱子、别乱丢东西、别跑太远**；'
      + '真的没事可做才回一句"继续待着"（那是少数情况，不是默认选项）。\n'
      + '想改长期目标/自主程度：`mc_auto set {"standing":"..."}`｜status 看状态 / off 全停 / stay 别乱走 / follow <玩家名>。'
  }

  const tryIdleWake = (s, sess, cfg, t) => {
    if (!cfg.idleWake) return
    const agent = s.agent
    if (!agent || typeof agent.steer !== 'function') return
    if (agent.status === 'running') return                        // AI 正在跑一轮，别插嘴
    if (wakeWaitMs(s, cfg, t) > 0) return                       // 距上次工具调用 / 上次叫醒都够久了吗
    const wdWake = num(sess?.watchdog?.lastWakeAt, 0)
    if (wdWake && t - wdWake < Math.max(MIN_IDLE_SEC, cfg.minIdleGapSec) * 1000) return
    s.wakeTimes = s.wakeTimes.filter((x) => t - x < 3_600_000)
    if (s.wakeTimes.length >= cfg.idleWakeMaxPerHour) { s.stats.denied++; return }

    // 退避记账：上一次叫醒之后 AI 有没有调过工具？
    const acted = s.lastWakeAt > 0 && s.lastToolAt > s.lastWakeAt
    s.noActionStreak = s.lastWakeAt === 0 ? 0 : (acted ? 0 : Math.min(s.noActionStreak + 1, 6))

    const text = idleText(s, sess, cfg, t)
    try {
      try { sess.interruptWait?.('idle') } catch { /* 打断等待失败不影响注入 */ }
      agent.steer(userMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin:mcp-mc-agent', form: 'notice', summary: 'MC 自主行动轮：自己找点事做' },
      }))
      s.lastWakeAt = t
      s.nudgedAt = 0
      s.wakeTimes.push(t)
      s.stats.wakes++
      logLine(`mc_auto：空闲 ${Math.round((t - s.lastToolAt) / 1000)}s → 已叫醒 AI（本小时第 ${s.wakeTimes.length} 次`
        + `${s.noActionStreak ? `，上次没动作，间隔已翻 ${2 ** s.noActionStreak} 倍` : ''}）`)
    } catch (e) {
      s.stats.denied++
      s.lastError = `空闲叫醒失败：${e?.message ?? e}`
    }
  }

  /**
   * 叫醒之后 AI 只说话没动手 → 补一条短催促（每次叫醒最多一条）。
   * 实测（session-8d80cd31）：光靠叫醒文案，模型有时仍然回一句"继续待着"或反问 Master 就不动了。
   * 这条不解释、只下命令，把它推回"动手"那条路上。
   */
  const maybeNudge = (s, sess, cfg, t) => {
    if (!cfg.idleWake) return
    if (!s.lastWakeAt || s.nudgedAt >= s.lastWakeAt) return      // 没叫醒过 / 这次叫醒已经催过
    if (s.lastToolAt >= s.lastWakeAt) return                     // 叫醒后已经动过手，不用催
    if (t - s.lastWakeAt < NUDGE_AFTER_MS) return                // 先给它一点时间，别追着喊
    const agent = s.agent
    if (!agent || typeof agent.steer !== 'function') return
    if (agent.status === 'running') return                       // 它正在跑，等它跑完
    s.wakeTimes = s.wakeTimes.filter((x) => t - x < 3_600_000)
    if (s.wakeTimes.length >= cfg.idleWakeMaxPerHour) return      // 催促也算一次叫醒，共用限流
    try {
      agent.steer(userMessage({
        content: [{
          type: 'text',
          text: '（别问了，直接做：挑一件小事**做完** —— 走两步、挖一块、递个东西都算；拿不准眼前什么情况就先 `mc_observe` 看一眼。）',
        }],
        source: { kind: 'plugin:mcp-mc-agent', form: 'notice', summary: 'MC 自主行动：别问，直接做' },
      }))
      s.nudgedAt = t
      s.wakeTimes.push(t)
      s.stats.nudges++
      logLine('mc_auto：叫醒后 AI 没动手 → 已补一条催促')
    } catch (e) {
      s.lastError = `催促失败：${e?.message ?? e}`
    }
  }

  /* ── 每 tick 的推进 ── */

  const step = (s, sess, t) => {
    const bot = sess?.bot
    if (!bot?.online) {
      // 离线：重置计时，免得重连后立刻被叫醒
      if (s.offlineSince !== true) { s.offlineSince = true; s.lastToolAt = t }
      s.hooked = false                    // 重连后是新的 bot 对象，得重新挂 entityHurt
      s.eatHooked = false                 // 🔴 同理：eatFinish/eatFail 也是挂在 bot 对象上的（审计 2026-10-08）
      return
    }
    if (s.offlineSince === true) { s.offlineSince = false; s.lastToolAt = t }
    // 被攻击的判据：只认"挨打的是我自己"（entityHurt 对每个受伤实体都会发）
    if (!s.hooked) {
      const b0 = sess?.bot?.bot
      if (typeof b0?.on === 'function') {
        s.hooked = true
        try {
          b0.on('entityHurt', (e) => {
            try {
              const self = sess.bot?.bot?.entity
              if (!e || !self) return
              if (e === self || (self.id != null && e.id === self.id)) s.lastHurtAt = now()
            } catch { /* 忽略 */ }
          })
        } catch { /* 挂不上就算了：avoid 里还有"掉血也算挨打"的兜底 */ }
      }
    }
    // 模式闸门（复用看门狗的 gate：不在 MC 模式就别动、别注入）
    const gate = sess?.watchdog?.gate
    if (typeof gate === 'function') {
      let allowed = true
      try { allowed = gate() !== false } catch { allowed = true }
      if (!allowed) return
    }
    if (!s.agent) s.agent = sess?.watchdog?.agent ?? null

    const cfg = cfgFor(s.agent)
    // 先看一眼附近的人在干嘛（只读；也决定"有人在旁边"时叫醒要不要更勤）
    try { observePlayers(s, sess, cfg, t) } catch { /* 观察失败不影响别的 */ }
    const sinceTool = t - s.lastToolAt
    /**
     * 两档"现在能不能自己动"：
     *   · quiet —— 没有任何工具在执行、且距上次工具调用已过 quietAfterToolMs。
     *     会改状态的动作（吃/捡/走）只用这一档。
     *   · calm  —— 只看时间（不管有没有工具在跑）。环顾只用这一档：
     *     这样 AI 在 `mc_events {waitSec:180}` 里干等时，我也不会僵在原地装死
     *     （转头不会改变世界状态）。
     */
    const quiet = s.inFlight === 0 && sinceTool >= cfg.quietAfterToolMs
    const calm = !s.busy && sinceTool >= cfg.quietAfterToolMs

    // AI 刚动过手 → 把它给的朝向记成"基础朝向"（环顾只在它附近晃，不会把身子拧到背后去）
    if (sinceTool < cfg.quietAfterToolMs) {
      try {
        const e = sess.bot?.bot?.entity
        if (e) { s.baseYaw = e.yaw; s.basePitch = e.pitch }
      } catch { /* 忽略 */ }
    }

    // ① 自保：任何时候都做（但要避开正在执行的动作）
    if (cfg.avoid) { try { avoid(s, sess, cfg, t) } catch (e) { s.lastError = `avoid 出错：${e?.message ?? e}` } }

    // ② 空闲转头（不动位置）
    if (calm && cfg.enabled) {
      if (cfg.lookAround) { try { lookAround(s, sess, cfg, t) } catch (e) { s.lastError = `look 出错：${e?.message ?? e}` } }
    }

    // ③ 会改状态的动作 + ④ 移动类：都要求"AI 这一轮已经跑完"（agentIdle）
    //    —— 免得 AI 还在思考/按刚看的画面准备动手，我却先挪了窝
    const agentIdle = s.agent?.status !== 'running'
    if (quiet && cfg.enabled && agentIdle) {
      // 自动吃**无条件调**：函数内部按开关 enable/disable 插件（关掉时也得进去 disableAuto，
      // 否则插件会一直吃下去）
      autoEat(s, sess, cfg, t).catch(() => {})
      if (cfg.pickup) { pickup(s, sess, cfg, t).catch(() => {}) }
      // 有甲就穿（"变强"里最便宜的一步，跟打不打没关系）：AI 没在动手时才碰背包
      if (cfg.wearArmor !== false && t - num(s.lastArmorAt, 0) > 10_000) {
        s.lastArmorAt = t
        viaScheduler(sess, 'auto:armor', ['inventory'], () => wearArmor(sess?.bot?.bot)).catch(() => {})
      }
      if (!s.busy) {
        try {
          follow(s, sess, cfg, t)
        } catch (e) { s.lastError = `移动出错：${e?.message ?? e}` }
      }
    }

    // ⑤ 空闲决策层
    try { tryIdleWake(s, sess, cfg, t) } catch (e) { s.lastError = `idleWake 出错：${e?.message ?? e}` }
    // ⑥ 叫醒后只说话没动手 → 补一条催促（每次叫醒最多一条）
    try { maybeNudge(s, sess, cfg, t) } catch (e) { s.lastError = `催促出错：${e?.message ?? e}` }
  }

  const tick = (t = now()) => {
    let list = []
    try { list = registry?.listSessions?.() ?? [] } catch { list = [] }
    const alive = new Set()
    for (const entry of list) {
      try {
        const sid = String(entry?.agentId ?? entry?.id ?? '')
        if (!sid) continue
        alive.add(sid)
        // 🔴 listSessions() 给的是**摘要对象**（只有 agentId/online/watching…，没有 bot/watchdog/agent），
        //    必须用 peek(sid) 拿真会话，否则这里拿到的东西啥也干不了。
        let sess = null
        try { sess = registry?.peek?.(sid) ?? null } catch { sess = null }
        if (!sess) { sess = entry?.bot ? entry : null } // 兼容"直接给真会话"的自检/未来改动
        if (!sess) continue
        const s = stateOf(sid)
        s.agent = sess?.watchdog?.agent ?? s.agent
        step(s, sess, t)
      } catch (e) {
        logLine(`mc_auto：单会话 tick 出错（已吞）：${e?.message ?? e}`)
      }
    }
    for (const sid of [...sessions.keys()]) if (!alive.has(sid)) sessions.delete(sid)
    return { sessions: alive.size }
  }

  /* ── 对外：状态 / 工具 ── */

  const statusOf = (agent, sess) => {
    const cfg = cfgFor(agent)
    const sid = String(agent?.id ?? sess?.agentId ?? '')
    // 还没 tick 过也要能看到本会话信息（有活会话才建状态；没有就保持 null）
    const s = sid ? (sessions.get(sid) ?? (sess ? stateOf(sid) : null)) : null
    const t = now()
    return {
      config: { ...cfg },
      defaults: { ...AUTO_DEFAULTS },
      session: s
        ? {
            idleSec: Math.round((t - s.lastToolAt) / 1000),
            inFlight: s.inFlight,
            busy: s.busy,
            escaping: s.escaping,
            lastWakeAt: s.lastWakeAt || null,
            lastWakeAgoSec: s.lastWakeAt ? Math.round((t - s.lastWakeAt) / 1000) : null,
            wakesThisHour: s.wakeTimes.filter((x) => t - x < 3_600_000).length,
            nextWakeInSec: cfg.idleWake ? Math.round(wakeWaitMs(s, cfg, t) / 1000) : null,
            noActionStreak: s.noActionStreak,
            nearPlayers: s.nearPlayers,
            playerObs: s.playerObs ?? [],
            lastAction: s.lastAction,
            lastError: s.lastError,
            stats: { ...s.stats },
          }
        : null,
      online: Boolean(sess?.bot?.online),
    }
  }

  const toolSpec = () => ({
    name: 'mc_auto',
    description: '🤖 **自主行为层**（"让它像正常玩家一样"）：不传参数 = 看状态。\n'
      + '两层：① **反射层**（不花 token、常开）：AI 没调工具时我自己环顾、饿了吃、'
      + '捡掉落物、躲岩浆火仙人掌、跟随玩家。'
      + '**被怪打 / 有怪贴上来 → 立刻叫醒 AI 定策略**（还手/撤/垒方块由 AI 决定）；'
      + '**我自己不跑、不还手**，只把手里那件活停下（`dangerStopWork` 可关；叫醒文案带怪名/坐标/距离/血量）。'
      + '远程怪（骷髅/掠夺者/女巫…）22 格内**且看得见我**才算威胁；挨打却看不到怪会报上次看到它在哪。'
      + '**水里憋气（头在水下）也会叫醒 AI 上浮**：掉血或超 10 秒；真要憋死了我只按住 jump 抬一下，不横向跑。'
      + '**附近有玩家时我一直看着他**（不动位置、不碰东西）；'
      + '任何工具调用后静默 6s；走路类只在 AI 这一轮跑完时才动。\n'
      + `② **空闲决策层**（花 token）：AI 停下来（默认 ${AUTO_DEFAULTS.idleWakeSec} 秒没事干）且这一轮结束时，我用插件提示叫醒它，`
      + '文案带"玩家在干什么"（距离/在动/手持/面向/最近聊天）+ **长期目标** + **没做完的任务**，'
      + '让它**按长期目标自己开工**（**看图不强制**；默认目标"像正常玩家一样发展、最后打末影龙"，路线木头/石具→铁→钻石→下界→末地；旁边有人一起干）。'
      + '**不许反问 Master"要我做什么"**（不回话 = 让它自己决定）；'
      + '只有要动 Master 的箱子/建筑时才 mc_say 问一句、问完不等。'
      + '叫醒 45s 后还没动手，我会再补一条"别问，直接做"的催促（每次叫醒最多一条，也占额度）。\n'
      + `每小时最多 ${AUTO_DEFAULTS.idleWakeMaxPerHour} 次；**叫醒后 AI 没做任何事就自动翻倍拉长间隔**`
      + '（封顶 30 分钟），做了事就复位。\n'
      + '用法：`action:"status"`（默认）｜`"off"` 关反射层（🔴 **不是"全停"**：空闲叫醒还开着，'
      + '要 `set {"idleWake":false}` 才全静音；自保 `avoid` 独立，要一起关得 `set {"avoid":false}`）｜`"on"` 全开｜`"stay"` 站定（停跟随）｜'
      + '`"follow"` + `who:"玩家名"` 跟着谁走｜`"wake"` 立刻叫醒一次（不等间隔）｜'
      + '`"set"` + `patch:{"standing":"先盖个小屋再挖矿","idleWakeSec":600}` 改参数（落 `.mcp-mc-agent/auto.json`）。\n'
      + '**Master 在对话里改了主意 → 立刻用 `set` 把 `standing` 写成他那句新的**；他没发话就别自己改。\n'
      + '🔴 默认只做**无害动作**：不会自己拆别人建筑、动别人箱子、乱丢东西、跑太远。',
    parameters: {
      action: { type: 'string', description: 'status（默认）/ on / off / stay / follow / wake / set' },
      who: { type: 'string', description: 'follow 用：要跟随的玩家名（留空=取消跟随）' },
      patch: { type: 'object', additionalProperties: true, description: 'set 用：要改的配置项（浅合并）' },
    },
    output: {
      schema: { type: 'object', properties: {}, additionalProperties: true },
      render: (a, v) => [{ type: 'text', text: typeof v?.text === 'string' ? v.text : JSON.stringify(v, null, 2) }],
    },
    async execute (args = {}, exec = null) {
      const agent = exec?.agent ?? null
      let sess = null
      try {
        const sid = String(agent?.id ?? '')
        sess = sid ? (registry?.peek?.(sid) ?? null) : null
      } catch { sess = null }
      const action = String(args?.action ?? 'status').toLowerCase()
      let note = ''

      if (action === 'on' || action === 'off') {
        setConfig(agent, { enabled: action === 'on' })
        note = action === 'on' ? '反射层已开' : '反射层已关（空闲叫醒不受影响，用 set {idleWake:false} 才全静音）'
      } else if (action === 'stay') {
        setConfig(agent, { enabled: true, follow: null })
        note = '已经站定：不跟随、不乱走（环顾/自保还在）'
      } else if (action === 'follow') {
        const who = args?.who === undefined ? undefined : String(args.who).trim()
        setConfig(agent, { follow: who ? who : null })
        note = who ? `开始跟随 ${who}（跟不上时会自己找路）` : '已取消跟随'
      } else if (action === 'set') {
        const { applied, rejected } = setConfig(agent, args?.patch ?? {})
        note = `已改：${Object.keys(applied).join(', ') || '（无）'}`
        if (rejected.length) note += `；不认识/非法的项被忽略：${rejected.join(', ')}`
      } else if (action === 'wake') {
        const s = sess ? stateOf(String(sess.agentId ?? '')) : null
        const target = agent ?? sess?.watchdog?.agent ?? null
        if (!s || !target?.steer) {
          note = '现在没有可叫醒的会话（bot 没连上 / 没有 agent）'
        } else {
          try {
            try { sess.interruptWait?.('idle') } catch { /* 忽略 */ }
            target.steer(userMessage({
              content: [{ type: 'text', text: idleText(s, sess, cfgFor(target), now()) }],
              source: { kind: 'plugin:mcp-mc-agent', form: 'notice', summary: 'MC 自主行动轮（手动触发）' },
            }))
            s.lastWakeAt = now()
            s.nudgedAt = 0
            s.wakeTimes.push(s.lastWakeAt)
            s.stats.wakes++
            note = '已经手动叫醒 AI 一次'
          } catch (e) { note = `叫醒失败：${e?.message ?? e}` }
        }
      } else if (action !== 'status') {
        note = `不认识的 action："${action}"（可用：status/on/off/stay/follow/wake/set）`
      }

      const st = statusOf(agent ?? sess?.watchdog?.agent, sess)
      const cfg = st.config
      const lines = [
        `🤖 自主层：${cfg.enabled ? '反射层开' : '反射层关'}｜${cfg.idleWake ? `空闲 ${cfg.idleWakeSec}s 叫醒 AI（本小时上限 ${cfg.idleWakeMaxPerHour}）` : '空闲叫醒关'}`,
        `　环顾 ${cfg.lookAround ? '开' : '关'}｜自动吃 ${cfg.autoEat ? '开' : '关'}`
          + `｜捡东西 ${cfg.pickup ? '开' : '关'}｜自保 ${cfg.avoid ? `开（被打/憋气时叫醒 AI${cfg.dangerStopWork !== false ? ' + 先停下手里的事' : ''}，不自己跑也不还手）` : '关'}`
          + `｜自动穿甲 ${cfg.wearArmor === false ? '关' : '开'}`
          + `｜跟随 ${cfg.follow ?? '关'}`,
        `　🎯 长期目标：${cfg.standing || DEFAULT_STANDING}`
          + '（改：`set {"standing":"..."}`）',
      ]
      if (st.session) {
        const s = st.session
        lines.push(`　本会话：已闲 ${s.idleSec}s${s.nextWakeInSec === null ? '' : `（下次叫醒还要 ${s.nextWakeInSec}s）`}`
          + `｜本小时叫醒 ${s.wakesThisHour} 次｜连叫没动作 ${s.noActionStreak} 次`
          + `${s.lastAction ? `｜刚才在「${s.lastAction}」` : ''}${s.lastError ? `｜⚠️ ${s.lastError}` : ''}`)
        lines.push(s.playerObs?.length
          ? `　👀 旁边：${s.playerObs.map((p) => `${p.username}(${p.distance.toFixed(1)}格，${p.moving ? '在动' : '站着'}${p.held ? `，手持 ${p.held}` : ''})`).join('、')}`
          : '　👀 旁边没有玩家')
        lines.push(`　累计：环顾 ${s.stats.looks}（其中看玩家 ${s.stats.watches}）｜吃 ${s.stats.eats}｜捡 ${s.stats.pickups}`
          + `｜自保提醒 ${s.stats.alerts ?? 0}（叫醒 ${s.stats.dangerWakes ?? 0}）｜脱险 ${s.stats.escapes}`
          + `｜跟随 ${s.stats.follows}｜叫醒 ${s.stats.wakes}`
          + `（其中催促 ${s.stats.nudges ?? 0}）｜限流挡掉 ${s.stats.denied}`)
        lines.push(`　🌊 水下自救 ${s.stats.waterRecovers ?? 0} 次（出来 ${s.stats.waterEscapes ?? 0} 次）`
          + (s.waterRecoverLast
            ? `｜上一次：${s.waterRecoverLast.ok ? '出来了' : '没出来'}（${s.waterRecoverLast.reason ?? '?'}）—— ${String(s.waterRecoverLast.note ?? '').slice(0, 80)}`
            : '｜还没跑过'))
      } else {
        lines.push('　本会话：还没有 MC 会话（没连上时只能看/改配置）')
      }
      if (note) lines.push(`　→ ${note}`)
      return { ok: true, action, note, ...st, text: lines.join('\n') }
    },
  })

  return { tick, cfgFor, setConfig, statusOf, toolSpec, stateOf, noteToolStart, noteToolEnd, sessions, configs }
}

/* ─────────────────────────── 插件挂载 ─────────────────────────── */

export async function apply (api) {
  const { ctx, asTool, registry, logLine, workspaceOf, memoryFor } = api
  const envOff = /^(off|0|false|no)$/i.test(String(process.env.MCP_MC_AGENT_AUTO ?? '').trim())

  // 记忆根：宿主认 `config.memoryDir`，扩展必须跟着走（拿不到就退回 `<工作区>/.mcp-mc-agent`）
  const memRootOf = (ws) => { try { return ws ? (memoryFor?.(ws)?.root ?? null) : null } catch { return null } }
  const auto = createAuto({ registry, logLine, workspaceOf, memRootOf })

  try {
    ctx.tools.register(asTool(auto.toolSpec()))
  } catch (err) {
    logLine(`mc_auto 工具注册失败：${err?.message ?? err}`)
    return
  }

  // 工具活动 = "AI 在开车"：重置空闲计时，并让它静默一会儿
  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      try { auto.noteToolStart(exec?.agent?.id, exec) } catch { /* 忽略 */ }
      return typeof next === 'function' ? next() : undefined
    })
    ctx.on('tools/post-execute', async (exec, result, next) => {
      try { auto.noteToolEnd(exec?.agent?.id) } catch { /* 忽略 */ }
      return typeof next === 'function' ? next() : undefined
    })
  } catch (err) {
    logLine(`mc_auto 工具钩子注册失败（反射层仍可用，但会误判空闲）：${err?.message ?? err}`)
  }

  if (envOff) {
    logLine('mc_auto 已加载：工具 mc_auto（反射层与空闲叫醒被 MCP_MC_AGENT_AUTO=off 关掉，仅可查看/改配置）')
    return
  }

  // 🔴 setInterval 回调里抛错 = uncaughtException = 整个宿主进程死。必须自己兜住。
  const timer = setInterval(() => {
    try { auto.tick(Date.now()) } catch (e) { logLine(`mc_auto tick 出错（已吞）：${e?.message ?? e}`) }
  }, 500)
  timer.unref?.()

  // 🔴 2026-10-08 审计：这里原来写死"空闲 180s、旁边有人 60s"，而实际默认是 5s/5s ——
  //    排查"为什么一直在叫醒"的人会被日志带偏。改成从 AUTO_DEFAULTS 现算。
  logLine(`mc_auto 已加载：工具 mc_auto + 自主行为层（反射常开；空闲 ${AUTO_DEFAULTS.idleWakeSec}s、旁边有人 ${AUTO_DEFAULTS.idleWakeNearPlayerSec}s 叫醒 AI，带每小时上限与退避；改 auto.json 或 mc_auto{action:"set"}）`)
}
