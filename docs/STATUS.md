# 集屿当前交付状态

## goal-readiness-20261029-1：当前源码体验包（2026-10-31）

- event_id=`J:goal-readiness-20261029:current-package:1`。ZIP：`D:/Code-D/filegeter/.artifacts/current-package-20261031/jiyu-current.zip`，SHA-256 `df57a573c5599d44f6c3127b7196721b5342598ca82c3a76b7a8b60031d2db0d`，12,453,463 字节、6179 文件（含清单）。指南在包内 `CURRENT_GUIDE.md`，逐项 hash 在 `PACKAGE_MANIFEST.json`，依赖许可证列在 `DEPENDENCY_LICENSES.json`；附带同锁生产依赖及原创合成体验材料。补充功能 / 实证 / 限制映射为同目录 `EVIDENCE_MAP.md`。
- 本机 `npm run build` 通过；ZIP 新目录完整解包，6179 文件与清单摘要一致，其中 84 项当前 src / server / public / dist 文件逐项与源码匹配，禁止路径检查通过。解包目录执行 `node scripts/review-start.mjs 3044`，health / 首页 / 初始化状态均 HTTP 200，setupRequired=true、setup-token 存在、无 AI 配置；进程已停止。附带依赖实际启动通过；本轮没有执行联网 `npm ci`，不宣称其他物理机 / 平台验收。
- 包默认本机监听、新库、模型停用；不含原账号、数据库、回执、凭据、日志、旧私有响应或历史媒体。首次安装 / 重新安装依赖需 Node 24.11+ 的 24.x 及 `npm ci --omit=dev` 网络条件，启动以包内指南为准。非正式 Release，未提交 / 推送 / 发布。
- 主控已有 `J_CURRENT_UI_READBACK.json`：隔离克隆桌面人工分类→需补充→刷新、390px 重排、旧真实计划 stale、提交者真实文件选择及私密回执整批替换，16 项读回通过。不是同一条真实模型 / 真实用户回执贯穿链，也非实体手机。
- 原真实对照 8 任务 6 可用（产品 2/4、基线 4/4）；产品 D02 超时 / unknown 和空建议 400 两次失败保留，修后 200 仅为原响应离线重放。32 次 / 已知 26483 token、unknown 剩余保留 23625、0 在途，费用未知，旧 36 次另存。非真人采用、非领先证明；最终主控独立解包验收和整体 Goal 仍未完成。

## goal-readiness-20261029-1：D02 空建议修复（2026-10-30，本地重放）

- event_id=`J:goal-readiness-20261029:d02-empty-suggestion-replay:1`。原 D02 产品第二次的两个真实网关请求均为 HTTP 200；最终一份 `no_issue_in_excerpt` 的 suggestion 为空，原服务端要求非空导致整批 400。最小修复只允许该判断提供空字符串；attention / uncertain 仍须 1–300 字，字段类型 / 上限、消息、归属、精确引用、读取范围、人工确认与版本守卫不放松。界面将空值显示为“暂无补充建议，请继续人工核对”，不伪装为模型生成文字。
- 使用原两份已保存真实响应，在新隔离 D02 产品实例经注入重放，修后 API 返回 200；替换为新文件后旧计划过期，尝试给新文件采用旧建议被 400 拒绝。证据 `D02_EMPTY_SUGGESTION_REPLAY.json`；本次无网络请求、未读取模型密钥，不是新真实模型结果。原冻结对照的 400 和超时及其所有结果未改；源码修复发生在原冻结之后，因此不能将旧对照当作修后真实验证。
- 引用 / 业务受影响 4 项测试及 `npm run build` 通过，覆盖空值仅限无问题判断、其他判断非空、类型 / 上限、跨文件 / 错引用、未读、快照变动和替换。原超时由共享 `modelRequest` 的实际 45 秒传输上限触发（实测 45.331 秒），没有达到 60 秒上限；unknown 已按完整任务预算保守预留且原请求未重发。
- 当前仍待主控实际核验桌面 / 手机界面、真实回执替换及产品质量；D02 原真实对照的产品两次仍分别为 502 / 400，不能标为全部通过。最终打包和整体 Goal 未完成，未提交、推送或发布。

## goal-readiness-20261029-1：真实同工具调优与 DEV（2026-10-30）

- event_id=`J:goal-readiness-20261029:paired-results:1`。用户直接确认四份原创合成材料外发范围后，执行审核通过；只使用指定模型配置认证。产品臂调用实际材料预核对入口、严格引用和建议持久化；基线独立调用同一个原子工具运行核心，不调用产品完整业务流程。两臂使用同一产品预览、F 别名、原文、JSON 动作、原子计数与 SQLite 阶段账本；离线相同注入动作的消息一致。实际产品 transport 为包装真实 HTTPS 的注入对象，因此 `preview.testMode=true`；真实请求以保存的网关响应、HTTP / usage / 请求 hash 为证，不能把该标记改称正式生产模式。
- T01/T02 产品与两种基线真实调优完成，共 12 请求 / 9600 已报告 token。固定 evidence-first：其两案证据均为约定数组；保留 T01 未明确列出缺失制作说明、T02 未指出正文指令的不足；skeptical 的 T01 evidence 返回对象而非约定数组。调优原始响应、所有结果与 hash 冻结见 `live-93ae74a1-b35f-4bae-94fc-87a10c5e1b4c/`、`PAIR_FREEZE.json`，不据此宣称优胜或独立留出。
- 固定后 D01 / D02 各臂两次均保留：D01 产品与基线各两次均产生建议，经 `PAIRED_DEV_AUDIT.json` 逐引用对照原文，均指出用途模糊及材料 / 方法矛盾；D02 基线两次均完成替换前后建议，引用匹配，能指出替换后的用途占位。D02 产品两次均未完成：第一次第二个请求 45.3 秒连接超时、HTTP 502 / 用量未知；第二次模型的人工建议字段不符合非空要求，产品返回 400。不得把两次失败剔除或改写为通过，也未获得 D02 产品替换后的真实建议。
- 超时 attempt 22 的本机进程 PID 11700 已退出、无本机在途；根据已有明确授权，在同一账本追加 `unknown_audit`，保留原失败与 actual usage / cost 为 null，不重发该请求；前序已知 375 token 加剩余预留 23625，合计按完整任务 24000 保守占用。后续只运行尚未执行任务，续跑脚本相对冻结主脚本仅跳过已执行项。当前总账 **32 次 / 已知 26483 token / 未知保守预留 23625 / 1 次未知 / 0 在途**，费用未知，阶段未锁定；旧 36 次另存并链接。
- 以 D01 第一次真实模型计划，在同一隔离产品库通过 app.inject 模拟人工确认并记需补充，处置持久化且旧计划过期；以第二次真实计划模拟隔离 store 替换后，旧计划过期，新文件不能采用旧依据（400）。分别见 `REAL_PLAN_SIMULATED_ADOPTION.json` / `REAL_PLAN_SIMULATED_REPLACEMENT.json`。这两项是基于真实模型输出的工程操作，不是实际用户、收件人回执替换或真实 UI 行为。
- 实际桌面 / 手机浏览器操作仍未验收；电脑操作授权超时。用户 VPS、实体设备、真实用户采用与完整产品质量仍未证明，最终包尚未同步，Goal 不得标完成。冻结文件和原始记录不可覆写；本轮未提交 / 推送 / 发布。

## goal-readiness-20261029-1：真实调优首批（2026-10-30）

- event_id=`J:goal-readiness-20261029:real-tuning:1`。用户明确允许指定网关接收经核查的原创 T01/T02/D01/D02 及工具派生内容后，经执行审批运行 T01/T02 调优：实际产品材料预核对入口，以及独立调用同一工具核心的 evidence-first / skeptical 两种基线策略，各两次请求 / 案。每轮出站前按已审样例重新核对预览、消息、工具动作和工具结果；真实模型输出保留在 `.artifacts/goal-readiness-20261029-1/live-93ae74a1-b35f-4bae-94fc-87a10c5e1b4c/`，本地隔离数据含加密模型配置，不可整体对外发布。
- 新阶段 SQLite 账本累计 **12 次、9600 已报告保守 token、0 在途**，未锁定；费用未知。新两小时窗口从首次真实请求开始，旧 36 次账本仅链接保留。产品两案均返回 200；两基线均返回最终结果，但成功返回不等于正确：T01 evidence-first 未明确指出缺失制作说明，skeptical 虽提出缺项但 evidence 返回对象而非约定数组；T02 evidence-first 未指出正文内干扰性指令，skeptical 和产品均提示该指令并指出制作说明缺用途。需独立核查原响应与原件，不能把这些结果说成胜出或完美。
- 原始方案选 evidence-first 作为后续基线候选的理由是两案均按要求提供数组形式引用，仍须明确保留 T01 漏缺项与 T02 未提示注入；这一选择尚未形成最终闭包 hash 冻结或经过主控核验。当前 D01/D02 成对试验、真实产品替换 / 人工采用及浏览器实操仍未完成。
- 本机 `PAIR_OFFLINE_WIRING.json` 验证产品实际入口与独立共享工具核心使用相同产品预览，在相同注入响应下除策略提示外后续消息一致；D02 模拟版本变化时旧建议失效且前后共用 4 请求预算。该测试不是收件人真实界面替换或真实模型对照。
- **明确待修**：`.artifacts/goal-readiness-20261029-1/pair-live-tuning.mts --real-dev` 暂被代码主动拒绝，因初稿通过恢复同一文件旧版本准备重复试验，可能让旧建议重新匹配；必须改为每组独立数据实例、确定性合成文件 ID / 原始版本，并先验证两臂对应预览与版本一致、旧建议持续失效，再冻结源码 / 配置及运行真实 DEV。禁止通过手工移除保护直接运行初稿。四案字节不变，未提交、推送或发布。

## goal-readiness-20261029-1：共同工具协议对齐进行中（2026-10-30）

- 产品与离线比较原型复用 `src/lib/material-tool-actions.ts` 的动作参数校验与协议说明，支持同一套 rules/read/parse/locate/calc/version/clarify（无授权事实时 clarify 拒绝）；限定授权文件和原文，数字计算只取材料中出现的整数。对照原型 Chat 请求已改为与产品相同的 JSON actions/findings 消息格式，并把合成文件映射为稳定 F 别名。Docker 运行层复制新共享模块。
- 构建通过；产品注入、对照运行器与适配器 6 项测试通过，四案 / 三策略消息白名单离线演练通过。没有重跑旧真实调用，也没有本轮实际外发或读取凭据。
- **尚未达到公平真实对照条件**：对照脚本中的 `product` 目前只是提示策略，未调用实际产品业务入口；产品预览与对照原型的版本标识、元数据和真实阶段账本尚未证明逐字等价。`run-tuning.mts` 不能作为公平比较直接运行；还须将实际产品接入同样的持久账本与已核范围，统一预览版本后离线逐请求核验，再按已获人类确认提交实际执行审核。双端界面和真实模型业务链也未完成。

## goal-readiness-20261029-1：产品工具接线（2026-10-30，注入验证）

- 人类已针对先前拒绝项直接答复“允许按上述范围调用”：仅已核查四份原创合成案例、公开工具定义及派生结果发送至指定网关，API Key 只作认证，费用未知；原拒绝记录保留。当前未重新提交执行审核或调用模型，因为产品 JSON 与对照 Chat function 的实际协议 / 工具集合尚不一致，不能把原型真实运行标成公平对照。
- 产品加入默认关闭的实验多轮 JSON 动作模式：服务端显式 `JIYU_MATERIAL_TOOL_MODE=1`，用户在材料发送范围内自行选择，两个发送同意仍必需；默认单轮不变。共同会话按已授权摘录构造，最多 4 次请求 / 20 原子动作 / 24000 已知 token / 180 秒；任何一次用量未知即停止。每轮前后检查任务规则及文件快照，最终仍由原 `parseMaterialFindings`、人工确认与采用接口约束。
- 注入式 Fastify 集成验证：多轮读取后生成建议、人工确认与记录；伪造引用、重复引用无位置、未读取直接结论、未知用量均拒绝；正文重索引、追加或替换后旧建议不可采用。此前单轮兼容及其权限 / CSRF 检查保留。`npm run build` 和受影响的 5 项测试通过；均为工程证据，非真实模型效果。
- 隔离注入展示 `http://127.0.0.1:3036/`，health 通过，数据仅 `.artifacts/goal-readiness-20261029-1/ui-data-3`，测试账号为 `admin`，合成口令见同目录 `ui-preview.mts`；传输完全注入且前端标明测试模式。浏览器实操尚未验证：Playwright CLI 本机不可用；电脑操作授权窗口超时，未操作用户浏览器。该进程只为本机检查，不是 VPS 发布。
- 已离线准备 evidence-first 和 skeptical/self-check 两种基线提示及单独产品策略；四案 / 三种提示的模拟工具结果一致。尚未做真实调优 / 冻结 / 两新 DEV 比较。当前产品为 JSON 动作协议，而竞争原型使用 Chat function 协议且工具集合不一致，**不能认定同工具公平对照**；需先统一接线和预算并审阅后再真实调用。当前无新模型请求、无新窗口及账本；保留此前外发拒绝记录。

## goal-readiness-20261029-1：模型调优审批结果（2026-10-30）

- event_id=`J:goal-readiness-20261029:egress-review-rejected:1`。自动审批拒绝执行 `run-tuning.mts tune`：理由是命令将读取本地模型凭据并向外部网关发送数据，而历史代理消息 / 助手说明不能替代用户对具体目的地、凭据使用和外发行为的明确授权。未绕过或重试；该命令未启动，本轮未读取密钥、没有真实请求，`new-stage-ledger.sqlite` 不存在，首个实际请求的两小时窗口尚未开始。
- 已准备仅使用固定 hash 四份原创合成材料的 Chat 适配和调优脚本，逐轮重放校验消息、固定工具 schema / 网关、单请求中止信号、脱敏响应留存、在途与 unknown 锁定，以及防止重启后自动重复任务。适配器、模拟多轮和内存账本 7 项测试通过；这不是产品真实调用，也不能证明真实网关联调、传输中止或模型质量。脚本保存在忽略目录，仍需实际批准及逐项验收；模型双策略调优、两 DEV 对照、产品真实模型与 UI 链均未完成。
- 下一步需用户直接确认是否允许从此前指定的本地模型配置读取 API Key 作为认证头，并将清单中的原创合成 T01/T02 材料、公开工具定义及其派生工具结果发送至 `https://agy.2222444.xyz/antigravity/v1` 进行调优；后续 D01/D02 对照同样只用清单中的合成内容。模型服务可能产生用量和费用，金额目前未知。旧私有诊断、账号、真实业务资料不在拟发送范围。再次执行仍受工具审批约束。

## goal-readiness-20261029-1：多轮离线契约继续（2026-10-29）

- **迟到回调修复**：共同会话把在途与永久终止分开；unknown、超预算、超时后第二次 / 迟到 finish 均不能重新开放工具或模型调用。调用结束与工具返回时重新核对任务时限；账本完成时也检查任务 / 阶段期限，超限锁定。定时器与 AbortSignal 不可抢占阻塞中的同步 JS，也尚未证明真实传输已中止；unknown 后原实例不恢复。对应反例及正常调用通过。
- 新增仅测试注入传输的 `.artifacts/goal-readiness-20261029-1/agent-runtime.mts`，复用共同 schema、两种提示、工具与账本，可在模拟多轮中处理替换事件并重新读取；没有真实 HTTP 适配、未连接产品业务或基线，也未保全实际模型原始响应。真实传输、每轮外发检验和完整调优对照仍未就绪，不能把此模拟当作真实模型自主调用。
- 离线运行器后续加入固定的四案 SHA-256 白名单，每轮模拟请求前从已审原文重放工具调用并核对整段消息，拒绝额外正文、越权文件、伪造工具结果；计算参数限于当前授权规则或正文中的数字。初始消息公开相同规则与文件元数据，允许两臂在四次请求预算内自主批量选择读取。此校验仅覆盖该本地运行器；真实 HTTP 序列化、认证与完整出站链仍未接线或验证。
- 新增仅本机的 `parse`（按授权正文分行并保留 UTF-16 起止位置）和有限整数 `calc`，与 rules/read/locate/version/clarify 使用相同计数入口。四份已审合成样例经两套提示执行模拟工具序列；结果 hash、别名及计数一致，替换使原快照失效；检查拒绝任意路径、多余参数和非样例引用。工具 schema、策略及模拟消息 hash 见 `.artifacts/goal-readiness-20261029-1/OUTBOUND_REHEARSAL.json`；它是模拟，不是模型自主调用或真实出站证明。
- `.artifacts/goal-readiness-20261029-1/budget.mts` 是隔离的持久 SQLite 账本原型：记载旧 36 次账本引用、2 小时窗口、40 次 / 500000 token 阶段上限、4 次 / 24000 token / 180 秒任务上限、每请求保守预留、单在途与未知用量锁定；60 秒超时目前仅在记账时发现并锁定，尚未接入传输中止。仅用内存数据库测试，**没有启动真实阶段窗口或创建真实请求账本**。
- 本次 `npm run build` 通过；此前账本、工具、引用和服务集成相关 7 项测试通过，本次迟到回调修复后重跑受影响的运行器、账本和工具 6 项通过；四案离线消息演练通过。新合成清单无修改，无密钥读取、模型 / 远程请求、提交、推送或发布。真实逐轮外发验证、生产与基线自主适配、有效传输超时中止、账本与传输接线、真实调优 / DEV、业务 UI 与整体 Goal 均未完成；不能把本记录视作公平比较或实测完成。

## goal-readiness-20261029-1：E02 离线准备（2026-10-29）

- event_id=`J:goal-readiness-20261029:offline-ready:1`。仅本机读取既存诊断并重放，无模型调用、外部请求或读取 API 密钥；旧响应、旧账本及旧包未覆盖，未提交、推送或发布。本条为阶段记录，不代表整体 Goal 完成。
- **真实失败定位**：保存的请求正文重建后与历史请求 hash 一致；F1/F2 绑定及文件版本一致，模型返回的两处位置偏移导致原文与位置不符。旧响应仍按原值被 422 拒绝；离线复制并去掉所有位置后，四处引用均可在各自授权摘录唯一定位。私有原文及完整诊断仅保留 `.artifacts/goal-readiness-20261029-1/private/`，不纳入外发清单。精简证据 `.artifacts/goal-readiness-20261029-1/E02_OFFLINE_REPLAY.json`。
- **实现与边界**：服务端只在同文件、同摘录、引用唯一且起止均未提供时定位；错误显式位置、半缺失位置、跨文件、重复出现、未读文本仍拒绝。原有生成前后与采用时快照检查保留；预览文件按 NFC 名称 / sha256 / id 排序，旧计划若顺序不同会保守过期。`Dockerfile` 已将新共享模块复制进运行镜像；容器本机未实跑。提示修改尚未接受真实模型检验。
- **工具原型**：`src/lib/material-atomic.ts` 统一别名、源正文 SHA-256、rules/read/locate/version/clarify、批量读逐文件计数及部分预算；本机相同样例按两种输入顺序执行的输出一致，替换使旧快照失效，未知用量锁定。其尚未连接产品 / 基线真实模型自主多轮，缺 parse/calc、每请求 60 秒中止、跨任务总账等；离线脚本不是两臂自主 Agent，不能据此断言公平比较。详见 `.artifacts/goal-readiness-20261029-1/OFFLINE_CONTRACT_CHECK.json` 和候选 `outbound/CONTRACT.json`。
- **待审核外发候选**：`.artifacts/goal-readiness-20261029-1/outbound/PAYLOAD_MANIFEST.json` 明列 T01、T02、D01、D02 和 CONTRACT 的精确字节数 / SHA-256；各材料均为新原创合成文本，含缺项、正文指令、矛盾 / 模糊、替换事件。清单仅覆盖列出的文件；未来实际系统提示 / 工具包装和具体外发内容需另行核查。本轮没有发送这些内容，也没有以其作为真人 / 独立留出证明。
- **验证**：`npm run build` 通过；`server/material-citation.test.ts`、`src/lib/material-atomic.test.ts`、`server/material-ai.test.ts`、`server/ai-json.test.ts` 共 6 项通过，覆盖唯一、重复、跨文件、位置错误、未读、版本变化、输入顺序、预算与未知用量。剩余真实工具接线、两策略调优和两新 DEV 实测、真实产品多场景及完整主控验收均未完成。

## 竞争DEV与当前离线包（2026-10-29 本地收尾，待主控验收）

**主控只读体验恢复（2026-10-29）**：此前验收后关闭的原解包实例已恢复到 **http://127.0.0.1:3027/**，启动父进程 **PID 17068**、服务子进程 **PID 48860**；解包目录 `C:/Users/16873/AppData/Local/Temp/jiyu-competitive-offline-s8FZRM/jiyu`。沿用原临时库及合成账号，账号仅 `.artifacts/competitive-20261028/private/offline-ui-access.json`，模型仍未配置、诊断未启用；health HTTP200。重启前后核对账号、任务、文件、AI记录及36次请求台账摘要一致，未初始化、重新建案、调用模型或重跑业务。原库快照仅保存在 private/controller-resume-20261029-before.json；本实例保留供主控使用。下方“3027已关闭”是此前验收结束时的历史状态。包可启动不代表公平比较就绪；下述公平性和覆盖缺口仍成立。

control_run_id=competitive-validation-20261028-1；event_id=J:competitive-validation-20261028:local-complete:1。额度恢复后只从已保存结果继续，未重做seed / 调优 / 原对照或额外调用模型。**交付是有限探索和当前离线包；公平强Agent比较条件未满足，产品新DEV覆盖不完整，不能声称胜出、获奖有保证或正式就绪。** submission_ready=false；无commit/push/注册购买/公开部署/外联投稿。

- **调优与固定**：两份原创调优DEV（跨材料缺项、正文含指令）下，两个独立多轮工具策略分别实际运行，共4任务、13次真实Chat。两策略均识别缺项 / 文本指令并给出可逐字核对的引用；A用6次、B用7次，按此证据选择A并在新案例比较前固定。模型自主选择read/rules/locate/version等受控原子工具，不执行任意宿主代码；输入为原创合成数据，不读取旧预留答案。**冻结前**对工具结果补充覆盖范围信息和版本事件，故最终固定工具的输出与调优期间略有不同，不能冒称已针对最终工具重新充分调优。全部调优结果及冻结前后记录保留。
- **成对DEV及公平性**：另外两份不同的原创DEV分别为空泛 / 矛盾内容和提交后整批替换；两臂各2次，共8任务，重复不是独立样本。原始结果中，产品E01一次200、一次502；E02两次502；基线E01两次有最终结果，E02一次有新版本最终结果、一次4次调用后未完成。两边原文件字节 / 规则 / 网关模型及预算上限一致，且产品各隔离任务原始文件hash已只读核对；但产品和基线文件别名顺序相反、模型可主动使用的原子工具不等同，产品工具计数还包括上传准备而基线只计模型选用工具，无法公平比较胜负。T01跨材料缺项 / T02正文指令**只在基线调优中运行，产品侧未对这两例成对实测**。这些不是独立留出或泛化结论。
- **真实失败与唯一修复批**：原对照3次产品502中的实际响应均为完整Markdown JSON代码块，保存的私有真实响应支持该原因；实现只接受整个代码块内合法JSON对象，仍拒绝夹带文字、损坏JSON、非对象、截断 / 拒答和非法原文引用。早前model-live一次未保存正文的格式失败原因仍未知，不能倒推一致。第一轮修复后E01真实验证200；E02初次及替换后200、旧建议stale，但模型额外猜测活动期号要求。故同一修复批明确提示“任务标题不自动新增逐字材料要求”。最终有限复验E01返回200，E02因引用与授权原文不一致返回**422并拒绝**，替换后续链在该次未运行；不重复调用凑通过率，语义可靠性仍待解决。独立此前真实UI替换旧建议守卫证据保留，不冒称最后422案例走完。
- **用量与人工**：本阶段真实网关请求 **36次 / 已报告40144 tokens**，无pending / 未知usage，费用null/unknown；未超过40次 / 500000 token工作配额，旧model-live的5次产品尝试 / 4次Chat / 4652已知下界与账本独立保留。每任务上限4次Chat / 20工具动作 / 24000 tokens / 180秒；真实usage、耗时、HTTP、输出、失败和输入hash保存在新台账与private证据。原对照产品侧通过app.inject模拟授权与点击；计量包装器实际调用原有安全HTTPS网关但产品标记testMode=true，原始响应是现实网关结果而非夹具；**不能说真人采用或实际UI点击**。裁定和调优审阅为开发者检查，未做真人专业试用。
- **检查与离线交付**：针对完整JSON块、截断 / 拒答及材料引用的3项测试通过，最终 `npm run build` 通过。新包 `.artifacts/competitive-20261028/delivery/jiyu-offline-current.zip`，**12445177字节、6175项（6174载荷+清单）**，SHA-256 **3d7ad44b48adf6cc085b85e8c215462c2324d5b0d8b98e5426eae37d4cc6920b**；包含当前代码、dist、同锁文件生产依赖、MIT、原创示例及OFFLINE_GUIDE，不含原库 / 凭证 / 账号 / 回执 / 对照输入或答案 / 私有日志。全部载荷hash / ZIP路径与符号链接检查通过；包中86个源码 / 配置 / 静态文件与当前工作区一致，文件路径及hash列表摘要 **48691fb857a6738b63b84ae13d47101b20f2e5e847968937d25f1e06818e8cfd**。Windows Node24.11.1在工作区外临时目录、无需npm安装启动，空库health200、未初始化 / AI未配置、静态资源字节一致；其他系统未实测。用户已有Node运行时仍为前提。
- **当前页面**：空库验证后，仅在临时解包库通过真实页面初始化合成管理员；同一自有页检查1440 / 390px模型设置，默认未启用、Key为空、无整体横向溢出，移动AI入口可见。首次切换视口截图捕捉到侧栏动画中间帧，等待结束后重新核对面板未遮挡；期间一个布局脚本在宿主侧错误引用innerHeight，已修正脚本并通过，没有改产品。仅验证设置页，**没有**在此次离线包复演上传、建议或替换界面。临时3027服务与自有CLI页面已关闭，临时目录证据保留；其他实例 / 原库 / 旧包媒体未操作。
- **交接证据 / 待完成**：`.artifacts/competitive-20261028/REVIEW.json`、FROZEN_CONFIG.json、train-results.json、compare-results.json、repair-results.json、repair-final-results.json、REQUEST_LEDGER.json、OFFLINE_SMOKE.json、delivery/PACKAGE_MANIFEST.json；private/原始网关响应、EXPERIMENT_COMPARE_FROZEN.mts、OFFLINE_EXTRACT.json及桌面 / 移动设置截图只供本地审阅，不进ZIP。公平等工具比较、产品侧新缺项 / 正文指令DEV、最终422原因处理、独立留出、真人使用、实体手机 / VPS与官方投稿均未完成。此前固定主控回报已被审批拒绝，按最新指示不再发送或绕过；主控可直接读本STATUS / REVIEW集中验收。

## 3024 原库恢复（2026-10-28）

供主控只读核对的原隔离实例已恢复：**http://127.0.0.1:3024/**，当前自有 **PID 72404**，使用 `.artifacts/model-live-20261027/run.mts` 和原 `data/`，合成账号仍在同目录 private/ACCESS.json。诊断显式开关未设置，保持关闭；health HTTP200。恢复前后只读摘要核实原管理员、模型配置、任务、文件、计划及5次产品尝试账本完全一致（4次实际Chat，已知token下界4652），没有初始化、seed、修改审核或调用模型。证据在 private/resume-20261028-snapshot.json 和 controller-resume-out.log。CLI 当前无浏览器，未关闭他人页面；主控可自行打开一个页面。先前PID63688为历史记录。此前被拒绝的跨会话回报未重试，主控直接读取此处。

## 唯一诊断修复批（2026-10-28 完成，不追加调用）

control_run_id=model-live-20261027-1；event_id=J:model-live-20261027:diagnostic-batch-completed:1；status=one_reproduction_success_old_failure_cause_unknown。本节为最新交接，更新下方原三类DEV中“缺信息有效提议 / 采用未运行”的历史状态；原格式失败记录继续保留，**没有确定其根因，也没有宣称修复该根因或全场景稳定**。本批只新增1次实际Chat，未使用第二次额度；累计5次产品尝试 / 4次实际Chat，未超过原8次工作配额。无commit/push/重包/媒体重录/部署/购买/外联/投稿，submission_ready=false。

- **诊断边界**：新增server/ai-failure-diagnostics.ts，仅createApp可信选项可启用，无前端 / HTTP参数入口，默认关闭。精确匹配本轮已审缺信息消息hash；须写到data同级private子目录。仅失败时保存finish_reason、结构键、正文类型 / 长度 / hash及至多64KiB脱密原响应；API Key精确替换，绝不回前端 / 聊天 / 公开日志。最多两份，并串行检查上限，诊断异常不改变产品拒绝 / usage。其他账号、原客户库、回执、oracle或留出数据均未读取 / 发送。
- **定向重现结果**：同一个缺信息DEV02、同一15字符原创正文、相同消息hash **06e5526b6e8c8f26c2b04fa57900c9858cfabdbad121ecf2cbd34b470eab443d**，仍通过原产品UI准备范围 / 双重授权 / 点击发送，真实网关与产品均200。此次返回合法JSON，assessment=attention，明确主题和过程缺失；引用“未定”[0,2)及“主题和使用过程待补充。”[3,14)经程序与人工逐字核实。因此**旧格式失败未重现**，没有实际失败诊断文件（0份），旧无效响应已无原文，无法确定是何种格式问题。不猜测、未放宽解析 / 吞截断 / 拒绝 / 越界，未改提示词或盲重试。
- **人工处置**：真实run **d8bb4f37-04db-4f54-a4f4-5c683e350d9d**，testMode=false。实际UI核对原文、带入人工表单、明确选择needs_changes并写具体补充说明，保存HTTP200。独立SQLite确认人工核对决策和计划disposition来源记录均为needs_changes，未判accepted。本次有效建议及原来的格式失败同时存在，不能用一次成功掩盖失败或当语义稳定性基准。正常真实提议 / 人工通过、真实替换后旧建议stale与采用禁用沿用原证据，未重演。
- **用量**：新增raw usage为prompt379 / completion105 / **total997**，细分原值完整在账本，耗时9361ms。累计实际Chat报告total **4652 tokens**（1279+1128+1248+997，含原格式失败），费用null/unknown。旧DNS失败usage仍null，因此整个阶段仍标unknown、已知下界4652，不写假0；失败次数仍计入。REQUEST_LEDGER.json更新为5条，原4条账本保存在REQUEST_LEDGER_BEFORE_REPAIR.json，原1条与历史RESULTS均保留。
- **检查与实现**：诊断默认关闭 / 精确范围 / private路径 / 脱密 / 并发两份上限，以及既有截断 / 无效 / 拒答拒绝链两项定向测试通过，未重跑旧6项、完整业务或媒体检查。构建通过，JS仍index-CJMoK7nn.js，CSS仍index-CE3VDmJA.css；SSRF、公网固定IP / TLS / 禁重定向 / 超时 / usage全部守卫保留。诊断仅本批明确启用；结束后恢复其默认关闭，并同库启动最终源码，当前3024自有 **PID63688**，不重置账号 / 数据，保留并复用jiyu-live唯一页面。
- **证据与源码**：`.artifacts/model-live-20261027/DIAGNOSTIC_BATCH_20261028.json`、REQUEST_LEDGER.json、diagnostics-final-tests.log、diagnostics-build.log；private/MISSING_REPAIR_READBACK.json、missing-diagnostic-reproduce.log、missing-human-diagnostic.log、missing-human-needs-changes.png、missing-scope-resume.png、missing-real-result.png保留真实计划 / 原文 / 人工处置。诊断失败原文目录为private/ai-failure-diagnostics（此次无失败故未创建），不伪造原失败响应。10个相关源码 / 类型 / 测试文件逐文件摘要见新报告，列表JSON SHA-256 **22ef56dc70b63d63243683fee0e81106df5a1e545c360bc2878308ef11f2aabf**。
- **本地交接与停止**：原跨会话回报审批拒绝继续有效，按最新指示**不重试发送**；主控直接读本STATUS及新报告。旧失败的确切原因、模型语义可靠性基准、真实调优冻结、公平留出、真人试用及VPS / 实体手机仍未测或未知。此唯一批到此停止，剩余新增调用额度不用，不自动开下一批。

## 真实模型有限阶段（2026-10-28 有界验证完成，保留一项真实格式失败）

control_run_id=model-live-20261027-1。用户已授权指定网关的实际调用，先按最多8次真实Chat工作配额推进，失败计入；不再把缺API / 等预算确认当当前事实。本轮只验证现有材料预核对的原创合成正常 / 缺信息 / 替换后旧结果三类DEV，保留原库、包与媒体，不重包或扩功能。新隔离入口 http://127.0.0.1:3024/ ，启动脚本 `.artifacts/model-live-20261027/run.mts`，当前自有PID57888；账号仅同目录private/ACCESS.json，网关密钥仅指定母private文件由本地进程读取，通过原配置API加密保存，不回显。

event_id=J:model-live-20261027:completed-with-failure:1；status=bounded_dev_attempts_complete_with_format_rejection。2026-10-28按用户“额度已恢复，继续”从已存CHECKPOINT恢复，未重做seed、原6项测试或首次DNS失败。上述57888是历史进程，当前原3024同库恢复后的自有 **PID41760**，登录仅private/ACCESS.json。不重置原三类DEV或原产品 / 主控库，不重包 / 重录，无commit/push/部署/购买/外联/投稿。**submission_ready=false**，不能称三类模型结果全部通过。

- **真实调用与失败**：累计4次产品尝试，1次旧DNS拦截未发出HTTPS，3次实际Chat POST均收到网关200。正常DEV与变更DEV生成真实建议且精确引用通过；缺信息DEV的响应未通过JSON格式解析，产品502拒绝，未保存提议或人工结论，不进行无目标重试。该无效响应正文没有持久保存，不能断言其具体格式原因或语义质量；raw usage仍保留。
- **正常案例 / 人工处置**：实际UI选纸桥说明、审阅34字符原创正文、分别勾选范围 / 正文授权、点击发送。模型观察为no_issue_in_excerpt，引用主题[3,13)与过程[14,33)逐字匹配。人工审阅后通过UI带入，明确选择accepted并保存，SQLite记录真实人工来源与说明；不是模型自动批准。
- **变更案例 / 旧建议**：独立灯塔DEV真实建议引用[3,10)与[11,26)匹配，经实际本人回执入口和原生文件选择器整批替换。新文件pending、原文件回收，真实旧计划GET返回stale=true；界面显示“原建议仅供历史查看”、采用禁用。首次检查误找“已有变化”而返回false，按实际提示及服务端状态核实后通过，产品未因此更改。缺信息DEV仍未人工批准。
- **网络阻断与安全兼容**：旧系统DNS198.18.0.206曾被正确拒绝。恢复后仅一次无凭据系统解析得到198.18.1.14，仍属同一保留段，未为此重试模型。主控新增NETWORK_DIAGNOSTIC_20261028提供可信HTTPS公共DNS证据后，做唯一实际无凭据固定公网IP的TLS探测，原域名证书有效、HEAD405。首个探测脚本缺family参数导致联网前ERR_INVALID_IP_ADDRESS，已单独保留并按产品契约修正，没有把它当网络响应。随后实现 **默认关闭、仅指定网关** 的JIYU_AI_PUBLIC_DNS_GATEWAY显式opt-in；只在本轮3024启动脚本启用。固定Cloudflare HTTPS解析器与1.1.1.1公网引导地址，无apikey，无请求可控解析器URL，无全局DNS/代理修改；5秒 / 16KiB限制，不跟随重定向。所有返回A/AAAA地址再次经过isPublicAddress，模型HTTPS固定连接被验证公网IP，原hostname/TLS证书校验保留。未把198.18放行，正常环境默认仍走原DNS守卫。
- **诚实用量**：逐次raw usage、inputHash、耗时 / HTTP / 状态均在既有settings的ai.accounting记录与REQUEST_LEDGER.json。三次已报告total分别 **1279 / 1128 / 1248，总计3655 tokens**（分别约10.61 / 10.62 / 10.18秒），含被格式拒绝那次；不以可见prompt+completion替代网关total。原DNS失败usage=null，因此整个阶段保留unknown并给已知下界3655，不伪报缺失用量0。费用null/unknown，无费率假设。网关自报gemini-3.8-flash-high，不确认底层官方模型身份；主控先前121-token预检是独立账本，不混进J计数。
- **实现 / 测试**：缺失usage为null，库内-1仅作未知标记；成功 / 拒绝 / 取消均保留可获得的用量，失败计次数。旧6项受影响测试已通过且未重跑；新单网关DNS opt-in / 默认关闭 / 混合保留地址拒绝测试1项通过。新模块后集中构建通过（1964模块，index-CJMoK7nn.js / index-CE3VDmJA.css）；git diff --check通过。运行源码本轮7文件摘要在RESULTS_20261028.json，列表JSON SHA-256 **51f2ce018ad37f75b17af57a30f55d1dcbc918874bbfe6c341ba154f7ef02e78**。前一材料包保留此前已验版本字节，本轮不再次打包。
- **证据与复核**：`.artifacts/model-live-20261027/RESULTS_20261028.json`、REQUEST_LEDGER.json（当前4条）、REQUEST_LEDGER_INITIAL_20261027.json（旧1条保留）、CHECKPOINT.json（历史阻断，不冒充当前）、DNS_RESUME_20261028.json、PUBLIC_TLS_20261028.json、PUBLIC_TLS_PROBE_LOCAL_ERROR.json、OPTIN_DNS_20261028.json、tests.log、dns-tests.log、build-network.log。private/ACTUAL_SYNTHETIC_SCOPES.json逐例保存实际范围与消息hash，对照服务器inputHash一致；REAL_PLANS_READBACK.json保存真实两计划 / 人工处置 / 替换读回。private的normal-real-resume.log、missing-real.log、change-real.log、change-stale-final.log及对应截图供主控独立审阅，不打包或输出凭据。
- **页面与停止**：恢复时CLI无浏览器，未关任何他人页；本次只创建/复用jiyu-live单一产品页，无并排或批量杀窗口。保留该页与3024供审阅，后续优先复用。正常 / 缺信息失败 / 真实旧建议守卫均已准确记录，停止本轮追加调用；缺信息有效提议 / 采用、真实调优冻结、公平留出比较、真人试用、VPS / 实体手机仍not_run。完成/失败事件先落盘，向固定主控最多尝试一次回报；若审批拒绝则不重试，由主控直接读取本状态。
- **本轮实际发送结果**：已一次尝试上述PROJECT_EVENT，工具返回isError=true，**未发送**。自动审批认为报告含内部路径、运行账本、源码摘要、用量及测试状态，而当前用户消息未明确授权向另一会话发送此类数据。遵照拒绝，不重试、不绕过；当前完整事件和证据均本地保存，供主控直接compact读取，不依赖再次批准来完成本地交接。

## 当前源码材料同步（2026-10-27 完成，停止追加）

control_run_id=product-quality-20261026-1；event_id=J:editorial-product-20261027:completed:1；status=limited_material_sync_completed。按主控本轮实际复验后的指示，只在新 `.artifacts/editorial-product-20261027/` 同步当前源码独立运行 ZIP、轻量版本说明 / 指南 / 差异页 / 清单，沿用已接受视觉与文字。**local_package_ready=true，submission_ready=false**。有限同步已完成，不再改产品、重录影片或追加测试；无 commit / push / 发布 / 部署 / 付费 / 外联 / 投稿。

- **先看 / 下载**：http://127.0.0.1:3021/ ，新材料预览自有 **PID 47060**，只读静态页面，不连接产品库。目录 `D:/Code-D/filegeter/.artifacts/editorial-product-20261027/`；index.html 当前版本入口、guide.html 当前安装与体验路径、changes.html 版本差异 / 验证边界、history.html 已接受历史影片、START_HERE.md 纯文本指南、MATERIAL_MANIFEST.json 文件清单、LICENSE。只有上述公开内容及 media / downloads 是本轮交付；**不要分发 `_work/`**（其中有测试解包目录、空库、日志和截图）。
- **新运行 ZIP**：`downloads/jiyu-0.4.0-dev-submission.zip`，**485803 字节，120 项（119 载荷 + 包内清单）**；SHA-256 **b84c162352a452c7fe45924d8d5a2bb593af8eaaaad57f3f94c4fd03e65d9079**。复用 scripts/package-submission.mjs，含 src / server / public / dist、唯一 npm 锁、必要配置、MIT、原公开合成输入、现行启动脚本和更新后的包内指南。文件载荷全部与当前工作区逐字节摘要一致；未包含 data / var / 上传 / 数据库 / node_modules / 凭据 / 私密回执 / 测试日志 / 私有 QA。包内保留源码测试文件，未混入测试结果或运行数据。
- **验收源码绑定 / 模块齐全**：前一轮 80 文件验收摘要 **762a5642f9975975b29aab4fd9cdbab01c452fbf85db3bed2e44ac595401724e** 对应的源码在本轮仍全部未变；ZIP 收入其中 **79 个运行源码 / 配置文件**，全部 hash 一致。未收入的仅 Dockerfile，本机 ZIP 启动无需它，不声明这个包是容器镜像。新 use-material-state.ts、material-state.ts、collection-draft.ts、public-errors.ts、共享材料模块与启动脚本齐全，**116 处服务端相对导入全部解析到包内文件**；119 载荷清单逐条大小 / hash 与 ZIP / 工作区一致，路径无穿越、无符号链接、无大小写重复。对本轮合成密码及两份自测回执 key 精确检查无命中，不冒称穷尽所有可能秘密的审计。
- **独立安装 / 启动烟测**：解包到新 `_work/unpacked/jiyu`，实际执行 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，联网安装 **84 个**锁定运行依赖，不链接旧 node_modules。沿用 `node scripts/review-start.mjs 3022` 启动空实例；health 200，setupRequired=true、未认证，collections / files / users 均 0，未初始化管理员、未创建案件。最新 `index-BteB3kZX.js` / `index-CE3VDmJA.css` 均 HTTP 200 且与解包 dist 字节相同，JS 中当前状态保护 / 直接替换模块文案存在；无模型调用。检查后仅停止本次临时父 / 子实例（44944 / 53368），不把3022作为长期体验入口；原3019与原3014包库未操作。本次不重演完整业务或旧全集，不因文档变更重复构建。
- **指南与历史媒体**：包内指南移除旧“状态接口尚未接读”表述，当前指南说明成功页直接看进度 / 原浏览器一次点击查询 / 换设备导入本人回执 / 按说明替换 / 顶部 AI / 实际32 MB。无默认账号；新解包仍须读取新 setup-token 自设至少12位密码，Node24.11+的24.x、首次联网安装和loopback条件明确。旧 MP4 / SRT / VTT / 封面复制到新 media，**逐字节相同**；history.html 标明“2026-10-26 已接受历史版本”，不能当2026-10-27当前UI录像，旁白合成语音及浏览器手机视口披露保留。原旧ZIP / 影片 / 库原样保留，不重录或覆盖。
- **新材料页面检查**：四页分别在1440 / 390 px实际浏览，8次检查均无整体横向溢出、无坏图，已查看桌面入口与手机指南 / 历史影片实际截图。16处页面资源 / 链接 HTTP200，私有 `_work` HTTP404，旧影片 Range206。首轮预览对无扩展名 LICENSE 返回404，仅修正新目录预览 MIME 后通过，不改原预览。浏览器实际点击下载的新ZIP与上方 hash 一致。材料清单列16个公开载荷，自身除外，共17个公开文件；清单 SHA-256 **8fc49c6097fd2ce6e38c3fc7f156928c0ceaa50dcadd77ab9e50d9247daffba5**。旧两套ZIP hash仍等于原记录。
- **主控独立产品复验（主控回报，非本会话代跑）**：原案手机正常查询补充说明→按说明整批替换2份341 B→成功页显示新两份pending→实际下载新回执→电脑QA-01待核 / QA-02缺项→实际CSV。主控独立SQLite确认2活动 / 2回收、旧需补充仅留回收原件、旧回执superseded新有效、CSV6内容行规则token与文件hash / 版本一致、ai_runs=0。主控未修改本会话PX自测案。本次包校验沿用这些已完成的产品验收，不冒称在新空包重跑。
- **证据与停止**：新目录 `_work/FINAL_REVIEW.json`、ZIP_CHECK.json、SMOKE_CHECK.json、browser-check.log、index-1440.png / guide-390.png / history-390.png；downloads/PACKAGE_MANIFEST.json 与 MATERIAL_MANIFEST.json 是公开清单。真实模型语义质量 / 成本 / 时延、实体手机、VPS、真人喜欢及资格 / 创作者资料 / 正式投稿仍未完成，submission_ready=false。本轮完成事件已落盘；不再尝试被拒的跨聊发送，由主控读取本 STATUS 集中审阅。只保留3019产品体验与3021材料预览；不自动开下一轮。

## 产品质量完整阶段（2026-10-27 本地完成，待主控集中验收）

control_run_id=product-quality-20261026-1；event_id=J:product-quality-20261026:completed:1；status=completed_local_current_source。必要前端接线、交互与核心修复及本轮集中自检已完成，取代此前“进行中”状态。沿用暖珊瑚视觉 / 原栈；没有 commit / push / 发布 / 部署 / 付费 / 外联 / 投稿，不自动开下一阶段。

- **当前实际入口**：http://127.0.0.1:3019/ ，原 `.artifacts/product-quality-20261026/run.mts`，同库 `data/`；2026-10-27 恢复后的自有进程 **PID 29784**，健康接口实际 200。合成登录仍仅同目录 ACCESS.json。首次非提升启动因监听端口 EACCES 退出，随后在允许的执行环境恢复成功；不是额度失败，也没有初始化 / 重置数据库。正式 data、旧 3014 包库及其他旧实例未操作。
- **主控案件保护**：恢复前已核验主控原任务、两份文件、提交记录与凭据摘要和前次快照相同。本会话仅操作另案“自测 · 材料质量闭环 · 规则更新”（PX-01/02）；主控原案继续由主控自行操作，因此后续其数据变化不拿旧摘要强行回滚。主控已确认原浏览器可自动找回并正常查询本人回执，取消了查找 / 导出请求；本会话未导出主控 key、未重签 / 重建回执、未代补交。
- **状态与旧响应**：材料工作台已读取授权状态接口，校验同一任务、字符串规则 token、要求、活动文件 / 版本与共享 SHA-256 摘要，前端不再重算展示结论。一次断网、坏摘要及跨任务晚回包的浏览器故障注入均被拦截；重试恢复、界面不被旧响应覆盖。晚回包测试网络 fulfill 成功，结论是界面忽略，未声称物理网络中止。实际修改自测规则后，新查询使用新 opaque token、旧正文被拒、旧选择及核对结论清空，未保存说明保留，旧规则 HTTP 409。
- **发起人与提交者体验**：三项待办直达缺项 / 待核对 / 需补充人员；说明草稿按账号 / 任务临时保存，重进不恢复文件选择、结论或 AI 采用授权。真实界面完成新建→390 px 选择真实 TXT 文件→提交→成功页自动看到待核对→桌面人工记作品说明需补充→返回同一成功页自动看到原因→直接“按说明替换本批文件”→新文件重新待核对。另已实际导入自测回执文件，刷新后一次点击“已经交过？查询回执 / 替换文件”自动读回当前批次，无需第二次点击查询。
- **限额与布局**：三步创建、确认及公开页均显示实际单文件 / 单次 32 MB；配置上限 50 MB 与服务器实际限额明确区分，原闸门不改。手机 AI 移到顶部，浮动入口隐藏；“前往提交”滚动至普通文档流按钮，实际 390×844 替换按钮底边 832 px 且中心命中。最终目视发现顶部标题挤压，已让搜索框收缩并保留标题 / 按钮宽度；重新完整刷新最终构建后，360 / 390 px 标题单行、AI 可点击且无整体溢出，1440 px 无整体溢出。旧文档未完整刷新时的首轮旧样式测量不列为最终结果。
- **独立读回**：本会话自测案 2 活动 / 2 回收文件，旧需补充记录保留，新两份均 pending 且不继承说明。当前报告为 participants=2 / receivedComplete=1 / reviewComplete=0 / missing=1 / needsChanges=0 / unclassified=0；规则 token 为字符串、摘要与只读 SQLite 一致。两份正文及最新 CSV 均实际从浏览器下载，正文与本地合成原文 / HTTP 下载逐字节一致，CSV 7 行与当前导出相同（仅 BOM 归一）；旧回执 superseded 且文件 0、新回执有效文件 2，未登录 401、错 key 403、旧规则 409。读回脚本首轮漏取独立 token 列导致 404，修正脚本后全部通过，未改产品。
- **构建与测试**：最终 `npm run build` 通过，**1964 模块**，`index-BteB3kZX.js` / `index-CE3VDmJA.css`；`git diff --check` 通过（仅 CRLF 规范提示）。沿用本切片已实际运行的四项受影响材料 / AI / 会话 / 权限 / 客户端绑定集成测试，4 通过 / 0 失败；末尾仅 CSS / 文档变化，不重跑旧全套。无新依赖 / schema。
- **可复核源码摘要**：80 个运行源码 / 必要配置文件的排序路径与逐文件 SHA-256 列表在 `SOURCE_MANIFEST.json`；该列表 JSON 的 SHA-256 为 **762a5642f9975975b29aab4fd9cdbab01c452fbf85db3bed2e44ac595401724e**。构建 JS SHA-256 **4f1c43a127c68e752aed7a27bcb2e430a936211cd147d53b96d2f1cc18d334a5**；CSS SHA-256 **a3fd284311b3aa8da677d119bf0ce9f54e51367b767e2e9747f7f93287d54f35**。这不是 Git 提交摘要，所有原有未提交成果保留。
- **证据与同步**：`.artifacts/product-quality-20261026/FINAL_REVIEW.json`、RESULTS.json、build-final.log、SOURCE_MANIFEST.json；私有细节在 qa-private/，包括 browser-races.log、rule-change.log、receipt-one-click-result.log、layout-final.log、server-state.json、ledger-current.csv、desktop-final.png、mobile-final.png、receipt-one-click-final.png、receipt-needs-changes.png、mobile-replace-confirm.png。CLI 内嵌文件选择处理后的工具残留已通过重开自有浏览器、采用 CLI upload 完成干净复验，不把残留当通过。旧材料 / 影片 / 运行 ZIP 均保留原字节，本轮只写 MATERIAL_DELTA.md，明确旧材料不是当前源码运行包，不重录 / 重包。
- **未测及停止**：当前服务未配置模型，实际 ai_runs=0；工程集成测试的内部注入不是真实模型。真实语义 / 成本 / 时延、实体手机 / 微信或支付宝、VPS、真人使用是否喜欢、公平比较仍 not_run，submission_ready=false。本轮完成事件已落盘；依此前跨聊审批拒绝与最新指示，不重试发送，由主控直接 compact 读取后独立验收。3019 保留供体验。

## 当前材料重制阶段（2026-10-26 完成，待总控视觉审阅）

control_run_id=material-quality-20261026-1；event_id=J:editorial-20261026:completed:1。按用户选择样张 A 及“不光是PPT”的最新范围，完成整段新材料；不做PPT，不改产品行为。**材料候选已完成，submission_ready=false 不变。** 此后停止新增内容，等总控集中看真实成品并汇总一批问题。

- **先看成品**：http://127.0.0.1:3017/ ，仅本机静态预览，当前自有预览 PID **53128**；入口文件 `D:/Code-D/filegeter/.artifacts/editorial-20261026/index.html`。此服务不连接任何产品数据库，`node preview.mjs [可选空闲端口]` 可在新材料目录独立运行，Ctrl+C 停止；静态HTML/CSS/图片也可直接本机打开。
- **叙事与版式**：暖白、墨黑、少量珊瑚色，围绕同一位社团提交者的“收件→人工需补充→本人替换→新文件重新待核对”。首屏清楚说明收件人和痛点，先看 / 先试 / 材料一步可达；正文放真实大图和单元格特写，窄屏专门放大对应局部。没有复制样张虚构公司/日期/订单，也没有假聊天、重绘成功UI或大面积做旧纹理；hash、命令和工程说明集中在指南/附录/清单。
- **页面与正文**：index.html（设计后的介绍）、guide.html（简洁安装/体验路径）、video.html（影片）、materials.html（下载索引）、appendix.html（来源/技术/权利/团队与限制）、work.md、START_HERE.md、shots.md。所有新文件仅在 `.artifacts/editorial-20261026/`，原提交材料与原库不动，除本状态记录外未改仓库源码/规范。
- **新版封面**：`media/cover.png`，1920×1080，**143768 字节**，16:9且小于5 MB。编辑式大标题配本例实际人工核对说明特写；非生成的产品图，不含凭证。浏览器已实际渲染并目视检查。
- **新版 MP4**：`media/jiyu-story.mp4`，**133.4 秒（2分13.4秒）**，1920×1080 / 25fps / H.264 yuv420p / AAC，**2904636 字节**；SHA-256 **f4fefcb79c7a9053706d0714d9e6c21204d4cc5080a453148e81b1755be55276**。9个镜头按问题、动作、证据、结果编排，使用已有真实截图大特写及6.16秒已有窄屏实录；不是连续业务录像。`media/jiyu-story.srt` / .vtt 共27条字幕，按各段实际合成音频长度定位，MP4内已烧录中文，另有shots.md完整镜头脚本。
- **旁白准确披露**：本机 Microsoft Huihui Desktop，rate=1 的合成语音，非真人。系统禁用脚本文件执行时未改执行策略；普通本机语音API在允许访问引擎的执行环境成功生成27段有效WAV。初始COM失败的空文件没有用于影片。已有FFmpeg本机运行时只读调用；本机字库仅内部渲染，不进入分发包。影片完整解码通过，音轨非静音，9个实际字幕成品帧已抽查；浏览器实际播放推进、定位正常。未冒称已逐字人工听审全片，最终旁白观感仍由总控/用户审阅。
- **新整套材料包**：`jiyu-editorial-materials.zip`，**4189689 字节，30项**；SHA-256 **1b7eed20d1881b4efe97e40918f4991d281ee02308d05f2dbabe1a82df66eb14**。入口 `jiyu-editorial/index.html`；只含白名单页面、说明、真实公开合成图像/实录、MP4/SRT/VTT、合成台账、许可、原运行ZIP及材料清单；没有 `_work`、字体、WAV、编码中间件、QA日志或私密数据。已从实际材料页点击下载，所得ZIP与最终包字节hash一致。
- **材料清单**：`MATERIAL_MANIFEST.json`（SHA-256 **15a1db0075c96124970de826c098421ce2e5a86fd59a0e1f6ca16e37c3be34bb**）列29个载荷附件大小/hash、媒体/来源/边界；清单不自列，外层ZIP结果在PACKAGE_INFO.json。所有载荷hash和30项ZIP逐项读回通过。原运行ZIP在downloads/，仍475179字节、SHA-256 **c59c8dd7b647cd11136f791ed733cfa3fa8ce32078eeced06696bc2f212b19ee**，未重建或改字节；保留MIT / 1Beyond1声明。
- **集中成品检查**：5个页面在1440px与390px均实看/渲染，10次布局检查无整体横向溢出、无坏图。27个本地资源实际HTTP200，3处页内锚点有效，无坏链接；MP4 Range请求206。实际点击先试、材料并下载整包通过。原图拷贝逐字节一致，局部仅裁切原像素；凭据/回执key未进入材料，合成编号与浏览器手机视口披露保留。前端/入口/锁等55受保护文件hash均无变化。沿用原工程验收，无清库、重演旧业务或重复旧全套测试。
- **证据**：`_work/qa/FINAL_REVIEW.json`、LINK_CHECK.json、MEDIA_CHECK.json、browser-report.log、final-navigation.log、index-1440.png / index-390.png、mobile-evidence-note.png / mobile-evidence-result.png、video-playback.png、final-video-contact.jpg。制作脚本、音频与字库均在内部 `_work`，不分发；原3014 / 3013 / 3002 / 3012及正式data未触碰。
- **仍需落实**：真实产品模型及语义效果实测、真实团队/工具版本资料、资格与不跨赛重复投递确认、评审获取/安装或访问条件。当前AI未配置，全部主画面/旁白/附录不把规则或测试结果当真实模型。未commit/push/部署/注册付费/投稿。
- **回报方式**：本轮完成事件信息已落盘（上述event_id），**未再次发送跨聊**。此前该动作被自动审批以本聊天未明确授权为由拒绝；依本轮“不让用户重复批准、主控自己读取”的指示，不重试、不绕过、不再次索要同一批准。固定总控可compact读STATUS及FINAL_REVIEW，集中视觉验收本轮成品。

## 当前参赛提交制作阶段（2026-10-26 完成，待总控验收）

control_run_id=submission-ready-20261025-1。有限本地交付切片完成，**local_package_ready=true，submission_ready=false**；正式就绪缺口见下。前端仍只读，Claude 与旧草稿成果保留；未 commit / push / 打标签 / Release / 公开部署 / 正式投稿。不自动开下一功能。

- **可交付目录**：`D:/Code-D/filegeter/.artifacts/submission-ready-20261025/delivery/`，共 19 个文件（含最终 manifest）。只交这个白名单目录内的候选文件，不上传同级 unpacked / qa-private / 运行日志。00-先读.md、QUICKSTART.md、WORK_DESCRIPTION.md、REQUIREMENTS.md、DEMO_SCRIPT.md、VERIFICATION.json 与 SUBMISSION_MANIFEST.json 提供启动、提交正文、规则映射、真实工具 / 数据来源、旧作品本期实质更新和准确限制；团队真实资料未代填。
- **最终独立 ZIP**：delivery/jiyu-0.4.0-dev-submission.zip，**475179 字节**；SHA-256 **c59c8dd7b647cd11136f791ed733cfa3fa8ce32078eeced06696bc2f212b19ee**。117 个有效载荷文件加包内清单，共 118 条 ZIP 项；源码、预构建 dist、唯一 npm 锁、配置、MIT LICENSE、公开合成输入和启动说明全部白名单挑选，无符号链接或越界路径。最终包与已解包操作的首包仅 WORK_DESCRIPTION.md 增补真实开发辅助工具披露，所有运行源码、构建、锁和启动脚本字节相同，未重演已过主线。最终 ZIP 内逐文件 hash、18 个交付附件 hash / 大小和 ZIP hash 均已核对，manifest 自身明确不列入自身清单。
- **启动 / 停止**：Node 24.11+ 的 24.x；新解包 jiyu 目录执行 `npm ci --omit=dev`（本轮实际联网安装 84 包，不含 node_modules，不虚称完全离线）→ `node scripts/review-start.mjs [可选端口]`，默认仅 127.0.0.1:3014；Ctrl+C 停止。包内无默认账号 / 密码 / 原库，体验者读取本包新 `.review-data/setup-token` 在原网页初始化。数据与备份只在各自解包目录 .review-data / .review-backups，不依赖原源码绝对路径或原上传目录。
- **新解包主线已实做**：Windows / Node 24.11.1、真实 Edge + Playwright CLI；原网页初始化合成管理员 → 桌面模板建任务与 DEMO-01/02 名单 → 390×844 视口按可见材料按钮打开真实文件选择器上传包内两份 TXT → 实际下载私密回执 → 管理端人工需补充 → 本人回执显示说明 → 实际整批替换 → 实际下载 CSV 及活动文件正文。不是用 API 写入业务替代 UI，也不是实体手机或支付宝环境验证。
- **集中读回**：QA_RESULT.json 保存 2 活动 / 2 回收文件，旧需补充留在回收站、新文件均 pending 不继承旧结论；旧回执 superseded 且当前文件为 0，新回执有效两份；CSV 7 行与当前导出（仅 BOM 归一）/ 状态 / 本人回执一致；浏览器实际下载正文及 HTTP 两份正文均与合成原文逐字节一致。私有状态未登录 401、旧规则 409、错回执 key 403，真实模型调用 0。中断恢复时原 3014 已停，仅用原解包脚本和同库恢复，当前父进程 **PID 28056**；业务表、凭据和两份回执前后摘要一致，未初始化 / 重置 / 新建样例。原 3013、3002、3012 与正式 data 未操作。
- **封面 / 素材**：delivery/cover.png，**1600×900、222176 字节**，16:9 且小于 5 MB，实际合成材料矩阵配准确标题、明确模型未配置，已视觉检查无凭据及重叠。另有 6 张当前截图、实际合成台账 / 正文，以及 69.16s 桌面、6.16s 窄屏两段无声 WebM 原素材与解说稿；动作录制边界及 5+3 个抽帧已查看，辅助桌面分享弹窗视频已移到 qa-private，不进入交付。原素材**不是**官方可直接上传的 MP4/AVI/MOV 成片；视频选填，不把未转码当必交阻断。用于封面的临时白名单渲染服务 / 自有浏览器已关闭。
- **隐私 / 权利**：无原库、原上传、密钥、账号、私密回执、学校姓名或受限官方原件进入 ZIP / delivery。对本次合成密码和回执 key 做了精确内容排查；素材按录制范围和抽帧审阅，不冒称全帧 OCR 审计。保留 MIT 与 1Beyond1 原作者声明，不随意匿名删许可；第三方依赖单独联网获取并适用其原许可。样本仅原创合成 DEMO 编号。
- **前端保护 / 检查范围**：本轮全 55 文件原哈希及母交接 50 个 src / 3 个入口配置均无变化，src 文件集合也一致。当前前端仍用共享纯函数计算材料矩阵，新状态接口尚未切读，现有路径可用。本轮重新 `npm run build` 通过（1962 模块）；沿用前轮 56 项 / 53 通过 / 3 跳过与主控后端验收，不重跑无关全套。本轮新增的包内 hash、安全解包、联网独立安装、主线、下载与失效核验全部通过；校验脚本漏取 token 列、漏传导出 revision 的两处已纠正，产品未因此修改。
- **官方映射与硬缺口**：按总控 2026-10-25 真实浏览器核查，URL 或 ZIP 可二选一，封面必需、视频选填；不把公网 URL 对所有作品一概列为硬要求。当前还缺合法产品模型 API 与草稿 / 精确出处预核对的真实语义实测、真实团队 / 创作者资料与最终工具披露、禁止跨赛重复投递及既有作品本期资格确认、正式评审获取和 Node/npm 联网安装条件确认。没有把127.0.0.1当公网链接，也未在官方渠道上传。截止按公告较早的 2026-12-06 00:00（UTC+8）准备，细则当日23:59:59的差异保留，须投稿前再核实。
- **私有验收入口**：当前 http://127.0.0.1:3014，合成管理员仅 qa-private/ACCESS.json；原任务链接在 qa-private/routes.json，有效回执仅 qa-private/receipt-current.txt，不复制到聊天或交付。恢复/读回证据为 QA_RESULT.json、FINALIZATION_RESULT.json、qa-private/resume-before.json；首包保留在 package/，最终源包在 package-reviewed/，这些均为忽略的分发/验收产物，不是源码副本。
- **完成回报**：event_id=J:submission-ready-20261025:completed:1。本轮已尝试一次向固定总控发送完成状态，不含密码或私密凭证；自动审批拒绝，消息未发送，未重试或绕过。审核理由：发送包含项目状态、路径、进程和交付元数据，当前可信用户消息未明确授权向该线程回报，不能仅依据其他会话或助手内容推定授权。虽已实际读取总控人类用户 turn 01a16bce-6982-70d2-a2e8-2628d0cf71c0 的既有回报指示，仍按此次拒绝停发；本地完成记录保存在这里，供总控 compact 发现并集中验收。若本聊天用户另行明确授权，可再按其范围处理，不自行恢复发送。

## 当前后端对齐阶段（2026-10-25）

control_run_id=backend-alignment-20261025-1，开发与本轮自检完成，待总控集中验收。仅修改后端 / 后端测试 / 必要本地脚本和文档，未提交或推送；Claude 前端与旧一句话草稿的未提交成果原样保留。本轮不恢复旧扩展任务。

- **交付**：新增授权读取 `GET /api/collections/:id/materials`，直接复用既有 `src/lib/materials.ts` 共享函数，返回逐人逐项状态、规则 token 和不排序的状态摘要 token。CSV 与本人回执兼容；当前前端仍使用共享函数在客户端计算，切读新接口是明确的接线待办。公开接口错误仅整理短文案与下一步，HTTP / JSON / 权限 / 续传及私密边界保留。
- **无需迁移的依据**：会话原本存在 SQLite，未过期 Cookie 的同库重启测试通过；12 小时有效期及过期 / 改密撤销不变。3012 那次掉登录原因未复现，不宣称修复。既有受信任 createApp 本机隔离注入已够用，不新增产品演示开关；正常启动未配置模型时不可调用。
- **集中验证**：`npm test` 实际 56 项，53 通过 / 3 跳过 / 0 失败；跳过为本机缺少 Poppler、Tesseract，以及未指定旧版源码的升级演练。`npm run build` 通过。新增测试覆盖会话重启 / 过期 / 改密、状态端点与独立 CSV / 本人回执一致、名单变化摘要、成员权限和公开错误边界。
- **当前新前端实际主线**：新建独立 3013 数据库，桌面用模板创建含 A01/A02 名单的任务 → 390 px 材料卡可见按钮打开真实文件选择器上传两份本地文件 → 实际下载私密回执 → 桌面人工记需补充及说明 → 手机回执看到说明 → 本人整批替换 → 桌面实际下载 CSV。后续 HTTP / 只读 SQLite 核对新两份待核对、旧两份进回收站且旧结论未继承、旧回执失效 / 新回执有效，CSV 7 行与状态端点和回执一致，实际下载正文逐字节一致。业务主线未绕过界面，初始化合成账号使用 app.inject。真实模型调用为 0。
- **前端保护**：本轮前后 55 个受保护文件哈希无变化；母交接基线 50 个 src 文件 + 3 个入口 / 配置文件也无变化。原正式 data、3002 和 3012 样例未写入。无新依赖 / schema / 公开部署 / 标签 / Release。
- **体验与证据**：http://127.0.0.1:3013，准备时 PID 80024，启动脚本 `.artifacts/backend-alignment-20261025/ui/run.mts`；服务保留供总控验收。合成登录凭据仅在 ui/ACCESS.json，当前链接在 ui/routes.json，当前有效回执在 ui/private-receipt-current.txt，不复制到聊天或 Git。ui/RESULTS.json、server-state.json、ledger.csv、desktop-after-replacement.png 与 receipt-needs-changes.png 为本轮证据；哈希比较在同级 frontend-after.json 和 parent-baseline-comparison.json。
- **仍未完成**：真实 API / 模型质量、实体手机 / 微信或支付宝 / VPS 未测；3012 原掉登录原因、前端状态接口接线和 390 px 浮动 AI 遮说明留待对应阶段。后端交接契约与限制见 FRONTEND_HANDOFF_BACKEND 第 5 节。
- **回报**：event_id=J:backend-alignment-20261025:completed:1。此前一次跨聊发送被自动审批拒绝，消息未发送。总控现已直接读取本轮实现、测试与 STATUS，并于 2026-10-25 要求仅恢复隔离环境；本次按要求不再跨聊回报或重试发送，供总控 compact 读取。只等待本轮集中验收，不自动开新阶段。

### 3013 原隔离服务恢复（2026-10-25 22:04，Asia/Taipei）

- 原 3013 已停，仅恢复该隔离实例，当前进程 **PID 91684**。使用原 `ui/run.mts` 和同一 `ui/data`，以隐藏窗口的 `Start-Process` 启动 `node --experimental-strip-types .artifacts/backend-alignment-20261025/ui/run.mts`，工作目录为本仓库。未重跑初始化：启动前已核实原管理员存在，脚本初始化条件不成立，预期与四份本地合成原文也已存在。
- `/api/health` 实际返回 200、ok=true、version=0.4.0-dev.0；只读数据库确认原链接对应任务仍在，计数仍为 1 个任务 / 4 份文件 / 2 批回执。启动前后 collections、files、submissions、submission_records、users 全行摘要一致，ACCESS、routes、两份私密回执、EXPECTED 和四份合成原文哈希一致；未覆盖凭据、回执或业务数据。正常启动保留原数据库，不重置或重新建样例。
- 恢复证据仅位于 `.artifacts/backend-alignment-20261025/ui/restart-before.json`、restart-result.json、restart-out.log、restart-err.log。系统拒绝读取 Get-NetTCPConnection 进程映射，但 PID 的进程查询与健康接口成功，不为此扩大权限。未运行旧整套测试、未改前端或功能、未提交推送；正式 data 及其他旧服务未动。环境恢复后停止，待总控本轮验收。

## Claude 前端重写：暖珊瑚视觉 + 两种身份关键流程（2026-10-25）

用户授权的前端重写（handoff/claude-frontend/J_JIYU_PROMPT.txt），视觉方向与用户讨论后定为“暖珊瑚 · 亲和”。后端/API 未改；技术栈不变。未提交 Git（上一轮 collection-draft 未提交改动同样保留在工作区）。

- **视觉系统**：`src/styles.css` 改 token（暖白底、珊瑚 #e8613c 强调、标题改无衬线粗体、圆角加大），旧硬编码颜色统一映射；文件末尾新增“Visual system v2”层：主按钮珊瑚、侧栏当前项珊瑚浅底、材料状态一色一义（绿=核对通过、红=缺项、琥珀=待核对/未分类、紫=需补充、灰=旧核对过期/选填）。index.html theme-color 同步；AGENTS.md 视觉条目同步更新。全部功能页继承新视觉，未删入口。
- **发起人**：材料矩阵每格显示带颜色的状态标签；整行可点开详情，当前行高亮；宽屏（≥1180px）详情变为右侧粘性抽屉，矩阵留在左侧；窄屏仍为卡片 + 下方详情。整行文字区分“有材料需补充”。
- **提交者（手机优先）**：每项材料一张卡片，卡内“上传 某材料”选的文件自动归到该项（仍可在“调整归属”里改，未分类仍提示）；通用拖放区降为“其他文件”；提交按钮仅在可提交时吸底；成功页“保存私密回执”为主按钮。上传 / 续传 / 回执 / 替换逻辑与 API 载荷未改。
- **一句话草稿**：核实前后端已接线（/api/ai/collection-draft 已注册，创建时 confirmCollectionDraft 校验）；无模型时界面明确“模型尚未配置”，同意框与生成按钮禁用，未伪造返回。
- **实际验收（隔离实例 http://127.0.0.1:3012，数据 `.artifacts/frontend-rewrite-20261025/data`，本机测试管理员凭据只存于该目录 ACCESS.txt）**：桌面用“社团作品征集”模板建任务（名单 A01/A02）→ 390px 手机打开提交链接，按材料卡分别上传报名表 / 作品说明并提交，取得并下载私密回执 → 桌面矩阵显示 A01 两项“待人工核对”、A02 两项“缺项”，宽屏抽屉打开 A01，将作品说明人工记“需补充”并写说明 → 手机凭回执查询，看到“需补充”及说明原文，“替换本批文件”经材料卡重选两份并提交 → 桌面刷新：新文件均“待人工核对”、旧结论未继承、旧两份进入回收站 → 实际导出台账 CSV（A01 待核对、A02 缺项、选填未交）。AI 预核对面板显示“模型尚未配置”。`npm run build` 通过，`npm test` 51 通过 / 3 跳过 / 0 失败（与改动前一致）。原 3002 样例与正式 data 未触碰。
- **证据**：`.artifacts/frontend-rewrite-20261025/`（screenshots/、ledger.csv、A01-private-receipt.txt，均不入 Git）。
- **限制 / 待办**：内置浏览器面板被遮挡时无法截图，宽屏抽屉与替换后状态以页面 DOM / 接口读回核实；部分操作因面板坐标不可靠改用对真实元素触发 click / input 事件；上传以合成文件字节放入真实 file input。390px 下浮动“集屿 AI”按钮遮挡底部说明的旧待办未处理；文件管理、存储、设置等次要页面只继承新视觉，未单独重排版。

此前阶段记录（保留成果，当前不续做）：control_run_id=manual-20261025-1，一句话生成材料清单草稿，经人工确认走原创建流程。已核实没有等价创建建议，原助手限于收件后整理 / 预核对；未提交代码保留，Claude 已核实前后端接线。真实模型仍 not_run，本轮不将该草稿阶段冒称新交付，当前范围以上述 backend-alignment 阶段为准。

更新：2026-10-25（Asia/Taipei）。project=J；control_run_id=manual-20261024-2；candidate-20261024-1。

- readiness: local_candidate_ready。第二阶段「有依据、可审阅的 AI 材料预核对」已完成；主控于 2026-10-25 亲自实际界面验收，有限合成主线未发现新的业务阻断。保持冻结供用户体验，不开第三阶段，不循环增加测试或优化。
- external_validation: waiting_external_validation。当前无已授权产品模型 API，真实语义质量 / 成本 / 时延 / 采用均 not_run。当前可体验的是工程协议及人工处置闭环；内部注入不代表真实模型效果。
- 原仓库 D:/Code-D/filegeter；Fastify / React / SQLite schema 5、npm、暖纸风格沿用，无新依赖 / 服务 / OCR / 网盘平台、子代理、新聊天或定时器。正式 data / 账号 / 上传未改；未发布 Release、部署或外联。

## 本轮交付

- 明确选择 1–10 个文件，发送前本机展示任务要求、文件归属与精确摘录。每份最多 4,000 字符、合计最多 8,000；未读 / 失败 / 超限 / 部分页明确标记。元数据和正文分别逐次授权，不附带私人名单或额外提交人字段；正文自身的个人信息由操作者审阅。
- 结构化逐文件问题、不确定性、可能材料归属与补充建议；依据须同一文件别名、精确 UTF-16 左闭右开位置及逐字匹配授权片段。错文件、伪片段、未读取部分、范围外材料、遗漏文件被拒绝；未读文件不能给内容或归属结论。
- 快照绑定任务 / 规则、活动文件集合、文件 ID / SHA / 分类 / 核对及提取状态 / 时间 / 完整索引摘要。调用前、返回后和人工采用时验证；补交、替换、规则或提取版本变化令旧建议失效，晚回包不写成功计划。
- 手机 / 电脑查看原文与上下文，逐文件确认后将建议带入原分类 / 人工核对表单，可修改再手动保存。AI 不直接通过材料；服务端复用权限、版本、原子写入和幂等重试，并持久化人工处置来源。
- 沿用模型设置 / 加密密钥 / 共享每日额度 / 最多两并发及既有正文索引。短期范围预览最多 30 份 / 15 分钟；建议存 ai_plans，跟随最近 1000 次 AI 记录清理，完整备份沿用。内部测试只通过 createApp 注入，公开请求参数不能启用夹具或绕过配置 / 授权。

## 已测与证据

- npm run build 通过。server/ai.test.ts、ai-content.test.ts、materials.test.ts 共 5 项相关既有回归通过。新增 material-ai.test.ts 覆盖整个闭环，保存失败链修正后单独复验通过；未重复原首轮 52 项 / 49 通过 / 3 本机跳过的无关链。首轮结果沿用；本轮源码 0854fdb 的 CI 40107680257 已实际返回 success：https://github.com/1Beyond1/jiyu/actions/runs/40107680257 。
- 新测试合并覆盖授权 / 未配置 / 客户端不能选夹具、精确引用及空白位置、错文件 / 伪片段 / 未读 / 超限位置 / 错材料 / 遗漏文件、401 / 403 / CSRF、跨任务、旧快照 / 晚回包、正文重提取、本人大批次变化、人工重试、共享额度及拒绝后的零调用；保存建议后故障注入 ERR_SQLITE_ERROR/13 返回 507，整笔计划回滚，不留下半份成功建议。
- 浏览器主线：A01 两文件精确授权→电脑查看依据 / 原文并手动记需补充→手机单文件预核对并手动归为作品说明（仍待人工核对）→新建议→手机凭本人回执实际替换原两文件→双端旧建议过期，采用按钮禁用。A02 同时展示一个未读文件和长文件仅前 4,000 字符，未调用模型替未读部分下结论。
- 360 / 390 / 430 / 768 / 1440 px 的新建议区域无整体横向溢出。viewport 覆盖已恢复；实际来源 / 处置数据读回已完成，后续不因非阻断截图定位再反复重演。
- 开发阶段隔离证据 D:/Code-D/filegeter/.artifacts/j-material-ai-qa/：independent-expected.json 在准备样本前写入；readback-results.json 保存当时 3 份计划的引用 / 实际 TXT 位置 / SHA、2 次人工处置、0 自动通过及 A01 替换读回。desktop-evidence.png 为当时桌面依据截图，layout-checks.json 为五档测量。主控后续已实际操作 A02，当前数据库及 last-authorized-request.json 已继续变化，不再将开发阶段计数当作当前计数。数据与截图均忽略，不进 Git。

## 2026-10-25 主控实际验收后指引

- controller-qa-20261024-1：主控亲自完成 A02 精确授权、新建议、390 px 原文核对 / 人工需补充、本人回执替换、旧建议过期且不可采用；未发现新的业务阻断。完整记录在 D:/Code-D/ai_competition/CONTROLLER_QA_20261025.md，证据在其 output/playwright/controller-qa/。本会话只准备了环境，没有代跑该验收。
- 主控替换后，原 manifest 与先前 CONTROLLER_ACCESS.json 中的 A02 回执均已失效。当前有效合成私密回执仅在 D:/Code-D/ai_competition/output/playwright/controller-qa/j-synthetic-private-receipt.txt；凭证不复制到聊天或 Git。隔离 CONTROLLER_ACCESS.json 的 currentReceipt.sourceFile 与 EXPERIENCE.txt 已指向该文件，账号信息仍只在忽略目录。
- 3002 隔离服务保留供体验，不重置数据、不生成新计划、不重跑检查、不改业务代码。390 px 浮动 AI 按钮遮少量底部说明已列非阻断待办；本轮实际核对 / 保存 / 替换可用，后续布局批次再处理。

## 体验入口及停止条件

- 正常候选版：在原目录停止旧服务后运行 npm run build，再 npm start；打开 http://127.0.0.1:3000。使用自己的原账号；收集任务→材料收齐与核对→查看某人材料→选文件→AI材料预核对。未设置模型时明确不可发送；正文先在文件详情识别。
- 无 API 本地工程样例：在原目录运行 node --experimental-strip-types .artifacts/j-material-ai-qa/run.mts，打开 http://127.0.0.1:3002。合成账号及样例现状见该忽略目录的 EXPERIENCE.txt；这是明确标记的内部注入，绝不访问真实服务商。已保留本人替换后的现状与历史记录，不自动重置样本或正式数据。
- 非阻断待办：390 px 浮动 AI 按钮遮少量底部说明、长名单定位、提示时机与历史查找便利性。真实 API / 质量评估 / 实体手机 / 微信或支付宝 / 真实网盘 / VPS 继续未测。不因这些外部条件寻找其他密钥或无限追加假场景。
- 后续仅由用户明确体验问题、新需求或提供真实条件并要求继续时，界定有限阶段；本轮完成回报后停止改代码。

## Git 与回报

- 本轮源码 0854fdb196c6a50a7d72def4748d36a557212bc5 已正常推送 origin/main（21f16e0..0854fdb），连同原先待同步状态文档一并上传；1Beyond1 与仓库隐私邮箱署名。无强制推送 / 证书降级，无标签 / Release。隔离服务于 2026-10-25 按总控要求恢复（准备时 PID 51268），当前保留供体验，正式服务未改。
- 固定总控 01a162b9-3b6f-79a2-b30e-1e150a6ccc70（local）。event_id: J:material-ai-20261024:completed:1；已先保存状态，再通过 send_message_to_thread 向固定总控发送一次 PROJECT_EVENT 请求 candidate-20261024-1 集中验收，工具返回目标 threadId 且无错误。本轮停止改代码，不开启第三阶段。

## claude-fixes-20261031-1（本地，未提交）

- 空文件统一拒绝；旧直接上传延后共用校验至文件流读完，新旧上传路径均有回归。旧续传测试原含空文件，改为非空并补传分片。
- 材料任务卡片及详情按名单/已提交人数显示必需项收齐和核对通过，名单外不计；普通任务保持文件份数。
- 可信 DNS 使用显式环境变量指定域名；首次未初始化且仅回环监听时输出初始化口令。
- npm test 65 通过、3 跳过；npm run check / build 通过。主控在 390 提交页实选空文件并验证拒绝，正常提交后详情显示 1 / 3 人收齐、0 人核对通过；证据 J_EMPTY_390.png / J_PROGRESS_390.png。
- 测试代码展开后，启动 / DNS 两项相关测试通过；阶段净增 107 / 删 25 行（代码、测试及指定文档，不含本记录）。隔离合成服务已关闭；无真实模型调用。

## 独立复验后的第二轮修复（Claude，本地，未提交）

- 材料面板与进度条统一按名单人数统计，名单外已收齐的人单独显示。npm test 65 通过、3 跳过；check 和 build 通过，dist 已重建。未调用模型，未打包。

## 预置模型，AI 开箱可用（Claude，本地）

- 新增 `JIYU_AI_BASE_URL` / `JIYU_AI_MODEL` / `JIYU_AI_KEY`：服务器预置模型后用户免配置；Key 只在进程环境，不进数据库和响应；发送确认和每日上限保留，管理员可改用自己的模型或关闭。
- 预核对不再要求先手动识别正文，未勾选时默认核对此人的材料（最多 10 份）。
- RiverAI（DeepSeek-V4.1-Flash-1017）合成数据实测：一句话起草 3–8 秒，敏感材料请求被拒；预核对约 4–5 秒，能指出缺用途和占位内容并引用原文；浏览器走通。未经真实用户验证。
- npm test 67 通过、3 跳过；check / build 通过。

## 冷启动走查（Claude，本地）

- 真实模型下走通一句话起草到建任务，手机提交页 375 宽度无横向滚动。修了：原话里的截止日期被忽略、模型提的澄清问题必须回答才能继续（现在可明确跳过，服务端记录）。npm test 68 通过、3 跳过；check / build 通过。文件上传到材料核对这段本轮未在界面重走。
