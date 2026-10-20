# 技术选型与架构建议

更新：2026-10-20。开始实现本地存储 MVP；网盘和模型适配仍为后续规划。

## 第一版实施决策

- 单仓库增加 `server/`，Fastify 提供同源 API 和构建后的前端，Node.js 24 直接执行 TypeScript，不另加运行时转译器。
- SQLite 使用 Node.js 内置 `node:sqlite`，先不引入 Drizzle；显式事务和 schema 版本维护结构。文件正文流式写入独立数据目录，随机存储键与显示名称分离，记录 SHA-256。
- 仅新增 Fastify、multipart、static、cookie、rate-limit 官方组件，分别负责 HTTP、流式上传、静态页面、会话 cookie 与限流。认证、哈希、文件和 SQLite 使用原生 API。
- 首次初始化需要数据目录中的一次性口令；管理员密码使用 scrypt，随机会话仅保存哈希，cookie HttpOnly / SameSite，写操作使用会话 CSRF 令牌及固定 Origin 校验。
- 分享使用独立随机令牌，公开接口不返回其他提交者或文件列表。服务端重复校验状态、截止、数量、容量、配额；批次先落临时文件，再事务提交，失败清理，重试使用幂等键。
- 第一版批量重命名在 SQLite 事务内原子完成，不移动文件正文；保留审计与撤销映射。回收站仅软删除，释放空间需明确清理。
- 备份/恢复通过停机 CLI 完成：互斥数据目录锁、数据库与文件一致快照、清单哈希校验、恢复到新目录，不覆盖现有目录。上线使用 Docker Compose + Caddy，数据单独挂载。
- 验收以真实 HTTP 集成测试覆盖认证、上传下载字节一致、权限隔离、限额、重复提交、重命名、重启持久化及备份恢复；浏览器检查实际操作入口。

实现依据：[Node.js 24 SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)、[Fastify multipart](https://github.com/fastify/fastify-multipart)、[Caddy 请求体限额](https://caddyserver.com/docs/caddyfile/directives/request_body)、[Compose 健康检查启动顺序](https://docs.docker.com/compose/how-tos/startup-order/)。Node 内置 SQLite 在当前 24.x 运行时仍有实验性提示，限定主版本并通过 CI 验证升级。

## 推荐方案

| 层 | 选择 | 适合本项目的理由 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 工作台交互多，React 便于复用任务、表格与助手；TS 约束元数据和操作；Vite 可生成静态资源，由反向代理或后端提供 |
| 样式 | CSS 设计变量 + Lucide 图标 | 便于确定个人风格，避免先引入大组件库；颜色、留白与密度集中维护 |
| API | Node.js + Fastify + TypeScript | 与前端共用语言；可通过 multipart 插件流式处理上传，校验与权限集中在服务端 |
| 元数据 | SQLite + Drizzle（规划） | 单 VPS 起步，无独立数据库服务；保存任务、元数据、操作与作业记录。文件正文不放数据库 |
| 文件 | LocalStorageAdapter → S3/WebDAV → 网盘授权适配 | UI 和业务不依赖单一存储商；逐个接入、测试与处理限制 |
| 批处理 | 数据库持久作业 + 独立 worker 进程 | 长时间改名/转存不占用请求；记录进度、幂等键、失败与重试，服务重启后可恢复 |
| 部署 | Docker Compose + Caddy | 服务端与 worker 可以复用镜像；HTTPS 与持久卷边界清晰，适合单台 VPS |
| AI | 服务端模型适配层 | 自选模型服务；凭证不发前端。默认只发送经明确选择的必要元数据 |

Vite 的定位与 Node 版本要求见[官方指南](https://vite.dev/guide/)。React 官方也将 Vite 列为从头构建 React 应用的工具选择之一，详见[React 文档](https://react.dev/learn/build-a-react-app-from-scratch)。本机采用 Node.js 24，具体依赖版本由锁文件固定。

Fastify 的上传能力参考[官方 multipart 插件](https://github.com/fastify/fastify-multipart)。正式版必须显式设置每文件大小、文件数、字段数和整请求总字节限制；消费上传流，限制并发，不把大文件整块读入内存。

SQLite 适合服务端管理的中小规模网站，但同一时刻只支持一个写者，参见[官方适用场景](https://www.sqlite.org/whentouse.html)。启用 WAL、短事务和合理的忙等待；多副本或持续高写入时迁移 PostgreSQL。Drizzle 便于统一查询与迁移定义，但迁移仍需验证，不能假设换数据库无需修改。

## 为什么现在不选其他方案

- **Next.js**：如果后续需要重内容展示、SEO 或服务端渲染可以考虑；当前是以登录后操作为主的工具，静态前端配明确的 API/worker 边界更直接。此为项目需求判断，不代表 Next.js 无法自托管或上传。
- **NestJS**：大型团队与复杂领域可受益，本项目起步阶段会增加更多约定和样板。
- **微服务 / Redis / 单独 PostgreSQL**：当前需求不需要先维护多个基础服务。满足单机闭环后再按实际瓶颈扩展。
- **无差别接入所有网盘**：各平台的开放权限、限速和服务区域不同，不能承诺网页登录一次就都能稳定接入。优先官方 OAuth、S3、WebDAV。

## 存储边界

计划接口只围绕 `putStream / getStream / stat / delete / health` 等必要能力。存储键采用随机 ID，显示名称独立存元数据，重命名优先只修改元数据，避免对象存储复制大文件。所有写入需校验任务权限与配额。

第一阶段用 VPS 的本地持久卷；第二阶段接 S3/WebDAV；第三阶段逐个实现 OneDrive / Google Drive 官方授权。国内网盘依据实际官方开放能力评估。rclone 可以作为后续后台传输桥接候选，已有多种[官方列出的后端](https://rclone.org/docs/)，但不会把完整 rclone 管理 API 暴露给上传者，也不把“支持某后端”等同于已完成产品集成。

## 文件安全的实现要求

不是“用了网盘就保证安全”。正式版需落实并测试：

- 管理端身份认证，短期会话，CSRF 防护；收集页只持有高熵、可撤销、限期的上传令牌，不允许列出其他人的提交。
- 服务端重复校验截止时间、文件格式、数量和容量；上传扩展名不等同于内容类型校验；随机存储名，防止路径穿越。
- 上传目录不可执行，下载走鉴权接口，控制 Content-Type/Disposition，避免把用户 HTML/SVG 直接作为可信页面执行。
- 限流、整请求体限额、流式写入、临时文件清理、失败重试与内容校验。病毒扫描按实际需求引入。
- TLS；磁盘/对象存储加密与加密密钥独立管理；OAuth 凭证在服务端加密保存。密钥不能写入 Git、前端环境变量或日志。
- 数据库与文件一致的备份策略、保留上限和恢复演练。备份不与唯一原文件共用一个故障点。
- 批量变更先生成计划，检查重名与权限，确认后执行，写入审计记录与可恢复映射。

## AI 的权限边界

悬浮面板是操作入口，不自动获得整个磁盘和网盘权限。模型给出结构化操作计划，服务端按白名单工具重新鉴权、校验路径和作用范围，前端预览后确认。文件文本与模型输出均视为不可信内容；不能把文件里的指令当系统命令。删除、外发、跨存储搬移应有明确的单独确认。

默认以文件元数据辅助命名。涉及正文识别时单独开启、说明发送范围，设置超时和预算。当前版本不发送模型请求。
