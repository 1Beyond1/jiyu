# 集屿（Jiyu）项目状态说明

当前版本：`0.5.1`（SQLite schema 6）。

## 已实现的核心能力

- **收集、归档克隆与模板迁移**：支持单次 / 补交收集、自定义表单字段、应交名单与参与人台账、任务归档与一键复制、管理员线下补录（`offline-upload`）、以及标准 `jiyu-template-v1` JSON 模板导入导出（严格剔除名单、截止日期、令牌、提取码与存储凭证）。支持可选 4–8 位访问提取码（单 IP 指数退避、跨 IP 全局保护与单任务并发在途上限，解锁前零信息泄露）与「仅允许应交名单内标识提交」防枚举准入开关、纯本地 SVG 二维码与分享卡片下载、自动命名规则（含 `{材料项}`）、4 MiB 分片断点续传（逐片 SHA-256 校验、24 小时保留与清理宽限期防 TOCTOU）及按凭证信任链聚合的个人私密回执查询/整批替换。
- **逐人逐材料核对与多渠道 Webhook 催交**：支持最多 8 项必需/选填材料清单、提交页逐文件归属选择、管理端材料矩阵、左右分栏连续审阅工作台（内联图片/PDF/小体积 UTF-8 文本与 DOCX 即时预览 + 键盘快捷键 + 保存并跳转下一位待核对）、冲突与版本失效守卫及 CSV 台账导出；支持零外发一键催交话术，以及飞书 / 钉钉加签 / 企业微信 / 通用 HMAC 多渠道 Webhook 引擎（公网 HTTPS + SSRF 校验、AES-GCM 凭证加密、聚合防刷屏、单渠道异步队列与脱敏日志），支持按任务配置截止前 24h/12h/6h/1h 幂等自动催交预警（`lastSentDeadline` 持久化防重启重复）与核对页一键手动推送（`POST /api/collections/:id/remind-webhook`）。
- **SQLite schema 6 真分页、回收站与定向归档**：数据库采用 `schema 6` 物化索引列，支持 `GET /api/files` 与 `GET /api/collections/:id/files` 真 SQL 分页、6 种排序、`已整理` 状态筛选、FTS5 中文全文检索与 `ETag` / `304` 增量同步；支持回收站后端分页搜索与仅管理员可见的二次确认在线永久清理（防活跃打包/备份并发误删）、按任务分组判重的批量重命名与撤销、以及 6 种目录结构与绑定 `rulesRevision` 的「仅打包人工核对通过」流式 ZIP 归档下载。
- **界面主题与工程门禁**：支持「跟随系统 / 暖白日间 / 暖炭深色」三态主题持久化切换；通过 `npm run check`、`npm run format:check`、`npm run lint`（0 Error）、`npm test`、`npm run build` 与 `npm audit --omit=dev`（0 漏洞）门禁。
- **多成员权限与安全加固**：支持 `admin` / `editor` / `viewer` 三级角色、工作台所有者（`primary`）保护、受控公开体验模式（`JIYU_DEMO_ENABLED`，2 小时短会话与关闭重启自动吊销、Webhook 全路径静音、管理员任务令牌/名单隔离）、成员并发更新原子合并、Origin + CSRF 校验、scrypt 密码与 SQLite 持久化会话、可配置限流阈值，以及 Caddy 安全头（`Strict-Transport-Security`、`Permissions-Policy`）与 Compose 最小权限容器配置。
- **备份与云端存储**：支持在线完整备份、定时策略、失败残骸自动清理与保留上限（`JIYU_BACKUP_MAX_KEEP`），以及 WebDAV / S3 / 百度网盘 / OneDrive / Google Drive 远端同步（原生校验和省流与 S3 SigV4 `x-amz-checksum-sha256` 完整签名、单飞 OAuth Token 刷新锁防并发轮换失效、指数退避重试，本机始终保留完整副本）。
- **可选 AI 辅助**：支持自填或运营商环境变量预置（`JIYU_AI_*`，含 `JIYU_AI_REASONING_EFFORT`）的 OpenAI Responses / Chat Completions 兼容模型，提供文件名建议、分类标签、一句话材料清单草稿与基于精确引用的材料预核对；所有建议均须人工确认后应用。

## 兼容与运维说明

- **局域网非 HTTPS 访问**：前端内置无 `crypto.randomUUID` / `crypto.subtle` 时的纯 JS 兼容实现与顶层错误边界，内网 HTTP 调试可正常使用；公网部署请配合 HTTPS（仓库提供 `compose.yaml` 与 `Caddyfile`）。
- **容器与依赖**：生产镜像基于 Node.js 24，直接运行 `node --experimental-strip-types server/index.ts`，内置 `poppler-utils` 与 `tesseract-ocr`；不包含测试文件与本地运行数据。
- **验证方式**：在仓库根目录运行 `npm run check`、`npm run format:check`、`npm run lint`、`npm test` 与 `npm run build` 即可执行完整检查。本机未安装 Poppler / Tesseract 时，相关原生命令测试自动跳过，由 Linux 容器环境覆盖。
