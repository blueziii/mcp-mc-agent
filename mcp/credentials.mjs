/**
 * mcp-mc-agent / mcp/credentials.mjs —— 本地文件凭据库
 * ============================================================================
 * 为什么要有这个文件：
 *
 *   DSH 版把 Minecraft 账户的密码 / accessToken 交给**宿主凭据服务**存
 *   （`dsh-credentials-local`，见 `src/accounts.mjs` 的 `credentialsReady`）。
 *   那套东西在 MCP 下不存在 —— MCP server 是个独立进程，没有宿主 profile。
 *
 *   `src/accounts.mjs` 对凭据服务的要求其实很窄，只有四个方法（`accounts.mjs:363-422`）：
 *
 *     listRecords()            → [{ key }]                  建"哪些账户有密码"的索引
 *     readRecord(key)          → { payload }                登录时取密码
 *     modifyRecord(key, fn)    → await fn() → {kind:'grant', payload}   存密码
 *     deleteRecord(key)        → 删
 *
 *   所以这里按同样形状实现一份**落盘的**，key 仍然是 `<CRED_SCOPE>/<innerID>`
 *   （`CRED_SCOPE = 'mcp-mc-agent'`，`src/accounts.mjs:36`）—— 保持与 DSH 版一致，
 *   从上游搬代码过来时不用改任何调用点。
 *
 * 🔴 安全边界（跟 DSH 版同一个理由）：
 *   凭据**绝不写进工作区**。工作区是喂给 AI 的（AI 能读、能提交、能贴出去）。
 *   所以默认落在 `<stateDir>/credentials.json`，即 `~/.mcp-mc-agent/credentials.json`，
 *   而不是 `exec.agent.session.header.cwd` 下面。
 *   落盘时 chmod 0600（Windows 上 chmod 基本是空操作，靠目录 ACL；仍然是好习惯）。
 * ============================================================================
 */
import { mkdirSync, readFileSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 与 `src/accounts.mjs:36` 的 `CRED_SCOPE` 保持一致（从上游搬代码时零改动） */
const CRED_SCOPE = 'mcp-mc-agent'

/**
 * 建一个本地文件凭据服务（接口对齐 DSH 的 `ctx.get('credentials')`）。
 *
 * @param {object} options
 * @param {string} options.stateDir  状态目录（`~/.mcp-mc-agent`）
 * @param {Function} [options.log]   日志
 * @returns {{listRecords:Function, readRecord:Function, modifyRecord:Function, deleteRecord:Function, file:string}}
 */
export function createFileCredentials ({ stateDir, log = () => {} }) {
  const file = join(stateDir, 'credentials.json')
  /** @type {Record<string, any>} key → payload */
  let store = null

  const load = () => {
    if (store) return store
    store = {}
    try {
      if (existsSync(file)) {
        const raw = readFileSync(file, 'utf8')
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          /* 兼容两种落盘形状：`{ "<key>": {payload} }` 或 `{ "<key>": {payload, kind} }` */
          for (const [k, v] of Object.entries(parsed)) {
            if (v && typeof v === 'object' && v.payload && typeof v.payload === 'object') store[k] = v.payload
            else if (v && typeof v === 'object') store[k] = v
          }
        }
      }
    } catch (e) {
      /* 🔴 读失败时**不吞**：给一个空 store 会让人以为"密码没了"，然后重新登录一次
       *    把旧文件覆盖掉。这里直接把原因写日志，并且让写操作也拒绝（见 save 的 loaded 标志）。 */
      log(`凭据库读取失败（${file}）：${e?.message ?? e}`)
      store = null
      throw e
    }
    return store
  }

  const save = () => {
    const s = store ?? {}
    const out = {}
    for (const [k, payload] of Object.entries(s)) out[k] = { kind: 'grant', payload }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify(out, null, 2), { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows 上 chmod 基本无效，忽略 */ }
  }

  /** 拿一个可用的 store；首次读取失败过就重新试一次（用户可能刚修好权限） */
  const ensure = () => {
    if (store) return store
    return load()
  }

  return {
    file,

    async listRecords () {
      const s = ensure()
      return Object.keys(s).map((key) => ({ key }))
    },

    async readRecord (key) {
      const s = ensure()
      const payload = s[String(key)]
      if (!payload) throw new Error(`没有这条凭据：${key}`)
      return { key: String(key), payload }
    },

    /**
     * DSH 的语义是"读改写"：`modifyRecord(key, updater)`，`updater` 返回新记录或 null（= 删）。
     * 这里照做 —— 但 Minecraft 那条路只会传 `{kind:'grant', payload}`。
     */
    async modifyRecord (key, updater) {
      const s = ensure()
      const k = String(key)
      const prev = s[k] ? { kind: 'grant', payload: s[k] } : null
      const next = typeof updater === 'function' ? await updater(prev) : updater
      if (next == null) {
        delete s[k]
      } else if (next.payload && typeof next.payload === 'object') {
        s[k] = next.payload
      } else if (typeof next === 'object') {
        s[k] = next
      } else {
        throw new Error('modifyRecord 的 updater 必须返回 {payload} 或 null')
      }
      save()
      return next
    },

    async deleteRecord (key) {
      const s = ensure()
      const k = String(key)
      const had = Object.hasOwn(s, k)
      delete s[k]
      if (had) save()
      return had
    },

    /** 只给 `mc_accounts` 的自检用：库里有多少条、文件在哪（**不含**任何密钥内容） */
    info () { return { file, count: store ? Object.keys(store).length : null } },
  }
}

export { CRED_SCOPE }
