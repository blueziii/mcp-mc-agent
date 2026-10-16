/**
 * 自检：**账户库**（元数据 / 凭据分离）+ MCP 版凭据落点。
 *
 * 移植自 dsh 版 `selfcheck.mjs:2536-2636`，**去掉 HTTP 路由段**（MCP 没有 Web GUI），
 * 并把"宿主凭据服务"换成 MCP 版的本地凭据库 `mcp/credentials.mjs`。
 *
 * 核心不变量（LLM 能看什么、不能看什么）：
 *   · 公开视图（`store.list()` / `mc_accounts`）里**逐字查过没有密码/token**；
 *   · 密码只进 `<状态目录>/credentials.json`（mode 0600），key = `mcp-mc-agent/<innerID>`；
 *   · 凭据库不可用时**拒绝降级写明文**（宁可失败，也不把密码写进工作区喂给 AI）。
 *
 * 🔴 必须从包目录跑（源码树里 import 会缺 minecraft 依赖）：
 *      cd <profile>/node_modules/mcp-mc-agent && node tools/check-accounts-store.mjs
 */
import { mkdtempSync, existsSync, statSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { AccountStore, offlineUuid, parseAuthlibCard } = await import('../src/accounts.mjs')
const { createFileCredentials, CRED_SCOPE } = await import('../mcp/credentials.mjs')
const { createHost } = await import('../mcp/host.mjs')

let pass = 0
let fail = 0
const ok = (cond, label, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + label) } else { fail++; console.log('  ❌ ' + label + (extra !== undefined ? ' → ' + extra : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const TMP = []
const mk = (p) => { const d = mkdtempSync(join(tmpdir(), p)); TMP.push(d); return d }

/* ── A. 账户库本身（用 MCP 的本地凭据库，不用假内存服务）───────────────────── */
console.log('\n--- A. 账户库 / 凭据隔离 ---')
{
  const stateDir = mk('mcp-acc-state-')
  const creds = createFileCredentials({ stateDir })
  const store = new AccountStore({ dir: stateDir, credentials: creds })
  store.ensureDefaults()
  await store.refreshCredentialIndex()

  const def = store.list()[0]
  ok(def?.type === 'offline' && def?.name === 'DeepSeek' && def?.default, '默认账户 = 离线 DeepSeek（且是默认）')
  ok(def?.uuid === offlineUuid('DeepSeek') && def?.uuidSource === 'derived-from-name', `离线 UUID 按名字派生（Java 同款）：${def?.uuid}`)
  ok(store.listAuthServers().some((s) => s.id === 'littleskin'), '默认带 LittleSkin 认证服务器')

  const renamed = store.update(def.innerID, { name: '用户', uuid: '0123456789abcdef0123456789abcdef' })
  ok(renamed.name === '用户' && renamed.uuid === '01234567-89ab-cdef-0123-456789abcdef' && renamed.uuidSource === 'custom', '离线账户可改名 + 可自定义 UUID')
  const badUuid = await Promise.resolve().then(() => store.update(def.innerID, { uuid: 'zzz' })).catch((e) => e.message)
  ok(/UUID 格式不对/.test(String(badUuid)), '非法 UUID 被拒')

  const srv = store.addAuthServer({ name: '认证服务器', url: 'https://auth.example.com/yggdrasil/' })
  ok(srv.url === 'https://auth.example.com/yggdrasil', '认证服务器地址归一化（去尾斜杠）')
  const dup = await Promise.resolve().then(() => store.addAuthServer({ url: 'https://auth.example.com/yggdrasil' })).catch((e) => e.message)
  ok(/已经加过/.test(String(dup)), `重复地址被拒：${String(dup).slice(0, 26)}`)
  ok(store.listAuthServers().length === 2, `已添加的服务器被记住：${store.listAuthServers().map((s) => s.name).join(' / ')}`)

  const renamedSrv = store.renameAuthServer(srv.id, '认证服务器')
  ok(renamedSrv.name === '认证服务器' && renamedSrv.id === srv.id && renamedSrv.url === srv.url, '认证服务器可改名，且 **id 不变**（账户是引用 id 的）')
  const dupName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, 'LittleSkin')).catch((e) => e.message)
  ok(/已经有同名/.test(String(dupName)), `改成已存在的名字被拒：${String(dupName).slice(0, 30)}`)
  const emptyName = await Promise.resolve().then(() => store.renameAuthServer(srv.id, '   ')).catch((e) => e.message)
  ok(/名字不能为空/.test(String(emptyName)), '空名字被拒')
  ok(store.renameAuthServer(srv.id, '认证服务器').name === '认证服务器', '名字没变时是幂等的（不抛错）')

  const delPreset = await Promise.resolve().then(() => store.removeAuthServer('littleskin')).catch((e) => ({ error: e.message }))
  ok(delPreset?.removed === 'littleskin', '预置的 LittleSkin 也能删（没有"内置不可删"这回事）')
  const nSrv = store.listAuthServers().length
  store.ensureDefaults()
  ok(store.listAuthServers().length === nSrv, '删掉之后 ensureDefaults **不会**把它长回来（seeded 标记）')

  const card = parseAuthlibCard('authlib-injector:yggdrasil-server:https%3A%2F%2Fauth.example.com%2Fyggdrasil')
  ok(card === 'https://auth.example.com/yggdrasil', `解析 authlib-injector 卡片：${card}`)
  ok(parseAuthlibCard('https://example.com/api/yggdrasil') === 'https://example.com/api/yggdrasil' && parseAuthlibCard('不是网址') === null, '裸网址也认 / 垃圾文本返回 null')

  const acc2 = store.add({ type: 'yggdrasil', name: '用户皮肤站号', serverId: srv.id, login: 'owner@example.com' })
  await store.setCredential(acc2.innerID, { password: 'p@ssw0rd', accessToken: 'tok-1', clientToken: 'ct-1' })
  await store.refreshCredentialIndex()
  const viewJson = JSON.stringify(store.list())
  const view2 = store.list().find((a) => a.innerID === acc2.innerID)
  ok(view2?.server?.url === 'https://auth.example.com/yggdrasil' && view2?.hasCredential, '皮肤站账户带服务器信息 + hasCredential 标记')
  ok(view2?.login === 'owner@example.com' && store.list().find((a) => a.type === 'offline')?.login === null, '视图带 login（皮肤站=输入的账号，离线=None）')
  const delUsed = await Promise.resolve().then(() => store.removeAuthServer(srv.id)).catch((e) => e.message)
  ok(/还有账户在用/.test(String(delUsed)), `被账户占用的服务器不许删：${String(delUsed).slice(0, 34)}`)
  ok(!/p@ssw0rd|tok-1|ct-1/.test(viewJson), '🔴 公开视图里逐字查过：**没有**密码/token')

  /* ── 凭据落点（MCP 版的关键差异）────────────────────────────────────── */
  const keys = (await creds.listRecords()).map((r) => r.key)
  ok(keys.includes(`${CRED_SCOPE}/${acc2.innerID}`), `凭据落在本地凭据库（key = ${CRED_SCOPE}/<innerID>）`)
  const credFile = join(stateDir, 'credentials.json')
  ok(existsSync(credFile), `凭据文件在状态目录：${credFile}`)
  const mode = existsSync(credFile) ? (statSync(credFile).mode & 0o777) : 0
  if (process.platform === 'win32') {
    // NTFS 不认 POSIX 位（chmod 是 no-op），Windows 上只能确认"写文件时确实请求了 0600"
    const credSrc = readFileSync(new URL('../mcp/credentials.mjs', import.meta.url), 'utf8')
    ok(/0o600|0o600\)/.test(credSrc), 'Windows 上 POSIX 位是 no-op → 改为断言源码里**确实请求了 0600**')
  } else {
    ok(mode === 0o600, `凭据文件权限 0600（实际 ${mode.toString(8)}）`)
  }
  ok(!/p@ssw0rd/.test(readFileSync(join(stateDir, 'accounts.json'), 'utf8')), '🔴 accounts.json 里**没有**密码（元数据/凭据分离）')

  const removed = await store.remove(acc2.innerID)
  ok(removed.removed === acc2.innerID && !(await creds.listRecords()).some((r) => r.key === `${CRED_SCOPE}/${acc2.innerID}`), '删账户连带删凭据')
  ok(store.search('用户').matched === 1, '按指令搜索（名字）')

  const noCred = new AccountStore({ dir: mk('mcp-acc-nocred-') })
  noCred.ensureDefaults()
  const refuse = await noCred.setCredential(noCred.list()[0].innerID, { password: 'x' }).catch((e) => e.message)
  ok(/拒绝把密码写进工作区/.test(String(refuse)), '凭据库不可用时**拒绝降级写明文**')
}

/* ── B. 工具层：跑在真实插件实例上（工具面 + 不泄漏凭据）─────────────────── */
console.log('\n--- B. 工具层：mc_accounts / mc_connect ---')
{
  const stateDir = mk('mcp-acc-tool-state-')
  const cwd = mk('mcp-acc-tool-ws-')
  process.env.MCP_MC_AGENT_DIR = stateDir        // apply() 里 resolveStateDir 认这个
  const credentials = createFileCredentials({ stateDir })
  const host = createHost({ cwd, credentials, log: () => {} })
  const mod = await import('../index.js')
  mod.apply(host.ctx, {})
  // 扩展是**异步**注册的（index.js 末尾的 ctx.effect 里 await import），要等工具表稳定
  const t0 = Date.now()
  let last = -1
  while (Date.now() - t0 < 15_000) {
    await sleep(150)
    if (host.tools.size === last && host.tools.size >= 29) break
    last = host.tools.size
  }
  ok(host.tools.size >= 29, `工具表已稳定：${host.tools.size} 个`)

  const A = host.makeExec()
  const accList = await host.tools.get('mc_accounts').execute({ action: 'list' }, A)
  ok(Array.isArray(accList.accounts) && accList.accounts.length >= 1, `mc_accounts{list} 可用（${accList.accounts?.length} 个账户，凭据库 ${accList.credentialsReady ? '可用' : '不可用'}）`)
  ok(accList.credentialsReady === true, 'MCP 下凭据库**可用**（本地 credentials.json，不再依赖宿主服务）')
  ok(!/password|authPass|accessToken|clientToken|"token"/i.test(JSON.stringify(accList)), '🔴 mc_accounts 返回里没有任何凭据字段')

  const chosen = await host.tools.get('mc_accounts').execute({ action: 'use', innerID: accList.accounts[0].innerID }, A)
  ok(chosen.selected?.innerID === accList.accounts[0].innerID, 'mc_accounts{use} 选定账户')
  const badUse = await host.tools.get('mc_accounts').execute({ action: 'use', innerID: 'acc-00000000' }, A).catch((e) => e.message)
  ok(/没有这个账户/.test(String(badUse)), '选不存在的账户报错清晰')
  const searchTool = await host.tools.get('mc_accounts').execute({ action: 'search', query: 'DeepSeek' }, A)
  ok(searchTool.matched >= 1, `mc_accounts{search} 可用（命中 ${searchTool.matched}）`)
  const refreshOffline = await host.tools.get('mc_accounts').execute({ action: 'refresh' }, A)
  ok(/离线/.test(String(refreshOffline.note ?? '')), '离线账户"刷新"= 说明不需要认证')
  const ghost = await host.tools.get('mc_connect').execute({ host: 'mc.example', account: 'acc-00000000' }, A).catch((e) => e.message)
  ok(/没有这个账户/.test(String(ghost)), 'mc_connect 指名不存在的账户报错清晰')
  host.dispose()
}

for (const d of TMP) { try { rmSync(d, { recursive: true, force: true }) } catch {} }

console.log(`\n${fail === 0 ? '✅ 全过' : '❌ 有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
