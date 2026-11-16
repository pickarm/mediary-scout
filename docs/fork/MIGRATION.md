# 数据库副本演练与切换计划

状态：工具开发与隔离验收中。本文描述可复现步骤；生产切换和真实网盘验证尚未执行。

## 工具运行位置

在安装了 Node.js、现有 npm 依赖的开发机运行工具。先执行 `npm run build:workflow`，使原生 schema 初始化入口可用。NAS 的应用镜像用于运行巡影，迁移工具不依赖镜像内存在源码或 npm 工具链。`pg_dump`、`pg_restore` 计划由另行安装的 PostgreSQL 客户端执行。

工具读取环境变量中的 URL。下文中的源库和副本均应先使用独立测试数据库；不要把真实连接串放进命令历史、Git 或报告。清单、门禁结果、临时 env 与备份保存到仓库外的受限目录。

## 副本检查

设置 `MEDIA_TRACK_MIGRATION_SOURCE_URL` 和 `MEDIA_TRACK_MIGRATION_COPY_URL`。预检只连接副本，源 URL 用于拒绝源与副本同库。副本限于本机；非本机副本必须同时设置 `MEDIA_TRACK_MIGRATION_ISOLATED_TEST_DB=1`，并在专用策略文件的 `isolatedHosts` 中明确列出地址，不能把生产地址加入演练白名单。

先从尚未升级的副本生成离线清单，再做只读预检。`COPY_MANIFEST` 和 `GATE_RESULT` 是仓库外的文件路径占位符。

```sh
node scripts/fork-migration.mjs inventory --role copy --out COPY_MANIFEST
node scripts/fork-migration.mjs preflight --manifest COPY_MANIFEST
```

清单记录表结构、数量与内容指纹，核验包括原有作品、任务、连接、设置和追更相关记录；不输出原始业务载荷、凭证或网盘文件 ID。同一副本的清单只能证明升级前后保持，不能证明它与源库克隆一致。若需将源库与恢复副本比较，可在另行授权的只读窗口设置 `MEDIA_TRACK_MIGRATION_ALLOW_SOURCE_READ=1`，使用 `inventory --role source` 获取源清单。本轮开发验收不连接生产源库。

确认目标为隔离副本后，设置 `MEDIA_TRACK_MIGRATION_ALLOW_SCHEMA_WRITE=1`，执行原生幂等初始化并重新核验：

```sh
node scripts/fork-migration.mjs schema-init --manifest COPY_MANIFEST
node scripts/fork-migration.mjs verify --manifest COPY_MANIFEST
```

任何旧数据指纹差异都应先查明原因。不要通过重新生成基线清单来掩盖差异。

## 禁写盘演练

副本仍含真实 provider 文件 ID，必须使用假适配并关闭所有 worker。工具构造独立环境，固定 `MEDIA_TRACK_REHEARSAL=1`、`MEDIA_TRACK_INPROCESS_WORKER=0` 及假 workflow/storage/agent，移除生产适配凭证。

```sh
node scripts/fork-migration.mjs rehearsal
node scripts/fork-migration.mjs rehearsal --write-env TEMP_ENV_FILE
```

检查输出的镜像名、端口与副本地址，再采用输出的 `docker run` 计划启动隔离容器。镜像标签必须替换为实际存在的受验版本；临时 env 文件含副本连接信息，使用后按本地敏感文件处理。不要直接复用生产部署目录的 `.env`。

`rehearsal --execute -- COMMAND ...` 可以在受限环境中运行指定命令；仅用于可信的本地验收命令，不会自动赋予真实网盘权限。

## 切换与回退计划

以下命令输出计划，不执行备份、恢复、生产切换或回退：

```sh
node scripts/fork-migration.mjs backup-plan
node scripts/fork-migration.mjs restore-plan
node scripts/fork-migration.mjs switch-plan
node scripts/fork-migration.mjs rollback-plan
```

正式切换前，需要完成真实测试目录验证、可恢复备份和发布门槛。停止旧实例的所有 worker、定时器、updater，并断开旧应用连接；不能只关闭网页。然后运行 `gate`，将 JSON 输出保存到仓库外，再用 `switch-plan --gate GATE_RESULT` 检查计划条件。

`gate` 检查当前数据库的其他连接及专用 advisory lock；它是检查时刻的证据，应用并不持续持有该迁移锁。必须通过部署管理保证旧实例停写，不能把一次门禁通过当作永久互斥。计划中的人工确认变量只有在相应步骤实际完成后才能设置。

回退前先停止全部新实例 worker 和定时器，核验没有其他写入者，再按计划恢复数据库并启动指定旧镜像。网盘已经发生的移动或改名不能靠恢复数据库逆转；需要保留整理操作清单与回读结果，先核对现场。
