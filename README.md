# 集屿 Jiyu

[![CI](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml/badge.svg)](https://github.com/1Beyond1/jiyu/actions/workflows/ci.yml)

让每一份文件都有归处。部署在个人 VPS 的文件收集与整理工作台。

作者与维护者：[1Beyond1](https://github.com/1Beyond1) · [公开仓库](https://github.com/1Beyond1/jiyu)

**v0.2 本地存储版**：一个链接集中收集文件，管理员登录后整理与下载。原型已升级为真实文件服务，旧浏览器演示记录不会混入正式数据。

## 可以做什么

- 初始化管理员、登录退出、修改密码并撤销旧会话。
- 创建与编辑收集，设置截止、格式、单文件大小、单次数量和任务容量。
- 分享独立随机链接，暂停、结束、重新开放或更换链接；提交者无需账号。
- 流式上传、进度、失败重试和提交回执；公开接口不提供文件列表或下载。
- 本地文件持久化、SHA-256 校验、鉴权下载、搜索与 CSV 导出。
- 批量命名先预览，服务器原子应用，可撤销；按内容哈希检查重复文件。
- 文件回收站与恢复；离线清理前先生成完整备份。
- 数据库与文件一致备份、校验恢复至全新目录。
- Docker Compose + Caddy、HTTPS、数据持久卷、配额、日志轮转与健康检查。
- 中文暖纸色界面，桌面和手机布局，右下角内置规则助手。

OneDrive / S3 / WebDAV 仍是接入计划。助手没有连接真实模型，不读取文件正文，也不向外部模型发送数据。扩展名校验和内容哈希不等于病毒扫描。

## 本机启动

需要 **Node.js 24.11+（24.x）**，使用 npm 和唯一 `package-lock.json`：

```sh
npm ci
npm test
npm run build
npm start
```

打开 [本机工作台](http://127.0.0.1:3000)。首次读取 `data/setup-token` 中的初始化口令，在页面设置管理员名称和至少 12 字符的密码。没有默认密码。正式数据默认保存在被 Git 忽略的 `data/`；VPS 采用独立持久卷。

```sh
npm run server:dev # 后端监听 3000，修改自动重启
npm run dev        # 前端监听 5173，将 /api 代理到 3000
npm run check      # 前后端 TypeScript 检查
npm run build      # 检查并生成前端 dist/
npm test           # 规则与真实文件服务集成测试
```

分离开发时将服务端 `JIYU_ORIGIN` 设置成实际前端地址，例如 `http://127.0.0.1:5173`。正式运行用 `npm start`，由同一个服务提供前端和 API。

## VPS 部署与运维

```sh
cp .env.example .env
# 编辑域名、外部 HTTPS 地址和配额
docker compose up -d --build
docker compose exec app cat /data/live/setup-token
```

完整步骤、备份恢复、离线清理与升级参见 [部署指南](docs/DEPLOYMENT.md)。不使用 `docker compose down -v` 删除数据卷。元数据导出不包含文件正文，不能替代完整备份。

## 项目管理

一个仓库、一个前端应用与一个实际服务，无源码副本、空 packages 或微服务。前后端共享 TypeScript 数据结构；Fastify 处理 HTTP 与上传，Node 内置 SQLite 保存元数据，文件正文存独立目录。

```text
src/       前端界面、功能组件、共享类型和格式规则
server/    API、认证、持久化、备份 CLI 与集成测试
public/    少量静态资源
docs/      项目、架构、设计和部署说明
```

依赖、构建、缓存、截图、文件正文、数据库与密钥不进 Git 或发布镜像。日常构建与测试通过后直接提交推送 `main`，GitHub CI 自动运行检查和容器启动测试。作者统一使用本仓库的 `1Beyond1` 与 GitHub 隐私邮箱。

- [项目计划](docs/PROJECT.md)
- [技术架构](docs/ARCHITECTURE.md)
- [界面设计](docs/DESIGN.md)
- [开发约定](AGENTS.md)
