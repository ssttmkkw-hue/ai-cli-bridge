# 开发交接文档

给接手继续开发的人（或换台电脑的自己）看：现在做到哪了、代码怎么组织、怎么测、接下来做什么。
使用和部署说明见根目录 [README.md](../README.md)。

## 当前状态（2026-11-26）

- 在 Windows 上开发和测试，**还没在 Mac 上跑过**。下一步就是在 Mac Air 上走一遍完整流程（见文末清单）。
- Codex 在 Windows 上实测通过：真实调用、上下文续接、看图片附件、生成文件、停止、只读沙盒拦截。
- Claude Code 在 Windows 上**没测过真实调用**（这台机器上的独立 `claude.exe` 没登录），只测了「未登录」报错的展示。解析逻辑是按 `stream-json` 格式写的，需要在 Mac 上登录后验证。
- `dev/smoke-test.mjs` 用模拟 CLI 覆盖 37 项，全部通过。

## 架构

```
浏览器 ──HTTP──▶ 中继 relay/server.js ◀──长轮询 + POST── 执行端 agent/agent.js ──spawn──▶ claude / codex
   ▲                    │
   └──── SSE 推送 ───────┘
```

- 三个部分都是零依赖 Node（>=18），前端是原生 JS，无构建步骤。
- 执行端**主动连**中继，所以执行端可以躲在 NAT 后面。
- 中继单进程、JSON 文件存储，定位是「一个人 + 几个朋友」的规模。

## 代码地图

### relay/server.js（中继）
| 部分 | 说明 |
|---|---|
| 存储 | `config.json`（agent token）、`users.json`、`db.json`（convs / tasks / uploads）、`sessions.json`（登录会话，只存 token 的 sha256）、`files/<id>`（文件本体）。`saveSoon()` 每秒落盘一次 |
| 用户与权限 | scrypt 密码；`perms = { clis, agents, workspaces, maxLevel, dailyLimit }`，`'*'` 表示全部；`checkRunPerms()` 是建对话 / 发消息时的总闸 |
| 派发 | `pickTasksFor(agent, free)`：同一对话串行（保证 resume 顺序）；同一设备的同一工作目录也串行（产出靠目录前后对比收集，并发会串到别的任务甚至别的用户），`isolate` 的目录除外（每个对话独立子文件夹）；因目录排队的任务带 `waitingFor: 'workspace'`；派发内容带 `convId`、`username` 供 agent 算子文件夹；派出时带上 `conv.sessionId` 作为 `resumeSessionId`；`wakeAgent()` 立即返回挂着的长轮询 |
| 订阅额度 | `quotaFromRateLimit()` 解析任务输出里的 `rate_limit_event.unifiedWindows`（`five_hour`、`seven_day`…，`utilization` 0~1，`resetsAt` 秒）；`runProbe()` 运行 `claude -p --output-format json`、stdin 写 `/usage`（`<synthetic>` 模型，不花额度，不进文件夹沙盒，因为要读本机所有会话的统计），`quotaFromUsageText()` 解析 `Current session: 37% used · resets Nov 26 at 11:09pm (Asia/Tokyo)` 这种行，`zonedToEpoch()` 按里面的时区换成时间戳 |
| 停止 | `cancelRequested` + `cancelSentAt`（指令只发一次，10 秒后补发一次）；30 秒还没停，中继直接判为已取消 |
| 掉线 | 执行端 45 秒没轮询即视为离线；已派发的任务 90 秒没有回音就判失败；中继重启时正在跑的任务判失败 |
| 文件 | `POST /api/agent/files`（agent 上传产出）、`GET /api/agent/files/:id`（agent 取附件）、`POST /api/uploads`（用户上传，需要 `X-Upload: 1` 头防 CSRF）、`GET /api/files/:id`（只有能看到这个任务的人能访问；HTML/SVG 带 `CSP: sandbox`） |
| 推送 | `/api/stream` SSE，事件 `task`（任务摘要，不含 events）、`chunk`（新增输出）、`agents`（设备列表） |
| 订阅额度 | agent 每个记录挂 `quota`（最近一次）和 `probes`（待执行的即时查询）。`POST /api/quota` → `requestProbe()` 把 `{kind:"usage"}` 塞进长轮询的返回值（`probes`），最多等 45 秒；agent 跑完 `POST /api/agent/quota` 带 `probeId` 回来。agent 平时在任务输出里看到 `rate_limit_event` 也会上报（20 秒最多一次）。`sanitizeQuota()` 只留 `key/label/percent/resetsAt/resetsText/status` |
| 备份导出 | `GET /api/convs/:id/export`、`GET /api/export`（`?all=1` 管理员导出所有人）→ `relay/export.js` 的 `exportConvs()`：先 `plan()` 决定每个文件在 zip 里的位置（同一任务同一路径只打包一份；回答里的「引用」不算新版本；最终版放 `files/`，被后面改掉的放 `history/t<N>/`），再用 `relay/zip.js` 的 `ZipWriter` 边读边写进响应（一次只读一个文件；文件名 UTF-8 标记 + 0x7075 扩展字段；我们自己起的目录名只用英文）。`index.html` 把 `style.css`、`render.js`、`export-viewer.js` 和数据内嵌进去 |

### agent/agent.js（执行端）
| 部分 | 说明 |
|---|---|
| 找 CLI | `findBin()`：PATH → 常见安装位置（Mac：`~/.local/bin`、`/opt/homebrew/bin`…；Windows：Claude 桌面 App 自带的、Codex 安装目录）；`versionOf()` 只确认程序能跑，**不确认是否已登录** |
| 子进程环境 | `childEnv()` 去掉宿主 Claude Code 注入的 `CLAUDE_CODE_*` 等变量；Mac 上补全 PATH（launchd 启动时 PATH 很短） |
| 命令行 | `buildCommand()`：权限三档 → CLI 参数；prompt 一律走 stdin；Codex 图片附件用 `-i` |
| 解析输出 | `makeParser()` 把两家的 JSON 行统一成事件 `text / tool / tool_out / think / info / err`，并记下会话 ID |
| 文件 | `snapshot()` 任务前后各拍一次（跳过 `.git`、`node_modules` 等，上限 2 万个文件，200KB 以下的文本连内容一起记）→ `diffSnapshots()` → `lineDiff()`（LCS）→ 上传；回答里 Markdown 引用的本地文件通过 `localLinks()` + `resolveLocal()` 找到，只允许工作目录内和 `extraOutputDirs` |
| 任务目录 | `taskDir()`：普通目录就是它本身；`isolate: true` 的目录是 `<目录>/<用户名>/<对话id>`（中继派发时带上 `convId`、`username`）。任务里的附件、快照、产出、`cwd` 都用这个目录（`ews`）。目录刚创建且带着旧会话 ID 时丢掉续接（Claude 会话按目录保存） |
| 文件夹限制 | `CONFINE`（macOS + `cfg.confine !== false`）时，所有级别的 claude 和 mock 都用 `/usr/bin/sandbox-exec -p <sandboxProfile()>` 启动。规则顺序：允许一切 → 拒绝家目录、所有工作目录、项目目录 → 放开用户文件夹、本对话的 `~/.claude/projects/<编码后的cwd>`、`~/.claude.json*`、缓存 → 只读放开钥匙串、`settings.json`、CLI 自身（`confineReadPaths()`）→ 拒绝执行 `SANDBOX_DENY_EXEC` 里的程序、`appleevent-send`、`user-preference-write`、LaunchServices 的 mach 服务（这些都能让沙盒外的进程替它干活）。所有放开路径的上级目录允许 `file-read-metadata`（程序会逐级 lstat，被拒会当成异常）；mock 额外放开各级 `package.json`（Node 判断模块类型）。Codex 不能套：`full` 降成 `edit`（它自带的 workspace-write） |
| 提示分级 | 开发用的提示（模型和目录、文件夹限制范围）带 `dev: true`，聊天里不显示，「任务」详情里显示（`eventsHTML(..., showDev)`） |
| 附件 | `prepareInputs()` 下载到 `<任务目录>/.ai-bridge/uploads/<任务id>/`，把相对路径追加到 prompt |
| 停止 | `job.cancel()` 是幂等的；`killTree()`：Windows 用 `taskkill /T /F`，Mac 结束整个进程组；进程退出但 `close` 迟迟不来时有兜底 |

### web/（前端）
- `render.js`：网页版和离线备份查看页共用的渲染函数（`md`、`eventsHTML`、`outputsHTML`、`inputsHTML`、`diffHTML`…）。`fileUrl` 用 `let` 声明，离线页把它换成 zip 里的相对路径；`isDevInfo()` 认出开发用的提示（新记录 `dev: true`，旧记录按内容）。
- `export-viewer.js`：离线备份查看页（备份 zip 里的 index.html）。
- 状态都在全局 `S` 里；`render()` 画外框，`renderView()` 画当前页。
- 新对话不弹窗：没选中对话时，聊天区顶部是 `renderNewChat()`（设备状态 + CLI / 模型单选按钮，`S.draft` 记当前选择），发第一条消息（或先加附件）时 `ensureConv()` 才创建对话；目录取设备上第一个 `isolate` 目录，权限取 `allowedLevels()` 的最高一级。Claude 的 3 个模型写死在 `CLAUDE_MODELS`，Codex 的取 agent 配置 `clis.codex.models` 前 3 个。手机上一打开先展开历史列表。
- 流式输出只重画对应的那一条回答（`renderTurn`），不动输入框。
- `md()` 是自己写的极简 Markdown 渲染（先转义再替换，安全）；`linkMap` 把回答里的本地路径换成 `/api/files/<id>`。
- 文件卡片、预览、diff：`outputsHTML / previewFile / diffHTML`。

## 统一事件格式（执行端 → 中继 → 浏览器）

```js
{ k: 'text', d: '正文增量' }
{ k: 'tool', name: 'shell', d: 'ls -la' }
{ k: 'tool_out', d: '输出片段', err: false }
{ k: 'think', d: '推理摘要' }        // 目前只有 Codex 有
{ k: 'info', d: '提示' }
{ k: 'err', d: '错误' }
```

## 怎么测

```bash
npm run local            # 起中继 + 本机执行端（自动生成 agent/agent.local.json，带模拟 CLI）
node dev/smoke-test.mjs  # 另开终端，37 项冒烟测试，不花额度
npm run check            # 只做语法检查
```

- 模拟 CLI 是 `scripts/mock-cli.js`，输出格式和 `codex exec --json` 一样。prompt 里带「slow / 慢」会跑 10 秒（方便测停止），带「文件 / file」会生成 `chart.svg`、`report.html` 并修改 `notes.md`，带「fail / 报错」会失败。
- 真实 CLI 手动测：网页上新建对话选 Claude / Codex。
- 预览端口默认 5227；管理员初始密码在 `data/INITIAL_ADMIN.txt`（Mac 上第一次启动会重新生成）。

## 已知问题和坑

- **Codex 回答不逐字输出**：`codex exec --json` 只在整段写完时给出 `agent_message`。要逐字输出需要换成 `codex app-server`。
- **每条消息都重启 CLI**：会慢几秒，并且要重新读一遍历史。
- **CLI 是否「可用」只看能不能运行**：没登录的 CLI 也显示可用，发消息时才报错。
- **内置预览面板（Claude 桌面 App）会拦截带 `sandbox` 属性的 iframe**，所以 HTML 预览改由服务端的 `CSP: sandbox` 响应头负责隔离，iframe 上不再加这个属性。普通浏览器两种写法都行。
- **文件没有自动过期**：`data/files/` 只在删除对话时清理。
- **Claude Code 的 `--permission-mode default` 不限制读取范围**：Read 工具能读工作目录以外的文件，所以靠 macOS 的 `sandbox-exec` 做文件夹限制（见上面「文件夹限制」）。Windows / Linux 上没有这层限制；Codex 和「完全放开」级别也没有。
- **`sandbox-exec` 被苹果标为过时**，但 macOS 15 上仍可用；如果哪天被移除，agent 启动日志会显示「文件夹限制：关」。

## 接下来要做的（按优先级）

1. **在 Mac 上验证**（见下一节清单），特别是 Claude Code 的 `stream-json` 解析和续接。
2. **显示订阅额度**
   - Codex：会话记录 `~/.codex/sessions/YYYY/MM/DD/rollout-*-<thread_id>.jsonl` 里的 `token_count` 事件带有 `rate_limits`（`primary` 是 5 小时窗口、`secondary` 是每周窗口，各有 `used_percent` 和 `resets_at`）。已在 Windows 上确认存在。
   - Claude Code：`stream-json` 输出里有 `type: "rate_limit_event"`，`rate_limit_info` 里有 `status / resetsAt / rateLimitType / utilization`。只在程序代码里看到过，没实际跑出来过，需要在 Mac 上确认什么时候会出现。
   - 做法：执行端每次任务结束后取额度 → 发给中继 → 「设备」页显示进度条和重置时间，对话顶部加提示。
3. **在网页上批准操作**：Claude Code 的 `--permission-prompt-tool` 可以把「允许吗？」交给一个 MCP 工具处理，把它接到网页上做成「允许 / 拒绝」按钮。需要先确认它在 `-p` 模式下的行为。
4. **常驻进程**：Claude 用 `--input-format stream-json`，Codex 用 `app-server`。好处是能中途插话、Codex 能逐字输出、省掉每次启动。
5. **每条任务自动存档、可撤销**：任务前给工作目录存快照（比如目录是 git 仓库就用 `git stash create` 或单独的分支），网页上加「撤销这次改动」。
6. 小改进：每条消息临时换模型、代码语法高亮、显示上下文用量、检测 CLI 是否已登录。

## Mac 上的验证清单

- [ ] `brew install node`，`node -v` ≥ 18
- [ ] `claude` 登录；`codex login`
- [ ] `npm run local` → 浏览器打开 http://localhost:5227 → 「设备」页 Claude 和 Codex 都显示版本号
- [ ] `node dev/smoke-test.mjs` 37 项全过
- [ ] Claude：发两条消息，第二条能接上第一条的上下文（问「我刚才说了什么」）
- [ ] Claude：「只读问答」下让它改文件，应被拒绝并提示「因权限级别被拒绝」
- [ ] Claude：「可改文件」下让它新建一个 HTML，网页上能预览
- [ ] Claude：跑一个长任务点停止，0.5 秒左右停下
- [ ] 观察 Claude 的 `stream-json` 里有没有 `rate_limit_event`（执行端可以临时打印未识别的事件类型）
- [ ] `bash mac/install-mac.sh both` 装成开机自启，重启 Mac 后仍能用
- [ ] 合上屏幕 / 长时间闲置后还在线（`pmset` 设置）
- [ ] `tailscale serve --bg 5227`，手机上能打开并发消息
