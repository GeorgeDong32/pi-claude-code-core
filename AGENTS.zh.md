# AGENTS.md — Agent 工作指引(中文版)

> 供参与本仓库的 AI agent(及人类)使用的工作说明。
> English: [AGENTS.md](AGENTS.md) · 架构文档: [docs/](docs/README.md)

## 本仓库是什么

`@georgedong32/pi-claude-code-core` —— [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
的统一核心扩展包。一个 npm 包,经单一扩展入口(`extensions/index.ts`)装配
**十二个模块**:权限模式、effort、goal、review、rules、memory、mcp-gov、
web-gov、action-fusion、observation-pack、能力总线(capability bus)与 UI
适配层。

pi 对每个 manifest 条目只加载一个工厂(见 `package.json` 的 `pi` 字段):
`extensions/index.ts` 的默认导出按固定顺序依次调用各模块工厂,共享同一个
`ExtensionAPI` 实例。

## 常用命令

| 命令 | 作用 |
|---|---|
| `bun install` | 安装依赖(bun 是本仓库的包管理器) |
| `bun run check` | 统一 tsc 门:两遍——主工程(`tsconfig.json`)+ 契约工程(`tsconfig.contracts.json`)。必须 exit 0。 |
| `bun run test` | 单元测试,**按框架分流**:vitest 跑 `test/lib/` + `extensions/modes/`(就近摆放),node:test(经 tsx)跑 `extensions/{effort,goal,review,action-fusion,observation-pack}/tests/` |
| `bun run contracts` | 跨包契约套件(`test/contracts/`,独立 vitest config)。钉住 globalThis 键、env 变量、status 槽、session entry 类型、磁盘布局。 |

三项全绿才算完成。测试一律走 script 入口(`scripts/run-tests.mjs`、
`scripts/check.mjs`),不要直接调 vitest/tsc。

## 仓库布局

```
extensions/
  index.ts           # 装配入口 —— 按序排列的模块工厂流水线
  bus.ts             # 能力总线(globalThis.__piClaudeCodeCore)
  modes/             # 权限模式:ask/plan/auto/bypass(P1)
  effort/            # 思考档位控制:/effort /fast、alt+t(P1)
  goal/              # goal 生命周期 + sisyphus 循环(P2,fork 自 capyup/pi-goal)
  review/            # 扇出代码评审:/review(P2)
  rules/             # 规则注入:/rules(P3)
  memory/            # 双层记忆 + 回溯(P3)
  web-gov/           # webfetch(domain:host) 规则族(P4)
  mcp-gov/           # MCP 规则族 + broker 镜像 + /core 面板(P4)
  action-fusion/     # write/edit + then_run 融合(economy,移植自 SoL-Pi)
  observation-pack/  # 大工具结果投影 + obs_recall(economy)
  ui/                # 呈现适配层:cctui 优先 + core 兜底
lib/                 # 共享原语 —— 禁止反向依赖 extensions/
test/lib/            # lib 与跨模块接线的 vitest 套件
test/contracts/      # 契约套件(见 test/contracts/README.md 契约表)
test/spikes/         # 一次性探针
types/               # 发布的 `./types` 子路径(纯类型:手工维护 .d.mts;运行时 reader 已按 D4=B 撤除)
scripts/             # check.mjs(tsc 门)、run-tests.mjs(按框架测试入口)
docs/                # 架构文档(en/ + zh/ 双语分文件)
```

各模块详见 [docs/zh/](docs/zh) —— 从 [docs/zh/architecture.md](docs/zh/architecture.md) 开始。

## 硬性不变量(不得破坏)

1. **依赖方向**:`lib/` 不 import `extensions/`。需要扩展类型的共享助手用
   结构化类型代替(`lib/rule-text.ts` 刻意自包含)。
2. **思考档位所有权**:`lib/effort-owner.ts` 是 core 中**唯一**允许调用
   `pi.setThinkingLevel` 的位置。优先级链:env 钉死(`PI_CORE_EFFORT`)>
   会话显式选择 > 模式 profile > 模型默认。P1-EF-07 源码扫描对 `extensions/`
   强制执行此规则。
3. **能力总线纪律**(`extensions/bus.ts`):
   - `globalThis.__piClaudeCodeCore` 是**冻结的纯数据快照**——不含函数
     (v2 的数据式 `onChange` 字段除外)。
   - 只在 pi 事件处理器内发布,中间不得有 `await` 断点;整快照替换 +
     单调递增 revision;legacy 键(`__piPermissionModes`、`__pmWorkingStats`)
     在同一同步批次内派生。
   - 无定时器、无轮询。订阅是数据(带版本门控),不是事件系统。
4. **规则族接缝**:治理类规则族经 `modes/rule-families.ts` 的
   `registerRuleFamily` 注册。web-gov 在装配顺序上先于 mcp-gov,URL 类调用
   优先命中域名规则。`mcp-gov/family.ts#canonicalizeMcpTool` 是「是否为
   MCP 形态工具」的唯一权威——复用它,不要重新实现。
5. **上下文预算**(`lib/context-budget.ts`):rules 40K / memory index 25K /
   dynamic steer 8K 字符。生产方必须按此钳制。
6. **契约套件规程**:任何跨包表面变更,先在 `test/contracts/README.md`
   契约表登记(契约 → spec ID → 消费方 → 移除条件),再写测试。跑不通的
   用例用 `test.todo` 并标注去向 Phase 编号——禁止静默丢弃。
7. **冻结表面**:session entry 类型与磁盘布局(P0-CT-08/09)已冻结——不得
   静默破坏既有用户数据。
8. **fail-open 边界**:memory 注入与 observation-pack 投影失败绝不阻塞
   turn(hook 体边界 try/catch、逐消息 fail-open)。economy 模块经
   `lib/pi-compat.ts` 探针自门控,降级只警告、不阻塞会话。
9. **observation-pack 不改历史** —— 只重写 `context` 投影层;transcript、
   TUI 渲染、原生压缩与会话恢复均不受影响。
10. **JSON 设置**一律走 `lib/settings.ts`:读遇到缺失/畸形输入返回 fallback
    (不抛错,`onInvalid` 回调是唯一例外);写是原子的(同目录 tmp + rename)。

## 约定

- **测试框架随来源**:每个模块保留迁移时的框架。新的 lib 级/跨模块套件放
  `test/lib/`(vitest)。同一套件目录内不混框架。
- **缩进用 tab**(与现有代码一致;仓库无 .editorconfig,跟随上下文风格)。
- **文件头注释即文档**:每个模块文件以块注释开头,写明 spec ID 与设计决策。
  改行为时同步更新文件头和 `docs/` 中对应文档。
- **代码注释用英文**;过程文档(`PROGRESS.md`、`DEVIATIONS.md`、
  `OPEN-QUESTIONS.md`)为中文。架构文档双语、按语言分文件存放于 `docs/en/`
  与 `docs/zh/`——修改任一侧时保持两侧同步。
- **偏差台账**:任何偏离 spec(`../specs/`,父工作区)的行为必须记入
  `DEVIATIONS.md`——它是唯一台账。各模块实施状态见 `PROGRESS.md`。
- **Changelog**:用户可见的变更在 `CHANGELOG.md` 对应版本段下补条目。

## 关键环境变量(core 消费)

| 变量 | 模块 | 作用 |
|---|---|---|
| `PI_CORE_EFFORT` | effort | 思考档位硬钉;置位期间显式写入被拒绝 |
| `PI_CORE_MCP_DIRECT_SERVERS` | mcp-gov | 允许认领裸工具名的 server id(如 `exa`) |
| `PERMISSION_MODES_INHERITED_MODE` | modes | 子代理模式继承(pi-subagents 生产,此处只消费) |
| `PERMISSION_MODES_CLASSIFIER_DEBUG` | modes | auto 模式分类器调试日志 |
| `PI_GOAL_AUTO_CONFIRM` | goal | 自动确认 goal 提案 |

`PI_SUBAGENT_*` 系列由 pi-subagents 生产;core 只读取。

## 磁盘落点

| 路径 | 归属 |
|---|---|
| `~/.pi/agent/permission-modes.json` | modes 权限 |
| `~/.pi/agent/core-economy.json` | economy 开关(`actionFusion` / `observationPack`) |
| `~/.pi/agent/pi-core-web.json` | web-gov 预批准域名覆盖 |
| `~/.pi/agent/sessions/permission-modes-forwarding/sessions/<id>/` | 审批转发(pm ↔ pi-subagents) |
| `<cwd>/.pi/goals/` | goal 状态 |
| `<cwd>/.pi/pi-review/`(`pi-review.json`、`runs/<runId>/`) | review |
| `<sessionDir>/observation-pack/<sessionId>/` | observation-pack 原文 |

以上路径由契约套件钉住(P0-CT-09)——视为冻结。

## 遇到阻塞时

停下来问用户。不得私自发明绕过方案、重定义范围,或将未完成的工作标记为完成。
