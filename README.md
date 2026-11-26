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
| `web/` | 前端（原生 JS，无构建）：对话 / 任务 / 设备 / 用户权限 四个页面，手机可用；`render.js` 是网页版和离线备份共用的渲染函数 |
| `relay/export.js`、`relay/zip.js` | 对话备份：边生成边下载的 zip（零依赖） |
| `mac/install-mac.sh` | 在 Mac 上装成开机自启服务（launchd） |
| `scripts/start-local.js` | 本地联调：一条命令同时起中继 + agent |
| `scripts/mock-cli.js` | 假 CLI，不花额度测试整条链路 |
| `dev/smoke-test.mjs` | 冒烟测试（47 项，只用假 CLI） |
| `docs/DEVELOPMENT.md` | 开发交接：代码地图、已知问题、下一步计划、Mac 验证清单 |
| `data/` | 运行后生成：`config.json`（agent token）、`users.json`、`db.json`、`sessions.json`（登录会话）、`files/`（产出与附件）、`INITIAL_ADMIN.txt` |

## 一、本机先跑起来测试（Windows / Mac 都行）

```
npm run local        # 等同于 node scripts/start-local.js 5227
```

打开 http://localhost:5227 ，管理员账号 `admin`，初始密码在 `data/INITIAL_ADMIN.txt`。
本地联调会自动生成 `agent/agent.local.json`，带一个「模拟 CLI」和两个测试目录（`test-workspaces/sandbox` 可写、`test-workspaces/readonly` 只读）。
另开一个终端跑 `node dev/smoke-test.mjs` 可以自动检查 47 项功能，不花额度。

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
   - `workspaces`：**允许 AI 碰的目录**，每个目录可以限制最高权限（`read` / `edit` / `full`）；加 `"isolate": true` 后每个对话在 `<目录>/<用户名>/<对话id>/` 里运行，同一目录的多个对话可以同时跑
   - `maxConcurrent`：这台设备最多同时跑几个任务（默认 3）
   - `confine`：文件夹限制，macOS 上默认开启；设成 `false` 关闭。CLI 装在不常见的位置、启动报 `EPERM` 时，把它的安装目录加进 `confineExtraRead`（数组）
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

浏览器只访问中继（网页和接口同一个地址），Mac 是主动连出去领任务的，所以 Mac 不需要公网 IP，也不用开端口。

中继可用的环境变量：

| 变量 | 作用 |
|---|---|
| `HOST` / `PORT` | 监听地址和端口；云上要设 `HOST=0.0.0.0` |
| `RELAY_DATA` | 数据目录（默认 `data/`），挂了持久磁盘就指过去 |
| `TRUST_PROXY` | 前面有几层反向代理（Render 是 1）。不设时完全不看 `X-Forwarded-For`，防止伪造 IP 绕过登录限流 |
| `AGENT_TOKEN` | 固定 agent token（至少 24 位）；不设则自动生成并存在 `data/config.json` |
| `ADMIN_PASSWORD` | 管理员 `admin` 的密码（至少 8 位），每次启动都以它为准；不设则第一次启动时随机生成并写进 `data/INITIAL_ADMIN.txt` |
| `GUEST1_PASSWORD` … `GUEST5_PASSWORD` | 最多 5 个访客账号的密码（至少 8 位），设了哪个就有哪个账号，删掉就停用；改了密码，已登录的设备会被踢下线 |
| `GUEST1_NAME` … `GUEST5_NAME` | 可选，访客的用户名（默认 `guest1` … `guest5`，可以用中文） |
| `GUEST_MAX_LEVEL` / `GUEST_DAILY_LIMIT` | 可选，访客新建时的最高权限（默认 `edit` 可改文件）和每日条数（默认 50） |

#### 部署到 Render（仓库里有 `render.yaml`）

1. Render 控制台 → **New → Blueprint**，连上 GitHub 仓库，选要部署的分支。
2. 按 `render.yaml` 创建：新加坡机房、免费版、`node relay/server.js`。创建时会让你填 `ADMIN_PASSWORD`；`AGENT_TOKEN` 自动生成，在服务的 Environment 页能看到。
3. 部署完成后打开 `https://<服务名>.onrender.com`，用 `admin` + 你填的密码登录。
4. Mac 上 `agent/agent.config.json` 的 `relayUrl` 改成这个网址，`token` 填 `AGENT_TOKEN`，然后 `npm run agent`（或 `bash mac/install-mac.sh agent` 装成开机自启）。

加访客账号：服务的 **Environment** 页点 Add，加 `GUEST1_PASSWORD`（需要的话再加 `GUEST1_NAME`），保存后服务会自动重启。环境变量管理的账号在网页上改不了密码、也删不掉，「用户权限」页会标出「环境变量」。

免费版的限制：磁盘不持久，**每次重启 / 重新部署后对话、上传的文件和你新建的账号都会清空**（管理员密码和 agent token 因为来自环境变量，保持不变，Mac 会自动重连）；一段时间没有请求会休眠，唤醒要几十秒（agent 一直在轮询，通常能保持唤醒）。长期使用请换付费实例并挂持久磁盘，把 `RELAY_DATA` 指到磁盘路径。

## 三、权限模型

**用户层面**（网页「用户权限」页，管理员设置）：
- 可用的 CLI、可用的设备、可用的工作目录
- 最高权限级别：只读问答 / 可改文件 / 完全放开
- 每日次数上限；可停用账号
- 管理员能看所有人的任务；普通用户只能看自己的

**管理员和其他账号看到的不一样**：只有管理员有「任务 / 设备 / 用户权限」页、右上角的额度圆环、回答里的工具步骤（含 Mac 上的路径和命令）、技术提示和耗时费用；其他账号只看到对话、模型选择、回答正文和产出文件（只能用一种 CLI 时连 CLI 选择都不显示）。中继发给非管理员的设备信息里也去掉了额度、电脑名等。

**设备层面**（Mac 上的 `agent.config.json`，网页改不了）：
- 只有配置里列出的 `workspaces` 能被使用，网页只传目录**名字**，不能传任意路径
- 每个目录的 `maxLevel` 是硬上限，即使管理员也越不过去

网页上新建对话时不再选目录和权限：自动用设备上开了 `isolate` 的目录，权限给到这个用户能用的最高一级；实际能碰到什么，由下面的文件夹限制兜住。

**文件夹限制**（macOS，默认开启）：Claude Code 自己的权限设置拦不住读取（Read 工具能读本机任何文件），所以**所有级别**（包括「完全放开」）的 CLI 都用系统自带的 `sandbox-exec` 启动，由内核拒绝越界读写：
- 只能读写**这个用户自己的文件夹**：开了 `isolate` 的目录是 `<目录>/<用户名>/`（他所有对话都在里面），否则是目录本身
- 读不到：其他用户的文件夹、其他工作目录、本项目目录（含 `data/` 里的密码哈希和 agent token）、家目录下的其他文件、其他对话在 `~/.claude/projects/` 里的会话记录
- 防止借别的程序绕出沙盒：禁止执行 `open`、`osascript`、`launchctl`、`crontab`、`at`、`shortcuts`、`automator`、`defaults`，禁止发送 AppleEvents、写偏好设置、连接 LaunchServices
- 可以联网（下载、调用网页接口都正常）
- 为了让 Claude Code 能跑，仍然放开：它自己的程序、`~/.claude.json`（含登录账号邮箱和项目列表）、`~/.claude/settings.json`、缓存目录、`~/Library/Keychains`（登录凭证，加密存储）
- ⚠️ 残留风险：Claude Code 用系统的 `security` 命令读登录凭证，所以这个命令不能禁。「完全放开」级别下 Claude 能执行任意命令，因此能读到它自己的登录凭证，以及钥匙串里允许 `security` 直接读取的条目。给不完全信任的人开账号时，在「用户权限」里把他的最高权限设成「可改文件」（网页会自动按这个上限创建对话）
- Codex 不能再套一层沙盒：开启限制时，Codex 的「完全放开」会降成它自带的 workspace-write 沙盒（只能改对话文件夹，但读取不受限制）
- 受限时用不了你装在 `~/.claude/` 下的技能和插件

**三档权限对应的 CLI 参数**：

| 级别 | Claude Code | Codex |
|---|---|---|
| 只读问答 `read` | `--permission-mode default`（非交互下改文件/执行命令会被自动拒绝） | `sandbox_mode="read-only"` |
| 可改文件 `edit` | `--permission-mode acceptEdits` | `sandbox_mode="workspace-write"` |
| 完全放开 `full` | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` |

## 四、对话与上下文

每个对话绑定 设备 + CLI + 工作目录 + 权限级别。第一条消息会新开 CLI 会话，记下会话 ID；后续消息自动用 `claude --resume <id>` / `codex exec resume <id>` 接续上下文。
同一对话的消息严格按顺序执行（前一条没完，后一条排队）。产出文件靠「任务前后对比目录」收集，所以：
- 开了 `isolate` 的目录：每个对话有自己的子文件夹，多个对话可以同时跑；
- 没开的目录（比如真实项目目录，大家要改同一份代码）：同一时间只跑一个任务，其余排队，网页上会提示在等什么；
- 不同目录之间可以并行。总并发数由 agent 的 `maxConcurrent` 决定。

已有对话所在的目录改成 `isolate` 后，它的工作目录会变成新的子文件夹；Claude Code 的会话按目录保存，所以这类对话的下一条消息会自动开新会话。
对话设置里可以「清空上下文」，下一条消息开新会话。

### 我的文件

对话列表底部的 **📁 我的文件**：浏览、下载 Mac 上自己的文件夹（`<目录>/<用户名>/`，每个对话一个子文件夹，显示成对话标题），可以在线打开图片、网页、PDF、文本，单个文件最大 25MB。普通用户只能看自己的文件夹，管理员能看所有人的；路径里的 `..`、隐藏文件、指到外面的快捷方式都会被拒绝。需要 Mac 在线。

### 会话 ID 和用量

点击对话顶部的 **ID** 即可复制。在「＋ 新对话」里输入 `id:c_0123456789ab`（换成实际 ID）并发送，即可打开原对话和历史消息。也可以输入 `id:c_0123456789ab 继续上次的修改`，或把正文写在下一行。只有正文会提交给 CLI，沿用原对话的设备、目录和上下文。

可以使用网页对话 ID，或当前绑定的 CLI 会话 UUID。Render 数据清空后，在线的 Mac agent 可以用本地索引恢复原 ID、工作目录和 CLI 会话。网页从恢复时开始显示新消息。旧聊天气泡、附件下载记录仍需从之前导出的 zip 查看。

- 更新 Render **和 Mac 上的 agent**。Mac 每次收到 CLI 的会话 ID，就把映射写到配置旁边的 `<配置文件>.sessions.json`。请保留此文件、原工作目录、CLI 自己的历史和固定的 `AGENT_TOKEN`。
- 环境变量管理员可跨部署恢复。环境变量访客默认用同一访客档位和密码识别租期，每次交给新租客请换新密码。也可设置 `GUEST1_RENTAL_ID`（其余档位同理），续租沿用，换人换新值。网页手工创建的账号按内部用户 ID 识别，数据库清空后重建同名账号不能领取旧会话。
- 升级前的 Claude 对话：环境变量管理员可输入原网页 ID，在自己原来的独立工作目录中查找本地 Claude 记录，有多个匹配时选一次。旧记录没有权限设置，恢复时最高使用「可改文件」，并受当前账号和工作区的权限限制。旧版访客可以在原中继记录仍在时继续聊一轮，建立新索引。工作目录、CLI 历史或归属无法核实时，不会自动另开会话来代替旧会话。
- 清空上下文或删除已索引对话时，Mac 需在线以同步作废记录。

每条回答下面显示这次用的**模型和 token 总数**（输入含缓存 + 输出）。

### 额度使用情况

右上角的**额度圆环**显示用得最多的那个额度（5 小时和本周取较大的），颜色随用量变化：蓝（< 40%）→ 绿（40～70%）→ 橙（70～90%）→ 红（≥ 90%），网页开着时每 5 分钟自动查一次。点开圆环，或在对话里发 **/usage**（不会发给 AI），显示 Claude 订阅的 **5 小时额度**、**本周额度**用了多少、什么时候恢复，和 Claude Code 里的 `/usage` 一样。数据来自 Mac：点开时让 agent 运行一次 `claude -p /usage`（不调用模型、不花额度）；平时跑任务时 Claude Code 输出的额度信息也会顺带更新。这是整个 Claude 账号的用量，在 Mac 上直接用 Claude 也算在里面。

### 对话备份

对话标题右边的 **⬇** 下载这个对话的备份，对话列表底部的 **⬇ 备份全部对话** 下载所有对话（管理员访问 `/api/export?all=1` 可导出所有人的）。下载的是一个 zip：

- 解压后双击 `index.html`，用浏览器离线查看：样子和网页版一样，不用联网、不用登录；回答里的图片、链接和产出文件卡片点开就是 zip 里的文件
- `c01/files/`：每个产出文件的最终版本，保持 AI 生成时的目录结构（AI 做的网页可以直接双击打开）；`c01/history/`：被后面的消息改掉的旧版本；`c01/attachments/`：上传的附件
- `data.json`：原始数据

Render 免费版重启 / 重新部署会清空对话记录，重要的对话记得先备份。

备份 zip 适合在电脑上看：手机和平板解压后打开 index.html 时脚本不运行（iOS 文件 App 只做静态预览），对话显示不出来。

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
