# SPEC FX — 回测加固后续小修（2026-11-14）

来源：BH 批完成后用户提出的第 4 类小修。三项检查对应 BH spec 第 47 行的三个非目标；E5 边界与 review-degradation 红项为 BH 批的已知遗留。批准决策 D-FX-1…4 见下。

## 用户决策（2026-11-14）

- **D-FX-1**：F1 采用「测试隔离 + fetch 时限」。
- **D-FX-2**：E5 边界选 **方案 B**——识别所有宿主切模型途径，宿主重置只记录不当用户选择，切换后恢复用户设置。
- **D-FX-3**：三项检查全部纳入本批；SC 评估现在做，用户授权只读 ssh 到 Air（100.88.88.3）。
- **D-FX-4**：spec 写入后直接派工，不等再确认。
- 沿用 **D-BH-4**：只在本地提交，不 push、不发版、不安装。

---

## FX-1 review-degradation 测试红 + 本地 fetch 时限（W-R）

**根因**

- `test/lib/review-degradation.test.ts` 三个用例把真实仓库目录（`process.cwd()`）当作 /review 的 cwd。工作区干净时，`acquireLocalDiff`（review-run.ts:337）会执行 `git fetch origin main`，本机实测 5.7 s > vitest 5 s 用例上限（DEVIATIONS #131 / BH-10，有网也超）。
- `defaultRunCmd`（run-cmd.ts:47）spawn 无超时：网络卡住或 git 等待凭据输入时 /review 无限等待。
- fetch 失败本就不中断流程：回退本地 `origin/<base>` 并记「可能过期」warning（review-run.ts:338-348）。因此给 fetch 加时间上限语义安全。

**设计**

- `run-cmd.ts`：`RunCmd` opts 增加两个可选字段：
  - `timeoutMs`：超时 kill 子进程，按非零 exitCode 返回，stderr 注明 timed out；
  - `env`：与 `process.env` 合并。
  - 不传时行为不变；注入 fake 的签名保持兼容（可选字段）。
- `acquireLocalDiff` 的 base fetch（review-run.ts:337）：
  - 命名常量 `LOCAL_BASE_FETCH_TIMEOUT_MS = 15_000`；不可配置，不新增 env/设置键（INV-10）。
  - `env: { GIT_TERMINAL_PROMPT: "0" }`。
  - 超时与失败走同一条既有非致命路径；warning 文案区分 "timed out" / "failed"。
- PR 路径（target-workspace clone、PR head fetch、`gh pr diff`）本项不改，交给 FX-5 审查判断。
- `review-degradation.test.ts` 三用例：
  - cwd 改用 `mkdtempSync(tmpdir())` 隔离目录，afterEach 清理；
  - `setRunCmd` 注入包装真实 defaultRunCmd 的 spy，断言用例过程中不执行 `git fetch`；`finally` 中 `resetRunCmd()`（run-cmd.ts 测试纪律）。

**验收**

- base 上的红证据：spy 证实用例过程触发 `git fetch`（或干净树下超时）。
- run-cmd 超时单测：`sleep 10` + 200 ms 时限 → 2 s 内非零返回、stderr 含 timed out。
- fetch 超时 → warning 路径单测。
- 不传 `timeoutMs` 的既有用例全部通过（行为不变回归）。
- **`bun run test` 零失败（关闭 BH-10）。**

## FX-2 E5 边界：覆盖所有宿主切换模型的途径（W-E，方案 B）

**宿主事实（pi 1.5.2，agent-session.js）**

- `setModel`（:2110）、`_cycleScopedModel`（:2154）、`_cycleAvailableModel`（:2180）同一顺序：先 `agent.state.model = 新模型` → `setThinkingLevel(模型切换默认)`（同步 emit `thinking_level_select`，:2220-2228）→ `await _emitModelSelect(...)`（`model_select`）。
- runner 的 `ctx.model` 是实时值（createContext getModel 直读当前 state）。
- 已安装三包中只有 core effort 模块注册 `thinking_level_select`（pi-subagents 与 TUI 只监听 `model_select`），故 tls 在 setThinkingLevel 内同步执行，顺序确定。

**当前症状**

- 用户经 `/model` 或 ctrl+p 切换模型：宿主重置被 effort 监听器（extensions/effort/index.ts:227）按「外部变化」采纳为显式（source session），覆盖 /effort 选择。
- 本会话内 profile `:effort` 失效，直到 `/effort reset`（BH-E5 同款病灶，触发源不同）。
- `PI_CORE_EFFORT` 固定时实际等级偏离固定值。

**设计**

- **识别**：
  - effort 维护 `switchBaselineKey`（provider/id），在 session_start、model_select、agent_start、turn_start 更新；
  - tls 处理器签名改 `(event, ctx)`。`owner.inModelSwitch()`，或 baseline 与实时 `ctx.model` 均存在且不相等 → 判定宿主切换，走 `noteModelSwitchLevel`，不写显式槽。
- **恢复**：
  - `model_select` 在不处于 BH-E5 窗口、且前后模型不同时，调用新增 owner 方法 `afterHostModelSwitch()`：
    1. 清 profile 槽（与 BH-E5 语义一致，下次模式切换 profile 重新应用）；
    2. `apply()` 恢复 env 固定值或显式选择——仍只有 owner 调 `setThinkingLevel`（P1-EF-07 不变），新模型不支持时宿主钳制；
    3. 同步 UI + bus 发布。
- **退化**：外部扩展若抢先注册 tls（model_select 先到），识别失效，行为等同今天。单测固定 + 文档记录。

**验收**（真实 AgentSession harness，extensions/effort/tests/integration.test.ts 模式）

前 3 条 base 上先红：

1. `/effort high` 后 `cycleModel`/`setModel`（非 profile 触发）→ 等级回到 high（或宿主降级值），source 为 session；
2. 手动切模型后，下一次模式切换 profile `:effort` 仍生效；
3. 设 env 固定值后手动切模型 → 等级回到固定值。

防误判（base 与修复后都绿）：

4. 不切模型，用户 `cycleThinkingLevel` 仍采纳为显式；
5. 手动切模型但等级未变（无 thinking 事件），随后用户 cycle 仍采纳为显式。

另：6. 退化顺序单测（fake pi 中 model_select 先于 tls，行为等同今天）；BH-E5 ①–④、modes 套件、P1-EF-07 源码扫描全绿；lib 不新增 extensions 导入；docs/{en,zh}/effort.md 同步。

## FX-3 memory 索引 25K 核实（W-M）

**已有证据**

- writer 落盘按 25K 截断（writer.ts:161）；
- 注入按 lane 预算截断（policy.ts:183）；
- `memory-v2-storage` 已钉注入 ≤ MEMORY_INDEX_MAX；
- 本机最大项目索引 20,500 bytes < 25K。
- 剩余风险：模型执行整理时直接编辑 MEMORY.md 绕过 writer。

**任务**

- 新增 vitest 用例：绕过 writer 直写 >25K 的 MEMORY.md，验证 ① 注入段 ≤ lane 预算；② `needsConsolidation` 返回 `index N/25000 bytes`；③ turn_end ConsolidationTrigger 发整理指令。已有覆盖点引用不重写。
- 只读采集本机与 Air 各层 MEMORY.md **字节数**（不读内容）。
- 结论写入 PROGRESS（本条由 orchestrator 台账统一落）。
- 发现真实缺陷 → 先失败测试再最小修；超出 memory/ 范围即上报。

## FX-4 SC 默认开启后的效果评估（W-M，只报告不改代码）

- **评估标准**：用户 O2 发布标准（长对话稳定性/可靠性、压缩效果、时间节约）；接管率按 SC-6 公式，M1 仅参考。
- **取数**：本机 + Air（只读 ssh）2026-11-11 后含 `cc-core-compaction*` 遥测的会话 JSONL；复制到仓库外私有临时目录，不入库，评估后删除；只输出计数/时长，不打印会话正文。本机现状：ST-01 34 条（4 文件），metrics 2 条（1 文件）。
- **分析**：`scripts/compaction-metrics.mjs`（必要时加 replay）：接管率、阈值兜底次数、discarded/overridden 原因分布、自动降级 shadow 次数、computeMs、estPostTokens；有原因码则裁决 SC-1 的 3 次未归因遗漏。
- **产出**：docs/{en,zh}/compaction.md 新增「默认开启后实测（2026-11-14）」节；DEVIATIONS SC-1 未关闭项更新（本条由 orchestrator 台账统一落）；样本不足如实写「数据不足」+计数，不外推；发现缺陷列入下一轮。

## FX-5 review/ 模块深度审查（W-R，FX-1 完成后）

- 范围：extensions/review/ src + tests（约 7,000 行）。
- 只读审查 → 仓库根 `REVIEW-2026-11-14-review-module.md`；每条发现 file:line + 证据 + P0–P3 严重度。
- 修复规则：确认的 P0/P1 本批修，先 base 失败测试再修；P2/P3 列入下一轮。
- 熔断：P0/P1 >5 条，或修复需动契约面/跨模块 → 停止上报，不扩面。

---

## 派工与收尾

| worker | 项 | 文件归属 |
|---|---|---|
| W-R | FX-1 → FX-5 | extensions/review/**、test/lib/review-*.test.ts、REVIEW-2026-11-14-review-module.md、docs/{en,zh}/review.md |
| W-E | FX-2 | lib/effort-owner.ts、extensions/effort/**、modes/profile-apply.ts 与 modes/index.test.ts（仅必要时）、docs/{en,zh}/effort.md |
| W-M | FX-3 + FX-4 | test/lib/memory-*.test.ts（新增）、extensions/memory/**（仅修缺陷时）、docs/{en,zh}/{compaction,memory}.md |

- worker 不改 CHANGELOG/DEVIATIONS/PROGRESS/spec/README，只在最终报告附台账草稿。
- 每分支独立只读审查；子 agent 不可用时 orchestrator 亲审。
- 合入顺序 W-M → W-E → W-R，rebase + ff 线性。
- 合入后 main 跑 `bun run check/test/contracts` + 金丝雀；**期望 test 零失败**。
- 台账：CHANGELOG Unreleased（Fixed：FX-1、FX-2）；DEVIATIONS 新增「小修批（SPEC FX）」节（FX-1…），关闭 BH-10 与 BH spec 非目标三项；PROGRESS 同日节；spec/README 状态。
- 收尾：删 worktree/分支/私有临时数据。只本地提交。
