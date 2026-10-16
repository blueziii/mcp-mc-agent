/**
 * **vendor 依赖加载器**（路线图第 ④ 条第二十八刀：从 `src\core.mjs` 搬出来的）。
 *
 * 这一层负责两件事（本来就是一件事）：**把 PrismarineJS 生态那几个现成插件找出来**、**把它们挂到 bot 上**。
 * `MC_DEPS`（清单）、`loadMcDep(key, opts)`（找 + 缓存**成功**）、`loadPathfinder()`（兼容旧名字）、
 * `setupPathfinder(self, opts)` / `movements(self)` / `setupPlugins(self, opts)`（第二十九刀搬进来的装配）、
 * `resetMcDepCache()` / `resetPathfinderCache()`（自检脚本用）。
 *
 * 三条约定：
 *   ① **不反向 import `core.mjs`**；只借 `node:fs` / `node:path` / `node:url` 与 `format.mjs` 的 `resolveStateHome`。
 *   ② **只缓存成功**：找不到时每次调用都重新试一遍（修好 vendor 树后下一次连接就能加载上，不用重启 DSH）。
 *   ③ 相对路径 `../../../vendor/mc-deps/...` 是按**本文件位置**算的 —— 本文件与 `core.mjs` 同在 `src/`，
 *      所以搬过来之后这条相对路径仍然对；但 junction / 符号链接安装时它会落到 `.pnpm` 深路径上，
 *      所以另有"按 `$DSH_HOME\profiles\<profile>\vendor\mc-deps` 绝对路径找"那条兜底。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveStateHome } from './format.mjs'
import { scaffoldingItemIds } from './place-items.mjs'
import { patchDigTime } from './dig-speed.mjs'
import { applyProfile, classifyTerrainCached, profileFor } from './terrain.mjs'
import { avoidBlockIds } from './bridge.mjs'
/**
 * ── 现成的 mineflayer 生态插件（PrismarineJS 官方/社区项目；**这些都不自己写**） ──────
 *
 * 用户 2026-10-06 要求："应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动。"
 * 之后又要求把「自动吃 / 捡东西 / 挖方块 / 换工具 / 打怪」也换成现成的项目。
 *
 * | 键 | 包 | 干什么 |
 * | --- | --- | --- |
 * | `pathfinder` | mineflayer-pathfinder | A* 寻路 + 挖穿挡路方块 + 垫 1×1 塔 + 卡住检测 |
 * | `collectBlock` | mineflayer-collectblock | 走过去挖方块 / 捡掉落物（内部自己换工具） |
 * | `tool` | mineflayer-tool | 按方块选并换上最好的工具 |
 * | `pvp` | mineflayer-pvp | 追击并打怪（近战节奏自己算） |
 * | `autoEat` | mineflayer-auto-eat | 饿了自动吃（自己挑食物、吃完换回原手上的东西） |
 *
 * 装法见 `mcp-mc-agent/PATHFINDER.md`：装到 `<profile>\vendor\mc-deps`（**不碰宿主的 node_modules**，
 * 免得 pnpm 一重装就把 readable-stream 那个补丁冲掉）。这里按顺序找：
 *   ① `MCP_MC_AGENT_MC_DEPS`（给"装依赖的目录"，可含 node_modules）② 插件包旁边的 vendor 树
 *   ③ 裸包名（宿主自己装了就能解析到）。找不到 = 那一项能力没有，其它照旧。
 */
export const MC_DEPS = {
  pathfinder: { pkg: 'mineflayer-pathfinder', entry: 'index.js', label: '寻路 mineflayer-pathfinder（A* + 挖穿 + 垫脚 + 卡住检测）' },
  collectBlock: { pkg: 'mineflayer-collectblock', entry: 'lib/index.js', label: '挖/捡 mineflayer-collectblock（走过去挖方块、捡掉落物）' },
  tool: { pkg: 'mineflayer-tool', entry: 'lib/index.js', label: '换工具 mineflayer-tool（按方块挑最好的工具）' },
  pvp: { pkg: 'mineflayer-pvp', entry: 'lib/index.js', label: '打怪 mineflayer-pvp（追击 + 近战节奏）' },
  autoEat: { pkg: 'mineflayer-auto-eat', entry: 'dist/index.js', label: '自动吃 mineflayer-auto-eat' },
}

const DEP_OFF = /^(off|0|false|no|none)$/i
const _depCache = new Map()

/**
 * `import()` 出来的模块可能是 CJS 也可能是 ESM，具名导出还不全 ——
 * 既看具名导出也看 `default`，按名字顺序取第一个拿到的。
 */
function pickExport (mod, names) {
  const d = mod?.default ?? {}
  for (const n of names) {
    const v = mod?.[n] ?? d?.[n]
    if (v !== undefined && v !== null) return v
  }
  return undefined
}

/**
 * 找一个 vendor 依赖并 `import()` 它。**只缓存成功**：找不到时每次调用都重新试一遍。
 * （踩过的坑：以前把"找不到"也缓存了，结果在 vendor 树里修好文件之后，
 *   进程内再也等不到重试 —— 只能重启 DSH。失败重试很便宜，只在连接时发生。）
 * @param {'pathfinder'|'collectBlock'|'tool'|'pvp'|'autoEat'} key
 * @param {{log?:Function, logWarn?:Function, spec?:string}} opts
 *   `log` = 成功细节（调用方一般传 `logDebug`，默认看不见）；`logWarn` = 失败/形状不对（info，真出问题时要看得见）
 * @returns {Promise<any>} pathfinder 返回 `{pathfinder,Movements,goals}`；其它返回 `loadPlugin` 要的那个函数；找不到返回 null
 */
export async function loadMcDep (key, { log = null, logWarn = null, spec = null } = {}) {
  if (_depCache.has(key)) return _depCache.get(key)
  const info = MC_DEPS[key]
  if (!info) throw new Error(`未知的 vendor 依赖：${key}（可用：${Object.keys(MC_DEPS).join(' / ')}）`)
  const raw = spec ?? process.env.MCP_MC_AGENT_MC_DEPS ?? null
  const cands = []
  if (raw && !DEP_OFF.test(String(raw).trim())) {
    const s = String(raw).trim()
    if (/\.(m?js|cjs)$/i.test(s)) cands.push(/^[a-zA-Z]:[\\/]|^\//.test(s) ? pathToFileURL(s).href : s)
    else {
      // 当成"装依赖的目录"：目录本身 / 目录/node_modules 里都能找
      for (const p of [
        join(s, info.pkg, info.entry),
        join(s, 'node_modules', info.pkg, info.entry),
        join(s, info.entry),
      ]) if (existsSync(p)) cands.push(pathToFileURL(p).href)
      if (!cands.length) cands.push(s)
    }
  }
  /* ① 相对本文件找随包 vendor 树（`<包>/vendor/mc-deps/node_modules/...`）。
   * 🔴 2026-10-16 审计：这条以前是**无条件 push** —— 路径不存在也进候选，靠 `import()`
   *    失败再往下试，于是**每次连服都在日志里刷 5 行**「候选不可用（file:///…/vendor/mc-deps/…）：
   *    ERR_MODULE_NOT_FOUND」。找不到的候选没有任何信息量，先 `existsSync` 再进列表。
   *    这一条同时覆盖两种装法：包目录是真目录，或是 `node_modules/.pnpm/<name>@file+.../`
   *    那种深路径（往上三层都不是包根时自然就不存在，不会误报）。 */
  try {
    const rel = fileURLToPath(new URL(`../../../vendor/mc-deps/node_modules/${info.pkg}/${info.entry}`, import.meta.url))
    if (existsSync(rel)) cands.push(pathToFileURL(rel).href)
  } catch {}
  /* ② 状态目录下的 vendor 树：`<状态目录>/vendor/mc-deps/node_modules/...`。
   *    给"不想把这些 mineflayer 插件写进 package.json 依赖、又不想用
   *    `MCP_MC_AGENT_MC_DEPS` 指路"的人留一个固定落点（DSH 版是 `$DSH_HOME/profiles/<名字>/vendor/`，
   *    MCP 下没有 profiles 这个概念，锚点换成状态目录）。 */
  try {
    const p = join(resolveStateHome(), 'vendor', 'mc-deps', 'node_modules', info.pkg, info.entry)
    if (existsSync(p)) cands.push(pathToFileURL(p).href)
  } catch {}
  cands.push(info.pkg)                        // 宿主自己装了也能解析到
  for (const c of cands) {
    const where = c.startsWith('file:') ? 'vendor 树' : c
    try {
      const m = await import(c)
      if (key === 'pathfinder') {
        // ⚠️ 它是 CJS：`import()` 出来的具名导出**不全**（实测只有 Movements/pathfinder，
        //    `goals` 只在 default 上）—— 所以两边都要看，凑成一个完整对象。
        const mod = {
          pathfinder: pickExport(m, ['pathfinder']),
          Movements: pickExport(m, ['Movements']),
          goals: pickExport(m, ['goals']),
        }
        if (mod.pathfinder && mod.Movements && mod.goals) {
          _depCache.set(key, mod)
          log?.(`已找到现成的${info.label}（${where}）`)
          return mod
        }
        ;(logWarn ?? log)?.(`pathfinder 候选不是预期的模块：${c}`)
        continue
      }
      // 其余插件：入口就是 `bot.loadPlugin()` 要的那个函数
      // （collectblock/tool/pvp 的 CJS 导出叫 `plugin`，auto-eat 的 ESM 导出叫 `loader`）
      const fn = pickExport(m, ['plugin', 'loader'])
      if (typeof fn === 'function') {
        _depCache.set(key, fn)
        log?.(`已找到现成的${info.label}（${where}）`)
        return fn
      }
      ;(logWarn ?? log)?.(`${key} 候选不是预期的模块：${c}`)
    } catch (e) {
      ;(logWarn ?? log)?.(`${key} 候选不可用（${c.startsWith('file:') ? c.slice(0, 60) + '…' : c}）：${e?.code ?? e?.message}`)
    }
  }
  // 故意不缓存失败：修好 vendor 树后，下一次连接（不用重启 DSH）就能加载上
  return null
}

/**
 * 兼容旧名字：只要寻路插件。`MCP_MC_AGENT_PATHFINDER` 仍然只影响"显式指定的那一路"，
 * 真正的开关是配置里的 `pathfinder: false`（见 `setupPathfinder`）。
 */
export async function loadPathfinder ({ log = null, logWarn = null, spec = null } = {}) {
  const raw = spec ?? process.env.MCP_MC_AGENT_PATHFINDER ?? null
  return await loadMcDep('pathfinder', { log, logWarn, spec: raw })
}

/** 测试用：清掉已成功的缓存（失败本来就不缓存，真机不需要调） */
export function resetPathfinderCache () { _depCache.delete('pathfinder') }
/** 测试用：清掉所有 vendor 依赖的成功缓存 */
export function resetMcDepCache () { _depCache.clear() }

/**
 * 挂上**现成的**寻路插件（mineflayer-pathfinder）。没装上只是"没有它"，其它功能照旧。
 *
 * 为什么用它：用户 2026-10-06 说"应该有写好的防卡住项目，现在它会一直跳来跳去，完全是瞎动"。
 * 手写的那套（按住前进 + 卡住就跳/挖/垫）在真机就是瞎动；pathfinder 是 A* + 自动挖/垫/绕路，
 * 自带卡住检测（3.5s 没进展 → `path_reset('stuck')`）和 noPath 判定。见文件顶部 `loadPathfinder`。
 */
export async function setupPathfinder (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return false
  if (self.cfg.pathfinder === false) { self.pfReady = false; return false }
  const mod = await loadPathfinder({ log: (m) => self.logDebug(m), logWarn: (m) => self.log(m), spec })
  if (!mod) {
    self.pfReady = false
    self.log('没有可用的 mineflayer-pathfinder（见 mcp-mc-agent/PATHFINDER.md）→ 所有移动已停止，避免盲跳')
    return false
  }
  try {
    if (typeof b.pathfinder?.goto !== 'function') b.loadPlugin(mod.pathfinder)
    // 想路线的预算：服务器卡顿时别想太久；搜索半径别放到无限。
    // 🔴 4000 太短了 —— 2026-10-06 实机挖树时频繁 "Took to long to decide path to goal!"，
    //    collectBlock 因此整批失败（改成逐个喂之后至少不会再一坏全坏）。8000 让"目标在高处、
    //    要垫脚才够得着"这类难想的目标有机会想出来，同时仍能及时放弃。
    b.pathfinder.thinkTimeout = Number(self.cfg.pfThinkTimeoutMs ?? 8000)
    b.pathfinder.tickTimeout = 40
    b.pathfinder.searchRadius = Number(self.cfg.pfSearchRadius ?? 192)
    self._pf = mod
    self.pfReady = true
    return true
  } catch (e) {
    self.log('pathfinder 挂载失败：' + e.message)
    self.pfReady = false
    return false
  }
}

/**
 * 造一份 `Movements`（走路 / 寻路 / collectBlock / pvp 共用同一套配置，
 * 免得"我走的时候不乱跳、插件走的时候乱跳"）。
 *
 * `terrain` 是 `classifyTerrain()` 的结果（`src/terrain.mjs`，导航 P2）——
 * 给了它就**按地形挑权重**（台阶上挖便宜一点、沟边垫方块便宜一点、岩浆边一格都不许跳），
 * 不给就退回平地那套（= 改动前的全局值）。用户显式配置永远优先（见 `profileFor` 的 `over`）。
 */
export function movements (self, { terrain = null } = {}) {
  const b = self.bot
  const { Movements } = self._pf ?? {}
  if (typeof Movements !== 'function') return null
  const mv = new Movements(b)
  // 地形档案（导航 P2）：先铺一套，再用下面那几行把"跟地形无关的"补上
  const profile = profileFor(terrain?.kind ?? 'unknown', self.cfg)
  mv.canDig = self.cfg.walkCanDig !== false        // 挡路的方块可以挖穿（不然掉坑里出不来）
  mv.allowSprinting = true
  mv.dontMineUnderFallingBlock = true
  /* 危险方块进寻路黑名单（mc_map 第二轮）：`blocksToAvoid` 决定"这格能不能站"
   * （`movements.js:233` 的 `b.safe`），上游只放了 fire/cobweb/web/lava ——
   * 把仙人掌 / 细雪 / 甜浆果丛 / 岩浆块 / 营火补上，A* 会主动绕开。 */
  for (const id of avoidBlockIds(b)) mv.blocksToAvoid.add(id)
  // 垫方块（pathfinder 的 scaffolding）：上游默认 `placeCost = 1`，比挖一格（4）还便宜 4 倍
  // ⇒ A* 有得垫就垫，下坡时表现为"横向往行进方向垫方块"（`movements.js:372-385` 的
  // `getMoveForward`：斜前方下面那格是空气就计划 toPlace）。平地上调高到 12，让它变成最后手段：
  // 掉进 1 格坑里垫出来那种仍然会垫（那时只有这一条路），下坡时改成绕路 / 挖穿。
  // ⚠️ 不能靠清空 `scafoldingBlocks` 来治 —— `remainingBlocks === 0` 会把
  // `getMoveUp`（1×1 柱子）那条路一起剪掉，机器人就爬不出坑了。
  applyProfile(mv, profile)
  mv.scafoldingBlocks = scaffoldingItemIds(b)      // 背包里能垫的方块（**item id**，见该函数注释）
  return mv
}

/**
 * 按当前地形**重挂**一份 `Movements`（`b.pathfinder.setMovements`），返回
 * `{ terrain, profile, changed }`；没挂上 pathfinder 就回 `null`。
 *
 * 这是"地形变了就换策略"的唯一入口 —— `src/movement.mjs` 每次走路前调它。
 */
export function adaptMovements (self, { feet = null, radius = null } = {}) {
  const b = self.bot
  if (!b?.pathfinder || typeof b.pathfinder.setMovements !== 'function') return null
  if (!self.pfReady) return null
  const terrain = radius == null ? classifyTerrainCached(b, { feet }) : classifyTerrainCached(b, { feet, radius })
  const mv = movements(self, { terrain })
  if (!mv) return null
  try { b.pathfinder.setMovements(mv) } catch { return null }
  const profile = profileFor(terrain.kind, self.cfg)
  return { terrain, profile, mv }
}

/**
 * 把**现成的**生态插件都挂上（`MC_DEPS` 里那几个）。缺哪个只是少那项能力，其它照旧。
 *
 * 顺序有依赖：pathfinder 必须最先（collectBlock / pvp 都要用它的 `Movements`）。
 * 用户 2026-10-06 的要求："不要自己写，用现成的项目" —— 走路/挖/捡/换工具/打怪/吃饭
 * 全部交给 PrismarineJS 生态，`core.mjs` 只留编排和"诚实报错"。
 */
export async function setupPlugins (self, { spec = null } = {}) {
  const b = self.bot
  if (!b) return { pathfinder: false }
  const out = { pathfinder: false, collectBlock: false, tool: false, pvp: false, autoEat: false }
  // 成功细节（"找到了哪个文件"）走 debug：依赖横幅原来每个连接重打一遍，占全日志 31.5%
  const log = (m) => self.logDebug(m)
  const logWarn = (m) => self.log(m)      // 候选不可用 / 形状不对：真出问题时要看得见
  out.pathfinder = await setupPathfinder(self, { spec }).catch((e) => { self.log('pathfinder 初始化异常：' + e.message); return false })
  const mv = self.pfReady ? movements(self) : null

  // ① 走过去挖方块 / 捡掉落物（内部自己用 mineflayer-tool 换工具）
  try {
    const fn = await loadMcDep('collectBlock', { log, logWarn })
    if (fn) {
      if (typeof b.collectBlock?.collect !== 'function') b.loadPlugin(fn)
      if (mv && b.collectBlock) b.collectBlock.movements = mv
      out.collectBlock = typeof b.collectBlock?.collect === 'function'
    }
  } catch (e) { self.log('collectBlock 挂载失败：' + e.message) }

  // ② 按方块挑最好的工具（dig 会用它）
  try {
    const fn = await loadMcDep('tool', { log, logWarn })
    if (fn) {
      if (typeof b.tool?.equipForBlock !== 'function') b.loadPlugin(fn)
      out.tool = typeof b.tool?.equipForBlock === 'function'
    }
  } catch (e) { self.log('tool 挂载失败：' + e.message) }

  // ③ 追击并打怪
  try {
    const fn = await loadMcDep('pvp', { log, logWarn })
    if (fn) {
      if (typeof b.pvp?.attack !== 'function') b.loadPlugin(fn)
      if (mv && b.pvp) b.pvp.movements = mv
      out.pvp = typeof b.pvp?.attack === 'function'
    }
  } catch (e) { self.log('pvp 挂载失败：' + e.message) }

  // ④ 饿了自动吃（**默认不开自动**：由 mc_auto 按自己的开关决定，免得两套逻辑抢）
  try {
    const fn = await loadMcDep('autoEat', { log, logWarn })
    if (fn) {
      if (!b.autoEat) b.loadPlugin(fn)
      if (b.autoEat?.setOpts) {
        b.autoEat.setOpts({
          priority: 'foodPoints',
          minHunger: Number(self.cfg.autoEatAt ?? 14),
          minHealth: 0,
          returnToLastItem: true,
          offhand: false,
          eatingTimeout: 10_000,
          strictErrors: false,
        })
      }
      b.autoEat?.disableAuto?.()
      out.autoEat = typeof b.autoEat?.eat === 'function'
    }
  } catch (e) { self.log('autoEat 挂载失败：' + e.message) }

  self.mcPlugins = out
  /* ⑤ 修 `bot.digTime`：它是**实际挖掘时长**（不是估算），而上游数据把 108 个"要石镐以上"的方块的
   *    material 写成了 `incorrect_for_wooden_tool` ⇒ 铁矿不管拿什么镐都按 4550ms 挖（真值 750ms）。
   *    见 `src\dig-speed.mjs` 的 `fixDigMs` / `patchDigTime` 注释。失败不影响别的功能。 */
  try { patchDigTime(b) } catch (e) { self.log('修 digTime 失败（不影响其它功能）：' + e.message) }
  const have = Object.entries(out).filter(([, v]) => v).map(([k]) => k)
  // 每个连接都会重打一遍（每个连接是新的模块实例）⇒ 进程内只留一行
  self.logOnce('deps-ready', `现成插件就绪：${have.length ? have.join(' / ') : '（一个都没有）'}`)
  return out
}
