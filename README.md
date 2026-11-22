# 集屿 Jiyu

简体中文 | [English](README.en.md)

[![CI](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml/badge.svg)](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

让每一份文件都有归处。部署在个人 VPS 的自托管文件收集、材料核对与整理工作台。

作者与维护者：[1Beyond1](https://github.com/1Beyond1) · [公开仓库](https://github.com/1Beyond1/jiyu) · [更新记录](CHANGELOG.md)

**当前版本 v0.4.0**（SQLite schema 5）：用一个随机链接集中收集文件，提交者无需登录即可断点续传，工作台成员可在同一处完成材料收齐核对、分页检索、批量命名、流式 ZIP 打包、在线备份与可选云端同步。从 `v0.3.x` 升级前请先生成完整备份（schema 5 数据目录不能直接用 v0.3 打开）。

## 界面预览

### 收集任务总览

集中管理进行中、已完成与已截止的收集任务，实时查看必需项收齐进度、人工核对人数、截止时间与本地存储配额。

![收集任务总览](docs/screenshots/collections.png)

### 按人材料核对矩阵

按参与人与材料清单逐项对照收齐状态与人工核对结论，快速筛选缺项或待补交人员并导出 CSV 材料台账。

![按人材料核对矩阵](docs/screenshots/materials-matrix.png)

### 免登录分材料提交页

提交者打开随机分享链接即可填写自定义字段并按材料槽位逐项上传，无需注册登录，自动保留原名与扩展名规则。

![免登录分材料提交页](docs/screenshots/public-submit.png)

## 核心能力

### 1. 灵活收集与材料核对工作台

- **分步创建与收集模板**：内置作业、报名材料、项目交付等模板，支持从现有任务保存、复用、归档与恢复模板（不复制名单、截止时间、令牌或存储连接）。
- **自定义字段与自动命名**：最多 8 个自定义文本字段，按姓名或必填字段识别提交人；按姓名、任务、日期、累计序号、原名及字段组合自动命名并支持实时试算，保留原扩展名并按任务防重名。
- **逐人逐材料收齐与人工核对**：支持定义最多 8 项必需/选填材料；逐文件显式归属，分开统计「必需项收齐」与「人工核对通过」（相同内容不能充当两项必需材料）；核对绑定规则与文件版本，批量冲突原子拒绝，改规则/重命名/删改后旧结论自动过期。桌面端提供矩阵视图，移动端提供人员卡片。
- **提交人台账与私密回执**：内置应交名单对照与 CSV 台账导出（名单仅工作台可见）；提交者凭私密回执可查询进度、导入旧版文本回执、补交或替换对应批次（旧批次移入回收站，并发替换仅成功一次）。公开提交页清晰区分当前有效份数与历史累计提交数。

### 2. 断点续传、检索与高效工作台同步

- **可靠分片上传**：4 MiB 分片、SHA-256 逐片与整批校验、暂停恢复、24 小时断点续传及幂等回执确认；兼容非 HTTPS 局域网环境的纯 JS SHA-256 / UUID 回退。
- **分页筛选与 `ETag` 增量同步**：提供 `GET /api/files` 与 `GET /api/collections/:id/files` 分页筛选接口；`GET /api/workspace` 与文件分页接口支持强一致 `ETag` / `If-None-Match` → `304 Not Modified`，降低 15 秒轮询的序列化与流量开销。
- **正文预览、OCR 与流式归档**：支持图片/PDF 在线预览，TXT/DOCX/PDF/图片正文提取与中文全文检索（运行镜像内置 Poppler 与 Tesseract 简体中文/英文 OCR）；勾选或按筛选结果预览后流式下载 ZIP（支持平铺、按任务、按提交人、任务/提交人四种目录结构，单次上限 500 文件 / 10 GiB）。

### 3. 云端同步、备份与安全权限

- **多云端适配与省流校验**：支持 WebDAV、S3/兼容存储，以及百度网盘、OneDrive、Google Drive 官方授权协议；所有文件先在本机可靠接收并保留完整副本。S3 优先核验 `x-amz-checksum-sha256` 或单段 MD5 `ETag`，OneDrive 优先核验 `sha256Hash` / `quickXorHash`，Google Drive 优先核验 `sha256Checksum`，校验一致时跳过二次全量下载；缺失或开启 `JIYU_STORAGE_STRICT_READBACK=1` 时自动回退全量读回验证。
- **指数退避自动重试**：云同步队列对瞬态网络/上游错误（HTTP 429/5xx、连接超时或中断）按指数退避自动重试（默认最多 3 次，状态记录 `retryCount` 与 `nextRetryAt`），对 401/403/配置与校验错误不盲目重试，保留失败项手动批量重试。
- **权限隔离与数据保护**：管理员 / 编辑者 / 只读成员三级角色，服务端逐请求鉴权 + 前端显式 `canEdit` 组件权限控制；凭证采用服务端主密钥加密存储，非管理员视图自动脱敏云存储配置与错误路径；元数据清单导出默认脱敏 `uploadToken` 与 `expectedSubmitters`，完整导出需二次确认。
- **在线完整备份与部署检查**：支持在线完整快照、定时计划与保留策略（可校验恢复至全新目录）；内置部署检查面板核对文件读写、数据库、磁盘配额、HTTPS、备份目录及 PDF/OCR 工具状态。

### 4. 可选 AI 辅助（默认关闭）

- 支持 Responses / Chat Completions 兼容接口，可由管理员在设置页配置或运维通过 `JIYU_AI_*` 环境变量预置；限定公网 HTTPS（443），禁止内网地址与重定向，凭证加密保存在服务端且不回显。
- 支持悬浮助手批量命名/标签建议、新建收集一句话材料草稿、以及带精确 UTF-16 原文出处的材料 AI 预核对。每次外发均须确认授权范围，正文摘录单独授权，所有建议先预览再由人工确认保存，支持撤销与每日调用次数上限控制。

## 本机启动与开发

需要 **Node.js 24.11+（24.x）**，使用 `npm` 与唯一锁文件 `package-lock.json`：

```sh
npm ci
npm run check
npm test
npm run build
npm start
```

打开 [http://127.0.0.1:3000](http://127.0.0.1:3000)。首次启动读取 `data/setup-token` 中的初始化口令，在页面创建管理员账号（密码至少 12 位，无默认密码）。正式数据默认存放在被 Git 忽略的 `data/` 目录。

常用开发与检查脚本：

```sh
npm run server:dev    # 启动后端开发服务（默认监听 3000，保存自动重启）
npm run dev           # 启动前端 Vite 开发服务（监听 5173，/api 代理到 3000）
npm run check         # 前后端 TypeScript 类型检查（tsc -b）
npm run format        # 使用 Biome 统一格式化代码
npm run format:check  # Biome 格式检查（CI 门禁）
npm run lint          # Biome 静态检查
npm test              # 运行全套前后端单元测试与真实 HTTP 集成测试
npm run build         # 类型检查并构建生产前端 dist/
npm run data          # 离线数据与备份恢复 CLI
```

前后端分离开发时，请将服务端环境变量 `JIYU_ORIGIN` 设为实际前端地址（如 `http://127.0.0.1:5173`）。生产运行只需 `npm start`，由同一个 Fastify 服务同时提供前端静态资源与 API。

## VPS 部署与环境变量

推荐使用 Docker Compose + Caddy 部署自动 HTTPS：

```sh
cp .env.example .env
# 编辑 .env，设置域名、外部 HTTPS Origin、配额等参数
docker compose up -d --build
docker compose exec app cat /data/live/setup-token
```

主要环境变量（完整示例见 [.env.example](.env.example) 与 [部署指南](docs/DEPLOYMENT.md)）：

| 变量名                                               | 默认值                  | 说明                                                |
| ---------------------------------------------------- | ----------------------- | --------------------------------------------------- |
| `JIYU_DOMAIN`                                        | —                       | Caddy 绑定域名（需已解析至服务器）                  |
| `JIYU_ORIGIN`                                        | `http://127.0.0.1:3000` | 外部完整访问 Origin，须与浏览器地址栏一致           |
| `JIYU_HOST` / `JIYU_PORT`                            | `127.0.0.1` / `3000`    | 服务监听地址与端口（容器默认 `0.0.0.0:3000`）       |
| `JIYU_DATA_DIR` / `JIYU_BACKUP_DIR`                  | `./data` / `./backups`  | 数据目录与在线备份目录                              |
| `JIYU_QUOTA_MB` / `JIYU_REQUEST_MB`                  | `10240` / `512`         | 工作台总存储配额与单次请求上限（MiB）               |
| `JIYU_BACKUP_MAX_KEEP`                               | `30`                    | 在线自动备份最大保留份数（1–30）                    |
| `JIYU_STORAGE_STRICT_READBACK`                       | 未开启                  | 设为 `1` 时禁用原生校验和省流，强制云端全量读回验证 |
| `JIYU_AI_BASE_URL` / `JIYU_AI_MODEL` / `JIYU_AI_KEY` | 空                      | 预置模型服务地址、模型 ID 与 Key（三项齐全生效）    |
| `JIYU_AI_PROTOCOL` / `JIYU_AI_DAILY_CALLS`           | `chat` / `50`           | 预置模型协议（`chat`/`responses`）与每日调用上限    |
| `JIYU_RATE_LIMIT_GLOBAL`                             | `180`                   | 全局每分钟限流次数                                  |
| `JIYU_RATE_LIMIT_UPLOAD_MULTIPART`                   | `30`                    | multipart 上传每小时限流次数                        |
| `JIYU_RATE_LIMIT_UPLOAD_CREATE`                      | `60`                    | 分片批次创建每小时限流次数                          |
| `JIYU_RATE_LIMIT_UPLOAD_CHUNK`                       | `180`                   | 分片上传每分钟限流次数                              |

> 注意：切勿使用 `docker compose down -v` 删除数据卷；元数据导出不包含文件正文，不能替代完整备份。

## 项目架构与目录

单仓、单前端应用、单 Fastify + Node 内置 SQLite 服务，前后端共享 TypeScript 类型与规则函数：

```text
src/       前端 React 应用（components/ 通用组件、features/ 业务页面、lib/ 共享规则与 API、types.ts）
server/    Fastify API、认证、SQLite 持久化（schema 5）、分片上传、归档、云同步、AI 编排、CLI 与测试
public/    静态资源
docs/      项目计划、技术架构、界面设计与部署运维文档
scripts/   辅助脚本
```

- [更新记录](CHANGELOG.md) · [部署指南](docs/DEPLOYMENT.md) · [技术架构](docs/ARCHITECTURE.md) · [项目计划](docs/PROJECT.md) · [开发约定](AGENTS.md)

## 使用边界

- 第三方网盘（百度网盘、OneDrive、Google Drive、S3/WebDAV）及外部大模型均已通过协议、校验、重试与安全边界自动化测试，但真实外部账号授权联调、模型语义质量、费用与时延须在您自己的凭证环境下实测确认。
- 云端同步后仍保留本机完整副本（用于在线预览、归档打包与完整备份），不会释放 VPS 磁盘空间。
- 项目当前不提供病毒扫描或端到端加密；生产上线前请自行做好域名、HTTPS、访问控制与异地备份。

## 开源协议

集屿采用 [MIT License](LICENSE)，Copyright (c) 2026 1Beyond1。第三方依赖遵循各自的开源许可证。
