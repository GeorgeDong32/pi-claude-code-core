# SPEC: update_goal 审计链卡死修复(spec 2026-10-04-goal-audit-hang-fix)

状态:待对抗 review
日期:2026-10-04
分支:main(dev tree `/Users/gd32/Coding/Pi-Extension/pi-claude-code-core`)

## 1. 背景与根因(2026-10-04 事故诊断结论)

事故:session `2026-10-04T06-43-09-595Z`(goal mutjn3wv-vhzoev)中 `update_goal(complete)` 调用于 09:01:41Z 发出后 **40+ 分钟无 toolResult**,主会话永久卡死,Esc 无法中止。

根因链(全部实测证据,无推测环节):

1. `update_goal` execute → `runCompletionAudit`(goal-audit-flow.ts)→ `runGoalCompletionAuditor`(goal-auditor.ts)起**内嵌 in-memory auditor 会话**(模型默认继承 `ctx.model`,本例 CPA/glm-5.3)。
2. auditor 自主发起 bash:`mdfind ...; find /Users/gd32 -maxdepth 5 -name "SPEC-upstream-sync*"`(在 pi-subagents 仓库未找到 spec 文件后扩大到全 home 搜索)。
3. find 进入 `~/Library/CloudStorage/OneDrive-GeorgeDong`(File Provider 虚拟挂载,含 `.Trash`)后 `getattrlistbulk` syscall 无限阻塞(lsof fd 指向 + sample 栈实证)。
4. bash 工具无执行超时,永远等子进程退出;`session.prompt()` **不接收 AbortSignal**(PromptOptions 无此字段;tool signal 只在 prompt 前检查一次),永不 resolve。
5. `runCompletionAudit` 永不返回 → `update_goal` execute 永不返回 → toolResult 永不写回 → 卡死。

排障期关键事实(影响本设计的两点):
- audit 期间 `pi.sendMessage` 排队到 turn 结束才落盘,**ledger(项目 `.pi/goals/goal_events.jsonl`)是唯一实时权威**:本事故 `completion_requested`/`audit_started` 已写而 `audit_result` 缺失,精确锁定卡层。
- 人工 kill 挂死 find 后,auditor 换路径继续并在 ~9 分钟内正常完成(`<approved/>`,goal_completed 09:43:59Z)——证明「卡死」是会话内单工具挂起,auditor 框架本身健康。
- 复现 harness(`repro-goal-auditor.tmp.mts`,真实 createAgentSession + 真实事故 prompt)2/2 red,同卡点同 syscall。

## 2. 目标与非目标

**目标**:update_goal 审计链获得「必然有限时间返回」保证,消灭永久卡死形态。三件套:

- ① audit 总超时:超时按 rejected 语义返回,goal 保持 active,update_goal 必然返回。
- ② signal 接线:tool abort(Esc)能实际中止 auditor 会话。
- ③ auditor prompt 加防扫描约束:禁止全 home / CloudStorage / 网络卷扫描、禁止长驻前台进程。

**非目标(不做)**:
- update_goal 对外工具 schema、参数、description 不变。
- 正常 approved/disapproved 路径语义、auditor 独立只读巡检行为不变。
- 不改 @earendil-works 上游 SDK;不碰 `~/.pi/agent/git` 安装副本;不 push。
- 不做 audit 重试自动化(rejected 后仍由模型/用户决定下一步,现状不变)。

## 3. 设计

### 3.1 ③ prompt 约束(文案定稿)

`buildGoalAuditorPrompt`(goal-auditor.ts)正文第 5 行改为:

```
Use read/grep/find/ls/bash as needed to inspect real artifacts, but stay strictly inside the project working directory (cwd). Never scan the user's home directory, never descend into ~/Library/CloudStorage or any network/automount volume, and never start long-running foreground processes (servers, watchers, repl). Do not mutate files or run destructive commands.
```

Audit checklist 第 2 条改为:

```
2. Inspect artifacts or command output that can prove or disprove those criteria (within the project directory only).
```

`makeAuditorResourceLoader().getSystemPrompt` 追加一行:

```
Stay inside the repository working directory; home-wide or cloud-storage scans hang the machine.
```

理由:prompt 约束是软防线(本次事故模型正是被「inspect real artifacts」引导扫了 home),但成本为零、直接切除最大触发面;硬防线由 ①② 兜底。

### 3.2 ① audit 总超时

**层位:`runCompletionAudit`(flow 层)包总超时**,不放 auditor 层。理由:flow 层是纯编排、已有 `auditor` 注入 seam 可单测;且保护面覆盖任何 auditor 实现(包括未来替换)。

**超时值:默认 600_000ms(10 分钟)**,依据:实测正常 audit 3m17s(2026-10-03 成功案例)、异常救活路径 9 分钟;10 分钟覆盖正常区间,又把事故形态从「无限」压到有界。

**可配置**:goal-auditor.json 新增可选字段 `auditTimeoutMs`(经 `parseGoalAuditorConfig` 解析,clamp 下限 60_000,非法/缺省回落默认)。这是 auditor 配置面扩展,不属于 update_goal 工具 schema。

**语义(硬约束)**:超时 ≠ crash。flow 层 catch 超时后返回 `{ verdict: "rejected", rejectionText }`,文案以 `Goal audit timed out after <N>s. The goal remains active.` 开头,附 auditor 部分输出(如有)。复用现有 rejected 路径 → goal 保持 active、`auditAttempts` 已在 execute 侧 ++(自然抑制无限重试)、UI 事件 `phase: "rejected"`、ledger 写 `audit_result`(verdict `"error"`)。用户可再调 update_goal 重试。

**实现形态**(伪码):

```ts
// goal-audit-flow.ts
export const DEFAULT_AUDIT_TIMEOUT_MS = 600_000;
// CompletionAuditArgs 增加: timeoutMs?: number; controller 由 flow 内部创建
const timeoutMs = args.timeoutMs ?? DEFAULT_AUDIT_TIMEOUT_MS;
const controller = new AbortController();
// tool signal → controller(用户 Esc)
args.signal?.addEventListener("abort", () => controller.abort(...), { once: true });
const timer = setTimeout(() => controller.abort(...), timeoutMs); // unref 不适用:必须活着触发
// race 参与者的 unhandled rejection 防护:
//   aborted promise 在「auditor 先落定」时会保持 pending 或之后 reject,
//   auditor promise 在「abort branch 先落定」后仍会继续跑完并可能 reject。
//   两者都必须在 race 落定后挂 noop catch,否则 Node 进程级 unhandledRejection。
const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(abortErr); });
const auditorPromise = (args.auditor ?? runGoalCompletionAuditor)({ ..., signal: controller.signal });
auditorPromise.catch(() => {}); // noop attach 不改变 race 结果,仅防 unhandled
aborted.catch(() => {});        // 同上(在 race 落定后 attach 亦可,直接 attach 更简单)
try {
  const auditor = await Promise.race([auditorPromise, aborted]);
  ...现有 verdict 逻辑...
} catch (err) {
  if (超时) return rejected outcome("timed out after ...");
  if (tool abort) return rejected outcome("aborted by user; the goal remains active.");
  throw err; // 其他真错误维持抛出
} finally {
  clearTimeout(timer);
  args.signal?.removeEventListener("abort", ...);
}
```

**注意**:此 setTimeout 有意不 unref(它是功能本体);race 落定后 clearTimeout 保证无悬挂定时器。

### 3.3 ② signal 接线(session.abort 方案)

pi 1.0.1 `PromptOptions` 无 signal 字段(已核);`AgentSession` 提供 `abort(): Promise<void>` 与 `dispose(): void`(已核)。**abort() 后 prompt() 的 settle 行为已在实现层核实**(agent-session.js `_runAgentPrompt`:run loop 检查 `_agentRunAbortRequested` 后 break,finally 清理并 `_emitAgentSettled()`,**prompt promise 正常 resolve,不 reject、不悬挂**)。接线方式(goal-auditor.ts `runGoalCompletionAuditor` 内):

```ts
const onAbort = () => { void session.abort().catch(() => {}); };
args.signal?.addEventListener("abort", onAbort, { once: true });
try {
  await session.prompt(...);
} finally {
  args.signal?.removeEventListener("abort", onAbort);
  session.dispose(); // prompt 已 settle(abort 内部 waitForIdle)后执行,idle 状态 dispose 安全
}
```

- prompt() 在 abort 后 resolve → 无 reject 路径 → 无 unhandled rejection;flow 层 race 的 abort 分支先行落定 rejected 结果,auditor 层 resolve 值被幂等忽略。
- `session.dispose()` 放 finally:异常/中止路径都释放内嵌会话资源(现状无 dispose,属泄漏修补,不改语义);因 abort() 自身 await waitForIdle,finally 时会话已 idle。
- 前置检查保留:`args.signal?.aborted` 时直接返回 aborted 结果,不起会话。

### 3.4 ④ bash 工具执行超时(调研结论:不做)

已核实 pi 1.0.1 `core/tools/bash.d.ts`:`BashToolOptions = { operations?, commandPrefix?, shellPath?, exposeSessionEnvironment?, spawnHook? }` —— **没有默认/上限 timeout 注入点**;schema 里的 `timeout` 是模型每调用自传的参数(模型不会给自己设上限,对防挂死无效)。要注入默认超时只能自定义 `BashOperations` wrapper 重写 exec,改动面与风险超出「顺手则做」边界。**裁决:不做**;① 的 10 分钟总超时已兜底(事故形态从无限压到有界,损失仅为一次可重试的 rejected)。

### 3.5 harness 处置:删除 + 留档

`repro-goal-auditor.tmp.mts`(及 `/tmp/repro-objective.txt`、`/tmp/repro-completion-summary.txt`、`/tmp/goal-auditor-repro.mts`)**删除**。理由:其复现力依赖真实 OneDrive 挂死环境,无法进 CI 稳定运行;「必然有限时间返回」语义由 3.6 的单元回归覆盖(挂死 fake auditor,无环境依赖)。根因复现方法以本 spec §1 为档。

## 4. 回归测试设计(红→绿,先行)

测试基建:node:test + node:assert(仓库惯例),基线 447 tests / 0 fail、`npm run check` OK(2026-10-04 实测)。

### 4.1 goal-audit-flow.test.ts(核心回归)

1. **audit timeout rejects(红→绿主测试)**:`timeoutMs: 50` + fake auditor 返回永不 resolve 的 promise(内部 `signal.addEventListener("abort")` 记录)→ 断言:outcome `verdict === "rejected"`;rejectionText 含 "timed out";fake auditor 收到的 signal 最终 aborted(超时传播停会话);sendAuditEvent 最后一次 `phase === "rejected"`;ledger `audit_result` 写入且 verdict `"error"`。
   - 红形态(已核实测试基建为 node:test + type stripping,无类型检查):实施前 `timeoutMs` 被 flow 忽略 → race 永不落定 → 断言超时;因此 test() 必须带显式 `timeout`(如 2000ms)让「挂死」表现为测试超时红,而非整个进程卡死。
2. **user abort rejects**:tool signal 中途 abort → rejected + 文案含 "aborted",goal 保持 active 语义(不触碰 stopActiveGoal,以 outcome 断言)。
3. **正常路径回归**:现有 auditor() factory 三个用例不破(approved/disapproved/spawn-failed)。
4. **timeoutMs 传播**:fake auditor 收到的 signal ≠ tool signal(是 flow 内部 controller 的),且 tool abort 后该 signal 跟随 abort。

### 4.2 goal-auditor.test.ts

1. `buildGoalAuditorPrompt` 输出包含防扫描关键词(project directory / CloudStorage / long-running foreground)。
2. `makeAuditorResourceLoader().getSystemPrompt()` 含限定语(需将该工厂导出——现状模块内私有,导出属测试可见性调整,不改行为)。
3. `parseGoalAuditorConfig` 接受 `auditTimeoutMs`(数字、clamp 下限 60_000、非法值回落默认)。

### 4.3 手工验证(单测覆盖不到的)

- 真机:重启 pi 后人工跑一次带 goal 的 update_goal(或等下次真实关账),观察正常 audit 行为不变;证据留本 spec §8。
- Esc 中止:长 audit 期间按 Esc,确认 update_goal 在有限时间返回 rejected 文案(可结合 3.2 的 timeoutMs 调小在测试机自测)。

## 5. 实施顺序

1. §4.1/4.2 测试先行(看红)
2. goal-audit-flow.ts:超时 + signal 组合 controller + rejected 语义
3. goal-auditor.ts:prompt 文案(§3.1)、session.abort 接线 + dispose、parseGoalAuditorConfig 扩展、导出 makeAuditorResourceLoader
4. goal.ts:update_goal execute 处读 config `auditTimeoutMs` 传入 flow;确认无其他调用点遗漏(grep runCompletionAudit)
5. ④ bash timeout(按 §3.4 判定)
6. 全量 `npm test` + `npm run check`
7. harness/临时文件清理(§3.5)
8. CHANGELOG(## Unreleased 新增条目,spec 标注 `2026-10-04-goal-audit-hang-fix`)

## 6. 验证门禁

- [ ] §4 新测试先红后绿;全量 npm test 0 fail(基线 447 + 新增)
- [ ] npm run check OK
- [ ] 无 update_goal 工具 schema/description diff
- [ ] 正常路径语义回归:现有 audit-flow 测试全绿
- [ ] ledger/UI/文案:超时路径走 rejected 现有渲染,无新增 UI 组件
- [ ] CHANGELOG 条目与实际 diff 相符

## 7. 风险与回滚

- **超时误杀慢 audit**:10 分钟 > 实测正常上限 9 分钟;真被误杀代价 = rejected + 可重试,无数据损失。可通过 config 调大。
- **abort() 后 prompt promise 行为**:已核实为正常 resolve(agent-session.js 实现层,见 §3.3),无 unhandled rejection;race 参与者的双 noop-catch 防护(§3.2)覆盖剩余边界。
- **controller 泄漏**(listener 未移除):finally 统一清理,review 重点。
- **audit 进行中的其他 goal 操作**(/goal-pause、/goal-tweak、session 切换):行为与现状完全一致(本修复只加超时与中止,不触碰这些路径)。
- 回滚:单 commit,`git revert` 即可;config 新字段向后兼容(旧记录无此字段=默认值)。

## 8. 真机观察记录

(实施完成后补:日期、goal、audit 耗时、结果。)

## 9. 对抗 review 记录(流程②)

**通道变更**:原定 pi-subagents `reviewer`(flash 高思考)通道在本 pi 运行时启动即崩(`scopedModelIdsFromContext is not a function`,前台/后台 3 次复现;源码/模块导出/jiti 直载均验证正常,属独立环境级 bug)。经用户拍板:由主线程执行同攻击面的对抗自查(2026-10-04)。

自查 findings 与处置(全部采纳):

- [R1-P2] §3.2 race 参与者 unhandled rejection:auditor promise 在 abort branch 先落定后仍会继续跑完并可能 reject;aborted promise 在 auditor 先落定后可能保持 pending/reject → 实施终态:auditor promise 直接挂 noop catch(neverAborted 由 race 内部 handler 覆盖),比 spec 伪码更精确、行为一致。
- [R2-P2] §3.3 原文「abort 后 prompt 预期 reject/resolve 其一」是未验证假设 → 已在实现层核实为 resolve(agent-session.js `_runAgentPrompt` run loop + finally `_emitAgentSettled`),spec 改为实测结论。
- [R3-P2] §3.4 原判「④ 可行性高」错误:`BashToolOptions` 无 timeout 注入点(逐字段核实)→ 裁决改为「不做」,调研结论留档。
- [R4-P2] §4.1 「红」形态需精确化:本仓测试基建无类型检查,实施前红 = race 永不落定 → 必须 test() 显式 timeout,已写入。
- [R5-P3] audit 中其他 goal 操作行为不变的边界声明,补入 §7。
- [R6-P3] dispose 时序:abort() 内部 waitForIdle,finally 时会话已 idle,dispose 安全,已写入 §3.3。

裁决:**ACCEPT(修订后)**——P1 无;R1-R4 已修订进 spec 正文,进入实施(流程③)。

**code-review 对抗(流程④,用户改定主线程自查,封顶 2 轮)**:

- 第 1 轮 findings(全部处置):[CR1-P2] flow 层无意义 `.catch(e => { throw e })` 改为 auditor promise 直挂 noop catch(防 unhandled 真正生效);[CR3-P3] 去掉多余 as 断言的理由注释化;[CR5-P3] export 语句移出 import 块;[CR10-P3] repl → REPLs;[CR12-P3] auditorSettingsLines 增加 audit_timeout_ms 回显行。
- 第 2 轮(终轮):门禁清单逐项核对通过;边界复查(前置 abort 同步落定、clamp 边界、rejected 消费路径、auditAttempts 语义、dispose/abort 竞争)无新 P1/P2。收尾。
