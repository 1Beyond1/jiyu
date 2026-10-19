# 集屿 Jiyu

[![CI](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml/badge.svg)](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml)

让每一份文件都有归处。面向个人 VPS 的文件收集与整理工作台。

作者与维护者：[1Beyond1](https://github.com/1Beyond1) · [GitHub 仓库](https://github.com/1Beyond1/jiyu)

**当前阶段：可交互的前端原型，等待视觉风格确认。不是可用于生产的文件服务。**

## 本地运行

需要 Node.js 22.12+（建议 Node.js 24）。使用 npm 和唯一的 `package-lock.json`：

```powershell
npm ci --cache .cache/npm
npm run dev
```

打开 http://127.0.0.1:5173 。服务器只监听本机。

```powershell
npm run check   # TypeScript 检查
npm run build   # 检查并生成 dist/
npm run preview # 预览构建结果
```

## 这版可以体验什么

- 工作台总览、任务状态、最近文件与动态。
- 创建收集、筛选任务、暂停/恢复收集、生成演示收集链接。
- 无需登录的提交页，选择/拖入文件、校验格式与单文件大小，提交元数据。
- 文件搜索、按收集与类型筛选、多选、标记已整理、导出 CSV 清单。
- 批量命名规则、变量、扩展名保留、重名检查与结果预览。
- 悬浮 AI 助手的交互演示，可显示进度和进入重命名预览。
- 存储方案展示、显示名称设置、导出工作台记录、恢复演示。
- 桌面和移动端布局。

## 原型边界

数据存储于当前浏览器的 `localStorage`，为保留更名前的演示数据，兼容沿用键 `guiji.workspace.v1`。同源标签页间同步；不同设备与浏览器间不共享。

提交页只读取 `File.name` 和 `File.size` 等元数据，不上传、不读取正文、不保留文件内容。示例总量与存储容量用于视觉演示，文件列表展示其中的部分样本。分享链接只适合当前本机、同浏览器演示。

AI 是本地规则演示，未连接真实模型。网盘、S3、认证、加密、备份和真正的文件下载都未实现。

## 项目管理

- [项目计划与目录规则](docs/PROJECT.md)
- [技术选型与部署规划](docs/ARCHITECTURE.md)
- [界面风格与交互约定](docs/DESIGN.md)
- [开发约定](AGENTS.md)

只有一份应用源码。`node_modules/`、`.cache/`、`.artifacts/`、`dist/` 均为可再生成内容，已忽略；生产上传、数据库、密钥和备份不得放入源码。

主分支为 `main`。日常改动在本地构建通过后直接提交并推送到 `main`，GitHub CI 在推送后自动检查；需要隔离的大改动再使用分支或 PR。具体 Git 操作见[项目管理约定](docs/PROJECT.md#git-管理)。

当前没有部署到 VPS；确定风格后先完成本地存储 MVP，再接网盘与真实 AI。
