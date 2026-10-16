/**
 * mc_skin.mjs —— 玩家皮肤：PNG 解码 + 下载缓存 + Minecraft 皮肤贴图采样
 *
 * 分工：渲染内核（mc_view-render.mjs）只管几何（哪个部件、哪个面、面内 uv）；
 *       本模块回答"这个部件这个面上 (u,v) 处是什么颜色"。
 *
 * 只依赖 node:zlib / node:fs / node:path / node:crypto + 全局 fetch，可单独自检：
 *   node mcp-mc-agent/tools/check-mc-skin.mjs
 *
 * Minecraft 皮肤贴图布局（64×64，1.8 之后的格式；基础层 + 覆盖层）：
 *   头部 (0,0)   8×8×8    覆盖层 (32,0)
 *   身体 (16,16) 8×12×4   覆盖层 (16,32)
 *   右臂 (40,16) 4×12×4   覆盖层 (40,32)      slim 皮肤臂宽 3
 *   右腿 (0,16)  4×12×4   覆盖层 (0,32)
 *   左臂 (32,48) 4×12×4   覆盖层 (48,48)      仅 64×64；64×32 老皮肤用右臂镜像
 *   左腿 (16,48) 4×12×4   覆盖层 (0,48)
 * 每个部件区域内部（宽 w 高 h 厚 d）的排布是固定的：
 *        [ 顶 ][ 底 ]
 *   [右][ 前 ][左][ 后 ]
 * 所以某个面的矩形 = 按 w/h/d 从区域左上角推出来（见 faceRect）。
 *
 * 面内 uv 的方向（跟 MC 一致，靠 cross(up, n) 定 u 轴）由渲染内核按局部坐标算好，
 * 本模块只按"归一化 uv + 面名"取像素。
 */
import { inflateSync } from 'node:zlib'
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

/** 各部件在 64×64 贴图里的基础层/覆盖层区域（像素） */
export const PART_LAYOUT = {
  head: { x: 0, y: 0, w: 8, h: 8, d: 8, ov: { x: 32, y: 0 } },
  body: { x: 16, y: 16, w: 8, h: 12, d: 4, ov: { x: 16, y: 32 } },
  rightArm: { x: 40, y: 16, w: 4, h: 12, d: 4, ov: { x: 40, y: 32 } },
  leftArm: { x: 32, y: 48, w: 4, h: 12, d: 4, ov: { x: 48, y: 48 } },
  rightLeg: { x: 0, y: 16, w: 4, h: 12, d: 4, ov: { x: 0, y: 32 } },
  leftLeg: { x: 16, y: 48, w: 4, h: 12, d: 4, ov: { x: 0, y: 48 } },
}

/** 披风贴图（64×32）里的各面矩形 */
export const CAPE_LAYOUT = {
  top: [1, 0, 10, 1],
  bottom: [1, 17, 10, 1],
  left: [0, 1, 1, 16],
  right: [11, 1, 1, 16],
  front: [12, 1, 10, 16], // 内侧
  back: [1, 1, 10, 16], // 外面（贴着玩家背的那面朝外）
}

/** 区域 + 面名 → 该面在贴图里的矩形 [x, y, w, h]（通用公式，slim 臂宽 3 也适用） */
export function faceRect (x0, y0, w, h, d, face) {
  switch (face) {
    case 'top': return [x0 + d, y0, w, d]
    case 'bottom': return [x0 + d + w, y0, w, d]
    case 'right': return [x0, y0 + d, d, h]
    case 'front': return [x0 + d, y0 + d, w, h]
    case 'left': return [x0 + d + w, y0 + d, d, h]
    case 'back': return [x0 + 2 * d + w, y0 + d, w, h]
    default: return null
  }
}

/**
 * 解一个 PNG（8 位、非隔行；颜色类型 0/2/3/4/6）。
 * @returns {{ width:number, height:number, rgba:Uint8Array }}
 */
export function decodePng (buf) {
  if (!buf || buf.length < 16) throw new Error('PNG 太短')
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error('不是 PNG 文件')
  let pos = 8
  let width = 0
  let height = 0
  let depth = 0
  let colorType = 0
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      depth = data[8]
      colorType = data[9]
      interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    pos += 12 + len
  }
  if (!width || !height) throw new Error('PNG 缺 IHDR')
  if (width * height > 4096 * 4096) throw new Error(`PNG 太大 ${width}×${height}`)
  if (depth !== 8) throw new Error(`不支持的位深 ${depth}（只支持 8 位）`)
  if (interlace !== 0) throw new Error('不支持隔行 PNG')
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`不支持的颜色类型 ${colorType}`)
  if (colorType === 3 && !palette) throw new Error('索引色 PNG 缺 PLTE')
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  if (raw.length < (stride + 1) * height) throw new Error('PNG 数据不完整')
  const out = Buffer.alloc(stride * height)
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)]
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride)
    const cur = out.subarray(y * stride, (y + 1) * stride)
    line.copy(cur)
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0
      const b = prev[x]
      const c = x >= channels ? prev[x - channels] : 0
      let v = cur[x]
      if (ft === 1) v = (v + a) & 255
      else if (ft === 2) v = (v + b) & 255
      else if (ft === 3) v = (v + ((a + b) >> 1)) & 255
      else if (ft === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
      } else if (ft !== 0) throw new Error(`不支持的滤波类型 ${ft}`)
      cur[x] = v
    }
    prev = cur
  }
  const rgba = new Uint8Array(width * height * 4)
  const n = width * height
  for (let i = 0; i < n; i++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 255
    if (colorType === 6) {
      r = out[i * 4]; g = out[i * 4 + 1]; b = out[i * 4 + 2]; a = out[i * 4 + 3]
    } else if (colorType === 2) {
      r = out[i * 3]; g = out[i * 3 + 1]; b = out[i * 3 + 2]
    } else if (colorType === 0) {
      r = g = b = out[i]
    } else if (colorType === 4) {
      r = g = b = out[i * 2]; a = out[i * 2 + 1]
    } else {
      const p = out[i] * 3
      r = palette[p]; g = palette[p + 1]; b = palette[p + 2]
      a = trns && out[i] < trns.length ? trns[out[i]] : 255
    }
    rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = a
  }
  return { width, height, rgba }
}

/** 下载（http 自动升级 https 重试；带超时），返回 Buffer */
export async function fetchBytes (url, timeoutMs = 6000) {
  const tries = []
  if (/^http:\/\//.test(url)) tries.push(url.replace(/^http:\/\//, 'https://'))
  tries.push(url)
  let lastErr = null
  for (const u of tries) {
    try {
      const res = await fetch(u, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'mcp-mc-agent/0.2 (+DeepSeek Harness)' },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return Buffer.from(await res.arrayBuffer())
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr ?? new Error('下载失败')
}

/**
 * 用解码后的贴图做一个"皮肤采样器"。
 * @param input { width, height, rgba, model?:'slim'|'classic', cape?:{width,height,rgba} }
 */
export function makeSkin (input) {
  const width = Number(input?.width) || 0
  const height = Number(input?.height) || 0
  const rgba = input?.rgba
  if (!width || !height || !rgba || rgba.length < width * height * 4) throw new Error('皮肤贴图数据不合法')
  const model = input.model === 'slim' ? 'slim' : 'classic'
  const legacy = height < 64 // 64×32 老皮肤：没有左臂/左腿区域
  const capeIn = input.cape
  const cape = capeIn && capeIn.rgba && capeIn.width && capeIn.height
    ? { width: capeIn.width, height: capeIn.height, rgba: capeIn.rgba }
    : null

  const px = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return null
    const o = (y * width + x) * 4
    return [rgba[o], rgba[o + 1], rgba[o + 2], rgba[o + 3]]
  }
  const rectPixel = (rect, u, v) => {
    const [rx, ry, rw, rh] = rect
    const sx = rx + Math.min(rw - 1, Math.max(0, Math.floor(u * rw)))
    const sy = ry + Math.min(rh - 1, Math.max(0, Math.floor(v * rh)))
    return px(sx, sy)
  }

  /** 部件 + 面 → 贴图矩形（考虑 slim 臂宽、老皮肤的左肢镜像） */
  function rectOf (part, face, overlay) {
    let p = part
    let mirror = false
    if (legacy && (p === 'leftArm' || p === 'leftLeg')) {
      p = p === 'leftArm' ? 'rightArm' : 'rightLeg'
      mirror = true
      overlay = false // 老皮肤没有覆盖层
    }
    const base = PART_LAYOUT[p]
    if (!base) return null
    const w = (p === 'rightArm' || p === 'leftArm') && model === 'slim' ? 3 : base.w
    if (overlay) {
      if (!base.ov || legacy) return null
      const r = faceRect(base.ov.x, base.ov.y, w, base.h, base.d, face)
      return r ? { rect: r, mirror } : null
    }
    const r = faceRect(base.x, base.y, w, base.h, base.d, face)
    return r ? { rect: r, mirror } : null
  }

  /**
   * 取一个面上一像素的颜色（基础层 + 覆盖层合成）。
   * @returns [r,g,b,a] 或 null（贴图里没有这个面）
   */
  function sample (part, face, u, v) {
    const baseInfo = rectOf(part, face, false)
    if (!baseInfo) return null
    const bu = baseInfo.mirror ? 1 - u : u
    const base = rectPixel(baseInfo.rect, bu, v) ?? [0, 0, 0, 0]
    const ovInfo = rectOf(part, face, true)
    let c = base
    if (ovInfo) {
      const ou = ovInfo.mirror ? 1 - u : u
      const over = rectPixel(ovInfo.rect, ou, v)
      if (over && over[3] > 0) {
        const k = over[3] / 255
        c = [
          over[0] * k + base[0] * (1 - k),
          over[1] * k + base[1] * (1 - k),
          over[2] * k + base[2] * (1 - k),
          Math.max(base[3], over[3]),
        ]
      }
    }
    return c
  }

  /** 披风面上一点的颜色（没有披风返回 null） */
  function sampleCape (face, u, v) {
    if (!cape) return null
    /* 审计 G10：认不出的 face 原来**静默**退回 back（披风背面），于是拼错的参数会拿到
     * 一个"看起来对"的颜色，永远查不出问题。这里如实回 null（没有披风/没有这个面）。
     * `CAPE_LAYOUT` 里的合法面见它自己的定义。 */
    const rect = CAPE_LAYOUT[face]
    if (!rect) return null
    const [rx, ry, rw, rh] = rect
    const sx = rx + Math.min(rw - 1, Math.max(0, Math.floor(u * rw)))
    const sy = ry + Math.min(rh - 1, Math.max(0, Math.floor(v * rh)))
    if (sx < 0 || sy < 0 || sx >= cape.width || sy >= cape.height) return null
    const o = (sy * cape.width + sx) * 4
    return [cape.rgba[o], cape.rgba[o + 1], cape.rgba[o + 2], cape.rgba[o + 3]]
  }

  /** 整张皮肤的平均色（给文字摘要用；忽略透明像素；只算一次） */
  let avgCache = null
  function average () {
    if (avgCache) return avgCache
    let r = 0
    let g = 0
    let b = 0
    let n = 0
    for (let i = 0; i < width * height; i++) {
      const a = rgba[i * 4 + 3]
      if (a < 128) continue
      r += rgba[i * 4]; g += rgba[i * 4 + 1]; b += rgba[i * 4 + 2]; n++
    }
    avgCache = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [128, 128, 128]
    return avgCache
  }

  return { width, height, model, legacy, cape: cape ? { width: cape.width, height: cape.height } : null, sample, sampleCape, rectOf, average }
}

/* ───────────────────────── 下载 + 磁盘缓存 ───────────────────────── */

const hash8 = (s) => createHash('sha1').update(String(s)).digest('hex').slice(0, 8)
const safeName = (s) => String(s ?? 'player').replace(/[^\w.-]+/g, '_').slice(0, 32) || 'player'

/** PNG 8 字节签名 —— 用来挡住"200 + HTML 错误页/截断响应"（真正的解析还是 `decodePng`） */
export const looksLikePng = (buf) => Boolean(buf) && buf.length > 8 &&
  buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
  buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a

/** 失败的记忆化标记：这么久之后允许重试（不然一次瞬时抖动 = 整会话没皮肤） */
const FAIL_TTL_MS = 30_000

/**
 * 皮肤仓库：按玩家名 + url 缓存，落盘到**记忆根**下的 `skins/`
 * （默认 `<工作区>/.mcp-mc-agent/skins/`；Master 设了 `config.memoryDir` 就跟着挪）。
 * 拿不到就返回 null（调用方回退到纯色），绝不抛。
 * @param {Function} [o.memRootOf] 工作区路径 → 记忆根绝对路径
 */
export function createSkinStore ({ workspaceOf, memRootOf, logLine, timeoutMs = 5000, mojangLookup = false } = {}) {
  const mem = new Map()
  const pending = new Map()
  const info = { ok: 0, fail: 0, fetched: 0, cached: 0, badCache: 0, lastError: null }

  function dirOf (ws) {
    if (!ws || ws === 'default') return null
    // 🔴 记忆根可能不在工作区里（`config.memoryDir`），不能写死 `<ws>/.mcp-mc-agent`
    let root = null
    try { root = memRootOf?.(ws) ?? null } catch { root = null }
    return join(root ?? join(ws, '.mcp-mc-agent'), 'skins')
  }

  /**
   * 下载字节 + 磁盘缓存。
   *
   * 🔴 2026-10-08 审计（子代理探针 p6）：**先落盘、后校验** ⇒ 一次"200 + HTML 错误页/截断响应"
   *    就把垃圾永久写进 `<记忆根>/skins/<玩家>-<hash8>.png`，之后 `existsSync` 直接读它、
   *    永不重下 —— 那个玩家永远是默认配色，**重启 DSH 也不好**。
   *    现在：① 缓存命中要先过 `validate`，坏的就删掉重下；② 下载回来的先校验、通过了才落盘。
   */
  async function bytesFor (url, file, timeout, validate = null) {
    if (file && existsSync(file)) {
      try {
        const buf = readFileSync(file)
        if (!validate || validate(buf)) { info.cached++; return buf }
        info.badCache = (info.badCache ?? 0) + 1
        info.lastError = `磁盘上那份皮肤缓存是坏的（${buf.length} 字节，不是 PNG）—— 已删掉重下`
        try { rmSync(file) } catch { /* 删不掉就算了，下面照样重下 */ }
      } catch { /* 读失败就重新下 */ }
    }
    const buf = await fetchBytes(url, timeout)
    if (validate && !validate(buf)) {
      throw new Error(`下载回来的不是 PNG（${buf?.length ?? 0} 字节）—— 服务端可能返回了错误页/截断响应`)
    }
    info.fetched++
    if (file) {
      try {
        mkdirSync(join(file, '..'), { recursive: true })
        writeFileSync(file, buf)
      } catch (e) { info.lastError = `缓存写入失败：${e.message}` }
    }
    return buf
  }

  /** 服务端没给 textures 时，按名字问 Mojang 要（只对正版名有效） */
  async function mojangSkin (username, timeout) {
    const res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(username)}`, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'mcp-mc-agent/0.2' },
    })
    if (!res.ok) throw new Error(`Mojang 查名 HTTP ${res.status}`)
    const j = await res.json()
    if (!j?.id) throw new Error('Mojang 没这个正版名')
    const res2 = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${j.id}`, {
      signal: AbortSignal.timeout(timeout),
      headers: { 'user-agent': 'mcp-mc-agent/0.2' },
    })
    if (!res2.ok) throw new Error(`Mojang 查档案 HTTP ${res2.status}`)
    const prof = await res2.json()
    const tex = (prof?.properties ?? []).find((p) => p.name === 'textures')
    if (!tex?.value) throw new Error('档案里没有皮肤')
    const decoded = JSON.parse(Buffer.from(tex.value, 'base64').toString('utf-8'))
    const skin = decoded?.textures?.SKIN
    if (!skin?.url) throw new Error('档案里没有皮肤 URL')
    return { url: skin.url, model: skin.metadata?.model, capeUrl: decoded?.textures?.CAPE?.url }
  }

  async function load (username, skinData, ws, timeout) {
    const dir = dirOf(ws)
    const skinFile = dir ? join(dir, `${safeName(username)}-${hash8(skinData.url)}.png`) : null
    const raw = await bytesFor(skinData.url, skinFile, timeout, looksLikePng)
    const dec = decodePng(raw)
    let cape = null
    if (skinData.capeUrl) {
      try {
        const capeFile = dir ? join(dir, `${safeName(username)}-cape-${hash8(skinData.capeUrl)}.png`) : null
        const craw = await bytesFor(skinData.capeUrl, capeFile, timeout, looksLikePng)
        cape = decodePng(craw)
      } catch (e) { info.lastError = `披风下载失败：${e.message}` }
    }
    return makeSkin({ width: dec.width, height: dec.height, rgba: dec.rgba, model: skinData.model, cape })
  }

  /**
   * @param username 玩家名
   * @param skinData mineflayer 的 player.skinData（{url, model, capeUrl}）
   * @param ws 工作区（决定缓存目录；给 null 就不落盘）
   */
  async function skinFor (username, skinData, ws) {
    let data = skinData
    if (!data?.url && mojangLookup && username) {
      try { data = await mojangSkin(username, timeoutMs) } catch { data = null }
    }
    if (!data?.url) return null
    const key = `${username}|${data.url}|${data.capeUrl ?? ''}`
    if (mem.has(key)) {
      const hit = mem.get(key)
      /* 🔴 失败标记带时间：30 秒内不重试（别一次抖动就刷屏），过了就删掉重试 —— 旧版是永久 `null`，
       *    一次网络抖动 = 这个玩家整个会话（以及之后每次连服）都是默认配色。 */
      if (!hit?.fail) return hit
      if (Date.now() - Number(hit.at ?? 0) < FAIL_TTL_MS) return null
      mem.delete(key)
    }
    if (pending.has(key)) return pending.get(key)
    const p = (async () => {
      try {
        const skin = await load(username, data, ws, timeoutMs)
        mem.set(key, skin)
        info.ok++
        return skin
      } catch (e) {
        info.fail++
        info.lastError = e?.message ?? String(e)
        logLine?.(`皮肤获取失败（${username}）：${info.lastError}`)
        mem.set(key, { fail: true, at: Date.now() })
        return null
      } finally {
        pending.delete(key)
      }
    })()
    pending.set(key, p)
    return p
  }

  return { skinFor, info, memory: mem }
}
