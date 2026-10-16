/**
 * 水下出口搜索 —— **只读世界 + 纯计算，绝不碰 bot 的按键**（2026-10-15 用户点名要的）。
 *
 * 为什么需要它：以前的"水里的自救"只有一条 `mc_move{mode:"swim"}` —— 按住 jump 往上顶。
 * 那招只能应付**头顶一路通到水面**的水域；一旦头顶是石头（洞穴里的水、水下的坑），
 * 它就只会一直顶天花板，氧气掉光、开始掉血，然后淹死。
 * 这一层补的正是那个缺口：**在水里找一条真的能出去的路**，而不是只会往上。
 *
 * 三类出口（用户定义的 A/B/C，**不是**简单的"越高越好"）：
 *   - `passage` A 可通行水道：只用来**脱离局部死路**（比如自己被卡在一条被墙堵住的支道里），
 *     找到它**不代表安全**，所以它的优先级最低。
 *   - `breath`  B 可呼吸空间：头那格不是水 ⇒ 能换气。洞穴顶上的空气口袋属于这一类 ——
 *     **它只是中间目标**，能让你多撑一会儿，但不等于已经脱险。
 *   - `dry`     C 安全落脚点：**真正的目标**。身体有空间、脚下有可靠支撑、不是水、附近没有岩浆 ——
 *     到了这里就可以交回给陆地寻路器了。
 *
 * 评分是**分阶段的**（可达性 → 生存安全 → 呼吸恢复 → 真正脱险 → 路径成本），
 * 不是给一个加权总分：加权会让"近但会掉进岩浆"赢过"远但安全"。
 *
 * 纪律（和 `terrain.mjs` / `bridge.mjs` 一致）：**不 import `core.mjs`**（会成环）、
 * **不 import 游戏库**（只认 `b.blockAt` / `b.entity`），纯函数尽量不碰全局状态。
 */

import { Vec3 } from 'vec3'
import { isAir, isLiquid, isPassable, isSolidBlock } from './block-names.mjs'
import { BRIDGE_FATAL, fatalText } from './bridge.mjs'

/* ─────────── 常量 ─────────── */

/** 水平搜索半径（第一版按用户建议从 8 起步，实机再调） */
export const WATER_RADIUS = 8
/** 往上找多少格（水面通常在头上，但洞穴水域的顶可能很高） */
export const WATER_UP = 8
/** 往下找多少格（往下的出口 = 更深的水，一般不是好出路，但得能看穿） */
export const WATER_DOWN = 8
/** 一次搜索最多走多少个格子（防止"一次出口搜索吃光整个工具预算"） */
export const WATER_MAX_NODES = 900
/** 候选点最多留几个（给 AI 看的列表，不是越多越好） */
export const WATER_MAX_CANDIDATES = 12
/** 走到离出口这么近就算到了（和 `walkPathfinder` 的默认到达半径同量级） */
export const WATER_ARRIVE = 1.6

export const WATER_KINDS = ['dry', 'breath', 'passage']

export const WATER_KIND_TEXT = {
  dry: '安全落脚点（干燥、有支撑、能交回陆地寻路）',
  breath: '可呼吸空间（能换气，但还没脱险）',
  passage: '可通行水道（只够脱离眼前的死路）',
}

/* ─────────── 世界只读：单格判据 ─────────── */

/** 这一格的方块名（`null` = 没加载 / 读不到 —— 和 `terrain.mjs` 一个语义） */
export function nameAt (b, x, y, z) {
  try {
    const blk = b?.blockAt?.(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)))
    if (!blk) return null
    return typeof blk.name === 'string' ? blk.name : null
  } catch { return null }
}

/** `'water'` / `'air'` / `'blocked'` / `'unknown'`（`unknown` = 区块没加载，**不能当空气**） */
export function cellKindAt (b, x, y, z) {
  const n = nameAt(b, x, y, z)
  if (n == null) return 'unknown'
  if (BRIDGE_FATAL.test(n)) return 'blocked'          // 岩浆/火/仙人掌…：不是"能站"，是"别去"
  if (isLiquid(n)) return 'water'
  if (isAir(n) || isPassable(n)) return 'air'
  return 'blocked'
}

/** 这一格能不能被"游过去"（脚 + 头都有空间；未知一律算不能，宁可少找也不要瞎走） */
export function swimmableAt (b, x, y, z) {
  const feet = cellKindAt(b, x, y, z)
  if (feet === 'blocked' || feet === 'unknown') return false
  const head = cellKindAt(b, x, y + 1, z)
  if (head === 'blocked' || head === 'unknown') return false
  return true
}

/** 头那格不是水 ⇒ 能换气（水面上、空气口袋里都算） */
export function breathableAt (b, x, y, z) {
  const head = cellKindAt(b, x, y + 1, z)
  return head === 'air'
}

/**
 * **安全落脚点**：身体两格都不是水、脚下是实心方块、而且那块不是会要命的东西。
 * 三个条件缺一不可 —— 只看"头那格是空气"会把水里的悬空洞口也当成岸。
 */
export function standableAt (b, x, y, z) {
  const feet = cellKindAt(b, x, y, z)
  if (feet !== 'air') return false
  const head = cellKindAt(b, x, y + 1, z)
  if (head !== 'air') return false
  const under = nameAt(b, x, y - 1, z)
  if (under == null) return false
  if (BRIDGE_FATAL.test(under)) return false
  return isSolidBlock(under)
}

/** 这一格附近有没有会要命的东西（自己 + 上下 + 四周，共 7 格） */
export function hazardNear (b, x, y, z) {
  const spots = [[0, 0, 0], [0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
  for (const [dx, dy, dz] of spots) {
    const n = nameAt(b, x + dx, y + dy, z + dz)
    if (n != null && BRIDGE_FATAL.test(n)) return n
  }
  return null
}

/* ─────────── 有限范围分层 BFS ─────────── */

const NEIGHBORS = [[0, 1, 0], [0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
const keyOf = (x, y, z) => `${x},${y},${z}`

/**
 * 从当前格出发，在有限范围里搜"能游到的格子"，顺手把三类出口候选挑出来。
 *
 * **第一版不上 A\*** —— 用户明确说的：先把"找得到 / 找不到"做对，再谈快不快。
 * 这里用分层 BFS（每层记距离），**6 邻域**而不是 26 邻域：斜着穿墙角在游戏里会卡住，
 * 少找几个候选，比"找到一条走不通的路"强。
 *
 * @returns {{ found, kind, target, path, distance, candidates, scanned, reason, note }}
 */
export function waterExitSearch (b, { feet = null, radius = WATER_RADIUS, up = WATER_UP, down = WATER_DOWN, maxNodes = WATER_MAX_NODES, avoid = null } = {}) {
  const f = feet ?? feetOfBot(b)
  if (!f) {
    return { found: false, kind: null, target: null, path: [], distance: null, candidates: [], scanned: 0, reason: 'unknown-world', note: '读不到自己在哪 —— 搜不了出口' }
  }
  const sx = Math.floor(f.x); const sy = Math.floor(f.y); const sz = Math.floor(f.z)
  /* 只有**真的泡在水里**才值得搜出口。注意判据是 `inWaterAt`（脚或头是水），
   * **不是** `swimmableAt` —— 站在干燥的岸上时"脚空气 + 头空气"也是可通行的，
   * 拿后者当门会变成"站在岸上还要找出口"。 */
  if (!inWaterAt(b, { x: sx, y: sy, z: sz })) {
    return { found: false, kind: null, target: null, path: [], distance: null, candidates: [], scanned: 0, reason: 'not-in-water', note: '我现在不在水里 —— 这条是给"泡在水里出不来"用的' }
  }

  const seen = new Set([keyOf(sx, sy, sz)])
  const prev = new Map()
  const dist = new Map([[keyOf(sx, sy, sz), 0]])
  const queue = [[sx, sy, sz]]
  const candidates = []
  let scanned = 1
  let head = 0

  while (head < queue.length && scanned < maxNodes) {
    const [x, y, z] = queue[head++]
    const d = dist.get(keyOf(x, y, z))
    /* 顺手把这一格本身是不是出口记下来（起点不算：站在起点说"找到出口了"是废话） */
    if (d > 0) {
      const kind = standableAt(b, x, y, z) ? 'dry' : (breathableAt(b, x, y, z) ? 'breath' : null)
      if (kind) {
        candidates.push({ x, y, z, kind, distance: d, safe: hazardNear(b, x, y, z) == null })
      }
    }
    for (const [dx, dy, dz] of NEIGHBORS) {
      const nx = x + dx; const ny = y + dy; const nz = z + dz
      if (Math.abs(nx - sx) > radius || Math.abs(nz - sz) > radius) continue
      if (ny > sy + up || ny < sy - down) continue
      const k = keyOf(nx, ny, nz)
      if (seen.has(k)) continue
      if (!swimmableAt(b, nx, ny, nz)) continue
      seen.add(k)
      prev.set(k, keyOf(x, y, z))
      dist.set(k, d + 1)
      queue.push([nx, ny, nz])
      scanned++
      if (scanned >= maxNodes) break
    }
  }

  const rank = { dry: 3, breath: 2, passage: 1 }
  /* 分阶段筛选：先把"会要命的"候选踢掉（除非一个安全的都没有，那时才退而求其次）。 */
  const safeOnes = candidates.filter((c) => c.safe)
  const pool = safeOnes.length ? safeOnes : candidates
  /* `avoid` = 上一轮走过但没走通的目标（用户要求"路线失败则排除旧路线再次搜索"）。
   * 注意只在**挑选**时排除，`candidates` 里仍然留着 —— AI 该看到的东西不能藏。 */
  const usable = avoid ? pool.filter((c) => !avoid.has(keyOf(c.x, c.y, c.z))) : pool
  usable.sort((a, c) => (rank[c.kind] - rank[a.kind]) || (a.distance - c.distance))
  if (avoid && pool.length && !usable.length) {
    return {
      found: false, kind: null, target: null, path: [], distance: null, candidates: pool, scanned,
      reason: 'all-tried',
      note: '找得到的出口都试过了、都没走通 —— 换个方向再叫我一次，或者扩大范围',
    }
  }

  let best = usable[0] ?? null
  if (!best) {
    /* 🔴 预算用完了（`maxNodes` 卡住）就**老实地承认没搜完**，不许拿"随便一个更开阔的水格"
     *   冒充出口 —— 用户说的"本轮预算内没结果就扩大范围或返回明确的失败，不能假装找到路径"。 */
    if (scanned >= maxNodes) {
      return {
        found: false, kind: null, target: null, path: [], distance: null, candidates: [], scanned,
        reason: 'budget-out',
        note: `这次搜索的预算（${maxNodes} 格）用完了还没找到出口 —— 过一会儿再叫我一次，或者换个方向`,
      }
    }
    /* 一类出口都没找到 —— 退一步：找一个"比起点更开阔"的可游格，用来脱离局部死路。
     * 用户说的 A 类就是这个意思：**只用于脱离死路，不能当成已安全**。 */
    best = passageCandidate(b, queue, dist, sx, sy, sz)
  }

  if (!best) {
    return {
      found: false, kind: null, target: null, path: [], distance: null, candidates: [], scanned,
      reason: 'no-exit-found',
      note: `半径 ${radius} 格 / 上下 ${up}+${down} 格以内（翻了 ${scanned} 格）没找到任何出口 —— **别在原地一直游**，换个方向再叫我一次`,
    }
  }

  const path = rebuildPath(prev, keyOf(best.x, best.y, best.z))
  return {
    found: true,
    kind: best.kind,
    target: { x: best.x, y: best.y, z: best.z },
    path,
    distance: best.distance,
    candidates: pool.slice(0, WATER_MAX_CANDIDATES),
    scanned,
    reason: 'ok',
    note: waterNote(best, pool),
  }
}

/** A 类兜底：找可游格里"出口最多"的那个（脱离局部死路用） */
function passageCandidate (b, queue, dist, sx, sy, sz) {
  /* 🔴 关键：只有**比我现在这格更开阔**的水道才算"出口"。
   * 不然一个四面都是水的密闭水牢里，每个格子都"有 6 个可游邻居"，
   * 兜底会把随便哪格报成"找到可通行水道" ⇒ 用户点名的场景⑤
   * （"附近完全没有可达出口 ⇒ 返回明确失败、不无限游动"）就永远走不到了。 */
  const openAt = (x, y, z) => {
    let n = 0
    for (const [dx, dy, dz] of NEIGHBORS) if (swimmableAt(b, x + dx, y + dy, z + dz)) n++
    return n
  }
  const startOpen = openAt(sx, sy, sz)
  let best = null
  for (const [x, y, z] of queue) {
    if (x === sx && y === sy && z === sz) continue
    const d = dist.get(keyOf(x, y, z))
    if (d < 2) continue                                  // 隔壁那格不算"出口"，得有"走过去"这回事
    const open = openAt(x, y, z)
    if (open <= startOpen) continue
    if (!best || open > best.open || (open === best.open && d < best.distance)) best = { x, y, z, kind: 'passage', distance: d, safe: hazardNear(b, x, y, z) == null, open }
  }
  return best
}

function rebuildPath (prev, endKey) {
  const out = []
  let k = endKey
  while (k != null && prev.has(k)) {
    const [x, y, z] = k.split(',').map(Number)
    out.unshift({ x, y, z })
    k = prev.get(k)
  }
  return out
}

function waterNote (best, pool) {
  const what = WATER_KIND_TEXT[best.kind] ?? best.kind
  const dry = pool.filter((c) => c.kind === 'dry').length
  const breath = pool.filter((c) => c.kind === 'breath').length
  const tail = best.kind === 'breath'
    ? '—— ⚠️ 这是**空气口袋**，只是中间目标，别当已经上岸'
    : (best.kind === 'passage' ? '—— ⚠️ 这只是**脱离眼前的死路**，不代表安全' : '')
  return `找到 ${what}，${best.distance} 格外（这轮还看到 干燥 ${dry} 个 / 空气 ${breath} 个）${tail}`
}

/* ─────────── 小工具 ─────────── */

/** 机器人脚底那格（`entity.position` 是脚中心，带 .5 偏移） */
export function feetOfBot (b) {
  const p = b?.entity?.position
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return null
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) }
}

/** 人现在是不是泡在水里（脚那格或头那格是水）—— 和 `world-observer.mjs` 的 `inWaterNow` 同源思路 */
export function inWaterAt (b, feet = null) {
  const f = feet ?? feetOfBot(b)
  if (!f) return false
  return cellKindAt(b, f.x, f.y, f.z) === 'water' || cellKindAt(b, f.x, f.y + 1, f.z) === 'water'
}

/** 一句话摘要（给日志 / `agent.steer` 文案用） */
export function waterSummaryOf (res) {
  if (!res || !res.found) return res?.note ?? '没找到出口'
  const t = res.target
  return `${WATER_KIND_TEXT[res.kind] ?? res.kind} @ (${t.x},${t.y},${t.z})，${res.distance} 格，路线 ${res.path.length} 步`
}

/** 危险方块的中文名（转出去给 AI 看，别让它读英文） */
export { fatalText }
