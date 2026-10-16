/**
 * 可以在 Worker 线程里跑的**纯计算**任务。
 *
 * 这个文件是**叶子**：只 import `block-names.mjs`，不碰 `core.mjs`、不碰 mineflayer、
 * 不碰控制位、不打 console。主线程和 Worker 线程**import 的是同一个文件**
 * （`src/worker-entry.mjs` 也 import 它）—— 一份实现两处用，不许各写一份。
 *
 * 为什么单独一个文件：搬进 Worker 的函数必须是"给数据就能算、不依赖 bot 对象"的。
 * 凡是需要 `bot.blockAt()` 的（比如扫地形）**都搬不动** —— 那是主线程的活。
 */
import { colorOf } from './block-names.mjs'

/**
 * 字符网格 → RGBA 像素图（最近邻放大 + 自己那一格画白框）。
 *
 * 入参刻意只用**可转移**的东西：
 * - `idx`：`Uint16Array`，每个格子一个"调色板下标"（-1 表示没有）
 * - `palette`：`string[]`，下标 → 方块名（一般只有几种）
 * - `rgba` 是返回值里的 `Uint8Array`，可以零拷贝转移回主线程
 *
 * 原来这段是 `map-render.mjs` 里 `mapImageOf()` 的内层循环。拆出来是因为
 * **它才是整条链上唯一既费 CPU、又不需要 bot 的部分**（2026-10-15 实测：
 * `radius:96, scale:16` ⇒ 3072×3072 = 943 万像素，纯循环 28.2ms、整条 36.1ms）。
 * 主线程扫地形那部分（`blockAt` 百万次）搬不动，也不该搬。
 */
export function rgbaOfNames ({ idx, palette, width, height, scale, markSelf = true }) {
  const w = Math.max(0, Math.floor(Number(width) || 0))
  const h = Math.max(0, Math.floor(Number(height) || 0))
  const s = Math.min(Math.max(Math.floor(Number(scale) || 1), 1), 16)
  if (!w || !h) throw new Error('地形数据为空（区块可能还没加载）')

  // 先算好调色板里每种颜色的 RGB（每种只算一次，而不是每格算一次）
  const pal = new Uint8Array(palette.length * 3)
  for (let i = 0; i < palette.length; i++) {
    const [r, g, b] = colorOf(palette[i])
    pal[i * 3] = r; pal[i * 3 + 1] = g; pal[i * 3 + 2] = b
  }

  const W = w * s
  const H = h * s
  const rgba = new Uint8Array(W * H * 4)

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = idx[y * w + x]
      let r = 0; let g = 0; let b = 0
      if (k >= 0 && k * 3 + 2 < pal.length) { r = pal[k * 3]; g = pal[k * 3 + 1]; b = pal[k * 3 + 2] }
      for (let dy = 0; dy < s; dy++) {
        const rowBase = (y * s + dy) * W
        for (let dx = 0; dx < s; dx++) {
          const o = (rowBase + x * s + dx) * 4
          rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b; rgba[o + 3] = 255
        }
      }
    }
  }

  // 自己：中心格画白色外框（内芯保留原色，便于看清脚下是什么）
  if (markSelf) {
    const cx = Math.floor(w / 2) * s
    const cy = Math.floor(h / 2) * s
    const put = (px, py) => {
      if (px < 0 || py < 0 || px >= W || py >= H) return
      const o = (py * W + px) * 4
      rgba[o] = 255; rgba[o + 1] = 255; rgba[o + 2] = 255; rgba[o + 3] = 255
    }
    for (let d = 0; d < s; d++) {
      put(cx + d, cy)
      put(cx + d, cy + s - 1)
      put(cx, cy + d)
      put(cx + s - 1, cy + d)
    }
  }

  return { width: W, height: H, rgba }
}

/** 任务名 → 实现。主线程（退路）和 Worker 线程（`worker-entry.mjs`）都查这张表。 */
export const WORKER_TASKS = { rgbaOfNames }
