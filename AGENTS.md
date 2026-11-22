# 集屿（Jiyu）开发约定

## 产品定位与设计

- 产品：部署在个人 VPS 的文件收集与整理工作台，单仓单服务架构（Fastify + Node 内置 SQLite + React/Vite）。
- 中文界面；视觉为“暖珊瑚 · 亲和”：暖白底、珊瑚强调、无衬线粗体标题，状态色一色一义。颜色、字体和间距统一由 `src/styles.css` 管理。
- 开始大改动前先阅读 `docs/PROJECT.md` 和 `docs/ARCHITECTURE.md`，沿用既有目录结构与数据边界。

## 目录地图与架构边界

- `src/`：前端 React + TypeScript 应用。
  - `src/components/`：通用 UI 基础组件。
  - `src/features/`：按业务功能拆分的页面与面板（收集、材料核对、文件、归档、存储、设置、AI 助手等）。
  - `src/lib/`：纯函数与客户端 API 封装（部分纯函数如 `collections.ts`、`materials.ts`、`participants.ts`、`submission-naming.ts` 由服务端复用；若新增被 `server/` 导入的 `src/lib/*` 文件，必须同步更新 `Dockerfile` 运行时 `COPY` 清单）。
  - `src/types.ts`：前后端共享的数据结构定义。
- `server/`：Node 24（`--experimental-strip-types`）Fastify 服务端、SQLite 持久化（`PRAGMA user_version=5`）、分片上传、归档、备份 CLI、云同步适配、AI 编排及集成测试。
- `public/`：静态资源。
- `docs/`：项目计划、架构决策、界面设计与部署运维文档。
- `scripts/`：辅助脚本（演示启动、提交打包）。
- 严格遵循单仓单应用原则：不创建 final/v2/backup 等源码副本，不提前创建空服务或 packages。
- 正式任务和文件由服务端持久化，不导入旧浏览器演示数据。尚未实测联调的外部网盘和模型必须如实标明边界，不把模拟结果当真实功能。

## 数据、密钥与临时目录约定

- 上传正文、数据库、密钥、日志、测试截图与临时验证目录均不得进入源码或 Git（均已纳入 `.gitignore`）。
- 临时脚本、诊断或中间文件统一放入 `.tmp/`（历史截图/演练产物在 `.artifacts/`），任务完成后及时清理。
- npm 是唯一包管理器，保留 `package-lock.json`，不增加其他锁文件。引入新依赖前先确认 Node/浏览器原生 API 是否足够。

## 常用开发、检查与测试命令

- `npm run dev` / `npm run server:dev`：前后端分离开发模式。
- `npm run check`：前后端 TypeScript 类型检查（`tsc -b`）。
- `npm run format` / `npm run format:check`：Biome 代码格式化与 CI 格式检查（配置见 `biome.json`，2 空格缩进、单引号、无分号、LF 换行、100 列宽）。
- `npm run lint`：Biome 静态检查。
- `npm test`：运行 `src/lib/*.test.ts` 与 `server/*.test.ts` 全部原生 Node 单元/集成测试。
- `npm run build`：类型检查并构建前端 `dist/`。
- 修改代码后必须运行 `npm run format:check`、`npm run check`、`npm test` 与 `npm run build`。

## Git 与发布规范

- Git 主分支为 `main`，远端为 `1Beyond1/jiyu`；大改动使用独立特性/整治分支，避免直接污染 `main`。
- Commit Message 遵循 Angular 规范（如 `feat:`、`fix:`、`style:`、`chore:`、`docs:`、`test:`）并使用中文描述。
- 提交作者使用本仓库配置的 `1Beyond1` 和 GitHub 隐私邮箱；未经用户要求不添加其他作者或 `Co-authored-by`。
- 日常提交与推送不等于版本发布；仅在用户明确要求发布时打版本标签或创建 GitHub Release。
- 严禁强制推送覆盖已有历史；提交前检查 `git status` 与暂存区，确保缓存、构建产物、临时目录、上传正文和密钥均未进入提交。
