<p align="center">
  <img src="docs/images/hero.svg" alt="巡影 · Mediary Scout" width="600">
</p>

<p align="center">
  <b>巡影 · Mediary Scout（pickarm Fork）</b><br>
  <b>面向自部署 NAS / VPS 的 Agent 驱动多网盘媒体库：自动搜片追更 · 六盘已有库整理 · 消息机器人直转 · 开箱强制登录与 GHCR 自动构建</b>
</p>

<p align="center">
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml/badge.svg" alt="Auto Build Docker Image"></a>
  <a href="https://github.com/pickarm/mediary-scout/pkgs/container/mediary-scout"><img src="https://img.shields.io/badge/GHCR-ghcr.io%2Fpickarm%2Fmediary--scout-2ea44f?logo=github" alt="GHCR"></a>
  <a href="https://github.com/pickarm/mediary-scout/releases"><img src="https://img.shields.io/github/v/release/pickarm/mediary-scout?display_name=tag" alt="Fork Releases"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="#nas--vps-快速部署推荐">🚀 快速部署</a> ·
  <a href="#登录验证与访问安全">🔐 登录与安全</a> ·
  <a href="#github-actions-自动构建镜像ghcr">⚙️ 自动构建镜像</a> ·
  <a href="#支持网盘与功能矩阵">🗂️ 支持网盘</a> ·
  <a href="#消息机器人与直转入口">💬 消息机器人</a> ·
  <a href="#文档索引">📘 文档索引</a> ·
  <a href="README.en.md">English</a>
</p>

本项目基于开源上游 [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout) 持续维护与增强（已同步合入上游 `#379` 改进），完整保留电影/剧集/番剧自动搜源、Agent 选源转存、落盘回读核实、每日定时追更、多账号隔离及 Emby / Jellyfin / Plex / Webhook 刷新能力；在此基础上重点强化了 **默认强制登录安全门禁、全链路 GHCR 自动构建镜像、六盘已有库扫描整理、大规模分页与 Redis 缓存以及个人微信/飞书/Telegram 机器人直转入库**。

> **当前交付与验证边界说明**：
> - **镜像与代码门禁**：全量静态类型检查、ESLint、无库生产构建、单元测试与隔离 Linux/PostgreSQL/Redis 回归已闭环验证；推送 `main` 即通过 GitHub Actions 自动构建 `linux/amd64` 镜像、完成启动与登录门禁冒烟后发布至 GHCR。
> - **真实外部环境建议**：从已有旧库迁移前务必在独立 PostgreSQL 副本执行禁写盘演练；真实微信 / 飞书 / Telegram 消息收发与真实网盘写入建议先在独立测试目录验证。详见 [Fork 部署文档](docs/fork/DEPLOYMENT.md) 与 [迁移说明](docs/fork/MIGRATION.md)。

![巡影：搜片 → 点获取 → agent 自动搜索、转存、验证落进你的网盘](docs/images/demo.gif)

---

## 核心能力对比（上游 + Fork 增强）

| 模块 | 上游基础能力 | pickarm Fork 新增与增强 |
|---|---|---|
| **默认强制登录与安全** | 默认无登录拦截（仅远程经 Cloudflare Tunnel 才拦截），多用户需手动开启且开放自由注册 | **默认全站强制账号密码登录**（覆盖公网裸端口、Nginx/Caddy 反代与局域网）；未认领时自动引导或由 `.env` 初始化站主并接管已有媒体库；**默认关闭公开注册**，支持站主在「设置 → 账号」切换注册开关、直接新建成员账号与重置密码；延续原生暗黑绿 UI 风格 |
| **自动搜片与追更** | 自然语言/片名搜片、Agent 选源转存、落盘回读验证、定时补缺、通用选源偏好与影视库刷新 | 沿用原有获取/追更/选源/刷新链路，新获取资源统一应用可自定义命名模板，保持原获取沙箱根保护与账号隔离 |
| **已有库扫描与整理** | 主要管理巡影自身获取落盘的作品 | 完整支持 **夸克 / UC / 115 / 123 / 光鸭 / 天翼** 六盘已有目录分页扫描、TMDB 身份识别、安全导入（默认关闭自动补缺）、模板预览/整理、多版本共存与字幕语言/`forced` 标记配对 |
| **大规模性能与缓存** | 直接读取 PostgreSQL 快照与列表 | 媒体墙与任务队列服务端有界分页，新增独立非网盘准备并发，支持 **可选 Redis 摘要缓存**（故障自动降级回 PG，不丢任务）及单页共享 SSE 进度流 |
| **消息机器人与直转** | Web 界面与 Agent API | 内置 **个人微信（iLink 扫码/PIN）/ 飞书（官方长连接卡片）/ Telegram（grammY 按钮）** 本人私聊入口，支持搜片、选盘、查进度、停止，以及**六盘分享链（含提取码）与 115/123/光鸭磁力直转** |
| **GHCR 自动构建与 NAS 部署** | 仓库内 `docker compose up` 本地编译 + Desktop 应用 | 提供免源码构建的 [`docker-compose.fork.yml`](docker-compose.fork.yml)，零密钥推送 `linux/amd64` 镜像至 **GHCR（`ghcr.io/pickarm/mediary-scout`）**，并支持环境变量自定义镜像源 |

---

## NAS / VPS 快速部署（推荐）

Fork 默认采用**预构建镜像 + 外置基础设施**架构：单个 `web` 容器同时承载 Web 界面与进程内 worker，外接你现有的 PostgreSQL、PanSou 与可选 Redis，无需在 NAS / VPS 上保留源码、安装 Node.js 或挂载 Docker socket。

### 1. 准备配置文件

下载 [`docker-compose.fork.yml`](docker-compose.fork.yml) 到部署目录，并创建 `.env`（完整字段说明见 [`.env.example`](.env.example)）：

```dotenv
# 必填：外部 PostgreSQL 连接串与 PanSou 搜索服务地址
MEDIA_TRACK_POSTGRES_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE_NAME
PANSOU_BASE_URL=http://PANSOU_HOST:PORT

# 可选：Redis 缓存（断开或清空不影响任务持久性）
REDIS_URL=redis://REDIS_HOST:6379

# 镜像来源与标签：默认拉取 ghcr.io/pickarm/mediary-scout:latest（可选 edge / sha-... / vYYYY.MM.DD）
# MEDIA_TRACK_IMAGE=ghcr.io/pickarm/mediary-scout
MEDIA_TRACK_IMAGE_TAG=latest
WEB_PORT=3000

# 可选：首次启动自动创建站主账号（仅当实例尚未认领时生效，绝不覆盖已有密码）
# MEDIA_TRACK_ADMIN_USERNAME=admin
# MEDIA_TRACK_ADMIN_PASSWORD=请设置至少6位强密码

# 可选：反代域名一致校验（若在反代后使用，优先让反代正确透传 x-forwarded-host）
# MEDIA_TRACK_ALLOWED_ORIGINS=mediary-scout.example.com
```

> 容器内的 `localhost` / `127.0.0.1` 指代容器自身；连接宿主机或其他容器的 PostgreSQL / Redis / PanSou 时请填写容器可达的主机名、Docker 网络名或局域网 IP。

### 2. 启动并核验服务

```bash
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d web
docker compose -f docker-compose.fork.yml ps
```

- 健康检查端点：`http://<HOST_IP>:3000/api/health`
- 打开浏览器访问 `http://<HOST_IP>:3000`：会自动跳转至 `/login`。
  - 若未配置 `MEDIA_TRACK_ADMIN_*`，首次访问将引导**创建站主账号**（已有单用户媒体库与网盘绑定会被自动接管保留），完成后立即锁定初始化入口。
  - 若已通过 `.env` 预置站主，直接使用该用户名和密码登录即可；进入后前往 **设置 → 网盘** 绑定你的网盘。

### 3. 日常更新与版本核验

```bash
# 拉取最新或指定标签镜像并重建容器
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d --force-recreate web

# 查看当前运行容器内置的代码提交与版本号
docker compose -f docker-compose.fork.yml exec -T web cat BUILD_COMMIT BUILD_VERSION
```

> 如果需要在同一台机器上一次性拉起全套自带 PostgreSQL、PanSou 与本地源码编译（或使用 macOS / Windows 桌面客户端），请参阅 [完整部署指南](docs/deploy.md) 与 [`docker-compose.yml`](docker-compose.yml)。

---

## 登录验证与访问安全

Fork 将访问控制改为**默认安全（Fail-Closed）**模型，适合直接部署在公网 VPS 端口、Nginx/Caddy/Lucky 反向代理后或局域网 NAS 上：

- **默认处处需要登录**：除 `/login`、`/api/auth/*`、健康检查 `/api/health` 与带自身令牌守卫的 `/api/workflows/*`、`/api/agent/*`、`/api/update/*` 外，其余所有页面与接口均需持有有效的签名会话 Cookie（`mt_session`）；未登录访问会自动携带站内安全回跳路径重定向至 `/login`。
- **协议自适应 Cookie**：`MEDIA_TRACK_COOKIE_SECURE` 留空时自动按客户端协议决定 `Secure` 标记——纯 HTTP 访问公网 IP `:3000` 或局域网不加 `Secure`，HTTPS 反代/隧道下自动启用 `Secure`，开箱不掉登录态。
- **默认关闭公开注册**：仅首位用户可认领成为站主；之后任何陌生人访问 `/login` 仅看到登录框，请求 `/api/auth/register` 将被返回 `403`。站主可在 **设置 → 账号** 中按需临时开启/关闭公开注册、直接后台添加成员账号或重置他人密码。
- **无效/过期会话自动重登**：失效 Cookie 会在引导查询与服务端壳层中自动清理并引导重新登录。

### 认证与初始化环境变量速查

| 变量名 | 默认值 | 说明 |
|---|---|---|
| `MEDIA_TRACK_ADMIN_USERNAME` | 空 | 可选，与密码成对配置；首次启动当实例未认领时自动初始化站主（绝不覆盖已改密码） |
| `MEDIA_TRACK_ADMIN_PASSWORD` | 空 | 可选，站主初始密码（至少 6 位）；仅在未认领时写入 |
| `MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP` | 空 | 设为 `1` 时禁止网页端 `/login` 匿名首次认领，强制要求通过上方环境变量初始化 |
| `MEDIA_TRACK_ALLOW_REGISTRATION` | 空 | 留空由站主在 **设置 → 账号** 动态切换（默认关闭）；`1` 强制开放、`0` 强制关闭并锁定 |
| `MEDIA_TRACK_COOKIE_SECURE` | 空 | 留空按 `x-forwarded-proto` / 请求协议自动判定；无完整透传反代时可显式设 `1` 或 `0` |
| `MEDIA_TRACK_MULTI_USER` | 空（默认开启） | 兼容开关：设为 `0` 时可退回旧版单用户局域网免登模式（仅拦截 Cloudflare Tunnel 请求） |

### 忘记密码重置（容器 CLI 逃生口）

如果站主或成员忘记密码，可在部署主机直接进入运行中的容器重置（无需数据库客户端）：

```bash
docker compose -f docker-compose.fork.yml exec web node scripts/reset-password.mjs <用户名>
```

---

## GitHub Actions 自动构建镜像（GHCR）

本仓库已配置免外部 Secrets、纯使用 GitHub Container Registry（GHCR）的镜像构建流水线。两条工作流均强制执行 **“单次 `linux/amd64` `buildx` 构建 → 对接独立 PostgreSQL + 假适配启动容器完成 `/api/health`、`/login` 与根路径未登录拦截冒烟 → 校验同镜像 ID 推送”**：

| 工作流文件 | 触发方式 | 推送目标与标签策略 | 适用场景 |
|---|---|---|---|
| [`.github/workflows/docker-autobuild.yml`](.github/workflows/docker-autobuild.yml)<br>(`Auto build Docker image`) | `push` 到 `main` / `feature/pickarm-v1`（自动忽略 `docs/**`、`README*.md`、`LICENSE` 等纯文档修改），或 **Actions → Run workflow** 手动触发 | 默认仓库 `ghcr.io/<owner>/<repo>`：<br>• `main` 分支推送 → 同步更新 **`latest`**、**`edge`**、**`sha-<12位>`**<br>• `feature/pickarm-v1` 推送 → 更新 **`dev`**、**`sha-<12位>`**<br>• 手动触发可指定 `image_tag` 并按需勾选 `push_latest` | 日常合入出包、个人 Fork 自动构建、拉取分支测试镜像 |
| [`.github/workflows/fork-image.yml`](.github/workflows/fork-image.yml)<br>(`Fork image release`) | 推送 `v*` 版本标签（如 `v2026.11.26`） | 先完整运行 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)（全量 lint / typecheck / 构建 / PG+Redis 集成测试）与只读版本预检，冒烟通过后向 GHCR 推送 **`<tag>`**、**`sha-<40位>`**、**`latest`**，核验三者远端 digest 完全一致后创建 GitHub Release | 正式版本发布、生成带升级命令的 Release 日志 |

### 在你自己的 Fork 仓库中一键启用

1. 打开 GitHub 仓库的 **Settings → Actions → General → Workflow permissions**，确认勾选 **Read and write permissions**（用于自动签发 `GITHUB_TOKEN` 推送 GHCR，无需额外配置 Docker Hub 账号密码）。
2. 向 `main` 推送代码（或进入 [Actions → Auto build Docker image](https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml) 点击 **Run workflow**），等待构建与冒烟全部绿灯。
3. **首次发布后开放公开拉取权限**（仅首次需要做一次）：
   - 进入仓库右侧 **Packages**（或 `https://github.com/<你的用户名>?tab=packages`）找到 `mediary-scout`；
   - 打开 **Package settings → Danger Zone → Change visibility**，将可见性切换为 **Public**。
   - 此后任何 NAS / VPS 均可直接免登录执行 `docker pull ghcr.io/<你的用户名>/mediary-scout:latest`。
4. 如需打正式日期版本包，推送 `v*` 标签即可：
   ```bash
   git tag v2026.11.26
   git push origin v2026.11.26
   ```

---

## 支持网盘与功能矩阵

| 网盘 | 绑定方式 | 搜片转存 | 磁力 / 离线 | 已有库扫描整理 | 消息直转 |
|---|---|---|---|---|---|
| **夸克网盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |
| **UC 网盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |
| **115 网盘** | 扫码登录 | 分享链 + 磁力 | 支持 | 支持 | 115 分享 + 磁力 |
| **123 网盘** | 扫码登录 | 分享链 + 磁力 | 支持 | 支持 | 123 分享 + 磁力 |
| **光鸭云盘** | 设备扫码 / Token | 分享链 + 磁力 | 支持 | 支持 | 光鸭分享 + 磁力 |
| **天翼云盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |

更多各网盘资源特征与连接细节见 [网盘评估](docs/drive-brand-evaluations.md) 与 [部署指南](docs/deploy.md)。

---

## 消息机器人与直转入口

在 Web 界面的 **设置 → 巡检 → 消息机器人** 按当前登录账号单独配置（所有平台默认关闭，仅响应配置好的本人私聊）：

- **个人微信**：基于腾讯 iLink 能力，扫码授权并显式开启；若发送回执因超时失败，结果仍保留在任务记录中供随时主动查询。
- **飞书**：填入应用 `App ID`、`App Secret` 与本人 `open_id`，使用官方 SDK 长连接订阅消息与卡片动作。
- **Telegram**：填入 `Bot Token` 与本人数值 `user_id`，采用 `grammY` 长轮询与交互按钮。

常用私聊指令：`帮助` · `我想看 片名`（或直接发片名）· 直接发送网盘分享链（可附提取码）或 `magnet:` 磁力链 · `查询 [任务ID]` · `停止 [任务ID]`。

---

## 文档索引

### Fork 专有文档
- [Fork 部署与运行指南](docs/fork/DEPLOYMENT.md)
- [Fork 数据库迁移与演练说明](docs/fork/MIGRATION.md)
- [Fork 产品需求文档 (PRD)](docs/fork/PRD.md)
- [Fork 技术设计文档](docs/fork/TECHNICAL-DESIGN.md)
- [Fork 任务与审查记录](docs/fork/TASKS.md) · [审查流水日志](docs/fork/REVIEW-LOG.md)

### 上游保留文档
- [完整源码部署指南](docs/deploy.md) · [PanSou 自托管](docs/pansou-self-host.md)
- [Agent API 接口文档](docs/agent-api.md)（让 Claude Code / Codex / OpenClaw 操作巡影）
- [智能选源与网页查证](docs/web-research.md)
- [架构速览](docs/architecture.md) · [工作流架构说明](docs/workflow-product-architecture.md)

---

## 本地开发与验证

环境要求：Node.js `>=22.13.0`、npm（严格沿用仓库 [`package-lock.json`](package-lock.json)）。

```bash
# 安装依赖
npm ci

# 构建 workflow 包与无库 Web 生产产物
npm run build:workflow
npm run build:web

# 严格类型检查与 ESLint（含 Web 测试与迁移脚本）
npm run typecheck
npm run typecheck:migration
npx tsc --noEmit --project apps/web/tsconfig.json
npm run lint

# 运行非 PostgreSQL 单元测试（Windows 沙箱下可附加 --configLoader native）
npx vitest run --exclude '**/*.pg.test.ts' --exclude '**/*.postgres.test.ts'
```

> 完整的 PostgreSQL / Redis 集成测试请参考 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在 Linux 或 Docker 环境下串行执行 `*.pg.test.ts` 与 `*.postgres.test.ts`。

---

## 免责声明与致谢

巡影是开源、自部署的软件，不提供、也永远不会提供托管服务：你自己运行实例，自带网盘、AI 模型和搜索服务凭证。程序执行的操作等价于你在自己网盘中的合法文件管理操作，详见 [项目定位](docs/distribution-and-legal-positioning.md)。本项目与 115、夸克、UC、光鸭、123、天翼、TMDB、微信、飞书、Telegram 及任何索引器均无隶属关系。

特别感谢开源上游 [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout) 与 [LINUX DO 社区](https://linux.do)，以及以下开源基础设施和 API 参考：
- [PanSou](https://github.com/fish2018/pansou-web)：资源搜索后端
- [Prowlarr](https://github.com/Prowlarr/Prowlarr)：索引器管理（可选）
- [p115client](https://github.com/ChenyangGao/p115client)：115 API 参考
- [p123client](https://github.com/ChenyangGao/p123client)：123 网盘 API 参考
- [AList](https://github.com/AlistGo/alist)：光鸭云盘 API 参考（`drivers/guangyapan`）
- [cloud189-auto-save](https://github.com/1307super/cloud189-auto-save) / [cloudpan189-api](https://github.com/tickstep/cloudpan189-api)：天翼云盘 API 参考
- [TMDB](https://www.themoviedb.org/)：影视元数据（本产品未获 TMDB 认证或背书）
