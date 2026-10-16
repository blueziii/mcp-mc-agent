/**
 * 聊天记录那一层（第十六刀：从 `src\core.mjs` 搬出来的）。
 *
 * 六件事：把 mineflayer 的聊天/系统消息接到实例事件上（`wireChatEvents`）、
 * 消息转纯文本（`plainText`）、认出"玩家在说话"（`playerChatFrom`）、
 * 一条聊天进账（`emitPlayerChat`）、记进 `chat` 环形数组（`pushChat`）、
 * 自己往公屏说话（`chatSay`）。
 *
 * 规矩：
 *   · **这一层是有状态的**（`self.chat` 环形数组、`self.stats.chats`、`self._lastChatKey` 去重键、
 *     `self.emit()` 事件）—— 和第十五刀那种"纯动作 + ctx"不一样：这里第一参数**直接收 `self`**
 *     （迁移规矩第 20 条：无状态/只读层走 `ctx`，有可变实例状态的层直接收 `self`，
 *     否则要写一堆 getter/setter，只会更难读）；
 *   · 不 import `core.mjs`（反向依赖），也不 import 任何游戏库 —— 这一层只认
 *     `{ on, _client, username }` 这么几个字段，自检用假 bot 就能走同一条路。
 */
/**
 * 把 mineflayer 的聊天/系统消息接到本实例的 `chat` / `system` 事件上。
 *
 * 🔴🔴 2026-09-16 真机事故（用户："喊我不应，只能 tp 我"）：
 *    以前只有 `_client.on('player_chat')`（**签名**聊天包）才 `emit('chat')`，
 *    而 `bot.on('message')`（`system_chat`，**未签名**聊天）被一律当成 system 丢掉。
 *    对**局域网开放的世界 / 离线服 / 1.19+ 关掉签名聊天**的服务器，玩家说话走的正是
 *    `system_chat` → `player_chat` 永不触发 → 看门狗的 mention / nearbySpeech **全哑**，
 *    只剩 damage / death / teleport 能用（`stats.chats === 0`、看门狗日志里一条 chat 都没有）。
 *
 * 现在按 mineflayer 的约定分流（`lib/plugins/chat.js` 里两种包的 emit 签名）：
 *    · `position === 'chat'`  → 来自 playerChat（签名）→ 由下面的 `player_chat` handler 处理，
 *      这里**直接跳过**（否则同一条进两遍）
 *    · `position === undefined`→ 来自 systemChat 的 **positionId 0 = 聊天**（未签名）
 *    · `position === 'system'` → 来自 systemChat 的 **positionId 1**：**也要按"内容"再判一次**
 *      —— 有的服务端（LAN 开放世界 / 某些插件）把玩家聊天塞进 system 位置，渲染出来仍是
 *      `<名字> 正文`。实验体 2026-09-16 的证据就是这样：事件队列里全是 `kind: system`、
 *      文本形如 `<<user>> tp我，ds。`，而看门狗只对 `chat` 判定 ⇒ mention 永远打不中。
 *    · `position === 'game_info'`（动作栏）→ 一律 system（动作栏刷屏不该唤醒）
 *    · 其余 → 系统消息
 *
 * ⚠️ 这是**公开方法**（不放在 connect 里内联）：自检要能用假 bot 走同一条代码路径 ——
 *    "喊我能不能醒"这种链路，断言必须落在真实实现上，不能只 grep 源码。
 * @param {object} b mineflayer bot（`on` + `_client`）
 */
export function wireChatEvents (self, b) {
  b.on('message', (msg, position) => {
    const text = plainText(msg)
    if (position === 'chat') return                    // 签名聊天：player_chat 那条路已处理
    if (position !== 'game_info') {                    // 动作栏除外，其余都按内容再判一次
      const parsed = playerChatFrom(msg, text)
      if (parsed) {
        emitPlayerChat(self, parsed.who, parsed.text, b.username)
        return
      }
    }
    pushChat(self, 'system', null, text)
    self.emit('system', { text })
  })
  b._client?.on?.('player_chat', (p) => {
    const who = String(p?.networkName?.value ?? p?.networkName ?? '?')
    const text = p?.plainMessage ?? ''
    emitPlayerChat(self, who, text, b.username)
  })
  return b
}

export function plainText (msg) {
  try { return msg.toString().replace(/§./g, '') } catch { return String(msg) }
}

/**
 * 一条"玩家说话"进账（**唯一入口**：签名聊天与未签名聊天都走这里）。
 * 自带 1.5 秒去重：同一句同一人在极短时间内从两条路各来一次（理论上不会）也只发一次。
 */
export function emitPlayerChat (self, who, text, selfName) {
  const w = String(who ?? '?')
  const t = String(text ?? '')
  if (!t) return
  const key = `${w}\u0000${t}`
  const now = Date.now()
  if (self._lastChatKey === key && now - (self._lastChatAt ?? 0) < 1500) return
  /* 🔴 省 token：自己说的话服务端会**回显**一遍 —— `chatSay` 先记一条 `self`，回显又记一条 `player`，
   *    内容一字不差（`mc_status` 的 recentChat / `mc_events` 里就出现两条一模一样的）。
   *    自己的话只留 `self` 那条；别人说的话照旧记 `player`。 */
  if (w === selfName) {
    const last = self.chat[self.chat.length - 1]
    if (last?.kind === 'self' && last.text === t && now - last.at < 2000) return
  }
  self._lastChatKey = key
  self._lastChatAt = now
  pushChat(self, 'player', w, t)
  self.stats.chats++
  self.stats.lastEventAt = now
  if (w !== selfName) self.emit('chat', { who: w, text: t })
}

/**
 * 从 `bot.on('message')` 收到的消息里**认出"玩家聊天"**（未签名聊天：LAN 开放世界 / 离线服 / 1.19+）。
 *
 * 判据按 translate 键（服务端给的聊天类型），只认这几种"有人在说话"的：
 *    · `chat.type.text`                    —— 普通公屏（渲染成 `<名字> 正文`）
 *    · `chat.type.team.text` / `.team.*`    —— 队伍聊天（with = [队伍, 发送者, 正文]）
 *    · `commands.message.display.incoming` —— 别人私聊我（with = [发送者, 正文]）
 * ④ 兜底看**渲染出来的形状**：`<名字> 正文`。
 *    🔴 这条是从实验体的证据里补的（2026-09-16）：有的服务端把玩家聊天发在 **system 位置**
 *    （positionId 1），translate 也可能是它自己那套；但渲染出来就是 `<<user>> tp我，ds。`。
 *    只按 positionId / translate 判的话，这类消息会永远停在 system 桶里，mention 一辈子打不中。
 *    宁可偶尔把"看起来像聊天的系统消息"算成聊天（最多多醒一次），也不能漏掉真人喊话。
 * @returns {{who:string, text:string}|null}
 */
export function playerChatFrom (msg, plain) {
  const t = String(msg?.translate ?? '')
  const withParts = Array.isArray(msg?.with) ? msg.with : []
  const partText = (p) => {
    if (p === null || p === undefined) return ''
    if (typeof p === 'string') return p
    if (typeof p.text === 'string') return p.text
    try { return String(p) } catch { return '' }
  }

  // ① 队伍聊天：who 取**发送者**（with[1]），不是队伍名
  if (/^chat\.type\.team\./.test(t)) {
    const who = partText(withParts[1] ?? withParts[0])
    const body = partText(withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ② 普通公屏
  if (t === 'chat.type.text') {
    const who = partText(withParts[0])
    const body = partText(withParts[1] ?? withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ③ 私聊（/tell、/msg）
  if (t === 'commands.message.display.incoming') {
    const who = partText(withParts[0])
    const body = partText(withParts[1] ?? withParts[withParts.length - 1])
    if (body) return { who: who || '?', text: body }
  }
  // ④ 兜底：渲染出来就是 `<名字> 正文` 的形状（有些服务端用自定义 chat type，translate 不认识）
  const m = /^\s*<([^<>]{1,32})>\s*(.+)$/s.exec(String(plain ?? ''))
  if (m) return { who: m[1].trim(), text: m[2] }
  return null
}

export function pushChat (self, kind, who, text) {
  self.chat.push({ at: Date.now(), kind, who, text })
  if (self.chat.length > self.cfg.chatHistory) self.chat.splice(0, self.chat.length - self.cfg.chatHistory)
}

export function chatSay (self, text) {
  const b = self.requireBot()
  const t = String(text).replace(/[\r\n]+/g, ' ').slice(0, 220)
  /* 🔴 2026-10-08 审计：mineflayer 的 `bot.chat('/…')` 会当成**指令**发出去（走 `chat_command` 包），
   *    于是 `mc_say` 能绕过 `mc_command` 的指令白名单 —— 白名单就白设了。
   *    要执行指令一律走 mc_command（那道闸门在），别从公屏绕。 */
  if (t.startsWith('/')) {
    throw new Error('要说的话不能以 `/` 开头 —— 那样会被服务端当成**指令**执行，等于绕过指令白名单。'
      + '要执行指令请用 mc_command（只有白名单里的能用）；真想喊出斜杠就写全角 "／"')
  }
  b.chat(t)
  pushChat(self, 'self', b.username, t)
  return t
}
