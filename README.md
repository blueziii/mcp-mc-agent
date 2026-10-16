# mcp-mc-agent —— 给任何 MCP 客户端一副能玩 Minecraft 的身体

**Minecraft 的 MCP server**：34 个 `mc_*` 工具，覆盖进服/寻路/挖矿/合成/熔炼/存取箱子/看第一人称画面/记账。
任何支持 [Model Context Protocol](https://modelcontextprotocol.io) 的客户端（Claude Desktop、Cursor、DSH……）
连上它，模型就能真的去玩：走路、挖建、说话、看图、记事 —— 并在"值得你注意"的时候被叫醒。
**不再绑定 DSH**：DSH 只是众多 MCP 客户端之一。

本仓库是 [whale-craft](https://github.com/yzi1b/whale-craft)（作者 yzi1b）的魔改版。
上游那条线是 DSH 插件（旧名 `dsh-mc-agent`），**本仓库是它的 MCP server 分支**；
`CHANGELOG.md` 里的旧名字（whale-craft）保持原样。

| 项 | 值 |
| --- | --- |
| 仓库 | <https://github.com/blueziii/mcp-mc-agent> |
| **入口** | `mcp/server.mjs`（`package.json` 的 `bin.mcp-mc-agent` 指向它；`npm start` = `node mcp/server.mjs`） |
| **传输** | **stdio 默认**（`--stdio`）；HTTP 可选（`--http [端口，默认 3921]`，Streamable HTTP —— MCP 端点在 `POST /mcp`，`GET /health` 给探活） |
| **状态目录** | `~/.mcp-mc-agent`（Windows `%USERPROFILE%\.mcp-mc-agent`）：`accounts.json` + `credentials.json`（mode 0600）+ `config.json` + 日志 |
| **会话工作区** | `--cwd`，默认 `process.cwd()`；记忆与落盘图片挂它下面的 `.mcp-mc-agent/` |
| 前提 | Node.js >= 22、一个能进的 Minecraft 服务器、一个支持 MCP 的客户端 |

一个 server 进程 = **一个 Minecraft 角色**（`MCP_SESSION_ID = 'mcp'`）：一份记忆、一个机器人。

## 接到 MCP 客户端

```bash
npm install          # @modelcontextprotocol/sdk + mineflayer + vec3；sharp 可选（装不上只影响 mc_kit_image 渲染）
```

然后在客户端的 MCP 配置里加一条 server。**stdio（默认，推荐）**：

```json
{
  "mcpServers": {
    "minecraft": {
      "command": "node",
      "args": ["<仓库绝对路径>/mcp/server.mjs"],
      "env": { "MCP_MC_AGENT_CWD": "<想当会话工作区的目录>" }
    }
  }
}
```

- Claude Desktop 写进 `claude_desktop_config.json`，Cursor 写进 `.cursor/mcp.json`，其它客户端找各自文档里的
  `mcpServers` 段 —— **形状都是上面这个**。
- `args` 用**绝对路径**。Windows 上 JSON 里要转义反斜杠（`C:\\path\\mcp\\server.mjs`），或者干脆写正斜杠。
- `env` 可以整段省掉：不设 `MCP_MC_AGENT_CWD` 就用客户端拉起进程时的当前目录当工作区。
- 想省掉路径：`npm link`（或 `npm i -g .`）之后把 `command` 写成 `"mcp-mc-agent"`。

**HTTP（可选，给远程 / 网页客户端）**：

```bash
node mcp/server.mjs --http 3921                                    # 端口默认 3921
node mcp/server.mjs --http 3921 --cwd /path/to/world --state-dir /path/to/state
```

客户端那边填 `http://<主机>:3921/mcp`（Streamable HTTP）；探活用 `GET http://<主机>:3921/health`。

**命令行 / 环境变量速查**：

| 参数 | 作用 |
| --- | --- |
| `--stdio` | 用 stdio 传输（**默认**；写了也只是显式声明） |
| `--http [端口]` | 用 Streamable HTTP 传输，默认端口 `3921` |
| `--cwd <目录>` | 会话工作区（记忆、落盘图片挂它下面；默认当前目录） |
| `--state-dir <目录>` | 状态目录（配置 + 账户库 + 凭据；默认 `~/.mcp-mc-agent`） |
| `--version` / `-v` | 打印版本后退出（读 `package.json`） |
| `-h` / `--help` | 这条帮助 |

🔴 **`--version` / `-h` 在起 server 之前就短路退出** —— 不然进程会先进 stdio 模式挂住等 stdin，
命令看起来就是"卡死"。
**矛盾 / 非法参数直接报错退出（exit 2）**，不悄悄挑一个：`--stdio` 与 `--http` 同时给、
端口不是 1–65535 的整数，都会打一行 stderr 就退。

环境变量：`MCP_MC_AGENT_STATE_DIR` · `MCP_MC_AGENT_HOME` · `MCP_MC_AGENT_CWD` · `MCP_MC_AGENT_HTTP_PORT` ·
`MCP_MC_AGENT_VERBOSE=1`（多打 stderr 日志）。
**没有 DSH 时代的兼容别名** —— 只有 `MCP_MC_AGENT_*` 这一套。

- **没装 `mineflayer-pathfinder` 时 `mc_move` 会直接拒绝**（返回 `via:"pathfinder-unavailable"`），
  只剩"在水里游"和"原地跳"能用 —— 寻路能力完全依赖它。
- 依赖树体检：`node tools\check-mc-deps.mjs`（8 项）。
- 不想连服务器也能跑的自检：`node tools\check-all.mjs`。

那五个生态插件（pathfinder / collectblock / tool / pvp / auto-eat）是**可选**的，装哪儿由你定：
`src\plugins.mjs` 的 `loadMcDep` 依次找 ① `MCP_MC_AGENT_MC_DEPS` 指的目录（目录本身或它的 `node_modules`）
② 包旁边的 `vendor\mc-deps\node_modules\` ③ 状态目录下的 `vendor\mc-deps\node_modules\` ④ **包自己的 `node_modules\`**
（`package.json` 里已列为 `dependencies`，`npm i` 之后就在这儿）。
**缺哪个只是少那项能力**，其它照旧。

## 账户（第一次用先做这个）

**MCP 协议里没有"填账号密码"这种交互**，所以账户从**命令行**管。账户库和凭据都落在状态目录里，
和 MCP 那边共用同一份 —— 在终端建好，AI 那边 `mc_accounts` 立刻就能看到。

```bash
node mcp/server.mjs accounts list                          # 看有哪些账户（★ = 默认）
node mcp/server.mjs accounts add offline 史蒂夫             # 离线（盗版服 / 单机）—— 最常用
node mcp/server.mjs accounts add yggdrasil \
  --url https://littleskin.cn/api/yggdrasil \
  --login 你的账号 --password-stdin --name 游戏名           # 皮肤站 / 第三方认证服
node mcp/server.mjs accounts add microsoft --email a@b.com  # 正版（微软）：先只登记邮箱
node mcp/server.mjs accounts login acc-xxxxxxxx            # 正版：打设备码，去 microsoft.com/link 授权
node mcp/server.mjs accounts refresh acc-xxxxxxxx          # 换令牌 / 修登录状态
node mcp/server.mjs accounts use acc-xxxxxxxx              # 设为默认（之后 mc_connect 用它）
node mcp/server.mjs accounts remove acc-xxxxxxxx
```

- `accounts` 与 `--version` / `-h` 一样**在起 server 之前就短路退出** —— 不会挂住等 stdin。
- `--password-stdin` 从管道读密码（**别把密码写进命令行**，那会进 shell 历史与进程列表）；
  `accounts` 的输出**从不打印密码或令牌**。
- `accounts add microsoft` 只登记邮箱，**真正登录要再跑一次 `accounts login`**（设备码得你去网页点）。
- 忘了怎么用：`node mcp/server.mjs accounts help`。

## 跑自检

```bash
node tools\check-all.mjs            # 49 个套件：48 个 tools\check-*.mjs + mcp\selfcheck-mcp.mjs（几分钟）
node tools\check-all.mjs --fast     # 跳过端到端那一个（快）
node tools\check-all.mjs --only check-core-dig   # 只跑名字含这个子串的（`check-core-dig` 会连 `check-core-digtime` 一起跑）
```

任何 ❌ 都会让整体 `exit 1`。套件自己收拾现场（`--keep` 保留现场供排查）。

端到端那个（`mcp\selfcheck-mcp.mjs`）**真起一个 server 子进程 + 真 MCP 客户端**走完整 stdio 握手，
验的是"从客户端看这 server 像不像样"，共 **43 项**：握手（`instructions` 非空）/ 34 个工具一个不少 /
一批离线工具真调 / 图片内联 / **34 个工具全传 `{}` 都不崩** / 并发不串台 / 4 个 resources 逐个读 /
状态落盘（含"凭据库不在工作区里"）/ 协议通道干净（stdout 只有 JSON-RPC）。单跑：`node mcp\selfcheck-mcp.mjs`。

各套件的期望值（**2026-10-16 实测：49/49 全过**）：

| 套件 | 期望 | 盯的是什么 |
| --- | --- | --- |
| `check-mc-craft` | 184/0 | 合成链条、合成格不吞料 |
| `check-mc-furnace` | 267/267 | 熔炼、燃料挑选、产物名反查 |
| `check-mc-chest` | 126/126 | 存取箱子、全搬 |
| `check-mc-auto` | 246/0 | 自主层：反射/空闲决策/威胁判据；危险名单与搭路共用一份（含灵魂火）；叫醒简报带"脚下一层"摘要 |
| `check-call-budget` | 143/143 | 单次调用 ≤11 秒、抢占推号 |
| `check-token-budget` | 37/0 | `mc_*` 描述总体积 ≤ 18000 字符 |
| `check-core-place` | 77/0 | 放置判据、依附面、垫脚 |
| `check-core-dig` | 42/0 | 挖掘出口、复原包判决 |
| `check-core-digtime` | 27/0 | 挖矿速度修正（含附魔效率） |
| `check-core-swim` | 99/99 | 水里游/上浮/憋气 |
| `check-core-map` | 162/0 | 地形图字形与配色、地板层图、**竖列图**（几格实心 / 哪里开始空 / 空腔·水·岩浆分开说）、坐标换算、危险格、导航摘要 |
| `check-core-inventory` | 70/70 | 背包视图、动作与装备/工具耐久（"快坏了"看得见） |
| `check-core-equip` | 78/0 | 换工具/穿护甲 |
| `check-core-useitem` | 39/0 | 用物品 |
| `check-core-entities` | 53/0 | 实体名单与挑选 |
| `check-core-attack` | 86/0 | 攻击判据（"打死了"要有掉血证据） |
| `check-core-evidence` | 45/0 | "报成功要有证据" |
| `check-session-memory` | 13/0 | 每会话独立记忆 |
| `check-rules-file` | 48/0 | RULES.md 注入 + 内置默认准则（进服那段 / 工具名）+ 「随版本更新」只动默认那块 + 版本标记（`rulesVersion`）与旧标记迁移的静态接线 |
| `check-mc-observe-host` | 96/0（`--gate-on` 110/0） | 第一人称感知 |
| `check-mc-view-render` | 112/0 | 渲染内核 |
| `check-mc-skin` | 78/0 | 皮肤 |
| `check-async-util` | 59/59 | "等一件事"只有一份实现：`waitUntil` 判据顺序（已中止一次条件都不跑 / 当场成立一次都不等 / 到点不睡穿 / 条件抛错照样往外抛）+ `waitForEvent` 摘干净监听器 + 六处接线 |
| `check-worker-pool` | 61/0 | Worker 池：**默认关**（一行线程都不开）/ 小活不搬 / 大活真搬且结果逐字节一致 / **搬了主线程真的不堵**（心跳实测）/ 超时·中止·未知任务都如实退回原地 / 统计形状 |
| `check-msa` | 55/0 | 微软正版登录：`authTitle` 是 **clientId 不是应用名**（写成 `"Minecraft"` 会 `invalid_client`）/ 设备码缓存按账户分 / 两种命名都认 / 登录任务表**只给状态不给令牌** / 账户库的 `microsoft` 类型 / 接线 |
| `check-task-epoch` | 86/0 | 任务代次：只有重排步骤/取消/收工才换代、两个 await 后各对一次、过期的结果不写账 |
| `check-mc-pathfinder` | 26/0 | 寻路接入 |
| `check-watch-chat` | 21/21 | 看门狗聊天唤醒 |
| `check-audit-session` | 46/0 | 会话审计 |
| `check-logging` | 55/55 | 日志轮转/级别/去重；端到端自检用临时状态目录跑（不往真日志/真账户库里写） |
| `check-mc-deps` | 8/0 | vendor 依赖可加载 |
| `check-action-scheduler` | 144/0 | 动作调度器：资源登记/父子复用 `actionId`/撞车记账/**排队 + 抢占**/中断释放/ALS 死锁防线 |
| `check-perf-monitor` | 48/0 | 性能监测：`cpuRatio` 判据、同步调用记账、短样本不给占比、开关零成本 |
| `check-move-progress` | 104/0 | 移动进度监控：只认"既没挪动也没靠近"、正常等待豁免有上限、脱困阶梯 → `unreachable`；路径被反复失效 ⇒ 不等满 2.4 秒直接进阶梯；到达判定分水平/垂直两轴，"站错层"优先于"别人的锅"报 |
| `check-bridge` | 108/0 | 搭路状态机：铺一块→回读确认→才走一格、危险/落差/血量/材料任一项不过就停、断点续铺；`avoidBlockIds` 把要命方块交给寻路器绕开 |
| `check-terrain` | 132/0 | 地形分类（危险/沟/落差/台阶/窄道/平地）与按类调权重：优先级从最要命的往下、一格台阶不把平地判成台阶、用户配置永远赢；**导航缓存**（没挪窝、世界没变就不重扫，`unknown` 不缓存）+ 实测判决「一次扫描 0.193ms ⇒ 不需要 Worker」 |
| `check-water-navigation` | 95/95 | 水下出口搜索：只读扫描 + 6 邻域分层 BFS、三类出口（干燥落脚点 > 可呼吸空间 > 可通行水道）、空气口袋只当中间目标、预算用完/找不到都如实报 |
| `check-water-recovery` | 103/103 | 水下恢复控制器：氧气/掉血/没进展触发、"搜出口 → 执行 → 复核真的动了吗"循环、没走通就拉黑换下一条、**绝不偷偷接管**（每次都通知 AI 一声） |
| `check-module-load` | 30/0 | 拆出去的模块全都 import 得进来（含 `core.mjs ≤ 1000` 行，实测 999） |
| `check-tool-def` | 14 | `builtinDefineTool` 行为：`render` 返回 `[{type:"text", text}]`（= MCP content block 形状）、`toolDefKind()` 取值、JSON Schema 转换与校验 |
| `check-watchdog-mcp` | 50 | MCP 唤醒链路 + job 结算：`ctx.__mcpWake` 兜底、伪 agent 的 `steer` → `onWake`（自主层的叫醒通道在 MCP 下不再全哑）、唤醒写进会话事件队列、`mc_stop` 的强清路径认得"本会话的 job"、kill 之后看门狗真停、已结算的 job 自动摘掉 |
| `check-accounts-store` | 36 | 账户库 + 文件凭据库：`mc_accounts {search}`、离线账户"刷新"= 不需要认证、`mc_connect` 指名不存在的账户报错清晰、凭据不落工作区 |
| `check-core` | ✅ 全树正常 | 全树语法（`node --check`）+ 动态 import `core.mjs` 与其余 61 个模块 + 私有字段一致性（不打印 pass/fail，失败即 `exit 1`） |
| `check-mcp-content` | 56/0 | 工具结果 → MCP content blocks：**DSH 形状的 `{type:'image',attachment}` 必须丢掉**（照搬 DSH 约定会让整个 `tools/call` 被客户端判 `-32602` 扔掉）/ 不合规降级成 text / 落盘图片兜底内联 / `blockOk` 不变量 |
| `check-mcp-cli` | 67/0 | 两块：① CLI **短路** —— `--version` / `-v` 秒退且 stdout 就是 `package.json` 的版本号、`-h` 列全所有开关、帮助里写到的开关源码里真有处理、矛盾/非法参数 `exit 2`（真踩过：`--version` 挂在 stdio 里 60 秒被超时杀掉）② `accounts …` 子命令 —— 帮助里列的都真有实现 / `accounts list` 秒退 / 用法错退出码 2、运行错 1 / 输出与 `credentials.json` 里**不出现密码明文** |
| `check-mcp-package` | 67 | 打包 / 改名彻底性 / MCP 接线（工具表与 `bin` 指向、`selfcheck.mjs` 之类旧文件确实没了、文档不在旧名残留的扫描范围里） |
| `check-mcp-http` | 23 | HTTP 传输：`POST /mcp` 握手 + 34 个工具 + `inputSchema` 都是 object、非法入参在 HTTP 上也回 `isError`、4 个 resources、没有 session 头时被拒（不是静默成功）、未知路径 404 |
| `check-standalone-import` | ✅ 成功 | `npm pack` → 干净目录 `npm install` → `import('mcp-mc-agent')` 必须成功（慢，CI 跑） |
| `mcp/selfcheck-mcp` | **43 ✅ / 0 ❌** | **端到端**：真起 server 子进程 + 真 MCP 客户端握手（见上） |

> 🔴 静态断言（"读源码文本 → 正则匹配"那一类）**在拆分模块时最容易悄悄失效** ——
> 代码搬到别的文件、`this.` 改成 `self.`，断言还在原地找，于是一直红着没人看。
> 搬完模块先跑 `node tools\scan-moved-assertions.mjs`（顾问型），再核对上表数字。

## 配置速查

会话级配置用 `mc_config` 读写；下面的键写在**状态目录的 `config.json`**（`~/.mcp-mc-agent/config.json`），
或者直接用 `mc_admin_config` / `mc_config` 工具改 —— 改完立即生效，不用重启 server。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `memoryDir` | `<会话工作区>\.mcp-mc-agent` | 记忆根。**MCP 的"工作区"就是 `--cwd`**（默认 `process.cwd()`）；设了 `memoryDir` 就按它走 |
| `memoryPerSession` | `false` | `true` = 每会话一份独立记忆，互相看不见 |
| `pathfinder` | `true` | 关掉/给路径，等价于 `MCP_MC_AGENT_PATHFINDER` |
| `walkCanDig` / `walkDigCost` | `true` / `4` | 寻路能不能挖穿墙 |
| `walkPlaceCost` | `12` | 垫方块的代价（上游默认 1，比挖还便宜 ⇒ 会往空气上搭） |
| `walkMaxDropDown` | `3` | 最多往下跳几格 |
| `walkAllowParkour` | `false` | 跑酷 |
| `pfThinkTimeoutMs` / `pfSearchRadius` | `8000` / `192` | A* 思考上限 / 搜索半径 |
| `autoEatAt` | `14` | 饱食度低于它就吃 |
| `moveBudgetMs` / `collectBudgetMs` | 很大 | 会被 10 秒上限钳住 |
| `wearArmor` | `true` | 自动穿护甲 |
| `avoid` | `true` | 自主层自保（躲岩浆/火/仙人掌） |
| `idleWakeSec` / `idleWakeMaxPerHour` | `5` / `120` | 空闲多久叫醒 AI / 每小时上限 |
| `minIdleGapSec` / `idleWakeNearPlayerSec` | `5` / `5` | 两次叫醒最小间隔 / 旁边有人时的间隔 |

单独文件（都在 `<memoryDir>\`）：

- `auto.json` —— 自主层开关；`view.json` —— 看图门禁（`{"gate":true,"maxActions":8,"maxAgeMs":120000}`，**默认不强制**）。
- `RULES.md` —— 行事准则（2026-10-08 起内置默认与记忆里那份是**同一份文本**）。
- `版本提示.md` —— 2026-10-08 起只投一行指针。

**server 自己的**环境变量（决定进程怎么起，见上一节）：`MCP_MC_AGENT_STATE_DIR` · `MCP_MC_AGENT_HOME` ·
`MCP_MC_AGENT_CWD` · `MCP_MC_AGENT_HTTP_PORT` · `MCP_MC_AGENT_VERBOSE=1`。
**插件行为**类环境变量：`MCP_MC_AGENT_PATHFINDER`（`off` 或路径）· `MCP_MC_AGENT_MC_DEPS` · `MCP_MC_AGENT_MEMORY_DIR` ·
`MCP_MC_AGENT_AUTO` · `MCP_MC_AGENT_VIEW_GATE` / `_VIEW_GATED` / `_VIEW_MAX_ACTIONS` / `_VIEW_MAX_AGE_MS` ·
`MCP_MC_AGENT_SKIN_TIMEOUT_MS` · `MC_LOG_LEVEL`(`quiet|info|debug`) · `MC_LOG_MAX_BYTES` · `MC_LOG_KEEP` ·
`MC_HOST` / `MC_PORT` · `MCP_MC_AGENT_SCHEDULER`（`observe-only`(默认) / `enforce` = 撞车时**排队等**、够高就叫停低的）·
`MCP_MC_AGENT_PERF`（`off` 关掉性能监测，默认开）· `MCP_MC_AGENT_PERF_RESOLUTION`（事件循环延迟直方图分辨率 ms，默认 100，最小 10）·
`MCP_MC_AGENT_PERF_KEEP`（每个动作留多少条样本，默认 20）·
`MCP_MC_AGENT_WORKERS`（Worker 线程池：**不给 = 关**；数字 = 池子上限（≤4）；`on` = 自动取）。
**默认关是量过才这么定的** —— 唯一够格搬走的是 `mc_map {format:"image", radius:96, scale:16}` 的像素循环（943 万像素、28ms），
其余候选都在 16ms 以内，而且大头是搬不动的 `bot.blockAt()`。

## 工具速查（34 个）

三层命名空间：`mc_*` 游戏内动作、`mc_kit_*` 宿主能力、`mc_admin_*` 管理。
`mc_connect` / `mc_disconnect` / `mc_map` / `mc_kit_image` 不受 11 秒闸门（一次调用要把握手或算图做完）。

### 连接与账户

| 工具 | 干什么 |
| --- | --- |
| `mc_status` | 在线/坐标/朝向/血量/饱食度/手持/模式/看门狗/最近 3 条聊天；`verbose:true` 看完整明细 |
| `mc_lan` | 探测局域网服务器（只读）：只听多播 `224.0.2.60:4445` 的公告，不扫端口，恒定 `seconds` 秒内返回（默认 3、上限 15） |
| `mc_ping` | 已知地址时发一次 STATUS ping：通不通/版本/协议号/MOTD/人数/延迟；不登录不进服；连不上会翻译成人话（`ECONNREFUSED`=端口没人听 / `ENOTFOUND`=域名拼错 / 超时=防火墙） |
| `mc_connect` | 进服。**没有账号密码**，用哪个账户由账户库（`mc_accounts`）维护；地址/端口/子服自己传（`host` 不传就看环境变量 `MC_HOST`，两个都没有会直接报错）；连上等区块加载。`force:true` 会先断开再重登（玩家会看到你退游戏几秒） |
| `mc_accounts` | 列出/搜索/刷新/选定账户。**永远拿不到密码或 token**；`needUserAction` 时要明确让用户在**终端**跑 `accounts login` / `accounts refresh`（见 [账户](#账户第一次用先做这个)）—— 密码只有用户能填 |
| `mc_capabilities` | 边界信息：支持的 MC 版本范围（`testedVersions`）、mineflayer 版本、登录方式、各种上限。**进服前不确定版本能不能连时先看它** |
| `mc_sessions` | 列出所有活跃 MC 会话实例（诊断用） |
| `mc_disconnect` | 从 MC 下线，不影响其他会话的机器人；看门狗自动关闭 |
| `mc_stop` | 先优雅退游戏、再清本会话全部后台任务（看门狗在内）。**不中断当前这一轮**，适合"我不想玩了，下线" |

### 感知

| 工具 | 干什么 |
| --- | --- |
| `mc_observe` | 👁 **第一人称视角**：从眼睛（眼高 1.62）朝正看方向渲染截图并内联，附**三段式感知**：① 我看到（图里数出来的）② 程序检测到（坐标/射线打到的方块/半径内实体带血量）③ 不确定（客户端预测、未加载区块、读不到的血量）。两套眼睛对不上时点名，**以程序射线为准**。门禁默认关，写 `view.json` 的 `{"gate":true}` 可变回强制 |
| `mc_scan` | 扫描周围方块：给 `name` 找位置，不给返回统计 |
| `mc_map` | 看周围地形；**默认给"脚下方块那一层"**（地板层：`·`能站 `#`墙 `v`会掉 `~`水 `≈`岩浆 `?`未加载）。`mode:"auto"` 地下自动切洞穴层（`↓`能站 `*`矿石）/ `"surface"` 地表 / `"cave"` / **`"column"` 竖列**（只看你脚下一格，往下几格实心、哪里开始是空的 —— 挖之前先问它"会不会掉下去"）。`format:"image"` 额外生成俯视图 |
| `mc_inventory` | 看背包、装备栏和手持物品 |
| `mc_events` | 读/消费看门狗记下的事件（聊天、系统消息、受伤、上线/死亡/重连/断线）；`peek:true` 只看不清。**被传送/捡物/其他玩家上下线不在这里**（用 `mc_watch {action:"log"}`） |
| `mc_watch` | 看门狗控制（进服自动挂载、退服自动卸载）。默认叫醒：有人喊我 / 身边有人说话 / **任何玩家说话** / 受击 / 死亡 / 被传送 / 断线。⚠️ MCP 下唤醒走"**事件队列 + MCP 日志通知 + `mc://wake-log`**"三条腿，**内容以 `mc_events` 为准**（见 [MCP 唤醒机制](#mcp-唤醒机制)） |
| `mc_config` | 读写本会话 MC 配置（唤醒条件、近距半径、心跳、观察窗口、叫法）。不传参 = 看当前 + 默认；嵌套项用点号键 |
| `mc_diag` | 诊断：机器人内部状态（物理/控制位/收包/事件队列/合成窗口）+ **提示词注入状态**（`promptInjection`） |

### 动作

| 工具 | 干什么 |
| --- | --- |
| `mc_move` | `walk`（自动避障；**在水里自动改成直接游**，实测 2 格/秒）/ `fly`（创造默认）/ `jump`（原地跳，不需坐标）/ `swim`（不给坐标就只上浮换气）。**一次只走 10 秒**，没走到回 `arrived:false` + `remaining` + `hint`，再叫一次接着走 |
| `mc_act` | `look` 看向坐标/玩家 · `toward` 看向并走近 · `place` 放方块（悬空先垫脚，带 `used`/`held`）· `break` 破坏（先自动换对的工具，换不上就拒绝）· `use` 使用方块或实体（都不给 = 用手上的东西）· `useitem` 用手上的东西 · `attack` 打实体（中英文名都认，24 格内会追）· `equip` 装备（护甲自动穿到对应格） |
| `mc_dig` | 挖方块：给 `name` 挖最近的、或给 `pos` 挖指定坐标；`count` 连续挖多个；会自己换成对的工具。**一次只挖 10 秒的量** |
| `mc_build` | 批量搭方块：`(x1,y1,z1)–(x2,y2,z2)` 实心长方体，会自己走近/垫脚，结果带 `used`/`held`。**一次只放 10 秒的量**，没放完回 `remaining` + `hint`，范围原样重发（放对的自动跳过） |
| `mc_sequence` | 按顺序执行一串世界交互（替代"写脚本"）：`wait/move/look/toward/place/break/dig/use/useitem/attack/equip/give/toss/say/jump/swim`。**整串只跑 10 秒** |
| `mc_give` | 创造模式直接获取物品（**不走 `/give`，是协议级 `set_creative_slot`，非 OP 也能用**）；`clearAll:true` 清空背包 |
| `mc_say` | 在 MC 公屏说话（所有玩家可见） |
| `mc_command` | 以玩家身份执行服务器指令。白名单可配（默认 `tp/give/time/weather/say/gamemode/effect/setblock/fill/clone/summon/title/clear/xp`）。**最后手段**：正经动作优先 `mc_act` / `mc_build` / `mc_move` |

### 长活儿与自主

| 工具 | 干什么 |
| --- | --- |
| `mc_task` | 长活儿进度台账（挖 4 个以上自动开），存 `<记忆根>\tasks.json`，掉线重连都还在。`run` 一轮推进一步、`resume` 复核、`plan`/`step` 记账 |
| `mc_auto` | 🤖 **自主行为层**。① 反射层（不花 token、常开）：环顾、饿了吃、捡掉落物、躲岩浆火仙人掌、跟随玩家；**被怪打或有怪贴上来立刻叫醒 AI 定策略**（自己不跑不还手）；**在水里憋气也叫醒 AI 上浮**；附近有玩家时一直看着他。② 空闲决策层（花 token）：AI 停下 `idleWakeSec` 秒就带"玩家在干什么 + 长期目标 + 没做完的任务"叫醒它，**不许反问 Master**；叫醒 45s 后没动手再催一条；每小时最多 `idleWakeMaxPerHour` 次，没做事就翻倍拉长（封顶 30 分钟） |

### 合成 / 熔炼 / 箱子

| 工具 | 干什么 |
| --- | --- |
| `mc_craft` | 🧱 真合成（走服务端合成台）。**自动补齐中间产物**（要 `wooden_pickaxe` 自己排"木板→木棍→木镐"）；需要工作台时附近有用、没有就自己放脚边；原料不够会报**缺什么、缺几个、现在有几个**并给出下一步调哪个工具；`name` 可写简称（`planks` 自动选背包那种原木对应的木板）；`list:true` 看配方、`dryRun:true` 只出计划 |
| `mc_furnace` | 🔥 真熔炼（走服务端熔炉）。**写产物名也行**（`name:"iron_ingot"` 自动找粗铁/铁矿石）；附近没熔炉但背包里有就自己放脚边；**自己挑燃料**（有煤/木炭先烧煤，木棍木板是合成料只在没正经燃料时才烧） |
| `mc_chest` | 📦 真仓库（服务端箱子/木桶）。`list`/`put`/`take`；附近没箱子但背包里有就自己放到脚边；`all:true` 是**真全搬**（工具也会被放进去） |

### 宿主工具

| 工具 | 干什么 |
| --- | --- |
| `mc_kit_image` | 图像能力。**SVG 是编辑语言**：布局/画框/加中文/拼网格都写 SVG 文本，再光栅化成 PNG。`info` / `embed`（图片变 data URI + 现成 `<image>` 标签，往 SVG 里引图必须这么做）/ `render` / `grid` / `save`。出的图**直接以 MCP image content 返回**给模型看 |
| `mc_kit_express` | 把**发布区** `.mcp-mc-agent/.express/` 里的文件换成"给用户的东西"。看 `mc_admin_config` 的 `expressEnabled` / `expressBase` 开没开：关（默认）= 只回一句 + 绝对路径，开 = 回完整 URL。**只有 `.express/` 下的可分享**，默认输出目录 `.out/` 不对外。⚠️ MCP 下**没有内置 HTTP 文件服务**（那条路由原本由 DSH 宿主提供），所以实际用关闭模式、把绝对路径给用户最靠谱；图片本身不用走它 —— `mc_map` / `mc_observe` / `mc_kit_image` 的图**直接以 MCP image content 返回** |
| `mc_kit_memory` | 长期记忆（跨会话、重启还在），按服务器建子文件夹（`_global/` 放通用）。`README.md` 索引由 AI 自己维护；MCP 下它的内容 + 自动目录树在 `initialize` 时拼进 `instructions`（全文见 `mc://prompt`）。`index` / `kinds` / `record`（带元数据，同 key 累加成功失败）/ `read`（读图片会作为附件）/ `append` / `put` / `search` / `delete` |
| `mc_admin_config` | 【管理】读写**全局配置**（状态目录的 `config.json`）。`get`/`set`/`unset`/`reset`/`list`；有用的键：`commandWhitelist`（`"tp"` 精确、`"/^gi.*/"` 正则、`"*"` 全放行）、`allowAllCommands`、`expressEnabled`、`expressBase`、`memoryDir`、`memoryPerSession`。**DSH 遗留键**（`mcModePresets` / `mcPlusPresets` / `mcMode.allowOtherTools` / `mcMode.hideAdminTools` / `ensureMcPreset`）在 MCP 下**没有效果** —— MCP 没有 preset 体系，这个进程只暴露那 34 个工具 |

## MCP 唤醒机制

MCP 是**"你问它答"**：server 不能主动往模型上下文里塞消息（DSH 的 `agent.steer` 能直接起一轮 /
在下一步插话，MCP 没有对应能力 —— `mcp/host.mjs` 桩上那个同名 `steer` 只是把消息**转进下面这三条通道**，
好让 `src/watchdog.mjs` 和 `extensions/mc_auto.mjs` 那些 `typeof agent.steer === 'function'` 的守卫照常成立）。
所以看门狗的唤醒走三条腿，**模型要主动收**：

| 通道 | 机制 | 谁看得见 |
| --- | --- | --- |
| **主通道：会话事件队列** | 唤醒文案以 `【看门狗唤醒·<kind>】…` 写进本会话的事件队列 | 模型下次调 **`mc_events`** 必然看得见（`mc_events` 是**消费**：取走即删；只想看用 `peek:true`） |
| 提示通道：MCP 日志通知 | 同时发一条 `notifications/message`（`level: "warning"`、`logger: "mcp-mc-agent"`） | 支持 logging 的客户端会**立刻**显示给模型；**它只是提示，内容以 `mc_events` 为准** |
| 兜底：`mc://wake-log` | 最近 **50** 条唤醒存在内存里（服务端进程内环形缓冲） | 通知丢了/客户端不支持 logging，读这个 resource 补 |

- 看门狗照旧**进服自动挂载、退服自动卸载**；唤醒条件（有人喊我 / 身边有人说话 / 任何玩家说话 /
  受击 / 死亡 / 被传送 / 断线）与 DSH 版一致。
- 想安静等：`mc_events {waitSec}` 会被"要唤醒你"**打断**（返回 `interrupted:true`），不会把唤醒压到等待结束。
- 结论：**该做的是定期 `mc_events`**；不要指望通知一定送到。

## 从 dsh-mc-agent 迁移

本仓库的 DSH 插件分支（旧名 `dsh-mc-agent`）和这个 MCP server 是**同一套代码的两个壳**：
**34 个工具的名字、参数、返回值一模一样**，账户库与记忆格式也兼容 —— 记忆里写的工具名不用改。

| 要搬的东西 | 旧位置（DSH 插件） | 新位置（MCP server） |
| --- | --- | --- |
| 全局配置 | `$DSH_HOME/dsh-mc-agent/config.json` | `~/.mcp-mc-agent/config.json` |
| 账户库 | `$DSH_HOME/dsh-mc-agent/accounts.json` | `~/.mcp-mc-agent/accounts.json` |
| 密码 / token | 宿主凭据服务（`$DSH_HOME/.credentials.yaml`） | `~/.mcp-mc-agent/credentials.json`（mode 0600） |
| MSA 令牌缓存 | `$DSH_HOME/dsh-mc-agent/msa/<账户>/` | `~/.mcp-mc-agent/msa/<账户>/` |
| 记忆 / 提示词 | `<会话工作区>/.mcp-mc-agent/` | 一样（"工作区"= `--cwd`） |

**不会自动接管**（目录名和位置都变了）。想带着配置和账户过来，手动搬一次：

```bash
cp -r "$DSH_HOME/dsh-mc-agent/." ~/.mcp-mc-agent/          # 搬过去
# 或者干脆指回老目录：
MCP_MC_AGENT_STATE_DIR="$DSH_HOME/dsh-mc-agent" node mcp/server.mjs
```

🔴 **密码搬不过来**：DSH 版把密码/token 交给**宿主凭据服务**，MCP server 是独立进程，用的是自己的
`credentials.json`（key 仍按 `mcp-mc-agent/<innerID>` 组织）。所以**正版 / 皮肤站账户要重新登录一次**
（离线账户不用）；账户条目本身在 `accounts.json` 里，会跟着搬过来。
重新登录就是在终端跑 `node mcp/server.mjs accounts login <innerID>`（正版，打设备码）或
`accounts refresh <innerID>`（皮肤站，会问你密码）—— 见 [账户](#账户第一次用先做这个)。

另外两处"没了"：**MC 模式 / MC+ 那套 preset 与权限隔离在 MCP 下不生效**（改成"这个进程只暴露这 34 个工具"），
**Web GUI / 设置页也没有了**（改配置用 `mc_admin_config` / `mc_config`，或者直接编辑 `config.json`）。

## 架构速览

`mcp\` 六个文件 + `index.js` + **62 个 `src\` 模块** + 7 个扩展。**依赖方向**：
`mcp\server.mjs` → `mcp\host.mjs` → `index.js` → `extensions\` → `src\`；
`src\` 内部单向，**新模块不许反向 `import` 回 `core.mjs`**（靠 `setXxx()` 注入或收 `ctx`）。

### 宿主侧

| 文件 | 干什么 |
| --- | --- |
| `mcp\server.mjs` | MCP 入口：stdio / Streamable HTTP 两种传输、`tools/list` + `tools/call`、4 个 resources、`instructions` 拼装、工具结果 → MCP content blocks（**图片内联**）、唤醒 → 事件队列 + `notifications/message` |
| `mcp\host.mjs` | 给 `index.js` 的 `apply(ctx, config)` 喂**宿主桩**（假 ctx / 假 exec）。`ctx.webServer` 是空实现、`ctx.tools.guard` **故意不生效**、`agentPresets` 假装成 `minecraft`（让"MC 模式"判据成立） |
| `mcp\content.mjs` | **工具结果 → MCP content blocks**：`renderContent`（text / image / resource）+ `blockOk` 校验 + `IMAGE_MIME` / `MAX_INLINE_IMAGE_BYTES`(4MB) / `mimeOfFile` / `findImageFiles` / `safeJson`。抽出来才能离线单测 |
| `mcp\accounts-cli.mjs` | `accounts …` 子命令（**MCP 协议里没有填账号密码的交互**，所以账户只能从命令行管）：`list` / `servers` / `add offline\|yggdrasil\|microsoft` / `login` / `refresh` / `use` / `remove` / `help`。输出**从不打印密码或令牌** |
| `mcp\credentials.mjs` | 本地文件凭据库（`<stateDir>/credentials.json`，0600，key = `mcp-mc-agent/<innerID>`），接口对齐 DSH 的 `ctx.get('credentials')` |
| `mcp\selfcheck-mcp.mjs` | 端到端自检：真起 server 子进程 + 真 MCP 客户端握手（43 项） |
| `index.js` | 5251 行。工具注册（29 个）、看门狗接线、`stopSession`、文件保护、`mc_admin_config`、日志落盘 |

### `src\` 模块

| 模块 | 干什么 |
| --- | --- |
| `core.mjs` | `McBot` 内核（999 行）。走路接 pathfinder、单次调用 ≤11 秒、日志基建、`actionScheduler` 接线 |
| `connection.mjs` | 连接与保活：`connect` / `scheduleReconnect` / `disconnect`；断线时 `actionScheduler().releaseAll()` |
| `runtime.mjs` | 运行时管线：`reportError`（唯一错误上报口）/ `withBudget`（超时闸门）/ `stopPathing` / `interruptMove` / `setAbortSignal` / `holdControl` / `waitForChunks` / `requireBot` |
| `status.mjs` | 连接/状态视图（`connectionViewOf` / `statusOf`，离线 ghost/reconnecting，在线坐标/朝向/生存/氧气/手持/在线时长） |
| `config.mjs` | 配置默认值与合并（715 行） |
| `accounts.mjs` / `auth-session.mjs` | 账户管理与认证（**全插件唯一碰凭据的地方**：`authOnly` / `makeSession` / `refresh` / `authenticate`） |
| `ping.mjs` / `lan.mjs` | STATUS ping / 局域网多播监听（`lan.mjs` 全程不抛） |
| `plugins.mjs` | vendor 依赖加载器（`MC_DEPS` / `loadMcDep` / `loadPathfinder`）＋ 装配（`setupPathfinder` / `movements` / `setupPlugins`） |
| `movement.mjs` | 移动原语：`jump` / `swimUp` ＋ 移动主体 `walkSwim` / `walkTo` / `flyTo` / `walkPathfinder`。**唯一的移动实现**，不再保留手写按键/盲跳/挖方块兜底 |
| `place.mjs` / `place-items.mjs` | 放置那一层（`placeRef` 找依附面 / `placeBlock` 够不着先走、悬空先垫脚、放完回读）＋ 挑方块与垫脚料（`NON_FULL_BLOCK` / `isFullBlockItem` / `scaffoldingItemIds` / `pickPlaceItem`） |
| `build.mjs` | 搭建：范围 → 坐标 → 逐个 `placeBlock`；只算复核过的、跳过已占用、到点带着结果收手 |
| `bridge.mjs` | 搭路（`mc_act {mode:"bridge"}`）：**铺一块 → 回读确认 → 才走一格**的状态机。开铺前先过危险闸（脚下实地 / 正下方岩浆火 / 落差 ≤8 / 血量 ≥8 / 有整方块料），任何一条不过就一块都不放；中途任何一处对不上立刻停；已铺好的格子跳过（断点续铺）；一次最多 16 格 |
| `terrain.mjs` | 地形分类 + 路径评分（导航 P2）：量脚边一圈的柱子，归成**危险 / 沟 / 落差 / 台阶 / 窄道 / 平地**，每类给一套寻路权重（`maxDropDown`/`liquidCost`/`digCost`/`placeCost`）。**只调权重、不换算法**；用户显式配置（`walkMaxDropDown` 之类）永远赢；判不出来就按平地走。结果按 `TERRAIN_CACHE_MS` 缓存，`blockUpdate`/区块加载卸载就作废 |
| `water-navigation.mjs` | **水下出口搜索**（只读 + 纯计算，**一行按键操作都没有**）：以脚下为中心，水平 8 格 / 上下 8 格做 6 邻域分层 BFS，把格子分成水 / 空气 / 挡路 / 未加载，挑出三类出口 —— **干燥落脚点（最优先）> 可呼吸空间 > 可通行水道**。不只看"是不是空气"：要查脚位 + 头位 + 脚下支撑 + 一条真的连得通的路；空气口袋只当**中间目标**；预算用完老实回 `budget-out`，找不到回 `no-exit-found`，**不假装找到路** |
| `water-recovery.mjs` | **水下恢复控制器**：`waterStateOf` 读氧气/血/在水里，`waterTriggerOf`（纯函数）判该不该救，`recoverFromWater` 走"**搜出口 → 用现有接口执行 → 复核真的动了吗** → 没走通就把这条拉黑再搜"的循环。移动全靠注入的 `ctx.walkTo` / `ctx.swimUp`（**不另起一套游泳按键控制**）；复核不认"离目标够近"（出口就在头顶一格时人没动也够近），认"真到了 / 真近了 / 气回来了 / 出水了" |
| `msa.mjs` | **微软正版登录**（叶子模块，只 import `node:*`）：`Authflow` 走**设备码**（`flow:'live'` + `authTitle` = 官方 clientId + `deviceType:'Nintendo'`），令牌缓存按账户分（`<stateDir>/msa/<innerID>/`）；`msaLogin` 给账户库（mc_accounts）的显式登录用，`msaSession` 给连接用 —— 后者**绝不停下来等用户**（缓存没了就报 `needUserAction` 指路去账户库重新登录）；`msaJobOf` 给 HTTP 层的状态**只含 state/设备码/结果，绝不含令牌** |
| `mining.mjs` | 挖掘：`breakBlock`（够不着/没落地/换不上工具/时间不够都不动手；服务端说"复原"就不报成功）＋ `dig`（一条路走过去挖，服务端不认就如实说） |
| `dig-guard.mjs` | 采集/落地守卫：`collectBusy` / `cancelCollect`（停任务 + 松控制位，等不到就清队列）/ `waitGrounded` / `withHeld` |
| `dig-speed.mjs` | 挖矿速度修正（上游把 108 个方块的 `material` 写成品级门标签，铁矿石要 4.5 秒） |
| `server-break.mjs` | 服务端破坏判决（`watchServerBreak` 三态：真挖掉 / 复原 / 没证据；`awaitServerBreak` 等服务端的包，可晚到约 1 秒） |
| `pickup.mjs` | 捡掉落物（`grabDrops` 按背包差报数；捡不到显式收尾，不让采集任务挂着） |
| `attack.mjs` | 攻击（`who` 中英文名/玩家名都认；`pvp.attack` 只是设目标，自己轮询等它消失） |
| `world-use.mjs` | 使用/交互：`useBlock`（容器看窗口、门看属性翻没翻）/ `useItem` / `interact`（look·place·break·toward 分流）/ `equip` |
| `world-scan.mjs` | 感知最后两块：`scanAround`（方块计数/点名，按距离升序）/ `entitiesNear`（附近有谁：分类/血量/远程/上下差） |
| `world-observer.mjs` | 只读观察：`entityHealth` / `inWaterNow` / `slowDigWhy` / `dropsNear` / `dropHint` / `blockReachOf` / `stateNameOf` |
| `observer.mjs` | 世界观察器整层：`invSignature` / `observeTick`（每秒产出 teleport·pushed·pickup·playerJoin/Leave）/ `startObserver`·`stopObserver` |
| `map-render.mjs` | 地图：`isUnderground` / `caveCell` / `heightmapOf` / `glyphMapText` / `mapImageOf`（自带 2.5 秒软上限） |
| `camera.mjs` | 朝向/相机：`lookAnglesTo` / `aimAt`（直接写 `entity.yaw/pitch`，绕开会挂的 `bot.lookAt`）/ `lookAt` |
| `inventory.mjs` | 背包那一层（读 + 动）：`heldText` / `invSnap` / `invUsed` / `canHarvestNow` / `toolKinds` / `countOf` / `freeSlot` / `inventoryView` / `giveItem` / `clearInventory` / `tossItem` / `equipFor` |
| `sequence.mjs` | 连串动作调度：`runSequence`（预算/中断/从第几步续跑；不为没执行的步骤记账）/ `runStep` |
| `task-runner.mjs` | 可恢复的任务状态机（落 `<记忆根>\tasks.json`，只记账不下发动作）＋ 结构化目标与步骤表（`GOAL_TYPES` / `STEP_STATUSES` / `defaultSteps` / `normSteps` / `migrateTask` / `stepBegin` / `stepDone` / `stepFail` / `stepReset`） |
| `task-exec.mjs` | 任务执行器：每轮只推一步（`observe()` 看现场 → `goalDone()` 复核 → 取当前步 → `call(op,args)` 调真工具 → 记账）；四道闸门（`budgetMs` / `maxRounds` / `maxAttempts` / 工具自己的 11 秒）；"结果未知"不记失败；**自己不碰 bot**，工具由 core 通过 `TOOL_HANDLERS` 回调进来 |
| `task-report.mjs` | 任务收工报告（三种形状并存）：`taskHave` / `verdictLine`（三态判决）/ `taskSettle` ＋ 任务门面 `taskStart`/`taskList`/`taskGet`/`taskResume`/`taskNote`/`taskDone`/`taskCancel`/`taskForget`/`taskPlan`/`taskStep` |
| `action-scheduler.mjs` | 统一动作调度器：`RESOURCES` / `PRIORITY` / `MODES` / `TOOL_SPEC` / `ActionScheduler`（`run`/`cancel`/父子复用 `actionId`/冲突记账/`releaseAll`/**排队 `waitMs` + 抢占 `#preempt` + `AsyncLocalStorage` 认父亲**） |
| `perf-monitor.mjs` | 性能监测（`perfWrap` 包住每次工具调用，记墙钟 / `process.cpuUsage()` / 期间事件循环延迟）＋ `perfVerdict()` 直接给"哪个动作该搬 Worker"的中文结论。**主信号是 `cpuRatio`（CPU÷墙钟），不是 `loop*`** —— 直方图本身带一个分辨率级底噪。`mc_diag` 的 `perf` 段就是它 |
| `watchdog.mjs` | 看门狗（唤醒矩阵 `wakeOn.*`，714 行） |
| `memory.mjs` | 记忆四分类 + 元数据（world/lessons/tasks/RULES；来源·更新·成功失败次数·适用版本·条件） |
| `chat.mjs` | 聊天记录（签名/未签名两条路 + 按渲染形状兜底；1.5 秒去重；`chatSay` 公屏说话，`/` 开头拒） |
| `agentsmd.mjs` | AGENTS.md / 提示词注入（326 行）。MCP 下这些条目由 `mcp\server.mjs` 拼进 `instructions`（全文 `mc://prompt`） |
| `version-prompt.mjs` / `connect-prompt.mjs` / `user-message.mjs` | 版本提示 / 进服提示 / 玩家消息转成提示 |
| `protected.mjs` | 受保护文件（RULES.md / AGENTS.md / config.json 不许改） |
| `block-names.mjs` | 方块名判据（空气/液体/能穿过去/软顶）+ 地形图字形与配色 + 右键交互判据 |
| `entity-names.mjs` | 实体名单与分类（敌对/远程/掉落物）、中文别名、`entityNameOf` / `matchNameOf` / `pickEntity` |
| `budget.mjs` | 单次调用时间预算（纯常量 + 纯函数）：`TIMEOUTS` / `CALL_MS` / `CALL_BUDGET_MS` / `callBudget` / `callDeadline` / `callSecText` / `budgetSecText` |
| `format.mjs` / `log.mjs` | 无损 JSON + 家目录脱敏 / 日志基建（本地时间、级别、去重、轮转） |
| `async-util.mjs` / `wait.mjs` | 异步叶子：`sleep` / `withTimeout` / `raceAbort` / `abortError` ＋ **全仓库唯一一份"等"的实现** `waitUntil`（判据轮询）/ `waitForEvent`（真事件）；`wait.mjs` 是 `mc_events {waitSec}` 的阻塞等待（会被"要唤醒你"打断） |
| `worker-pool.mjs` / `worker-tasks.mjs` / `worker-entry.mjs` | Worker 线程池（**默认关**）：`runInWorker` 把纯计算交给线程；任务实现只在 `worker-tasks.mjs`（主线程与线程**同一份**）；起不来 / 崩了 / 超时 / 活太小 ⇒ 原地跑同一份实现并如实标 `via` |
| `image.mjs` / `png.mjs` / `express.mjs` | 图像编解码 / PNG 写出 / 文件分享 |
| `wsconfig.mjs` / `serverhistory.mjs` | 工作区配置 / 服务器历史 |
| `tool-def.mjs` | 工具定义辅助（294 行） |

### `extensions\`（改完重启 server 即生效）

| 文件 | 干什么 |
| --- | --- |
| `mc_util.mjs` | 共用件（**不是扩展**）：物品/方块名与 id、`countOf`、放得下吗… |
| `mc_observe.mjs` | 第一人称截图 + 三段式感知（注册 `mc_observe`） |
| `mc_view-render.mjs` | 渲染内核（不注册工具） |
| `mc_skin.mjs` | 皮肤解析与渲染（不注册工具） |
| `mc_auto.mjs` | 自主行动层（注册 `mc_auto`） |
| `mc_craft.mjs` / `mc_furnace.mjs` / `mc_chest.mjs` | 合成 / 熔炼 / 存取箱子 |

### 5 个现成依赖（不自己写这些能力）

| `MC_DEPS` 键 | 包 | 接管了什么 | 接在哪 |
| --- | --- | --- | --- |
| `pathfinder` | mineflayer-pathfinder@2.4.5 | 寻路 / 防卡住 | `McBot.walkTo()`（见 [PATHFINDER.md](PATHFINDER.md)） |
| `collectBlock` | mineflayer-collectblock@1.6.0 | 走过去挖方块 + 捡掉落物 | `McBot.dig()` 优先交给它；`mc_auto` 的 `pickup` |
| `tool` | mineflayer-tool@1.2.0 | 按方块挑最好的工具 | `dig()` 退回原地挖时 `equipForBlock`；**包内打过补丁** |
| `pvp` | mineflayer-pvp@1.3.2 | 追击 + 近战节奏 | `McBot.attack({who})` |
| `autoEat` | mineflayer-auto-eat@5.0.3 | 饿了自动吃 | `mc_auto` 只按开关 enable/disable |

`#movements()` 造的那份 `Movements` 同时给 pathfinder / collectBlock / pvp 用 —— 免得"我自己走不乱跳、
插件走就乱跳"。缺哪个只是少那项能力，其它照旧。

### 目录

```
mcp\server.mjs                         MCP 入口（stdio / Streamable HTTP）
mcp\host.mjs                           宿主桩（假 ctx / 假 exec）
mcp\credentials.mjs                    本地文件凭据库
mcp\selfcheck-mcp.mjs                  端到端自检（真 server + 真 MCP 客户端，43 项）
index.js                               宿主侧（工具注册 / 看门狗 / 配置）
src\                                   62 个模块（见上表）
extensions\                            7 个扩展 + mc_util.mjs
tools\check-*.mjs                      47 个离线自检套件
tools\check-all.mjs                    一条命令全跑完 + ✓/✗ 汇总表
tools\scan-moved-assertions.mjs        顾问型：搬模块后的断言扫描
README.md / 插件说明.md / 踩坑档案.md / PATHFINDER.md / CHANGELOG.md
```

**东西都落哪去了**：

| 东西 | 位置 |
| --- | --- |
| 状态目录（全局配置 · 账户库 · 凭据 · 日志 · MSA 令牌缓存） | `~/.mcp-mc-agent/`（Windows `%USERPROFILE%\.mcp-mc-agent\`），可用 `--state-dir` / `MCP_MC_AGENT_STATE_DIR` 改 |
| 记忆 / 提示词 / 出图 | `<会话工作区>/.mcp-mc-agent/`：`README.md`（AI 维护的总索引）+ `RULES.md`（行事准则）+ 任意文档/图片 |
| 默认输出 / 发布区 | `<记忆根>/.out/`（**不对外**）· `<记忆根>/.express/`（可分享，见 `mc_kit_express`） |
| 任务台账 | `<记忆根>/tasks.json` |

`.mcp-mc-agent/` 里的东西**只读写文件，不执行任何东西**。**凭据绝不写进工作区**（工作区是喂给 AI 的）。

## 相对上游改了什么

上游 whale-craft 是一个能连服的 mineflayer 壳；这个版本把它做成了"能长期自己玩"的 agent。
按能力分类（每条的具体来龙去脉在 [踩坑档案.md](踩坑档案.md)）：

**安全与诚实**

- **"报成功必须有证据"**：`break`/`place`/`dig` 的判据一律回读服务端状态；服务端发回原方块包
  （拒绝破坏）绝不算成功（`server-break.mjs` 三态判决）。
- **不许骗人**：`place` 没出现方块、`use` 没开窗口、`attack` 没打死，都如实说；
  `mc_connect {force:true}` 的说明写明"玩家会看到你退游戏几秒"。
- 受保护文件（RULES.md / AGENTS.md / config.json）不许改。

**不卡死**

- **单次调用 ≤11 秒**：`mc_move`/`mc_dig`/`mc_build`/`mc_sequence` 到点带结果收手，
  返回 `remaining` + `hint` 让模型接着叫 —— 挂住的时候用户看不到任何消息。
- 超时闸门走 abort signal + 本地 deadline；客户端取消这次调用能立刻真停（`interruptMove` 推号 + 停采集 + 松控制位）。
- 挖矿速度修正：上游 `material` 写错导致铁矿石要 4.5 秒，现在石镐挖铜矿 4550ms → 1302ms。
- pathfinder 接进来 + 两处补丁 + `walkPlaceCost` 调高（上游默认 1 会让机器人往空气上搭）。

**能自己玩**

- **看门狗**：进服自动挂载，聊天/受击/死亡/传送/断线都会叫醒 AI（MCP 下是"事件队列 + 通知"，见 [MCP 唤醒机制](#mcp-唤醒机制)）。
- **自主层 `mc_auto`**：反射层不花 token 地环顾/吃/捡/躲/跟随，被怪打或憋气时叫醒 AI 定策略；
  空闲决策层带"玩家在干什么 + 长期目标 + 没做完的任务"叫醒它，**不许反问 Master**。
- **任务台账 + 步骤表 + 执行器**：挖 4 个以上自动开工，`tasks.json` 掉线重连都还在；
  `mc_task {action:"run"}` 一次推进一步，四道闸门防跑飞。
- **记忆**：四分类（world/lessons/tasks/RULES）带来源·成功失败次数·适用版本；按服务器建子文件夹，可每会话独立。
- **统一动作调度器**：资源冲突（interaction/movement）记账；`enforce` 模式下撞车**先排队等**（`waitMs`，默认 3 秒），
  够高就叫停低的（同级不抢、`preemptible:false` 不抢、取消边界在 `cleanup`/`unknown` 不抢）；
  父子动作复用 `actionId`，而且**子步骤忘了说自己是谁也不会把自己锁死**（`AsyncLocalStorage` 兜底）。

**看得见**

- **第一人称视角 `mc_observe`**：从眼睛渲染截图 + 三段式感知（我看到 / 程序检测到 / 不确定），
  两套眼睛对不上时点名，以程序射线为准；门禁默认关，AI 自己决定何时看。
- **地形图**：地表图 + 地下自动切洞穴层；`format:"image"` 出俯视图。

**生活技能**

- 合成/熔炼/存取箱子三个扩展走**真服务端界面**（不是作弊给物）：自动补齐中间产物、
  写产物名反查原料、自己挑燃料、附近没工作台/熔炉/箱子就自己放一个。
- 装备栏、附魔台、铁砧、锻造台。
- 图像工具链（`mc_kit_image` / `mc_kit_express` / `mc_kit_memory`）与 `mc_admin_config`。

**工程**

- `src\core.mjs` 从 4896 行拆到 999 行，62 个模块单向依赖（拆的规矩见下一节）。
- 日志：本地时间、级别、去重、轮转（上游是 UTC + 从不轮转 + 59.7% 启动噪声）。
- `tools\check-all.mjs` 49 个套件离线自检 + 顾问型断言扫描器。

## 拆分模块的规矩

`src\core.mjs` 是**分 43 刀**拆出来的（4896 → 999 行）。以后继续拆照这 46 条来 ——
每条都是踩出来的，括号里的"第 N 刀"是它第一次被踩到的位置（对应提交见 [CHANGELOG.md](CHANGELOG.md)）。

1. **`core.mjs` 里保留同名导出**：`export { lossless, redactPath } from './format.mjs'` —— 外部一行都不用改。
2. **一次只搬一个模块**，搬完立刻 `node --check` + 真的 import 一遍，确认导出还在、行为没变。
3. **移动和挖掘最后再拆**：`#walkPathfinder()` / `dig()` 共享 `_moveGen`、`_ctrlLease`、11 秒预算和一堆事件监听。
4. **静态断言也要跟着搬**：套件里有"`core.mjs` 里有没有 `const SOFT_ROOF = `"这种**按文件找代码**的断言，代码一搬它就红。
5. **先 grep 谁在 import 这个名字**：被别的模块 import 就必须 re-export，否则报的是**加载期**的
   `does not provide an export named '…'`（整个扩展起不来），不是运行期。
6. **grep 要 grep 整个仓库**（`tools\` 与 `*.md` 都算），不只看 import —— 有一批断言是"按名字找代码"的。
7. **搬家脚本别手写"要加 `export` 的白名单"**：`node --check` 只查语法不查导出，漏一个要等真 import 才报。
8. **新模块不许反向 `import` 回 `core.mjs`**（循环导入）⇒ 改成 core 注入 `setXxx()`。
9. **"模块加载时读一次"的环境变量搬进单例模块后必须改成现读**：`core.mjs` 每个连接会重新 import 一份，
   `src\log.mjs` 整个进程只加载一次 ⇒ `MC_LOG_MAX_BYTES`/`MC_LOG_KEEP` 要写成 `logLimits()` 现读。
   搬之前先问一句"**这个模块会被加载几次**"。
10. **搬"私有方法"比搬"纯函数"多两件事**：签名要多一个 `b`（`this.#heldText(b)` → `heldText(b)`，所有调用点都得改）；
    公开方法要在 core 留薄包装。"逐字等价"验证法失效（签名变了），改用**行为对照**。
11. **"grep 整个仓库"要连 `tools\check-*.mjs` 一起 grep**：47 个套件里大量是"读源码文本 → 正则匹配"
    的**静态断言**，代码一搬就在原地红着没人看。改完跑 `node tools\check-all.mjs --fast` 全绿才算搬完，
    别只看你改的那个套件。
12. **能并进已有模块就别新开**（依赖方向要天然是顺的）。
13. **搬常量/工具函数时先分清"哪部分是纯的、哪部分绑在实例上"**：纯的进模块，读 `this.xxx` 的留类里。
    判据：**"公开面不变"= "以前 `export` 过"**，不是"有没有人用"。
14. **一个名字在两个模块里表示两件事时顺手改名**（`#reachOf` → `blockReachOf`，与 `mc_craft.mjs` 那个"材料够不够做"的 `reachOf` 区分）；
    改名时**用脚本统计命中数**，命中 0 处就抛错。
15. **搬"公开方法"要给类留同名薄包装**（不是 re-export）：`heightmap (opts = {}) { return heightmapOf(this.requireBot(), opts) }`。
    验证用 **A/B 对照**（把 `git HEAD` 的 `core.mjs` 临时拷回 `src\`，跑完即删）。
16. **薄包装的参数形状要跟原来一模一样**：`scan ({…} = {})` 收对象、`entities (radius = 24, {…} = {})` 是位置参数 + 可选对象 ——
    调用方是**照签名**调的，签名一改就是静默改行为。
17. **实例状态不属于 `bot`：多给模块一个 `ctx` 参数**（`statusOf(b, ctx)`）。
    判据：**凡是被搬走的代码里出现 `this.xxx`，就问这个 xxx 是 bot 的还是插件的**。
18. **A/B 的假数据必须复刻真实数据的形状**，否则"等价"可能只是"两边都走了同一条死路"
    （`dig-speed.mjs` 第一版冒烟 82/0 全绿，但假 registry 把工具表写成了 `{900:2, 901:2}`，真实数据只有木工具）。
19. **搬"实例状态 + 收尾动作"混在一起的方法：模块只做动作，状态全走 `ctx`**
    （`cancelCollect(b, ctx)`，`ctx = { force, budgetMs, bumpGen, stopPathing, releaseControls, log }`）。
    薄包装里**保留字面 `this._moveGen++`**（`check-call-budget.mjs` 按字面数"抢占时把代号往前推 ≥2 处"）；
    收尾类动作一律 `try { … } catch {}` 包住每一步。
20. **有可变实例状态的层，第一参数直接收 `self`（不是 `ctx`）**。判据：**"要读"进 `ctx`，"要改"就直接收 `self`**。
21. **每搬一个模块都要跑 `node tools\scan-moved-assertions.mjs`**（顾问型，不判红）。
    它做两遍：① 按导出名找"提到这些名字且正则带实现细节"的断言；② 把断言的正则拿去它断言的文件里试，
    在 core 里找不到、却能在别的 `src/*.mjs` 找到的就报。
22. **一个 `ok()` 里塞两条正则时，扫描器可能只看到第一条**：要抠掉整行**所有** `.test(<ident>)` 再判，
    并把 `= `、`.方法(`、`??`、`||` 也算实现细节。教训：**两条正则都要单独看一眼**。
23. **`lines.splice(n, …)` 是 0-based，锚点自检用的是 1-based**；`split('\n')` 后每行带 `\r`，比对要 `.replace(/\r$/, '')`。
    `node --check` 不会报这类错（多一行孤立 `/**` 语法完全合法）。
24. **搬"要发包的动作"时模块只做动作，实例/库相关的全走 `ctx`**（`giveItem`/`clearInventory`/`tossItem`
    要 `ctx = { t, makeItem }`，模块**不 import 任何游戏库**）。
25. **搬"服务端不回执的动作"：把 `await` 留在模块里**，别把 promise 交回实例
    （容器看 `currentWindow`、门看 `getProperties()` 翻没翻）。
26. **混合行尾的文件不能按行号切**（既有 CRLF 又有孤立 LF ⇒ 从第一个孤立 LF 起整体错开）。
    自检：`(raw.match(/\r\n/g)||[]).length` 与 `raw.split('\n').length - 1` 对不上就是混合行尾。
    手术脚本要么**按内容定位**（`raw.indexOf(锚点)` + 括号配平），要么先统一了再切、搬完换回去。
27. **要回调一堆实例方法的层，第一参数收 `self`**。判据：**"只读几项"用 `ctx`，"要改"或"要回调"用 `self`**。
28. **模块够不着私有方法，就把它塞进 `ctx`**：`cancelCollect: (bb, o) => this.#cancelCollect(bb, o)`
    （私有名在模块外面不能用字符串取）。
29. **搬方法时 JSDoc 也要一起搬**（脚本删到哪儿，就把那儿的 JSDoc 写进新模块，或在 core 原位留一行指针）；
    **分节注释**（`/* ─── 世界观察器 ─── */`）同样跟着走。丢了注释不影响任何自动检查。
30. **薄包装和 import 撞名时 import 取别名**：`import { startObserver as startObserverImpl, … }`
    （类方法名不进词法作用域，能跑但读的人会以为是递归）。
31. **搬进"已经存在的模块"时，那个模块头注释里的"N 件事"也要改** —— 头注释是这个项目"这个模块负责什么"的索引。
32. **搬进已有模块时把新成员要用的兄弟依赖补进 import**，补之前先确认**不会成环**。
33. **新写的头注释里不许出现 `*/`**：写 `$DSH_HOME/profiles/*/vendor` 这种 glob 会提前关掉块注释，
    `node --check` 报的行号在注释中间很迷惑。用 `<profile>` 占位或反斜杠。
34. **A/B 两边抛同一个错也算"通过"** ⇒ 每条 A/B 都要配"真的走通了吗"的断言（输出非 `null`、`!ea && !eb`）。
35. **手术脚本的"不许残留 `this.`"自检要先把注释剥掉**：
    `const bare = s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')`
    —— 注释里的 `this.` 是踩坑说明，代码里的才是残留。
36. **改调用点的正则要连"尾参"一起改**（`await this.connect({...})` → `await connect(self, {...}, ctx)`）；
    自检里加一条"新调用点的参数个数对得上"。
37. **A/B 两边不能共用一份"状态会变"的假件**（假 bot 的 `entity.isInWater` 是时变的）；
    假件里带**时间 / 次数 / 状态**的字段，A/B 就不能共享 —— 新旧各造一份，B 要在 A 跑完之后再造。
38. **按签名找函数体时 `indexOf('{')` 会先撞上参数里的解构 `{`**
    （`async #walkPathfinder (target, { arrive = 1.6, … } = {}) {`）⇒ 先取第一个换行、再 `lastIndexOf('{', nl)`。
39. **手术脚本要"先全查、后写盘"**：所有锚点（要删的、要插的、import 的）先验完，最后才写文件。
    import 锚点**别按"单行 import"去猜**（movement 的 import 是多行的，锚点只取 `} from './movement.mjs'`）。
40. **A/B 全绿不等于那条路走到了**：写完用例回头问一句"这条分支的**前置条件**是什么"，照着摆世界。
41. **A/B 全绿 + 调用序列一致，也可能是同一份用例把两边带到同一条错路上**
    （`dig` 的 40 条断言全绿，四条出口全走的是"够不着"那条）⇒ 每条用例配一条"这条路真的走到了"的断言，
    并把**输出打出来看一眼**。
42. **带定时器的状态层：状态字段留在实例，读写逻辑搬进模块**（`holdControl`/`#releaseControls` 只搬读写，
    租约表 `_ctrlLease` 留 `core.mjs`）。
43. **"抠旧实现"要连它依赖的模块级 import 一起搬**：判据是"方法体 + 它引用的**所有**模块级标识符
    （函数、常量、类）"，不只是 import 名。
44. **模块里出现 `mineflayer` / `prismarine` 字样（哪怕只是 `import`）就该停下来看看**。
45. 自写冒烟的 `t` 兜底写成 `ctx.t ?? ((p) => p)`，不必每次造一个真的闸门。
46. 拆分收尾用 `check-module-load.mjs` 体检（30/0：拆出去的模块全都 import 得进来）。

## 文档索引

| 文档 | 给谁看 | 讲什么 |
| --- | --- | --- |
| 本文件 | 开发者 | 接到 MCP 客户端、跑自检、配置速查、工具速查、唤醒机制、迁移、架构速览、拆分模块的规矩 |
| [插件说明.md](插件说明.md) | **模型 / 维护者** | 工具与机制细节：34 个工具的设计取舍、提示词怎么进去、唤醒链路、账户与凭据、安全边界、已知限制、English |
| [踩坑档案.md](踩坑档案.md) | 开发者 | 119 个真 bug 的**现象 → 根因 → 证据 → 修法 → 回归**（"为什么现在这么写"） |
| [PATHFINDER.md](PATHFINDER.md) | 开发者 | 寻路/防卡住专题：为什么用现成的、装在哪、打过的补丁、上游复核、已知缺口 |
| [CHANGELOG.md](CHANGELOG.md) | 开发者 | 按日期的改动流水（含拆 core.mjs 的 43 刀 + 分叉成 MCP server 那一版） |
