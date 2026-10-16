/* 验的是行为，不是配置项：`mcp/content.mjs` 把工具返回值翻成 MCP content blocks 时，
 * **客户端收不收得下**。
 *
 * 为什么单独立一个套件：MCP 对 `content[]` 里每个块都有严格 schema，**一个块形状不对，
 * 客户端会把整条 `tools/call` 判成 `-32602` 扔掉** —— 连前面那些好块一起。
 * 而工具自带的 `output.render()` 是照 **DSH 宿主**的约定写的，DSH 的图片块长这样：
 *   `{ type:'image', attachment:{ id, name, mediaType, bytes } }`
 * MCP 只认 `{ type:'image', data:<base64>, mimeType }`，**没有 `attachment` 这个字段**。
 *
 * 🔴 真踩过（2026-10-16 实机）：`mc_observe` **默认参数**就会画图 ⇒ 一进游戏就报
 *   `MCP error -32602: Invalid tools/call result`，而这个工具正是"看一眼世界"的主力；
 *   `mc_map {format:"image"}` 同理。离线自检发现不了 —— 它不连服务器，画不出图。
 *
 * 🔴 必须从包目录跑：`node tools\check-mcp-content.mjs`
 *
 * 覆盖：
 *   ① DSH 形状的图片块（只有 attachment、没有 data）**必须被丢掉**
 *   ② MCP 形状的图片块（data + mimeType）原样留着
 *   ③ 文本块原样过；不是对象的条目降级成文本；缺 `text` / 未知 `type` 也降级（不许原样吐出去）
 *   ④ `attachments.saveImage()` 收上来的图 → 合法 image 块（base64 + mimeType）
 *   ⑤ 落盘图片兜底内联（真读一个 PNG）；超大文件只留路径 + 一句说明
 *   ⑥ 空结果兜底；`render()` 抛异常也降级成文本而不是崩
 *   ⑦ **不变量**：上面每一条产出的 `content[]`，逐块过一遍"客户端收不收得下"的判据
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderContent, blockOk, mimeOfFile, findImageFiles, safeJson, IMAGE_MIME, MAX_INLINE_IMAGE_BYTES } from '../mcp/content.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

const tmp = mkdtempSync(join(tmpdir(), 'mcp-content-check-'))
/** 一个最小的合法 PNG（1×1 透明），用来验"落盘图片真能被内联"。 */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
const pngPath = join(tmp, 'shot.png')
writeFileSync(pngPath, PNG_1PX)

const toolWith = (render) => ({ output: { render } })
const R = (o) => renderContent({ cwd: tmp, log: () => {}, ...o })

/* 每个用例都过一遍这个不变量：产出的块必须逐块合规 */
const allValid = (blocks) => Array.isArray(blocks) && blocks.length > 0 && blocks.every(blockOk)

console.log('\n--- ① DSH 形状的图片块必须丢掉（本次修的就是这个）---')
{
  const out = R({
    tool: toolWith(() => ([
      { type: 'text', text: '正文' },
      { type: 'image', attachment: { id: 'a1', name: 'mc-observe.png', mediaType: 'image/png', bytes: 1234 } },
    ])),
    args: {}, value: { text: '正文' }, images: [],
  })
  ok(out.length === 1 && out[0].type === 'text', '只有 attachment 的 image 块被丢掉（不留半截）', `blocks=${out.length}`)
  ok(!JSON.stringify(out).includes('attachment'), '产出的 JSON 里再也搜不到 attachment 字段')
  ok(allValid(out), '剩下的块全部合规')
}
{
  /* 反面：真图片（sink 有图）时，丢掉那个坏块**不能**把图也丢掉 */
  const out = R({
    tool: toolWith(() => ([
      { type: 'text', text: '正文' },
      { type: 'image', attachment: { id: 'a1' } },
    ])),
    args: {}, value: { text: '正文' },
    images: [{ data: PNG_1PX, mediaType: 'image/png', name: 'x.png' }],
  })
  ok(out.length === 2 && out[1].type === 'image' && typeof out[1].data === 'string',
    '坏块丢掉后，真图仍由 attachments 那条路补上', `blocks=${out.map((b) => b.type).join('+')}`)
  ok(allValid(out), '块全部合规')
}

console.log('\n--- ② MCP 形状的图片块原样留着 ---')
{
  const good = { type: 'image', data: 'AAAA', mimeType: 'image/png' }
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }, good])), args: {}, value: {} })
  ok(out.length === 2 && out[1] === good, 'data + mimeType 的块原样透传')
  ok(allValid(out), '块全部合规')
}

console.log('\n--- ③ 文本与非对象条目 ---')
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: '你好' }, '裸字符串', 42])), args: {}, value: {} })
  ok(out.length === 3, '三个条目都在')
  ok(out[1].type === 'text' && out[1].text === '裸字符串', '裸字符串降级成文本块')
  ok(out[2].text === '42', '数字也降级成文本块')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'text' }])), args: {}, value: { a: 1 } })
  ok(out[0].type === 'text' && typeof out[0].text === 'string' && out[0].text.length > 0,
    '缺 text 的文本块降级（不原样吐出去）', JSON.stringify(out[0]).slice(0, 60))
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'audio', data: 'x' }])), args: {}, value: {} })
  ok(out[0].type === 'text', '未知 type（audio）降级成文本 —— 不猜')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => (null)), args: {}, value: { hello: 'world' } })
  ok(out.length === 1 && out[0].type === 'text' && out[0].text.includes('world'),
    'render 返回 null ⇒ 用返回值兜底成文本')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => { throw new Error('炸了') }), args: {}, value: { x: 1 } })
  ok(out.some((b) => b.type === 'text' && b.text.includes('结果渲染失败')), 'render 抛异常也降级成文本')
  ok(allValid(out), '块全部合规')
}

console.log('\n--- ④ attachments 收上来的图 ---')
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: {}, images: [{ data: PNG_1PX, mediaType: 'image/png', name: 'a.png' }] })
  ok(out.length === 2 && out[1].type === 'image', '图片块补在最后')
  ok(out[1].data === PNG_1PX.toString('base64'), 'data 是 base64 字符串')
  ok(out[1].mimeType === 'image/png', 'mimeType 带上了')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: {}, images: [{ data: PNG_1PX }] })
  ok(out[1].mimeType === 'image/png', '没给 mediaType 时兜底 image/png')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: {}, images: [{ data: null, name: 'bad.png' }] })
  ok(allValid(out), '图片数据坏掉时不影响其它块（转 base64 失败只记日志）', `blocks=${out.map((b) => b.type).join('+')}`)
}

console.log('\n--- ⑤ 落盘图片兜底内联 ---')
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: { image: { file: 'shot.png' } }, images: [] })
  ok(out.length === 2 && out[1].type === 'image', '按 file 相对路径内联（相对 cwd 解析）')
  ok(out[1].data === PNG_1PX.toString('base64'), '内联的正是那个文件')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: { image: { file: 'shot.png' } }, images: [{ data: PNG_1PX }] })
  ok(out.length === 2, 'sink 里已经有图时**不**再按文件重复内联')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => ([{ type: 'text', text: 't' }])), args: {}, value: { file: '不存在.png' }, images: [] })
  ok(out.length === 1 && out[0].type === 'text', '文件读不了不是错误（路径还在结果里）')
  ok(allValid(out), '块全部合规')
}

console.log('\n--- ⑥ 空结果 / 辅助函数 ---')
{
  const out = R({ tool: toolWith(() => ([])), args: {}, value: undefined })
  ok(out.length === 1 && out[0].text === '(空结果)', 'render 给空数组 ⇒ 兜底 `(空结果)`（MCP 要求 content 非空）')
  ok(allValid(out), '块全部合规')
}
{
  const out = R({ tool: toolWith(() => (null)), args: {}, value: undefined })
  ok(out.length === 1 && out[0].text === '(undefined)', 'render 返回 null + value 是 undefined ⇒ `(undefined)`')
  ok(allValid(out), '块全部合规')
}
ok(safeJson({ a: 1 }) === '{\n  "a": 1\n}', 'safeJson 缩进 JSON')
ok(safeJson('x') === 'x', 'safeJson 字符串原样')
ok(mimeOfFile('a.PNG') === 'image/png', 'mimeOfFile 大小写不敏感')
ok(mimeOfFile('a.bin') === 'image/png', 'mimeOfFile 未知后缀兜底 png')
ok(Object.keys(IMAGE_MIME).length === 5, 'IMAGE_MIME 五种（svg 不算图片）')
ok(MAX_INLINE_IMAGE_BYTES === 4 * 1024 * 1024, '内联上限 4MB')
ok(findImageFiles({ file: 'a.png' }, tmp).length === 1, 'findImageFiles 认 file')
ok(findImageFiles({ image: 'a.png' }, tmp).length === 1, 'findImageFiles 认 image 字符串')
ok(findImageFiles({ path: 'a.txt' }, tmp).length === 0, '非图片后缀不认')
ok(findImageFiles({ file: 'a.png', path: 'a.png' }, tmp).length === 1, '同一个文件不重复收')
ok(findImageFiles({ file: 'a.png', image: { file: 'b.png' } }, tmp).length === 2, '两个不同文件都收')

console.log('\n--- ⑦ 不变量：blockOk 判据本身 ---')
ok(blockOk({ type: 'text', text: '' }), '空字符串的 text 块合规（MCP 允许）')
ok(!blockOk({ type: 'text' }), '缺 text 不合规')
ok(!blockOk({ type: 'image', attachment: {} }), '🔴 只有 attachment 的图片块**不合规**（这正是本次修的）')
ok(!blockOk({ type: 'image', data: 'x' }), '缺 mimeType 的图片块不合规')
ok(blockOk({ type: 'image', data: 'x', mimeType: 'image/png' }), 'data + mimeType 合规')
ok(blockOk({ type: 'resource', resource: { uri: 'mc://state' } }), 'resource 块合规')
ok(!blockOk({ type: 'resource' }), '缺 resource 不合规')
ok(!blockOk(null) && !blockOk('x') && !blockOk({}), 'null / 字符串 / 空对象都不合规')

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败'}：pass=${pass} fail=${fail}\n`)
process.exit(fail === 0 ? 0 : 1)
