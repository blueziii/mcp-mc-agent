/**
 * mcp-mc-agent / mcp/accounts-cli.mjs —— `node mcp/server.mjs accounts ...`
 * ============================================================================
 * **为什么需要它**：MCP 客户端没有"账户界面"这个东西（那是 DSH 版 Web GUI 的活），
 * 而 `mc_accounts` 只给模型 list/search/use/refresh —— **加不了账户、登录不了正版号**。
 * 结果就是"只能用自动建的那个离线号"。这个子命令补上那个入口：
 * 在终端里把账户建好、把正版号登进去（设备码），之后 server 照常用它们。
 *
 * 它**不进 MCP 协议**（不是工具）：账户与密码是**用户**的东西，不该由模型来管。
 * 所以它跑在 `server.mjs` 起传输层**之前**，跟 `--version` / `-h` 一样是短路命令。
 *
 * 子命令：
 *   accounts list                              列出账户（不含密码/token）
 *   accounts servers                           列出认证服务器
 *   accounts add offline <名字> [--uuid <u>] [--default]
 *   accounts add yggdrasil --url <认证服> --login <账号> [--password <pw> | --password-stdin]
 *                          [--name <显示名>] [--default]
 *   accounts add microsoft --email <邮箱> [--name <显示名>] [--default]
 *   accounts login <innerID>                   正版账户：走设备码（会打印 8 位代码 + 网址）
 *   accounts refresh <innerID>                 皮肤站账户：拿存着的密码换一套新令牌
 *   accounts use <innerID>                     设成默认账户
 *   accounts remove <innerID>                  删账户（连同凭据）
 *   accounts help
 *
 * 🔒 边界：密码只在 `add yggdrasil` 那一步出现，写进 `<状态目录>/credentials.json`（0600），
 *    **从不打印、从不进日志**。`--password-stdin` 是给"不想让密码留在 shell 历史里"的人用的。
 * ============================================================================
 */
import { AccountStore, normalizeServerUrl } from '../src/accounts.mjs'
import { createFileCredentials } from './credentials.mjs'
import { msaCacheDir, msaHasCache, msaLogin, msaSupported } from '../src/msa.mjs'
import { authenticate } from '../src/auth-session.mjs'

export const ACCOUNTS_HELP = `mcp-mc-agent accounts —— 管理 Minecraft 账户（在终端里做，不经过模型）

用法：
  node mcp/server.mjs accounts list
  node mcp/server.mjs accounts servers
  node mcp/server.mjs accounts add offline <名字> [--uuid <uuid>] [--default]
  node mcp/server.mjs accounts add yggdrasil --url <认证服地址> --login <账号> [--password <密码>]
                        [--password-stdin] [--name <显示名>] [--default]
  node mcp/server.mjs accounts add microsoft --email <微软邮箱> [--name <显示名>] [--default]
  node mcp/server.mjs accounts login <innerID>     正版账户：打印 8 位设备码 + 网址，在浏览器里输一次
  node mcp/server.mjs accounts refresh <innerID>   皮肤站账户：用存着的密码换一套新令牌
  node mcp/server.mjs accounts use <innerID>       设成默认账户（mc_connect 不指名时用它）
  node mcp/server.mjs accounts remove <innerID>    删账户（连同凭据）
  node mcp/server.mjs accounts help               这条帮助

选项：
  --state-dir <目录>   状态目录（账户库 + 凭据；默认 ~/.mcp-mc-agent）
  --password-stdin     从标准输入读一行当密码（别让密码留在 shell 历史里）

🔒 密码只写进 <状态目录>/credentials.json（0600），不会打印、不会进日志。`

/* ── 参数解析：只认 `--k v` / `--flag` / 位置参数 ─────────────────────────── */

function parseArgs (argv) {
  const pos = []
  const opt = {}
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !String(next).startsWith('--')) { opt[key] = String(next); i++ }
      else opt[key] = true
    } else pos.push(a)
  }
  return { pos, opt }
}

/** 从 stdin 读第一行（`--password-stdin`）。没给 stdin（TTY）就报错，别静默挂住。 */
async function readLineFromStdin () {
  if (process.stdin.isTTY) throw new Error('--password-stdin 需要从管道读（例如 `echo 密码 | …`）')
  let buf = ''
  for await (const chunk of process.stdin) {
    buf += chunk.toString('utf8')
    const nl = buf.indexOf('\n')
    if (nl >= 0) return buf.slice(0, nl).replace(/\r$/, '')
  }
  return buf.replace(/\r?\n$/, '')
}

const typeLabel = (t) => ({ offline: '离线', yggdrasil: '皮肤站', microsoft: '正版' }[t] ?? t)

/** 没给 `--name` 时，从登录名/邮箱前缀猜一个合法显示名（`accounts.add` 要求非空）。 */
const nameFromLogin = (login) => String(login ?? '').split('@')[0].replace(/[^\w\u4e00-\u9fa5.]/g, '_').slice(0, 32)

/* ── 主入口 ─────────────────────────────────────────────────────────────── */

/**
 * @param {string[]} argv            `accounts` 之后的参数（不含 `accounts` 本身）
 * @param {object}   opts
 * @param {string}   opts.stateDir   状态目录
 * @param {Function} [opts.out]      stdout（可注入，方便测）
 * @param {Function} [opts.err]      stderr
 * @returns {Promise<number>}        退出码（0 成功 / 1 运行错 / 2 用法错）
 */
export async function runAccountsCli (argv, { stateDir, out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`) } = {}) {
  const { pos, opt } = parseArgs(argv)
  const sub = String(pos[0] ?? 'list').toLowerCase()

  if (sub === 'help' || opt.help === true) { out(ACCOUNTS_HELP); return 0 }

  /* 凭据库：与 server 用的是同一个实现（`<stateDir>/credentials.json`，0600） */
  const credentials = createFileCredentials({ stateDir })
  const accounts = new AccountStore({ dir: stateDir, credentials })
  if (accounts.loadFailed) {
    err(`🔴 账户库读不出来：${accounts.loadError ?? '原因不明'}`)
    err(`　　文件：${accounts.file}`)
    err('　　**不会写盘**（怕把你的账户覆盖掉）—— 先修好它（比如从备份恢复）再来。')
    return 1
  }
  accounts.ensureDefaults()
  accounts.msaDirOf = (innerID) => msaCacheDir(stateDir, innerID)
  await accounts.refreshCredentialIndex().catch(() => {})

  const needId = (what = 'innerID') => {
    const id = String(pos[1] ?? '').trim()
    if (!id) throw Object.assign(new Error(`要指定 ${what}（先跑 accounts list 看看）`), { usage: true })
    return id
  }

  try {
    if (sub === 'list') {
      const list = accounts.list()
      const def = accounts.data.defaultAccount
      out(`状态目录：${stateDir}`)
      out(`账户库：${accounts.file}（${list.length} 个）`)
      out('')
      for (const a of list) {
        /* ⚠️ 第一列**必须**是 innerID（脚本要能 `awk '{print $1}'` 取它），
         *    所以「默认」标记放行尾，不放行首。 */
        const cred = a.hasCredential ? '有凭据' : '无凭据'
        out(`${a.innerID}  ${typeLabel(a.type).padEnd(4)}  ${String(a.name ?? '').padEnd(16)}  ${cred}`
          + (a.type === 'yggdrasil' ? `  服务器：${a.server?.name ?? '（没挂）'}` : '')
          + (a.type === 'microsoft' ? `  邮箱：${a.login ?? '（没填）'}  登录缓存：${msaHasCache(accounts.msaDirOf(a.innerID)) ? '有' : '没有（要 accounts login）'}` : '')
          + (a.innerID === def ? '  ★默认' : ''))
      }
      if (!list.length) out('（一个账户都没有）')
      out('')
      out(`默认账户：${def ?? '（没有）'}`)
      return 0
    }

    if (sub === 'servers') {
      const list = accounts.listAuthServers()
      if (!list.length) out('（没有认证服务器）')
      for (const s of list) out(`${s.id}  ${s.name ?? '(无名)'}  ${s.url}`)
      return 0
    }

    if (sub === 'add') {
      const type = String(pos[1] ?? '').toLowerCase()
      if (type === 'offline') {
        const name = String(pos[2] ?? opt.name ?? '').trim()
        if (!name) throw Object.assign(new Error('add offline 要给名字：accounts add offline <名字>'), { usage: true })
        const acc = accounts.add({ type: 'offline', name, uuid: opt.uuid ?? null })
        if (opt.default === true) accounts.update(acc.innerID, { default: true })
        out(`✅ 建好离线账户：${acc.innerID}  ${acc.name}`)
        out('　（离线账户不需要登录，直接就能用）')
        return 0
      }
      if (type === 'yggdrasil') {
        const url = String(opt.url ?? '').trim()
        const login = String(opt.login ?? '').trim()
        if (!url) throw Object.assign(new Error('add yggdrasil 要给 --url <认证服地址>'), { usage: true })
        if (!login) throw Object.assign(new Error('add yggdrasil 要给 --login <账号>'), { usage: true })
        const nm = String(opt.name ?? '').trim() || nameFromLogin(login)
        if (!nm) throw Object.assign(new Error('add yggdrasil 要给 --name <显示名>（没法从登录名猜出来）'), { usage: true })
        let password = opt.password === true ? null : (opt.password ?? null)
        if (opt['password-stdin'] === true) password = await readLineFromStdin()
        const norm = normalizeServerUrl(url)
        const existing = accounts.listAuthServers().find((s) => s.url === norm)
        const serverId = existing ? existing.id : accounts.addAuthServer({ name: opt['server-name'] ?? null, url: norm }).id
        if (opt['server-name'] && existing && String(opt['server-name']) !== existing.name) {
          accounts.renameAuthServer(serverId, String(opt['server-name']))
        }
        const acc = accounts.add({ type: 'yggdrasil', name: nm, login, serverId })
        if (password) await accounts.setCredential(acc.innerID, { password: String(password) })
        if (opt.default === true) accounts.update(acc.innerID, { default: true })
        await accounts.refreshCredentialIndex()
        out(`✅ 建好皮肤站账户：${acc.innerID}  ${acc.name}  服务器：${norm}`)
        if (!password) out('　⚠️ 没给密码 —— 连服前还得补一次：accounts refresh ' + acc.innerID)
        return 0
      }
      if (type === 'microsoft') {
        const email = String(opt.email ?? opt.login ?? '').trim()
        if (!email) throw Object.assign(new Error('add microsoft 要给 --email <微软邮箱>'), { usage: true })
        const acc = accounts.add({ type: 'microsoft', name: opt.name ?? null, login: email })
        if (opt.default === true) accounts.update(acc.innerID, { default: true })
        await accounts.refreshCredentialIndex()
        out(`✅ 建好正版账户：${acc.innerID}  ${acc.name}  邮箱：${email}`)
        out(`　⚠️ 还没登录 —— 现在跑一次：node mcp/server.mjs accounts login ${acc.innerID}`)
        return 0
      }
      throw Object.assign(new Error(`add 后面要跟类型：offline / yggdrasil / microsoft（给的是「${type}」）`), { usage: true })
    }

    if (sub === 'login') {
      const innerID = needId()
      const acc = accounts.get(innerID)
      if (!acc) throw new Error(`没有这个账户：${innerID}`)
      if (acc.type !== 'microsoft') throw new Error(`「${acc.name}」不是正版账户（只有正版走设备码；皮肤站用 accounts refresh）`)
      const email = String(acc.login ?? '').trim()
      if (!email) throw new Error('这个正版账户没填微软邮箱')
      if (!msaSupported()) throw new Error('这台机器上找不到 prismarine-auth（正版登录用不了）—— 装一次：npm i prismarine-auth')
      const cacheDir = accounts.msaDirOf(innerID)
      out(`正在为「${acc.name}」启动设备码登录…`)
      const r = await msaLogin({
        email, cacheDir,
        onCode: (d) => {
          out('')
          out('　┌─────────────────────────────────────────────')
          out(`　│  设备码：${d?.userCode ?? '?'}`)
          out(`　│  网址　：${d?.verificationUri ?? 'https://www.microsoft.com/link'}`)
          out('　└─────────────────────────────────────────────')
          out('　在浏览器里打开上面那个网址、把设备码输进去（**用哪个微软账号都行**，就是你要登的那个）。')
          out('　做完这一步别关终端 —— 这里在等它。')
          out('')
        },
      })
      /* 登录成功后把游戏名/UUID 回写进账户库（`add` 时用的邮箱前缀只是占位） */
      accounts.update(innerID, { name: String(r.name ?? acc.name), id: String(r.uuid ?? '') || null })
      out(`✅ 登录成功：${r.name}（${r.uuid}）${r.hasCerts ? '　·带聊天签名证书' : ''}`)
      out('　令牌已按账户缓存在 ' + cacheDir)
      return 0
    }

    if (sub === 'refresh') {
      const innerID = needId()
      const acc = accounts.get(innerID)
      if (!acc) throw new Error(`没有这个账户：${innerID}`)
      if (acc.type === 'offline') { out(`「${acc.name}」是离线账户，不需要认证。`); return 0 }
      if (acc.type === 'microsoft') {
        const has = msaHasCache(accounts.msaDirOf(innerID))
        out(has
          ? '令牌缓存还在（续期由 prismarine-auth 在连接时自己做）。'
          : `缓存没了 —— 要重新走一次设备码：node mcp/server.mjs accounts login ${innerID}`)
        return 0
      }
      const cred = await accounts.getCredential(innerID).catch(() => null)
      const password = cred?.password ?? null
      if (!password) {
        err(`🔴 「${acc.name}」没有存密码 —— 没法换令牌。`)
        err(`　　重建一个带上密码的：node mcp/server.mjs accounts add yggdrasil --url <认证服> --login ${acc.login ?? '<账号>'} --password-stdin`)
        return 1
      }
      const srv = accounts.listAuthServers().find((s) => s.id === acc.serverId)
      if (!srv) throw new Error(`这个账户挂的认证服务器不在库里了（serverId=${acc.serverId}）`)
      let s
      try {
        s = await authenticate({ authUrl: srv.url, authUser: acc.login, authPass: password })
      } catch (e) {
        /* 401/403 = 认证服明确拒绝了这组凭据 —— 绝大多数情况就是密码不对，
         * 所以这里给一条能直接抄的补救命令，而不是只丢一句 HTTP 码。 */
        if (/HTTP (401|403)/.test(String(e?.message ?? ''))) {
          err(`🔴 ${e.message}（认证服拒绝了这个账号/密码）`)
          err('　　密码多半不对。带上正确密码重来一次：')
          err(`　　node mcp/server.mjs accounts add yggdrasil --url ${srv.url} --login ${acc.login ?? '<账号>'} --password-stdin`)
          return 1
        }
        throw e
      }
      await accounts.setCredential(innerID, {
        password,
        accessToken: s.accessToken ?? null,
        clientToken: s.clientToken ?? null,
      })
      const nm = s?.selectedProfile?.name
      if (nm && nm !== acc.name) accounts.update(innerID, { name: String(nm) })
      await accounts.refreshCredentialIndex()
      out(`✅ 「${acc.name}」的令牌换好了${nm ? `（档案名：${nm}）` : ''}`)
      return 0
    }

    if (sub === 'use') {
      const innerID = needId()
      const acc = accounts.update(innerID, { default: true })
      out(`✅ 默认账户设成「${acc.name}」（${innerID}）`)
      return 0
    }

    if (sub === 'remove') {
      const innerID = needId()
      const r = await accounts.remove(innerID)
      out(`✅ 删掉了 ${r.removed}（还剩 ${r.remaining} 个；默认账户：${r.defaultAccount ?? '（没有）'}）`)
      return 0
    }

    throw Object.assign(new Error(`不认识的子命令：「${sub}」`), { usage: true })
  } catch (e) {
    err(`🔴 ${e?.message ?? e}`)
    if (e?.usage) { err(''); err(ACCOUNTS_HELP) }
    return e?.usage ? 2 : 1
  }
}
