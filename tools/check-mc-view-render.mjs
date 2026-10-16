/**
 * `mc_view-render`（`mc_observe` 用的第一人称体素渲染内核）的离线自检：不需要 Minecraft、不需要 DSH、不连服务器。
 * 跑法：node mcp-mc-agent/tools/check-mc-view-render.mjs
 * 落盘的 PNG 在系统临时目录（跑完会打印路径），用眼睛确认方向/纹理/实体对不对。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const render = await import(new URL('../extensions/mc_view-render.mjs', import.meta.url).href)
const { encodePng } = await import(new URL('../src/png.mjs', import.meta.url).href)
const { makeSkin } = await import(new URL('../extensions/mc_skin.mjs', import.meta.url).href)
const outDir = mkdtempSync(join(tmpdir(), 'mc-view-render-'))
const {
  cameraBasis, renderView, compassOf, castRay, colorOf, ruleOf, isAirName, isWaterName, isLavaName,
  isGlassName, isEmissiveName, entityStyle, entityBoxOf, entityParts, selfTest, VIEW_DEFAULTS,
} = render

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log('  ok   ' + label) } else { fail++; console.log('  FAIL ' + label + (extra ? '  <<< ' + extra : '')) }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps
const px = (frame, x, y, w = 192) => {
  const i = (y * w + x) * 4
  return [frame.rgba[i], frame.rgba[i + 1], frame.rgba[i + 2]]
}
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
const dom = (c, i) => c[i] > c[(i + 1) % 3] && c[i] > c[(i + 2) % 3]
const uniqColors = (frame) => {
  const s = new Set()
  for (let i = 0; i < frame.rgba.length; i += 4) s.add(frame.rgba[i] + ',' + frame.rgba[i + 1] + ',' + frame.rgba[i + 2])
  return s.size
}

console.log('— 1. 相机基向量 —')
{
  const { f, r, u } = cameraBasis(0, 0)
  ok(near(f[0], 0) && near(f[1], 0) && near(f[2], -1), 'yaw=0,pitch=0 → f=(0,0,-1)', JSON.stringify(f))
  ok(near(r[0], 1) && near(r[1], 0) && near(r[2], 0), 'r=(1,0,0)', JSON.stringify(r))
  ok(near(u[0], 0) && near(u[1], 1) && near(u[2], 0), 'u=(0,1,0)', JSON.stringify(u))
  const b2 = cameraBasis(0, Math.PI / 4)
  ok(near(b2.f[1], Math.SQRT1_2, 1e-6) && near(b2.f[2], -Math.SQRT1_2, 1e-6), 'pitch=45° → f 抬头', JSON.stringify(b2.f))
  ok(near(b2.u[1], Math.SQRT1_2, 1e-6) && near(b2.u[2], Math.SQRT1_2, 1e-6), 'pitch=45° → u 向上', JSON.stringify(b2.u))
  for (const [yaw, pitch] of [[0.7, -0.4], [2.9, 0.9], [-1.3, 0.2], [Math.PI, -1.2]]) {
    const b = cameraBasis(yaw, pitch)
    const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2]
    ok(near(dot(b.f, b.r), 0, 1e-9) && near(dot(b.f, b.u), 0, 1e-9) && near(dot(b.r, b.u), 0, 1e-9),
      `正交 yaw=${yaw} pitch=${pitch}`)
    ok(near(dot(b.f, b.f), 1, 1e-9) && near(dot(b.r, b.r), 1, 1e-9) && near(dot(b.u, b.u), 1, 1e-9), `单位长度 yaw=${yaw}`)
  }
  const cross = (a, c) => [a[1] * c[2] - a[2] * c[1], a[2] * c[0] - a[0] * c[2], a[0] * c[1] - a[1] * c[0]]
  const b = cameraBasis(0.4, 0.3)
  const cu = cross(b.r, b.f)
  ok(near(cu[0], b.u[0], 1e-9) && near(cu[1], b.u[1], 1e-9) && near(cu[2], b.u[2], 1e-9), 'u = r × f', JSON.stringify([cu, b.u]))
}

console.log('— 2. 罗盘 —')
ok(compassOf(0) === '北(N,-Z)', 'yaw=0 → 北', compassOf(0))
ok(compassOf(-Math.PI / 2) === '东(E,+X)', 'yaw=-90° → 东', compassOf(-Math.PI / 2))
ok(compassOf(Math.PI / 2) === '西(W,-X)', 'yaw=90° → 西', compassOf(Math.PI / 2))
ok(compassOf(Math.PI) === '南(S,+Z)', 'yaw=180° → 南', compassOf(Math.PI))

console.log('— 3. 方位标记世界（每个方向一块独特的方块，看准星命中什么）—')
{
  const marker = {
    getBlock (pos) {
      // 真实世界是 prismarine-world，getBlock 会调 pos.floored()（worldsync.js:102）。
      // 这里照抄，避免"只传纯 {x,y,z}"的写法在真实服务器上才炸。
      const { x, y, z } = pos.floored()
      if (y === 0) return { name: 'grass_block', boundingBox: 'block' }
      if (y === 1) {
        if (x === 0 && z === -5) return { name: 'emerald_block', boundingBox: 'block' } // 北
        if (x === 0 && z === 5) return { name: 'redstone_block', boundingBox: 'block' } // 南
        if (x === 5 && z === 0) return { name: 'gold_block', boundingBox: 'block' } // 东
        if (x === -5 && z === 0) return { name: 'diamond_block', boundingBox: 'block' } // 西
      }
      return { name: 'air', boundingBox: 'empty' }
    },
  }
  const shot = (yaw, pitch = 0) => renderView({ world: marker, origin: [0, 1.62, 0], yaw, pitch, width: 65, height: 33, crosshair: false, hand: false })
  const c = (yaw, pitch) => { const h = shot(yaw, pitch).center; return h ? h.name : 'sky' }
  ok(c(0) === 'emerald_block', 'yaw=0 准星 = 北边的 emerald_block', c(0))
  ok(c(-Math.PI / 2) === 'gold_block', 'yaw=-90° 准星 = 东边的 gold_block', c(-Math.PI / 2))
  ok(c(Math.PI / 2) === 'diamond_block', 'yaw=90° 准星 = 西边的 diamond_block', c(Math.PI / 2))
  ok(c(Math.PI) === 'redstone_block', 'yaw=180° 准星 = 南边的 redstone_block', c(Math.PI))
  ok(c(0, Math.PI / 2) === 'sky', '抬头 90° = 天空', c(0, Math.PI / 2))
  ok(c(0, -Math.PI / 2 + 0.01) === 'grass_block', '低头 90° = 脚下草地', c(0, -Math.PI / 2 + 0.01))
  const h = shot(0).center
  ok(Math.abs(h.dist - 4) < 1e-6, '北边标记距离 = 4 格（方块近面在 z=-4）', String(h && h.dist))
  ok(h.axis === 2 && h.step === -1, '从 +Z 面进入（axis=2, step=-1）', h && `${h.axis}/${h.step}`)
  ok(h.bx === 0 && h.by === 1 && h.bz === -5, '命中方块坐标 (0,1,-5)', h && `${h.bx},${h.by},${h.bz}`)
}

console.log('— 4. DDA 边界情况 —')
{
  const flat = { getBlock: ({ y }) => (y === 0 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) }
  ok(castRay(flat, 0, 1.62, 0, 0, -1, 0, 8) !== null, '垂直向下命中')
  ok(castRay(flat, 0, 1.62, 0, 0, 0, -1, 8) === null, '水平朝北不命中（脚下是 y=0，眼睛 1.62 之上没东西）')
  ok(castRay(flat, 0, 1.62, 0, 0, 1, 0, 8) === null, '垂直向上不命中')
  const unloaded = { getBlock: () => null }
  const u = castRay(unloaded, 0, 1.62, 0, 0, 0, -1, 8)
  ok(u && u.unknown === true, '全是 null → unknown')
  const inside = { getBlock: () => ({ name: 'stone', boundingBox: 'block' }) }
  const ins = castRay(inside, 0.5, 0.5, 0.5, 0, 0, -1, 8)
  ok(ins !== null && ins.dist <= 0.51, '眼在实体方块内 → 立刻命中', ins && String(ins.dist))
  const torchWorld = { getBlock: ({ z }) => (z === -3 ? { name: 'torch', boundingBox: 'empty' } : z === -5 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' }) }
  const th = castRay(torchWorld, 0, 1.62, 0, 0, 0, -1, 8)
  ok(th && th.name === 'stone', '火把（empty）穿过去，命中后面的石头', th && th.name)
  const waterWorld = { getBlock: ({ z }) => (z === -3 ? { name: 'water', boundingBox: 'empty' } : { name: 'air', boundingBox: 'empty' }) }
  const wh = castRay(waterWorld, 0, 1.62, 0, 0, 0, -1, 8)
  ok(wh && wh.name === 'water', '水（empty 但液体）要停下', wh && wh.name)
  const t0 = Date.now()
  const r2 = castRay({ getBlock: () => ({ name: 'air', boundingBox: 'empty' }) }, 0, 1.62, 0, 0, 0, -1, 4096, null, 512)
  ok(r2 === null && Date.now() - t0 < 200, '空世界走满步数不死循环')
}

console.log('— 5. 调色板 / 贴图规则 / 方块名判定 —')
{
  ok(dom(colorOf('grass_block'), 1), 'grass_block 以绿为主', JSON.stringify(colorOf('grass_block')))
  ok(dom(colorOf('oak_planks'), 0), 'oak_planks 以棕（红）为主', JSON.stringify(colorOf('oak_planks')))
  ok(dom(colorOf('redstone_block'), 0), 'redstone_block 以红为主（走 /redstone/ 而不是 /stone/）', JSON.stringify(colorOf('redstone_block')))
  ok(colorOf('redstone_block')[0] - colorOf('stone')[0] > 50, 'redstone 明显比石头红')
  const rs = colorOf('red_sand')
  ok(rs[0] > 190 && rs[1] > 170, 'red_sand 走 /sand/（偏沙色，不是红石块）', JSON.stringify(rs))
  const ds = colorOf('deepslate')
  ok(ds[0] < 115 && Math.abs(ds[0] - ds[1]) < 14, 'deepslate 走 /deepslate/（暗灰）', JSON.stringify(ds))
  const es = colorOf('end_stone')
  ok(es[0] > 110 && Math.abs(es[0] - es[1]) < 14, 'end_stone 走 /stone/ 兜底（浅灰）', JSON.stringify(es))
  ok(JSON.stringify(colorOf(null)) === JSON.stringify([150, 150, 150]), '未知 → 灰')
  ok(typeof ruleOf('oak_planks').pattern === 'string', 'ruleOf 带 pattern（程序化贴图）', ruleOf('oak_planks').pattern)
  ok(ruleOf('grass_block').side !== undefined && ruleOf('grass_block').sidePattern === 'dirt', 'grass_block 有侧面专用规则（草皮+泥土）')
  ok(isGlassName('glass') === true && isGlassName('stone') === false, 'isGlassName')
  ok(isEmissiveName('glowstone') === true && isEmissiveName('stone') === false, 'isEmissiveName')
  ok(isAirName('air') && isAirName('cave_air') && isAirName('void_air') && !isAirName('water'), 'isAirName')
  ok(isWaterName('water') && !isWaterName('lava') && isLavaName('lava'), 'isWaterName / isLavaName')
}

console.log('— 6. 整帧渲染（纹理 / AO / 准星 / 未加载 / 昼夜 / 雾 / 手持物）—')
{
  const { frame, world, entities } = selfTest()
  const W = 192
  const H = 108
  const base = { world, origin: [0, 1.62, 0], yaw: 0, pitch: 0, width: W, height: H, entities, held: 'diamond_pickaxe', time: 4000 }
  ok(frame.stats.pixels === W * H, '像素数')
  ok(frame.stats.hit > 0, '有命中', JSON.stringify(frame.stats.top))
  ok(frame.stats.unknown > 0, '有未加载像素', String(frame.stats.unknown))
  ok(frame.stats.sky > 0, '有天空像素', String(frame.stats.sky))
  ok(frame.center && frame.center.name === 'oak_planks', '中心（准星）是那面 oak_planks 墙', frame.center && frame.center.name)
  ok(frame.stats.top.length > 0 && /oak_planks|grass_block/.test(frame.stats.top[0].name), 'top 统计里有墙/草地', JSON.stringify(frame.stats.top[0]))
  const c = px(frame, W >> 1, H >> 1)
  ok(c[0] > c[1] && c[1] > c[2] && c[0] > 90, '中心像素是木头色（棕）', JSON.stringify(c))

  // 纹理开关：关掉纹理后颜色种类明显减少
  const noTex = renderView({ ...base, texture: false })
  ok(uniqColors(noTex) < uniqColors(frame), '关掉纹理后颜色种类明显变少', `tex=${uniqColors(frame)} flat=${uniqColors(noTex)}`)
  ok(!same(px(noTex, W >> 1, H >> 1), c), '纹理确实改变了像素')

  // 准星：中心留空、横臂纯白、带黑描边
  const noCross = renderView({ ...base, crosshair: false })
  const withCross = renderView({ ...base, crosshair: true })
  ok(same(px(noCross, 96, 54), px(withCross, 96, 54)), '准星中心留空（不覆盖准星那一格）', JSON.stringify(px(withCross, 96, 54)))
  ok(same(px(withCross, 99, 54), [255, 255, 255]), '准星横臂是纯白', JSON.stringify(px(withCross, 99, 54)))
  ok(same(px(withCross, 99, 55), [24, 24, 24]), '准星带黑描边', JSON.stringify(px(withCross, 99, 55)))

  // 未加载区块：暗紫，且只在 +X 右半边
  const isUnloaded = (p) => p[0] > 100 && p[0] < 145 && p[1] > 40 && p[1] < 65 && p[2] > 125 && p[2] < 175 && p[2] > p[0]
  let left = 0
  let right = 0
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (isUnloaded(px(frame, x, y))) (x < W / 2 ? left++ : right++)
    }
  }
  ok(right > 0 && left === 0, '未加载（暗紫）只出现在画面右半边（+X 侧）', `left=${left} right=${right}`)

  // 昼夜：白天天空比夜里亮
  const bright = (f) => {
    let s = 0
    for (let y = 0; y < 12; y++) for (let x = 0; x < W; x++) { const p = px(f, x, y); s += p[0] + p[1] + p[2] }
    return s / (12 * W * 3)
  }
  const day = renderView({ ...base, time: 6000, sky: true })
  const night = renderView({ ...base, time: 18000, sky: true })
  ok(bright(day) > bright(night) + 30, '白天天空明显比夜里亮', `day=${Math.round(bright(day))} night=${Math.round(bright(night))}`)

  // 雾：远处方块被雾拉向天空色（蓝通道升高）
  const clear = renderView({ ...base, distance: 12, fogStart: 1 })
  const foggy = renderView({ ...base, distance: 12, fogStart: 0.05 })
  const cc = px(clear, W >> 1, H >> 1)
  const ff = px(foggy, W >> 1, H >> 1)
  ok(ff[2] > cc[2] + 30, '远处的墙被雾拉向天空色（更蓝）', `${JSON.stringify(cc)} → ${JSON.stringify(ff)}`)

  // 手持物：右下角手臂/手持物
  const noHand = renderView({ ...base, hand: false })
  ok(!same(px(noHand, W - 3, H - 3), px(frame, W - 3, H - 3)), '右下角画了手臂（hand=true 与 false 不同）')
  let skin = 0
  for (let y = H - 30; y < H; y++) for (let x = W - 40; x < W; x++) {
    const p = px(frame, x, y)
    if (Math.abs(p[0] - 228) < 26 && Math.abs(p[1] - 178) < 26 && Math.abs(p[2] - 148) < 26) skin++
  }
  ok(skin > 8, '右下角能找到手臂皮肤色', String(skin))

  /* 🔴 2026-10-08 审计（子代理探针 p3）：`status().held` 是 `oak_planksx1`（名字 + x数量），
   *    而 `colorOf` 的规则带锚点（`/_planks$/` 等）⇒ 一个都匹配不上 ⇒ 永远落 FALLBACK 灰。
   *    这两条钉死：带不带 xN 渲染要一致；物品框四条边都要画出来（边框判据笔误那条）。 */
  const handPlain = renderView({ ...base, held: 'oak_planks', hand: true })
  const handCount = renderView({ ...base, held: 'oak_planksx12', hand: true })
  ok(same(handPlain.rgba, handCount.rgba), 'held 带 xN 后缀与不带渲染一致（先归一化再匹配颜色）')
  const fallbackGray = [150, 150, 150]
  const itemPx = (f) => {
    let n = 0
    for (let y = H - 40; y < H; y++) for (let x = W - 40; x < W; x++) {
      const p = px(f, x, y)
      if (same(p, fallbackGray)) n++
    }
    return n
  }
  ok(itemPx(handCount) === 0, '手持物色块不再整块 fallback 灰', String(itemPx(handCount)))
  // 边框 [28,28,32] 应该左右对称（旧版右边框恒不绘制）
  const border = [28, 28, 32]
  const colCount = (f, x) => {
    let n = 0
    for (let y = H - 40; y < H; y++) if (same(px(f, x, y), border)) n++
    return n
  }
  const cols = []
  for (let x = W - 40; x < W; x++) if (colCount(handCount, x) > 0) cols.push(x)
  ok(cols.length > 2 && colCount(handCount, cols[0]) === colCount(handCount, cols[cols.length - 1]),
    '物品框右边框画出来了（左右两边像素数相同）',
    `left=${cols[0]}:${colCount(handCount, cols[0])} right=${cols[cols.length - 1]}:${colCount(handCount, cols[cols.length - 1])}`)

  // 确定性
  const again = renderView(base)
  let diff = 0
  for (let i = 0; i < frame.rgba.length; i++) if (frame.rgba[i] !== again.rgba[i]) diff++
  ok(diff === 0, '同参数渲两次逐字节一致', String(diff))

  writeFileSync(join(outDir, 'view-forward.png'), encodePng(W, H, frame.rgba))
  const f2 = renderView({ ...base, yaw: -Math.PI / 2 })
  writeFileSync(join(outDir, 'view-east.png'), encodePng(W, H, f2.rgba))
  const f3 = renderView({ ...base, pitch: -0.35 })
  writeFileSync(join(outDir, 'view-down.png'), encodePng(W, H, f3.rgba))
  const f4 = renderView({ ...base, time: 18000 })
  writeFileSync(join(outDir, 'view-night.png'), encodePng(W, H, f4.rgba))
  const f5 = renderView({ ...base, yaw: 0.38, pitch: 0.065 })
  writeFileSync(join(outDir, 'view-aim-steve.png'), encodePng(W, H, f5.rgba))
  console.log(`  对照图写到了 ${outDir}（view-forward / view-east / view-down / view-night / view-aim-steve）`)
}

console.log('— 7. 实体（投影 / 遮挡 / 准星 / 造型）—')
{
  const { world, entities } = selfTest()
  const W = 192
  const H = 108
  const base = { world, origin: [0, 1.62, 0], yaw: 0, pitch: 0, width: W, height: H, crosshair: false, hand: false, time: 4000 }
  const frame = renderView({ ...base, entities })
  const steve = frame.stats.entities.find((e) => e.name === 'Steve')
  const zombie = frame.stats.entities.find((e) => e.name === 'zombie')
  ok(frame.stats.entitiesDrawn === 2, '两个实体都画出来了', String(frame.stats.entitiesDrawn))
  ok(frame.stats.entityPixels > 100, '实体像素数合理', String(frame.stats.entityPixels))
  ok(steve && steve.shape === 'player' && steve.pixels > 0, 'Steve 是人形且有像素', JSON.stringify(steve))
  ok(steve && steve.screen.xPct < 50, 'Steve 在画面左半边（他在 -X 侧）', steve && String(steve.screen.xPct))
  ok(steve && Math.abs(steve.distance - 4.3) < 0.3, 'Steve 距离 ≈4.3 格', steve && String(steve.distance))
  ok(zombie && zombie.hostile === true && zombie.pixels > 0, 'zombie 是敌对且有像素', JSON.stringify(zombie))
  ok(zombie && zombie.screen.xPct > 50, 'zombie 在画面右半边（他在 +X 侧）', zombie && String(zombie.screen.xPct))
  ok(steve && zombie && steve.color !== zombie.color, '两个实体颜色不同', `${steve && steve.color} / ${zombie && zombie.color}`)
  ok(/^#[0-9a-f]{6}$/.test(steve.color), '颜色是 hex 字符串', steve.color)

  // 墙后的实体：0 像素
  const hidden = [{ id: 9, type: 'player', username: 'Hidden', x: 0, y: 1, z: -10, width: 0.6, height: 1.8 }]
  const hf = renderView({ ...base, entities: hidden })
  ok(hf.stats.entities[0].pixels === 0 && hf.stats.entitiesDrawn === 0, '墙后的玩家被挡住（0 像素）', JSON.stringify(hf.stats.entities[0]))

  // 关掉实体
  const off = renderView({ ...base, entities: false })
  ok(off.stats.entitiesDrawn === 0 && off.stats.entities.length === 0, 'entities:false 不画实体')
  let entDiff = 0
  for (let i = 0; i < frame.rgba.length; i++) if (frame.rgba[i] !== off.rgba[i]) entDiff++
  ok(entDiff > 100, '画不画实体确实改变了像素（差异像素数）', String(entDiff))

  // 准星正对实体：把视线瞄准 Steve 的包围盒中心
  const aim = renderView({ ...base, yaw: 0.3805, pitch: 0.065, entities })
  ok(aim.stats.crosshairEntity && aim.stats.crosshairEntity.name === 'Steve',
    '瞄准 Steve 时 crosshairEntity = Steve', JSON.stringify(aim.stats.crosshairEntity))
  ok(aim.stats.crosshairEntity && aim.stats.crosshairEntity.underCrosshair === true, 'underCrosshair 标记为 true')
  // 视线偏开一点就不该再算"正对着"（投影中心靠近画面中心的老写法会误判远处小实体）
  const miss = renderView({ ...base, yaw: 0.3805 + 0.16, pitch: 0.065, entities })
  ok(miss.stats.crosshairEntity === null, '视线偏开 0.16 rad 后不再算"正对着"', JSON.stringify(miss.stats.crosshairEntity))

  // entityBoxOf / entityStyle / entityParts
  const box = entityBoxOf({ x: 1, y: 2, z: 3, width: 0.6, height: 1.8 })
  ok(near(box.minY, 2) && near(box.maxY, 3.8) && near(box.cy, 2.9) && near(box.minX, 0.7) && near(box.maxX, 1.3),
    'entityBoxOf：脚底 y、宽高、中心', JSON.stringify(box))
  ok(entityBoxOf(null) === null && entityBoxOf({ x: 1 }) === null, 'entityBoxOf 对缺字段返回 null')
  ok(entityStyle({ type: 'player', username: 'Alice' }).label === 'Alice', '玩家 label = 用户名')
  ok(entityStyle({ type: 'mob', name: 'zombie' }).hostile === true, 'zombie → 敌对')
  ok(entityStyle({ type: 'mob', name: 'cow' }).hostile === false, 'cow → 非敌对')
  ok(entityStyle({ type: 'orb' }).shape === 'item' && entityStyle({ type: 'orb' }).label === '经验球', '经验球 → 小方块')
  ok(entityStyle({ type: 'player', username: 'A' }).color !== entityStyle({ type: 'mob', name: 'zombie' }).color, '玩家与僵尸配色不同')
  const parts = entityParts({ x: 0, y: 1, z: 0, width: 0.6, height: 1.8 }, entityStyle({ type: 'player', username: 'Alice' }))
  ok(parts.length === 6, '玩家拆成 6 个部件（两条腿分开 + 身 + 头 + 两臂）', String(parts.length))
  ok(parts.filter((p) => p.mark === true).length === 1, '只有一个部件带头部标记（脸）')
  const head = parts.find((p) => p.mark === true)
  ok(head && near(head.maxY, 2.8) && near(head.maxY - head.minY, 0.45, 1e-9),
    '头在最上面、高 0.45（8 像素 × 1.8/32，MC 原始比例）', JSON.stringify(head))
  ok(parts.every((p) => p.minY >= 1 - 1e-9 && p.maxY <= 2.8 + 1e-9), '所有部件都在 1..2.8 之间（脚底对齐）')
  // 两条腿左右分开（MC 模型：每条腿 4 像素宽、位于 ±2 像素）
  const legs = parts.filter((p) => p.minY < 1.2)
  ok(legs.length === 2, '两条腿是分开的两个部件', String(legs.length))
  ok(legs.length === 2 && Math.abs(legs[0].minX - legs[1].minX) > 0.05, '两条腿左右不重叠')
}

console.log('— 8. 皮肤（真实皮肤按 MC 布局贴到模型各面 + 朝向）—')
{
  // 造一张"每个面一个颜色"的皮肤（用官方硬编码坐标，独立于被测代码）
  const raw = { width: 64, height: 64, rgba: new Uint8Array(64 * 64 * 4) }
  const fill = (x0, y0, w, h, [r, g, b, a = 255]) => {
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        const o = (y * 64 + x) * 4
        raw.rgba[o] = r; raw.rgba[o + 1] = g; raw.rgba[o + 2] = b; raw.rgba[o + 3] = a
      }
    }
  }
  fill(8, 8, 8, 8, [255, 0, 0])       // 头 正面 红
  fill(24, 8, 8, 8, [0, 255, 0])      // 头 背面 绿
  fill(0, 8, 8, 8, [0, 0, 255])       // 头 右侧 蓝
  fill(16, 8, 8, 8, [255, 255, 0])    // 头 左侧 黄
  fill(8, 0, 8, 8, [255, 0, 255])     // 头 顶面 品红
  fill(20, 20, 8, 12, [255, 128, 0])  // 身体 正面 橙
  const skin = makeSkin({ ...raw, model: 'classic' })

  const W = 192
  const H = 108
  const world = { getBlock (pos) { const p = pos.floored(); return p.y <= 63 ? { name: 'stone' } : null } }
  const ent = { id: 1, type: 'player', username: 'Skinny', x: 0, y: 64, z: -3, width: 0.6, height: 1.8, yaw: Math.PI }
  const base = {
    world, origin: [0, 65.62, 0], yaw: 0, pitch: 0, width: W, height: H,
    crosshair: false, hand: false, time: 4000, entities: [ent],
  }
  const k = 1.8 / 32
  const tanY = Math.tan(35 * Math.PI / 180)
  const screenY = (wy) => Math.round((0.5 - ((wy - 65.62) / (3 * tanY)) * 0.5) * H)
  const headY = screenY(64 + 28 * k)
  const bodyY = screenY(64 + 18 * k)
  const isCol = (c, name) => {
    if (name === '红') return c[0] > 150 && c[1] < 80 && c[2] < 80
    if (name === '绿') return c[1] > 150 && c[0] < 80 && c[2] < 80
    if (name === '蓝') return c[2] > 150 && c[0] < 80 && c[1] < 80
    if (name === '黄') return c[0] > 150 && c[1] > 150 && c[2] < 80
    if (name === '橙') return c[0] > 150 && c[1] > 60 && c[1] < 160 && c[2] < 60
    return false
  }
  const look = (yaw) => renderView({ ...base, entities: [{ ...ent, yaw }], skins: { Skinny: skin } })
  const front = look(Math.PI)
  const back = look(0)
  const left = look(Math.PI / 2)
  const right = look(-Math.PI / 2)
  const at = (f) => px(f, W / 2, headY, W)
  ok(front.stats.skinned === 1, 'stats.skinned = 1', String(front.stats.skinned))
  ok(isCol(at(front), '红'), '面向相机 → 头正面（贴图正面）红', JSON.stringify(at(front)))
  ok(isCol(at(back), '绿'), '背对相机 → 头背面（贴图背面）绿', JSON.stringify(at(back)))
  ok(isCol(at(left), '黄'), '侧身（yaw=90°）→ 头左侧 黄', JSON.stringify(at(left)))
  ok(isCol(at(right), '蓝'), '侧身（yaw=-90°）→ 头右侧 蓝', JSON.stringify(at(right)))
  ok(isCol(px(front, W / 2, bodyY, W), '橙'), '身体正面是贴图的橙色', JSON.stringify(px(front, W / 2, bodyY, W)))
  // 四个朝向互不相同（真的转了）
  const set = new Set([at(front), at(back), at(left), at(right)].map((c) => c.join(',')))
  ok(set.size === 4, '四个朝向的头颜色互不相同', String(set.size))
  writeFileSync(join(outDir, 'view-skin-front.png'), encodePng(W, H, front.rgba))
  writeFileSync(join(outDir, 'view-skin-left.png'), encodePng(W, H, left.rgba))

  // 没皮肤时不贴图（回退默认配色 + 画眼睛标记），像素要和贴图版不同
  const plain = renderView({ ...base, entities: [{ ...ent }] })
  ok(plain.stats.skinned === 0, '没给皮肤时 stats.skinned = 0', String(plain.stats.skinned))
  ok(!same(at(plain), at(front)), '有皮肤 / 没皮肤的头像素不同')
  const style = entityStyle(ent)
  ok(entityParts(ent, style).filter((p) => p.mark === true).length === 1, '没皮肤时画眼睛标记')
  ok(entityParts(ent, style, skin).filter((p) => p.mark === true).length === 0, '有真皮肤时不再画眼睛标记')

  // slim 细臂 / 披风
  const armR = entityParts(ent, style, skin).find((p) => p.skinPart === 'rightArm')
  ok(armR && near(armR.local.hx, 2 * k, 1e-9), '普通右臂半宽 2 像素', armR && String(armR.local.hx))
  const slimSkin = makeSkin({ ...raw, model: 'slim' })
  const slimParts = entityParts(ent, style, slimSkin)
  const slimArm = slimParts.find((p) => p.skinPart === 'rightArm')
  ok(slimArm && near(slimArm.local.hx, 1.5 * k, 1e-9), 'slim 右臂半宽 1.5 像素', slimArm && String(slimArm.local.hx))
  const capeSkin = makeSkin({ ...raw, model: 'classic', cape: { width: 64, height: 32, rgba: new Uint8Array(64 * 32 * 4) } })
  const capeParts = entityParts(ent, style, capeSkin)
  ok(capeParts.length === 7 && capeParts.some((p) => p.cape === true), '有披风时多一个披风部件（7 个）', String(capeParts.length))
}

console.log('— 9. 性能（默认 192×108 + 更大档）—')
{
  const { world, entities } = selfTest()
  for (const [w, h] of [[192, 108], [384, 216], [640, 360]]) {
    const t0 = Date.now()
    renderView({ world, origin: [0, 1.62, 0], yaw: 0.3, pitch: -0.1, width: w, height: h, distance: 48, entities })
    console.log(`  ${w}×${h}  ${Date.now() - t0} ms`)
  }
  console.log(`  默认档 = ${VIEW_DEFAULTS.width}×${VIEW_DEFAULTS.height}（${VIEW_DEFAULTS.texture ? '纹理' : '纯色'} / ${VIEW_DEFAULTS.ao ? 'AO' : '无AO'} / ${VIEW_DEFAULTS.entities ? '实体' : '无实体'}）`)
}

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：pass=${pass} fail=${fail}`)
if (!process.argv.includes('--keep')) {
  try { rmSync(outDir, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
  console.log(`（对照图目录 ${outDir} 已清理；想留着看图加 --keep）`)
}
process.exit(fail === 0 ? 0 : 1)
