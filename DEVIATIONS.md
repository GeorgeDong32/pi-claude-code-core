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
