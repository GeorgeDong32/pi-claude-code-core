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
