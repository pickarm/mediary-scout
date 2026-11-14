# 巡影 Fork 技术设计

## 基线与架构
基线：282ef781edf876d2c7ecbadbc8d2bd147759006e。Next.js Web + 进程内 worker，沿用 PostgreSQL 持久化和原有 Agent。新增 library 业务模块，接口依赖注入，测试不访问真实网盘。

## 模块契约
- `library/types.ts`：导入、物理副本与目录绑定契约；扫描、识别、整理各自模块维护其公开类型，避免单一共享类型文件反复冲突。scan root 与目标目录均绑定 accountId/connectedStorageId。
- `library/store.ts`：PG导入事务与物理绑定；`scan-store.ts`维护扫描任务/检查点，`organization-store.ts`维护整理清单。各自使用固定增量DDL锁并先确保所需前置schema。扫描导入不伪造workflow run。
- `library/naming.ts`：无副作用模板解析与渲染。字段 title/originalTitle/year/tmdbId/season/episode/episodeCode/resolution/edition/originalName/ext；仅允许确定的字段，禁止执行表达式、绝对路径、..或路径分隔符注入。ext保留源扩展名。
- `library/scanner.ts`：在授权根下逐目录分页遍历，生成文件事实与父子关系，保存检查点。独立于识别与整理；不调用资源搜索或转存。
- `library/identification.ts`：证据解析、TMDB候选确认与可注入AI建议。无法唯一确定则pending，不改变文件。
- `library/organizer.ts`：根据已确认身份和模板产生/执行清单，字幕配对、碰撞后缀、按ID回读、幂等恢复。永不删除已有资源。
- `library/preparation.ts`：独立领取已入队任务的非网盘准备工作。使用同一原始ResourceProvider，结果绑定run/account/config，消费时仍经过原RealResourceProviderV2与sandbox注册和死链校验。
- 查询扩展：服务端分页摘要、SQL聚合和批量获取；保留原仓储的业务语义，列表不借完整workflow snapshot装配数据。
- Redis可选加速：PG是唯一任务事实；短TTL缓存和通知在提交后写入，失败直接降级。页面单订阅SSE，重新连接先读快照，保留统一轮询后备。

## 持久化与导入
新增扫描配置、扫描任务、目录事实、文件身份、物理绑定、整理操作和准备结果表。所有表含account及storage分区，并有可重复执行的初始化。
导入事务按文件ID去重，同时维护现有media_titles、tracked_seasons、episode_states、episode_copies；季的逻辑目录与各副本实际目录分开。追更开关为向后兼容的可选字段：缺省沿用原行为，扫描新作品显式false，重扫不覆盖已有设置。
目录查找首先按持久绑定的ID，名称仅用于首次发现。共享目录可关联多个作品，不得因暂时仅识别出一个作品就认定为专属；用于后续获取的目录需要明确的专属证据，默认不可作为获取清理目标。双集视频可由同一个文件ID关联多个episode，解除追踪清理库绑定而不删除网盘资源。支持movie/tv的TMDB数值相同而互不污染，anime遵循原有tmdb_tv命名空间。

## 网盘协调与错误处理
光鸭账号级协调入口覆盖转存、整理及扫描请求；写任务单独持有互斥权，读取请求受共享节流和获取优先级约束。不会放开原获取沙箱的protected root。
未知写结果先回读，确认文件ID/位置/名称再标记完成；不依据客户端的乐观返回更新库。鉴权失败冻结任务，限流退避，资源源错误与无资源分开显示。

协调分两层验收：F07a只调度单个HTTP fetch，默认最小起始间隔500ms，同provider账号共享，写优先且每三次写后服务一个等候读取，429响应只冷却后续请求。F07b对整段获取/整理/落盘核对使用PG账号锁；进程退出由数据库释放，锁连接丢失后禁止发出新的写请求。搜索准备不持有写锁。多网盘任务涉及多个光鸭账号时按稳定顺序获取锁，避免互相等待。所有现有生产runner、恢复和临时目录清理须纳入，不能只保护新整理入口。

## Web接口与权限
新增库管理入口，服务端按当前账号验证storage归属。配置保存、扫描操作、身份确认、命名预览、整理操作使用同源认证与CSRF/Origin防护；客户端不能自行决定账号或扩大扫描授权。
前端复用现有CSS token及组件，demo独立使用mock数据。扫描身份确认不引入下载资源的手动选择流程。

接口分工先冻结以下边界，后续单功能开发不得交叉改动：
- `/api/library/configurations`：列出和保存当前账号指定光鸭连接的扫描配置；模板在服务端用F01解析。配置修改遵循活动任务保护。
- `/api/library/directories`：只读、单页目录选择；用已有连接的凭证访问，不触发获取目录自动创建。用户明确选择的任意已有根仅授权扫描和经预览后的整理，不改变获取沙箱。
- `/api/library/scans`：创建、列出扫描；`/api/library/scans/[taskId]`读取有界摘要，POST执行pause/resume/cancel/retry。结果和失败记录使用游标分页，不返回全库事实。
- 身份识别、身份确认和导入由独立接口/后台服务负责，F08a扫描控制不执行识别或导入。整理预览/执行也使用独立入口，只接收任务、模板及已持久化确认的文件ID，不接受浏览器提供的目录关系图或可信身份声明。
- 所有变更入口服务端解析账号并验证同源，客户端仅选择storageId；未知或其他账号的连接均拒绝，不回退默认网盘。演示模式禁止真实修改。
- 新增`@media-track/workflow/library`子入口集中导出已审核模块，保留原包入口兼容。Web新增library runtime共享小连接池与单例扫描服务，不复制原worker或创建第二套凭证存储。

整理的生产授权必须回查该任务的持久化配置、扫描事实和F02导入绑定。纯计划函数仅供预览/单测，不形成写权限。执行及恢复前重新验证授权；网盘写请求仍需账号级整任务互斥。

## 部署与迁移
一个standalone应用镜像，外接MEDIA_TRACK_POSTGRES_URL、REDIS_URL、PanSou。源码Fork为pickarm/mediary-scout，用户确认Docker Hub命名空间qicket，镜像为qicket/mediary-scout。GitHub Actions通过DockerHub变量和secret发布linux/amd64，发布前校验镜像启动。Fork发行信息不再要求桌面安装包。
演练模式统一拒绝真实网盘写入并关闭自动worker；先验证数据库导入和只读状态，再在物理隔离的光鸭目录做真实验证。旧实例停写后才能启用新实例。回退数据库前需停止全部新worker。

## 验证
沿用Vitest和上游CI；纯功能测试用注入端口，PG/Redis集成使用一次性服务，真实网盘仅用专用测试目录。采集准备/等待/云盘耗时、SQL次数及分页响应大小，不承诺未经验证的倍数。
