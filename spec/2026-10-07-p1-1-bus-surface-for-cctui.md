# SPEC P1-1：bus 的跨包面整理（契约补登记 · 实例标识 · reader 去留提案 · footer 归属）

状态：规格已补齐；instance / footer / 加性契约可实施，reader 去留**待决策 D4**；D5 归属原则已确认

> **实施记录（2026-10-07）**：可实施部分已落地——契约表登记（XPKG-01..09-HOST，ff0f7e7）、`snapshot.instance` + 类型加性补齐（320e7e5）、footer helper + 降级时机 + modes footer 渲染（见 git log）。D4 未决，reader/exports/行为断言原样保留。**生产方已就绪**：TUI 可消费 `snapshot.instance`（reload 检测）、`onChange`（v2 订阅）、`display.footer`（cc-footer 渲染，off 恢复 stock 例外见 §1.4）、通知尾队列协商语义不变。仍待联合验收：两种加载顺序 / off/on / reload 失败下的真实 footer 槽位（B6/C11）、widget 排序时序取证（XPKG-09-HOST todo）。基线 core revision：见 PROGRESS.md 本批条目。
日期：2026-10-07
分支：main
来源：2026-10-07 联合架构审查，清单项 CORE-07 / CORE-08 / CORE-09 / CORE-10（报告 X1、C7 卡片）
配对：pi-claude-code-tui `spec/2026-10-07-p0-2-core-bus-client.md`（消费 `instance`、通知协商语义与 `display.footer`）。本 spec 的 instance / footer / 契约部分先落地，或两边同一天落地；TUI 不依赖 reader 删除。

## 1. 背景与证据

### 1.1 已检索范围内 `readCoreStatus` 没有生产调用方

- 发布方式：`package.json` 的 `exports["./types"] = { types: "./types/index.d.mts", import: "./types/core-status.mjs" }`。
- 调用方检索结果（2026-10-07）：
  - 整个 `~/Coding/Pi-Extension` 工作区和 `~/.pi/agent/git` 下已安装的 3 个包（core / cctui / pi-subagents）中，引用只出现在 core 自身。
  - 这些引用是：测试 `test/lib/bus-types.test.ts`、`bus-channels.test.ts`、`rules-wiring.test.ts:170-180`、`memory.test.ts:573-585`、`test/contracts/observation-sites.test.ts:109-141`，以及 spike `test/spikes/types-subpath-spike/`。
  - cctui 从未 import 它，而是自写 3 个 duck-typed 镜像：`pm-capability.ts:47-54, 146-149`、`obs-savings.ts:34-37`。
- 类型也不诚实：`CoreStatus`（`types/index.d.mts:49-71`）声明了 reader（`core-status.mjs:93-108`）从不返回的 6 个字段——`onChange`、`modes.meta`、`goal.widget`、`notifications`、`observation`、`fusion`。另外 `goal.widget.goal` 缺少已经发布的 `costUsed`（`goal.ts:746, 759`）。
- `extensions/bus.ts:21` 以 type-only 方式 import `CoreSnapshot` 等声明，所以 `types/index.d.mts` 本身必须保留。

### 1.2 bus 实例在 `/reload` 后会更换，但快照里没有任何标识

- `bus.ts:194-199`：`sharedBus` 是模块级变量。pi 用 jiti `moduleCache:false` 加载扩展（`pi-coding-agent dist/core/extensions/loader.js:478`），`/reload` 后会新建 bus。
- 按不变量 3，publish 应在事件处理器内（现存 economy 例外见 §1.3），所以重载后到新 bus 首次 publish 之前，`globalThis.__piClaudeCodeCore` 仍是**旧 bus** 的快照，`onChange` 指向旧的 listener 集合（`bus.ts:123-129`）。
- 运行时复现：审查目录下的 `sims/reload-sim.mjs` 显示，cctui 会 attach 到旧 bus，重载后的通知全部丢失。cctui 侧修复见配对 spec，core 侧只需提供可比较的实例标识。

### 1.3 `display.footer` 无人渲染、互相覆盖、且在加载期发布

- 生产方：`lib/pi-compat.ts:81-95` 的 `degradeEconomyModule`，由 `action-fusion/index.ts:92-96` 与 `observation-pack/index.ts:77` 在 **factory 加载期**调用，违反 bus 不变量 3。
- 覆盖：publish 是浅合并（`bus.ts:154-160`），两个模块各自发布 `{ display: { footer: [line] } }`，后发布的会覆盖先发布的。
- 渲染：core 的 fallback adapter（`ui/fallback.ts`）不读该通道，cctui 也不读。用户只能看到一条启动期 `console.warn`。

### 1.4 footer 槽不会因撤回 presence 自动交接

core 只在 `modes/index.ts:2093` 的 session_start 调用 `installModesFooter`，在场检测仅决定该次是否安装。TUI `/claude-tui off` 在 `claude-code-tui.ts:792-794` 调用 `setFooter(undefined)` 并删除 cc-footer；宿主 pi 1.0.1 的 `interactive-mode.js:1921-1940` 因而恢复内置 footer，没有扩展 footer 栈。presence=false 不等于 core 已持有槽位。

本批维持 off 恢复 stock 的现有语义：此后 stock footer 不显示 `display.footer`，直到 TUI 再启用或后续 session_start 实际安装 core footer。加载期的 console.warn 保留；不增加动态交回 core 的协议或轮询。reload 后 TUI 加载失败时，需要以新的 core session_start 确实安装 footer 为验收，不能只断言 presence 已删除。

### 1.5 契约表缺口（`test/contracts/README.md`）

cctui 实际依赖、但没有登记的面：

1. 通知尾队列与 `__piCcTui.notificationsConsumer` 协商（`ui/notify.ts:26-68`），以及 `snapshot.onChange` 订阅点。P1-BUS-05 只钉了"快照与 legacy key 同步"。
2. bus 实例更换语义（§1.2）。
3. obs_recall 结果协议：cctui 解析两行文本 header（cctui `cc-rows.ts:126-127` ↔ `observation-pack/index.ts:119-122`）。
4. `then_run` 参数形状 `then_run.command`（cctui `claude-code-tui.ts:316`）。
5. cctui `callArgsFor` 依赖的 core 工具名与参数字段（cctui `cc-rows.ts:74-100`）。

另外第 21 行"core 不重注册 CCTUI 已注册的工具"已过时：cctui 自 1.8.0 起改用 `registerToolRenderer`，不再注册工具。

## 2. 决策登记

| # | 决策 | 候选方案 | 选择 | 放弃了什么 | 风险与承担 | 证据 |
|---|---|---|---|---|---|---|
| D4 | `readCoreStatus` 的去留 | A 保留并让类型诚实；B **删除运行时 reader 与 `CoreStatus`，`./types` 改为纯类型导出**；C 连 `./types` 导出一起删 | **待 D4**；B 为提案，未获选定；无 TUI 调用只能证明本地无依赖，不能证明不兼容或授权破坏性删除 | A 的"总读取器"能力（已检索范围未见外部调用）；C 让未来 TS 消费方无类型可用 | 若有未知外部消费方，import 会失败 → CHANGELOG 标为 breaking，发布时至少采用对应破坏性变更的次版本（从当前 0.3.0 可到 0.4.0；本 spec 不授权发布） | §1.1 |
| D4b | 现有测试里的 reader 断言 | A 改为直接读 `coreBus().snapshot()` / `globalThis.__piClaudeCodeCore`；B 删除断言 | **仅选定 D4=B 后采用 A**（断言意图保留，只换读取方式） | — | 断言改动需按契约协议登记 | 5 个测试文件 |
| I2 | 实例标识 | A 快照加纯数据字段 `instance`；B 在 `session_shutdown` 中 publish `{ stale: true }`；C 消费方只比较 `onChange` 函数身份 | **A**（C 作为旧 core 的回退） | B：消费方仍要检测更换，多一个状态 | 无（可选的加性字段） | §1.2 |
| D5 | footer 的归属 | A 改走通知队列；B **footer 槽归谁，谁渲染 `display.footer`**：cctui 实际启用时由 cc-footer 渲染，core modes footer 实际安装时由它渲染；off 恢复 stock，不保证持续显示；C 新增 status 槽 | **B**（用户：footer 以 TUI 为准） | A 的零改动；C 需要扩充 P0-CT-07 槽位契约 | core footer 持槽时多一行；off 后 stock 不显示该通道，见 §1.4 | §1.3、`modes/ui/footer.ts:39-50` |
| F1 | 多来源覆盖 | A 新增字段 `display.footerBySource`；B **保持 `footer: string[]` 形状，统一经一个 helper 按来源合并后整体发布** | **B** | A 是更"结构化"的形状，但多一个契约字段 | 无（形状不变） | `bus.ts:154-160` |
| F2 | 加载期 publish | A 维持；B **降级提示改为在首个 `session_start` handler 中发布** | **B** | 无 | `console.warn` 仍在加载期输出，用于诊断 | 不变量 3 |

## 3. 目标与非目标

**目标**
- 契约表覆盖 cctui 的全部真实依赖面，每行都有消费方与移除条件。
- 快照携带 `instance`，消费方可以可靠检测 bus 更换。
- 分别列出 D4 保留并修正类型 / 删除 reader 的实施条件；未选定前保留现有运行时导出与断言。
- 在 core modes footer 或 cctui 实际显示期间渲染 `display.footer`；多来源不再互相覆盖，发布回到事件处理器内。显式 off 的 stock 例外见 §1.4。

**非目标**
- 不改通知协商的现有行为（`ui/notify.ts`、`ui/fallback.ts` 逻辑零改动）；cctui 侧的修复见配对 spec。
- 不撤 legacy key（P0-CT-01 / 02 的移除条件不变）。
- 不改 bus 快照的发布节奏与冻结纪律。

## 4. 设计

### 4.1 契约表新增与修订（先于任何代码改动）

| 契约 | spec ID | 消费方 | 移除条件 |
|---|---|---|---|
| 通知尾队列 `notifications`（单调 id、cap 20）+ `__piCcTui.notificationsConsumer=true` 时 core 停止 direct forward；**在场声明即所有权交接**：在场期间 fallback 只推进游标、不显示，消费方处理交接后仍保留于队列的条目；cap 20 无 ACK，不承诺任意迟到下零丢失 | XPKG-01 | cctui ≥ 配对 spec 版本 | 通知改由其他通道承载时 |
| `snapshot.onChange` 订阅点（v2，数据携带的注册函数，每个 bus 实例一个） | XPKG-02 | cctui、core fallback | bus 改用其他订阅机制时 |
| `snapshot.instance`：每个 bus 实例的随机标识；同一实例的所有快照相同；`/reload` 后必然不同 | XPKG-03 | cctui core-bus client | — |
| obs_recall 结果：`details { id, offset, bytes, lines, nextOffset, eof }` 为结构化来源；文本首两行 header 为模型协议，显示侧只能作为回退解析 | XPKG-04 | cctui obs_recall 显示 | cctui 不再解析文本时，可删去文本那半句 |
| action-fusion `edit` / `write` 参数可携带 `then_run.command`（字符串） | XPKG-05 | cctui then_run 徽标 | — |
| cctui 按工具名摘要依赖的字段，完整名单见 §4.1a（包括真实 schema 与旧显示别名的区分） | XPKG-06 | cctui callArgsFor | cctui 改为 schema 驱动摘要后撤除（见 cctui P1-1） |
| `display.footer`：string 数组，core modes footer 安装时或 cctui 启用时渲染（含其 native footer 模式的 cc-footer）；显式 off 恢复 stock 后不显示，不存在基于 presence 的自动交回 | XPKG-07 | cctui footer、core modes footer | — |
| 宿主假设：aboveEditor widget 顺序受注册顺序影响；cctui 现有 macrotask 重注册仅为尽力排序，不能保证晚于所有异步 session_start 或后续 core widget 更新。跨包不新增“core 此后不能重注册”的限制 | XPKG-09-HOST | cctui 布局 | pi 提供正式排序 interface 后撤除；未取证时 test.todo 指向本批 TUI P3-1 D5 |
| 修订第 21 行 | — | — | 改写为"cctui 只经 `registerToolRenderer` 换渲染器，不注册任何工具；core 不得依赖 cctui 的渲染接管" |
| 修订 OBS-09-SITES 行 | — | — | 仅在 D4=B 获选并实施删除时删去 reader 子句，注明版本；未选定前保留 |

可执行契约逐条配测试：XPKG-01/02/03/07 放 `test/contracts/bus-cross-package.test.ts`（新文件）；XPKG-04/05 放现有 action-fusion / observation-pack 测试，对形状做编译期或运行期钉住；XPKG-06 在表中列真实 schema 与显示兼容字段；对真实工具注册名/字段做 schema fixture 检查，不能把历史显示别名伪装成生产字段。XPKG-09-HOST 需真实 widget 宿主时序证据，未取得前按协议显式 todo。

### 4.1a XPKG-06 字段清单

以下为 cctui `builtinCallArgs` **实际读取**的字段，不等同于 core 都提供这些参数；实施登记时对照真实 schema，保留别名只作旧结果回放兼容。

| 工具 | 显示侧读取顺序 |
|---|---|
| create_goal / propose_goal_draft | objective / goal / title |
| update_goal | objective / note / status |
| get_goal | 无参数摘要 |
| pause_goal | reason |
| goal_questionnaire | topic / question |
| session_recall | query + since |
| memory_consolidate | operations.length / reason |
| obs_recall | id + offset |
| pi_review_report | mode / scope / base |
| plan_ready | plan / summary |
| step_complete | step / result |
| abort_goal（TUI P1-1 新增） | reason |
| apply_goal_tweak（新增） | changeSummary / newObjective |
| goal_question（新增） | question |

### 4.2 `instance` 字段

- `bus.ts` 的 `createCoreBus()` 生成 `const instance = randomUUID()`（`node:crypto`）。`initialSnapshot(instance)` 与每次 publish 都写入 `instance`；patch 不可覆盖它。创建时仅初始化私有快照，不写 globalThis。dispose 后视为终态，不复用同一实例重启监听；测试 reset 新建 bus。
- `types/index.d.mts` 的 `CoreSnapshot` 增加 `instance?: string`（可选，兼容旧快照），`goal.widget.goal` 补 `costUsed?: number`（当前生产者提供，旧快照允许缺失）；两项不依赖 D4。
- 头注释写明：消费方应以 `instance` 判断是否需要重新订阅；旧 core 没有该字段时，回退比较 `onChange` 函数身份。

### 4.3 `readCoreStatus` 去留（待 D4）

**未选定前：**保留运行时 reader、`CoreStatus`、`package.json` 的 import 导出及 reader 行为测试。§4.1 的 OBS-09-SITES 删除与下列 B 步骤均不能进入默认实施批次。TUI 兼容不要求删除 reader。

**若选 A（保留）：**运行时 reader 继续维持其总函数 / legacy 回退语义；为 `CoreStatus` 单列真实 reader 输出形状，移除从不返回字段的错误承诺，与完整 `CoreSnapshot` 区分。保留并补齐输出键、坏输入、legacy 回退与声明一致性测试；发布说明交代类型收窄的影响。不要顺便让 reader 返回新字段而扩张 API。

**若选 B（删除）：**才执行以下步骤，发布时按破坏性变更说明；本 spec 不授权发布。

1. 删除 `types/core-status.mjs`；从 `types/index.d.mts` 删除 `CoreStatus` 接口与 `readCoreStatus` 声明，保留 `CoreSnapshot` / `CoreCommand` / `CoreCommandResult` / `LegacyPmCapability`。
2. 快照类型缺口按 §4.2 的独立加性修复处理，reader 删除不应阻塞它。
3. `package.json`：`exports["./types"] = { "types": "./types/index.d.mts" }`。
4. `bus.ts:21-23`：去掉 `CoreStatus` 的 import / re-export。
5. 测试迁移（断言意图不变，改为读快照）：
   - `bus-types.test.ts`：删除 reader 的"总函数 / 回退链"用例（被测对象已删除）；保留并强化"`CoreSnapshot` 类型 ⇄ 真实 publish 形状"的孪生守卫，新增 `instance` 字段。
   - `bus-channels.test.ts`、`rules-wiring.test.ts:170-180`、`memory.test.ts:573-585`：`readCoreStatus(globalThis).x` → `coreBus().snapshot().x`。
   - `observation-sites.test.ts` ②：删除第 131-137 行 reader 相关的两条断言（按 §4.1 的契约修订登记）。
6. `test/spikes/types-subpath-spike/`：属一次性 spike，结论已记录在 `RESULT.md`，可整目录删除（本批保留作历史证据，避免无关删除）。
7. 文档：`docs/en/bus.md:28` 与 `docs/zh/bus.md:26` 改为"消费方直接 duck-type 快照，`./types` 只提供形状声明"；`AGENTS.md` / `AGENTS.zh.md` 布局表中的 `types/` 描述同步修改。

### 4.4 `display.footer`

1. `lib/pi-compat.ts`：将降级结果组织为 `{ enabled, warning?, footerLine? }` 数据，真实 warn 由调用方在加载期执行、footer 由事件处理器发布；lib 不导入 extensions。不是把带 console.warn 的函数改名为“纯函数”。
2. 新增 `extensions/ui/footer-lines.ts`：按 CoreBus 实例隔离的 `Map<source, line>`（例如 WeakMap，reset/reload 不沿用旧 bus 的行），提供 `setFooterLine(source, line | undefined)`，每次把 Map 的值按 source 排序后整体发布为 `display.footer`。只能在事件处理器内同步调用，整批发布不得夹 await。重复 source 覆盖自身，不累加；删除最后一行显式发布空数组，不能省略字段而保留旧值。
3. action-fusion / observation-pack：在检测失败后提前 return 之前注册一个 `session_start` handler，在其中调用 `setFooterLine("action-fusion" | "observation-pack", line)`。`console.warn` 保留在加载期。
4. 不增加新 status 槽；footer helper 发布时保留 display 的其他字段。core modes footer（`modes/ui/footer.ts`）：在现有两行之后，追加 `coreBus().snapshot().display?.footer` 的每一行（dim 样式、按宽度截断）。
   - cctui 在场时，modes footer 本来就不安装（`footer.ts:48-49`），由 cctui 渲染（配对 spec）；若 core 先安装，TUI 启用后接管展示。
   - `/claude-tui off` 后由宿主 stock footer 持槽，不再显示本通道；withdraw 只撤在场，不触发 modes footer 安装。两种加载顺序与 reload 失败都验证实际 setFooter / widget 最终状态，不能把布尔 presence 当成交接证据。

### 4.5 不变的部分

`ui/notify.ts`、`ui/fallback.ts` 的协商与跳过规则一行不改；legacy key 推导不变；`__piClaudeCodeCoreCmd` 不变。

## 5. 回归测试

| # | 用例 | 位置 |
|---|---|---|
| B1 | 两个 `createCoreBus()` 的 `instance` 不同；同一 bus 多次 publish 的 `instance` 相同；初始快照已带 `instance` | `test/lib/bus.test.ts` |
| B2 | XPKG-01：在场 + consumer 声明后 notify → fallback 不显示、不 direct forward、游标推进；无在场 → fallback 显示一次 | `test/contracts/bus-cross-package.test.ts` |
| B3 | XPKG-02/03：每个实例的 `onChange` 只通知自己的 listener；旧实例 listener 收不到新实例的 publish | 同上 |
| B4 | footer：两个来源依次 `setFooterLine` → `display.footer` 同时包含两行；`setFooterLine(src, undefined)` 删除该行 | `test/lib/footer-lines.test.ts` |
| B5 | 降级路径：加载期零 publish（spy `coreBus().publish`）；`session_start` 后 footer 含降级行 | `extensions/{action-fusion,observation-pack}/tests/compat-degrade.test.ts`（改写现有断言的触发时机） |
| B6 | modes footer 实际安装时输出含 `display.footer`；在场时跳过安装。联合覆盖 core-first / TUI-first：启用由 cc-footer 显示，off 为 stock 且无 cc-footer / 自动 core 恢复；reload 后 TUI 加载失败但 core session_start 安装成功才由 core 显示 | `extensions/modes/` footer 测试旁 + 配对 TUI C11 |
| B7 | D4 未选：原 reader / exports 断言继续通过；若 A：输出与收窄声明一致、legacy 回退不变；若 B：迁移行为断言，类型导入成功、运行时 reader 明确不再导出 | 类型 fixture / package exports 检查 |
| B8 | reset/reload 后旧 footer 行不泄漏；两来源重复 session_start 不增行；清空后无提示；headless 仅 warn | footer / compat 测试 |

## 6. 实施顺序

1. 契约表登记（§4.1）→ 单独一个 commit。
2. `instance` 字段 + B1 / B3。
3. footer helper + 降级时机 + modes footer + B4–B6 / B8；与 TUI 联合验证真实槽位。
4. D4 未选时保留 reader 并通过既有 B7；选定 A / B 后才另批处理 §4.3 的对应方案与文档。
5. 三绿：`bun run check && bun run test && bun run contracts`。

## 7. 风险与回滚

- **仅 D4=B 实施后 breaking**：`@georgedong32/pi-claude-code-core/types` 不再提供运行时导出。已检索的范围内没有消费方；CHANGELOG 标注，发布时至少采用对应破坏性变更的次版本（从当前 0.3.0 可到 0.4.0；本 spec 不授权发布）。
- 降级提示的显示时机从"加载期"变为"首个 session_start"。非交互模式下仍有 `console.warn`。
- **回滚**：按实际依赖逆序回退；D4 若获选，其 reader 变更独立提交，避免连带回退 instance / footer。

## 8. 台账

- `DEVIATIONS.md`：F1 / F2 的实现形态及 off 的 stock 例外；仅 D4=B 实施后登记 P1-BUS-02 / P1-BUS-07（published total reader）撤除，并附用户决策。
- `CHANGELOG.md` Unreleased：新增 `snapshot.instance`、降级提示在扩展 footer 中可见及 off 例外；reader 类型调整 / breaking 删除仅按最终选定并实施的 D4 方案记录。
- `PROGRESS.md` 批次条目；`docs/{en,zh}/bus.md`、`docs/{en,zh}/ui.md` 同步。
