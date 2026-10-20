# 集屿 v0.2 本地存储版

适合单台 Linux VPS、一个管理员和少量并发收集。需要已安装 Docker Engine 与 Compose 插件，域名解析到 VPS，放行 TCP 80/443（可选 UDP 443）。数据库使用本地文件系统，不放 NFS；单个数据目录仅启动一个应用进程。

## 本机运行

安装 Node.js 24.11+（24.x），在仓库根目录执行：

```sh
npm ci
npm test
npm run build
npm start
```

打开 `http://127.0.0.1:3000`。首次页面需要初始化口令：Windows 执行 `Get-Content data/setup-token`，Linux 执行 `cat data/setup-token`。口令只用于创建管理员，完成后文件自动删除。设置至少 12 字符的密码，妥善保存在密码管理器中；不会生成默认账号或默认密码。原型的浏览器演示数据不会导入。

开发前后端时，在第一个终端将 `JIYU_ORIGIN` 设为 `http://127.0.0.1:5173` 后运行 `npm run server:dev`，第二个终端运行 `npm run dev`。Vite 将 `/api` 代理到 3000；Origin 必须与访问页面完全相同。正式环境用后端直接提供 `dist/`，无需 Vite。

## VPS 部署

```sh
git clone https://github.com/1Beyond1/jiyu.git
cd jiyu
cp .env.example .env
```

编辑 `.env` 中的 `JIYU_DOMAIN` 和 `JIYU_ORIGIN`，例如分别为 `files.example.com` 和 `https://files.example.com`，然后：

```sh
docker compose up -d --build
docker compose ps
docker compose exec app cat /data/live/setup-token
```

打开域名，输入上一步的初始化口令并创建管理员。Caddy 自动申请 HTTPS 证书；应用端口 3000 不映射到公网。不要在 `.env` 中填写管理员密码，也不要把初始化口令发给提交者。初始化后创建收集、分享链接，使用另一台设备验证上传，再从管理端下载检查。

数据位于 Compose 命名卷的 `/data/live`，备份位于独立卷 `/backups`。升级、重建容器保留这些卷。**不要使用 `docker compose down -v`**，它会删除卷。需要迁移服务器时，必须迁移完整备份，不能只复制 Git 仓库。

## 配额与运行限制

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `JIYU_ORIGIN` | 本机 `http://127.0.0.1:3000` | 必须与外部页面地址相同；HTTPS 时启用 Secure cookie |
| `JIYU_QUOTA_MB` | 10240 | 文件总配额，含回收站，不代表磁盘实际容量 |
| `JIYU_REQUEST_MB` | 512 | 一次上传的文件正文总量上限；请求封装另有 2 MiB 硬限额 |
| `JIYU_DATA_SUBDIR` | `live` | Compose 数据卷中的子目录，可切换到已恢复的新目录 |
| `JIYU_DATA_DIR` | 本机 `./data` | 非 Compose 时指定持久数据目录 |
| `JIYU_HOST` / `JIYU_PORT` | `127.0.0.1` / `3000` | 非 Compose 时的监听地址；不直接开放裸 HTTP 到公网 |
| `JIYU_TRUST_PROXY` | `false` | 仅在应用只允许可信反向代理访问时开启；Compose 内置配置为 `true` |

每个任务另有文件格式、单文件大小、单次数量、任务总容量限制。第一版最多同时处理 4 个上传请求，单次最多 100 个文件，文件总数最多 10000（含回收站）。文件正文不整块读入内存。上传请求最多 10 分钟，失败后保留所选文件可重试；同一个提交编号不会重复保存。

登录尝试每来源每分钟最多 5 次；上传每来源每小时最多 30 次，普通接口每分钟 180 次。Compose 中应用端口不公开，只接收 Caddy 转发，因此显式信任代理提供的客户端 IP。裸机部署默认不信任转发头；开启代理信任时必须限制应用只能被可信代理访问。日志输出不包含令牌、文件名或密码，Docker 日志轮转为每容器 2×10 MB。

## 完整备份

先停止应用，生成数据库与文件一致的完整快照；Caddy 可以继续运行。备份命令检测数据目录互斥锁，在线运行会拒绝。

```sh
docker compose stop app
docker compose run --rm --no-deps app npm run data -- backup /data/live /backups/backup-20261020
docker compose up -d app
```

替换示例日期，每次使用全新备份目录。只有命令成功、目录中存在 `manifest.json` 才算完成。清单包含数据库及每个对象的 SHA-256；文件不一致时失败，不生成有效清单。

备份含管理员密码哈希、收集令牌和文件内容，按私密数据保护。将完整备份目录复制到服务器外：

```sh
mkdir -p ../jiyu-backups
docker compose cp app:/backups/backup-20261020 ../jiyu-backups/backup-20261020
```

把该目录移出项目源码并转存至另一台设备。建议保留最近 5 份完整备份；第一版不会自动删除备份，避免误删唯一副本，请在异地副本验证可恢复后由管理员清理旧备份。元数据 JSON 和 CSV 不包含文件正文，不能替代完整备份。

## 恢复演练与切换

恢复只能写入全新目录；先验证数据库完整性、清单和每个文件的哈希。不会覆盖现有数据，也不会保留旧登录会话。

```sh
docker compose stop app
docker compose run --rm --no-deps app npm run data -- restore /backups/backup-20261020 /data/restored-20261020
```

成功后，将 `.env` 中 `JIYU_DATA_SUBDIR` 改为 `restored-20261020`，运行 `docker compose up -d app`。使用原管理员密码登录，检查任务并下载文件。旧 `/data/live` 暂时保留，可把配置改回 `live` 回退；确认新数据可用、另有完整备份后再由管理员处理旧目录。恢复需要足够磁盘空间存放新旧两份数据。

## 释放回收站空间

第一版管理页只软删除和恢复，不提供在线永久删除。需要释放空间时，停止应用，运行以下命令。它会先生成新的完整备份；备份成功后才永久清理回收站文件，且必须显式传入确认参数。

```sh
docker compose stop app
docker compose run --rm --no-deps app npm run data -- prune-trash /data/live /backups/before-prune-20261020 --confirm-delete
docker compose up -d app
```

若当前已切换数据目录，替换上面的 `/data/live`。清理后只能通过完整备份恢复，无法从页面恢复。

## 升级

先备份，再 `git pull --ff-only` 和 `docker compose up -d --build`。查看 `/api/health` 或 `docker compose ps`。重启时会清理中断批次的临时对象，已提交文件由数据库引用保护。第一版不自动升级数据库版本；遇到更高 schema 会拒绝启动。

## 当前边界

- 已实现本地持久存储、管理员认证、公开提交、下载、校验哈希、批量整理、回收站和离线备份恢复。
- OneDrive、S3、WebDAV 仍为接入计划；悬浮助手使用本地规则，未连接真实模型，也不发送文件正文。
- 接受格式按扩展名校验，不提供病毒扫描、文档解析或内容类型鉴定；文件下载使用附件及不可嗅探响应，上传目录不对外提供静态访问。
- HTTPS 保护传输；磁盘加密、宿主机权限、异地备份和服务器监控由部署者管理。没有端到端加密，不应作此承诺。
- Node.js 24 当前内置 SQLite 仍有实验性提示；项目限定 24.x 并在 CI 执行数据与容器测试。升级运行时前先备份并演练恢复。
