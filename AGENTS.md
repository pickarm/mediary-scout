# 巡影 Fork 开发约定

## 1. 目标与来源（上游基线与项目定位）
- **项目定位**：巡影 · Mediary Scout（`pickarm/mediary-scout` Fork）是面向自部署 NAS / VPS 的 Agent 驱动多网盘媒体库，采用**单个 `linux/amd64` Next.js Standalone 容器 = Web + 进程内后台 Worker** 形态，外接 PostgreSQL、PanSou 与可选 Redis。
- **上游基线与同步状态**：上游为 `fancydirty/mediary-scout`，初始基线 `282ef781edf876d2c7ecbadbc8d2bd147759006e`；已同步合入上游至 `582a3b73`（`#379`，含通用选源偏好与 Emby / Jellyfin / Plex / Webhook 入库刷新），并落地 Fork v1.1（`F01–F26`）、默认强制登录（`78e2a9b`）、去远程访问清理、内置 TMDB 图片代理、TMDB 搜索扩容与 GHCR 镜像更新检测。保持原有获取、验证、追更和多账号隔离能力。
- **镜像发布源**：统一发布至纯 GHCR `ghcr.io/pickarm/mediary-scout`（零外部 Docker Hub 密钥）。部分历史文档（如 `docs/fork/PRD.md`、`docs/fork/TECHNICAL-DESIGN.md`）中遗留的旧 `qicket/mediary-scout` 名称以实际代码与 `.github/workflows/` 为准。
- **需求与视觉约定**：首版需求、接口和验收以 `docs/fork/PRD.md`、`docs/fork/TECHNICAL-DESIGN.md`、`docs/fork/TASKS.md` 为准；部署与迁移补充见 `docs/fork/DEPLOYMENT.md`、`docs/fork/MIGRATION.md`。产品文案使用简体中文；新增 UI 复用现有 CSS token、按钮、面板和导航，不另建视觉体系。

## 2. Monorepo 目录结构与模块边界
- **运行基线**：Node.js `>=22.13.0`、npm workspaces（`apps/*`、`packages/*`）、Next.js 16 + React 19 + TypeScript 5.9 + Vitest 4 + ESLint 10。
- **`packages/workflow`（`@media-track/workflow`）**：纯业务编排、六盘适配与持久化核心，**仅通过 `package.json#exports` 公开 12 个子入口**：
  - `.`、`./scope`、`./search-view`、`./user-requests`、`./library`、`./activity-query`、`./preparation-consumer`、`./library-query`、`./summary-cache`、`./naming`、`./selection-preference`、`./media-server-refresh`。
  - **严格前后端边界**：Web 客户端组件（`"use client"`）只允许导入纯类型或纯工具子入口（如 `./naming`），严禁值导入含 `pg`、Node 原生模块或 AI SDK 的聚合入口。
  - **六盘统一注册表**（`src/storage-brands.ts`）：`pan115`（115）、`quark`（夸克）、`uc`（UC）、`guangya`（光鸭）、`tianyi`（天翼）、`pan123`（123）。115 / 光鸭 / 123 支持分享链 + 磁力离线，夸克 / UC / 天翼支持同品牌分享链；写范围保护分 `parents`（115/夸克/UC）与 `listed`（光鸭/天翼/123）。
  - **核心分层**：`src/acquisition-v2/`（获取引擎 V2）、`src/library/`（模板、扫描、识别、专用导入、整理、提前准备、有界查询、缓存、光鸭三层协调）、六盘 `*-client.ts` / `*-qrcode-login.ts` / `*-storage-executor.ts`、`tmdb-provider.ts` / `pansou-provider.ts` / `prowlarr-provider.ts` / `haisou-provider.ts` / `jev-*`、`postgres.ts` / `repository.ts` / `auth/{password,session}.ts`。
- **`apps/web`（`@media-track/web`）**：Next.js 16 App Router 应用。
  - **核心页面（`app/`）**：`/`（首页搜索 + 热门 + 分页库墙）、`/w/[storageId]`（旧工作区路径兼容重定向）、`/show/[tmdbId]`（作品详情/季集/追更/换源留言）、`/activity`（活动与队列）、`/notifications`（通知）、`/foreign-work/[workflowRunId]`（异作品确认）、`/library/manage`（已有库扫描/识别/模板/整理）、`/library-demo`（演示页）、`/settings`（网盘/资源与服务/获取偏好/巡检与通知/账号/更新）、`/login`（登录与首次站主认领）。
  - **主要 API 分组（`app/api/`）**：`/api/auth/*`、`/api/health`、`/api/workflows/{run-next,run-type3}`、`/api/agent/{acquire,activity,config,library,patrol}`、`/api/library/*`（含 `/api/library/progress` 共享 SSE）、`/api/{115,quark,uc,guangya,tianyi,pan123}/qrcode/*`、`/api/activity/*`、`/api/notifications/meta`、`/api/settings/attention{,/dismiss}`、`/api/tmdb/image/[size]/[...path]`、`/api/update/{status,busy,hold}`。
  - **进程内 6 类后台 Worker**（由 `instrumentation.ts` 初始化代理、校验配置与迁移后启动）：主队列/每日巡检（`lib/background-worker.ts`）、扫描与识别恢复（`lib/library-scan-worker.ts`）、手动整理（`lib/library-organization-worker.ts`）、自动整理调度（`lib/library-auto-organization-worker.ts`）、非网盘提前准备（`lib/library-preparation-worker.ts`）、三平台消息机器人（`lib/messaging/worker.ts`）。
- **`apps/desktop`**：上游保留的 Electron 桌面封装（Fork 不发布桌面安装包，CI 仍校验其 `tsc`）。
- **`workers/`**：
  - 仅保留 `workers/tmdb-proxy/`（Cloudflare Worker TMDB 元数据与图片只读代理）。
  - **已彻底移除商业远程访问服务、`workers/scout-connect/` 与 Cloudflare Tunnel 集成**：Web 端「设置 → 远程访问」Tab、首页横幅、`connect-*` / `remote-access-*`（除 `/login` 单用户安全提示所需的 `lib/remote-access-copy.ts` 外）及 `docker-compose*.yml` 中 `cloudflared` / `TUNNEL_TOKEN` 均已清理；旧库 `app_settings` / `account_settings` 历史 `connect_*` 键按精确键查询模型兼容忽略，不引发报错。
- **`scripts/`、`updater/`、`deploy/`、`docs/`**：`scripts/` 包含 `reset-password.mjs`（容器重置密码 CLI）、`fork-migration.mjs` + `fork-migration-policy.json`（迁移演练与表指纹）及实盘探针；`updater/` 仅保留供显式 `MEDIA_TRACK_DISTRIBUTION=local-source` 使用（已清理 `/tunnel` 路由与 `tunnel-env.*`）。

## 3. 核心业务主线
1. **资源获取 V2 + 并发 TMDB + 图片代理 + 库墙增强**：
   - TMDB 搜索支持分页并发拉取最多 **40 条**候选（`DEFAULT_SEARCH_MAX_RESULTS = 40`、`MAX_SEARCH_PAGES = 3`），带 5 分钟失效线路熔断器（`TMDB_DEAD_ACCESS_TTL_MS`），剧集详情/演职员并发加载（`TV_DETAILS_CONCURRENCY = 6`、`MAX_CAST_MEMBERS = 10`）；
   - Web 提供 `/api/tmdb/image/[size]/[...path]` 内置图片代理（`lib/tmdb-image.ts` 校验尺寸与文件名白名单，支持 `TMDB_IMAGE_BASE_URL`，直连失败自动 5 分钟冷却并回退内置 TMDB 代理，带内存与临时磁盘缓存）；
   - `library-query.ts` 支持按 `updatedAt` 排序等分页查询；独立准备 worker 提前并发执行非网盘 PanSou 搜索与 Jev 预筛，再由主循环按每盘单并发执行转存、回读核实、按模板重命名与媒体服务器刷新。
2. **六盘已有库扫描、识别与整理**：在 `/library/manage` 为六盘配置扫描根/目标根/模板，分页扫描落库事实、TMDB/AI 识别并原子导入（`autoAcquire` 默认关闭），支持预览与非破坏性整理（持写锁、回读确认、保留多版本与字幕语言/`forced` 标记）。
3. **三平台消息机器人**：位于 `apps/web/lib/messaging/`，按账号隔离存储，默认关闭且仅响应本人私聊；支持微信（iLink 扫码/PIN）、飞书（官方长连接卡片）与 Telegram（grammY 按钮）搜片入队、查进度/停止，以及六盘分享链（含提取码）与 115/123/光鸭磁力直转至独立落地区。
4. **默认强制登录鉴权（Fail-Closed）**：由 `apps/web/proxy.ts` 与 `apps/web/lib/auth-mode.ts` 强制拦截未登录访问并跳转 `/login`；未认领时支持 `/login` 首次设置站主（接管 `acct_default`）或 `.env` `MEDIA_TRACK_ADMIN_*` 预置；默认关闭公开注册；Cookie `Secure` 按请求协议自适应。
5. **GHCR 镜像更新检测**：由 `apps/web/lib/image-update-server.ts`、`fork-release.ts`、`deployment-update-server.ts`、`update-state.ts`、`update-view-server.ts` 实现。默认分发模式为 `"fork-image"`（仅显式 `MEDIA_TRACK_DISTRIBUTION=local-source` 时退回旧源码自更新并挂载 `autoUpdate`）。容器模式直接请求 OCI/GHCR Registry v2 manifest 与 config blob（307 跨源重定向剥离 `Authorization` 头），提取 `org.opencontainers.image.revision`、版本号与构建时间并与容器内 `/app/BUILD_COMMIT` 比对；使用 `globalThis` 跨 chunk 缓存（成功 30 分钟 / 网络不可达 5 分钟 / 401·404 10 分钟）、Singleflight、SWR 与 15 秒手动检查冷却，在侧栏徽章与「设置 → 更新」展示「检测到新镜像，请更新容器」及 `pull && up -d --force-recreate` 命令。

## 4. 代理和所有权
- 主代理负责需求、设计、接口、文档、审查与集成，不将文档工作分给开发代理。
- 所有编码代理和专职代码审核代理使用 `metapi/deepseek-v4.1-flash`，思考强度为 high（用户于2026-11-16更新）。不设代理人数上限，按文件所有权和依赖并行；共享文件仍须单一所有者。
- 每名开发代理只实现一个功能，使用全新上下文；完成任务后结束，不接续其他功能。
- 专职审核代理不修改业务实现，报告可复现问题、严重性、文件和测试建议；开发者自行修复，主代理决定合并。
- 开始前明确文件所有权，不修改其他代理所有的文件。共享 domain/repository/runtime/index/package 文件每轮只有一个所有者。
- 不擅自 commit/push、改其他分支或重置工作区。提交由主代理完成，禁止覆盖他人改动。

## 5. 不变量与数据/运行约束
- **PostgreSQL 唯一持久化来源**：PostgreSQL 是任务、扫描进度、导入、整理、消息游标与摘要记录的持久化来源（含 22 张核心表 + 17 张 `library_*` + `messaging_jobs` + `tmdb_search_cache`；表结构变更须同步核查 `scripts/fork-migration-policy.json`）。SQLite 开发库已淘汰。Redis 仅作可选摘要缓存，Redis 故障只能降级回 PG，不得丢任务或重复写盘。
- **`pg.Pool` 与并发 DDL 硬约束**：所有新建 `pg.Pool`（含生产代码与测试）**必须挂载 `pool.on("error", ...)`**，防止数据库重启或临时测试库销毁时触发 `57P01` 未捕获异常；`CREATE TABLE IF NOT EXISTS` 并发下必须受 advisory lock 保护；PG 集成测试文件必须串行执行（`--no-file-parallelism`）避免 DDL 死锁。
- **身份键与防伪造**：身份键包含账号、网盘、媒体类型、TMDB ID。文件和目录以 provider ID 为身份，名称不是身份。扫描来源资源使用专用导入事务，不伪造获取或转存成功记录；自动补缺默认关闭，既有作品的开关不被覆盖。
- **整理安全与超时回读**：整理不删除视频，不覆盖其他版本；字幕配对保留语言和 forced 标记。写请求超时后先回读核实。
- **权限根边界**：任意扫描根的授权不能放宽原 acquisition sandbox 根保护。目录关系来自选定根的实际遍历，不能信任客户端传入任意文件 ID。
- **网盘并发与互斥**：同一光鸭账号的写任务互斥，读取共享限速（含 F07a 限流队列、F07b PG 写互斥锁、F07c 401 刷新互斥与代次 CAS）；六盘已有库扫描与整理遵守各盘写范围保护；非网盘准备任务可以独立并发。
- **演练与保密边界**：演练数据库仍含生产文件 ID。演练（`MEDIA_TRACK_REHEARSAL=1`）禁用真实网盘写入、自动 worker、消息连接与 Redis，真实验证仅限单独测试目录。不接触真实生产实例或发布秘密；不要把凭证、数据库转储、个人环境配置写入 Git。

## 6. CI/CD 纯 GHCR 自动构镜流程
- **`.github/workflows/ci.yml`**（`push main` / `PR` / `workflow_call`）：启动 `postgres:16-alpine` + `redis:7-alpine`（强制 `MEDIA_TRACK_CI_REQUIRE_POSTGRES=1`、`MEDIA_TRACK_CI_REQUIRE_REDIS=1`），依次运行 `build:workflow` → `lint` → `typecheck` → `typecheck:migration` → `apps/web` / `apps/desktop` / `workers/tmdb-proxy` 独立 `tsc` → **无数据库 `npm run build:web`**（`MEDIA_TRACK_POSTGRES_URL=""`）→ 非 PG 单测 → **串行全仓 PG/Redis 集成测试**（`--no-file-parallelism --testTimeout=30000 --hookTimeout=30000`）→ `repository-contract-postgres` + `postgres-schema-init` → `image-smoke` 容器 `/api/health` 冒烟。
- **`.github/workflows/docker-autobuild.yml`**（`push main` / `feature/pickarm-v1` / `workflow_dispatch`，忽略纯文档修改）：零外部 Secrets，仅用 `GITHUB_TOKEN` 推送至 `ghcr.io/<owner>/<repo>`；单次 `linux/amd64` `docker buildx build --load`（注入 `BUILD_COMMIT`/`BUILD_VERSION` 与 OCI Labels）→ 启动容器冒烟（`/api/health` 200、`/login` 200、未登录 `/` 重定向）→ 校验同镜像 ID 后推送：`main` 推 `latest` + `edge` + `sha-<12>`，`feature/pickarm-v1` 推 `dev` + `sha-<12>`。
- **`.github/workflows/fork-image.yml`**（`push tags: v*`）：先执行 `ci.yml` 与只读版本预检 → 单次构建与冒烟 → 推 `<tag>`、`sha-<40>`、`latest` 至 GHCR 并校验三者远端 digest 一致 → 发布 GitHub Release。
- **`.github/workflows/release-desktop.yml`**：仅在上游 `fancydirty/mediary-scout` 执行。

## 7. 验证和交付与常用命令速查
- **类型与 lint 规范**：使用 TypeScript 严格类型，不以 `any`、关闭 lint 或删测试来绕过问题。每个功能包含行为测试和相关回归证据；最终执行 workflow build、typecheck、lint、web build 和适当的集成测试。
- **严格区分检查范围**：对本功能的源文件与测试文件一起做严格类型检查；Vitest 转译通过不代表测试类型通过。他人的未完成文件阻塞全局检查时，报告具体位置并单独检查自己负责的完整文件集。Web 功能必须执行 `npx tsc --noEmit --project apps/web/tsconfig.json`，覆盖组件、服务端入口和测试；根目录 `npm run typecheck`（`tsc --noEmit`）只覆盖 `packages/**`，不能作为 Web 功能的类型验证证据。
- **真实夹具与包管理约束**：跨模块测试复用原生注册表、公开 schema 和领域端口构建夹具；不能自造 provider 别名或不兼容的表结构，让实现与错误夹具互相验证。光鸭连接 provider 为 `guangya`。包管理器固定为 npm 与现有 `package-lock.json`；禁止 pnpm/yarn 自动安装、修复或更换依赖布局。共享依赖环境由主代理维护，开发和审核代理只运行现有 npm/npx 命令；缺依赖先报告。
- **如实报告**：不宣称未运行的检查通过。外部环境不可用时写明未验证项，提供可重复运行的检查。每次完成报告：功能、文件列表、测试命令和结果、剩余风险。代码审核通过前不标记任务完成。

### 常用开发与验证命令
```bash
# 依赖与构建
npm ci
npm run build:workflow
MEDIA_TRACK_POSTGRES_URL="" npm run build:web

# 严格类型检查与规范（Web 改动必跑 apps/web/tsconfig.json）
npm run typecheck
npm run typecheck:migration
npx tsc --noEmit --project apps/web/tsconfig.json
npx tsc -p apps/desktop/tsconfig.json --noEmit
npx tsc -p workers/tmdb-proxy/tsconfig.json --noEmit
npm run lint

# Windows / 沙箱环境运行 Vitest（必须加 --configLoader native，避免 .vite-temp EPERM）
npx vitest run --configLoader native <test-files>
# 若 worktree 下 node_modules 为目录联接（Junction），需透传 --preserve-symlinks：
node --preserve-symlinks --preserve-symlinks-main ./node_modules/vitest/vitest.mjs run --configLoader native <test-files>

# 非 PG 单元测试（与 ci.yml 对齐）
npx vitest run --configLoader native --exclude '**/*.pg.test.ts' --exclude '**/*.postgres.test.ts' --exclude '**/*-postgres.test.ts' --exclude 'packages/workflow/src/postgres-schema-init.test.ts' --exclude 'packages/workflow/src/library/library-import.test.ts' --exclude 'packages/workflow/src/library-scanner.test.ts' --exclude 'packages/workflow/tests/fork-migration.test.ts' --exclude 'apps/web/lib/workflow-runtime.acquisition-bindings.test.ts' --exclude 'apps/web/lib/workflow-runtime.acquisition-naming.test.ts'

# 部署更新与忘记密码逃生口
docker compose -f docker-compose.fork.yml pull web && docker compose -f docker-compose.fork.yml up -d --force-recreate web
docker compose -f docker-compose.fork.yml exec -T web cat BUILD_COMMIT BUILD_VERSION
docker compose -f docker-compose.fork.yml exec web node scripts/reset-password.mjs <用户名>
```
