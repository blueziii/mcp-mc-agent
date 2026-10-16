/* ============================================================================
 * 认证 / 会话层（路线图第 ④ 条第三十刀从 `core.mjs` 搬出来）
 * ----------------------------------------------------------------------------
 * 这一层负责"账户描述符 → mineflayer 能用的 session"：离线自己造、皮肤站先刷 token
 * 再用密码登录。
 *
 * 🔴 **全插件唯一接触凭据的地方**。返回值只给 mineflayer 与插件层回调，
 *    绝不进工具输出、不进 HTTP 响应（`authOnly` 的返回值是脱敏的：只有名字/uuid/有没有令牌）。
 *
 * ⚠️ 改这里务必保证：**只用参数，不读 `self.cfg`** —— 2026-09-15 真机踩过一次：
 *    调用点早就改成传 `{authUrl,…}`，而 `#authenticate` 签名没接参数、函数体还在读 `this.cfg.authUrl`
 *    （配置里已清空）⇒ 退化成 `fetch('/authserver/authenticate')` → `Failed to parse URL`。
 *    守卫检查的是调用点算出的局部变量，fetch 用的却是空的 cfg —— 两个来源不一致才让 bug 藏了很久。
 */

import { offlineUuid, dashUuid } from './accounts.mjs'
import { msaSession } from './msa.mjs'

/**
 * 规范化认证端点基址：去首尾空白、去掉结尾多余的斜杠。
 * 否则 `https://x/yggdrasil/` 会拼成 `https://x/yggdrasil//authserver/authenticate`
 * （多数服务端能容忍，但不该指望）。
 */
function normalizeBaseUrl (url) {
  const s = String(url ?? '').trim()
  return s ? s.replace(/\/+$/, '') : ''
}

/**
 * 只做认证、**不连服**（给「刷新账户」用）。
 * 🔴 返回值**脱敏**：只有名字/uuid/有没有令牌，绝不含 accessToken。
 * 需要持久化新令牌的调用方，用 `onSession` 回调拿（那个 session 只活在插件层）。
 */
export async function authOnly (self, auth, { onSession = null } = {}) {
  const session = await makeSession(self, auth)
  try { if (typeof onSession === 'function') onSession(session) } catch { /* 回调出错不影响结果 */ }
  const p = session.selectedProfile ?? {}
  return { ok: true, name: p.name ?? null, uuid: dashUuid(p.id), hasToken: Boolean(session.accessToken) }
}

/**
 * 账户描述符 → mineflayer 能用的 session。
 *
 *   · `offline`：**自己造** session —— 这样才能支持"自定义 UUID"；
 *     不传 uuid 就按 `OfflinePlayer:<name>` 派生（与官方离线服务器一致）。
 *   · `yggdrasil`（皮肤站）：先拿缓存 accessToken 走 `refresh`（避免每次都用密码），
 *     刷新失败且存了密码才 `authenticate`；两样都没有就报"需要用户处理"。
 *
 * ⚠️ 这里（以及 #authenticate/#refresh）是全插件**唯一**接触凭据的地方；
 *    返回值只给 mineflayer，不进工具输出、不进 HTTP 响应。
 */
export async function makeSession (self, auth) {
  if (auth.mode === 'offline') {
    const name = String(auth.name ?? '').trim()
    if (!name) throw new Error('离线账户缺少名字——这是插件内部 bug，请报告')
    const uuid = dashUuid(auth.uuid) ?? offlineUuid(name)
    const bare = uuid.replace(/-/g, '')
    return {
      accessToken: '0',
      clientToken: '0',
      selectedProfile: { id: bare, name },
      availableProfiles: [{ id: bare, name }],
    }
  }
  /* 正版（Microsoft）：令牌缓存是 `prismarine-auth` 自己管的（`<stateDir>/msa/<innerID>/`），
   * 所以这里**没有密码、也没有我们自己的 token 字段** —— 只把邮箱和缓存目录传下去。
   * ⚠️ `msaSession` 绝不停下来等用户（缓存没了就直接报"需要重新登录"），
   *    否则 `mc_connect` 会卡在一个永远不会来的浏览器操作上。 */
  if (auth.mode === 'microsoft') {
    return await msaSession({ email: auth.msaEmail, cacheDir: auth.msaCacheDir })
  }
  if (auth.mode !== 'yggdrasil') throw new Error(`不支持的登录方式：${auth.mode}（只有 offline / yggdrasil / microsoft）`)

  const base = normalizeBaseUrl(auth.authUrl)
  if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')

  let refreshErr = null
  if (auth.accessToken) {
    try {
      const refreshed = await refresh({ authUrl: base, accessToken: auth.accessToken, clientToken: auth.clientToken })
      if (refreshed?.accessToken) return refreshed
    } catch (e) { refreshErr = e; self.log(`token 刷新失败，改用密码重新登录：${e.message}`) }
  }
  if (auth.authUser && auth.authPass) {
    return authenticate({ authUrl: base, authUser: auth.authUser, authPass: auth.authPass })
  }
  /* 🟡 2026-10-15 审计（报告 E 第 8 条）：上面那个 catch 把网络抖动/认证站 5xx 降级成一行日志，
   *   这里再统一报"登录状态已失效" —— 用户于是跑去重新登录，其实等一会儿重试就好。
   *   把真实原因带出来，并给出与之匹配的下一步。 */
  const err = new Error(refreshErr
    ? `这个账户的登录状态**没能刷新**（${refreshErr.message}），而且没有保存密码可用`
    : '这个账户的登录状态已失效，而且没有保存密码')
  err.needUserAction = true
  err.hint = refreshErr
    ? '如果只是网络/认证站一时不通，让用户稍后用 mc_accounts 刷新该账户重试一次；一直不行才需要重新登录。'
    : '请让用户用 mc_accounts 重新登录这个账户'
  throw err
}

/** 用 refreshToken 换新 accessToken（皮肤站 Yggdrasil 标准端点） */
export async function refresh ({ authUrl, accessToken, clientToken }) {
  const base = normalizeBaseUrl(authUrl)
  if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
  if (!accessToken) throw new Error('refresh 需要 accessToken')
  const res = await fetch(`${base}/authserver/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessToken, clientToken: clientToken ?? undefined, requestUser: true }),
  })
  if (!res.ok) {
    const e = new Error(`刷新访问令牌失败 HTTP ${res.status}`)
    if (res.status === 401 || res.status === 403) e.needUserAction = true
    throw e
  }
  const session = await res.json()
  if (!session?.selectedProfile?.name) throw new Error('刷新返回异常（没拿到档案）')
  return session
}

/**
 * 调 Yggdrasil 外置登录。
 *
 * 🔴 这里曾经有个真 bug（2026-09-15 真机暴露）：调用点早就改成传 `{authUrl,...}`，
 *    但本方法**签名没接参数、函数体还在读 `this.cfg.authUrl`**（配置里已清空），
 *    于是退化成 `fetch('/authserver/authenticate')` → `Failed to parse URL`。
 *    守卫检查的是调用点算出的局部变量（所以"不传凭据就报缺凭据"看起来正常），
 *    fetch 用的却是空的 cfg —— 两个来源不一致才让这个 bug 藏了这么久。
 * ⚠️ 以后改动这里务必保证：**只用参数，不读 this.cfg**。
 */
export async function authenticate ({ authUrl, authUser, authPass } = {}) {
  const base = normalizeBaseUrl(authUrl)
  if (!base) throw new Error('认证端点为空（authUrl）——这是插件内部 bug，请报告')
  if (!authUser || !authPass) {
    const e = new Error('这个账户没有可用的密码——请用 mc_accounts 重新登录它')
    e.needUserAction = true
    e.hint = '让用户用 mc_accounts 重新登录该账户'
    throw e
  }
  const res = await fetch(`${base}/authserver/authenticate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 🔴 `agent` 是 **Yggdrasil 官方协议里 authenticate 的必填字段**（authlib-injector / 官方
    //    Minecraft 客户端都会发）。我们以前没发，多数皮肤站容忍，但 **LittleSkin 的新实现
    //    `Yggdrasil Connect` 不容忍**：缺 agent 直接回 **400**（不是 401/403），
    //    症状就是"LittleSkin 账号一直显示 400 认证失败，而认证服务器那种老实现没事"。
    //    2026-09-19 实测对照（同一地址、只差这一个字段）：
    //      LittleSkin 缺 agent → 400 ｜ 带 agent（假账号）→ 403（正常走完校验）
    //      认证服务器       缺 agent → 403 ｜ 带 agent         → 401
    body: JSON.stringify({
      agent: { name: 'Minecraft', version: 1 },
      username: authUser,
      password: authPass,
      requestUser: true,
    }),
  })
  if (!res.ok) {
    const e = new Error(`认证失败 HTTP ${res.status}`)
    if (res.status === 400) {
      // 400 基本只有两种来路：请求体不合规（最常见就是认证服要求某个字段）、或账号格式被拒。
      e.hint = '认证服拒绝了这次请求（400）。若这个皮肤站换过实现，可能是它要求的请求字段变了——把这条报给插件维护者'
    }
    if (res.status === 401 || res.status === 403) {
      e.needUserAction = true
      e.hint = '账号或密码可能已经变了——请让用户用 mc_accounts 重新登录这个账户'
    }
    throw e
  }
  const session = await res.json()
  if (!session?.selectedProfile?.name) {
    const e = new Error('认证返回异常（没拿到游戏档案）')
    e.needUserAction = true
    e.hint = '让用户用 mc_accounts 重新登录或刷新该账户'
    throw e
  }
  return session
}
