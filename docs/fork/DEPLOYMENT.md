# Fork 镜像部署与验证

状态：代码及amd64镜像隔离验收完成。用户于2026-11-16另行要求发布当前镜像，现已发布[Docker Hub](https://hub.docker.com/r/qicket/mediary-scout/tags)的`v2026.11.16`、提交SHA标签和`latest`，均来自审核提交`f3e8a54`且摘要一致。真实网盘验证仍未完成，发布不代表生产验收；详情见[交付记录](DELIVERY-20261116.md)。

## 运行形态

一个 `qicket/mediary-scout` 应用容器同时承载 Web 与 worker，外接现有 PostgreSQL、PanSou，以及可选 Redis。使用 `docker-compose.fork.yml`；NAS 不需要检出源码、安装 npm 或挂载 Docker socket。

在部署目录放置该 compose 文件和本机 `.env`，填写外部服务地址、所需元数据与模型配置。不要把 `.env`、访问令牌或备份提交到 Git。网盘连接仍在设置页管理。

```dotenv
MEDIA_TRACK_POSTGRES_URL=postgresql://USER:PASSWORD@DATABASE_HOST:5432/DATABASE_NAME
PANSOU_BASE_URL=http://PANSOU_HOST:PORT
REDIS_URL=redis://REDIS_HOST:6379
MEDIA_TRACK_IMAGE_TAG=RELEASE_TAG
WEB_PORT=3000
```

`RELEASE_TAG` 必须替换为已经发布的版本；也可使用 `latest`。容器内的 `localhost` 指容器自身，外部数据库和 PanSou 应使用容器可达的服务地址。Redis 不可用时退回 PostgreSQL，不能把 Redis 当成任务备份。

```sh
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d web
docker compose -f docker-compose.fork.yml ps
docker compose -f docker-compose.fork.yml logs --tail=100 web
```

应用以 `/api/health` 检查数据库读取是否可用。镜像使用 Fork 更新来源，设置页提供拉取和重建命令；不启用原来依赖本地源码构建的 updater。

## 更新与回退前提

更新前记录当前镜像版本和数据库备份位置。固定版本部署时修改 `MEDIA_TRACK_IMAGE_TAG`，然后拉取并重建；检查运行镜像的 `BUILD_COMMIT` 与发行说明一致。

```sh
docker compose -f docker-compose.fork.yml pull web
docker compose -f docker-compose.fork.yml up -d --force-recreate web
docker compose -f docker-compose.fork.yml exec -T web cat BUILD_COMMIT
```

首次兼容迁移必须先在独立 PostgreSQL 副本演练。副本保留真实网盘文件 ID，演练时强制 `MEDIA_TRACK_REHEARSAL=1`、`MEDIA_TRACK_INPROCESS_WORKER=0` 并使用假适配，禁止真实网盘写入。真实扫描和整理另用物理隔离的专用测试目录。

正式切换前停止旧实例的 worker、定时器和更新器，确认只允许一个实例写网盘。回退数据库之前先停止全部新实例 worker；不能让新旧版本同时操作相同数据或网盘。副本检查、禁写盘演练及切换/回退计划见 [迁移说明](MIGRATION.md)。本文件不是生产切换已获验收的证明。

## 发行门槛

发行必须包含完整类型检查（含 Web 源码与测试）、lint、workflow/Web 构建、原有回归、全部位置的 PG/Redis 集成，以及隔离镜像启动检查。镜像启动通过后才推送版本/SHA/latest 标签，三者应指向同一镜像，最后创建 Fork 正式 release。

自动发行凭证保存在 CI Secrets。本次用户授权的本地发布由主代理将凭证通过标准输入交给Docker，使用临时Docker配置并在结束后清理。开发代理不执行发布、生产迁移或真实网盘操作。

## 自动构建与发行工作流

本 Fork 在 `.github/workflows/` 下提供两条镜像构建流水线：

- **日常/分支自动构建（[`.github/workflows/docker-autobuild.yml`](../../.github/workflows/docker-autobuild.yml)）**：
  - 当代码推送至 `main`（自动打标 `edge`）或 `feature/pickarm-v1`（自动打标 `dev`），或在 GitHub **Actions → Auto build Docker image → Run workflow** 手动触发时运行；
  - 仅执行一次 `linux/amd64` `docker buildx build`，利用独立 PostgreSQL 与假适配启动并轮询 `/api/health` 确认可用后，推送同一已验证镜像 ID；
  - 默认免密推送至 **GHCR**（`ghcr.io/<owner>/<repo>:<tag>` 与 `sha-<12位>`），若同时配置了 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` Secrets，也会自动双推至 Docker Hub（默认 `qicket/mediary-scout`，可通过 Repository Variable `DOCKERHUB_IMAGE` 覆盖）；默认不覆盖 `latest`（仅手动勾选 `push_latest` 时更新）。
- **正式版本发布（[`.github/workflows/fork-image.yml`](../../.github/workflows/fork-image.yml)）**：
  - 仅在推送 `v*` 轻量标签时触发，先完整执行 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml) 与只读预检，冒烟验证后向 Docker Hub 推送 `<tag>`、`sha-<40位>`、`latest` 并验证远端摘要完全一致，最后创建 GitHub Release。

## v1.1消息入口配置

设置 → 巡检 → 消息机器人分别配置微信、飞书和Telegram。每个平台属于当前巡影账号，只处理配置的本人私聊；连接默认关闭。微信扫码只绑定凭证，随后显式勾选启用并保存。飞书填写App ID、App Secret及本人open_id，应用使用长连接订阅`im.message.receive_v1`和`card.action.trigger`，开放私聊与机器人发消息权限。Telegram填写Bot Token和本人数值ID，并先与机器人私聊。默认目标网盘只能选择本账号的活动连接；无默认且有多个兼容盘时，机器人提供选择。

支持发送“帮助”“我想看 片名”、直接片名、本网盘分享链接或磁力；回复序号或点按钮确认作品、季和目标盘。资源由原获取流程自动选择。发送“查询”或“查询 任务ID”查看进度和持久结果，“停止 任务ID”取消排队任务；原获取执行中会如实说明不可取消。直转提交后停止只阻止后续识别整理，远端仍可能完成，文件不会删除。

115/夸克/UC/123/天翼/光鸭分享只转存至同品牌；磁力使用115、123或光鸭。直转完整包先落到原授权根内的独立目录，再走原扫描识别和整理；身份不明的文件留在落地区，可在媒体库确认。仅实际整理的新视频触发既有媒体服务器刷新配置。

复用现有进程内worker，无新增端口或sidecar。`MEDIA_TRACK_INPROCESS_WORKER=0`、`MEDIA_TRACK_REHEARSAL=1`或演示模式不启动平台连接；关闭某个平台只停止新消息接收。发送失败仍可在后续私聊主动查询结果。平台真实收发及网盘最终一致性验证仍需独立测试目录，不以协议mock代替实测。
