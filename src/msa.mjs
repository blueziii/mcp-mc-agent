/* ============================================================================
 * 微软正版登录（Microsoft 账户 → Xbox Live → Minecraft Java）
 * ----------------------------------------------------------------------------
 * 走 **prismarine-auth** 的**设备码流程**（`flow: 'live'`）：用户拿到一个 8 位代码
 * 和一个网址，在浏览器里输一次就完事，插件这边**不需要密码、不碰用户的微软账号**。
 *
 * 🔴 三条纪律：
 *   ① **只读参数、不读 `self.cfg`**（同 `auth-session.mjs`，2026-09-15 踩过）；
 *   ② 令牌缓存**按账户分开**（`<stateDir>/msa/<innerID>/`）—— 两个正版账户共用一个
 *      缓存目录会互相顶掉，`prismarine-auth` 的缓存文件名只认 `username`；
 *   ③ `msa.mjs` 是**叶子**：只 import `node:*`，不 import `core.mjs`、不 import mineflayer。
 *
 * ⚠️ 这里返回的 session **含真令牌**：只给 mineflayer 与插件层回调，
 *    绝不进工具输出、不进 HTTP 响应（HTTP 层只给 `msaJobOf()` 那种脱敏状态）。
 */

import { join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'

/** 与 `core.mjs` 同一套写法：优先用 mineflayer 自己那份依赖（版本不会跟宿主打架） */
const requireFromMineflayer = (() => {
  try { return createRequire(createRequire(import.meta.url).resolve('mineflayer')) } catch { return createRequire(import.meta.url) }
})()

/** 官方 MC 那个 clientId（= `prismarine-auth` 的 `Titles.MinecraftNintendoSwitch`）。
 *  ⚠️ **别写成应用名**（`'Minecraft'` 之类）：`authTitle` 收的是 clientId，传一个不认识的
 *  名字会变成 `invalid_client`（`The client does not exist or is not enabled for consumers`）。
 *  上游 `minecraft-protocol/src/client/microsoftAuth.js` 用的就是这一对（clientId + Nintendo）。 */
export const MSA_AUTH_TITLE = '00000000441cc96b'
/** 跟 `MSA_AUTH_TITLE` 配套的设备类型；上游同款，改一个不改另一个也会 `invalid_client`。 */
export const MSA_DEVICE_TYPE = 'Nintendo'

/** 令牌缓存目录：`<stateDir>/msa/<innerID>/`（按账户分开，见文件头 🔴②） */
export function msaCacheDir (stateDir, innerID) {
  const safe = String(innerID ?? '').replace(/[^\w.-]/g, '_') || 'default'
  return join(String(stateDir ?? '.'), 'msa', safe)
}

/** 这台机器上找不找得到 `prismarine-auth`（找不到 ⇒ 正版登录整个不可用） */
export function msaLoad () {
  try { return requireFromMineflayer('prismarine-auth') } catch { return null }
}

export function msaSupported () { return Boolean(msaLoad()?.Authflow) }

function msaMissingError () {
  const e = new Error('这台机器上找不到 prismarine-auth（正版登录要用它）')
  e.needUserAction = true
  e.hint = '它应该跟 mineflayer 一起装在插件依赖里；缺了就重装一次插件'
  return e
}

/** 缓存目录里有没有东西 ⇒ 「这个账户登录过没有」 */
export function msaHasCache (cacheDir) {
  try {
    if (!existsSync(cacheDir)) return false
    return readdirSync(cacheDir).some((f) => f.endsWith('.json'))
  } catch { return false }
}

/**
 * 把上游给的设备码对象**规整成自己的形状**。
 * 上游实际给的是 `@azure/msal-node` 的 camelCase 版本（`userCode` / `verificationUri`），
 * 但类型声明里写的是 snake_case —— 两种都认，免得哪天上游换回来。
 */
export function msaCodeOf (raw) {
  if (!raw || typeof raw !== 'object') return null
  const userCode = raw.userCode ?? raw.user_code ?? null
  const uri = raw.verificationUri ?? raw.verification_uri ?? null
  const message = raw.message ?? null
  if (!userCode && !uri && !message) return null
  return {
    userCode: userCode ? String(userCode) : null,
    verificationUri: uri ? String(uri) : null,
    message: message ? String(message) : null,
    expiresIn: Number(raw.expiresIn ?? raw.expires_in ?? 0) || null,
  }
}

function makeFlow (Authflow, { email, cacheDir, onCode }) {
  const opts = { flow: 'live', authTitle: MSA_AUTH_TITLE, deviceType: MSA_DEVICE_TYPE }
  /* 🔴 回调**自己出错不能拖垮登录** —— 它只是把代码转给 UI */
  const cb = (raw) => { try { onCode?.(msaCodeOf(raw)) } catch { /* 忽略 */ } }
  /* 缓存文件名只认第一个参数（username），所以传邮箱；空的话给个固定串 */
  return new Authflow(String(email ?? '').trim() || 'mcp-mc-agent', cacheDir, opts, cb)
}

function sessionOf (res) {
  const profile = res?.profile
  if (!profile?.name) {
    const e = new Error('微软那边登录成功了，但没拿到 Minecraft 档案 —— 这个账号可能没买过 Java 版')
    e.needUserAction = true
    e.hint = '确认这个微软账号买过 Minecraft Java 版（基岩版不行），或者换一个账户'
    throw e
  }
  const id = String(profile.id ?? '').replace(/-/g, '')
  const name = String(profile.name)
  const session = {
    accessToken: res.token,
    selectedProfile: { id, name },
    availableProfiles: [{ id, name }],
  }
  /* 1.19+ 的服务器要**聊天签名**；拿得到证书就带上（拿不到也能连，只是不能签） */
  if (res.certificates) session.certificates = res.certificates
  return session
}

/**
 * 走完整条设备码流程（**会一直等到用户在浏览器里点完**）。
 * `onCode` 会被调一次，参数形如 `{ userCode, verificationUri, message }` —— UI 拿它显示。
 */
export async function msaLogin ({ email, cacheDir, onCode } = {}) {
  const mod = msaLoad()
  if (!mod?.Authflow) throw msaMissingError()
  const flow = makeFlow(mod.Authflow, { email, cacheDir, onCode })
  const res = await flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: true })
  const session = sessionOf(res)
  const p = session.selectedProfile
  return { name: p.name, uuid: p.id, hasCerts: Boolean(session.certificates) }
}

/**
 * 连接时用：**从缓存拿令牌**。
 *
 * 🔴 与 `msaLogin` 的区别是**它绝不停下来等用户**：缓存没了/过期了，上游会开始走设备码流程，
 *    我们**立刻**改用一条明确的错误结束这次连接（`needUserAction`），让用户回设置页重新登录。
 *    不然 `mc_connect` 会卡在那里等一个永远不会来的浏览器操作，把工具调用的预算耗光。
 */
export async function msaSession ({ email, cacheDir } = {}) {
  const mod = msaLoad()
  if (!mod?.Authflow) throw msaMissingError()
  let code = null
  const flow = makeFlow(mod.Authflow, { email, cacheDir, onCode: (d) => { code = d } })
  const tokenP = flow.getMinecraftJavaToken({ fetchProfile: true, fetchCertificates: true })
  /* 下面竞速输了以后这条还在跑 —— 自己吞掉，别变成"未处理的拒绝" */
  tokenP.catch(() => {})

  let timer = null
  const guardP = new Promise((_, reject) => {
    timer = setInterval(() => {
      if (!code) return
      const e = new Error(`正版账户「${email ?? ''}」的登录缓存没了 —— 需要重新登录一次`)
      e.needUserAction = true
      e.hint = '请让用户在账户库（mc_accounts）里点这个账户的「登录」，按页面显示的代码和网址走一遍'
      e.msaCode = code
      reject(e)
    }, 250)
    /* ⚠️ 这个定时器**故意 unref**：它只是"顺便看一眼"，不该吊住进程退出 */
    try { timer.unref?.() } catch { /* 无所谓 */ }
  })

  let res
  try {
    res = await Promise.race([tokenP, guardP])
  } finally {
    if (timer) { try { clearInterval(timer) } catch { /* 无所谓 */ } }
  }
  return sessionOf(res)
}

/* ───────────────────────── 登录任务（给 HTTP 层用） ─────────────────────────
 * 设备码流程要等用户去浏览器点，**不能占着一次 HTTP 请求**。
 * 所以：POST 起一条后台任务并立刻返回状态；前端拿着 `userCode` 显示给用户，
 * 再轮询 GET 看好了没有。
 * 一个账户同时**只跑一条**（两条设备码会互相作废）。
 * ------------------------------------------------------------------------ */

const _jobs = new Map()

/** 脱敏状态：绝不含令牌，`code` 只有 `userCode`/`verificationUri`/`message` */
export function msaJobOf (innerID) {
  const j = _jobs.get(String(innerID))
  if (!j) return null
  return {
    state: j.state,
    code: j.code ?? null,
    error: j.error ?? null,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt ?? null,
    result: j.result ? { name: j.result.name, uuid: j.result.uuid, hasCerts: j.result.hasCerts } : null,
  }
}

export function msaJobClear (innerID) { return _jobs.delete(String(innerID)) }

export function msaJobStart ({ innerID, email, cacheDir, onDone = null } = {}) {
  const id = String(innerID)
  const cur = _jobs.get(id)
  if (cur && cur.state === 'pending') return msaJobOf(id)      // 已经在等用户了，别开第二条
  const job = { state: 'pending', code: null, error: null, startedAt: Date.now(), finishedAt: null, result: null }
  _jobs.set(id, job)
  ;(async () => {
    try {
      const res = await msaLogin({ email, cacheDir, onCode: (d) => { job.code = d } })
      job.state = 'done'
      job.result = res
      job.finishedAt = Date.now()
      try { onDone?.(res) } catch { /* 回调出错不影响登录本身 */ }
    } catch (e) {
      job.state = 'error'
      job.error = String(e?.message ?? e)
      job.finishedAt = Date.now()
    }
  })()
  return msaJobOf(id)
}
