/* 验的是行为，不是配置项：`mcp/server.mjs` 的命令行**短路**开关真的短路了。
 *
 * 为什么单独立一个套件：`--version` / `-h` 这类开关必须在「起 server」之前就退出。
 * 写在后面的话，进程会先进 stdio 模式挂住等 stdin —— 命令不报错、也不退出，就是卡死，
 * 而且 stdio 那条路在自检里是**被客户端喂着 stdin** 的，永远发现不了这个 bug
 * （真踩过：`--version` 挂了 60 秒被超时杀掉）。
 *
 * 🔴 必须从包目录跑：`node tools\check-mcp-cli.mjs`
 *
 * 覆盖：
 *   ① `--version` / `-v`：退出码 0、**秒退**、stdout 就是 `package.json` 的 version
 *   ② `-h` / `--help`：退出码 0、秒退、帮助里列全所有开关
 *   ③ 帮助文本里写到的每个开关，源码里都真有处理（防"文档写了没实现"）
 *   ④ 短路时不碰 stdout 的 JSON-RPC 通道（版本号是唯一一行输出）
 *   ⑤ 矛盾/非法参数（`--stdio` + `--http` 同给、端口越界/非数字）**报错退出码 2**，
 *      而不是悄悄挑一个；单独给 `--stdio` 不报错且 stdin 一关就体面退出
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SERVER = join(ROOT, 'mcp', 'server.mjs')

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const src = readFileSync(SERVER, 'utf8')

let pass = 0
let fail = 0
const ok = (cond, label, extra = '') => {
  if (cond) { pass++; console.log(`  ✅ ${label}${extra ? ` — ${extra}` : ''}`) }
  else { fail++; console.log(`  ❌ ${label}${extra ? ` — ${extra}` : ''}`) }
}

/** 跑一次 CLI。返回 {code, out, err, ms, timedOut}。 */
const run = (args, timeoutMs = 15000) => {
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [SERVER, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: timeoutMs, killSignal: 'SIGKILL',
  })
  return {
    code: r.status,
    out: String(r.stdout ?? ''),
    err: String(r.stderr ?? ''),
    ms: Date.now() - t0,
    timedOut: r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL',
  }
}

console.log('\n【1】--version / -v')
for (const flag of ['--version', '-v']) {
  const r = run([flag])
  ok(!r.timedOut, `${flag} 没卡死（真的短路了）`, `${r.ms}ms`)
  ok(r.code === 0, `${flag} 退出码 0`, String(r.code))
  ok(r.out.trim() === String(pkg.version), `${flag} stdout = package.json 的 version`, `${JSON.stringify(r.out.trim())} vs ${JSON.stringify(pkg.version)}`)
  ok(r.out.trim().split('\n').length === 1, `${flag} stdout 只有一行（没污染 JSON-RPC 通道）`, `${r.out.trim().split('\n').length} 行`)
  ok(r.ms < 5000, `${flag} 秒退（没走到起 server）`, `${r.ms}ms`)
}

console.log('\n【2】-h / --help')
for (const flag of ['-h', '--help']) {
  const r = run([flag])
  ok(!r.timedOut, `${flag} 没卡死`, `${r.ms}ms`)
  ok(r.code === 0, `${flag} 退出码 0`, String(r.code))
  ok(/mcp-mc-agent/.test(r.err), `${flag} 打了帮助（走 stderr，不占 stdout）`, r.err.split('\n')[0])
  ok(r.out.trim() === '', `${flag} 不动 stdout`, JSON.stringify(r.out.trim().slice(0, 40)))
}

console.log('\n【3】帮助里写到的开关，源码里都真有处理')
const help = run(['-h']).err
for (const flag of ['--stdio', '--http', '--cwd', '--state-dir', '--version', '-h', '--help', '-v']) {
  const documented = help.includes(flag)
  /* 源码里要么直接出现，要么被 `flag('--x')` 取过 */
  const implemented = src.includes(`'${flag}'`) || src.includes(`"${flag}"`)
  ok(documented && implemented, `开关 ${flag} 既有文档也有实现`, `documented=${documented} implemented=${implemented}`)
}

console.log('\n【4】环境变量也都在文档里')
for (const env of ['MCP_MC_AGENT_STATE_DIR', 'MCP_MC_AGENT_HOME', 'MCP_MC_AGENT_CWD', 'MCP_MC_AGENT_HTTP_PORT', 'MCP_MC_AGENT_VERBOSE']) {
  ok(help.includes(env) && src.includes(env), `${env} 文档 + 实现都在`)
}

console.log('\n【5】矛盾/非法参数要报错，而不是悄悄挑一个')
{
  const both = run(['--stdio', '--http', '3931'])
  ok(both.code === 2 && !both.timedOut, '`--stdio` 与 `--http` 同给 → 退出码 2', `code=${both.code}`)
  ok(/不能同时给/.test(both.err), '报错说清了原因', both.err.trim().slice(0, 60))

  const badPort = run(['--http', '70000'])
  ok(badPort.code === 2 && !badPort.timedOut, '端口越界 → 退出码 2', `code=${badPort.code}`)
  ok(/端口不合法/.test(badPort.err), '报错说清了端口', badPort.err.trim().slice(0, 60))

  const nanPort = run(['--http', 'abc'])
  ok(nanPort.code === 2 && !nanPort.timedOut, '端口不是数字 → 退出码 2', `code=${nanPort.code}`)

  /* 单独给 `--stdio` 是合法的（它就是默认值），不能报错 —— 只是它会挂住等 stdin，
   * 所以喂一个关掉的 stdin 让它体面退出。**必须给临时状态目录**，否则会写用户的真账户库。 */
  const tmpState = mkdtempSync(join(tmpdir(), 'mcp-cli-stdio-'))
  const onlyStdio = spawnSync(process.execPath, [SERVER, '--stdio', '--state-dir', tmpState, '--cwd', tmpState], {
    cwd: ROOT, encoding: 'utf8', input: '', timeout: 15000, killSignal: 'SIGKILL',
  })
  ok(!/不能同时给/.test(String(onlyStdio.stderr ?? '')), '单独给 `--stdio` 不报错（它是默认值）', String(onlyStdio.stderr ?? '').slice(0, 60))
  ok(!onlyStdio.timedOut, 'stdin 一关就体面退出（不是挂死）', `${onlyStdio.status}`)
  try { rmSync(tmpState, { recursive: true, force: true }) } catch { /* 无所谓 */ }
}

console.log('\n【6】accounts 子命令（MCP 工具加不了账户，全靠它）')
{
  const CLI_SRC = readFileSync(join(ROOT, 'mcp', 'accounts-cli.mjs'), 'utf8')
  const state = mkdtempSync(join(tmpdir(), 'mcp-cli-acc-'))

  /* 6.1 `accounts help` 必须**不碰盘**就短路（它是纯文本命令，不该因为账户库坏了而失败） */
  const helpR = run(['accounts', 'help'])
  ok(!helpR.timedOut, 'accounts help 没卡死（真的短路了）', `${helpR.ms}ms`)
  ok(helpR.code === 0, 'accounts help 退出码 0', String(helpR.code))
  ok(/accounts/.test(helpR.out), 'accounts help 走了 stdout（是人看的文本，不是 JSON-RPC）', helpR.out.split('\n')[0])

  /* 6.2 帮助里列出的子命令，源码里都真有实现（防"文档写了没实现"） */
  for (const sub of ['list', 'servers', 'add', 'login', 'refresh', 'use', 'remove', 'help']) {
    const documented = new RegExp(`accounts ${sub}\\b`).test(helpR.out)
    const implemented = CLI_SRC.includes(`sub === '${sub}'`)
    ok(documented && implemented, `子命令 ${sub} 既有文档也有实现`, `documented=${documented} implemented=${implemented}`)
  }

  /* 6.3 首次跑 list：自动建默认离线账户（与 server 起时同一套 ensureDefaults） */
  const first = run(['accounts', 'list', '--state-dir', state])
  ok(first.code === 0 && !first.timedOut, 'accounts list 空库也能跑', `code=${first.code} ${first.ms}ms`)
  ok(/DeepSeek/.test(first.out), '空库自动建了默认离线账户（DeepSeek）', first.out.split('\n').find((l) => /DeepSeek/.test(l)) ?? '')
  ok(/accounts\.json/.test(first.out), 'list 报出了账户库路径（落点可核对）')

  /* 6.4 add offline → list 看得到；**第一列必须是 innerID**（脚本要能 awk 取它） */
  const added = run(['accounts', 'add', 'offline', 'Steve', '--state-dir', state])
  ok(added.code === 0, 'accounts add offline 成功', `code=${added.code}`)
  const listed = run(['accounts', 'list', '--state-dir', state])
  const steveLine = listed.out.split('\n').find((l) => /Steve/.test(l)) ?? ''
  ok(/Steve/.test(steveLine), 'list 里能看到刚建的账户', steveLine.trim())
  ok(/^acc-[0-9a-f]+/.test(steveLine.trim()), '**第一列就是 innerID**（行尾才是 ★默认，脚本可 awk）', steveLine.trim().slice(0, 20))

  /* 6.5 用法错 = 退出码 2（不是 1）—— 脚本要能区分"我用错了"和"跑挂了" */
  const noName = run(['accounts', 'add', 'offline', '--state-dir', state])
  ok(noName.code === 2, 'add offline 不给名字 → 退出码 2', String(noName.code))
  const noUrl = run(['accounts', 'add', 'yggdrasil', '--login', 'me', '--state-dir', state])
  ok(noUrl.code === 2, 'add yggdrasil 不给 --url → 退出码 2', String(noUrl.code))
  const noEmail = run(['accounts', 'add', 'microsoft', '--state-dir', state])
  ok(noEmail.code === 2, 'add microsoft 不给 --email → 退出码 2', String(noEmail.code))
  const bogus = run(['accounts', 'bogus', '--state-dir', state])
  ok(bogus.code === 2 && /不认识的子命令/.test(bogus.err), '未知子命令 → 退出码 2 + 说清原因', bogus.err.split('\n')[0])
  ok(/accounts/.test(bogus.err), '未知子命令顺便打了帮助（别让人再猜一次）')

  /* 6.6 离线账户不该被当成"要去登录"；正版账户**没登录时**如实说清下一步 */
  const offLogin = run(['accounts', 'login', 'acc-00000000', '--state-dir', state])
  ok(offLogin.code === 1 && /没有这个账户/.test(offLogin.err), 'login 不存在的账户 → 退出码 1（运行错，不是用法错）', offLogin.err.split('\n')[0])
  const ms = run(['accounts', 'add', 'microsoft', '--email', 'foo@bar.com', '--state-dir', state])
  ok(ms.code === 0, 'add microsoft 成功', `code=${ms.code}`)
  const msId = (run(['accounts', 'list', '--state-dir', state]).out.split('\n').find((l) => /foo/.test(l)) ?? '').trim().split(/\s+/)[0]
  const msRefresh = run(['accounts', 'refresh', msId, '--state-dir', state])
  ok(msRefresh.code === 0 && /accounts login/.test(msRefresh.out), '正版账户没登录缓存时，refresh 会指路去 login', msRefresh.out.trim().slice(0, 50))

  /* 6.7 密码只在凭据文件里：list / help 的任何一行都不该出现它 */
  const SECRET = 'zzz-not-a-real-password-zzz'
  run(['accounts', 'add', 'yggdrasil', '--url', 'littleskin.cn', '--login', 'me@x.com', '--password', SECRET, '--state-dir', state])
  const afterAdd = run(['accounts', 'list', '--state-dir', state])
  ok(!afterAdd.out.includes(SECRET) && !afterAdd.err.includes(SECRET), 'list 的输出里**没有密码**')
  ok(!helpR.out.includes(SECRET), 'help 里没有密码')
  const credFile = join(state, 'credentials.json')
  ok(readFileSync(credFile, 'utf8').includes(SECRET), '密码确实落到了 credentials.json（写进去了，只是不打印）')

  /* 6.8 帮助里要提 accounts —— 否则用 MCP 的人根本不知道有这条路 */
  ok(/accounts/.test(help), 'server 的 --help 里提到了 accounts 子命令')

  try { rmSync(state, { recursive: true, force: true }) } catch { /* 无所谓 */ }
}

console.log(`\n${fail === 0 ? '✅ CLI 短路全过' : '❌ CLI 短路有失败'}：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`)
process.exit(fail === 0 ? 0 : 1)
