#!/usr/bin/env node
/**
 * 微软正版登录（`src/msa.mjs` + 账户库里的 `microsoft` 类型）的离线自检。
 *
 * **不联网、不需要 MC、不需要 DSH** —— 这里只钉住"拼参数 / 解析 / 记账 / 接线"这几层。
 * 「真去微软要一次设备码」那一步**故意不进来**：它要联网、要等、还会留下一条没人认领的
 * 设备码（2026-10-15 手工验过一次，拿到 `userCode` 就算通过，见提交说明）。
 *
 * 🔴 这里有一条**真机 bug 的回归**：`authTitle` 收的是 **clientId**，不是应用名。
 *    一开始写成 `'Minecraft'` ⇒ 微软回 `invalid_client`（`The client does not exist
 *    or is not enabled for consumers`），设备码永远拿不到。
 */

import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0, fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`) } else { fail++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}
const section = (t) => console.log(`\n${t}`)
const stripComments = (s) => String(s).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
const HERE = new URL('.', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, HERE), 'utf8')

const M = await import(new URL('../src/msa.mjs', import.meta.url))
const { MSA_AUTH_TITLE, MSA_DEVICE_TYPE, msaCacheDir, msaLoad, msaSupported, msaHasCache, msaCodeOf, msaJobOf, msaJobClear } = M

const tmp = mkdtempSync(join(tmpdir(), 'check-msa-'))

/* ── ① clientId 与设备类型（真机 bug 回归） ─────────────────────────────── */
section('① clientId / deviceType —— authTitle 不是应用名')
ok(/^[0-9a-f]{16}$/i.test(MSA_AUTH_TITLE), 'MSA_AUTH_TITLE 是 16 位十六进制 clientId', MSA_AUTH_TITLE)
ok(MSA_AUTH_TITLE === '00000000441cc96b', '就是上游 Titles.MinecraftNintendoSwitch 那个值')
ok(!/minecraft$/i.test(MSA_AUTH_TITLE), '🔴 不是应用名（写成 "Minecraft" 会 invalid_client）')
ok(MSA_DEVICE_TYPE === 'Nintendo', 'MSA_DEVICE_TYPE = Nintendo（跟 clientId 配套，上游同款）')
{
  const src = stripComments(read('../src/msa.mjs'))
  ok(/authTitle:\s*MSA_AUTH_TITLE/.test(src), 'makeFlow 用 MSA_AUTH_TITLE 当 authTitle')
  ok(/deviceType:\s*MSA_DEVICE_TYPE/.test(src), 'makeFlow 同时给了 deviceType（少一个也 invalid_client）')
  ok(/flow:\s*'live'/.test(src), "flow 是 'live'（设备码流程）")
}

/* ── ② 缓存目录 ───────────────────────────────────────────────────────── */
section('② msaCacheDir —— 按账户分开')
ok(msaCacheDir('/base', 'abc') === join('/base', 'msa', 'abc'), '普通 id ⇒ <stateDir>/msa/<innerID>')
ok(msaCacheDir('/base', 'a b/c') === join('/base', 'msa', 'a_b_c'), '路径分隔符/空格被换掉（不能穿目录）')
ok(msaCacheDir('/base', '') === join('/base', 'msa', 'default'), '空 id ⇒ default')
ok(msaCacheDir('/base', null) === join('/base', 'msa', 'default'), 'null id ⇒ default')
ok(msaCacheDir('/base', 'a') !== msaCacheDir('/base', 'b'), '两个账户的目录不一样（共用会互相顶掉）')
ok(msaCacheDir('/base', 'x').startsWith(join('/base', 'msa')), '都在 <stateDir>/msa 底下')

/* ── ③ msaCodeOf —— 两种命名都认 ───────────────────────────────────────── */
section('③ msaCodeOf —— camelCase / snake_case')
{
  const a = msaCodeOf({ userCode: 'ABCD-1234', verificationUri: 'https://x/link', message: 'm', expiresIn: 900 })
  ok(a?.userCode === 'ABCD-1234' && a?.verificationUri === 'https://x/link' && a?.expiresIn === 900, 'camelCase 认')
  const b = msaCodeOf({ user_code: 'WXYZ', verification_uri: 'https://y/link', message: 'n', expires_in: 600 })
  ok(b?.userCode === 'WXYZ' && b?.verificationUri === 'https://y/link' && b?.expiresIn === 600, 'snake_case 也认')
  ok(msaCodeOf({ userCode: 12345 })?.userCode === '12345', '数字码转成字符串')
  ok(msaCodeOf({ userCode: 'A' })?.expiresIn === null, '没给 expiresIn ⇒ null（不是 0）')
  ok(msaCodeOf(null) === null && msaCodeOf(undefined) === null && msaCodeOf('x') === null, 'null/字符串 ⇒ null')
  ok(msaCodeOf({}) === null, '空对象 ⇒ null（三个字段全空）')
}

/* ── ④ msaHasCache —— 「这个账户登录过没有」 ───────────────────────────── */
section('④ msaHasCache')
{
  const d1 = join(tmp, 'c1')
  ok(msaHasCache(d1) === false, '目录不存在 ⇒ false')
  const d2 = join(tmp, 'c2')
  mkdirSync(d2, { recursive: true })
  writeFileSync(join(d2, 'a.txt'), 'x')
  ok(msaHasCache(d2) === false, '只有非 .json ⇒ false')
  const d3 = join(tmp, 'c3')
  mkdirSync(d3, { recursive: true })
  writeFileSync(join(d3, 'live.json'), '{}')
  ok(msaHasCache(d3) === true, '有 .json ⇒ true（登录过）')
  ok(msaHasCache(null) === false, 'null 不炸 ⇒ false')
}

/* ── ⑤ 登录任务表（脱敏状态） ─────────────────────────────────────────── */
section('⑤ 登录任务表 —— 只给状态，不给令牌')
ok(msaJobOf('nobody') === null, '没起过 ⇒ null')
ok(msaJobClear('nobody') === false, '清一个不存在的 ⇒ false')
{
  const src = stripComments(read('../src/msa.mjs'))
  ok(/if \(cur && cur\.state === 'pending'\) return msaJobOf\(id\)/.test(src), '同账户已有 pending ⇒ 复用（两条设备码会互相作废）')
  ok(/\{ state: 'pending', code: null, error: null, startedAt: Date\.now\(\), finishedAt: null, result: null \}/.test(src), 'job 初始形状固定')
  ok(/job\.state = 'done'/.test(src) && /job\.state = 'error'/.test(src), '有 done / error 两个终态')
  ok(!/job\.(accessToken|token)\s*=/.test(src), '🔴 job 上从来不挂令牌字段')
  ok(/msaJobOf \(innerID\)/.test(src), 'msaJobOf 是只读的（HTTP 层拿它回状态）')
}

/* ── ⑥ 账户库：microsoft 类型 ─────────────────────────────────────────── */
section('⑥ AccountStore 里的 microsoft')
{
  const { AccountStore } = await import(new URL('../src/accounts.mjs', import.meta.url))
  const dir = mkdtempSync(join(tmp, 'acc-'))
  const st = new AccountStore({ dir })
  st.ensureDefaults()
  st.msaDirOf = (id) => msaCacheDir(dir, id)

  const acc = st.add({ type: 'microsoft', login: 'someone@example.com' })
  ok(acc.type === 'microsoft', '建得出正版账户')
  ok(acc.login === 'someone@example.com', 'login 存的是邮箱')
  ok(acc.name === 'someone', '名字空 ⇒ 用邮箱前缀占位', acc.name)
  ok(acc.server?.kind === 'microsoft', 'server.kind = microsoft', JSON.stringify(acc.server))
  ok(acc.hasCredential === false, '还没登录 ⇒ hasCredential false')
  ok(acc.uuidSource === 'unknown', 'uuidSource = unknown')
  const v = st.view(st.list().find((a) => a.innerID === acc.innerID))
  ok(v?.server?.name === '微软正版', 'view() 里名字是「微软正版」', v?.server?.name)
  ok(st.list().map((a) => st.view(a)).every((a) => !('password' in a) && !('accessToken' in a)), '🔴 view() 里没有 password / accessToken')

  let e1 = null; try { st.add({ type: 'microsoft' }) } catch (e) { e1 = e }
  ok(/邮箱/.test(String(e1?.message)), '不给邮箱要报错', String(e1?.message))
  let e2 = null; try { st.add({ type: 'microsoft', login: 'not-an-email' }) } catch (e) { e2 = e }
  ok(/邮箱格式不对/.test(String(e2?.message)), '邮箱格式不对要报错', String(e2?.message))
  let e3 = null; try { st.add({ type: 'nope', name: 'x' }) } catch (e) { e3 = e }
  ok(/不支持的账户类型/.test(String(e3?.message)) && /microsoft/.test(String(e3?.message)), '未知类型报错里列全三种', String(e3?.message))
  ok(st.add({ type: 'microsoft', login: 'b@c.d', name: '自定义' }).name === '自定义', '给了名字就用名字')
}

/* ── ⑦ 接线（静态） ─────────────────────────────────────────────────────
 * ⚠️ MCP 版：原来的 `/api/mc/accounts/msa` 三条 HTTP 路由断言和 client.js 的
 *    MicrosoftForm / 轮询断言**已删** —— 那是 DSH 的 Web GUI 半端，MCP 里没有。
 *    设备码登录在 MCP 下走 `mc_accounts`（见 mcp/selfcheck-mcp.mjs）。 */
section('⑦ 接线')
{
  const idx = stripComments(read('../index.js'))
  const as = stripComments(read('../src/auth-session.mjs'))
  const conn = stripComments(read('../src/connection.mjs'))
  const core = stripComments(read('../src/core.mjs'))
  const acc = stripComments(read('../src/accounts.mjs'))

  ok(/from '\.\/src\/msa\.mjs'/.test(idx), 'index.js 引了 msa.mjs')
  ok(/accounts\.msaDirOf = \(innerID\) => msaCacheDir\(stateDir, innerID\)/.test(idx), '把缓存目录注入账户库')
  ok(/mode: 'microsoft', msaEmail:/.test(idx), 'resolveAuth 拼得出 microsoft 描述符')
  ok(/msaCacheDir\(stateDir, acc\.innerID\)/.test(idx), '描述符里带按账户分的缓存目录')
  ok(/acc\.type === 'yggdrasil' \|\| acc\.type === 'microsoft'/.test(idx), 'persistAuth 认 microsoft')
  ok(/acc\.type === 'yggdrasil' && session\?\.accessToken/.test(idx), '🔴 写令牌那段仍然只对 yggdrasil（正版令牌不落账户库）')

  ok(/if \(auth\.mode === 'microsoft'\) \{\s*return await msaSession\(\{/.test(as), 'makeSession 走 msaSession')
  ok(/msaSession\(\{ email: auth\.msaEmail, cacheDir: auth\.msaCacheDir \}\)/.test(as), 'msaSession 拿到邮箱与缓存目录')
  ok(/mode === 'yggdrasil' \|\| mode === 'microsoft'/.test(core), 'sessionFlags 把 microsoft 当真凭据')
  ok(/session\.certificates/.test(conn), 'connection.mjs 挂聊天签名证书')
  ok(/msaHasCache/.test(acc), '账户库用 msaHasCache 判 hasCredential')

  ok(/notSupported: msaSupported\(\) \? \[\] :/.test(idx), 'mc_capabilities 的"不支持"按 msaSupported() 决定')
  ok(/microsoft（微软正版，设备码登录）/.test(idx), 'mc_capabilities 列出了 microsoft 模式')
}

rmSync(tmp, { recursive: true, force: true })
console.log(`\n${pass} ✅ / ${fail} ❌`)
process.exit(fail ? 1 : 0)
