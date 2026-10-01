# PROGRESS — pi-claude-code-core 实施进度

> 每模块:状态 / 复查结论 / 测试计数 / 剩余风险。日期均为 2026-09。

## goal-hijack 修复批(2026-10-01,spec 2026-10-01-goal-hijack-fix)

**状态:实现完成 + 对抗 review 通过折入(v1.2,F1-F9 全处置:runner env 纪律/GH-04 断言/台账同步),三门全绿(常规与模拟子代理 env 双复验)。**

- **GH-02** `loadState` 子会话跳过磁盘收养 + **GH-02b** `reconcileFocusedGoalFromDisk` 同判定返回(补充守卫:命令/工具路径 mid-session 重读盘,实施中发现);**GH-03** `queueContinuation` 顶部早退(双保险,五调用点)。
- 探测复用 `modes/permission-forwarding#isSubagentChildProcess`(goal→modes 跨模块 import,无环;PI_SUBAGENT_* 只消费,P0-CT-06 边界不动)。
- FakeHost 补 `idle`/`hasPendingMessages` ctx 选项(既有 fidelity 缺口:缺 hasPendingMessages 时 product try/catch 吞 TypeError,续跑在 fake 从未武装)。

## memory 召回修复批(2026-10-01,spec 2026-10-01-memory-recall-fix v3.1)

**状态:实现完成 + 对抗 review 通过折入(v3.2,findings F1-F11 全处置:1 major 补计费守卫测试、F4/F5 两处代码缝隙修复、其余文字/nit),三门全绿复验。**

- **MR-01/02/03** per-turn pin & re-project:`pinnedTurn` 状态,turn 首个 context 事件选取+pin(查询=最后一条非 customType user 消息),turn 内逐请求重投影字节级同一块;`before_agent_start` 清 pin,`session_compact`/`session_start` 全量重置。删除 `surfacedRecallKeys`(宿主源码取证:投影 request-ephemeral,反查永远空集)。
- **MR-04** 双域匹配:primary(title+description ≥2)或次级(≥1 且 body ≥2)入选,body 仅 tiebreaker;body-only 永不入选。
- **MR-05/08** `surfacedKeys` 计费化(每文件每 session 一次,`isPrePaid` 谓词不再消耗剩余预算);read 抑制保留。
- **MR-09** 缓存纪律:尾部追加不变量、turn 内字节稳定、systemPrompt 索引字节稳定(三守卫用例)。
- **用例翻转**:memory-v2-storage AD1 用例改写为 v2 语义;mode-inherit.test 预存隔离 bug 顺手修(ambient env 泄漏)。
- 新增 describe `MR memory-recall fix v3.1` 8 用例 + isPrePaid 直测。

## 二轮深审修复批(2026-09-22,REVIEW-II)

**状态:实现完成 + 对抗审计通过(红队 3 subagent:真实性轴全绿,回归轴 4 残留已修),三命令全绿,已待 commit。**

来源:code-review skill 双轴全量深审(4 并行子代理 + 关键发现亲验)。处置面:Spec 轴 4 应修全修 + Standards 轴 11 应修全修 + 实质性建议项;台账 #48-#61 连号(DEVIATIONS)。分组:

| 组 | 内容 |
|---|---|
| Spec 语义 | S1 effort 兜底翻转(§3.3 兑现,resolveEffortForMode 无显式→undefined,modes 守卫成真,2 用例红绿翻转);S2 settings/model-id 收敛补完(P0-LB-04「P2 收尾全收敛」兑现;PLAN §1.4「×2 份」表述失实记录);S4 memory 通道 readCoreStatus 断言补真(#47b② 闭案);S5 特异度分层(精确>server 前缀>裸 mcp_*);S6/C5 RuleFamily.matchesRule+familyRuleMentions(web ask 走全弹窗、deny 展示真实规则+source);S3 web 认领限定 mcp 形态;S7 flag pin 提示;S11 defaults 文案 |
| memory 核心 | C1 CJK bigram 分词(中文 lexical 注入从不可用变可用,最重发现);C7 字节口径统一(byteLength 全面);A4 缓存键控+namesKey 失效;A5 scanMemoryDirCached 指纹缓存+git root memo(每 turn 3 遍全文读→零内容读) |
| memory 其余 | C2 secret regex(无引号/base64 padding);C8 readLines UTF-8 边界 withhold;C10 customType 过滤;C11 导入不覆写本地编辑;C9 query 移除+子域名预批准;C13b reset 文案 |
| mcp/web-gov | C3 broker 复用 canonicalize(native 前缀不再误拼);C4 mirror 防重入+shutdown 清理;A3 面板 ruleValueText;A7 ALL_LEVELS 加 max;C6 appliesNow 口径(fake-host 防御) |
| lib/rules 小项 | rule-text 去反向依赖(structural 内联);readJson onInvalid throw 传播;A8 steerRule 提取;A9 死参数+globalHome env 默认;C13a 降级净增守卫;review-run/paths 死代码清理(#46 闭案) |

- **测试**:vitest **574**(558 + 深审新增 12 + 对抗审计新增 4)+ node--test **312**(72+75+165,断言零改动)+ 契约 **17**;`bun run check` exit 0。
- **对抗审计批(#62)**:红队抓出 4 项修复残留并修毕——C8b(4 字节 emoji 边界,回扫上限 3→4)、C11b(hermes invalid 本地文件覆写,existsSync 化)、C13ab(小预算 break 出口超预算,整块丢弃最小块)、C1b(虚词 bigram 停用词 + bigram 分支补过滤);顺手:broker probe 前 stop、globalHome 惰性。挂账疑点 5 项记录于 #62。
- **用例翻转(行为变更,均 spec 背书)**:profiles「defaults to medium」→「returns undefined」;index.test 两处 applyProfileModelForMode 断言 medium→off;p4 webfetch 认领→null、extractHost query→null。
- **挂账(#61)**:rule-families 四职责拆分、yield 标记 systemPrompt 语义真机验证、空 diff 守卫顺序、C6 无独立单测。

## REVIEW-2026-09-22 修复批(codebase-design 规划)

**状态:处置完毕,复查通过(2026-09-22,一轮有条件 PASS + 补修),已 commit。**

### 修复分组(deep-module 视角:散点知识收敛进汇聚点)

| 组 | review 发现 | 处置 |
|---|---|---|
| A 放行链 | #11(Minor 最重)+ #38③ | 一次性 Allow 记录点收敛到 `applyApprovalDecision`(交互/转发/规则 ask 三路必经的汇聚点),`allow_always_*` 落盘后记 rule-allow;step-2 allow 分支复用同一 helper;新增端到端用例(显式 ask 规则 → Allow → adjudication 在 → mirror allow_once) |
| B rules | #13 #14 #15 #16a/b/c | 降级循环核算全部输出字节(段头/连接符/尾注预留),预算改精确断言;降级次序「条件 fold-in 先降」对齐 spec;首触 steer 超 DYNAMIC_STEER_MAX 改按需 Read 指针(不截全文);指纹升级文件级(mtimeMs+size,内容编辑可见);tool_call 复用指纹缓存(collectRules 结果随缓存,零额外扫描);activatedNames 不随指纹清空 |
| C memory | #17 #18 | 可写探测 accessSync(W_OK);不可写真降级 policy-only(不注索引);chmod 555 测试落地;reconciler 热路径零内容读(entries 走缓存) |
| D lib 收敛 | Standards #4/#6 + 真实 bug | 新增 `lib/rule-text.ts`(ruleValueText/ruleMatchesId/isInsideDir),替换 4 份提取、2 份尾通配、guard 裸 startsWith;25K 常量统一 MEMORY_INDEX_MAX。**修实真 bug**:parser 对象 ruleValue 经 `String(.value)` 提取失明(持久规则对 first-seen/ruleMentions 不可见) |
| E 清扫 | Standards #1/#2/#3/#8/#9 + Spec #3/#6/#7/#20 | resolve 序 stale 注释 ×4、check.mjs 消息(成功路径保留输出)、types 注释旧文件名、memory/memdir/importers/paths/render 死代码与投机参数、`@/abs` 双斜杠、overlay 死 disable、planPhase 生产者补齐、fresh-clone 守护(check.mjs)、effort-owner d) 用例实化、session_recall 空文案口径(web-gov 注册序注释与 void ctx ×2 属复查二轮补修,见 #47b) |
| F 台账 | #1 #8 #9 #10 #12 #19 | #20 引证改本地 ec2bcbe;FORK.md 命令族 14 枚举补全;goal bus 发布移出 hasUI 门控(与 review 通道对称;**复查二轮补修——初版虚报**)、direct 形态配置 seam(`PI_CORE_MCP_DIRECT_SERVERS`)+ README 注明;contextBudget/memory 通道 readCoreStatus 断言(**复查二轮补修——初版虚报**);随机性质测试(seeded PRNG ×10:≤budget + 字节确定);rules↔pm/goal 共存测试(append-only 不碰既有标记);chmod 测试 |

**择优认定(不修,已挂 DEVIATIONS #47)**:#5 写入即 0600(安全正向)、#4 malformed mtime 缓存内不 re-warn(诊断降级)、Standards #8 的 context `as never`(类型面成本)、#12 的 env 配置 seam(已接)。

### 测试计数

- vitest **557**(554 + review #11 端到端 + plan/auto 首调 + chmod + 随机性质 + 共存 + B1 ask-vs-allow 断言)+ node--test **312** + 契约 **17**
- `bun run check` exit 0(含 fresh-clone sibling 守护)

### 复查结论(2026-09-22,新鲜眼 subagent,一轮)

**有条件 PASS → 补修后达门槛。** 复查亲证:28 条中 21 条真实修复(A 组全、C 组全、D 组主体含真 bug 修复成立、E 组 7/9、F 组部分);两个 PARTIAL(#13 块间连接符欠账、#16a 双扫→单扫)均 Minor 且无红线击穿;三命令全绿、契约与 441 随迁零改动。

- **复查抓出四处自报失实**(python replace 静默失败再现):#10 goal bus 门控、通道断言、web-gov 注释、void ctx ×2——**全部已补修**,台账以 #47b 修正并记录教训(「已修」自报必须实测背书)。
- 顺手补修:#13 连接符核算、#16a 激活热路径真零扫描(cachedRules 内存匹配)、mirror allow_always 写失败 fail-closed、check.mjs 成功输出、两处幽灵注释。
- 挂账:allow_always 写失败深化(P4-MC-02)、MC-05 floor、MC-06 inventory 链(已在 #38)。

## P4 — mcp-gov + web-gov(1.3.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.3.0 + deprecate 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P4-FAM-01 | RuleFamily 扩展点:modes/rule-families.ts registry;evaluateToolPermission 在 mapPiToolToCcTool 未命中后、passthrough 前遍历;verdict 折算进既有 behavior 契约(step2 消费机制零改动) | ✅ |
| P4-FAM-02 | 首见弹窗语义:ask/plan/auto 经 step2 统一(先于 ladder);plan 的 mcp 不在 PLAN_READ_TOOLS 天然不进只读 carve-out;auto 下 family verdict 先于 classifier;非 mcp 未知工具不受影响(direct 命名 knownServers 白名单,宁漏勿误) | ✅ |
| P4-FAM-03 | suggestAllowRuleForToolCall 委托 family | ✅ |
| P4-FAM-04 | 红绿:ask mcp first-seen 弹窗(原静默放行);Allow once/session/always 三路;非 mcp 未知工具 ask/plan passthrough 不变 | ✅ |
| P4-FAM-05 | sessionGrants:内存 Set;session_start/shutdown 清;first-seen「Allow for this session」写入;/permissions 列出 + /permissions-clear-grants 清除 | ✅ |
| P4-FAM-06 | web-gov 第二 family 注册进同一 seam | ✅ |
| P4-MC-01 | canonicalize 三形态(native 前缀/proxy input.tool/direct+knownServers);resolve deny>allow>ask 前缀匹配 | ✅ |
| P4-MC-02 | Allow always 落盘复用 addPermissionRule(global);建议 `mcp_exa_*`;写失败 fail-closed | ✅ |
| P4-MC-03 | broker 镜子:同步纯 decide(五支放行链:adjudicated→bypass→rule→sessionGrant→allow_once,否则 fail-closed deny 计数);noteAdjudicated 单点记录(gate allow 路径 + first-seen 各放行分支) | ✅ |
| P4-MC-04 | 一致性矩阵:5 结局 × bypass 两态(gate 放行⇔mirror allow;deny 计数) | ✅ |
| P4-MC-05 | McpEventPort seam:动态 import 探测(本机 adapter 未装 → absent idle 零副作用,实测路径);版本降级(未知字段忽略) | ✅ |
| P4-MC-06 | /core 面板 MCP 段:live snapshot ‖ readStaticMcpInventory 降级 + 规则摘要 + install hint | ✅ |
| P4-MC-07 | 首查:本机无 pi-mcp-adapter,claim 语义无法实测——按 spec 风险①预案实现(架构不变;callId 不依赖,canonicalId 走 server/tool;记 OPEN-QUESTIONS) | ✅(按预案) |
| P4-WB-01 | createWebRuleFamily:URL 工具→host;`webfetch(domain:host)` 规则(显式规则 > 预批准) | ✅ |
| P4-WB-02 | 预批准域名清单(builtin 14 域)可经 pi-core-web.json 覆盖 | ✅ |
| P4-WB-03 | D7 落地:README exa 接入引导;defaults 搜索文案改定版「exa MCP 优先」;pi-web-access 退役用户侧 | ✅ |
| P4-WB-04 | Sources 尾注规则已在 P3 defaults(P4 不重复实现) | ✅ N/A |
| P4-REL-01 | 发 1.3.0 + 旧四包 deprecate:用户侧 | ⏸ 用户 |

### 测试计数

- `bun run test`:vitest **553 passed**(P4 新增 16)+ node--test **312 passed**
- `bun run contracts`:**17 passed**
- `bun run check`:exit 0

### 剩余风险

1. P4-MC-07 两项(broker claim 同步性/approval callId)未实测(本机无 adapter)——mirror 架构对两者免疫(同步纯函数 + canonicalId 走 server/tool),真机验证归 P4-REL 冒烟。
2. /permissions 的 grants 展示为文本段 + 独立清除命令(非交互清除),v1 可接受。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 三命令实测全绿、计数精确对账;modes diff 审计干净(全部 hunk 属 family 机制所需,441 零改动);契约零变化;absent port 零副作用经真机探针证实。

- **阻塞发现(已修复)**:B1 resolve 序 deny>allow>ask 违背 spec「deny>ask>allow」(显式 ask 被 allow 前缀吞)——mcp/web 两处改序 + 断言。
- 非阻塞修复(已随本次处理):mirror bypassActive 生产断裂(setBypassIndicator 同步);session_shutdown 清 grants;WB-01 注册序(web 先于 mcp,域名规则优先);ruleMentions 尾通配;矩阵注释诚实化 + uiPrompts≤1 断言;plan/auto 首调弹窗端到端(红队 #2 增补态);PROBE 残留;OPEN-QUESTIONS #6(P4-MC-07)与 README knownServers 注明兑现。
- 挂账(DEVIATIONS #38):MC-05 版本 floor、MC-06 inventory 链/cached、FAM-05 转发计入结构性不可达。
- 遗留:P4-REL-01(1.3.0 发版/deprecate/真机 exa+bypass 冒烟)用户侧。

## P3 — rules 引擎 + memory 模块(1.2.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.2.0 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P3-RU-01 | 四层优先级 builtin<global<compat<project;project/compat trust 门控;同名 shadow(render.ts collectRules) | ✅ |
| P3-RU-02 | frontmatter name/description/globs/always;** 退化 always;无 frontmatter=always(scan.ts) | ✅ |
| P3-RU-03 | @include 四形态;缺失静默;环重访丢弃;深度 5;include 体在前(scan.ts expandIncludes) | ✅ |
| P3-RU-04 | 预算 40K:内联超限降级最大 always→索引;索引整行尾部丢弃;单文件>4K 只索引;>40K 整体剔除;绝不截中部 | ✅ |
| P3-RU-05 | total function:缺失目录 0 贡献;坏文件静默+尾注 `skipped N invalid`;字节级确定 | ✅ |
| P3-RU-06 | before_agent_start append-only systemPrompt(不动 contextFiles) | ✅ |
| P3-RU-07 | 索引+首触 steer(tool_call 捕获 path→glob 命中→sendMessage steer;每规则每 session 一次;session_start 重置) | ✅ |
| P3-RU-08 | mtime 指纹缓存;stat 计数断言(unchanged turn ≤3 = dir 数) | ✅ |
| P3-RU-09 | /rules 只读输出(名称/scope/globs/预算占用/激活数) | ✅ |
| P3-RU-10 | lib/context-budget.ts 静态切分 + bus `contextBudget` 可选通道(rules session_start 发布;reader 透传) | ✅ |
| P3-RU-11 | 文件布局 index/render/scan/paths/defaults(~700 LOC);paths.ts 的 session 历史挖掘未实现(不在行为规范,见 DEVIATIONS #29) | ✅ |
| P3-RU-12 | v1 无 setEnabled/lint/subscribe(工厂壳接口不变) | ✅ |
| P3-RU-13 | 首查:①input.path 实测确认(read.js schema `path: Type.String` + pm 同款用法);②parallel steer 以 0.85 文档语义实现,真机冒烟归 P3-REL(见 DEVIATIONS #28) | ✅ |
| P3-ME-01 | 磁盘格式 CC 1:1(memory/<slug>.md + MEMORY.md;git-canonical-root;pi 同款 sanitizer) | ✅ |
| P3-ME-02 | reconciler:≤200 行/25KB+WARNING;mtime 短路;坏 frontmatter 排除+skipped 计数 | ✅ |
| P3-ME-03 | policy 注入(自写 POLICY_COMPACT)+ capped 索引 entrypoint | ✅ |
| P3-ME-04 | selectForTurn lexical(阈值 2,≤5 文件×4KB,session 60KB,新鲜度头,不落 session);session_compact 重置 | ✅ |
| P3-ME-05 | 写路径=plain files;guardMemoryWrites secret 拦截器(7 类 pattern);无 memory_write 工具 | ✅ |
| P3-ME-06 | InjectionGate 双探测(静态 npm/settings 扫描+动态 `<memory-policy` 标记);只管注入;结果上 bus memory 通道 | ✅ |
| P3-ME-07 | session_recall 工具(AND 匹配,流式扫,toolResult 不命中,坏行计数,limit≤50,只读) | ✅ |
| P3-ME-08 | /memory-import-claude(不信源索引)+ /memory-import-hermes(§ 拆条+type 启发式);双跑幂等 | ✅ |
| P3-ME-09 | 降级与韧性:notifyOnce、注入 try/catch 永不阻断 turn、空目录友好文案 | ✅ |
| P3-ME-10 | v1 不做 provider seam/双工具/LLM(设计定稿) | ✅ N/A |
| P3-ME 首查 | ①hermes 本机在装(实测 node_modules 命中)→ 静态探测路径真实;②lexical 标定回放 CherryDev 存量 81 文件(见 DEVIATIONS #27) | ✅ |
| P3-PM-01 | modes carve-out(ask-ladder write/edit 分支+promptWithPermissionOptions 漏斗;路径特判);红绿 3 例(免审批/外仍弹/secret 仍拦) | ✅ |

### 测试计数

- `bun run test`:vitest **536 passed**(441 modes + 31 lib + 26 P1 + 5 P2 + 33 P3:rules-render 11 + rules-wiring 6 + memory 12 + carve-out 3 + review-degradation 3 中的 P3 无…… 精确列:11+6+12+3=32 新增) + node--test **312 passed**
- `bun run contracts`:**17 passed**
- `bun run check`:exit 0

### 真机冒烟(P3 可做子集)

lexical 标定回放(真实 CherryDev 存量 81 文件)即本 Phase 真机数据冒烟:强重叠命中目标文件、无关 prompt 零注入。P3-REL-01 完整清单(放规则生效/steer 可见/hermes 双装无双重注入)需发版后用户侧执行。

### 剩余风险

1. lexical 阈值 2 首日偏召回(标定实录:1 prompt 召回 3 弱相关,被 5 文件上限钳制);推翻条件(误报高烧预算)触发时升 3。
2. parallel tool mode 下 steer 送达批次未真机验证(按 0.85 文档实现);P3-REL-01 冒烟项。
3. rules 的 project/compat trust 门控在 wiring 层默认 true(pi 上游有 project_trust 事件门控扩展加载),若 pi 语义变化需跟随。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 三命令实测全绿且计数精确对账;modes diff 审计确认 carve-out 仅 18 行、441 测试零改动;契约断言零变化;P3-PM-01 联合红绿为真实双模块链。

- **阻塞发现(已修复)**:①P3-RU-04「绝不截内容中部」红线——收尾 slice 硬截 + 尾注超预算,已改为降级循环核算全部字节(含尾注预留),测试容忍收紧为精确 ≤budget;②调试残留 PROBE9 已删。
- 非阻塞修复(已随本次处理):>4K globs 规则首触永不 steer 且永久标记(steer 改取 collectRules 原文);动态 yield 翻转后 bus 快照不更新(补 publish);extraDirs 静默失效(collectRules filter);contextBudget/memory 通道零断言(补两条);深度 6 专项(红队 #11)补 fixture;60KB 预算耗尽 + session_compact 重置补断言;session_start 探针与 session_recall 的 cwd 口径统一;lastInjectedFiles 只写不读删除;5 条未申报偏差补台账(#32b)+ #31 残留补修(#31b)。
- 遗留:parallel steer 真机冒烟归 P3-REL;lexical 阈值推翻条件记录在案。

## P2 — pi-goal fork + pi-review 整体并入(1.1.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.1.0 + CCTUI 1.5.0 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P2-GO-01 | fork 入树 extensions/goal/(基线 ec2bcbe = npm 0.6.0 内容);FORK.md 完整(基线 hash/npm 0.6.0 比对/差异清单/跟进策略) | ✅ |
| P2-GO-02 | 75 项随迁全绿断言零改动(计数考证见 DEVIATIONS #20);磁盘布局与 entry 类型不变(CT-08/09 对 core fork 实测绿) | ✅ |
| P2-GO-03 | 白名单:import 包内化(tests 扁平化)、auditor config→lib/settings、questionnaire→showComponentOverlay(bare 等价)、status 槽/widget 不变 | ✅ |
| P2-GO-04 | 命令族 14 + 工具族 8 签名不变(diff 审计:除白名单三文件外与 npm 0.6.0 逐字节一致) | ✅ |
| P2-GO-05 | 共存红绿:test/lib/coexistence.test.ts(双工厂同 pi,context 链式,互不误伤) | ✅ |
| P2-GO-06 | 上游跟进策略入 FORK.md | ✅ |
| P2-REV-01 | review 0.8.6 全量迁入 extensions/review/;165 测试随迁零适配全绿;4 命令 + pi_review_report 工具 + renderer 签名不变 | ✅ |
| P2-REV-02 | peer `pi-subagents >=0.41 <1.0` + peerDependenciesMeta optional | ✅ |
| P2-REV-03 | 降级路径红绿 3 例(test/lib/review-degradation.test.ts):缺工具拒跑+一次性 install hint;有工具放行 | ✅ |
| P2-REV-04 | 8 个 agent .md 随包分发;package.json `pi.subagents.agents` 声明;directive.ts 陈旧产物防御保留(源码未动) | ✅ |
| P2-REV-05 | 磁盘布局不变(CT-09 切 core review 后实测绿) | ✅ |
| P2-REV-06 | review config 读写迁 lib/settings.ts(165 测试兜底)——PLAN §1.4 三类重复中 settings/model-id/picker 收敛(effort 的 fast-mode 落盘按 P0-LB-04 白名单保留自有实现,非收敛对象) | ✅ |
| P2-BUS-01 | bus goal 通道(active/paused/summary,updateUI 挂 publish)+ review 通道(running/done+lastRunAt) | ✅ |
| P2-BUS-02 | 通道红绿(test/lib/bus-channels.test.ts):goal 恢复→active→pause 翻转;review done 经 pi_review_report 真实工具路径;readCoreStatus 类型断言 | ✅ |
| P2-CCTUI | **用户侧**(本次派发不改 CCTUI 仓库;bus 双写保证现版无感) | ⏸ 用户 |
| P2-REL | 发 1.1.0 + CCTUI 1.5.0 + settings 切换:用户侧 | ⏸ 用户 |

### 测试计数

- `bun run test`:vitest **504 passed**(441 modes + 31 lib + 26 P1 + 5 P2 新增)+ node--test **312 passed**(effort 72 + goal 75 + review 165)
- `bun run contracts`:**17 passed**(goal/review 目标已切 core,断言零改动)
- `bun run check`:exit 0(goal 0.6.0 类型漂移已入树修复,P0 白名单机制自动过期撤除)

### 真机冒烟(P2 可做子集)

`pi -e ./extensions/index.ts --no-session --no-tools`:四模块装配加载无自身错误;goal 工具族(get_goal/create_goal/update_goal)注册并使本机旧包冲突弃用(切换期预期形态)。完整冒烟(P2-REL-02:/review 全轮、goal 建目标→widget、共存一晚)需发版切换后执行,用户侧。

### 剩余风险

1. review `/review` 的 bus running 发布仅在命令 handler 内(prepareRun 后),单测未驱动(需 git/PR 环境);由 P2-REL-02 真机冒烟覆盖。
2. goal-auditor 的 0.85 modelRuntime 行为(不再继承主会话 registry)——auditor model 均显式解析,真机 /goal 完成审计时观察。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS(修复后)— 达 commit 门槛。** 随迁零改动 diff 审计全部通过:goal fork 对照 npm 0.6.0 tarball 仅白名单三文件不同;review 的 tests/agents/reference 与源包零差异,src 差异逐 hunk 判定为申报内改动;契约断言文件零变化。DEVIATIONS #20-#26 裁定合理。

- **阻塞发现(已修复)**:review running 发布因替换锚缩进不匹配静默未插入,与三处自报不符——已补(index.ts prepareRun 成功后),P2-BUS-01 完整。
- 非阻塞修复(已随本次处理):types/index.d.mts CoreSnapshot.goal 补 paused?: boolean;reader paused 透传显式 false;bus-channels 补 /goal-resume 后 paused:false 断言;DEVIATIONS 补 26b(165 vs 161 考证);.gitignore 补 .pi/;FORK.md 注 docs/README 未随迁。
- P2-GO-05 的真机同屏冒烟半边、P2-CCTUI、P2-REL:用户侧(P2-REL 窗口)。

## P1 — modes + effort 并入 + capability bus 首发(1.0.0,本次不发)

**状态:实现完成,复查通过(2026-09-21),已 commit(未发版——1.0.0+ 留用户)。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P1-PM-01 | pm 2.8.0 全量迁入 extensions/modes/(import 包内化;改动仅白名单+bus 接线) | ✅ |
| P1-PM-02 | 441 vitest 随迁零断言改动全绿 | ✅ |
| P1-PM-03 | 契约套件 modes 目标切 core 模块,CT-01..09 断言零改动持续绿 | ✅ |
| P1-PM-04 | 白名单:①profiles :effort → EffortOwner.setFromProfile;②alt+t → setExplicit("shortcut")+envPin;③settings→lib/settings.ts(config/profiles/permissions-loader)、plan-approval-dialog 底座→lib/overlay.ts | ✅ |
| P1-EF-01 | @mariozechner→@earendil-works 全量替换,peer 提至 >=0.85<1.0;API 面 tsc 为准(漂移适配见 DEVIATIONS) | ✅ |
| P1-EF-02 | effort 迁入;命令/快捷键/flag 保持;picker 底座→lib/overlay.ts;fast-mode 落盘键不变 | ✅ |
| P1-EF-03 | 72 项随迁全绿(spec 写 74,源包基线实测 72),node--test 保持 | ✅ |
| P1-EF-04 | status 槽 pi-effort-thinking/pi-effort-fast 不变(契约套件对 core effort 实测) | ✅ |
| P1-EF-05 | lib/effort-owner.ts 所有权链 ①env>②explicit>③profile>④默认(接口微扩见 DEVIATIONS) | ✅ |
| P1-EF-06 | 红绿 a)–f) 六条 + changed()/共享单测(test/lib/effort-owner.test.ts,12 用例) | ✅ |
| P1-EF-07 | source-scan:extensions/{modes,effort} 零直接 setThinkingLevel 调用(红→绿钉住) | ✅ |
| P1-BUS-01 | __piClaudeCodeCore frozen 纯数据快照 + __piClaudeCodeCoreCmd 写通道(extensions/bus.ts) | ✅ |
| P1-BUS-02 | ./types subpath:纯 .mjs + .d.mts,total reader readCoreStatus(fallback 新 key→legacy→默认) | ✅ |
| P1-BUS-03 | publishCore 唯一发布口,显式 per-channel patch,同批次派生写 legacy | ✅ |
| P1-BUS-04 | version 固定 1、revision 单调、无定时器;presence gate 留在 modes 实现细节 | ✅ |
| P1-BUS-05 | publish 后新 key + 2 个 core 可写 legacy key 同步一致(bus.test.ts) | ✅ |
| P1-BUS-06 | frozen/整体替换/revision 单调/未触碰 channel 引用不变 | ✅ |
| P1-BUS-07 | reader total 矩阵(undefined/{}/v0/v1/v99+garbage)全不 throw(bus-types.test.ts) | ✅ |
| P1-BUS-08 | Cmd unknown → {ok:false,"unknown-command"} 不 throw;dispose 清 core 自有 key(legacy 残留按 CT-03) | ✅ |
| P1-BUS-09 | 写侧(bus.test.ts)与读侧(bus-types.test.ts)文件互不 import,撤除互不阻塞 | ✅ |
| P1-BUS-10 | v1 无订阅字段断言 + v2 onChange 数据字段预案注释(bus.ts/types) | ✅ |

### 测试计数

- `bun run test`:**498 passed**(modes 随迁 441 + lib 31 + effort-owner/bus 新增 26)+ node--test **72 passed**(effort 随迁)
- `bun run contracts`:**17 passed**(modes/effort 目标已切 core 模块,断言零改动)
- `bun run check`:main OK + contracts OK(goal 0.6.0 两行已知漂移白名单)

### 真机冒烟(P1 可做子集)

`pi -e ./extensions/index.ts --no-session --no-tools -p hi`:core 装配(bus+modes+effort)加载无自身错误;flag `--effort/--permission-mode/--model-profile` 与工具 `plan_ready` 均注册,与本机旧包并装时 pi 判定旧包冲突并弃用旧包、core 胜出(切换期预期形态;P1-REL-03 完整清单需发版+切 settings,本次不做,见 OPEN-QUESTIONS)。

### 剩余风险

1. bus effort/goal/review 通道的 P2 填充(goal/review 空骨架已发布)。
2. `setMode`/`setEffort` Cmd kind 的真实处理器未注册(v1 只交付 registry + unknown 契约;待 /core 面板 P4 接 ctx)。
3. effort 的 integration 测试对 0.85 loader 的三处 setup 适配(见 DEVIATIONS #9),上游再变需跟随。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS — 达 commit 门槛。** 21 个实现 spec ID:20 PASS + P1-REL 流程项(与 P0-SK-04 同性质,待发布窗口)。要点:

- 三命令实测全绿且计数精确对账(498 = 441+31+26;effort 72;contracts 17)。
- 随迁断言零改动经独立 diff 审计:pm 22 个测试文件**逐字节零差异**;effort 3 文件 diff 逐 hunk 判定全部为 DEVIATIONS #9 申报的 setup 适配,断言行零改。
- 契约测试文件与 P0 commit diff 审计:断言文件实质零改动(disk-layout/env-forwarding 仅 import 随被测对象切换,属 P1-PM-03 本身)。
- DEVIATIONS #8-#18 全部裁定为合理裁量。
- 修复的复查发现:permissions-loader malformed 语义恢复(#19);两处测试注释失真修正。
- 遗留:P1-REL-01..04 待发布窗口执行(发 1.0.0、切 settings、完整冒烟、symlink 核查)。

## P0 — 脚手架 + 契约冻结(0.1.0)

**状态:实现完成,复查通过(2026-09-21),已 commit + 发 0.1.0-next。**

### 交付项与 spec ID 对照

| spec ID | 内容 | 状态 |
|---|---|---|
| P0-SK-01 | git init + package.json(name/pi.extensions/peer 0.85<1.0/devDeps pin 0.85.1) | ✅ |
| P0-SK-02 | extensions/index.ts 空装配(八模块位注释)+ test/contracts/ | ✅ |
| P0-SK-03 | `bun run check`(scripts/check.mjs 双 tsc 门)/ `bun run test`(scripts/run-tests.mjs 统一入口)/ `bun run contracts`(独立 vitest config) | ✅ |
| P0-SK-04 | npm 发 0.1.0 `--tag next` | ⚠️ 被阻:本机 npm 未登录(ENEEDAUTH),记 OPEN-QUESTIONS #1 由用户执行;包体与 publishConfig 就绪 |
| P0-SK-05 | spike① `/types` subpath 布局(npm pack + jiti + tsc 三验证过,见 test/spikes/types-subpath-spike/RESULT.md);spike② 显式 per-channel patch(5 个 @ts-expect-error 编译期证明,见 test/spikes/per-channel-patch.ts) | ✅ |
| P0-LB-01 | lib/settings.ts(readJson 从不 throw / writeJsonAtomic tmp+rename) | ✅ 9 测试 |
| P0-LB-02 | lib/model-id.ts(parseModelId,非法→null 不 throw) | ✅ 15 测试 |
| P0-LB-03 | lib/overlay.ts(showOverlay:custom overlay → select 降级 → headless null) | ✅ 7 测试 |
| P0-LB-04 | lib 单测(等价 + 边界);旧实现零删除(按白名单随 P1/P2 并入时删) | ✅ |
| P0-CT-01..03 | globalThis 契约(capability 形状/CCTUI 在场抑制+双 key/shutdown 残留+poller 停) | ✅ 5 测试 |
| P0-CT-04..06 | env/转发契约(INHERITED_MODE/转发目录约定/pm 不设 PARENT_SESSION) | ✅ 3 测试 |
| P0-CT-07 | status 槽白名单(容忍 effort 槽 undefined 清理写;pm 对 modes 槽的 undefined 写合法) | ✅ 2 测试 |
| P0-CT-08 | appendEntry 类型白名单(modes 经 shift+tab 路径行使;goal/review entry 由 P2 套件行使,此处钉「实例化+session_start 无白名单外类型」) | ✅ 1 测试 |
| P0-CT-09 | 磁盘布局逐一钉住(行为断言为主;pm config 默认路径与 review runs 路径为源码行钉住,原因见 DEVIATIONS) | ✅ 6 测试 |
| P0-CT-10 | test/contracts/README.md 契约→消费方→移除条件表 | ✅ |
| P0-CT-11 | `bun run contracts` 一键,测试名带 spec ID | ✅ |
| P0-CT-12 | test/contracts/fake-host.ts(pm createFakePi 模式扩展:status/widget/workingMessage 记录、env 快照、globalThis 清理、四包实例化) | ✅ |
| P0-CT-13 | (逃生门)本 Phase 无 todo 用例——四包工厂全部真实例化通过 | ✅ N/A |

### 测试计数

- `bun run test`(lib 单测):**31 passed**(settings 9 + model-id 15 + overlay 7)
- `bun run contracts`(契约):**17 passed**(globalthis 5 + env-forwarding 3 + status-entries 3 + disk-layout 6)
- `bun run check`:main OK + contracts OK(goal 0.6.0 两行已知漂移白名单,见 DEVIATIONS #2)

### 真机冒烟

`pi -e ./extensions/index.ts --no-session --no-tools -p hi`:core 空壳加载无错、无命令/工具注册、LLM 正常往返(输出中 SoL-Pi 报错为本机另一已装包在 --no-session 下的已知行为,与 core 无关)。

### 剩余风险

1. goal 0.6.0 ↔ 0.85.1 类型漂移两处(goal-auditor.ts:142/206)——P2 fork 入树后修复并撤 scripts/check.mjs 白名单(自动过期机制会强制提醒)。
2. 契约套件 vitest SSR 的 bare-import 解析经 core/node_modules(0.85.1)而非各源包声明版本——与真机 pi 0.85.1 行为一致,反而是更真实的被测环境;但「源包声明版本(0.72/0.74/0.84)下的行为」不在本套件覆盖内(P1/P2 迁移后统一到 0.85,该差异自然消失)。

### 复查结论(2026-09-21,新鲜眼 subagent)

**PASS — 达 commit 门槛。** 全部 19 个 spec ID 逐项核对:18 PASS + P0-SK-04 PARTIAL(发版为流程待办,复核查毕后执行)。要点:

- 三命令实测全绿;四源包 git status clean(effort 包一个 untracked plan.md 为 Sep 19 真机残留,早于实施,与套件无关);空壳实例化复核 0 注册。
- 契约断言与 pm/goal/effort 源码并排对照,确认为钉住现状的真行为断言,无空转/名不副实。
- DEVIATIONS 7 条全部认定为合理工程裁量,无违反 spec 硬要求。
- 修复的复查发现(2 项,均非阻塞):contracts README 补 PLAN §3.2 第 6 条豁免登记;DEVIATIONS #6 表述修正(fake-host 由 contracts project 而非主 project 的 tsc 覆盖)。
- 遗留提示(不阻塞):package.json `files` 的 `types/` 目录为 P1-BUS-02 预布,当前不存在(npm pack 无害)。

---

## Core/UI 解耦批（DC1–DC5b，2026-09-23）

spec rev2（红队处置版）全 Phase 落地，见 `../CORE-UI-DECOUPLE-PLAN.md` §11 偏离记录。十三次 commit（core 9 + cctui 4）：

- **DC1** `03053be` / cctui `818e168`：MODE_META 呈现素材过 bus 快照 + legacy 投影，cctui 删本地表只留 paint。
- **DC2** `6c1bf17`：`effort/ui/`（status 槽/loader/picker）+ UiAdapter interface 冻结（`ui/base.ts`）。
- **DC3** `ede4a07`：`modes/ui/` 四件（meta/footer/plan-widget/confirm + dialog git mv）+ `ui/notify.ts` 尾队列（cap 20、单调 id、无 ACK）+ modes 26 notify。
- **DC4a** `3a1ef29`：goal 36 notify 接队列 + `goal.widget` 快照字段。
- **DC4b** `89c04ed` / `d1d425d`：goal 状态机 5 例行为测试（FakeHost + 磁盘 fixture，经 bus 频道断言——goal.ts 主文件首次有测试）+ widget 投影完备化 + 呈现接线半边物理搬移 `goal/ui.ts`（闭包状态参数化为 6 getter，状态机测试零改动全过=搬移安全网）。
- **DC5** `e3558f6` / cctui `fc8a963`：bus v2 `onChange` DATA field（订阅点即数据）+ publish always-full + `__pmWorkingStats` 写入侧存活键门控（P0-CT-02 negative 在新语义下保持）+ `ui/fallback.ts` 持有 working-message 写权（§4.3 丙案：写入点让路、轮询自愈）+ cctui `readPmStatus` 切快照本体。
- **DC5b** `6db4ae2` + `fde5305` / cctui `1f8a5ee`：fallback adapter 经 onChange 消费尾队列（首个 v2 真实消费者）；cctui 声明 `notificationsConsumer` 能力并自消费（attach 快进 + 帧路径幂等重试）；core 直写收敛为旧 cctui 兜底 leg——新/旧/无 cctui 三组合每条消息恰好显示一次。

### 测试计数（终态）

- vitest **591** + node --test **324**（79+80+165）+ contracts **17**；cctui **72**；tsc 双仓零错；每批 TUI 冒烟通过。
- 新测试面：尾队列合同 6 + fallback adapter 8 + goal 状态机 5 + cctui 消费者 3 + bus v2 契约更新（14）。

### 剩余（版本门控，非实施项）

1. notify 直写 leg 的删除：旧 cctui 装机清零时。
2. `deriveLegacy` 撤除：cctui ≥1.5.0 且装机率到位（contracts/README.md 准则）。
3. 命令区交互类触点（select/editor）按 spec §3 呈现/交互分治有意留在逻辑侧。

---

## memory v2 批（V2-M1/M-C/M-A，2026-09-24）—— 全量替代 pi-hermes-memory

spec `../specs/design/DESIGN-MEMORY-V2.md`，报告 `../MEMORY-V2-REPORT.md`（替代矩阵/冒烟脚本/卸载清单在报告）。四阶段全落地，**未 commit**（等用户真机冒烟）：

- **P1 存储+写入（MV2-S）**：用户层 `~/.pi/agent/memory/`（同款 per-file + 同一 reconciler）；注入=用户索引(≤8K 含 pinned 常驻段)+项目索引吃 25K 车道余量；selection 池合并两层；guard 双目录；modes carve-out 换 `isMemoryWritePath`（DEVIATIONS #67）；`pinned: true` frontmatter 吸收 STANDING 语义（≤5 文件/2KB，超限整丢不截断）。
- **P2 整合（MV2-C）**：`store.ts` ops engine（preflight 全量校验→批原子落盘，单文件 tmp+rename；mkdir 锁 TTL 10min）；`memory_consolidate` 工具（必须收缩不变量，原生渲染，reject 即 throw）；directive+triggerTurn（followUp）；turn_end 自动触发（索引截断 WARNING/条目>200，会话 ≤2 次、10-turn 间隔、tool_result/agent_settled 清 in-flight）；`/memory-consolidate` 兜底命令。
- **P3 自动维护（MV2-A）**：`llm.ts` side-channel `completeSimple()`（auth 轮换重试一次/60s 超时/严格 JSON ops 提取——schema 仅 prose 防思维链复述误解析）；纠正检测（EN 强/弱/负 + CJK 补齐——hermes 仅英文，对本机用户实质改进；1/3 turns 节流）；review（≥10 turns 或 ≥15 tool calls，≥3 user turns 预热，fire-and-forget）；flush（before_compact 60s 跟 signal + shutdown≠reload 10s）；settings 两旋钮（`memory.automation`/`memory.model`）；整合指令 turn 不计入捕获计数；yielded 时全部静默。
- **P4 迁移+收敛（MV2-M）**：§ 切分修复（v1 `/^§ /m` 与真实数据不匹配）+ 全量迁移（USER.md→用户层、全局 MEMORY.md 按 project64 路由、failures.md→feedback 带类别前缀、projects-memory 项目匹配 endsWith 规则、跨源去重、created 保留）；`/memory` 诊断升级（两层占用+automation/consolidation/lastError+hermes 提示）；命令面=2 稳态+2 一次性迁移。

### 测试计数（终态）

- vitest **662**（+72：storage 12 + consolidate 19 + automation 28 + migration 12 + 既有回归）；既有 memory/carveout 用例零改动全绿；tsc 双 project 零错。
- 真实数据实弹：临时 HOME 拷贝跑 `importHermesFull`（Pi-Extension 身份）→ 39 条全量路由正确、幂等、去重生效。

### 剩余（用户门控）

1. 真机冒烟（报告 §7 脚本）→ 卸载 hermes（packages 移除 + 数据目录归档，清单在报告 §7）。
2. commit 拆分建议：P1+P2+P3+P4 各一或两批（`memory v2` 主题）。
3. 冒烟后观察项：side-channel parse_error 率（高则按 spec §10a 降频/改 directive 形态）、CJK 纠正误报率（高则收紧强模式）。

## 架构优化 8-batch（2026-10-02 起，方案 v2 定稿 + 2 轮对抗审查）

> 来源：improve-codebase-architecture 走查（3 并行 reviewer → 9 候选 → HTML 报告）；方案 v1→v2 经 2 轮 glm-5.3-flash 对抗审查定稿（Round1 22 findings 全处置、Round2 verdict 定稿可执行 + 4 条 P2 勘误随批更正）。

- **B1（C1 MCP-shape 谓词下沉）✅ commit 2a8da74**：`lib/mcp-shape.ts` 纯底座（5 分支 + env 解析）；family.ts 组合（authority 不变）；plan gate 消费同一底座 —— 4 个泄漏形态（全单下划线/proxy/direct-named/裸 mcp_*）从放行变拒绝；4 条 shape pin + p4-families 回归绿；AGENTS.md 不变量 4 精确化 + web-gov 注释 + DEVIATIONS #72 + CHANGELOG。三绿。
- **B2（C8 quick wins）✅ commit 88d63b9**：INDEX_MAX_BYTES 派生权威常量（MEMORY_INDEX_MAX）；POLICY_MARKER 常量化（policy↔yield 单侧改名编译期红）；slugify 去重（memdir 唯一实现）；core-economy 收编 readJson（语义保持：missing 静默/malformed+empty+non-object warn、字段归一留 caller、setCoreEconomyPath seam 保留）；ledger.ts header 正名（write-only 审计，非 sentinel 数据源）；FORK.md 白名单补 ui.ts+questionnaire-layout.ts（DC4b）；selection↔session-recall tokenizer 分工互注；contracts README MemoryPatch 附注 P1-BUS-05（零消费方不独立登记）。三绿。
- **B3（C4 goal kind 化 + 死代码）✅ commit 66fa7d9**：GoalStateEntry 加可选 kind（5 产生点标注，version 不 bump）；renderGoalResult kind 优先分派 + legacy prefix 回退（孤儿 prefix 留回放）；删 evaluateDraftingToolGate/ToolGateDecision（no-op + 绿测试假信心）；shouldQueueContinuation 收编为唯一实现；三单例入 factory closure；renderGoalResult 导出 + 3 条渲染 pin。三绿。
- **B4（C6 pi-compat 注入+degrade 收拢）✅ commit 42b5c81**：probePiCompat 未提供探针不再报 problem（obs 纯 version 探测无噪音）；mutationQueue 纯诊断化（FUS-03 死锁实证，移出 problems）；degradeEconomyModule 共享降级尾巴（纯函数收回调）；ActionFusionOptions.version 注入 + assembly economy 块穿线（首个生产性 options）；obs hostExports 同语义；两条自禁用回归 pin（0.85→零注册+真 bus footer）+ pi-compat 3 新用例。三绿。
- **B5（C2 obs 纯投影）✅ commit bf17a70**：projection.ts 纯投影步骤（store/appendLedger 两端口 + outcome 携带 failOpenReasons/sentinelWarning/counters）；handler 退 thin adapter；sentinel/noSession flags 移出 module scope（ProjectionState 单对象，factory 持有）；invariant 9 显式 pin（非候选引用透传 + 替换项仅 content 变）；6 条直驱 node:test（原需 ~286 行 FakeHost）；sentinel 触发路径勘误（ledger 抛，非 store 抛——store 抛时 eligible 不计数）。CON-03/04 零改动全绿。三绿。
- **B6（C7 fusion outcome 结构化）✅ commit a22e471**：executeMutationThenRun 在合并 details 上盖 thenRun:succeeded（既有 details 保留）；两处 substring 嗅探改读字段（THEN_RUN_SUCCEEDED 文本逐字不动，FUS-04）；runFused 单点收拢编排+计数，edit/write 注册块缩至差异项；resolveToolPath+normalizeToolPath 搬 tool-path.ts；fused-count.test.ts 经真注册 write 工具端到端 pin 计数（tmpdir+cat，bus fusedCount 恰好一次）。三绿。
- **B7（C3 goal monolith 拆分）✅ 分步 3 commits，验收缩水已记 DEVIATIONS #73**：step1 continuation loop → goal-continuation.ts（7 直测）；step2 completion-audit flow → goal-audit-flow.ts（auditor 可注入，3 直测）；step3 pendingGoalAchievement → audit 域 slot。statemachine 全程零改动全过。FORK.md P2-GO-06 改写为结构性 fork 自持。状态机核心（persist/setGoal/池/记账）+ confirmation 粘合仍在 goal.ts——thin adapter 终态未达，终审复核。
- **B8（C5 memory RecallSession）✅ commit 8d0e189**：recall-session.ts 吃掉四个闭包绑定（MR-01..09+AD1 全部不变量单点，7 条 vitest 直测）；context handler 退 wiring（MR-03 快照提取+两层扫描+投影）；memory.test.ts FakeHost 回归零改动 36/36；/memory 渲染移 diagnostics.ts（纯函数，预算 cap 引权威）。三绿。
- **C9（fail-open seam）：跳过（2026-10-02 决定）**。理由：(a) B8 抽走 recall 后 memory/index.ts hook body 只剩 wiring 胶水，各 catch 降级值语义各异（undefined / {systemPrompt} / {messages}），adapter 参数化不减少理解面；(b) invariant 8「注入永不阻塞 turn」已由 memory.test.ts FakeHost fail-open 用例端到端钉住；(c) R1 审查判定 deletion test 弱（Speculative）。
