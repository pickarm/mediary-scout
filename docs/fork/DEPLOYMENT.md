# Fork 镜像部署与验证

状态：已完成全仓库静态检查、单元/集成回归、默认强制登录认证以及 GHCR 自动构建流程改造。真实平台（微信/飞书/Telegram）收发与真实网盘写入验证仍建议先在独立测试目录运行；数据库迁移演练与历史交付记录见 [DELIVERY-20261116.md](DELIVERY-20261116.md) 与 [DELIVERY-20261125.md](DELIVERY-20261125.md)。

## 运行形态

一个 `ghcr.io/pickarm/mediary-scout`（`linux/amd64`）应用容器同时承载 Web 与进程内 worker，外接现有 PostgreSQL、PanSou，以及可选 Redis。部署使用 `docker-compose.fork.yml`；NAS / VPS 不需要检出源码、安装 npm 或挂载 Docker socket。

在部署目录放置 [`docker-compose.fork.yml`](../../docker-compose.fork.yml) 和本机 `.env`，填写外部服务地址、所需元数据与模型配置（不要把 `.env`、访问令牌或备份提交到 Git；网盘连接在网页「设置 → 网盘」管理）：

```dotenv
MEDIA_TRACK_POSTGRES_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE_NAME
PANSOU_BASE_URL=http://PANSOU_HOST:PORT
REDIS_URL=redis://REDIS_HOST:6379

# 镜像来源与标签：默认拉取 ghcr.io/pickarm/mediary-scout:latest（可选 edge / sha-... / 固定版本标签）
# MEDIA_TRACK_IMAGE=ghcr.io/pickarm/mediary-scout
MEDIA_TRACK_IMAGE_TAG=latest
WEB_PORT=3000
```

容器内的 `localhost` 指容器自身，外部数据库和 PanSou 应使用容器可达的服务地址。Redis 不可用时退回 PostgreSQL，不能把 Redis 当成任务备份。

```sh
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d web
docker compose -f docker-compose.fork.yml ps
docker compose -f docker-compose.fork.yml logs --tail=100 web
```

应用以 `/api/health` 检查数据库读取是否可用。镜像使用 Fork 更新来源，设置页展示 `pull` 和 `--force-recreate` 命令；不启用原来依赖本地源码构建的 updater。

## 登录与访问控制配置

Fork 默认启用**全站强制账号密码登录**，无论是直接暴露公网 IP 端口、走反向代理还是局域网访问，未持有有效 `mt_session` 会话都会重定向至 `/login`（仅 `/api/health`、`/api/auth/*` 及自带令牌守卫的 `/api/workflows/*`、`/api/agent/*`、`/api/update/busy`、`/api/update/hold` 例外）。

- **首次初始化方式**：
  1. **网页端一次性认领（默认开启）**：首次打开 `http://<HOST_IP>:3000/login` 设置站主用户名与密码（若原库已有 `acct_default` 数据和绑定网盘会自动接管保留），设置完成后初始化入口自动锁定。
  2. **环境变量预置（适合自动化部署）**：在 `.env` 配置 `MEDIA_TRACK_ADMIN_USERNAME` 与 `MEDIA_TRACK_ADMIN_PASSWORD`（至少 6 位），启动后首次引导或登录会自动写入站主凭证；**一旦实例已认领或改过密码，环境变量绝不会覆盖现有密码**。
  3. **禁止网页匿名初始化**：设置 `MEDIA_TRACK_DISABLE_WEB_BOOTSTRAP=1` 后，`/login` 不再提供首次创建站主表单，强制走上述环境变量初始化。
- **公开注册与成员管理**：
  - 认领完成后，公开注册**默认关闭**（访客请求 `/api/auth/register` 返回 `403`）。
  - 站主可在 **设置 → 账号** 动态切换「公开注册」开关，或在关闭公开注册的情况下直接后台「新建账号」或重置成员密码。
  - 若在 `.env` 中设置了 `MEDIA_TRACK_ALLOW_REGISTRATION=1` 或 `0`，则由环境变量强制锁定，设置页开关禁用。
- **HTTP / HTTPS 会话 Cookie 兼容**：
  - `MEDIA_TRACK_COOKIE_SECURE` 留空时自动依据客户端协议与 `x-forwarded-proto` 判定；直接通过 HTTP 访问公网 IP `:3000` 不会写入 `Secure` 标记，可正常保留登录态；若使用反代且未透传 `x-forwarded-proto`，可显式设为 `1` 或 `0`。
- **兼容逃生开关**：显式设置 `MEDIA_TRACK_MULTI_USER=0` 可退回旧版单用户局域网免登录模式。
- **忘记密码重置**：在部署主机执行以下命令直接重置指定账号密码：
  ```sh
  docker compose -f docker-compose.fork.yml exec web node scripts/reset-password.mjs <用户名>
  ```

## 更新与回退前提

更新前记录当前镜像版本和数据库备份位置。固定版本部署时修改 `MEDIA_TRACK_IMAGE_TAG`，然后拉取并重建；检查运行镜像的 `BUILD_COMMIT` 与发行说明一致。

```sh
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d --force-recreate web
docker compose -f docker-compose.fork.yml exec -T web cat BUILD_COMMIT BUILD_VERSION
```

首次兼容迁移必须先在独立 PostgreSQL 副本演练。副本保留真实网盘文件 ID，演练时强制 `MEDIA_TRACK_REHEARSAL=1`、`MEDIA_TRACK_INPROCESS_WORKER=0` 并使用假适配，禁止真实网盘写入。真实扫描和整理另用物理隔离的专用测试目录。

正式切换前停止旧实例的 worker、定时器和更新器，确认只允许一个实例写网盘。回退数据库之前先停止全部新实例 worker；不能让新旧版本同时操作相同数据或网盘。副本检查、禁写盘演练及切换/回退计划见 [迁移说明](MIGRATION.md)。本文件不是生产切换已获验收的证明。

## 发行门槛

发行必须包含完整类型检查（含 Web 源码与测试）、lint、workflow/Web 构建、原有回归、全部位置的 PG/Redis 集成，以及隔离镜像启动检查。镜像启动与登录门禁冒烟全部通过后才推送版本/SHA/latest 标签，三者应指向同一镜像 ID 与 digest，最后创建 Fork 正式 GitHub Release。

## 自动构建与发行工作流

本 Fork 在 `.github/workflows/` 下提供两条零外部 Secrets、纯基于 GHCR（`ghcr.io/<owner>/<repo>`）的镜像构建流水线（均仅构建 `linux/amd64` 以提升出包速度）：

- **日常/分支自动构建（[`.github/workflows/docker-autobuild.yml`](../../.github/workflows/docker-autobuild.yml)）**：
  - 当代码推送至 `main` 或 `feature/pickarm-v1`（自动忽略纯文档变更 `docs/**`、`README*.md`、`LICENSE`、`release-notes/**`），或在 GitHub **Actions → Auto build Docker image → Run workflow** 手动触发时运行；
  - 仅执行一次 `linux/amd64` `docker buildx build --load`，对接独立 PostgreSQL 与假适配启动容器，连续校验：`/api/health` 返回 200、`/login` 返回 200、未登录访问 `/` 返回 `307`/`302` 重定向，全部通过后才推送同一镜像 ID 至 GHCR：
    - 推送至 `main`：自动同步推送 **`latest`**、**`edge`** 与 **`sha-<12位>`**；
    - 推送至 `feature/pickarm-v1`：推送 **`dev`** 与 **`sha-<12位>`**（不覆盖 `latest`）；
    - 手动触发支持填写自定义 `image_tag` 与勾选 `push_latest`。
- **正式版本发布（[`.github/workflows/fork-image.yml`](../../.github/workflows/fork-image.yml)）**：
  - 仅在推送 `v*` 轻量标签时触发，先完整执行 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) 与只读预检，完成同款单次构建与健康/登录门禁冒烟后，使用 `GITHUB_TOKEN` 向 GHCR 推送 `<tag>`、`sha-<40位>`、`latest` 并验证三者远端 digest 完全一致，最后创建 GitHub Release。

> **首次启用提示**：在仓库 **Settings → Actions → General → Workflow permissions** 开启 **Read and write permissions**；首次推送镜像到 GHCR 后，前往仓库 **Packages → `mediary-scout` → Package settings** 将可见性设为 **Public**，即可免登录 `docker pull ghcr.io/<owner>/mediary-scout:latest`。

## v1.1消息入口配置

设置 → 巡检 → 消息机器人分别配置微信、飞书和Telegram。每个平台属于当前巡影账号，只处理配置的本人私聊；连接默认关闭。微信扫码只绑定凭证，随后显式勾选启用并保存。飞书填写App ID、App Secret及本人open_id，应用使用长连接订阅`im.message.receive_v1`和`card.action.trigger`，开放私聊与机器人发消息权限。Telegram填写Bot Token和本人数值ID，并先与机器人私聊。默认目标网盘只能选择本账号的活动连接；无默认且有多个兼容盘时，机器人提供选择。

支持发送“帮助”“我想看 片名”、直接片名、本网盘分享链接或磁力；回复序号或点按钮确认作品、季和目标盘。资源由原获取流程自动选择。发送“查询”或“查询 任务ID”查看进度和持久结果，“停止 任务ID”取消排队任务；原获取执行中会如实说明不可取消。直转提交后停止只阻止后续识别整理，远端仍可能完成，文件不会删除。

115/夸克/UC/123/天翼/光鸭分享只转存至同品牌；磁力使用115、123或光鸭。直转完整包先落到原授权根内的独立目录，再走原扫描识别和整理；身份不明的文件留在落地区，可在媒体库确认。仅实际整理的新视频触发既有媒体服务器刷新配置。

复用现有进程内worker，无新增端口或sidecar。`MEDIA_TRACK_INPROCESS_WORKER=0`、`MEDIA_TRACK_REHEARSAL=1`或演示模式不启动平台连接；关闭某个平台只停止新消息接收。发送失败仍可在后续私聊主动查询结果。平台真实收发及网盘最终一致性验证仍需独立测试目录，不以协议mock代替实测。
