/**
 * mcp-mc-agent / mcp/content.mjs —— 工具返回值 → **MCP content blocks**
 * ============================================================================
 * 从 `server.mjs` 里抽出来的（抽出来才能离线单测：见 `tools/check-mcp-content.mjs`）。
 * 这一层是 server 与"客户端能不能收下这次 tools/call"之间的**最后一道关**：
 * MCP 对 `content[]` 里的每个块都有**严格的 schema**，形状不对的块会让客户端把
 * **整条 `tools/call` 结果**判成 `-32602` 扔掉 —— 连前面那些好块一起。
 *
 * 🔴 为什么必须挡住 `{type:'image', attachment}`（2026-10-16 实机踩到）：
 *   工具自带的 `output.render()` 是照 **DSH 宿主**的约定写的，DSH 那边图片长这样：
 *       `{ type:'image', attachment:{ id, name, mediaType, bytes } }`
 *   而 **MCP 的 image 块只认 `{ type:'image', data:<base64 字符串>, mimeType }`** ——
 *   没有 `attachment` 这个字段，`data` 也必须是字符串。
 *   照搬过来 ⇒ 客户端校验失败 ⇒ `mc_observe`（**默认参数**就会画图）一进游戏就报
 *   `MCP error -32602: Invalid tools/call result`，而这个工具恰恰是"看一眼世界"的主力。
 *   真图片走的是 `attachments.saveImage()` → `images` 参数这条路（下面第二个循环），
 *   形状本来就是对的 —— 所以这类"只有 attachment、没有 data"的块**直接丢掉**，
 *   不会少任何东西。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/** MCP 的 image 块只认这几种（SVG 是文本，客户端不会渲染，所以不当图片处理） */
export const IMAGE_MIME = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif',
}

/** 单张内联图片的字节上限（超了就只留路径 + 一句说明，别把上下文撑爆） */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

export function mimeOfFile (p) {
  const m = /\.([a-z0-9]+)$/i.exec(String(p))
  return IMAGE_MIME[`.${(m?.[1] ?? '').toLowerCase()}`] ?? 'image/png'
}

export function safeJson (v) {
  try {
    if (v === undefined) return '(undefined)'
    return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
  } catch { return String(v) }
}

/**
 * 从工具返回值里捞出"指向图片文件"的路径。
 *
 * 只看几个约定字段（`file` / `path` / `image.file`），不递归整个对象 ——
 * 工具的返回值里有大量无关的字符串（方块名、玩家名），全树扫会误伤。
 * 相对路径按 `cwd`（server 的工作目录）解析 —— `mc_map` 回的是工作区相对路径。
 */
export function findImageFiles (value, cwd = process.cwd()) {
  const out = []
  const seen = new Set()
  const push = (p) => {
    if (typeof p !== 'string' || !p.trim()) return
    const ext = /\.([a-z0-9]+)$/i.exec(p.trim())?.[1]?.toLowerCase()
    if (!ext || !(ext in { png: 1, jpg: 1, jpeg: 1, webp: 1, gif: 1 })) return
    const abs = isAbsolute(p) ? p : resolve(cwd, p)
    if (seen.has(abs)) return
    seen.add(abs)
    out.push(abs)
  }
  const nodes = [value, value?.image, value?.result, value?.data]
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue
    push(n.file)
    push(n.path)
    push(n.image)
  }
  /* 一次调用最多内联 4 张：多到那个份上基本是误用，而且会把上下文撑爆 */
  return out.slice(0, 4)
}

/**
 * 这个块客户端收不收得下？
 *
 * 只做**最小必要**的形状检查（MCP 只认 text / image / resource 三种带 `type` 的块，
 * 且各自有必填字段）。不合规的一律**降级成 text** 或丢掉 —— 宁可少一张图，
 * 也不能让整条 `tools/call` 被判 `-32602`（那会连文字结果一起丢）。
 */
export function blockOk (b) {
  if (!b || typeof b !== 'object' || typeof b.type !== 'string') return false
  if (b.type === 'text') return typeof b.text === 'string'
  if (b.type === 'image') return typeof b.data === 'string' && typeof b.mimeType === 'string'
  if (b.type === 'resource') return b.resource && typeof b.resource === 'object'
  /* 别的（audio / 未来新增的）不猜：一律降级 */
  return false
}

/**
 * 把工具返回值渲染成 MCP content blocks。
 *
 * `mcp-mc-agent` 的每个工具都带 `output.render(args, value)`，返回值**本来就是**
 * `[{type:'text', text}]`（见 index.js 的 `text()` helper）—— 也就是说工具结果
 * 早就是 MCP 形状了，这里只是**挡掉 DSH 形状的图片块**、补上真图片、再做点防御。
 *
 * @param {object}   o
 * @param {object}   o.tool     工具定义（用它的 `output.render`）
 * @param {object}   o.args     本次调用入参
 * @param {*}        o.value    工具返回值
 * @param {Array}    [o.images] 调用期间 `attachments.saveImage()` 收到的图（`{data, mediaType, name}`）
 * @param {string}   [o.cwd]    解析相对图片路径用的工作目录
 * @param {Function} [o.log]    日志（可省）
 * @param {boolean}  [o.verbose] 详细日志
 */
export function renderContent ({ tool, args, value, images = [], cwd = process.cwd(), log = () => {}, verbose = false } = {}) {
  const blocks = []
  let rendered
  try {
    rendered = tool?.output?.render?.(args, value)
  } catch (e) {
    rendered = null
    blocks.push({ type: 'text', text: `（结果渲染失败：${e?.message ?? e}）\n${safeJson(value)}` })
  }
  if (Array.isArray(rendered)) {
    for (const b of rendered) {
      if (!b || typeof b !== 'object' || typeof b.type !== 'string') {
        blocks.push({ type: 'text', text: String(b) })
        continue
      }
      /* 🔴 DSH 形状的图片块（只有 `attachment`，没有 `data`）：MCP 不认，丢掉。
       *    真图片在下面 `images` 那段，形状本来就是对的。 */
      if (b.type === 'image' && !b.data) {
        if (verbose) log(`丢掉一个 DSH 形状的 image 块（attachment=${b.attachment?.id ?? b.attachment ?? '?'}）`)
        continue
      }
      if (!blockOk(b)) {
        blocks.push({ type: 'text', text: safeJson(b) })
        continue
      }
      blocks.push(b)
    }
  } else if (rendered !== undefined && rendered !== null) {
    blocks.push({ type: 'text', text: typeof rendered === 'string' ? rendered : safeJson(rendered) })
  } else if (blocks.length === 0) {
    blocks.push({ type: 'text', text: safeJson(value) })
  }
  /* 图片：桩在调用期间从 `attachments.saveImage` 收的（见 host.mjs） */
  for (const img of images) {
    try {
      blocks.push({ type: 'image', data: Buffer.from(img.data).toString('base64'), mimeType: img.mediaType || 'image/png' })
    } catch (e) { log(`图片转 base64 失败（${img?.name}）：${e?.message ?? e}`) }
  }
  /* 兜底：`mc_kit_image` 这类工具**不经过 attachments**（它只把 PNG 落盘 + 回一个路径）。
   * DSH 那边靠 Web GUI 的「发布区」把文件端给用户，MCP 没有那一层 ——
   * 所以这里把结果里指向的图片文件直接内联成 image 块，等价于"给用户看"。
   * 只在上面没收到图片时做，避免 mc_map / mc_observe 重复内联。 */
  if (!images.length) {
    for (const f of findImageFiles(value, cwd)) {
      try {
        const buf = readFileSync(f)
        if (buf.length > MAX_INLINE_IMAGE_BYTES) {
          blocks.push({ type: 'text', text: `（图片 ${f} 有 ${(buf.length / 1048576).toFixed(1)} MB，超过 ${MAX_INLINE_IMAGE_BYTES / 1048576} MB 上限，没有内联；文件就在这个路径。）` })
          continue
        }
        blocks.push({ type: 'image', data: buf.toString('base64'), mimeType: mimeOfFile(f) })
      } catch (e) {
        /* 文件不在 / 读不了：不是错误，结果里的路径还在，交给模型判断 */
        if (verbose) log(`内联图片失败 ${f}：${e?.message ?? e}`)
      }
    }
  }
  /* MCP 要求 content 非空 */
  if (!blocks.length) blocks.push({ type: 'text', text: '(空结果)' })
  return blocks
}
