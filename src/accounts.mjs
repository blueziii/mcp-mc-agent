// -*- coding: utf-8 -*-
/**
 * mcp-mc-agent / accounts.mjs —— MC账户库（元数据）+ 凭据封装（密码/token）
 * ============================================================================
 * 用户 2026-09-16 的要求：
 *   · 默认有一个**离线账户 DeepSeek**；离线账户可改名、可自定义 UUID
 *   · 可新建：离线账户 / **皮肤站账户**（默认 littleskin，可自己加认证服务器）/ 微软账户（暂不支持）
 *   · 已添加的认证服务器要**记住**，也能移除
 *   · 🔴 **MCAI 再也拿不到密码和 token**：它只能看到账户基本信息（innerID/ID/UUID/服务器）
 *
 * 两处存储，刻意分开：
 *   · **元数据**（能见人的部分）→ `<工作区>/.mcp-mc-agent/accounts.json`
 *   · **凭据**（密码/token）→ **server 自己的本地凭据库** `mcp/credentials.mjs`
 *     （落在状态目录的 `credentials.json`，mode 0600；key = `mcp-mc-agent/<innerID>`）
 *
 * ⚠️ 为什么不把密码写进工作区文件：agent 手里有 `read`（tool-fs）——
 *    密码一旦落进工作区，等于直接喂给 LLM。所以宁可"凭据库不可用就拒绝存密码"，
 *    也**不降级**写明文。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { msaHasCache } from './msa.mjs'

/**
 * **预置**认证服务器（首次建库时写进去当便利，**不是内置、可以删**）。
 * 🔴 用户 2026-09-16：LittleSkin 只是"提前预设"——删掉就是删掉，**不许再自动长回来**
 *    （靠 `seeded` 标记：只在第一次建库时种一次）。
 */
export const PRESET_AUTH_SERVERS = [
  { id: 'littleskin', name: 'LittleSkin', url: 'https://littleskin.cn/api/yggdrasil' },
]

const FILE = 'accounts.json'
const CRED_SCOPE = 'mcp-mc-agent'
/** 凭据 key 的两段都要求"小写连字符标识符"，所以 innerID 只用 [a-z0-9-] */
const INNER_ID = /^acc-[a-z0-9]{8}$/

/** 离线 UUID = Java 的 `UUID.nameUUIDFromBytes("OfflinePlayer:<name>")`（version 3） */
export function offlineUuid (name) {
  const h = createHash('md5').update(`OfflinePlayer:${String(name)}`, 'utf8').digest()
  h[6] = (h[6] & 0x0f) | 0x30
  h[8] = (h[8] & 0x3f) | 0x80
  const hex = h.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 补横线的 UUID（认证服有时给不带横线的） */
export function dashUuid (raw) {
  const s = String(raw ?? '').trim().replace(/-/g, '')
  if (!/^[0-9a-fA-F]{32}$/.test(s)) return null
  const l = s.toLowerCase()
  return `${l.slice(0, 8)}-${l.slice(8, 12)}-${l.slice(12, 16)}-${l.slice(16, 20)}-${l.slice(20)}`
}

/** 认证服务器地址归一化：去空白、补 https://、去结尾斜杠（**不猜路径**） */
export function normalizeServerUrl (raw) {
  let s = String(raw ?? '').trim()
  if (!s) throw new Error('认证服务器地址不能为空')
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s
  s = s.replace(/\/+$/, '')
  let u
  try { u = new URL(s) } catch { throw new Error(`不是合法的地址：${raw}`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http/https')
  // 必须像个主机名（域名要有 nnn.nnn，或 IPv4/IPv6）——否则 "https://随便几个字" 也会被 URL 当 IDN 收下
  const host = u.hostname
  const looksLikeHost = /\./.test(host) || /^\[[0-9a-f:]+\]$/i.test(host) || host === 'localhost'
  if (!looksLikeHost) throw new Error(`地址里没有主机名（要有类似 example.com 这样的域名）：${raw}`)
  return u.toString().replace(/\/+$/, '')
}

/**
 * 解析 authlib-injector 卡片/文本里的认证服务器地址。
 * 形如 `authlib-injector:yggdrasil-server:https%3A%2F%2Fauth.example.com%2Fyggdrasil`
 * （网址部分是 URL-encoded；也容忍已经解码过、或干脆就是一条裸网址）
 * @returns {string|null} 归一化后的地址，解析不出来返回 null
 */
export function parseAuthlibCard (text) {
  const s = String(text ?? '').trim().replace(/^["'<]+|["'>]+$/g, '')
  if (!s) return null
  const m = s.match(/authlib-injector\s*:\s*yggdrasil-server\s*:\s*(\S+)/i)
  const raw = m ? m[1] : s
  const candidates = [raw]
  try { candidates.push(decodeURIComponent(raw)) } catch { /* 解不开就用原样 */ }
  for (const c of candidates) {
    try { return normalizeServerUrl(c) } catch { /* 换下一个 */ }
  }
  return null
}

export class AccountStore {
  /**
   * @param {{dir:string, credentials?:object|null, logger?:object|null}} opts
   *   dir = `<工作区>/.mcp-mc-agent`；credentials = 宿主 `ctx.credentials`（可为 null）
   */
  constructor ({ dir, credentials = null, logger = null } = {}) {
    this.dir = dir
    this.file = join(dir, FILE)
    this.credentials = credentials
    this.logger = logger
    this.data = { version: 1, defaultAccount: null, authServers: [], accounts: [] }
    /** 账户库读失败（JSON 坏了/权限不对）—— 调用方看到它就必须**跳过一切写盘**，见 load() */
    this.loadFailed = false
    this.loadError = null
    this.load()
    /** 正版账户的令牌缓存目录怎么算（`innerID → 目录`）—— 由 `index.js` 注入，见 `src/msa.mjs` */
    this.msaDirOf = null
    /** 有凭据的 innerID 缓存（`list()` 是同步的，所以要缓存；启动/增删时刷新） */
    this._withCred = new Set()
    this.credIndexError = null
  }

  /* ─────────────── 读写 ─────────────── */

  load () {
    try {
      if (!existsSync(this.file)) { this.data = { version: 1, seeded: false, defaultAccount: null, authServers: [], accounts: [] }; return }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      this.data = {
        version: 1,
        // 是否已经种过"预置认证服务器"。旧库没有这个字段 → 当成"没种过"，下一次 ensureDefaults 会补一次；
        // 之后删掉预置项就**不会再长回来**。
        seeded: parsed?.seeded === true,
        defaultAccount: parsed?.defaultAccount ?? null,
        authServers: Array.isArray(parsed?.authServers) ? parsed.authServers : [],
        accounts: Array.isArray(parsed?.accounts) ? parsed.accounts : [],
      }
    } catch (e) {
      this.data = { version: 1, seeded: false, defaultAccount: null, authServers: [], accounts: [] }
      this.loadError = `账户库读取失败（已按空库运行）：${e.message}`
      /* 🔴 2026-10-15 审计（报告 E 第 1 条）：这里把"读失败"降级成"按空库运行"，而 `index.js`
       *    紧接着会调 `ensureDefaults()` + `save()` —— 于是**一次读失败就把用户的账户库覆盖成
       *    "只剩一个默认离线号"**（账户永久丢失，而且没有任何提示）。这个标志位就是给调用方
       *    用来**跳过一切写盘**的；`loadError` 仍然保留给人看。 */
      this.loadFailed = true
    }
  }

  save () {
    /* 🔴 2026-10-15 审计（报告 E 第 1 条）：读失败之后**绝不能写** —— 否则一次读失败就把
     *    用户的账户库覆盖成"空库 + 一个默认离线号"。这是最后一道保险（调用方也该先看 loadFailed）。 */
    if (this.loadFailed) {
      throw new Error(`账户库之前读取失败（${this.loadError ?? '原因不明'}）—— 为免覆盖掉里面的账户，这次不写盘。`
        + `请先修好 ${this.file}（比如从备份恢复）再重试。`)
    }
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
      /* 🟡 2026-10-15 审计（报告 E 第 1 条）：原来直接 `writeFileSync` —— 写到一半断电/被杀就留下
       *    半个 JSON（下次启动就是"读失败"）。与 `src/wsconfig.mjs:112-116`、`src/task-runner.mjs:384-385`
       *    统一：先写临时文件再 rename（同分区上 rename 是原子的）。 */
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.data, null, 2) + '\n', 'utf8')
      renameSync(tmp, this.file)
    } catch (e) { throw new Error(`账户库写入失败：${e.message}`) }
  }

  /** 首次使用：种一次预置认证服务器 + 默认离线账户 `DeepSeek`（种过就不再种） */
  ensureDefaults () {
    let changed = false
    if (this.data.seeded !== true) {
      for (const s of PRESET_AUTH_SERVERS) {
        if (!this.data.authServers.some((x) => x.url === s.url)) this.data.authServers.push({ ...s })
      }
      this.data.seeded = true
      changed = true
    }
    if (!this.data.accounts.length) {
      const acc = { innerID: newInnerId(), type: 'offline', name: 'DeepSeek', uuid: null, login: null, id: null, serverId: null }
      this.data.accounts.push(acc)
      this.data.defaultAccount = acc.innerID
      changed = true
    }
    if (!this.data.defaultAccount || !this.data.accounts.some((a) => a.innerID === this.data.defaultAccount)) {
      this.data.defaultAccount = this.data.accounts[0]?.innerID ?? null
      changed = true
    }
    if (changed) this.save()
    return changed
  }

  /* ─────────────── 账户 ─────────────── */

  /** 给 LLM/UI 的公开视图：**绝不含密码/token** */
  view (acc) {
    if (!acc) return null
    const srv = this.data.authServers.find((s) => s.id === acc.serverId) ?? null
    const server = acc.type === 'offline'
      ? { kind: 'offline', name: '离线', url: null }
      : acc.type === 'microsoft'
        ? { kind: 'microsoft', name: '微软正版', url: 'https://www.minecraft.net' }
        : { kind: 'yggdrasil', name: srv?.name ?? '(已移除的服务器)', url: srv?.url ?? null }
    const uuid = acc.uuid ?? (acc.type === 'offline' ? offlineUuid(acc.name) : null)
    return {
      innerID: acc.innerID,
      id: acc.id ?? null,                       // 认证服务器给的账号 id（离线为 null）
      login: acc.login ?? null,                 // 登录用账号名/邮箱（皮肤站才有）
      name: acc.name,                           // 游戏内名字（皮肤站登录后会用档案名覆盖）
      uuid,
      uuidSource: acc.uuid ? 'custom' : (acc.type === 'offline' ? 'derived-from-name' : 'unknown'),
      type: acc.type,                           // offline | yggdrasil
      server,
      /* 正版账户的"登录凭据"= prismarine-auth 的**令牌缓存目录里有没有东西**（不在凭据服务里）；
         皮肤站/离线走宿主凭据服务。两种都只回布尔，绝不含令牌。 */
      hasCredential: acc.type === 'microsoft'
        ? (typeof this.msaDirOf === 'function' ? msaHasCache(this.msaDirOf(acc.innerID)) : false)
        : this._withCred.has(acc.innerID),
      /* 🟡 2026-10-15 审计（报告 E 第 2 条）：凭据索引刷失败时上面的 `hasCredential` 可能已经过时，
       *    如实告诉调用方"这个值可不可信"，别让它把"读不出来"当成"没有密码"。 */
      credIndexOk: !this.credIndexError,
      ...(this.credIndexError ? { credIndexError: this.credIndexError } : {}),
      default: this.data.defaultAccount === acc.innerID,
    }
  }

  list () { return this.data.accounts.map((a) => this.view(a)) }

  get (innerID) { return this.data.accounts.find((a) => a.innerID === innerID) ?? null }

  /** 选定/默认账户：给了 innerID 就必须存在；没给就 defaultAccount；再退第一个 */
  resolve (innerID = null) {
    if (innerID) {
      const acc = this.get(innerID)
      if (!acc) throw new Error(`没有这个账户：${innerID}（先用 mc_accounts{action:"list"} 看看有哪些）`)
      return acc
    }
    const d = this.data.defaultAccount ? this.get(this.data.defaultAccount) : null
    return d ?? this.data.accounts[0] ?? null
  }

  /** 按指令搜索：名字 / login / uuid / id / 服务器名 / innerID 模糊匹配 */
  search (query) {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) throw new Error('query 不能为空（要搜什么？名字、UUID、服务器名都行）')
    const hits = this.data.accounts.filter((a) => {
      const v = this.view(a)
      const hay = [v.innerID, v.id, v.login, v.name, v.uuid, v.server?.name, v.server?.url, v.type]
        .filter(Boolean).join(' ').toLowerCase()
      return hay.includes(q)
    })
    return { query, matched: hits.length, accounts: hits.map((a) => this.view(a)) }
  }

  /** 新建账户（凭据另行 setCredential 写入） */
  add ({ type, name, uuid = null, serverId = null, login = null, id = null } = {}) {
    const t = String(type ?? '').trim()
    if (t !== 'offline' && t !== 'yggdrasil' && t !== 'microsoft') {
      throw new Error(`不支持的账户类型：${t}（离线 offline / 皮肤站 yggdrasil / 正版 microsoft）`)
    }
    /* 正版账户：邮箱是**认缓存的那把钥匙**（prismarine-auth 按第一个参数给缓存文件命名），必填。
       游戏内名字要等登录成功才拿得到，所以这里先用邮箱前缀占位（`persistAuth` 登录后会覆盖它）。 */
    let nm = String(name ?? '').trim()
    if (t === 'microsoft') {
      const mail = String(login ?? '').trim()
      if (!mail) throw new Error('正版账户要填微软账号的邮箱（登录时靠它认缓存）')
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error(`邮箱格式不对：${mail}`)
      login = mail
      if (!nm) nm = mail.split('@')[0].replace(/[^\w\u4e00-\u9fa5.]/g, '_').slice(0, 32) || 'Microsoft'
    }
    if (!nm) throw new Error('账户名不能为空')
    if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(nm)) throw new Error('账户名只能用中英文/数字/下划线/点，最长 32')
    if (t === 'yggdrasil') {
      const srv = this.data.authServers.find((s) => s.id === serverId)
      if (!srv) throw new Error(`没有这个认证服务器：${serverId}（先用 mc_accounts 添加）`)
    }
    const u = uuid ? dashUuid(uuid) : null
    if (uuid && !u) throw new Error(`UUID 格式不对：${uuid}（要 32 位十六进制，可有横线）`)
    if (t === 'offline' && this.data.accounts.some((a) => a.type === 'offline' && !a.uuid && a.name === nm)) {
      throw new Error(`已经有同名离线账户了：${nm}`)
    }
    const acc = { innerID: newInnerId(), type: t, name: nm, uuid: u, login: login ? String(login) : null, id: id ? String(id) : null, serverId: t === 'yggdrasil' ? serverId : null }
    this.data.accounts.push(acc)
    this.save()
    return this.view(acc)
  }

  /** 改：名字 / UUID / login / id / 设为默认 */
  update (innerID, patch = {}) {
    const acc = this.get(innerID)
    if (!acc) throw new Error(`没有这个账户：${innerID}`)
    if (patch.name !== undefined) {
      const nm = String(patch.name).trim()
      if (!nm) throw new Error('名字不能为空')
      if (!/^[\w\u4e00-\u9fa5.]{1,32}$/.test(nm)) throw new Error('名字只能用中英文/数字/下划线/点，最长 32')
      acc.name = nm
    }
    if (patch.uuid !== undefined) {
      if (patch.uuid === null || patch.uuid === '') acc.uuid = null
      else {
        const u = dashUuid(patch.uuid)
        if (!u) throw new Error(`UUID 格式不对：${patch.uuid}`)
        acc.uuid = u
      }
    }
    if (patch.login !== undefined) acc.login = patch.login === null ? null : String(patch.login)
    if (patch.id !== undefined) acc.id = patch.id === null ? null : String(patch.id)
    if (patch.serverId !== undefined) {
      if (patch.serverId !== null && !this.data.authServers.some((s) => s.id === patch.serverId)) {
        throw new Error(`没有这个认证服务器：${patch.serverId}`)
      }
      acc.serverId = patch.serverId
    }
    if (patch.default === true) this.data.defaultAccount = acc.innerID
    this.save()
    return this.view(acc)
  }

  /** 删账户（连同凭据）；删的是默认账户就把默认让给下一个 */
  async remove (innerID) {
    const i = this.data.accounts.findIndex((a) => a.innerID === innerID)
    if (i < 0) throw new Error(`没有这个账户：${innerID}`)
    this.data.accounts.splice(i, 1)
    if (this.data.defaultAccount === innerID) this.data.defaultAccount = this.data.accounts[0]?.innerID ?? null
    this.save()
    await this.deleteCredential(innerID).catch(() => {})
    return { removed: innerID, remaining: this.data.accounts.length, defaultAccount: this.data.defaultAccount }
  }

  /* ─────────────── 认证服务器 ─────────────── */

  listAuthServers () { return this.data.authServers.map((s) => ({ ...s })) }

  addAuthServer ({ name, url } = {}) {
    const u = normalizeServerUrl(url)
    const nm = String(name ?? '').trim() || hostOf(u)
    if (this.data.authServers.some((s) => s.url === u)) throw new Error(`这个认证服务器已经加过了：${u}`)
    if (this.data.authServers.some((s) => s.name === nm)) throw new Error(`已经有同名认证服务器：${nm}`)
    const srv = { id: newServerId(nm), name: nm, url: u, builtin: false }
    this.data.authServers.push(srv)
    this.save()
    return { ...srv }
  }

  /**
   * 改认证服务器的**显示名**（2026-09-16 用户要求：缓存标签里要看得懂，别显示一串网址）。
   * `addAuthServer` 不给名字时默认用域名——所以建完之后得能改。
   * ⚠️ **id 绝不变**：账户是靠 `serverId` 引用它的；名字只是给人看的。
   */
  renameAuthServer (id, name) {
    const srv = this.data.authServers.find((s) => s.id === id)
    if (!srv) throw new Error(`没有这个认证服务器：${id}`)
    const nm = String(name ?? '').trim()
    if (!nm) throw new Error('名字不能为空')
    if (nm === srv.name) return { ...srv }
    if (this.data.authServers.some((s) => s.id !== id && s.name === nm)) throw new Error(`已经有同名认证服务器：${nm}`)
    srv.name = nm
    this.save()
    return { ...srv }
  }

  /** 删认证服务器。**没有"内置不可删"这回事**（预置的也能删）；被账户占用的不许删。 */  removeAuthServer (id) {
    const i = this.data.authServers.findIndex((s) => s.id === id)
    if (i < 0) throw new Error(`没有这个认证服务器：${id}`)
    const used = this.data.accounts.filter((a) => a.serverId === id).map((a) => a.name)
    if (used.length) throw new Error(`还有账户在用这个服务器（${used.join('、')}），先删/改那些账户`)
    const [gone] = this.data.authServers.splice(i, 1)
    this.save()
    return { removed: gone.id, name: gone.name }
  }

  /* ─────────────── 凭据（只进本地凭据库，绝不进工作区） ─────────────── */

  get credentialsReady () { return Boolean(this.credentials && typeof this.credentials.modifyRecord === 'function') }

  #key (innerID) {
    if (!INNER_ID.test(innerID)) throw new Error(`内部账户 id 不合法：${innerID}`)
    return `${CRED_SCOPE}/${innerID}`
  }

  /** 启动时建"哪些账户有凭据"的缓存（list() 是同步的，用它填充 hasCredential） */
  async refreshCredentialIndex () {
    this.credIndexError = null
    if (!this.credentialsReady) { this._withCred = new Set(); return }
    /* 🔴 2026-10-15 审计（报告 E 第 2 条）：这里原来**先清空** `_withCred` 再去 `listRecords()`，
     *    而它抛错时只记 `credIndexError`（**不 rethrow**）⇒ `index.js:698` 那个"必须 catch"的兜底
     *    永远不触发；后果是**所有账户都显示"没有密码"**（`hasCredential` 全 false），UI/模型会
     *    引导用户去重设密码 —— 明明是凭据服务/网络抖了一下。
     *    改成：结果没拿到之前**不动旧集合**，失败就保留旧值并记下原因。 */
    try {
      const entries = await this.credentials.listRecords()
      const next = new Set()
      for (const e of entries ?? []) {
        const key = String(e?.key ?? e ?? '')
        const [scope, id] = key.split('/')
        if (scope === CRED_SCOPE && id) next.add(id)
      }
      this._withCred = next
    } catch (e) {
      this.credIndexError = String(e?.message ?? e)
      try { this.logger?.warn?.(`账户凭据索引刷新失败（沿用上一次的结果，共 ${this._withCred.size} 条）：${this.credIndexError}`) } catch { /* 日志失败无所谓 */ }
    }
  }

  async setCredential (innerID, { password = null, accessToken = null, clientToken = null } = {}) {
    if (!this.get(innerID)) throw new Error(`没有这个账户：${innerID}`)
    if (!this.credentialsReady) {
      throw new Error(`本地凭据库不可用，拒绝把密码写进工作区（那等于喂给 AI）——请检查 ${CRED_SCOPE} 的状态目录（默认 ~/.${CRED_SCOPE}）是否可写、credentials.json 权限是否正常`)
    }
    const key = this.#key(innerID)
    const payload = { password, accessToken, clientToken, refreshedAt: Date.now() }
    await this.credentials.modifyRecord(key, async () => ({ kind: 'grant', payload }))
    this._withCred.add(innerID)
    return { innerID, saved: true, hasCredential: true }
  }

  /** ⚠️ 只在插件内部（登录流程）用；**不要**把它塞进工具返回值或 HTTP 响应 */
  async getCredential (innerID) {
    if (!this.credentialsReady) return null
    try {
      const rec = await this.credentials.readRecord(this.#key(innerID))
      const p = rec?.payload
      if (!p || typeof p !== 'object') return null
      return { password: p.password ?? null, accessToken: p.accessToken ?? null, clientToken: p.clientToken ?? null, refreshedAt: p.refreshedAt ?? null }
    } catch (e) { this.logger?.warn?.(`[mcp-mc-agent] 读凭据失败 ${innerID}：${e.message}`); return null }
  }

  async deleteCredential (innerID) {
    if (!this.credentialsReady) return { deleted: false }
    try { await this.credentials.deleteRecord(this.#key(innerID)) } catch { /* 没有就算了 */ }
    this._withCred.delete(innerID)
    return { deleted: true }
  }
}

/* ─────────────── 小工具 ─────────────── */

function newInnerId () { return 'acc-' + randomBytes(4).toString('hex') }

function newServerId (name) {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 20)
  return (slug || 'srv') + '-' + randomBytes(2).toString('hex')
}

function hostOf (url) {
  try { return new URL(url).hostname } catch { return '认证服务器' }
}
