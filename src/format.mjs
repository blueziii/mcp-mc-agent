// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / format.mjs —— **纯函数**：把内部值转成"能给人看 / 能进 JSON"的形状
 * ---------------------------------------------------------------------------
 * 这是用户 2026-10-08 路线图第 ④ 条（"渐进拆分 `src/core.mjs`：**先抽纯函数**，再实体/背包/感知，
 * 移动和挖掘最后拆；每次只迁一个模块"）的**第一刀**。
 *
 * 为什么先挑这三个：
 *   · `lossless()`  —— 递归纯函数，谁都不依赖（只碰 JS 内建类型）；
 *   · `redactPath()` / `resolveStateHome()` —— 只读环境变量与 `node:path`，不碰 bot、不碰网络。
 * 三者共同点是**没有 `this`、没有事件、没有异步**：搬走之后 `core.mjs` 的行为一字不变，
 * 出错也只会"导入就报错"，不会变成"跑一半才出的怪事"。
 *
 * 迁移规矩（后面继续拆时照这个来）：
 *   1. `core.mjs` 里**保留同名导出**（`export { … } from './format.mjs'`），外部 import 一行都不用改；
 *   2. 一次只搬一个模块，搬完立刻 `node --check` + 把 core.mjs 导入一遍，确认导出还在；
 *   3. 移动和挖掘（`#walkPathfinder`/`dig`）**最后再拆** —— 它们共享 `_moveGen`、控制位租约、
 *      预算和事件监听，是最容易拆坏的部分。
 */
import { join, sep } from 'node:path'
import { homedir } from 'node:os'
import { STATE_DIR_NAME } from './config.mjs'

/** 插件状态目录的家：`MCP_MC_AGENT_STATE_DIR` → `MCP_MC_AGENT_DIR`（自检隔离）→
 *  `MCP_MC_AGENT_HOME/.mcp-mc-agent` → `~/.mcp-mc-agent`
 *
 * 🔴 2026-10-16 审计：这里原来读的是 `DSH_HOME`（DSH 版遗留）⇒ **MCP 版脱敏的锚点找错了地方**：
 *    真实状态目录是 `~/.mcp-mc-agent`，而它按 `~/.dsh` 去切前缀 ⇒ 一条路径都切不掉、
 *    主机用户名照样原样进工具返回。同时 `plugins.mjs` 也拿它去拼 `~/.dsh/profiles/<名字>/vendor/...`
 *    （MCP 下根本没有 profiles 这回事，纯空转）。现在按 MCP 自己的规矩来。
 *
 * 🔴 2026-10-16 第二次：目录名**不能在这里再写一遍** —— `config.mjs` 那边写的是没有点的
 *    `'mcp-mc-agent'`，两边一岔开，脱敏锚点又指到了不存在的目录（同一个坑摔两次）。
 *    名字改成从 `config.mjs` import `STATE_DIR_NAME`，只有一处出处。
 */
export function resolveStateHome () {
  const explicit = String(process.env.MCP_MC_AGENT_STATE_DIR ?? '').trim()
  if (explicit) return explicit
  const isolated = String(process.env.MCP_MC_AGENT_DIR ?? '').trim()
  if (isolated) return isolated
  const fromEnv = String(process.env.MCP_MC_AGENT_HOME ?? '').trim()
  if (fromEnv) return join(fromEnv, STATE_DIR_NAME)
  try { return join(homedir(), STATE_DIR_NAME) } catch { return join(process.cwd(), STATE_DIR_NAME) }
}

/**
 * 把绝对路径里的状态目录换成 `$MCP_MC_AGENT_STATE_DIR`（审计报告 F12）。
 * `mc_capabilities` 以前直接回绝对路径 ⇒ 把主机用户名写进工具返回、进而进对话记录。
 * 换成占位符后信息量不变（模型可以用环境变量解析），但不再泄露家目录。
 */
export function redactPath (p) {
  const s = String(p ?? '')
  if (!s) return s
  const home = resolveStateHome()
  if (!home) return s
  if (s === home) return '$MCP_MC_AGENT_STATE_DIR'
  if (s.startsWith(home + sep) || s.startsWith(home + '/') || s.startsWith(home + '\\')) {
    return '$MCP_MC_AGENT_STATE_DIR/' + s.slice(home.length + 1).replace(/\\/g, '/')
  }
  return s
}

/**
 * 把任意返回值转成"无损 JSON"（宿主要求无损；mineflayer 到处返回 Vec3 之类的类实例）。
 *
 * 规则：类实例 → 只取自有可枚举属性；Map/Set → 普通对象/数组；循环引用 → '[circular]'；
 * NaN/±Infinity → null；-0 → 0；undefined/函数/symbol → 丢掉该键（数组里补 null）。
 *
 * 🔴 它**只递归、不 import 任何东西**，所以是最适合先搬出来的一块。
 */
export function lossless (value, seen = new WeakSet()) {
  if (value === null) return null
  const t = typeof value
  if (t === 'number') {
    if (!Number.isFinite(value)) return null
    return Object.is(value, -0) ? 0 : value
  }
  if (t === 'bigint') return value.toString()
  if (t === 'string' || t === 'boolean') return value
  if (t !== 'object') return undefined          // undefined / function / symbol
  if (seen.has(value)) return '[circular]'
  seen.add(value)
  /* 🟡 2026-10-15 审计（报告 E 第 4 条）：原来只 `add` 从不 `delete`，而 `seen` 是**整棵树共用**
   *   的 —— 于是兄弟位置复用同一个对象（mineflayer 到处是这种：同一个 Vec3 挂给两个字段、
   *   数组里同一个实例出现两次）会被误判成循环引用，输出假的 `'[circular]'`。
   *   递归回来就把自己摘掉：只有"**祖先链**上出现过"才叫循环。
   *   （`src/tool-def.mjs:174` 那处一直是对的，这里与它对齐。） */
  try {
    if (value instanceof Date) return value.toISOString()
    if (Array.isArray(value)) {
      return value.map((v) => {
        const s = lossless(v, seen)
        return s === undefined ? null : s
      })
    }
    if (value instanceof Map) return lossless(Object.fromEntries([...value].map(([k, v]) => [String(k), v])), seen)
    if (value instanceof Set) return lossless([...value], seen)
    const out = {}
    // 只取自有可枚举属性：类实例的 getter/原型方法/私有字段一并丢掉
    for (const [k, v] of Object.entries(value)) {
      const s = lossless(v, seen)
      if (s !== undefined) out[k] = s
    }
    return out
  } finally { seen.delete(value) }
}
