# DEVIATIONS — 与 spec 的偏差记录

> 每条偏差:内容 / 理由 / 影响面。小决策按 spec 精神自行裁定;本文件是唯一台账。

1. **契约套件独立 vitest config(而非同一 include)**
   Spec P0-CT-11 只要求「`bun run contracts` 一键跑」。实现用 `vitest.contracts.config.ts` 独立入口,主 `bun run test`(vitest.config.ts)不含契约——vitest 的位置参数过滤仍受 include 限制,且两套件独立运行本来就是 spec 意图(「同一套件,P1 起换被测对象」)。断言文件不变,无契约影响。

2. **goal 0.6.0 源码对 0.85.1 的两处类型漂移(白名单而非修复)**
   `goal-auditor.ts:142`(ResourceLoader 缺 `getSystemPromptSource`/`getAppendSystemPromptSources`)与 `:206`(`CreateAgentSessionOptions.modelRegistry` 不存在)是 goal 0.6.0 按 pi 0.74 类型编写、与 0.85.1 的真实漂移。P0 禁改源包,`@ts-expect-error` 无法抑制其他文件内部的错误,故 `scripts/check.mjs` 维护**精确两行**的自动过期白名单(漂移修复后 check 反而失败并提示移除)。运行时全绿(契约套件真实例化 goal 工厂)。P2 fork 入树后修复并撤白名单。

3. **P0-CT-09 两处用源码行钉住而非行为断言**
   - pm `permission-modes.json` 默认路径:config.ts 的默认值是模块级 `let` 初始化,setter 无恢复语义,无法在测试进程内取回未污染默认值 → 钉源码行 `join(homedir(), ".pi", "agent", "permission-modes.json")`(任何路径改动必改此行)。
   - review `runs/` 目录:构造式在 `prepareRun` 内部且未导出 → 同法钉 `join(cwd, ".pi", "pi-review", "runs", runId)` 源码行。
   其余 CT-09 项全部为行为断言(实际落盘后断言路径)。

4. **P0-CT-08 的 goal/review entry 行使范围**
   spec 验收允许 CT-08「绿或带去向标注」。实现:四包实例化 + session_start + pm shift+tab 切换路径真实产出 `modes` entry(非空转断言);goal/review 的 entry 类型由其命令族触发,属 P2 迁移套件的红绿范围,此处钉「实例化 + session_start 不产生白名单外类型」。已在测试注释与 PROGRESS 标注,非静默缩窄。

5. **`bun run check` 由 tsc 直跑改为 scripts/check.mjs 双 project 门**
   原因见 #2(跨包类型检查需要独立 project + 白名单)。主 project(exclude test/contracts)零错才过;契约 project 除两行白名单外零错才过。语义上仍是「tsc 零错」,且比单 tsc 更严(以前 contracts 根本不在检查内)。

6. **fake-host 的 ExtensionAPI 类型策略**
   P0-CT-12 说「参照 panel 0.4.x 的 fake host 先例」。实现参照 pm index.test.ts 的 createFakePi(plan2 C1 模式,pm 自己的先例),以运行时鸭子对象 + `asPi()` 跨版本断言(四包 ExtensionAPI 类型来自不同版本,不可能同时静态满足);fake-host 的类型由契约 project(tsconfig.contracts.json,compilerOptions 与主 project 相同)的 tsc 检查覆盖。

7. **writeForwardedRequest 断言落盘而非函数输出**
   P0-CT-05 spec 说「仅断言路径构造函数输出」;`forwardingSessionDir` 未导出,改断言导出的 `writeForwardedRequest` 实际落盘树(`sessions/permission-modes-forwarding/sessions/<id>/{requests,responses}`)——更强的行为断言,同一契约。

---

## P1 偏差(2026-09-21)

8. **effort 随迁测试计数 72 ≠ spec 的 74**
   源包同跑法(`tsx --test tests/*.test.ts`)基线实测 72(spec 的 74 为估算误差)。随迁 72=72 等价。

9. **effort integration 测试对 0.85 的 setup 适配(断言零改动)**
   ① import 命名空间 `@mariozechner→@earendil-works`(P1-EF-01 本职);② `AuthStorage` 与 loader 辅助函数 0.85 起不在包根导出,改 deep path import;③ `AuthStorage.set(provider, cred)` 改 `modify(provider, fn)`(roundtrip 实测等价);④ `ModelRegistry.create(authStorage, modelsPath)` 与 `createAgentSession` 的 `authStorage/modelRegistry` options 已被 0.85 的默认 `modelRuntime`(读 agentDir/auth.json+models.json,同路径)取代,删除显式构造;⑤ effort.test.ts 的 ThinkingLevel 漂移守卫补已知上游别名 "max"。

10. **lib/settings 接口微扩:onInvalid 回调 + write opts.mode**
    `readJson(path, fallback)` 增第三参 `onInvalid?(reason)`——pm 441 测试钉住了 malformed 配置的 console.warn(profiles.test "returns {} and warns"),需要区分 missing/empty(静默)与 malformed/non-object(warn);`writeJsonAtomic(path, value)` 增 `opts?: {mode?}`——profiles 写 model-profiles.json 带 `0o600`(安全行为,不可丢)。两参签名语义不变。

11. **lib/overlay 增 showComponentOverlay(组件注入);effort picker 组件保持原实现**
    P1-EF-02「picker 改用 lib/overlay.ts」按字面替换组件会杀死 effort-picker.test.ts 的 23 条断言(盒线渲染/9 行布局/居中标题被钉死),违反零断言改动。实现:picker **组件**原样保留,`ctx.ui.custom` + overlayOptions + 几何参数的**底座管线**收敛为 lib/overlay 的 `showComponentOverlay`(pm plan-approval-dialog 同样需要组件注入,items 型 showOverlay 无法服务)。等价性说明:custom 调用参数与几何逐项相同;非 TUI 的 select 降级仍在 effort 调用方(原样)。

12. **bus planPhase 联合补 "refining"**
    P1-BUS-01 的 planPhase 三值联合漏了 pm 现状的 `"refining"`(PlanPhase 实为四值)。按红队「以现状钉住」原则补全(types 与 bus 同步)。

13. **types subpath 文件布局细化:.mjs/.d.mts 分名**
    spike 定稿的 `.js + .d.ts` 在本仓 vitest/vite 下被 TS-importer 重映射抓到 `.d.ts` 当源码解析(实证)。布局改为:runtime `types/core-status.mjs`(无同名声明,vite/tsc 直取)、声明 `types/index.d.mts`(exports "types" 指向;bus.ts 等 type-only import)。消费端经 exports map `./types` 的语义与 spike 验证一致(types→index.d.mts,import→core-status.mjs;jiti/node/tsc 三通路不变)。

14. **EffortOwner 接口微扩(spec 签名全部保留)**
    增 `envPin()`(返回①值或 null;P1-EF-06 c 的「被 env 钉死」提示需命令侧感知而 spec 的 setExplicit 为 void)、`currentSource()`(bus effort.source 四值需要)、`setExplicit` 返回 `"applied"|"pinned-by-env"`(同一语义的机器可读形式)。OwnerEffortLevel = pi ThinkingLevel 联合(含 "off")——alt+t 必须能表达 "off",spec 文字中的 EffortLevel 按 effort 包 ALL_LEVELS(含 off)理解。

15. **--effort flag 与 alt+t 归入②;/effort reset 新子命令**
    flag=启动期手动意图(src "command");alt+t=src "shortcut"(红队 #1)。`/effort reset` 为 P1-EF-06 b) 要求的行为,parseEffortCommand/handler 增 `{kind:"reset"}`(USAGE 字符串不动——30 条 effort 单测钉住其文案;reset 不在 USAGE 列举中与 min/max 同为语义别名,可接受)。

16. **modes publishCapability 委托 bus(P1-PM-04 白名单之外的接线)**
    P1-BUS-03「publishCore 唯一发布口」的必然落点:modes 的 publishCapability 函数体改调 coreBus().publish,4 个调用点零改动;`__pmWorkingStats` 的 legacy 派生移入 bus(仅在 snapshot.modes.workingStats 非空时写,负例行为与 CT-02 钉住一致)。功能语义零变化。

17. **契约 targets 切 core + bus 测试重置钩子**
    targets.modes/effort 切 core 模块(P1-PM-03/04 验收),redirect setter 同步改用 core 模块实例(必须与被测对象同模块,否则重定向无效)。bus 增 `resetCoreBusForTests()`(生产不调用;否则共享单例的 snapshot 跨契约用例泄漏,CT-02 负例把上用例 stats 带回)。

18. **Cmd 内建 kind 暂不注册**
    P1-BUS-01 形状列出 setMode/setEffort;v1 仅交付 registry 机制 + unknown 契约(P1-BUS-08),不注册真实处理器(modes setMode 需交互 ctx;owner setEffort 可 P2/P4 随 /core 面板接)。无契约要求内建 kind 可用。

19. **permissions-loader 迁 lib/settings 时的 malformed 语义修复(P1 复查发现)**
    初版迁移丢了原版两处行为:`readJsonFile` 对损坏文件的 console.warn;`writePermissionsToFile` 对损坏的既有文件「warn + 不写」(初版静默以 {} 覆写=自愈)。复查指出后已恢复两者(readJson onInvalid 检测 + corrupted 短路),行为与 pm 2.8.0 等价。教训:settings 迁移的等价性不只 happy path,malformed 分支也在 441 测试的既有语义内。


---

## P2 偏差(2026-09-21)

20. **goal 随迁测试计数 75(spec 记 103;源包基线 66+3 文件加载失败)**
    源包未安装 node_modules,三个 UI 测试文件(goal-auditor/questionnaire/widget,各 4 test)在源包目录直接 ERR_MODULE_NOT_FOUND;core 内 0.85 依赖齐全后 75/75 全绿(66+9=75,多出的即那 3 个文件的测试)。spec 的 103 为估算误差。随迁断言零改动:14 个测试文件对照**本地 ec2bcbe 检出**(非 npm tarball——其 package.json files 不含 tests/,REVIEW-2026-09-22 #8 指正)仅 import 路径扁平化(#25)。
    *(2026-09-22 修复批注:#8 引证失实已修正;#9 FORK.md 命令族枚举补全;#10 goal bus 发布移出 hasUI 门控与 review 通道对称。)*

21. **goal-auditor 两处 0.85 类型漂移入树修复**
    P0 期只读源包靠 check.mjs 白名单豁免(goal-auditor.ts:142/206);P2 fork 入树后同文件进 tsc 主门,必须修复:ResourceLoader 补 0.85 新成员(返回 undefined/[]);createAgentSession 删 modelRegistry 选项(0.85 默认 modelRuntime 读同一 agentDir,auditor model 已显式解析)。白名单按自动过期机制撤除。详见 FORK.md。

22. **review 降级 gate 范围:仅 /review**
    spec P2-REV-03 说「/review 族命令返回明确错误文案」。裁量:/review-config(编辑 json)、/review-agents(列 .md frontmatter)、/review-show(重渲染最近报告)不依赖 subagent 工具,保持可用更符合「其余 core 功能不受影响」的精神;唯一 spawn reviewer 的 /review 被 gate。降级提示:一次性 install-hint warning + 每次明确的「review skipped」error。

23. **P2-BUS-02 覆盖范围**
    goal 通道经真实恢复路径(磁盘 goal 文件 + session entries)+ /goal-pause 命令翻转;review 通道 done 经 pi_review_report 工具真实路径。running 发布点在 /review 命令 handler 内(prepareRun 后),单测不驱动(需 git/PR 环境),由 P2-REL-02 真机冒烟覆盖。已在 PROGRESS 剩余风险记录。

24. **0.1.7 议题消解(handoff 笔误)**
    npm 实测 @capyup/pi-goal 无 0.1.7(版本线 0.1.0-0.1.2→…→0.5.0→0.6.0 最新);npm 0.6.0 tarball 与 fork 基线 ec2bcbe 内容一致(白名单三文件除外,逐文件 diff 实测)。spec §8「0.1.7↔0.6.0 diff 盘点」无对象,OPEN-QUESTIONS #3 关闭。

25. **goal tests import 扁平化**
    源包布局 tests/ 与 extensions/ 平级(import ../extensions/x.ts);core 布局 tests 在 extensions/goal/ 内,统一改为 ../x.ts(P2-GO-03a import 包内化;断言零改动)。

26b. **review 随迁计数 165 vs spec 161(P2 复查补记)**
    源包基线同跑法实测 165=165(与 effort/goal 同类的 spec 估算误差),随迁断言零改动(diff -rq tests/agents/reference 零差异)。补记以对齐 #8/#20 先例。

26. **降级提示计数语义**
    session_start 的 headless 探测只 console.log(不置一次性 flag),首个用户可见提示(命令路径)才消耗 degradedNoticeShown——否则 headless 启动会吞掉 UI 会话的一次性 warning。


---

## P3 偏差(2026-09-21)

27. **lexical 阈值标定(首查②,真实存量回放)**
    用本机 CherryDev CC 存量(81 文件)回放:MIN_TOKEN_OVERLAP=2 时目标命中精准(builtin-provider prompt → add-builtin-provider-recipe),无关 prompt 零注入,但一个 symlink prompt 召回 3 个弱相关文件(被 maxFiles=5 钳制)。首日取 2(召回优先);推翻条件(DRIVING-MEMORY (a) 误报高烧预算)触发时升 3。标定脚本为一次性,未入仓。

28. **P3-RU-13 ② parallel steer 未真机冒烟**
    steer 送达语义按 pi 0.85 docs(「本 turn 工具执行完、下次 LLM 调用前送达」)实现;parallel tool mode 下的实际批次需要带 LLM 的多工具并行会话,本会话无此预算。归 P3-REL-01 真机冒烟清单。①input.path 已实测确认(read.js schema + pm 2.x 同款用法)。

29. **rules/paths.ts 未实现 session 历史挖掘**
    P3-RU-11 布局注释提到 paths.ts 含「session 历史挖掘」,但行为规范(P3-RU-01..10)无对应条目——按「spec 不给 ID 即不做」省略。paths.ts 仅实现 tool_call 目标路径提取。

30. **modes carve-out 插入两处(ask-ladder + 漏斗)**
    P3-PM-01 预想单点插入;实测 ask 模式 edit/write 有内联 select 弹窗(index.ts:1919 不经 promptWithPermissionOptions),故 ask-ladder 分支为主插入点,promptWithPermissionOptions 开头为防御性第二点(覆盖 plan-execute/forwarding 等其它弹窗路径)。行为等价、覆盖更全。

31. **memory 模块 cwd 口径统一为 ctx.cwd**
    实现中 memoryDir(ctx) 以事件 ctx.cwd 为锚(process.cwd() 仅兜底)——与 modes carve-out 同口径,避免双口径漂移(carve-out 测试曾因此红)。context 事件经 ExtensionHandler 两参签名拿 ctx(0.85 types:902 确认)。

32b. **P3 复查补记的未申报偏差(已裁定合理,补台账)**
    ①globs 匹配为手写 globToRegExp 而非 picomatch(零依赖;`*`/`**`/`?`/`{a,b}` 实测正确,字符类/extglob 不支持——规则文件作者用基础 glob 即可,记录于 render.ts 注释);②>4KB 记忆文件 selectForTurn **整体跳过**而非 spec 测试计划的「截断标记」(静默截断记忆内容有误用风险,跳过+按需 Read 更安全);③hermes 导入未保留 created/last 元数据(§ store 无此字段,启发式转换从简);④fake-host isProjectTrusted false→true(rules wiring 需要 trust 门控放行,契约断言不受影响);⑤wiring 头注释指向不存在的 rules-command.test.ts(已修正)。

31b. **ctx.cwd 口径统一的两处残留(P3 复查发现,已修)**
    session_start 的可写性探针 statSync(memoryDir()) 未传 ctx、session_recall 工具用 process.cwd()——均已改为 ctx.cwd 优先。另:contextBudget/memory 两条新 bus 通道此前零断言,已补(rules-wiring + memory.test);动态 yield 翻转后快照不更新已修(probePrompt 翻转时补 publish);>4K globs 规则首触永不 steer 且被永久标记的缺陷已修(steer 正文改从 collectRules 原文取,不再依赖 render 内联输出);extraDirs 因 find 单目录静默失效已修(collectRules filter 循环);P3-RU-04「绝不截内容中部」红线(收尾 slice + 尾注超预算)已修(降级循环核算全部字节,含尾注预留);lastInjectedFiles 只写不读已删(去重由「同 turn 文件唯一 + 60KB 累计」承载);rules 渲染测试容忍 +64 收紧为精确 ≤budget。

32. **yield 静态探测的 agentDir 随 HOME 现解析**
    gate 构造读 process.env.HOME 而非 homedir() 快照——生产等价,测试可注入;DEVIATIONS #26 同族(测试可注入性优先)。


---

## P4 偏差(2026-09-21)

33. **direct 命名形态需 knownServers 白名单(P4-MC-01 收紧)**
    spec 风险②已预警:direct 形态(exa_search)若按纯命名启发式认领,任意 foo_bar 扩展工具会被误 claim(实测:未配白名单时 some_custom_tool 在 ask 模式被弹窗,违反 P4-FAM-02④ 不变面)。修:direct 仅当首段 server id 在 createMcpRuleFamily({knownServers}) 列表内才认领;native mcp__ 前缀与 proxy 形态不受影响。README 的 exa 引导注明。

34. **web family 规则优先于预批准清单**
    P4-WB-02 未定义显式规则与 builtin 预批准的冲突序;实现取「显式规则 > 预批准」(deny github.com 必须成立)。

35. **broker 镜子的 allow 判定引用 rules 快照**
    mirror 的 hasAllowRule 在 session_start 时以 loadMergedPermissionRules(ctx.cwd) 构建闭包(与 gate 同源);rules 运行中变更的镜像刷新归 /core 面板展示兜底(v1 不做每事件重载——mirror 只在 adapter 在场时活跃,本机 absent)。

36. **/permissions 的 grants 管理形态**
    spec「/permissions 面板可见可清」实现为:列表段 + 独立 /permissions-clear-grants 命令(非交互式清除)。v1 简单可审计,交互化留 /core 面板迭代。


---

## P4 复查补记(2026-09-21)

37. **P4 复查发现并已修**(阻塞 B1 + 顺手项):①resolve 序 deny>allow>ask 违背 spec「deny>ask>allow」(用户显式 ask 被 allow 前缀吞)——mcp/web 两处改序并补断言;②mirror 的 bypassActive 生产装配硬编码 false(红队 #3 的 bypass 支重演)——modes setMode/session_start 经 setBypassIndicator 同步,mirror 读 isBypassActive;③session_shutdown 不清 grants/spec 明文要求——clearSessionState 双钩子;④WB-01 域名规则应「先于 mcp 前缀规则」——装配序改为 web 先注册(URL 工具 host 特化优先,非 URL mcp 工具回落 mcp family);⑤ruleMentions 不识别尾通配 ask 规则——改前缀匹配;⑥P4-MC-04 矩阵测试头注释失真——诚实化并补 uiPrompts≤1 断言到端到端用例;⑦plan/auto 首调弹窗(红队 #2 增补态)补端到端;⑧PROBE11 残留删除。

38. **v1 未实现/不可达项(挂账)**:①P4-MC-05 的 busVersion floor 撤 claim 与「缺字段按 cached」未实现(adapter absent 下无消费方,重开条件=adapter 真机接入);②P4-MC-06 的静态 inventory 只扫 mcp.json(settings packages 扫描与 mcp.json 配置链未做)、green 判定无 cached 表达;③P4-FAM-05「headless/转发审批计入」结构性不可达——headless 走 fail-closed、subagent 转发路径在 promptWithPermissionOptions(不受 family first-seen 走),family 工具的转发 allow 在现架构无入口;重开条件=first-seen 弹窗接入转发机制。


---

## REVIEW-2026-09-22 修复批注(2026-09-22)

39. **#11 放行链缺口修复**:一次性 Allow 的记录点收敛到 `applyApprovalDecision`(交互 select、headless 转发 resp "allow"、promptWithPermissionOptions 三路必经);`allow_always_*` 落盘后记 rule-allow。#38③ 的「转发 allow 无入口」表述作废——显式 ask 规则的 promptWithPermissionOptions 即入口;一致性矩阵缺口闭合,新增 review #11 端到端用例(gate 放行 → adjudication 在 → mirror allow_once)。
40. **#13/#14 预算核算与降级次序**:降级循环计入段头(`## Rule details`)+ 连接符 + 条件内联块的 connector 位,预算为精确断言(≤budget);降级次序改为「条件 fold-in 先降 → 最大 always 次之 → 索引行尾部整行丢」,对齐 spec「条件规则先降为索引行」。
41. **#15 steer 钳制落地**:首触 steer 正文超 `DYNAMIC_STEER_MAX`(8K)时改发「按需 Read」指针行,不截全文(渲染红线对 steer 同样成立)。
42. **#16 便宜性修正**:指纹升级为文件级(mtimeMs+size,内容编辑可见;成本改为每 dir 一次 readdir + N 次 stat——spec「每 dir 一次 stat」表述在内容可见性需求下不可两全,取正确性,本条即偏差申报);tool_call 复用指纹缓存(collectRules 结果随指纹缓存,匹配工具调用零额外扫描);activatedNames 不再随指纹清空(每 session 一次语义保住)。
43. **#17 可写探测**:statSync 存在性 → `accessSync(dir, W_OK)`;不可写时真降级为 policy-only(不注索引),通知与行为一致;chmod 测试可行(本机非 root),已补。
44. **#18 reconciler 短路前置**:热路径(mtime 未变且上次无 skip)零文件内容读,entries 走缓存。
45. **共享实现进 lib(Standards #4/#6)**:新增 `lib/rule-text.ts`(ruleValueText / ruleMatchesId / isInsideDir),替换 4 份 ruleValue 提取、2 份尾通配匹配、guard 的裸 startsWith;25K 常量统一 import `MEMORY_INDEX_MAX`。**修实一个真 bug**:ruleValue 为 parser 对象时旧提取 `String(.value)` 失明(持久规则对 first-seen 判定/ruleMentions 不可见)。
46. **注释/死代码批清(Standards #1/#2/#3/#8/#9 + Spec #20)**:resolve 序 stale 注释 ×4、check.mjs 成功消息、types 注释指向旧文件名、memory/index 死常量与 paths 绑定、memdir 无变异重算、importers 无效三元、paths.ts 恒等替换、render/rules-paths 投机参数与 `@/abs` 双斜杠、session_recall 空文案 cwd 口径、overlay 死 disable 指令、effort-owner d) 用例实化、planPhase 生产者补齐、fresh-clone 守护。**(复查二轮修正:本条初版虚报两项——web-gov 注册序注释与 memory `void ctx` ×2 当时未实际修改,复查抓出后已补修;check.mjs 不可达分支保留,成功路径恢复输出。)**
47b. **修复批复查二轮(2026-09-22):四处自报失实修正**
    复查 subagent 亲证以下四项初版自报「已修」实际不存在(python 批量替换静默失败的再现,同 P4 running 事件):①#10 goal bus 移出 hasUI 门控(goal.ts 零改动);②contextBudget/memory 通道断言(文件中无);③web-gov 注册序注释;④memory `void ctx` ×2。**全部已补修**(publishGoalChannel 移至 hasUI early-return 之前,两通道对称;两条 readCoreStatus 断言入 rules-wiring/memory 测试;注释反转;void ctx 删除/参数收敛)。同批顺手:#13 块间连接符欠账补入核算((N−1)+(R−1) 个 `\n`);#16a 激活检测热路径改 cachedRules 内存 glob 匹配(真零扫描,冷路径保留全量回退);mirror allow_always 写失败改 fail-closed(与 firstSeen 一致);check.mjs 成功路径恢复输出;memory temp-write fallback 幽灵注释与 rules 头注释过时表述修正。**教训重申:python replace 静默失败是本仓事故主源——凡是「已修」自报必须以复查或实测背书。**

47. **择优认定(不修,挂账)**:①#5 writeJsonAtomic 使 model-profiles.json 每次写入均 0600(pm 仅创建时)——安全正向,保留;②#4 config.ts malformed 首读后 mtime 缓存内不再 re-warn——诊断降级可接受;③Standards #8 的 `as never`(context 注入对象 vs AgentMessage)——类型面成本高于收益,留;④#12 direct 形态生产装配 knownServers 恒空——配置 seam(`PI_CORE_MCP_DIRECT_SERVERS` env)已在 mcp-gov/index 接入,README 注明。

---

## 二轮深审修复批(2026-09-22,REVIEW-II)

> 来源:code-review skill 双轴全量深审(Spec 4 应修 + Standards 11 应修 + 实质性建议项)。台账自本批起 #48 连号;两项历史自报失实随批闭案(#47b② memory 通道断言本轮 S4 补真;#46 paths 恒等替换已删)。

48. **S1 effort 兜底翻转(pm 等价性主动让位 §3.3)**:`resolveEffortForMode` 无显式 effort(ModeConfig.effort 或 `:suffix`)时返回 `undefined`(原兜底 `"medium"`,DEFAULT_PROFILE_EFFORT 删除);modes 消费点 `if (!effort) return` 从死代码变为真守卫——profile 无 :effort 切 mode 完全不动 thinking level。两个 pm 随迁用例红绿翻转(index.test「defaults to medium」→「leaves alone」,断言 off)。P1-EF-06 d) 的 modes 侧守卫自此真实存在。
49. **readJson onInvalid 语义收紧**:onInvalid 回调 throw 现在原样传播(一次、真实 reason),不再被外层 catch 吞成二次 "malformed" 上报;文件头与函数 doc 更新。effort 的 `readSettingsObject` 改用 throwing-onInvalid 复现「corrupted settings.json 不可被 writeFastMode 静默覆写」守卫(与 pm permissions-loader #19 同型)。
50. **settings/model-id 收敛补完(P0-LB-01/04「P2 收尾全收敛」兑现)**:effort.ts 的 readSettingsObject/writeSettingsObject 与 permission-forwarding 的 atomicWriteJson 迁 lib/settings(0o600 经 opts.mode;forwarding 的 readJsonFile 保留——「任意类型 parse-or-null」控制流语义,非 settings 原语重复);profiles.ts 自有 parseModelId 改为 lib/model-id 薄适配(字段名映射,签名/测试不变)。**PLAN §1.4「×2 份 provider/model 解析」表述失实记录**:review 的 resolveModel 实为 "inherit" 哨兵解析,从来不是第二份 parser;真收敛对象只有 profiles 这份。
51. **C1 CJK bigram 分词(新能力)**:tokenize 对 CJK 连续段切 bigram(ASCII 词不变)——此前整句中文并入单 token,换措辞即失配,中文 lexical 注入实际不可用(二轮深审最重发现);中文单字停用词删除(bigram 下单字 token 不再产生)。MIN_TOKEN_OVERLAP=2 对 bigram 语义不变;#27 的英文标定结论不受影响(英文路径零改动)。
52. **C7 字节口径统一**:selection(selectForTurn 预算对比/会话累计)、policy(indexEntrypoint 封顶)、memory/index(60KB 计入标题+新鲜度头+整块,`slice(0,4096)` 死代码删除)全部 Buffer.byteLength——CJK 体量原低估至 1/3。
53. **A4 memdir 缓存键控+失效**:reconcile 缓存从模块级单例改为 per-memoryDir Map,键含文件名清单(namesKey)——删除/改名(不 bump 任何 mtime)也失效,索引死行不再永久滞留;同进程多项目互不污染。
54. **A5 注入热路径**:新增 `scanMemoryDirCached`(name:mtimeMs:size 指纹缓存,含 body);before_agent_start 与 context 两个 hook 共用——原每 turn 3 遍全文读(两处 scanMemoryDir + context 逐文件 readFileSync)降为指纹未变时 1 次 readdir+N stat、零内容读;`gitCanonicalRoot` 按 cwd 进程内 memo(原每次 memoryDir() 都 execSync git)。git root 变更需重启进程才可见(可接受,worktree 场景 root 不变)。
55. **S3 web family 认领限定 mcp 形态**:match() 先过 `canonicalizeMcpTool`(native/proxy/direct+knownServers)门再做 URL 提取;knownServers 解析抽为 `directKnownServersFromEnv()`(mcp/web 两 family 同口径);proxy 形态的 effectiveName(input.tool)同样过 URL_TOOL_HINT。非 mcp 工具带 url 参数恢复 passthrough(P4-FAM-02④)。p4 用例翻转(webfetch 字面名不再被认领)。
56. **S5 特异度分层(P4-MC-01 前缀优先级)**:resolveMcpVerdict 改为「精确名 > `mcp_<server>_*` > `mcp_*`」三层特异度优先,同层内 deny>ask>allow——`deny mcp_*` + `allow mcp_exa_search` 现判 allow(原被宽泛 deny 吞)。
57. **S6+C5 family 规则形态内化**:RuleFamily 接口新增 `matchesRule(rule, canonicalId)`(mcp=ruleMatchesId;web=webfetch(domain:) 形态);`ruleMentions` 升级为 `familyRuleMentions`(带 family)。效果:web 显式 ask 规则可被识别→走 promptWithPermissionOptions 全弹窗(allow_always_local 可达,S6);family deny verdict 展示真实 deny 规则文本+真实 source(原为 allow 建议串+硬编码 "global",C5)。
58. **C3/C4/A3 broker 三连**:canonicalIdForEvent 复用 canonicalizeMcpTool(adapter 事件带 native `mcp__` 前缀不再拼出 `mcp_mcp__exa__search` 导致 adjudication 全 miss 误拒);mirror `start()` 防重入(先退订再订阅)+mcp-gov wiring 在 session_start 先 `mirror.stop()` 再重建、session_shutdown 补清理(订阅泄漏/双重 deny 计数);/core 面板 ruleSummary 换 ruleValueText(对象型 ruleValue 不再显示空串,#45 漏点再现的堵口)。
59. **memory 其余修复包**:C2 secret regex 修正(收尾引号可选+值类含 `=`,base64 padding/无引号 token 不再漏拦);C8 readLines UTF-8 chunk 边界 withhold(多字节字符不再产生替换符;position 只推进已解码字节,截断尾防死循环);C10 context 注入自选文本不再可能成为下一轮 recall prompt(过滤 customType user 块);C11 双导入器「本地编辑优先」(内容分歧 skip+note,不再静默覆写);C9 extractHost 移除 query 键(搜索词不是 fetch 目标)+预批准子域名匹配(`host === d || host.endsWith("." + d)`,非前缀伪造);S11 defaults search-channel description 与定版 content 同步。
60. **effort/rules 小项包**:S7 `--effort` flag env pin 下补 notify(返回值检查,与命令/picker 路径对齐);A7 ALL_LEVELS 加 `"max"`(pi-ai 原生 max 档此前被 isEffortLevel 过滤掉,模型最高档不可用);C6 syncEffortUi 的 appliesNow 默认改 `ctx.isIdle()` 口径(changed 回调不再以「立即生效」刷 working message 与 "(applies next prompt)" 自相矛盾);C13b /effort reset 通知不再谎报 currentSource(「control returns to profile/model default; currently X」);A8 steer 发送提取 `steerRule()` helper(两段逐字重复消除);A9 renderFor 死参数删除+globalHome 默认 `process.env.HOME ?? ""`(漏调 setRulesHome 时 @~/ 不再解析到空);C13a render 降级循环加「降级后更大则不降」守卫(小块不净增体量,极端情形走索引尾丢);review-run `void writeFileSync` 死代码与 import 清理;memory/paths sanitizePath 恒等替换删除(#46 闭案)。
61. **择优认定(不修,挂账)**:①A6 rule-families.ts 四职责(family registry/bypass 指示/sessionGrants/adjudication)拆分——结构重构风险大于收益,重开条件=P5 或下次 family 接入需求;②C12 yield 动态探测标记押注 pi systemPrompt 非累积语义——真机验证后定;③review-run 空 diff 守卫晚于 prepareWorkspace(白付一次 clone,TTL 兜底);④C6 的「run 中 changed 回调」无独立单测(fake host 的 isIdle 序列成本高),由 53 条 effort node--test 与真机冒烟覆盖。

## 对抗审计批(2026-09-22 二轮,红队 3 subagent)

62. **对抗审计修复(4 实锤 + 2 顺手)**:真实性轴全绿(#48-#61 逐条属实、15 测试无空转、计数吻合——未发生第三次自报失实);回归轴抓出 4 项修复残留并全部修毕:
①**C8b**:utf8SafeEnd 回扫上限 3→4——4 字节 emoji 序列恰在 chunk 尾时 lead byte 被孤立解码(红队实测产生替换符),修复后增补平面字符边界完整(emoji 边界用例);
②**C11b**:importFromHermes 存在性检查从 scanMemoryDir().entries(仅 valid)改为 existsSync——frontmatter 损坏的本地文件此前仍被静默覆写(invalid 用例);
③**C13ab**:降级循环 break 出口改为「整块丢弃最小 inline 块」——全部块小于索引行且无索引行时原样输出超预算,违反 #40「精确 ≤budget」不变量(30×40 字符 + budget 300 用例);
④**C1b**:中文高频虚词 bigram(我们/一个/这个…20 条)入 STOPWORDS 且 bigram 分支补停用词过滤(原只在 ASCII 分支过滤)——红队实测「我们需要整理一个计划」凭两个虚词 bigram 误命中无关记忆;信息密度低于英文词的固有松散由 #27 升 3 通道继续跟踪。
顺手:broker probe 前 stop 旧 mirror(throw 时不再遗留订阅);globalHome 惰性初始化(静态初始化会在测试 HOME 覆盖前捕获)。
**挂账(红队疑点,择优认定)**:broker direct 双拼 `mcp_exa_exa_search`(fail-closed 方向安全,adapter 真机接入时观测);Tab 补全 max 在模型原生含 max 时重复展示;effort 三处裸调 ctx.isIdle 与 syncEffortUi 防御风格不一(真实运行时 isIdle 恒在,extensions/types.d.ts:232);ALL_LEVELS_WITHOUT_XHIGH 无消费者(dead export);C2 人类句子误拦(`password: "my-password-is-long-enough"`)——over-blocking 声明内。测试 vitest **574**(+4)+ node--test 312 + 契约 17 全绿。

## memory v2 批（DESIGN-MEMORY-V2，2026-09-24）

67. **modes carve-out 判定外移（V2 唯一跨模块改动）**：任务约束「不动 core 其它模块」，但 D1 用户层（~/.pi/agent/memory/）的模型写入若不进 P3-PM-01 豁免，ask 模式下每次写用户记忆都弹审批，「自动化优先」不成立。改法：`memory/paths.ts` 导出 `isMemoryWritePath(path, cwd)`（两层根目录单一真相，guard 与 modes 共用防漂移），modes/index.ts 判定行换调它（净 -1 行，依赖方向 modes→memory 原本已存在）。豁免行为由新增用例钉住（memory-v2-storage.test.ts「modes carve-out skips the approval dialog for USER-layer writes」）。
68. **hermes 子进程 fallback 链不迁移（择优认定）**：hermes 的 direct→`pi -p` 子进程兜底（超时预算共享/交接/心跳/锁协调全套）整体不迁移，direct 失败=静默跳过记 `/memory` 诊断，下个钩子自然重试。理由：捕获类钩子（review/correction/flush）天然有下一次机会，fallback 链是 hermes 复杂度大头；重开条件=真机 parse_error 率实测偏高（spec §10a）。

69. **goal token 记账改四通道求和（cache-inclusive，用户指令 2026-10-01）**：`assistantTurnTokens()` 由 `input+output` 改为 `input+output+cacheRead+cacheWrite`（turn_end 与 agent_end abort 两条路径共用该函数，一处改全生效）。理由：pi `Usage` 四字段中上游 fork 只记前两个；prompt caching 下非缓存 input 只占真实处理量的零头，旧口径把 tokensUsed 低报约一个量级（实测样例：goal 全程账面 235K，cache 命中后 provider 口径为 M 量级）。影响面：bus goal 通道/`tokensUsed` 字段/compact 摘要渲染形状零变化，仅数值变大；历史 goal 记录不受影响（只增量、不回填）。已登记 FORK.md 白名单表 goal.ts 行。

70. **memory 召回机制修订（spec 2026-10-01-memory-recall-fix v3.1，MR-01..09）**：P3-ME-04 的「去重」由 messages 反查（`surfacedRecallKeys`，经宿主源码取证证实从未生效——投影 request-ephemeral 不回流）改为 **per-turn pin & re-project**：turn 首个 context 事件选取并 pin（query = 最后一条非 customType user 消息），turn 内所有请求重投影字节级同一块；`surfacedKeys` 收窄为纯计费判重（每文件每 session 扣一次，经 `selectForTurn` 新增 `isPrePaid` 谓词不再消耗剩余预算），投影永不抑制。匹配域改双域制：primary（title+description ≥2）或次级（≥1 且 body ≥2，v3.1 校准：≥4 对 3-bigram query 数学不可达）入选，body 仅同分 tiebreaker——body-only 命中永不入选。v1 的 session 级去重方案经对抗审查（F1）否决：会把 memory 修成「每 session 只在一个请求可见」。用例翻转：memory-v2-storage「AD1: never re-injected」改写为 v2 语义（prior block 不抑制重注入、不成为 query）；顺手修预存测试隔离 bug（mode-inherit.test「ignores invalid modes」未清环境变量——在 pi 会话内跑测试时 ambient `PERMISSION_MODES_INHERITED_MODE` 经 afterEach 还原泄漏，非本批功能改动引入）。**对抗 review 折入（2026-10-01,v3.2）**:F1 计费守卫测试补齐（40-turn 不重复计费 + 耗尽阻断新文件/已付文件不受影响两条 hook 级用例）;F4 删除 selectForTurn 耗尽早退（原实现把校准③要救的已付文件在耗尽态一并致盲——unpaid 由循环内 remaining 检查拦截,行为不变）;F5 `!prompt` 分支补 pin 空决定（与空选取路径对称）;F3 旧 P3-ME-04 主用例按 pin 语义重写（budget 断言移至 MR-05 直测,原 30× hammer 在 pin 下不再经过任何预算路径,用例名与注释已失准）;F2/F6/F7-F10 文字与 nit 同步（spec §4 残留、空选取吞 steering 话题登记 §7.5、注释缩进、CHANGELOG 双 Unreleased 合并、docs try/catch 措辞、MR-09① 逐元素守卫）。

71. **goal-hijack 修复（spec 2026-10-01-goal-hijack-fix，GH-01..06）**：`loadState` 在子代理会话（`PI_SUBAGENT_CHILD=1`，复用 modes/permission-forwarding 的 `isSubagentChildProcess`）跳过磁盘 goal 池收养；`reconcileFocusedGoalFromDisk` 同判定直接返回（实施中发现的补充守卫:10+ 命令/工具调用点 mid-session 重读磁盘池,loadState 守卫盖不住,GH-02b 用例钉住）；`queueContinuation` 顶部同判定早退（双保险，覆盖全部五个调用点）。根因：pi-subagents 同 cwd spawn 子会话 → goal 模块 session_start 无条件收养 `<cwd>/.pi/goals/` 活跃 goal 并武装续跑 → `<pi_goal_continuation>` checkpoint 占住子会话 agent loop → 派发任务 prompt 被拒（"already processing"），goal 活跃期间项目内 subagent 派发全部失败（events.jsonl 实证，2026-10-01）。父会话零行为变化（GH-05 红绿钉住：stash 守卫后仅子会话用例翻红）。测试侧：FakeHost 补 `idle`/`hasPendingMessages` ctx 选项（fidelity 缺口——缺后者时 product 的 try/catch 吞掉 TypeError 直接 return，续跑在 fake 里从未武装，属既有 harness 缺陷顺手补）。**对抗 review 折入(2026-10-01,v1.2)**:F1 测试运行器 env 纪律——run-tests.mjs 顶部 + 契约套件 setupFile(test/contracts/env-setup.ts)剥离 PI_SUBAGENT_CHILD/PI_SUBAGENT_PARENT_SESSION/PERMISSION_MODES_INHERITED_MODE(子代理内跑套件曾假红 6 goal + 2 contracts 用例,reviewer 实测复现;测试一律建模父会话语义,需子语义的测试自行置位);F2 GH-04 工具集断言补齐(FakeHost setActiveTools 从空操作改为记录);F3 GH-03 用例注释区分力边界(绿由 GH-02 保证,belt 走查覆盖,spec §3 预留路径);F4/F5/F7/F8 台账同步(FORK 补 reconcile 差异、spec §5.3 登记子会话写盘不可达的既有防线及失效条件、PROGRESS 计数、CHANGELOG 双 Unreleased 再合并)。

## 架构优化 8-batch（2026-10-02 起，方案 v2 经 2 轮 glm-5.3-flash 对抗审查定稿）

72. **不变量 4 表述精确化 + plan gate MCP 形状泄漏修复（B1 / 候选 C1）**：modes plan gate 的 MCP 形状判定原是 0.99-adapt 批引入的私有 `__`-only 正则（modes/index.ts `MCP_TOOL_NAME`），与 authority 已分歧——全单下划线 `mcp_exa_search`、proxy（工具名 "mcp" + `input.tool`）、direct-named（knownServers 门控）、裸 `mcp_*` 在 plan 只读 gate 全部穿透（invariant 4 的 single authority 结构上不可达：family.ts import modes/rule-families + permissions，modes 反向 import 即 P1→P4 倒挂成环）。修法：canonicalizeMcpTool 的纯函数核心下沉 `lib/mcp-shape.ts`（零 extension import，5 分支逐字保留），family.ts 组合之（对外签名/行为不变；`directKnownServersFromEnv` 同步下沉并由 family re-export 保持 web-gov import 面不破），modes plan gate 改消费同一底座（knownServers 从同一 env 解析取）。不变量 4 语义精确化为「authority = canonicalizeMcpTool（对外唯一入口）；shape 判定底座 = lib/mcp-shape.ts（authority 与 plan gate 共享）；禁止第三份实现」。行为变化：plan gate 从放行变拒绝上述 4 形态（bug fix，红绿 pin：modes/index.test.ts 4 条 shape pin + p4-families.test.ts authority 回归）。对抗审查处置：Round1 F1/F2 采纳（knownServers 参数化、文档同步三件套）；Round2 F3 采纳（5 分支枚举按 regex1/regex2/passthrough/proxy/direct 重写）。

73. **goal monolith 结构性拆分（B7 / 候选 C3，分步推进）**：goal.ts（~2500 行六合一 closure）按 DECOUPLE-PLAN 已验证模式分步拆分。已完成并三绿：step 1 continuation loop → `goal-continuation.ts`（三 loop 变量收进 module，idle probe + emit seam 注入，7 条直测；GH-03/g谓词逐字保留；statemachine 零改动全过）；step 2 completion-audit flow → `goal-audit-flow.ts`（ledger 三事件 + started/rejected/passed emits 经注入 seam，auditor 可注入，3 条直测）；step 3 pendingGoalAchievement 归入 audit 域（createPendingAchievementSlot）。**验收缩水记录**：goal 的 B7 验收原定「goal.ts 退化为 thin pi adapter」——状态机核心（persist/setGoal/replaceGoal/stopActiveGoal/loadState/池管理/记账）与 confirmation intent 粘合状态仍居 goal.ts（confirmation 的验证/对话框半边本就在 goal-draft/goal-questionnaire 有家），thin adapter 终态未在本批达成；已拆出的三个 module 均可独立直测。FORK.md P2-GO-06 上游跟进条款同步改写为结构性 fork 自持（上游 cherry-pick 通道放弃，diff 仅作人工参考）。终审对抗阶段对此缩水复核。

## memory 召回 v2 批（2026-10-02，spec 2026-10-02-memory-recall-v2 R1）

74. **MR-01/03/04/05/06/09 被整体取代（R1/D1-D3）**：前序 spec 2026-10-01-memory-recall-fix 的 per-turn pin & re-project、MR-03 query 快照、MR-04 双域词法、MR-05 计费判重、MR-06/09 缓存纪律随 request 级投影一起删除——词法召回（`selection.ts`）与状态机（`recall-session.ts`）整文件移除，代之以持久化一次投递 + LLM 清单选择器（`recall.ts` + `selector.ts`）。理由：实测 27 session/1253 request 复盘，request 级尾部重投影 = 4878KB 未缓存注入字节（持久化一次后 160KB，≈30×），且 run 级 pin 使 steer 消息（11% 用户消息）永不重选（RC-1/RC-2）。MR-08（已读抑制）与 MR-02（预算重置）语义保留但改为历史推导（RV-07 / compactionSummary 窗口）。

75. **删除的用例逐条登记（replace, don't layer）**：`recall-session.test.ts`（8 用例，被 `recall.test.ts` 11 用例取代）；memory.test.ts 的 `P3-ME-04 per-turn lexical injection`（1）、`P3-ME-04 lexical selection determinism`（1）、`MR memory-recall fix v3.1` describe（8 + isPrePaid 直测）、`C1 CJK bigram`、`C7 字节口径`（原则移入 recall.test 用例 9 的 CJK 截断）、`C1b 功能词 bigram`（词法门已不存在）；memory-v2-storage.test.ts 的 selection pooling 与两条 AD1 用例改写为 RV 语义（fake selector + before_agent_start；AD1 计费语义翻转 → RV-06 硬判重）。`P3-ME-09 resilience` 从 throwing context handler 改写为 throwing recall 路径。

76. **前序 spec 更正（2026-10-01-memory-recall-fix）**：①v3.1 校准②「before_agent_start 载荷无用户文本」在 pi 0.99.1 不成立（`BeforeAgentStartEvent.prompt` 存在，types.d.ts:688-698；`BeforeAgentStartEventResult.message` 持久化为 custom message，:1077-1081 + agent-session.js:1547-1556——已双通道静态核实 + 契约/单测钉住）；②§7.5 F6「steer 不重选是设计代价」结案：RV-01/03 改为每条真实用户消息一次选择（message_end 兜 steer，before_agent_start 承 prompt 路径）。

77. **召回常量不进 `CONTEXT_BUDGET` 发布对象（D10/S3 例外）**：`RECALL_*` 常量入住 `lib/context-budget.ts`（预算权威单一居所），但刻意不加入 bus 发布的 `CONTEXT_BUDGET` 对象——rules-wiring.test.ts 钉住对象形状，召回无外部消费方。风险由该测试承担（加字段必红）。

78. **附记 A.1 ③ 顺手修复（评审增量）**：automation 写入路径对「body 自带完整 frontmatter 的 op」叠双 frontmatter，correction 的 description 对索引不可见（实证：project 层 `pi-memory-recall-reinject-symptom.md`）。修法：`store.ts` `hoistLeadingFrontmatter`——前导 frontmatter 块的字段提升、body 取其 body-part；红绿钉住（memory-v2-consolidate 新 describe）。

79. **R3 实现范围与 spec 行完全对齐（2026-10-02-memory-recall-v2 R3）**：glob 上提（lib/glob.ts，rules re-export）、paths: 解析与作用域过滤（splitFrontmatter 仅内联列表——块列表行本就整文件判无效，属解析器现状而非新限制）、policy user 索引过滤、automation 三提示词路由指引 + store apply 层 user→project 重路由（projectKey 为 sanitized 目录尾段启发式，worktree 目录会露出 worktree 名——可接受，已注释）、importer 外项目条目改路由（找不到项目层 = skip+注明，替代旧「进 user 层加前缀」——migration 两条用例随之改写）、/memory 错层诊断。**无偏差**；migration 断言改写按 spec §7 R3 行明示登记。

80. **scopeMatches 的目录本体匹配（RV-14 实现细节）**：rules glob 引擎按语义不把 `dir/**` 匹配到 `dir` 本身（激活语义是文件）；召回作用域要「该项目含根目录」。修法：scopeMatches 对每个模式同时尝试 root 与合成子路径 `root/__scope_child__` ——不改 glob 引擎（rules 语义零影响），语义差异收在唯一消费点。

81. **TR 实施与 spec v1.1 的两处偏差(2026-10-02-core-tool-renderers)**:① 结果头行弃用 spec 示例的 📎 emoji,纯文本 + muted 着色(用户视觉口味克制,spec 自审 R6 补录);② B 的 resultStatus 用「Container 包装 + 追加行」而非 spec v1 初稿的改写文本(v1 自审 R1 判定初稿无效,修订版即实施版——builtin 从 details 渲染 diff 时不读 content text)。零包装规则:无 then_run 的 write/edit 返回原组件引用。

82. **goal notes 无 spec 直做(2026-10-02)**:resumeNote/userNote 为用户当日直接请求的小特性,无对应 spec 文件;按仓库纪律以测试+台账钉住。设计要点:resume note 为一次性内存态(不落盘,防重启后陈旧指示);user note 为 record 持久字段且仅用户可写(/goal-note)。ledger 未加事件类型(避免触碰 goal-ledger 三处 render switch;notify+持久化已可观察,后续需要再补)。

83. **recall v1.2 修订(2026-10-03,用户实机体验驱动,cctui handoff §3 诊断材料,取代 spec v1.1 三处)**:① D4 默认 waitMs 4000→0 —— 实测阻塞 before_agent_start 串行链导致 Enter→上屏延迟;② RV-03/04 投递改完成驱动:挂起选择一完成即 sendMessage(triggerTurn:false) 入 pi pending custom 队列,宿主在下一个 turn_end(最早=首条模型消息结束)落盘 —— run 内 request #2 可见、run 结束下一轮 request #1 可见,取消「continues=true 门控 + run 结束丢弃」(onTurnEnd 入口删除);③ agent_end 不再 abort 在途选择(晚到照样投递),latest-wins 改由下一条用户消息的 before_agent_start abort 承担。投递时重滤用消息时快照的惰性 thunk(选择期间新读文件仍排除)。display:false 隐式性双 TUI 源码核证。测试:recall.test.ts 3/4/5 重写、wiring 18 改完成驱动断言 + display 隐式断言。


84. **memory shutdown flush 推翻(2026-10-03,spec 2026-10-03-memory-exit-flush)**:DESIGN-MEMORY-V2 §4 的 `session_shutdown(reason≠reload) flush(10s 硬顶,静默)` 一项被整体推翻 —— 实测根因:宿主串行 await 全部 shutdown handler 且无超时兜底,主模型(glm-5.3)在真实 23KB 尾窗上冷调 11-12.4s、cache 命中仍 10.5s(瓶颈=生成速度 ~70tok/s,非 prefill),每次长会话退出必打满 10s 且 applied=0 纯浪费。替代:shutdown 只原子落盘 cursor 相对后缀 60 条到 `~/.pi/agent/memory-queue/`(P0-CT-09 已登记),下一同项目 session_start 后台 drain(≤5 条/次、≤3 次/条、projectsDir 精确路由、7 天/2MB GC)。compact flush(session_before_compact,60s 跟 event.signal)保留 —— 其挂在本就等待且可 Esc 中止的路径,非退出卡顿源。配套修复(对抗审查 A1):session_start 重置全部每会话闭包态 —— 原实现里 /new,/resume,/fork 后已死的 AbortController 会静默杀死全部 automation(现存 bug,独立于本 spec 成立)。附随:side-channel 模型回退链改 `model → recallModel → 会话模型`(llm.ts resolveModelRef 单一实现,selector.ts 委托,D3 语义不动)。

85. **compact flush 保留条款推翻(2026-10-03,arch review C2,用户批准)**:#84 明确保留的 `session_before_compact` 60s awaited flush 被推翻 —— 巡查发现 12s 退出停顿只是被搬家而非消灭:宿主对 compaction 同样串行等待,每次 /compact(≥3 用户轮)在侧通道生成上等待 ~10s(上限 60s)。替代:compact 与 shutdown 共享 `stageUnextractedTail`(同一 queue seam,cursor 相对后缀、clamp ≤60×2000 字符、原子写、同 sessionId 记录替换),下次同项目 session_start 后台 drain;runOps 的 "flush" kind 与 FLUSH_COMPACT_MS 随之删除。用户指示原话:「Compact 其实不太需要记忆,改成 queue seam 也可以」。测试:compact 两测重写(零 LLM + stage 记录断言)。

86. **json-lift 归一的轻微行为面变化(2026-10-03,arch review C4)**:四处手写的「模型文本捞 JSON」归一到 lib/json-lift(canonical 顺序:fences 文档序后先 → 整文 → 字符串感知平衡 span 文档序 → 最外层切片;每 candidate 先原文后修复变体)。行为升级三处:① memory llm/selector/review 三消费方现默认启用 BOM+尾逗号修复(原仅 modes classifier 有);② selector 修掉字符串感知缺口(value 内 `}` 断 span → 静默 parse_error,recall v2 新代码);③ review extractVerdictBlock 的兜底在「fence 可解析但非 verdict 形状」时也生效(原仅在无任何 fence 可解析时)。多顶层 object 时谁先命中由各消费方 payload 校验决定,顺序差异已在 lib 头注释记录并有测试钉住。

87. **goal auditor 拒绝块统一(2026-10-03,arch review C6)**:goal.ts before_agent_start 里两份手抄的 [AUDITOR REJECTION] 注入(上游 capyup/pi-goal 继承的复制漂移)收敛为 goal-prompts.ts 的单一 `auditorRejectionBlock(report, goalId)`。选择丢弃 active 分支的 `completion_requested` 门:探查(R2 复核)证实 `audit_result` 唯一写入者 `runCompletionAudit` 必先 append completion_requested(goal-audit-flow.ts:91-98),该门在「append 成功」前提下不可达;DEVIATIONS 前提措辞:completion_requested 的 append 被 try/catch 静默吞,撕裂写世界里两分支统一后行为恒等(paused 的无门行为反而更安全)。行为面变化:paused 分支 header 从 `[AUDITOR REJECTION]` 变为带 goalId(与 prompt 族 marker 格式对齐);无测试 pin 过旧注入(补了 builder 直测)。纯搬移部分:渲染三件套 → renderers.ts,oneLineSummary → goal-core.ts,行为零变化。

88. **alt+t 归属 effort + 单档模型零写入守卫(2026-10-03,arch review C5 Move A)**:modes 的 THINKING_LEVELS 硬编码六级表 + 写探测循环删除,alt+t 由 effort 注册并与 ctrl+shift+e 共享 cycleShortcut handler(纯决策函数 decideCycleShortcut:write/noop/unavailable 三态)。修复两处用户可见行为:① 单档/clamp 模型下,旧循环最多 6 次把被 clamp 候选写进持久化 explicit 槽(②>③ 整 session 压制 profile effort,仅 /effort reset 可解)——现 noop 只通知零写入;ctrl+shift+e 现存的同类单档污染同修。② 循环改为模型感知(getUserFacingLevels,alt+t 额外含 off;ctrl+shift+e 保持不含 off)。effort.md en/zh 自「modes 注册」现状描述更新为目标态。modes 侧负例测试钉死双注册不可能(registerShortcut 为 per-extension Map.set 静默共存)。DEVIATIONS #15(alt+t 归入所有权链②)语义不变——两实现本就经 owner。

89. **modes profiles 有状态半边迁 profile-apply.ts(2026-10-03,arch review C5 Move B)**:lazy 首激活/reload 重盖章/entry 恢复覆盖 flag//model-profile/alt+i/--model-profile 自 index.ts 迁入 ProfileController 工厂(deps 注入 getMode/onStateChanged/sendList);四个保真点逐字保留(①lazy 在 apply 路径非 init;②重盖章仅内存不改盘;③entry 恢复覆盖 flag;④undefined effort 不碰思考档)。frozen entry activeProfile 字段形状不变(persistState 读 controller.active)。纯内部搬移零行为变化,456 modes 测试全绿含全部 profile 用例。

90. **session_recall 前置 bug 修复 + 有界异步扫描(2026-10-03,arch review C8 + R2 P1-1)**:① `sessionsDirFor` 命名修复 —— 原用 projects 层的裸 sanitize 形态,pi 的 sessions 层实为 `-${sanitizePath(cwd)}-` 包裹横杠(实机 51/53 目录 + 本 session 自身路径实证),导致工具真机恒返回空(消费者仅 session_recall 一条链);修复后工具真机首次可用(CHANGELOG 记)。② 扫描异步化(fs/promises 有界读,不再卡事件循环)+ 三重上限(200 文件/单文件 1MB 有界部分读——R1 的整文件跳过设计因系统性丢弃最新大会话被否——/总预算 8MB)+ 透明度行(scanned/truncated_size/budget/bytes;budget 截断才提示收窄 query)。披露:单条 >1MB 行不可匹配(此类行本被 extractText 排除);预算挤占使旧小文件可达性低于跳过方案(近期优先取向,spec §5.4 记录)。

91. **随手修四项(2026-10-03,arch review)**:① memory 两处手写 settings.json 读取(automation.ts loadMemorySettings / yield.ts staticProbe)改走 lib/settings readJson —— 回退语义逐字保持(missing/malformed → 默认,静默);删 AutomationDeps.now 死成员(声明后零引用)。② lib/glob globToRegExp 加模块级 Map memo(rules tool_call 热路径曾每 glob×每 path 重编译;模式集来自规则文件,天然有界,不设逐出)。③ queue drain 并行化:≤5 条记录由串行(最坏 5×20s)改 Promise.allSettled(最坏 max(20s));前提写明 applyMemoryOps 全同步(事件循环下原子,无 corpus lost-update);两个语义变化:串行版 infra 失败 catch→return 中止整个 drain 的行为消失(各记录独立尽力),QUEUE_DRAIN_MAX 保持只数 eligible 记录。④ memory 三处防御式 sessionManager cast(historyFor 的 buildSessionProjection / 两处 getBranch / sessionIdOf)收敛到 modes/session-branch.ts 读取器(session-branch 补导出 readSessionProjection;getBranch 读取后局部统一 shape cast,防御探测归读取器)。

92. **C1 memo key 加宽 + code 审查 R1 修复(2026-10-03,arch review)**:① C1 identity memo key 实现为 `${root}\0${toolName}\0${toolCallId}`(spec §1.1 初稿为不含 toolName 的简式)——toolCallId 单独不唯一(不同 tool 的消息可共享 call id),加宽后有碰撞负例测试钉住;spec 文本同步。② code 对抗审查 R1 的 P1 修复:session_recall 消费循环 limit-break 时显式 `iterator.return()` 关闭挂起的 async generator(否则 reader 的 finally 不执行、FileHandle 泄漏,命满即泄,长会话累积 EMFILE);P3-1 drain 诊断聚合单点写入、P3-2 identity 保留成本披露。详见 REVIEW-2026-10-03-arch-followups-code-r1-adversarial.md。

93. **code 审查 R2 处置补正(2026-10-03,arch review)**:R2 ACCEPT 但抓出 R1 处置的两处虚记 —— P3-2(projection.ts 保留成本披露)与 P3-4(ledger.ts re-arms 措辞)的替换脚本未断言匹配、实际未落地即记账;本轮以断言 + grep 复核真正落地(虚记教训与既有台账纪律条目同源:处置必须逐条对文件验证)。附 R2 report-only 两项采纳:drain 聚合的 flushes/lastFlush 现按 applied>0 计数(旧版 ops.length>0 即计;仅 /memory panel 诊断面、无测试钉住、语义更准——真写入次数);session-recall finally 注释缩进归位。

94. **policy 文案路径不一致修复(2026-10-03,project memory core-memory-policy-path-mismatch)**:POLICY_COMPACT 静态文案写 `PROJECT memory (<project>/memory/)`(字面项目目录)而实现(resolveMemoryPaths)读写 `~/.pi/agent/projects/<git-canonical-root>/memory/` —— 2026-10-02 有 session 按字面把记忆写进仓库根 memory/(不入索引/recall;当日已合入 canonical 并清理)。修复:POLICY_COMPACT 常量改为 `policyCompact(projectMemoryDir)` 函数,注入真实绝对路径 + 显式「NOT in a memory/ directory inside the repository」防复发子句;buildPolicyInjection 与 degraded 注入点(index.ts policy-only 分支)均传入实际 dir。回归钉:单测断言插值路径出现/字面形态消失(memory-v2-storage)+ e2e 注入断言(memory.test P3-ME-03)。

95. **/memory 面板 recall 状态误标修复(2026-10-03)**:面板 reason 原逻辑「machine 为 null 且 recallModel 已配 → 报 'recallModel unresolvable'」——但 machine 只在 before_agent_start 时创建,新开 session 尚无 agent turn 时面板把「尚未尝试」误标为「unresolvable」(实测探针:真实 registry 下 resolveModelRef('CPA/model-fast') RESOLVED,headless 复现 on;用户重启后面板仍报 unresolvable 即此误标)。修复:/memory 处理器报状态前先 ensureRecallMachine(cctx) 重试(幂等、无 LLM 调用);真不解析时仍如实报 unresolvable。双测钉住(panel 自愈 on / 真 unresolvable off)。

96. **review 提取挪 agent_end(2026-10-03,用户设计决策)**:bulk 整理(review)从 turn_end 门槛命中即开火改为 run 结束(agent_end)时判定开火——完整 run 为提取快照单元(不再从进行中对话提取)、单 run 至多一次 LLM 提取、cursor 推进缩小 shutdown/compact stage 尾窗(与 latency 拆解结论②对齐)。correction 留在 turn_end(6-part 窗口靠新鲜度,挪走会被长 run 挤出丢纠正)。新增:REVIEW_MAX_PARTS=60 suffix 上限(queue-clamp 对齐,防超长 run 单次 prompt 无界);空窗口守卫(cursor 以来无新内容 → 重置计数器不发 LLM——旧版会对空对话开火,既有测试依赖该行为,已改为提供 sessionEntries)。测试:全量 review 用例加 agent_end 触发点 + 新增「turn_end 达阈但 run 未结束不开火」节奏钉。turn_end 保留计数与 correction。

97. **pi 1.0.x 适配:依赖矩阵全量升级与 peer 上界放宽(2026-10-03,spec 2026-10-03-pi-1.0-adaptation,计划对抗 2 轮)**:devDeps 四包(pi-agent-core/pi-ai/pi-coding-agent/pi-tui)0.99.1→1.0.1;peerDeps 三条 @earendil-works 上界 `<1.0.0`→`<2.0.0`(floor 不动:pi-ai >=0.86.0、其余 >=0.87.0)。上界取舍:`^1.0.0` 会丢 >=0.87 旧宿主支持故不取;`<1.1.0` 逐 minor 放行维护摩擦大(earendil 家族 lockstep 发版)故不取;**1.x minor 未逐一实证,接受三门禁+契约套件(pi-host-semantics ③④⑤⑥ 直 import 真包)兜底,出问题回退 peer 上界**。证据:四包 0.99.1→1.0.1 对 core 全部 34 个直接 import 符号 additive-only(pi-tui 仅 :8/:28 两条 export 行扩充,pi-ai 仅 JSDoc 措辞,pi-agent-core d.ts 零删除);唯一代码适配 = modes 测试 fake host 补 `registerToolRenderer` no-op(1.0.1 ExtensionAPI 新必选方法,core 生产代码未用到)。codemode 交互钉测试 2 个:ask 档本体静默放行是设计行为(安全边界在嵌套调用逐工具 gate——上游 tool.js:5-9/execute.js:304 嵌套调用走完整 tool pipeline,此为上游文档化事实非钉测试);plan 快照/恢复与 codemode active 共存(两步构造防假绿)。ask 档是否应对 codemode 本体 prompt 属产品决策,记「不做」。

98. **AR1005-JS json-lift 字符串保真 + 惰性候选(2026-10-05,spec 2026-10-05-core-architecture-reliability §3)**:① repair 由不识别字符串的正则 `/,\s*([}\]])/g` 改为字符状态扫描(跟踪双引号字符串与反斜杠转义;仅字符串外「逗号+JSON 空白+`}`/`]`」时删除该逗号及空白)——文档同时存在真实尾逗号时字符串正文不再被改写(基线已复现:`"literal ,} sequence"` 被改成 `"literal } sequence"`;JS-T01/T02 先红后绿钉住)。② 候选生成改为私有惰性 generator(jsonCandidates 收集、liftJson 直接迭代),阶段 1/2 成功时 balanced span 扫描不再执行(JS-T07 用模块内计数 seam 以操作次数断言,不用机器毫秒门槛);候选顺序与 Set 去重语义同基线逐字一致。③ 按规格 AR1005-JS-03 **保留** balancedObjectSpans 既有恢复规则:仍需 span fallback 的畸形输入保留平方最坏情形(本批披露不修;后续如优化须独立建立差分语料,不得顺手改容错能力)。④ 新增模块内测试观察导出 `_spanScanCountForTests`/`_resetSpanScanCountForTests`(规格允许的私有候选生成 seam 计数替身;非跨模块候选协议、不进包 exports、不入工具 schema)。⑤ docs en/zh lib.md 补 json-lift 表行(0.2.1 C4 批的文档遗漏,本批一并补齐)。四消费者连接钉测试各一(classifier/selector/ops/review verdict)。

99. **AR1005-RC recall 生命周期(2026-10-05,spec 2026-10-05-core-architecture-reliability §4)**:① RecallMachine 增终态 `dispose()`(幂等不可逆;abort 保持可复用重置);每请求 generation + AbortController + 等待 timer + cancelled resolver —— 新消息/abort/dispose/机器替换立即失效:在途 await 即时返回 null(不挂死在忽略 abort 的 selector 上;规格只要求「立即/有界」,cancelled-resolver 给到立即),晚到完成零 history 读取/零投递/零状态污染。② `onUserMessage` total promise(RC-02):入口与延迟段全部抛错收敛为 null + 每失败请求至多一条 `diagnose` 诊断(新增可选 dep,默认 no-op,wiring 接 console.log);selector 同步 throw 用 `Promise.resolve(...).catch` 归一(已 settled 原生 promise 保持同一性,零额外 tick)。③ RC-03:deferred 仅在 deliver 同步成功后提交 runDelivered/deliveries(旧版 assemble 内先记账,deliver 抛错时假标记已交付 + unhandled rejection);immediate 维持「返回即已交付」约定不变。④ wiring(RC-04):session_shutdown 任意原因同步 dispose(独立 handler,与 automation 的 shutdown 并存);session_start 防御性 dispose + 清 label/prompt 标记/recallOffNotified;ensureRecallMachine 在 label 变更/关闭召回时先 dispose 旧机。正常 agent_end 不 abort/dispose(v1.2 语义保留,DEVIATIONS 历史条目继续成立)。⑤ 契约 AR1005-RC-HOST 先登记后测试(§13.1 四行一并登记);unhandledRejection 验证用隔离子进程(rc-host-scenario.ts 由 bun 显式拉起 —— node strip-only 模式拒收参数属性,且 vitest 下 process.execPath=node 时包 exports 封锁深路径 import,故 loader 走相对路径);基线红证据:SCENARIO_UNHANDLED + exit 2。⑥ 旧缺陷测试均以 stash 方式在基线确认红(recall.test 8 红 + memory.test T09 3 红)。

100. **AR1005-AU audit 预中止与 session 释放(2026-10-05,spec 2026-10-05-core-architecture-reliability §5)**:① AU-01 封套顺序改为「先建立内部取消结果监听与清理 → 连接外部 signal → 立即检查其当前状态」:预中止的 update_goal 不调用 auditor、不启动新模型工作,直接走既有 rejected outcome 文案(goal remains active);started 事件与 completion_requested/audit_started/错误 audit_result 台账语义保持("started = 流程被请求"而非"模型已启动");timer/外部 listener/内部 listener 全部退出路径释放。② AU-02 auditor:session 创建一解决即进入覆盖全部剩余生命周期的 try/finally —— 创建期间取消:不 prompt、dispose 恰好一次;subscribe/prompt/unsubscribe 任一异常仍 dispose(unsubscribe 与 dispose 各自 try/catch 守护,一处抛错不跳过另一处);创建失败(无 session 对象)不调用不存在的 disposer;flow 超时/中止返回后的晚到完成只清理资源、只产出 aborted 错误 outcome,绝不补发 passed。③ 新增 `sessionAdapter` 内部测试 seam(受控 adapter 对真实 createAgentSession,单一宿主边界非全 mock 间接层,规格 AU-02 明示允许)。④ 基线红证据(stash):AU-T01/T03/T04/T05/T06a/T06b/T06c 七项红(基线预中止仍调用 auditor 并产生 "Auditor error: Auditor aborted." 文案;session 泄漏路径若干);AU-T02/T05-flow 为附加钉(基线 a01a083 已覆盖,保留为回归面)。

101. **AR1005-FU then_run 展示解释权收敛(2026-10-05,spec 2026-10-05-core-architecture-reliability §6)**:① 新增纯解释模块 `action-fusion/outcome.ts`(规格允许的"仅包含纯结果解释的内部 module"):结构化 `details.thenRun === "succeeded"` 为第一权威(未知字段值不强断为成功——生产今日只写 succeeded,failed/skipped 走 throw);文本兼容为行锚定(协议行 = 以 marker 起始的行,或生产 text block 开头),不再任意行中子串 includes;历史 `ok` alias 仅在文本兼容层保留。renderers.ts 不再持有第二套 marker 常量/判定优先级。② FU-02 能力探测:renderResult 消费 `ToolRenderContext.args` / `.isPartial` 与 `ToolRenderResultOptions.isPartial`(契约 AR1005-FU-HOST 以编译期 type-level 钉在真包上——字段被删则 contracts 门禁的 tsc 先红;运行时缺字段的保守回退由结构化缺字段替身测试覆盖):args 在场而无 then_run → 永不包装(正文含 marker 也不);partial → 无终态;args 不可得(旧宿主)→ 旧扫描行为。③ 成功 UI 文案保持 "✓ ok" 设计,协议 token 不改名为 ok;fusedCount 维持仅按结构化成功计数(B6 语义);解释不改写 content/details。残留披露:无结构化来源且日志伪装成完全相同协议行时,纯文本历史无法无歧义判定(规格明示接受)。④ 基线红证据(stash -u):tool-renderers 3 测试红(T04 零包装、T06 生产 succeeded 徽标 + T02 结构化压制、行中 prose 误配);then-run.test 的 FU 组因 outcome.ts 在基线不存在而整文件失败(模块缺失红),其行为红由 tool-renderers 侧同语义断言兜底。

102. **AR1005-GO-A goal 计时余数(2026-10-05,spec 2026-10-05-core-architecture-reliability §7.2)**:① 新增 `goal/goal-accounting.ts` 时钟模块(四能力:begin 开新段且保留该 goal 余数 / settle 结算 floor((elapsed+carry)/1000) 并保留余数、null 表示无活动段由调用方 begin / preview 只读预览 / pause 丢段保留余数、forget 释放完成或清除 goal 的余数);goal.ts 的 `accounting` 双可写变量删除,知识集中。② 旧缺陷:accountProgress 每次 `Math.floor` 后无条件重置 lastAccountedAt —— 8×250ms 工具结束事件把真实 2 秒记为 0 秒(基线红证据:`actual: 0, expected: 2`,FakeHost + 注入固定时钟)。③ 时钟 seam 经 goal factory 第二可选参数注入(`deps.now`,装配不传 → performance.now 单调时钟);updatedAt/ledger 时间戳仍走既有 Date.now/nowIso 墙钟。④ GO-A-02 冻结取舍:落盘仍整数 activeSeconds、不加 carryMs 字段、不迁移旧记录 —— 重启至多丢当前段未持久化的亚秒余数(规格明示接受,不得回退为逐事件丢失)。⑤ setGoal 在 goal 永久离开(null/complete)时 forget 余数;paused 保留(removeFocusedGoal 为无调用方死代码,未接线)。⑥ GO-B(同事件读取收敛)为独立后续提交,本提交不动 persist/reconcile 的读取结构。

103. **AR1005-GO-B 同事件读取收敛(2026-10-05,spec 2026-10-05-core-architecture-reliability §7.3)**:① accountProgress(用量行为入口,GO-04)创建每事件 `{ goal }` 读取上下文:reconcileFocusedGoalFromDisk 以可选 `captureDiskGoal` 填充刚解析的聚焦盘上 goal,persist/syncGoalPromptFromDisk 在上下文在场时复用其 objective、不再 mergeGoalPromptFromDisk 重读重解析。② 语义边界:上下文仅同一同步调用段有效(无 path-keyed 缓存、不跨事件、不跨 await);下一事件重读池并观察外部 objective/status/autoContinue/删除(GO-T09 钉);零 usage 早退保持在 reconcile 之后(外部取消/删除检测不跳过);全池 reconcile 与 preserveMemoryUsage max 合并不变;命令、无上下文 persist、状态转换、await 后路径均 fresh read;writeActiveGoalFile 的路径/symlink 检查与原子写全保留(仅减少读取侧重复解析,未触碰写侧安全)。同步段外部读取时点 = 事件开始 snapshot,不新增跨进程事务隔离。③ 操作次数证据:goal-files 增测试观察 seam `_parseGoalFileCountForTests`(计数替身,非公共协议);基线红:单事件 4 解析(池 3 + persist 合并 1),修复后 3;benchmark 1/10/100 goal → 每事件 N 解析、零额外聚焦读(基线 N+1),O(N) 池扫描按规格保留。④ 本项与 GO-A 独立验收:GO-A(计时)先红 `0 ≠ 2` 后绿;GO-B(读取)先红 4 解析后绿 3。

104. **AR1005-RU 规则激活整轮预算(2026-10-05,spec 2026-10-05-core-architecture-reliability §8)**:① 新增 `rules/activation.ts` 激活预算模块(规格 §8.2 建议形态):turn = turn_start → 下一个 turn_start,同 turn 全部 pi-rules-activate content.length 累计 ≤ DYNAMIC_STEER_MAX(JS 字符长度,标题/空白/指针说明全计);session_start 重置激活集+预算 epoch,turn_start 仅重置本轮用量,首个 turn_start 前的工具调用用 session 初始化的零用量 epoch;不在 before_agent_start/每 tool_call/每条命中处清零。② 下发阶梯:全文(放得进剩余)→ 既有完整指针(逐字保留)→ 短指针(完整路径+最小说明,不截路径不截正文)→ 本轮不发不标记(无后台队列,下次匹配重试);send 同步成功才消费预算并标记 activated(指针成功也算,与历史超大单条语义一致);检查/预留/发送/提交-回滚在同一无 await 同步过程(预留先于 send,同步重入 adapter 观察到扣减后的预算;send 同步抛错回滚预留、保持未激活、不影响其余)。③ wiring:index.ts 增 turn_start handler + 同步 send adapter(pi.sendMessage 同步抛错 = 激活失败,异步 rejection 不算);activatedNames/steerRule 删除,once-per-session 判定与 /rules 面板计数改由模块提供。④ 公开行为变化(超预算时部分全文变指针或等下次命中)已按规格 §8.3 写入 CHANGELOG 与双语文档;未超预算的单规则输出逐字不变。⑤ 基线红证据(stash index.ts):T01 `expected 18036 ≤ 8000`(3×6K = 18,036,即规格复现数字)、T02/T07 红;模块级 T06(throw 回滚/同步重入不双花/短指针保完整路径)为新增 seam 行为。⑥ 契约 AR1005-RU-HOST 已登记;真机 turn 生命周期无法无模型自动驱动 → 按 §13.2 test.todo 指向 Phase 4 宿主验收 + 注释内人工步骤。

105. **AR1005-ST 流式统计读取缓存(2026-10-05,spec 2026-10-05-core-architecture-reliability §9)**:① 新增 `modes/working-stats.ts`(快照+失效+usage 快照唯一所有者;accumulateBranchStats 求和与前缀检查不动):cheap key = sessionManager 实例(WeakMap id,拒绝以 ctx 对象身份为 key)+ sessionId + leafId(经 session-branch 形状权威新增 readLeafId/readBranchEntriesStrict;合法空 branch null 可缓存,getter 缺失/抛错 = 不可缓存走旧读路径,不提 peer floor;读取失败绝不缓存为成功空快照,下一事件重试)。② 失效表:session_start/session_tree/session_shutdown → reset(含累积器);session_compact → invalidate;message_end(新增 handler,先于宿主 append)→ markDirty(与 leafId key 双保险);model_select(新增 handler)→ usage 失效;turn_start/turn_end → force 一次已提交读(turn_end 旧版同 handler 内重复读两次,现一次);before_provider_request → 仅 forceUsage(不再无条件重复相同 branch 求和);message_update → 纯 key 命中。③ 展示/发布不动:publishCapability 节奏、fallback adapter、legacy keys、TPS 公式与格式保持(ST-03/ST-06);流式片段不入 branch totals(口径不变)。④ 证据:ST-T01 基线红 `expected 200 to be 0`(基线 200 次 getBranch,即规格复现的 2M parent-map 读取),修复后 0/0;benchmark 1K/10K/50K × 200 update → getBranch=0 getContextUsage=0 getLeafId=201;ST-T03 对真实 SessionManager.inMemory 对照 brute-force 四通道求和一致;契约 AR1005-ST-HOST ⑩(真实 SM append 后 leaf 移动 + branch 增长 = key 失效信号)+ ⑪ todo(真机 run-loop 的 message_end 先于 append 顺序无法无模型自动驱动,Phase 4 人工验证;接线另以 markDirty 双保险,正确性不单靠该顺序)。

106. **AR1005-OB 稳定 observation 投影 memo(2026-10-05,spec 2026-10-05-core-architecture-reliability §10)**:① ProjectionState 增 `placeholder: Map<memoKey, {text, tokens}>`(与 identity 同键 `${root}\0${toolName}\0${toolCallId}`;值仅 placeholder 字符串 + token 估算,不复制全文、不驻留 split 数组)与 `placeholderConstructions` 计数(状态上的诚实可观察量,非 monkeypatch/生产导出配置——规格许可的构造计数 seam)。② 语义:首次 replacement 需要时生成(full-send 阶段零构造,基线亦然,T02 钉)、逐字复用(T01 跨请求 + 跨 fresh state 逐字一致,含 CRLF/无末尾换行/Unicode/长单行)、memo 在 ledger append 之前写入 —— ledger 失败保留 memo 但计数/节省不提交(T05)、不跨 root/tool(T03)、进程重启重生成、磁盘 id/hash/filePath 不变。③ OB-02 全保留:store/appendLedger 顺序、FULL_SENDS、sentCounts 恢复、首替换计费与 sentinel 完全不动;每次 replacement 请求仍追加 ledger 行(memo 绝不跳过审计,T07)。④ 证据:基线红 3 项(计数断言 undefined);benchmark 16 KiB/2 MiB/8 MiB × 51 请求 = 1 次构造、热请求 ~0.001 ms(基线 8 MiB 单次构造 ~26 ms);5×2 MiB 多旧结果 = 5 次构造。⑤ 内存成本披露延续:memo 正比于短 placeholder 数量(每 identity 一份短字符串 + 数字),不新增全文驻留;沿用既有 identity 全文驻留取舍,不因此批加 compaction/LRU。

107. **AR1005-CL 删除 memory preflight 死读取(2026-10-05,spec 2026-10-05-core-architecture-reliability §12)**:applyMemoryOps 每 op 的 `const existing = listMemoryFiles(dir)` 无任何消费方(单文件唯一出现,引用检查确认),删除;batch 开始时为 postFileCount 读取两目录的必要计数与真正的存在/安全检查全保留。纯死工作删除,不引入新 module/interface/缓存,不加"证明某行被删"的专门测试 —— 回归面即既有 storage/consolidate/batch/automation 套件(93 测全绿)。store.ts header 的 per-op preflight 语义行同步标注。

108. **AR1005-RV 跨仓 review 规则上下文(2026-10-05,spec 2026-10-05-core-architecture-reliability §11)**:① prepareRun 的 `discoverRulePathsLocal(cwd)` 从"workspace 准备之前、以调用者 cwd"改为"workspace 重试/HEAD 检查落定之后、以最终 workspacePath"(RV-01 路径事实表:配置加载/run artifacts/manifest·diff·workflow 写入归调用者 cwd;目标源码/目标规则/reviewer 工作目录归最终 workspace)。manifest.rulePaths(冻结的相对路径数组形状不变,相对 workspace 解释)、ChangeProfile.rulePaths、rulesheriff 路由(adaptiveSkips)与 directive 全部消费同一份 prepared 值,无各自重推导。② RV-02 全保留:gh pr diff 权威、force-push/HEAD mismatch 重试与失败语义(T04 实测重试后取最终 workspace 规则)、local dirty/clean 与 diff-file 的 workspace 选择(T05 钉)、rulesheriff explicit disabled/fixed/adaptive/lite 优先级(T02/T06 + 既有套件)、artifacts 冻结路径与 manifest 字段形状、不加载目标仓 reviewer 配置、不扫描目标仓之外的更多规则目录。③ 规则发现失败沿用既有读取降级语义(discoverRulePathsLocal 内部 try/catch 忽略,未新增错误策略)。④ 证据:基线红 5 项(T01/T02/T03/T04/T06 — 调用者 cwd 推导的错误结果),修复后 24/24 绿;受控 clone fake 在 cloneDir(args[4],git clone 形状)种入目标规则文件,断言 manifest 与 reviewerIds 而非 directive 子串。
