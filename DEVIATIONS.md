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

