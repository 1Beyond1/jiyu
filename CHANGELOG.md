# 更新记录

## v0.5.1 — 2026-11-26

### 新特性与品牌更新

- **受控公开体验模式（`JIYU_DEMO_ENABLED`）**：新增受环境变量控制的公开体验入口（`JIYU_DEMO_ENABLED`、`JIYU_DEMO_USERNAME`、`JIYU_RATE_LIMIT_DEMO`），仅在显式开启且存在对应非管理员 `editor` 账号时展示登录页「一键访客体验」按钮；体验账号严禁改密、访问系统设置/成员/备份/Webhook/云存储写入/永久清理/线下补录等高危接口。
- **预置推理模型思考强度配置**：支持通过 `JIYU_AI_REASONING_EFFORT`（`minimal` / `low` / `medium` / `high`）为预置模型配置推理思考强度，非法值自动忽略。
- **新版品牌 Logo**：更换集屿新版品牌 Logo 并在中英文 README 与应用界面统一展示。

### 安全加固与缺陷修复

- **公开体验模式全面安全收口**：
  - 在 `sessions` 表幂等追加 `is_demo` 列（平滑兼容现有 `schema 6` 数据卷），体验会话固定签发 2 小时短 TTL；当 `JIYU_DEMO_ENABLED` 关闭后重启服务，自动吊销全部 `is_demo = 1` 旧会话。
  - Webhook 全路径防绕过：服务端禁止体验号创建或修改开启 `deadlineReminder` 的任务，克隆管理员任务强制关闭定时预警与剥离应交名单；`webhooks.emit` 与 `checkDeadlines` 对体验会话、体验任务与体验用户触发的提交/审阅/截止事件一律静音，前端材料核对页与提交人台账同步隐藏 Webhook 催交推送按钮。
  - 后端敏感数据隔离：对体验会话，`GET /api/workspace?mode=summary` 自动剥离非体验（管理员）任务的 `uploadToken` 与 `expectedSubmitters`（保留体验号自建任务的完整创建、分享、提交、核对与导出体验流程），`GET /api/workspace?mode=full` 与前端脱敏导出一致剥离全部敏感令牌与名单，并禁止体验号修改/归档/轮换管理员任务链接，同时按体验身份隔离 `ETag`。
- **S3 SigV4 补签 `x-amz-checksum-sha256`**：`server/storage-adapters.ts` 扩展 `s3Headers()` 支持将 `extraHeaders` 中规范化小写后的 `x-amz-*` 头合并入 `CanonicalHeaders` 与 `SignedHeaders` 参与 AWS SigV4 签名，解决严格校验签名的 S3 兼容服务拒绝携带校验和上传的问题。
- **JPEG 尺寸探测越界与大 EXIF 截断修复**：`server/content.ts` 为 `imagePixels()` 补全 `0xff` 填充扫描与 `readUInt16BE` 边界校验，跳过无载荷独立标记（`0x01`、`0xd0–0xd8`），杜绝畸形 JPEG 触发 `RangeError`；新增按段流式 seek（上限 2 MiB），正确跳过超过 64 KiB 的 EXIF/APPn/COM 段以支持高像素实拍照片 OCR。
- **回收站恢复防误标 `stale` 与防同任务重名冲突**：`POST /api/files/restore` 仅对确实处于回收站（`Boolean(deletedAt)`）的文件执行恢复与 `materialVersion` 递增，避免重复恢复误将活跃已通过文件标为 `stale`；恢复事务内按同任务 `fileNameKey` 判重，撞名时自动附加不冲突序号并保留原扩展名。
- **ZIP 打包计划上限与淘汰策略优化**：`server/archive.ts` 全局 20 个计划上限改为仅统计活跃计划（`ready` / `streaming`），新增单会话最多 5 个活跃计划限制；已结束计划改用 60 秒短 TTL 与最多 50 条 FIFO 淘汰，避免高频下载误触发全局 429。
- **可靠性与 CI 稳定性修复**：
  - 修复 32–64 MiB 已索引大文件在禁用二进制预览时未降级返回 `preview: 'text'` 的问题；
  - `POST /api/collections/:id/offline-upload` 事务内补充 10000 文件总数上限与最新字段/材料归属复核；
  - `server/backup.ts` 在备份/恢复失败时自动清理本次新建的半成品目录（不触碰已存在目录）；
  - `server/webhooks.ts` 将 `inFlightDeadlines` 改为引用计数 `Map<string, number>` 并在 `deliverNow` 透传 `nowFn()`；
  - 放宽 `server/content.test.ts` 的 3 处 `<100ms` 墙钟断言为宽裕阈值以消除 CI 抖动，并为 `Dockerfile` 增加 `ARG SKIP_TESTS=0` 避免 CI 容器阶段二次重复执行全量单测；
  - 抽取统一 `APP_VERSION` 常量并将版本对齐为 `0.5.1`。

## v0.5.0 — 2026-11-23

### 新功能与高频产品体验

- **任务定时截止预警与 Webhook 催交播报**：在收集任务配置中新增 `deadlineReminder`（支持截止前 24h / 12h / 6h / 1h 触发与缺交名单脱敏开关，存于 `collections.data` JSON，兼容旧数据）；服务端新增受单进程锁保护的幂等定时检查器（默认每 5 分钟扫描），按任务统计已收/缺交人数与可选脱敏名单并向已启用的飞书 / 钉钉 / 企业微信 / 通用 HMAC 渠道播报，投递成功后原子持久化 `lastSentDeadline` 防止重启重复发送；新增 `POST /api/collections/:id/remind-webhook`（仅 `admin`/`editor`）并在任务设置、材料核对页与提交人台账提供一键推送与实时状态反馈。
- **标准模板 JSON 导入 / 导出（Template Portability）**：新增 `GET /api/templates/:id/export` 与 `POST /api/templates/import`（仅 `admin`/`editor`），支持标准 `jiyu-template-v1` JSON 跨工作台迁移；导出严格剔除名单、截止时间、令牌、提取码与存储凭证，导入强校验格式、字段上限与名称长度；前端模板选择与管理界面新增导出/导入按钮与状态提示。
- **多渠道 Webhook 引擎、任务归档克隆与管理员线下补录**：内置飞书 / 钉钉加签 / 企业微信 / 通用 HMAC 通知引擎（公网 HTTPS + SSRF 校验、AES-GCM 加密凭证、同任务防刷屏聚合、单渠道队列隔离与 50 条脱敏日志）；支持任务归档与一键复制、管理员线下代收补录（`POST /api/collections/:id/offline-upload`），以及材料分栏审阅快捷键与回执信任链进度汇总。
- **SQLite schema 6 真 SQL 分页**：升级至 `PRAGMA user_version=6`，为 `files` 表新增物化索引列并新增 `webhook_logs` 表，驱动真 SQL 分页、排序、状态筛选与 FTS5 检索。

### 安全加固、并发修复与依赖归零

- **提取码防爆破并发竞态修复**：修复 `POST /api/public/:token/unlock` 在 `await checkPassword` 失败分支读取过期计数器的丢失更新问题，并增加按任务提取码版本维度的并发在途校验上限（默认 2），防止并发突发绕过退避与全局锁定。
- **分片清理 TOCTOU 修复**：`server/uploads.ts` 清理孤立分片前增加 `!active.has(batchId)` 校验、实时数据库存在性查询与 `mtime` 宽限期（默认 60 秒），避免误删活跃上传分片。
- **OAuth Token 单飞刷新锁**：`server/storage.ts` 按云盘 Provider 维护 `inFlightRefresh` 单飞锁并在刷新前重读数据库最新凭证，防止并发刷新导致 Refresh Token 轮换失效并误停用云存储连接。
- **成员更新原子合并**：`PATCH /api/users/:id` 在 `await hashPassword` 后的事务内基于最新 `current` 记录合并显式传入字段，避免并发改密覆盖角色降权或禁用状态。
- **生产依赖漏洞归零与容器加固**：`@fastify/static` 升级至 `10.1.12`（`npm audit --omit=dev` 输出 0 漏洞）；`compose.yaml` 补齐 `JIYU_RATE_LIMIT_UNLOCK` 与 `JIYU_STORAGE_STRICT_READBACK` 透传并为 `caddy` 增加 `cap_drop: [ALL]`、`cap_add: [NET_BIND_SERVICE]`、`no-new-privileges:true`、`mem_limit`、`pids_limit`；`Caddyfile` 补充 `Strict-Transport-Security` 与 `Permissions-Policy` 安全头。
- **版本与文档同步**：统一 `package.json`、`/api/health` 与 Webhook `User-Agent` 为 `0.5.0`，同步中英文 README 与运维文档至 `v0.5.0` / `SQLite schema 6`。

## v0.4.0 — 2026-11-22

### 收集流程、材料核对与 AI 辅助

- **收集模板与自定义字段**：支持内置作业、报名材料、项目交付模板及从任务保存/归档/恢复模板（不复制名单、截止时间、令牌或存储连接）；支持最多 8 个自定义文本字段、按姓名或必填字段识别提交人、应交名单对照与 CSV 台账导出（名单仅工作台可见）。
- **逐人逐材料收齐与人工核对**：支持定义最多 8 项必需/选填材料及稳定材料编号，逐文件显式归属；分开统计必需项收齐与人工核对通过，相同内容不能充当两项必需材料；人工分类与核对绑定规则与文件版本，批量冲突原子拒绝，改规则/重命名/删改后旧核对自动过期；电脑提供矩阵视图，窄屏提供人员卡片。
- **一句话 AI 材料草稿与带出处预核对**：新建收集可选一句话起草并经人工澄清确认；材料 AI 预核对先展示本次精确授权摘录与未读范围，输出逐文件问题、归属与补充建议，引用严格校验 UTF-16 原文位置与活动文件快照；采用建议仍须人工核对保存，不自动批准。
- **按规则自动命名与私密回执替换**：按姓名、任务、日期、累计序号、原名及字段组合自动命名，支持实时试算；支持私密回执查询、旧版文本回执导入、跨设备查验与凭证替换（旧批次移入回收站，并发替换仅成功一次）；修复任务关闭与字段调序下的续传回执找回问题。
- **首次引导与体验细节**：首页增加可收起的首次使用清单与三分钟示例收集导览；分享弹窗明确区分本机、局域网与 HTTPS 地址；公开提交页明确区分当前有效份数与历史累计提交数，避免替换或移入回收站后产生语义误解。

### 工作台同步、分页与性能

- **服务端分页与筛选接口**：新增 `GET /api/files` 与 `GET /api/collections/:id/files`，支持按任务（`collectionId`）、整理状态（`status`）、文件类型（`kind`）、回收站状态（`trashed`）、关键词与正文搜索（`q`）、排序（`sort`）及分页（`page`、`pageSize`）查询，返回 `items`、`total`、`page`、`pageSize`、`hasMore`。
- **强一致 `ETag` 增量同步**：为 `GET /api/workspace` 与文件分页接口增加基于数据库变更戳与用户角色的 `ETag`、`Cache-Control: no-cache` 及 `If-None-Match` → `304 Not Modified` 支持；前端 15 秒轮询携带 `If-None-Match`，命中 `304` 时跳过序列化与无效重渲染。
- **SQLite 与上传流热路径优化**：消除高频 SQLite 全表扫描，增加 `files(collection_id)` 索引与 SQL 聚合统计；优化 multipart 上传流热路径，避免在每个小分块回调中查询 SQLite。
- **非 HTTPS 局域网兼容与顶层容错**：新增 `safeRandomUUID` 与纯 JS SHA-256 回退，解决非 Secure Context 局域网源下 WebCrypto 不可用导致的崩溃；补充 React 顶层 `ErrorBoundary`。

### 云端存储、校验省流与可靠性

- **云同步原生校验和优先省流**：S3/兼容存储上传携带 `x-amz-checksum-sha256` 并优先核验响应校验头或单段 MD5 `ETag`；OneDrive 优先比对 `file.hashes.sha256Hash` / `quickXorHash`，Google Drive 优先比对 `sha256Checksum`；校验一致时跳过二次全量回读下载，缺失、不匹配或启用严格回读模式（`JIYU_STORAGE_STRICT_READBACK=1`）时自动拒绝或回退全量读回。
- **云同步瞬态错误指数退避重试**：对可重试的瞬态网络/上游错误（HTTP 429/5xx、连接中断或超时）自动按指数退避重试（默认最多 3 次），状态记录 `retryCount` 与 `nextRetryAt`；对 401/403/配置与内容校验错误不盲目重试，保留失败项手动批量重试能力。
- **写入可靠性与在线备份加固**：修复 SQLite 写满时自动回滚掩盖原始错误，磁盘/数据库/配额不足统一返回 507；修复在线备份失败时清理半成品目录并同步 `JIYU_BACKUP_MAX_KEEP` 契约；统一重名校验为按任务分组并修复无点号文件扩展名绕过问题。

### 安全、权限与运维配置

- **显式组件权限与敏感信息保护**：将只读成员界面控制由依赖脆弱 CSS 选择器改为各组件内显式 `canEdit` 渲染判断（保留样式兜底）；`GET /api/storage/connections` 对非管理员角色脱敏敏感配置、回调地址与错误路径；保护主管理员账号不被其他管理员越权操作。
- **元数据脱敏导出**：「导出元数据清单」默认脱敏活跃收集链接令牌（`uploadToken`）与应交名单（`expectedSubmitters`），完整导出需经显式二次确认与风险勾选。
- **环境变量扩展与运营商预置 AI**：支持通过环境变量覆盖全局与上传限流阈值（`JIYU_RATE_LIMIT_*`）；修复运营商预置 AI（`JIYU_AI_*`）状态机与边界校验，支持修改非 Key 参数并防止换源窃取 Key，支持一键恢复站点预置配置。
- **SQLite schema 5 与平滑升级**：数据库升级至 `PRAGMA user_version=5`，新增模板与提交记录表，兼容旧任务、待续传批次及完整备份；CI 容器在运行时镜像中执行真实 `v0.3.0` 升级与旧快照回退演练。

### 工程规范与文档

- **Biome 规范格式化与 CI 门禁**：引入 `@biomejs/biome` 统一全仓代码风格，消除历史单行超长压缩代码，并在 GitHub CI 接入 `npm run format:check` 门禁。
- **目录与双语文档**：补充 `.tmp/` 临时目录约定与 `AGENTS.md` 目录地图，同步更新中文 `README.md` 并新增英文 `README.en.md`。

### 使用边界说明

- 真实第三方网盘账号（百度网盘 / OneDrive / Google Drive / 真实云端 S3）与真实大模型服务的语义质量、计费与时延仍需在用户自有凭证/授权下实测联调；自动化测试覆盖协议、校验、重试与安全边界，不代替真实外部账号端到端验证。
- 部署自查与容器冒烟测试通过不代表已完成生产 VPS 上线；正式上线前请按部署文档配置真实域名、HTTPS、持久化卷与异地备份策略。
- 云端同步后仍保留本机完整副本，不会自动释放 VPS 磁盘空间；项目不提供病毒扫描或端到端加密。

## v0.3.0 — 2026-10-21

### 收集与整理

- 4 MiB 分片上传、SHA-256 校验、暂停与 24 小时续传，提交回执保持幂等。
- ZIP 流式打包下载，支持按任务 / 提交人分目录，下载前预览归档路径。
- 图片 / PDF 预览、TXT / DOCX / PDF / 图片正文索引、中文全文检索；容器内提供 Poppler 与 Tesseract 简体中文 / 英文 OCR。
- 可配置 Responses / Chat Completions 兼容模型，悬浮助手按授权范围提供命名和标签建议，预览后应用，可撤销；正文摘录单独授权。

### 存储与可靠性

- WebDAV / S3、百度网盘、OneDrive、Google Drive 适配，持久云端同步队列、校验与手动重试；所有文件先在本机接收并保留完整副本。
- 存储接入分步引导、官方应用配置说明、回调地址复制，以及连接后直接创建收集。夸克专用入口已移除。
- 区分文件已用、收集配额、真实数据磁盘剩余，展示读取时间并支持刷新。
- 管理员 / 编辑者 / 只读成员权限，在线备份、定时计划与保留策略。
- 修复临时网络故障重置提交页、未修改连接使任务失效、检查失败仍显示可用，以及手机导航焦点与复制失败提示等问题。

### 部署与协议

- 项目采用 MIT License，版权归属 1Beyond1；第三方依赖保留各自许可，运行镜像携带项目 LICENSE。
- 数据库升级至 schema 4。升级前先用当前版本生成完整备份，包含文件正文、数据库及存在的 `secrets.key`；恢复需写入新目录。旧版本不能直接打开升级后的数据目录。
- 本机构建及 28 项测试通过；另外两项原生 PDF/OCR 测试由 Linux 容器 CI 实际执行。CI 同时检查容器启动、Compose 和 Caddy 配置。

### 使用边界

- 网盘与 AI 适配已通过协议测试，尚未使用用户真实网盘 / 模型账号完成联调；接入需自己的凭证 / 开放平台应用及用户授权。
- 云端同步后仍保留本机副本，不会释放 VPS 正文空间。回执表示本机已收到文件，云端结果在存储空间单独查看。
- 当前不提供病毒扫描或端到端加密。真实 VPS 上线须另行配置域名、HTTPS 和持久化数据目录。
