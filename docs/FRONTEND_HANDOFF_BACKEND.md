# 前端重写交接（给后端 / Codex）

2026-10-25，Claude 完成集屿前端重写的这一轮：暖珊瑚视觉系统，以及发起人 / 提交者两种身份的关键流程。**`server/` 与 API 未改**。改动集中在 `src/styles.css`（token + 文件末尾 Visual system v2 层）、`src/features/materials.tsx`、`src/features/submission.tsx`、`src/features/submission-receipt.tsx`、`index.html`、`AGENTS.md` 视觉条目。`npm run build` 通过，`npm test` 51 通过 / 3 跳过 / 0 失败。**未提交 Git**；上一轮 collection-draft 的未提交改动仍在工作区，未动。

## 1. 新前端依赖什么

- 材料状态：前端用 `src/lib/materials.ts` 的 `materialParticipants / materialReviewState`（客户端计算）给矩阵着色；台账 CSV 由服务端 `/api/collections/:id/materials/export` 生成。**两边的判定规则必须保持一致**；后端改状态口径时请同步这个文件，或提供服务端计算好的逐人逐项状态。
- 提交页：每份文件的材料归属仍通过上传元数据 `materialIds[]`（与 `files` 同序）提交，载荷未变。材料卡只是在前端预先设好归属。
- 回执：`GET /api/public/:token/receipts/:id`（头 `X-Receipt-Key`）返回的 `files[].materialState / materialNote` 被提交者页面直接展示。
- 一句话草稿：`/api/ai/settings`（`enabled, keyReady, testMode, baseUrl, revision`）、`POST /api/ai/collection-draft`；创建时 `draftConfirmation` 随 `POST /api/collections` 提交。
- AI 预核对：沿用 `material-ai.tsx` 的既有接口，无模型时显示“模型尚未配置”。

## 2. 实测发现的后端侧问题 / 建议（非阻断）

1. **服务重启后管理员会话失效**，需要重新登录（隔离实例 3012 观察到）。如果这是设计（会话只存在内存），请在文档写明；如果不是，建议持久化会话或延长有效期。
2. **状态判定在前后端各写一份**（见上）。建议服务端在 workspace 或单独接口返回逐人逐项状态，前端只做展示，避免口径漂移。
3. **没有真实模型时无法在正常界面体验 AI 流程**。内部注入只存在于测试和 `.artifacts/j-material-ai-qa/run.mts`。若比赛演示需要，建议提供一个**明确标记、默认关闭、只能本机开启**的演示注入开关，而不是在公开界面开放测试开关。
4. 公开提交接口的错误文案会直接显示给提交者（手机端），建议统一为“发生了什么 + 下一步怎么做”的短句。

## 3. 已实测（隔离实例 http://127.0.0.1:3012，数据在 `.artifacts/frontend-rewrite-20261025/data`）

桌面用模板建任务（名单 A01/A02）→ 390px 手机按材料卡上传两份并提交，下载私密回执 → 桌面矩阵 A01“待人工核对”、A02“缺项”，宽屏抽屉中把作品说明记为“需补充” → 手机凭回执看到“需补充”和说明，替换本批 → 桌面：新文件均“待人工核对”、旧结论不继承、旧批次进回收站 → 导出台账 CSV。正式 `data/` 与原 3002 样例未触碰。

## 4. 边界

`src/**` 前端文件由前端负责，后端请勿同时改同一组件；接口调整请保持兼容或先写在本文件。项目 Git 约定（作者 1Beyond1、直接推 main）由用户决定何时执行，本轮未提交。

## 5. Codex 后端回执（2026-10-25）

control_run_id=backend-alignment-20261025-1。本轮仅后端、服务端测试、文档与忽略目录内隔离脚本；未修改 src、index.html、前端配置或锁文件，未 commit / push。旧一句话草稿与 Claude 未提交成果保留，不将它们冒称本轮新交付。

### 会话：事实核实，无需存储迁移

- 实际为 SQLite `sessions` 表，不是内存会话。签发时服务端 expires 与 Cookie Max-Age 均为 12 小时；正常启动仅清理过期项，关闭仅释放数据库。同一数据目录、未过期 Cookie 的重启已通过本轮测试，仍能读取授权工作台。
- 过期需要重新登录；改密码撤销该成员旧会话，停用 / 改权限及完整恢复也保留原撤销策略。没有延长有效期或放宽安全策略。
- 3012 的那次实际失效原因尚未重现，不能称为已修复。若再现，请保留同一访问地址 / 数据目录和重启前后的认证状态，排查 Cookie 变化、有效期及恢复 / 账号变更；无需先做持久化迁移。

### 材料：同源函数与新增服务端读取接口

`server/materials.ts` 原本已导入 `src/lib/materials.ts`；CSV、回执及前端一直共用该处判定。本轮不重造规则，也不修改该共享文件。

新增成员授权读取：`GET /api/collections/:id/materials`，可带 `?revision=<当前materialRevision>`；指定旧规则返回 409，未配置材料返回 404，未登录 401，只读成员可读、仍不可改。返回：

- `collectionId / rulesRevision / generatedAt / stateVersion / requirements`。
- `summary`：participants、receivedComplete、reviewComplete、missing、needsChanges、unclassified。
- `participants[]`：identity、owner、expected、status、receivedComplete、reviewComplete、duplicateCount、unclassifiedFileIds；slots[] 含 materialId、state、label、fileIds、duplicate。
- `files[]`：id、materialId、materialState、materialNote、expectedVersion。

rulesRevision、expectedVersion 延续原 token；新增 stateVersion 为包含名单 / 文件状态的摘要 token，**仅比较相等 / 不等，不按字典序判断新旧**。generatedAt 是读取时间，不是业务版本。必需项收齐与人工通过分开；选填空项的原始 state 为 missing，但 label 为选填未交；重复标志与总体收齐必须一起显示，不能将两个重复文件算作两项必需材料。名单仅成员接口可见，公开回执仍只返回持有人本批文件。

**2026-10-25 时的待办（已由下文第 6 节完成）**：当时 `src/features/materials.tsx` 仍本地调用共享函数，后端对齐轮没有切读新接口。台账 CSV 与本人回执的现有字段 / 载荷均未变。

### 演示与公开错误

- 既有 `.artifacts/j-material-ai-qa/run.mts` 通过受信任的 createApp 依赖注入、字面量 loopback 监听提供明确标记的测试传输，已足够用于本地工程演示；不新增产品公开开关或环境配置。普通 `npm start` 默认真实适配器且模型未配置时不可调用；公开请求的 testMode 参数不能切换传输。
- 本轮新隔离实例 3013 使用普通 createApp、未配置模型，界面明确显示未配置，实际模型调用为 0。内部注入不等于真实语义效果，当前无产品 API。
- `server/public-errors.ts` 仅整理 `/api/public/` 失败文案为发生情况与下一步，保留 HTTP 状态、`{error}` 包络、权限、续传 / 幂等及回执隐私。失效链接提示获取新链接；容量不足提示联系发起人；凭证不匹配不透露身份 / 文件；5xx 不显示内部异常。

### 本轮实际验收与剩余项

- `npm test`：56 项，53 通过、3 跳过、0 失败；不是引用此前 51/3 基线。跳过为 Windows 本机缺少 Poppler / Tesseract 两项及未指定旧版源码的升级演练。`npm run build` 通过。
- 新服务端测试覆盖同库重启 / 过期 / 改密，状态端点与独立 CSV / 私密回执读回，重复 / 未分类 / 需补充 / 过期口径，名单变化摘要更新，成员权限及公开错误状态 / 包络 / 私密边界。
- 当前 Claude 前端在全新 `.artifacts/backend-alignment-20261025/ui/data`、http://127.0.0.1:3013 实际完成模板建任务与 A01/A02 名单、390 px 可见材料按钮打开真实文件选择器上传、下载私密回执、桌面人工需补充、手机回执说明、本人整批替换、实际 CSV 下载。无注入 DOM 文件字节或绕过界面的业务 API 创建 / 审核。初始化合成账号使用 app.inject，仅后续状态读回通过 HTTP / 只读 SQLite。
- 独立读回：新两文件待核对、原两文件回收站保留、旧回执 superseded、新回执有效；CSV 7 行（表头 + 2 人 × 3 项），A01 两项待核对 / A02 两项缺项，与新状态端点及回执一致，下载正文与本地合成原文逐字节一致。
- 证据 / 访问说明均在忽略目录 `.artifacts/backend-alignment-20261025/`，包含 ui/RESULTS.json、server-state.json、ledger.csv、截图及私密回执；合成凭据只保留 ui/ACCESS.json，不上传或回报口令。原正式 data、3002、3012 样例未写入。
- 未完成：真实 API / 模型效果、实体手机 / 微信或支付宝 / VPS；3012 那次掉登录的具体原因；前端状态接口接线；390 px 浮动 AI 遮说明仍属前端待办，本轮未动布局。

## 6. 产品质量切片回执（2026-10-27）

在 product-quality-20261026-1 授权下完成必要前端接线及布局。材料工作台已读取上述授权接口，校验字符串规则 token、精确活动文件版本与同源 SHA-256 摘要；请求绑定 / 晚回包保护、失败禁止写入、跨任务草稿恢复均经集中验证。草稿只恢复说明，不恢复文件选择、核对结论或 AI 采用授权。前端不再本地推导材料表展示状态。

成功页直接显示本人核对进度 / 补充说明和替换入口，保存回执刷新后一次点击可查询；本人替换沿用原接口，新文件不继承旧人工结论。创建 / 确认 / 公开页统一显示实际 32 MB 上限。390 px 已移除浮动 AI 按钮，顶部入口可点击，提交按钮处于普通文档流；最终修正手机顶部标题挤压，360 / 390 / 1440 px 无整体溢出。

保留所有原有未提交成果与旧样例，正式 data、3014 包库不改。原库 3019 已恢复，自测另案；主控原案由主控自行继续，本会话没有代替补交或重新签发回执。四项相关集成测试结果沿用本切片已通过的运行；最终构建通过。真实模型 / 实体手机 / VPS 与 3012 历史掉线原因仍未确认。最终源码摘要、证据、访问入口和完成事件见 STATUS 与 `.artifacts/product-quality-20261026/FINAL_REVIEW.json`。
