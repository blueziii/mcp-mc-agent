#!/usr/bin/env node
/**
 * check-watch-chat.mjs —— 看门狗「玩家在公屏说话 → 叫醒 AI」这条链路
 *
 * 为什么需要它：2026-10-06 用户报告"我游戏里输入的它好像看不到了"。真机定位结论：
 *   · 聊天链路本身是好的（探针证明能收到 `system_chat`，`#playerChatFrom` 的兜底正则认得出）；
 *   · 但**唤醒条件**一条都没命中 —— 玩家切**旁观模式**后 `bot.players[who].entity` 直接是
 *     undefined（实测打印 `Bluezi: entity=没有 gamemode=3`），于是 `nearbySpeech` 永远不成立；
 *     而"你在干嘛"这类话里不含任何叫法 ⇒ `mention` + `nearbySpeech` 两条主通道全哑，
 *     AI 只能靠自己碰巧轮询 `mc_events` 才看得到（转写里它第 132/143 步确实轮询到了）。
 *   → 加 `wakeOn.anyChat`（默认开）：任何玩家说话都叫醒，仍受 `maxWakePerMinute` 限流。
 *
 * 用法：node tools/check-watch-chat.mjs
 *   ⚠️ 必须从**包目录**跑（要 node_modules）；工作区根目录跑会因为解析不到依赖而 ERR_MODULE_NOT_FOUND。
 */
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const { Watchdog, WATCH_DEFAULTS } = await import(new URL('../src/watchdog.mjs', import.meta.url))

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const ME = { x: 0, y: 64, z: 0 }
const at = (dx, dy, dz) => ({ x: ME.x + dx, y: ME.y + dy, z: ME.z + dz })

/** 假会话：`sess.bot` 是事件源，`sess.bot.bot` 是 mineflayer bot（#isNearby 读它） */
function mkSess ({ players = {}, withMe = true } = {}) {
  const bot = new EventEmitter()
  bot.online = true
  bot.sub = ''
  bot.bot = {
    entity: withMe ? { position: { ...ME } } : undefined,
    players,
    username: 'DeepSeek',
  }
  return { bot, events: [], config: {} }
}

/** 假看门狗（无宿主 jobs → 自动降级成"无 job"模式） */
function mkWd (opts = {}) {
  const injected = []
  const agent = { status: 'idle', steer: (msg) => { injected.push(msg); return true } }
  const wd = new Watchdog({
    ctx: { get: () => undefined, logger: { info () {}, warn () {}, debug () {} } },
    sess: mkSess(opts),
    agent,
    onFire: () => {},
  })
  if (opts.config) wd.updateConfig(opts.config)
  wd.arm()
  return { wd, injected }
}

const reasonsOf = (wd) => (wd.pending?.[0]?.reasons ?? [])
const textOf = (msg) => String(msg?.content?.[0]?.text ?? '')

// ── 1. 默认值 + 文档 ──────────────────────────────────────────────────────────
section('1. 默认值与工具文案')
ok(WATCH_DEFAULTS.wakeOn.anyChat === true, '🔴 唤醒矩阵新增 wakeOn.anyChat，默认开（任何玩家说话都叫醒）')
ok(WATCH_DEFAULTS.wakeOn.mention === true && WATCH_DEFAULTS.wakeOn.nearbySpeech === true,
  '原有两个聊天通道没被顶掉（mention / nearbySpeech 仍默认开）')
{
  const src = readFileSync(fileURLToPath(new URL('../index.js', import.meta.url)), 'utf8')
  ok(src.includes('wakeOn.anyChat'), 'mc_watch 工具描述里写明了 anyChat（AI 知道自己为什么会醒）')
  ok(src.includes('任何玩家说话'), '描述里用了"任何玩家说话"这句人话')
}

// ── 2. 旁观模式：拿不到玩家实体，也必须能叫醒 ────────────────────────────────
section('2. 旁观模式（entity 拿不到）—— 兜底通道')
{
  // 真机形状：gamemode=3 的玩家在 bot.players 里，但 entity 是 undefined
  const { wd } = mkWd({ players: { Bluezi: { gamemode: 3 } } })
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: '你在干嘛' })
  const r = reasonsOf(wd)
  ok(r.includes('anyChat'), '不含叫法 + 看不到实体 → 兜底唤醒', JSON.stringify(r))
  ok(!r.includes('nearbySpeech'), '确实没走 nearbySpeech（实体拿不到，距离无从算起）')
  ok(wd.log.some((e) => e.kind === 'chat'), '事件仍然记档（mc_watch log / mc_events 看得到）')
  wd.disarm('自检结束', { notify: false })
}

// ── 3. 近距 / 远距 ───────────────────────────────────────────────────────────
section('3. 近距说话 vs 远距离说话')
{
  const near = mkWd({ players: { Bluezi: { gamemode: 0, entity: { position: at(5, 0, 0) } } } })
  near.wd.sess.bot.emit('chat', { who: 'Bluezi', text: '这边有矿洞' })
  const rn = reasonsOf(near.wd)
  ok(rn.includes('nearbySpeech'), '5 格内说话 → 按"身边有人说话"走', JSON.stringify(rn))
  ok(!rn.includes('anyChat'), '近距命中时不抢兜底标签（AI 分得清"就在旁边"和"有人在说话"）')
  near.wd.disarm('自检结束', { notify: false })

  const far = mkWd({ players: { Bluezi: { gamemode: 0, entity: { position: at(40, 0, 0) } } } })
  far.wd.sess.bot.emit('chat', { who: 'Bluezi', text: '这边有矿洞' })
  const rf = reasonsOf(far.wd)
  ok(rf.includes('anyChat') && !rf.includes('nearbySpeech'),
    '40 格外（>nearRadius 16）说话 → 靠兜底唤醒', JSON.stringify(rf))
  far.wd.disarm('自检结束', { notify: false })
}

// ── 4. 点名优先 ──────────────────────────────────────────────────────────────
section('4. 被点名时按"有人喊我"走')
{
  const { wd } = mkWd({ players: { Bluezi: { gamemode: 3 } } })
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: 'DeepSeek 过来一下' })
  const r = reasonsOf(wd)
  ok(r.includes('mention') && !r.includes('anyChat'), '喊名字 → mention（兜底不抢）', JSON.stringify(r))
  wd.disarm('自检结束', { notify: false })
}

// ── 5. 关掉 anyChat 就回到"必须点名或近距" ───────────────────────────────────
section('5. 关掉 anyChat（留给"只有被点名才理"的用法）')
{
  const { wd } = mkWd({ players: { Bluezi: { gamemode: 3 } }, config: { wakeOn: { anyChat: false } } })
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: '你在干嘛' })
  ok(wd.pending.length === 0, '关掉后同样的发言不唤醒')
  ok(wd.log.some((e) => e.kind === 'chat'), '但照样记档（不丢事件，AI 轮询 mc_events 仍看得到）')
  wd.disarm('自检结束', { notify: false })
}

// ── 6. 注入文案（提示词注入，不是用户消息）───────────────────────────────────
section('6. 注入文案')
{
  const { wd, injected } = mkWd({
    players: { Bluezi: { gamemode: 3 } },
    config: { observeWindowMs: 1 },
  })
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: '你怎么不动了' })
  await sleep(1200)                        // tick 是 1s 一跳
  const text = textOf(injected[0])
  ok(injected.length === 1, '观察窗口到期后注入一次', `${injected.length} 次`)
  ok(text.includes('【MC 看门狗｜有人说话】'), '标题用"有人说话"标签', text.split('\n')[0])
  ok(text.includes('· [有人说话] <Bluezi> 你怎么不动了'), '正文带上原话与说话人')
  ok(injected[0]?.source?.kind === 'plugin:mcp-mc-agent' && injected[0]?.source?.form === 'notice',
    '走 plugin notice（提示词注入），不冒充用户发言', JSON.stringify(injected[0]?.source))
  ok(wd.stats.injected === 1 && wd.stats.fired === 1, 'stats 记到 injected/fired 各 1')
  wd.disarm('自检结束', { notify: false })
}

// ── 7. 限流仍然生效 ──────────────────────────────────────────────────────────
section('7. 限流（任何玩家说话都叫醒 ≠ 无限叫醒）')
{
  const { wd } = mkWd({
    players: { Bluezi: { gamemode: 3 } },
    config: { observeWindowMs: 1, maxWakePerMinute: 1 },
  })
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: '第一句' })
  await sleep(1200)
  wd.sess.bot.emit('chat', { who: 'Bluezi', text: '第二句' })
  await sleep(1200)
  ok(wd.stats.fired === 1, '每分钟上限 1 → 只醒一次', `fired=${wd.stats.fired}`)
  ok(wd.stats.dropped >= 1, '第二次被限流丢弃并计数', `dropped=${wd.stats.dropped}`)
  ok(wd.log.some((e) => /唤醒被限流丢弃/.test(e.text)), '限流也留了痕（mc_watch log 能查）')
  wd.disarm('自检结束', { notify: false })
}

// ── 收尾 ─────────────────────────────────────────────────────────────────────
console.log(`\n结果：${pass}/${pass + fail} 通过，${fail} 失败`)
process.exit(fail ? 1 : 0)
