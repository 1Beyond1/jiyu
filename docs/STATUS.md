# 集屿（Jiyu）项目状态说明

当前版本：`0.4.0`（SQLite schema 5，v0.5 功能迭代中）。最新正式发布标签：`v0.4.0`。

## 已实现的核心能力

- **收集与提交闭环**：支持单次 / 补交收集、自定义表单字段、应交名单与参与人台账、可选 4–8 位访问提取码（解锁前不泄露任务详情/材料清单，独立防爆破限流）与「仅允许应交名单内标识提交」防枚举准入开关、纯本地 SVG 二维码与分享卡片下载、零外发一键催交话术（群公告脱敏 / 单人私聊）、自动命名规则（含 `{材料项}`）、4 MiB 分片断点续传（逐片 SHA-256 校验、24 小时保留）与本人私密回执查询/整批替换。
- **逐人逐材料核对**：支持最多 8 项必需/选填材料清单、提交页逐文件归属选择、管理端材料矩阵、左右分栏连续审阅工作台（左侧内联图片/PDF/小体积 UTF-8 文本与 DOCX 即时预览 + 右侧归属/核对表单 + 一键保存并跳转下一位待核对）、冲突与版本失效守卫、以及服务端 CSV 台账导出。
- **文件管理、回收站与批量整理**：支持在线图片/PDF/文本/DOCX 即时预览（含 Range）、本机正文提取与中文全文检索（PDF / DOCX / UTF-8 文本 / 图片 OCR）、6 种排序与 `已整理` 筛选、回收站后端分页搜索与仅管理员可见的二次确认在线永久清理（防活跃打包/备份并发误删）、按任务分组判重的批量重命名与撤销、以及 6 种目录结构（含 `material/owner`、`owner/material`）与绑定 `rulesRevision` 的「仅打包人工核对通过」流式 ZIP 归档下载。
- **界面主题与代码质量门禁**：支持「跟随系统 / 暖白日间 / 暖炭深色」三态主题持久化切换；CI 强制校验 `npm run format:check`、`npm run lint`（0 Errors）、`npm run build`、`npm test` 与容器烟雾测试。
- **多成员权限与安全边界**：支持 `admin` / `editor` / `viewer` 三级角色、工作台所有者（`primary`）保护、Origin + CSRF 校验、scrypt 密码与 SQLite 持久化会话、以及可配置限流阈值。
- **备份与云端存储**：支持在线完整备份、定时策略、失败残骸自动清理与保留上限（`JIYU_BACKUP_MAX_KEEP`），以及 WebDAV / S3 / 百度网盘 / OneDrive / Google Drive 远端同步（本机始终保留完整副本）。
- **可选 AI 辅助**：支持自填或运营商环境变量预置（`JIYU_AI_*`）的 OpenAI Responses / Chat Completions 兼容模型，提供文件名建议、分类标签、一句话材料清单草稿与基于精确引用的材料预核对；所有建议均须人工确认后应用。

## 兼容与运维说明

- **局域网非 HTTPS 访问**：前端已内置无 `crypto.randomUUID` / `crypto.subtle` 时的兼容实现与顶层错误边界，内网 HTTP 调试可正常使用；公网部署仍建议使用 HTTPS（例如配合仓库自带的 `compose.yaml` 与 `Caddyfile`）。
- **容器与依赖**：生产镜像基于 Node.js 24，直接运行 `node --experimental-strip-types server/index.ts`，内置 `poppler-utils` 与 `tesseract-ocr`；不包含测试文件与本地运行数据。
- **验证方式**：在仓库根目录运行 `npm run check`、`npm test`、`npm run build` 即可执行类型检查、自动化测试与前端生产构建。本机未安装 Poppler / Tesseract 时，相关原生命令测试会自动跳过，由 Linux 容器环境覆盖验证。
