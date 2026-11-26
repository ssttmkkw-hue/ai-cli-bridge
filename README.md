# AI 遥控台：用网页调用 Mac 上的 AI CLI

在手机或任意浏览器里打开一个网页，就能让闲置的 Mac Air 上的 **Claude Code / Codex CLI** 干活。用的是 Mac 上已经登录的账号额度，不需要 API Key。

```
手机 / 浏览器
     │  HTTPS（Tailscale 或 Cloudflare Tunnel）
     ▼
中继 relay/server.js  ← 网页平台：聊天窗口 / 任务管理 / 用户权限
     │  任务队列 + 实时状态同步（SSE 推给网页，长轮询派给 agent）
     ▼
执行端 agent/agent.js（跑在 Mac Air 上）
     │  spawn
     ▼
claude -p … / codex exec …   （Mac 上已登录的 CLI）
```

架构图里「Firebase / Supabase」那一层由 `relay/server.js` 自己承担（JSON 文件存储），**零依赖**，只要 Node 18+。
agent 是**主动连出去**领任务的，所以 Mac 放在家里路由器后面也不用开端口、不用公网 IP。

## 目录

| 路径 | 作用 |
|---|---|
| `relay/server.js` | 中继：网页、登录、用户权限、对话与任务队列、SSE 推送、agent 接口 |
| `agent/agent.js` | 执行端：找 CLI、领任务、调用 CLI、把流式输出解析成统一事件回传 |
| `agent/agent.config.example.json` | agent 配置模板（设备名、工作目录、各目录最高权限） |
| `web/` | 前端（原生 JS，无构建）：对话 / 任务 / 设备 / 用户权限 四个页面，手机可用 |
| `mac/install-mac.sh` | 在 Mac 上装成开机自启服务（launchd） |
| `scripts/start-local.js` | 本地联调：一条命令同时起中继 + agent |
| `scripts/mock-cli.js` | 假 CLI，不花额度测试整条链路 |
| `dev/smoke-test.mjs` | 冒烟测试（21 项，只用假 CLI） |
| `docs/DEVELOPMENT.md` | 开发交接：代码地图、已知问题、下一步计划、Mac 验证清单 |
| `data/` | 运行后生成：`config.json`（agent token）、`users.json`、`db.json`、`sessions.json`（登录会话）、`files/`（产出与附件）、`INITIAL_ADMIN.txt` |

## 一、本机先跑起来测试（Windows / Mac 都行）

```
npm run local        # 等同于 node scripts/start-local.js 5227
```

打开 http://localhost:5227 ，管理员账号 `admin`，初始密码在 `data/INITIAL_ADMIN.txt`。
本地联调会自动生成 `agent/agent.local.json`，带一个「模拟 CLI」和两个测试目录（`test-workspaces/sandbox` 可写、`test-workspaces/readonly` 只读）。
另开一个终端跑 `node dev/smoke-test.mjs` 可以自动检查 21 项功能，不花额度。

## 二、部署到 Mac Air

1. 在 Mac 上克隆仓库，例如 `git clone <仓库地址> ~/ai-bridge`。`data/`、`agent/agent.config.json` 这些运行时文件不在仓库里，各台机器自己生成。
2. 装 Node：`brew install node`
3. 在 Mac 终端里把 CLI 登录好（只需一次）：
   - Claude Code：`claude` 进去按提示登录（订阅账号即可）
   - Codex：`codex login`
4. 生成并修改 agent 配置：
   ```
   cd ~/ai-bridge
   bash mac/install-mac.sh both      # 第一次运行只会生成 agent/agent.config.json
   ```
   编辑 `agent/agent.config.json`：
   - `name`：设备名，例如 `mac-air`
   - `workspaces`：**允许 AI 碰的目录**，每个目录可以限制最高权限（`read` / `edit` / `full`）
   - `token`：中继和 agent 在同一台 Mac 上时保持原样即可，会自动读取
5. 再运行一次 `bash mac/install-mac.sh both`，中继和 agent 都会开机自启，日志在 `logs/`。
6. 防止睡眠掉线：`sudo pmset -c sleep 0 disablesleep 1`（插电时不睡）。合盖也要跑的话，建议外接电源并在「电池」设置里关掉自动睡眠。

### 从外面（手机）访问

中继默认只监听 `127.0.0.1`，**不要直接把端口暴露到公网**（能调 CLI = 能在你 Mac 上执行命令）。推荐两种方式，任选其一：

- **Tailscale（最省事、最安全）**：Mac 和手机都装 Tailscale 并登录同一账号，然后在 Mac 上：
  ```
  tailscale serve --bg 5227
  ```
  手机打开 `https://<mac名>.<你的tailnet>.ts.net` 即可，只有你 tailnet 里的设备能访问。
- **Cloudflare Tunnel**：要给别人用、或者需要一个公开域名时用。
  ```
  brew install cloudflared
  cloudflared tunnel --url http://127.0.0.1:5227
  ```
  正式使用请配置命名隧道 + 自己的域名，可以再在 Cloudflare Access 里加一道邮箱验证。

### 中继放云上、agent 放 Mac（可选）

想让中继 7×24 在线（Mac 关机时网页仍能打开、消息会排队），可以把 `relay/` + `web/` 部署到任意能跑 Node 的服务器（`HOST=0.0.0.0 PORT=5227 node relay/server.js`，前面套 HTTPS 反代）。
Mac 上只跑 agent：`bash mac/install-mac.sh agent`，`agent.config.json` 里 `relayUrl` 填中继地址，`token` 填网页「设备」页显示的 token。

## 三、权限模型

**用户层面**（网页「用户权限」页，管理员设置）：
- 可用的 CLI、可用的设备、可用的工作目录
- 最高权限级别：只读问答 / 可改文件 / 完全放开
- 每日次数上限；可停用账号
- 管理员能看所有人的任务；普通用户只能看自己的

**设备层面**（Mac 上的 `agent.config.json`，网页改不了）：
- 只有配置里列出的 `workspaces` 能被使用，网页只传目录**名字**，不能传任意路径
- 每个目录的 `maxLevel` 是硬上限，即使管理员也越不过去

**三档权限对应的 CLI 参数**：

| 级别 | Claude Code | Codex |
|---|---|---|
| 只读问答 `read` | `--permission-mode default`（非交互下改文件/执行命令会被自动拒绝） | `sandbox_mode="read-only"` |
| 可改文件 `edit` | `--permission-mode acceptEdits` | `sandbox_mode="workspace-write"` |
| 完全放开 `full` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

## 四、对话与上下文

每个对话绑定 设备 + CLI + 工作目录 + 权限级别。第一条消息会新开 CLI 会话，记下会话 ID；后续消息自动用 `claude --resume <id>` / `codex exec resume <id>` 接续上下文。
同一对话的消息严格按顺序执行（前一条没完，后一条排队），不同对话可以并行（并发数由 agent 的 `maxConcurrent` 决定）。
对话设置里可以「清空上下文」，下一条消息开新会话。

## 五、文件与图片

**AI 产出的文件（Mac → 网页）**
- 任务开始前，执行端给工作目录拍一张「快照」（文件列表 + 修改时间；小于 200KB 的文本文件连内容一起记下）。任务结束后再拍一张，对比出**新增 / 修改 / 删除**的文件。
- 新增和修改的文件会上传到中继（单个 ≤25MB，每次最多 30 个），网页上显示为「产出文件」卡片：
  - 图片直接显示；网页在隔离沙盒里预览；PDF、音视频用浏览器自带的预览和播放；代码和文本带行号显示；其他类型提供下载
  - 修改过的文本文件可以点「改动」查看红绿对比
- 回答里用 Markdown 引用的本地文件，例如 `![图](./chart.png)`、`[报告](out/report.pdf)`，即使这次没改动，也会上传并替换成可访问的地址，图片直接显示在回答里。
- 只会上传**工作目录里**的文件，外加 `extraOutputDirs`（默认 `~/.codex/generated_images`，可以在 agent 配置里改）。`../`、绝对路径之类指向别处的引用一律不传。
- 快照跳过 `.git`、`node_modules`、`.venv` 等目录；超过 2 万个文件时只检查前 2 万个。
- 同一个目录里如果有两个对话**同时**在跑，彼此的改动会混在一起显示。需要的话，给不同对话用不同的工作目录。

**用户上传的附件（网页 → Mac）**
- 聊天框左边的 📎，或者直接粘贴截图、把文件拖进对话区。单个 ≤25MB，一次最多 10 个。
- 附件先存到中继，任务派发时由执行端下载到 `<工作目录>/.ai-bridge/uploads/<任务id>/`，再把路径写进提示词。
- 图片附件额外交给 CLI 直接看：Codex 用 `-i`，Claude 会自己读取文件。

**隔离与权限**
- 文件地址需要登录才能访问，只有能看到这个任务的人（发起人和管理员）能打开。
- HTML、SVG 等可执行内容带 `Content-Security-Policy: sandbox` 响应头，在不透明源里运行，读不到本站 cookie，也调不了 API。

## 六、安全清单

- 第一次登录后立刻改 admin 密码，删掉 `data/INITIAL_ADMIN.txt`
- agent token 等于「能在 Mac 上领任务」的凭证，泄露了就在「设备」页点「更换 token」
- 密码 scrypt 加盐存储；登录有失败限流；Cookie 为 HttpOnly + SameSite=Strict；写接口强制 JSON 防 CSRF
- 「完全放开」只给自己；给别人用时，建议只开「只读问答」+ 专门的沙盒目录
- Mac 上的 CLI 用的是你自己的订阅额度，给别人用前看清各家服务条款

## 七、已知限制 / 后续可做

- 存储是 JSON 文件，单机几个人用没问题；多人高频使用可以换 SQLite 或真的接 Supabase（中继的数据层集中在 `db` / `users` 两个对象里，替换成本不高）
- 产出文件和附件存在 `data/files/`，删除对话时一起清掉，目前没有自动过期清理
- Codex 的回答要整段写完才出现（`codex exec` 不逐字输出），以后可以换成常驻的 `codex app-server`
- CLI 自己的交互式确认（例如 Claude 问「要不要执行这条命令」）在非交互模式下不会弹出，统一由权限级别决定
