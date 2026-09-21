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
    源包未安装 node_modules,三个 UI 测试文件(goal-auditor/questionnaire/widget,各 4 test)在源包目录直接 ERR_MODULE_NOT_FOUND;core 内 0.85 依赖齐全后 75/75 全绿(66+9=75,多出的即那 3 个文件的测试)。spec 的 103 为估算误差。随迁断言零改动:tests 与 npm 0.6.0 tarball 的 tests 目录 diff 仅 import 路径扁平化(DEVIATIONS #25)。

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
