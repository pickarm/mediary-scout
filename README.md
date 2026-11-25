<p align="center">
  <img src="docs/images/hero.svg" alt="巡影 · Mediary Scout" width="600">
</p>

<p align="center">
  <b>巡影 · Mediary Scout（pickarm Fork）</b><br>
  <b>面向自部署 NAS 的 agent 驱动网盘媒体库：自动搜片追更 + 已有库扫描整理 + 消息机器人直转入库。</b>
</p>

<p align="center">
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml"><img src="https://github.com/pickarm/mediary-scout/actions/workflows/docker-autobuild.yml/badge.svg" alt="Auto Build Docker Image"></a>
  <a href="https://github.com/pickarm/mediary-scout/releases"><img src="https://img.shields.io/github/v/release/pickarm/mediary-scout?display_name=tag" alt="Fork 版本"></a>
  <a href="https://hub.docker.com/r/qicket/mediary-scout"><img src="https://img.shields.io/docker/v/qicket/mediary-scout?label=Docker%20Hub" alt="Docker Hub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-0BSD-blue" alt="license"></a>
</p>

<p align="center">
  <a href="#nas--docker-快速部署推荐">🚀 快速部署</a> ·
  <a href="#github-actions-自动构建镜像">⚙️ 自动构建镜像</a> ·
  <a href="#消息机器人入口">💬 消息机器人</a> ·
  <a href="docs/fork/DEPLOYMENT.md">📘 Fork 部署文档</a> ·
  <a href="README.en.md">English</a>
</p>

本项目基于开源上游 [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout) 维护并增强，保留原有电影/剧集/番剧自动搜源、选源、转存、落盘核实、每日定时巡检追更、多账号隔离及 Emby / Jellyfin / Plex / 入库 Webhook 刷新能力，并针对 **NAS 预构建部署、已有网盘媒体库管理、大规模性能优化及聊天机器人直转** 进行深度扩展。

> **当前交付边界说明**：
> - **Docker Hub 预构建镜像（`linux/amd64`）**：首版 `qicket/mediary-scout:v2026.11.16` 已完成隔离环境验证并发布至 [Docker Hub](https://hub.docker.com/r/qicket/mediary-scout/tags)。
> - **v1.1 开发中能力（消息机器人与六盘链接直转）**：源码与单元测试正在收尾复审，真实微信/飞书/Telegram 收发及真实六盘测试目录实测仍需在独立测试环境完成，部署前请阅读 [Fork 部署文档](docs/fork/DEPLOYMENT.md) 与 [迁移说明](docs/fork/MIGRATION.md)。

![巡影：搜片 → 点获取 → agent 自动搜索、转存、验证落进你的网盘](docs/images/demo.gif)

---

## 核心能力对比（上游 + Fork 增强）

| 模块 | 上游核心能力 | pickarm Fork 新增与增强 |
|---|---|---|
| **自动搜片与追更** | 自然语言/片名搜片、Agent 选源与转存、落盘回读验证、定时巡检补缺、通用选源要求、影视服务器刷新 | 沿用原有获取/追更/选源/刷新链路，新获取资源统一应用可自定义命名模板，保持原有获取沙箱根保护与多账号隔离 |
| **已有库扫描与整理** | 仅管理巡影自身获取落盘的作品 | 完整支持 **115 / 夸克 / UC / 123 / 天翼 / 光鸭** 六盘已有目录分页扫描、媒体身份识别、导入（默认关闭自动补缺）、模板预览/整理、多版本保留与字幕语言/`forced` 标记配对，支持可选后台自动整理 |
| **大规模性能与缓存** | 直接读取 PostgreSQL 快照与列表 | 媒体墙与队列改为服务端有界分页查询，新增独立并发提前准备队列、**可选 Redis 摘要缓存**（故障自动降级回 PG，不丢任务）以及单页面共享 SSE 进度流 |
| **消息机器人（v1.1）** | 仅 Web UI 与 Agent API | 内置 **个人微信（iLink 扫码/PIN）/ 飞书（官方长连接卡片）/ Telegram（grammY 按钮）** 本人私聊入口，支持搜片、选片、选盘、查询与停止 |
| **链接与磁力直转（v1.1）** | 经搜索选源后转存 | 支持私聊直接发送 **六盘本品牌分享链接（含提取码）** 与 **115 / 123 / 光鸭磁力链接**，完整包落入授权独立目录并回执恢复、自动扫描识别整理及刷新媒体服务器 |
| **NAS 部署与迁移** | 仓库内 `docker compose up` 本地源码构建 + Desktop 应用 | 提供免源码构建的 `docker-compose.fork.yml`、预构建 `linux/amd64` 镜像、GitHub Actions 自动构建镜像流水线与只读副本迁移演练工具 |

---

## NAS / Docker 快速部署（推荐）

Fork 面向 NAS 场景默认采用**预构建镜像 + 外置基础服务**模式：单个 `web` 容器同时托管 Web 服务与进程内后台 worker，不内置 PostgreSQL/PanSou，无需在 NAS 上检出完整源码、安装 Node/npm 或挂载 Docker socket。

### 1. 准备配置文件

在 NAS 部署目录下载 [docker-compose.fork.yml](docker-compose.fork.yml) 并创建 `.env`（参考 [`.env.example`](.env.example)）：

```dotenv
# 必填：外部 PostgreSQL 连接串与 PanSou 搜索服务地址
MEDIA_TRACK_POSTGRES_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE_NAME
PANSOU_BASE_URL=http://PANSOU_HOST:PORT

# 可选：Redis 缓存（断开或清空不影响任务持久性）
REDIS_URL=redis://REDIS_HOST:6379

# 镜像标签：固定正式版本（如 v2026.11.16），或 latest / edge / dev
MEDIA_TRACK_IMAGE_TAG=v2026.11.16
WEB_PORT=3000

# 可选：反代域名一致校验（改此项需在构建时传入；日常反代建议正确透传 x-forwarded-host）
# MEDIA_TRACK_ALLOWED_ORIGINS=mediary-scout.example.com
```

> 容器内 `localhost` / `127.0.0.1` 指代容器自身；连接宿主机或其他容器的 PostgreSQL / Redis / PanSou 时请使用容器可达的主机名或局域网 IP。

### 2. 启动与检查

```bash
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d web
docker compose -f docker-compose.fork.yml ps
```

访问 `http://<NAS_IP>:3000` 登录并连接网盘。健康检查端点：`http://<NAS_IP>:3000/api/health`。

若需使用 GitHub Actions 自动构建推送到 **GHCR** 的开发镜像，可直接修改 `docker-compose.fork.yml` 中的镜像地址或手动拉取：

```bash
docker pull ghcr.io/pickarm/mediary-scout:edge
```

### 3. 更新与回退

```bash
# 拉取指定版本或最新镜像并重建容器
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d --force-recreate web

# 查看当前运行镜像对应的代码提交与版本
docker compose -f docker-compose.fork.yml exec -T web cat BUILD_COMMIT BUILD_VERSION
```

从上游实例或旧库迁移前，务必先在独立 PostgreSQL 副本完成禁写盘演练并停止旧实例 worker，详见 [部署文档](docs/fork/DEPLOYMENT.md) 与 [迁移说明](docs/fork/MIGRATION.md)。

> 如果你需要自己修改代码并直接在本地编译镜像，或运行 macOS / Windows 桌面客户端，可参考原仓库 [部署指南](docs/deploy.md) 与 `docker-compose.yml`。

---

## GitHub Actions 自动构建镜像

本仓库提供两条职责清晰的镜像流水线，均强制执行 **“单次 `linux/amd64` 构建 → 独立 PostgreSQL + 假适配启动 `/api/health` 冒烟 → 校验通过后再推送同一镜像 ID”**：

| 工作流文件 | 触发方式 | 推送目标与标签 | 适用场景 |
|---|---|---|---|
| [`.github/workflows/docker-autobuild.yml`](.github/workflows/docker-autobuild.yml)<br>(`Auto build Docker image`) | `push` 到 `main` / `feature/pickarm-v1`（忽略纯文档变更），或 GitHub 页面 **Actions → Run workflow** 手动触发 | **GHCR（开箱即用）**：`ghcr.io/<owner>/<repo>:<tag>` 与 `sha-<12位提交>`<br>**Docker Hub（配置 Secrets 后自动双推）**：默认 `qicket/mediary-scout`<br>分支默认标签：`main` → `edge`，`feature/pickarm-v1` → `dev`；默认不覆盖 `latest` | 日常分支验证、私有/Fork 自动出包、手动打指定测试标签（可选勾选更新 `latest`） |
| [`.github/workflows/fork-image.yml`](.github/workflows/fork-image.yml)<br>(`Fork image release`) | 推送 `v*` 轻量标签（如 `v2026.11.25`） | 先完整运行 [`.github/workflows/ci.yml`](.github/workflows/ci.yml) 与只读预检，再向 Docker Hub 推送 `<tag>`、`sha-<40位>`、`latest` 并验证远端摘要完全一致，最后创建 GitHub Release | 正式版本发布（要求全套 CI、PG/Redis 集成与构建全部通过） |

### 在你自己的 Fork 仓库启用自动构建

1. 在 GitHub 仓库打开 **Settings → Actions → General → Workflow permissions**，确认开启 **Read and write permissions**（用于免密推送到 GHCR）。
2. 如需同时自动推送到你自己的 Docker Hub，在 **Settings → Secrets and variables → Actions** 配置：
   - **Secrets**：`DOCKERHUB_USERNAME`、`DOCKERHUB_TOKEN`（Docker Hub Access Token）
   - **Variables（可选）**：`DOCKERHUB_IMAGE`（例如 `yourname/mediary-scout`，不填则默认 `qicket/mediary-scout`）
3. 推送代码到 `main` / `feature/pickarm-v1` 即会自动触发镜像构建与冒烟校验；也可以在 **Actions → Auto build Docker image → Run workflow** 手动输入 `image_tag` 并选择是否勾选 `push_latest`。
4. 需要发布正式版本号时，打轻量标签并推送：
   ```bash
   git tag v2026.11.25
   git push origin v2026.11.25
   ```

---

## 支持的网盘与功能矩阵

| 网盘 | 登录方式 | 搜片转存 | 磁力 / 离线 | 已有库扫描整理 | 消息直转（v1.1） |
|---|---|---|---|---|---|
| **夸克网盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |
| **UC 网盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |
| **115 网盘** | 扫码登录 | 分享链 + 磁力 | 支持 | 支持 | 115 分享 + 磁力 |
| **123 网盘** | 扫码登录 | 分享链 + 磁力 | 支持 | 支持 | 123 分享 + 磁力 |
| **光鸭云盘** | 设备扫码 / Token | 分享链 + 磁力 | 支持 | 支持 | 光鸭分享 + 磁力 |
| **天翼云盘** | 扫码登录 | 分享链 | — | 支持 | 同品牌分享链 |

更多各网盘资源规模差异与连接配置说明见 [网盘评估](docs/drive-brand-evaluations.md) 与 [部署指南](docs/deploy.md)。

---

## 消息机器人入口（v1.1）

进入 Web 界面的 **设置 → 巡检 → 消息机器人**，可按当前巡影账号分别配置以下平台（所有平台默认关闭，仅响应本人私聊）：

- **个人微信**：基于腾讯 iLink 公开能力，扫码绑定凭证并显式开启；发送失败时保留任务结果供后续主动查询取回。
- **飞书**：填写应用 `App ID`、`App Secret` 与本人 `open_id`，采用官方 SDK 长连接订阅 `im.message.receive_v1` 与 `card.action.trigger`，支持交互卡片按钮。
- **Telegram**：填写 `Bot Token` 与本人数值 `user_id`，采用 `grammY` 长轮询与按钮交互。

常用私聊消息指令：
- `帮助`：查看可用指令与支持的链接格式
- `我想看 片名` 或直接发送片名：触发搜索，按序号或按钮选择作品、季数和目标网盘
- 直接发送网盘分享链接（可附带 `提取码：xxxx`）或 `magnet:` 磁力链接：创建独立授权落地区、完整包转存、扫描识别整理并刷新配置好的媒体服务器
- `查询` / `查询 任务ID`：查看最近任务或指定任务的持久进度与结果
- `停止` / `停止 任务ID`：取消排队中的获取任务或阻止直转任务的后续识别与整理

---

## 文档索引

### Fork 专有文档
- [Fork 部署与运行指南](docs/fork/DEPLOYMENT.md)
- [Fork 数据库迁移与演练说明](docs/fork/MIGRATION.md)
- [Fork 产品需求文档 (PRD)](docs/fork/PRD.md)
- [Fork 技术设计文档](docs/fork/TECHNICAL-DESIGN.md)
- [Fork 任务与审查记录](docs/fork/TASKS.md) · [审查流水日志](docs/fork/REVIEW-LOG.md)

### 上游保留文档
- [完整部署指南](docs/deploy.md) · [PanSou 自托管](docs/pansou-self-host.md)
- [Agent API 接口文档](docs/agent-api.md)（让 Claude Code / Codex / OpenClaw 操作巡影）
- [智能选源与网页查证](docs/web-research.md)
- [架构速览](docs/architecture.md) · [工作流架构说明](docs/workflow-product-architecture.md)

---

## 本地开发与验证

环境要求：Node.js `>=22.13.0`、npm（严格沿用仓库 [`package-lock.json`](package-lock.json)）。

```bash
# 安装依赖
npm ci

# 构建 workflow 包与 Web 生产产物（允许无数据库预构建）
npm run build:workflow
npm run build:web

# 类型检查与代码检查
npm run typecheck
npm run typecheck:migration
npx tsc --noEmit --project apps/web/tsconfig.json
npm run lint

# 运行非 PostgreSQL 单元测试
npx vitest run --exclude '**/*.pg.test.ts' --exclude '**/*.postgres.test.ts'
```

> 完整的 PostgreSQL / Redis 集成测试建议在 Linux 或 Docker 环境下配合 `.github/workflows/ci.yml` 中的服务配置串行运行 `*.pg.test.ts` 与 `*.postgres.test.ts`。

---

## 免责声明与致谢

巡影是开源、自部署的软件，不提供、也永远不会提供托管服务：你自己运行实例，自带网盘、AI 模型和搜索服务凭证。程序执行的操作等价于你在自己网盘中的合法文件管理操作，详见 [项目定位](docs/distribution-and-legal-positioning.md)。本项目与 115、夸克、UC、光鸭、123、天翼、TMDB、微信、飞书、Telegram 及任何索引器均无隶属关系。

特别感谢上游项目 [fancydirty/mediary-scout](https://github.com/fancydirty/mediary-scout) 与 [LINUX DO 社区](https://linux.do)，以及以下开源基础设施和 API 参考：
- [PanSou](https://github.com/fish2018/pansou-web)：资源搜索后端
- [Prowlarr](https://github.com/Prowlarr/Prowlarr)：索引器管理（可选）
- [p115client](https://github.com/ChenyangGao/p115client)：115 API 参考
- [p123client](https://github.com/ChenyangGao/p123client)：123 网盘 API 参考
- [AList](https://github.com/AlistGo/alist)：光鸭云盘 API 参考（`drivers/guangyapan`）
- [cloud189-auto-save](https://github.com/1307super/cloud189-auto-save) / [cloudpan189-api](https://github.com/tickstep/cloudpan189-api)：天翼云盘 API 参考
- [TMDB](https://www.themoviedb.org/)：影视元数据（本产品未获 TMDB 认证或背书）
