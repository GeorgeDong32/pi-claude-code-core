# 批次二实施 Spec：B5 effort 写入期钳制 + B6 willRetry 契约钉 + B8 路径匹配审计与口径

状态：spec 对抗审稿（flash，1 轮）· 上游方案：docs/{en,zh}/cherry-derived-hardening-spec.md
§B5/B6/B8 · 2026-10-20 · 侦察修正已并入（见 §0）

---

## 0. 侦察修正（与上游草案的三处偏差，以本 spec 为准）

1. **B5 缺口收窄**：effort 的命令路径（/effort 与 --effort flag，index.ts:76-86/
   247-258）**已有**支持集校验——但是**拒绝式**（error 通知 + 不写入），goal 要求
   **钳制式**（钳最近支持档 + 状态行提示）。**profile 路径零校验**
   （profile-apply.ts:146 `setFromProfile` 直写，PROFILE_EFFORT_LEVELS 只查语法）。
2. **B6 前提修正**：devDeps pi-coding-agent 1.2.0 的 **AgentEndEvent 无 willRetry
   字段**（types.d.ts:748-751 只有 messages）；willRetry 存在于**压缩三事件**
   （session_before_compact/session_compact/session_compact_failed，语义 =
   「overflow recovery 将重试被中止的 turn」）。Cherry 消费的 agent_end.willRetry
   是其自建 driver 层合成或版本差异——我们按 1.2.0 事实钉。
3. **B8 前提修正**（R1 P1-2：「词法=保守」的全称断言对两个具名消费点
   不成立）：modes 主边界 `isOutsideCwd`（path-safety.ts:28-60）**已有**
   realpath 逐级 symlink 逃逸探测。上游草案的「scopeMatches 升级」实际
   落在 `lib/rule-text.ts isInsideDir`（纯词法）与 `memdir scopeMatches`
   （纯 glob）——消费点按**方向**分野：
   - `guard.ts:63-64` 层判定：inside → 更多检查——词法在此真保守 ✓
     （保持词法）。
   - `protected-paths.ts:95`（G1-C4）：inside → 拦截——alias symlink
     **绕过拦截**（miss=放行）。realpath 只会收紧。
   - `paths.ts:126 isMemoryWritePath` → modes carve-out（index.ts:389）：
     inside → **跳过审批对话框**——symlink alias 物理指向外部即
     fail-open 方向的逃逸（R1 P1-2 的头条）。这是唯一 realpath 升级
     真正堵洞的消费点。
   - `memdir scopeMatches`：召回过滤，miss → 隐藏——convenience ✓。
   B8 定性：逐消费点审计表（方向如实）+ write-root carve-out **一处
   realpath 收紧** + 真保守处保守性钉 + 口径文案。

---

## B5 · effort 写入期钳制（profile 路径补校验 + 命令路径拒绝式改钳制式）

### 纯函数（effort.ts，深模块：两路共用一个钳制语义）

```ts
export function clampToSupported(
  level: EffortLevel, model: EffortModel | null | undefined,
): { level: EffortLevel; clamped: boolean };
```

- `off` 恒合法（既有结论）；`level ∈ getAvailableThinkingLevels(model)` →
  原样返回；否则钳到**序最近的合法档**（序 = off/minimal/low/medium/high/
  xhigh/max 的 ladder 顺序；距两侧等远取低侧——更低档多花的是 token 少、
  翻车面小，保守方向）。模型不可解析（null/undefined）→ 返回
  **undefined**（不透传）：调用方保持现状的拒绝——今天 null model 下
  `/effort high` 被拒，钳制式不得放宽它（R1 P2-1）。没有模型就没有
  最近档可算；「推迟到首个模型选定」是静默行为变化，不取。
- **删除测试**：删掉后 profile 与命令两路各自重写「最近档」逻辑——通过。

### 接线

| 路径 | 现状 | 改为 |
|---|---|---|
| profile-apply `applyForMode` | `setFromProfile(effort)` 直写 | clamp 后写 + notify「profile X 的 effort Y 不被 <model> 支持，已钳到 Z」（info 级——profile 切换是常规操作不该弹 error） |
| /effort 命令（index.ts:76） | 拒绝式 error | 模型可解析时钳制式：写钳定值 + notify「Y 不支持，已设为 Z；可选：…」；null model 保持拒绝 |
| --effort flag（index.ts:249） | 拒绝式 warning | 同上（startup flag 同语义） |

- effort-owner（不变量 2 唯一写入点）**零改动**——支持集校验是调用方职责，
  owner 继续只管优先级链。env pin 路径不钳（pin 本身就是「用户显式声明」，
  且 pin 拒绝显式写入的语义已存在）。

### 测试（extensions/effort 既有 node:test 套件追加）

| # | 用例 | 断言 |
|---|---|---|
| B5-1 | clampToSupported 表驱动（支持档原样/off 恒过/单档模型钳制/等距取低/null 原样） | 六分支 |
| B5-2 | profile：单档模型 + profile=medium | 写入钳定档 + info 通知含「已钳到」 |
| B5-3 | /effort 命令：不支持档 | 写入钳定档 + 通知含候选列表 |
| B5-4 | 支持档命令 | 直写零通知（现状不回归） |

---

## B6 · willRetry 契约钉 + 激活评估记录（守卫按 R1 P1-1/P2-3 撤下）

### 契约（pi-host-semantics 追加，先登记 README 表 CB2-B6）

1. **编译期类型钉**：`AgentEndEvent` 当前无 willRetry——钉成
   **编译期断言**（不是对自建 sample 的运行时 `in` 探测——那永远探不到
   类型层新增）：
   ```ts
   type AgentEndHasWillRetry = "willRetry" extends keyof AgentEndEvent ? true : false;
   const _pinAgentEndHasNoWillRetry: false = null as unknown as AgentEndHasWillRetry;
   ```
   红灯亮在 `bun run check` 的契约 tsc pass（vitest/esbuild 不做类型
   检查——运行时套件保持绿）。
2. **压缩事件在场钉**：三个压缩事件带 willRetry 且语义为 overflow
   recovery 重试（运行时可查——import 事件类型断言声明形状上字段存在）。

### 守卫落点——撤下（R1 findings）

- 上游草案的「review 侧」落点**不存在**（extensions/review 无 agent_end
  handler；唯一 review 相邻消费点 memory/automation.ts:536 天然幂等——
  计数器 pass 前清零，retry 的 agent_end 时 reviewDue 已 false）。
  agent_end 全消费点（5 处）：effort/index.ts:294（UI 同步）、
  goal/goal.ts:2130（记账——**刻意**结算 aborted in-flight 消耗
  「not silently lost」；跳过 willRetry 事件反而**漏记**真实消耗、
  是反向失败）、modes/index.ts:1468（idle reset——真正的激活评估
  问题）、memory/automation.ts:536（幂等）、memory/index.ts:546。
- 因此：**本批不发内联守卫**。契约钉住字段缺失；红灯（上游引入字段）
  触发记录在案的**激活评估**——逐消费点回答「其终态结算是否并入
  pre-retry 碎片？」（goal：先证明再抑制；modes idle-reset：retry
  pending 的 agent_end 会不会假性恢复 UI？）——评估说 yes 的地方才落守卫。

## B8 · 路径匹配审计：逐消费点方向 + 一处 realpath 收紧 + 口径文案

### 审计结论（逐消费点——方向如实）

| 消费点 | isInsideDir 判定 → 效果 | 词法 miss 的方向 | 处置 |
|---|---|---|---|
| `modes isOutsideCwd`（主边界） | 已有逐段 realpath 探测 | — | 不动 |
| `guard.ts:63-64` 层判定 | inside → 更多检查 | 更严分支 ✓ 真保守 | 保持词法 + 保守性钉 |
| `paths.ts:126 isMemoryWritePath` → modes carve-out（index.ts:389） | inside → 跳过审批对话框 | **fail-open 方向的逃逸**（symlink alias 物理指向外部仍享受 memory carve-out） | **此处 realpath 收紧**——词法 pass 后再 realpath 解析写入路径、要求仍在某 write root 内；miss 回落常规审批路径（fail-closed） |
| `protected-paths.ts:95`（G1-C4 自改拦截） | inside → 拦截 | alias 绕过 = 漏拦（放行）——realpath 只会收紧 | 本批保持词法 + 记录 alias 绕过注记（硬编码常量表；绕过需用户自建 symlink 指向自己 memory 目录——弱攻击面；随 G1 证据再评估） |
| `memdir scopeMatches` | 召回过滤，miss → 隐藏 | convenience ✓ | 保持 + 注释 |

### 口径文案（「convenience, not containment」）

- 落 `docs/{en,zh}/modes.md` 权限节：allowlist/路径匹配是**便利层而非
  沙箱**——主边界带 symlink 逃逸探测、memory write-root carve-out 本批
  realpath 收紧，但 memory scoping（paths 字段）是召回过滤不是访问控制；
  任何安全决策不得建立在 paths scoping 之上。
- 钉：guard.ts 词法保守性测试；realpath 收紧自带测试（alias-inside →
  不 carve-out；real-inside → carve-out；realpath 不可解析 → 审批路径）。

## 测试矩阵汇总

| # | 用例 | 断言 |
|---|---|---|
| B5-1..4 | 见 §B5 | 钳制语义 + 两路接线 |
| B6-C1 | 编译期类型钉（keyof-extends） | 字段到达时只在 check 契约 tsc pass 变红 |
| B6-C2 | 压缩事件带 willRetry | 三个声明形状上字段在场 |
| B8-1 | guard.ts 层判定：symlink 形态路径 | 词法 outside → 更严分支（由既有 G1-C2/C3 用例覆盖——test/lib/memory-guard-g1.test.ts，无需新测试；记录在案） |
| B8-2 | isMemoryWritePath realpath 收紧：alias-inside（symlink 指向 write root 外） | 不 carve-out → 审批路径（fail-closed） |
| B8-3 | realpath 收紧：real-inside / 不可解析 | carve-out / 审批路径 |
| B8-4 | docs 口径文案 | 关键词锚（"not a sandbox"/不是沙箱）双语两份在场 |

## 门槛与流程

三门禁 exit 0（contracts：基线 47 passed + 4 todo → CB2-B6 两条登记后 49 passed + 4 todo）；台账
DEVIATIONS 中文；CHANGELOG 随文件既有语言（英文）；双语 docs 同步；提交推送（SSH 失败走
https+代理旁路——本次批次一已遇 fake-IP TUN 拦截）；双机部署副本同步。
审查轮数：spec ≤1、code ≤2。
