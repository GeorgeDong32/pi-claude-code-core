# PROGRESS — pi-claude-code-core 实施进度

> 每模块:状态 / 复查结论 / 测试计数 / 剩余风险。日期均为 2026-09。

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
| P2-REV-06 | review config 读写迁 lib/settings.ts(165 测试兜底)——PLAN §1.4 三类重复全部收敛 | ✅ |
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
