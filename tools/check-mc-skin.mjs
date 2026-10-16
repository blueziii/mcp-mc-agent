/**
 * check-mc-skin.mjs —— 皮肤模块自检（不需要 MC、不需要 DSH、不需要联网）
 *
 *   node mcp-mc-agent/tools/check-mc-skin.mjs
 *
 * 覆盖：PNG 解码（各颜色类型 / 5 种滤波 / 索引色 + tRNS）、MC 皮肤贴图布局、
 *       面内采样与覆盖层合成、老皮肤（64×32）左肢镜像、slim 细臂、
 *       下载 + 磁盘缓存（起一个本地 HTTP 服务真下载一次）、失败不抛。
 */
import { deflateSync } from 'node:zlib'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodePng, makeSkin, faceRect, PART_LAYOUT, createSkinStore } from '../extensions/mc_skin.mjs'

let pass = 0
let fail = 0
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e
function ok (cond, label, extra) {
  if (cond) { pass++; return }
  fail++
  console.log(`  FAIL ${label}${extra === undefined ? '' : '  <<< ' + extra}`)
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`)

/* ─────────────── 造 PNG（含滤波，用来验证解码器） ─────────────── */

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c
  }
  return t
})()
function crc32 (buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 255] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}
function chunk (type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const t = Buffer.from(type, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
  return Buffer.concat([len, t, data, crc])
}
/** 按指定滤波类型编码一行（滤波值 = 原值 - 预测值） */
function filterRow (ft, cur, prev, ch) {
  const out = Buffer.alloc(cur.length)
  for (let x = 0; x < cur.length; x++) {
    const a = x >= ch ? cur[x - ch] : 0
    const b = prev ? prev[x] : 0
    const c = prev && x >= ch ? prev[x - ch] : 0
    let p = 0
    if (ft === 1) p = a
    else if (ft === 2) p = b
    else if (ft === 3) p = (a + b) >> 1
    else if (ft === 4) {
      const q = a + b - c
      const pa = Math.abs(q - a)
      const pb = Math.abs(q - b)
      const pc = Math.abs(q - c)
      p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
    }
    out[x] = (cur[x] - p) & 255
  }
  return out
}
/** 组装 PNG：rows 是每行未滤波的原始字节 */
function makePng ({ width, height, colorType = 6, rows, palette, trns, filter = 0 }) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = colorType
  const raw = []
  let prev = null
  for (const r of rows) {
    raw.push(Buffer.from([filter]))
    raw.push(filterRow(filter, r, prev, r.length / width))
    prev = r
  }
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr)]
  if (palette) parts.push(chunk('PLTE', palette))
  if (trns) parts.push(chunk('tRNS', trns))
  parts.push(chunk('IDAT', deflateSync(Buffer.concat(raw))))
  parts.push(chunk('IEND', Buffer.alloc(0)))
  return Buffer.concat(parts)
}

console.log('— 1. PNG 解码 —')
{
  // RGBA + 5 种滤波
  const w = 9
  const h = 4
  const rows = []
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(w * 4)
    for (let x = 0; x < w; x++) {
      r[x * 4] = (x * 23 + y * 7) & 255
      r[x * 4 + 1] = (x * 5 + y * 41) & 255
      r[x * 4 + 2] = (x * 11 + y * 13) & 255
      r[x * 4 + 3] = (x + y) % 2 ? 128 : 255
    }
    rows.push(r)
  }
  for (const ft of [0, 1, 2, 3, 4]) {
    const dec = decodePng(makePng({ width: w, height: h, rows, filter: ft }))
    let same = dec.width === w && dec.height === h
    for (let y = 0; y < h && same; y++) {
      for (let x = 0; x < w && same; x++) {
        for (let c = 0; c < 4; c++) if (dec.rgba[(y * w + x) * 4 + c] !== rows[y][x * 4 + c]) same = false
      }
    }
    ok(same, `RGBA + 滤波 ${ft} 往返一致`)
  }
  // RGB（颜色类型 2）
  {
    const r2 = [Buffer.from([10, 20, 30, 40, 50, 60])]
    const dec = decodePng(makePng({ width: 2, height: 1, colorType: 2, rows: r2 }))
    eq([...dec.rgba], [10, 20, 30, 255, 40, 50, 60, 255], 'RGB → RGBA 扩展')
  }
  // 灰度（颜色类型 0）
  {
    const dec = decodePng(makePng({ width: 3, height: 1, colorType: 0, rows: [Buffer.from([0, 127, 255])] }))
    eq([...dec.rgba], [0, 0, 0, 255, 127, 127, 127, 255, 255, 255, 255, 255], '灰度 → RGBA')
  }
  // 灰度 + alpha（颜色类型 4）
  {
    const dec = decodePng(makePng({ width: 2, height: 1, colorType: 4, rows: [Buffer.from([200, 64, 100, 255])] }))
    eq([...dec.rgba], [200, 200, 200, 64, 100, 100, 100, 255], '灰度+alpha → RGBA')
  }
  // 索引色 + tRNS（颜色类型 3）
  {
    const pal = Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255])
    const dec = decodePng(makePng({ width: 3, height: 1, colorType: 3, rows: [Buffer.from([0, 1, 2])], palette: pal, trns: Buffer.from([0, 128]) }))
    eq([...dec.rgba], [255, 0, 0, 0, 0, 255, 0, 128, 0, 0, 255, 255], '索引色 + tRNS')
  }
  // 异常输入
  const bad = (label, fn) => { try { fn(); ok(false, label, '没有抛错') } catch { ok(true, label) } }
  bad('非 PNG 头 → 抛错', () => decodePng(Buffer.from('hello world hello')))
  bad('截断 → 抛错', () => decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
}

console.log('— 2. 皮肤布局（MC 官方坐标）—')
{
  eq(faceRect(0, 0, 8, 8, 8, 'front'), [8, 8, 8, 8], '头 正面 (8,8)')
  eq(faceRect(0, 0, 8, 8, 8, 'back'), [24, 8, 8, 8], '头 背面 (24,8)')
  eq(faceRect(0, 0, 8, 8, 8, 'right'), [0, 8, 8, 8], '头 右侧 (0,8)')
  eq(faceRect(0, 0, 8, 8, 8, 'left'), [16, 8, 8, 8], '头 左侧 (16,8)')
  eq(faceRect(0, 0, 8, 8, 8, 'top'), [8, 0, 8, 8], '头顶 (8,0)')
  eq(faceRect(0, 0, 8, 8, 8, 'bottom'), [16, 0, 8, 8], '头底 (16,0)')
  eq(faceRect(16, 16, 8, 12, 4, 'front'), [20, 20, 8, 12], '身体 正面 (20,20)')
  eq(faceRect(16, 16, 8, 12, 4, 'back'), [32, 20, 8, 12], '身体 背面 (32,20)')
  eq(faceRect(40, 16, 4, 12, 4, 'front'), [44, 20, 4, 12], '右臂 正面 (44,20)')
  eq(faceRect(40, 16, 4, 12, 4, 'back'), [52, 20, 4, 12], '右臂 背面 (52,20)')
  eq(faceRect(40, 16, 3, 12, 4, 'front'), [44, 20, 3, 12], 'slim 右臂 正面（窄 1 像素）')
  eq(faceRect(40, 16, 3, 12, 4, 'back'), [51, 20, 3, 12], 'slim 右臂 背面')
  eq(faceRect(0, 16, 4, 12, 4, 'front'), [4, 20, 4, 12], '右腿 正面 (4,20)')
  eq(faceRect(32, 48, 4, 12, 4, 'front'), [36, 52, 4, 12], '左臂 正面 (36,52)')
  eq(faceRect(16, 48, 4, 12, 4, 'front'), [20, 52, 4, 12], '左腿 正面 (20,52)')
  ok(PART_LAYOUT.head.ov.x === 32 && PART_LAYOUT.body.ov.y === 32 && PART_LAYOUT.leftLeg.ov.y === 48, '覆盖层区域锚点')
}

/* ─────────────── 造一张"每个面一个颜色"的皮肤 ─────────────── */

function blank (size = 64, h = size) {
  return { width: size, height: h, rgba: new Uint8Array(size * h * 4) }
}
function fill (skin, x0, y0, w, h, [r, g, b, a = 255]) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * skin.width + x) * 4
      skin.rgba[o] = r
      skin.rgba[o + 1] = g
      skin.rgba[o + 2] = b
      skin.rgba[o + 3] = a
    }
  }
}
/** 用硬编码的官方坐标画色块（不借用被测代码，保证是独立验证） */
function paintHeadFaces (skin) {
  fill(skin, 8, 8, 8, 8, [255, 0, 0]) // front 红
  fill(skin, 24, 8, 8, 8, [0, 255, 0]) // back 绿
  fill(skin, 0, 8, 8, 8, [0, 0, 255]) // right 蓝
  fill(skin, 16, 8, 8, 8, [255, 255, 0]) // left 黄
  fill(skin, 8, 0, 8, 8, [255, 0, 255]) // top 品红
  fill(skin, 16, 0, 8, 8, [0, 255, 255]) // bottom 青
}

console.log('— 3. 采样与覆盖层 —')
{
  const raw = blank()
  paintHeadFaces(raw)
  const skin = makeSkin({ ...raw, model: 'classic' })
  eq(skin.sample('head', 'front', 0.5, 0.5), [255, 0, 0, 255], '正面取到红')
  eq(skin.sample('head', 'back', 0.5, 0.5), [0, 255, 0, 255], '背面取到绿')
  eq(skin.sample('head', 'right', 0.5, 0.5), [0, 0, 255, 255], '右侧取到蓝')
  eq(skin.sample('head', 'left', 0.5, 0.5), [255, 255, 0, 255], '左侧取到黄')
  eq(skin.sample('head', 'top', 0.5, 0.5), [255, 0, 255, 255], '顶面取到品红')
  eq(skin.sample('head', 'bottom', 0.5, 0.5), [0, 255, 255, 255], '底面取到青')
  ok(skin.sample('head', 'nope', 0.5, 0.5) === null, '不存在的面返回 null')
  ok(skin.sample('body', 'front', 0.5, 0.5)[3] === 0, '没画的地方是透明')

  // 覆盖层（帽子）半透明合成
  const raw2 = blank()
  paintHeadFaces(raw2)
  fill(raw2, 40, 8, 8, 8, [0, 0, 0, 128]) // hat 正面 50% 黑
  const skin2 = makeSkin({ ...raw2 })
  const c = skin2.sample('head', 'front', 0.5, 0.5)
  ok(near(c[0], 128, 2) && near(c[1], 0, 2) && near(c[2], 0, 2) && c[3] === 255, '覆盖层 50% 黑盖在红上 → 暗红', JSON.stringify(c))

  // uv 越界要夹住（不抛）
  ok(Array.isArray(skin.sample('head', 'front', 1.7, -0.3)), 'uv 越界被夹住')

  // 平均色（忽略透明）
  const raw3 = blank()
  fill(raw3, 0, 0, 64, 64, [10, 20, 30])
  fill(raw3, 0, 0, 32, 32, [200, 100, 50, 0])
  const skin3 = makeSkin({ ...raw3 })
  eq(skin3.average(), [10, 20, 30], '平均色忽略透明像素')
  ok(skin3.average() === skin3.average(), '平均色有缓存（同引用）')
}

console.log('— 4. 老皮肤（64×32）与 slim —')
{
  const raw = blank(64, 32)
  fill(raw, 4, 20, 4, 12, [11, 22, 33]) // 右腿正面
  fill(raw, 44, 20, 4, 12, [99, 88, 77]) // 右臂正面
  const skin = makeSkin({ ...raw })
  ok(skin.legacy === true, '64×32 识别为老皮肤')
  eq(skin.sample('rightLeg', 'front', 0.5, 0.5), [11, 22, 33, 255], '老皮肤 右腿正面')
  eq(skin.sample('leftLeg', 'front', 0.5, 0.5), [11, 22, 33, 255], '老皮肤 左腿用右腿贴图')
  eq(skin.sample('leftLeg', 'front', 0.1, 0.5), skin.sample('rightLeg', 'front', 0.9, 0.5), '老皮肤左腿横向镜像')
  eq(skin.sample('rightArm', 'front', 0.5, 0.5), [99, 88, 77, 255], '老皮肤 右臂正面')
  ok(skin.rectOf('rightArm', 'front', true) === null, '老皮肤没有覆盖层')

  const slim = makeSkin({ ...blank(64, 64), model: 'slim' })
  ok(slim.model === 'slim' && slim.legacy === false, 'slim 模型识别')
  eq(slim.rectOf('rightArm', 'front', false).rect, [44, 20, 3, 12], 'slim 右臂面矩形窄 1 像素')
  eq(slim.rectOf('leftArm', 'front', false).rect, [36, 52, 3, 12], 'slim 左臂面矩形')
  const throws = (label, fn) => { try { fn(); ok(false, label, '没有抛错') } catch { ok(true, label) } }
  throws('空贴图 → 抛错', () => makeSkin({ width: 0, height: 0, rgba: new Uint8Array(0) }))

  // 披风
  const cape = blank(64, 32)
  fill(cape, 1, 1, 10, 16, [7, 8, 9])
  const withCape = makeSkin({ ...blank(), cape })
  ok(!!withCape.cape, '带披风')
  eq(withCape.sampleCape('back', 0.5, 0.5), [7, 8, 9, 255], '披风外面取色')
  ok(makeSkin({ ...blank() }).sampleCape('back', 0.5, 0.5) === null, '没披风 → null')
}

console.log('— 5. 下载 + 磁盘缓存（本地 HTTP）—')
{
  const raw = blank()
  paintHeadFaces(raw)
  const png = makePng({
    width: 64,
    height: 64,
    rows: Array.from({ length: 64 }, (_, y) => Buffer.from(raw.rgba.subarray(y * 64 * 4, (y + 1) * 64 * 4))),
  })
  let hits = 0
  let badBody = '<html>oops, 502 from edge</html>'
  const server = createServer((req, res) => {
    hits++
    if (req.url === '/skin.png') {
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(png)
    } else if (req.url === '/bad.png') {
      // 服务端**撒谎说是 image/png**，内容却是 HTML 错误页（真实世界最常见的坏响应）
      res.writeHead(200, { 'content-type': 'image/png' })
      res.end(badBody ?? png)
    } else {
      res.writeHead(404)
      res.end('no')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ws = mkdtempSync(join(tmpdir(), 'mc-skin-'))
  const lines = []
  const store = createSkinStore({ workspaceOf: () => ws, logLine: (s) => lines.push(s), timeoutMs: 3000 })
  const url = `http://127.0.0.1:${port}/skin.png`
  const s1 = await store.skinFor('Tester', { url, model: 'slim' }, ws)
  ok(s1 && s1.model === 'slim' && s1.width === 64, '从 HTTP 下载并解码', String(s1))
  eq(s1.sample('head', 'front', 0.5, 0.5), [255, 0, 0, 255], '下载到的皮肤能采样')
  ok(hits === 1, '只请求一次', String(hits))
  ok(store.info.fetched === 1, 'info.fetched = 1', JSON.stringify(store.info))
  const s2 = await store.skinFor('Tester', { url, model: 'slim' }, ws)
  ok(s2 === s1 && hits === 1, '第二次走内存缓存，不再请求')
  const dir = join(ws, '.mcp-mc-agent', 'skins')
  ok(existsSync(dir) && readdirSync(dir).some((f) => f.endsWith('.png')), '落盘缓存文件存在')

  // 换一个进程内缓存（模拟重启）→ 应走磁盘缓存
  const store2 = createSkinStore({ workspaceOf: () => ws, logLine: (s) => lines.push(s), timeoutMs: 3000 })
  const s3 = await store2.skinFor('Tester', { url, model: 'slim' }, ws)
  ok(s3 && hits === 1 && store2.info.cached === 1, '重启后走磁盘缓存（没再下载）', JSON.stringify(store2.info))

  // 失败：404 / 无 url / 超时
  const bad = await store.skinFor('Bad', { url: `http://127.0.0.1:${port}/nope.png` }, ws)
  ok(bad === null, '404 → null（不抛）')

  /* 🔴 2026-10-08 审计（子代理探针 p6/p2）：坏响应先落盘 ⇒ 磁盘缓存永久中毒（跨重启）；
   *    失败被内存永久缓存 ⇒ 一次抖动 = 这个玩家整个会话都没皮肤。这两条钉死。 */
  const badUrl = `http://127.0.0.1:${port}/bad.png`
  const hitsBeforeBad = hits
  const poison1 = await store.skinFor('Poison', { url: badUrl }, ws)
  ok(poison1 === null, '200 + HTML 错误页 → null（不当成皮肤）')
  const files1 = readdirSync(dir)
  ok(!files1.some((f) => f.startsWith('Poison-')), '坏响应**不落盘**（旧版会把 HTML 写成 .png）', files1.join(','))
  const badKey = `Poison|${badUrl}|`
  ok(store.memory.get(badKey)?.fail === true && typeof store.memory.get(badKey)?.at === 'number',
    '失败记的是**带时间的标记**（不是永久 null）', JSON.stringify(store.memory.get(badKey)))
  const hitsAfterBad = hits
  const poisonAgain = await store.skinFor('Poison', { url: badUrl }, ws)
  ok(poisonAgain === null && hits === hitsAfterBad, '30 秒内不重复重试（别把失败刷屏）', String(hits))

  // 换新 store（模拟重启）+ 服务端修好 ⇒ 磁盘上没有坏文件，应该能拿到皮肤
  badBody = null
  const storePoison = createSkinStore({ workspaceOf: () => ws, logLine: () => {}, timeoutMs: 3000 })
  const poisonFixed = await storePoison.skinFor('Poison', { url: badUrl }, ws)
  ok(poisonFixed && poisonFixed.width === 64, '服务端修好后能拿到皮肤（坏响应没留后遗症）', String(poisonFixed))
  ok(storePoison.info.badCache === 0, '没落过盘 ⇒ 没有坏缓存要清', JSON.stringify(storePoison.info))

  // 磁盘上已经有坏文件（老版本留下的垃圾）⇒ 读到坏的就删掉重下
  const h8 = createHash('sha1').update(badUrl).digest('hex').slice(0, 8)
  writeFileSync(join(dir, `Poison-${h8}.png`), '<html>legacy garbage from an old version</html>')
  const storeLegacy = createSkinStore({ workspaceOf: () => ws, logLine: () => {}, timeoutMs: 3000 })
  const legacyFixed = await storeLegacy.skinFor('Poison', { url: badUrl }, ws)
  ok(legacyFixed && legacyFixed.width === 64, '磁盘上的坏缓存会被删掉重下（老版本留下的垃圾不会永久毒住）', String(legacyFixed))
  ok(storeLegacy.info.badCache === 1, 'info.badCache 记了一次', JSON.stringify(storeLegacy.info))
  ok(readdirSync(dir).filter((f) => f === `Poison-${h8}.png`).length === 1 &&
    !readFileSync(join(dir, `Poison-${h8}.png`)).toString('utf8').includes('legacy garbage'),
  '重下之后磁盘上那份是**真 PNG**（不是那份垃圾）')

  ok(await store.skinFor('None', null, ws) === null, '没有 skinData → null')
  ok(await store.skinFor('None2', {}, ws) === null, '空对象 → null')
  const store3 = createSkinStore({ workspaceOf: () => null, logLine: () => {}, timeoutMs: 3000 })
  const noWs = await store3.skinFor('Tester', { url, model: 'slim' }, null)
  ok(noWs && noWs.width === 64, '没有工作区也能用（不落盘）')
  ok(lines.some((l) => l.includes('皮肤获取失败')), '失败会 logLine', JSON.stringify(lines))

  // 记忆根覆盖（2026-10-06）：Master 设了 config.memoryDir 之后，皮肤缓存必须跟着记忆根走。
  // 以前写死 `<工作区>/.mcp-mc-agent/skins`，记忆一挪缓存就散在两个地方。
  // 放在最后：上面几条断言依赖 hits 计数（"只请求一次"），这里会多发一次请求。
  const wsMem = mkdtempSync(join(tmpdir(), 'mc-skin-wsmem-'))
  const mem = mkdtempSync(join(tmpdir(), 'mc-skin-mem-'))
  const storeMem = createSkinStore({ workspaceOf: () => wsMem, memRootOf: () => mem, logLine: () => {}, timeoutMs: 3000 })
  const sm = await storeMem.skinFor('Mem', { url, model: 'slim' }, wsMem)
  ok(sm && sm.width === 64, '记忆根模式：照样能拿到皮肤')
  const memDir = join(mem, 'skins')
  ok(existsSync(memDir) && readdirSync(memDir).some((f) => f.endsWith('.png')), '记忆根覆盖：缓存落 <记忆根>/skins/')
  ok(!existsSync(join(wsMem, '.mcp-mc-agent')), '记忆根覆盖：工作区里不再长出 .mcp-mc-agent')
  // 拿不到记忆根（老宿主）→ 退回 <工作区>/.mcp-mc-agent，行为不变
  const storeFall = createSkinStore({ workspaceOf: () => wsMem, memRootOf: () => null, logLine: () => {}, timeoutMs: 3000 })
  const sf = await storeFall.skinFor('Fall', { url, model: 'slim' }, wsMem)
  ok(sf && sf.width === 64, '记忆根拿不到：照样能拿到皮肤')
  ok(existsSync(join(wsMem, '.mcp-mc-agent', 'skins')), '记忆根拿不到 → 退回 <工作区>/.mcp-mc-agent/skins/')
  rmSync(mem, { recursive: true, force: true })
  rmSync(wsMem, { recursive: true, force: true })

  server.close()
  rmSync(ws, { recursive: true, force: true })
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：pass=${pass} fail=${fail}`)
process.exit(fail === 0 ? 0 : 1)
