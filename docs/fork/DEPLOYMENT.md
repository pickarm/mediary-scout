# Fork 镜像部署与验证

状态：开发验证中。镜像配置存在不表示镜像已发布；首次使用前须确认对应正式版本已经完成镜像构建、启动验证和发布。

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

发布凭证仅在 CI Secrets 中使用。开发代理只准备配置和测试，不执行推送、发布、生产迁移或真实网盘操作。
