# AGENTS.md — Agent 工作指引(中文版)

> 供参与本仓库的 AI agent(及人类)使用的工作说明。
> English: [AGENTS.md](AGENTS.md) · 架构文档: [docs/](docs/README.md)

## 本仓库是什么

`@georgedong32/pi-claude-code-core` —— [pi coding agent](https://github.com/earendil-works/pi-coding-agent)
的统一核心扩展包。一个 npm 包,经单一扩展入口(`extensions/index.ts`)装配
**十四个模块**:权限模式、effort、goal、review、rules、memory、mcp-gov、
web-gov、action-fusion、observation-pack、bg-shell、能力总线、智能压缩控制器
(compaction)与 UI 适配层。

pi 对每个 manifest 条目只加载一个工厂(见 `package.json` 的 `pi` 字段):
`extensions/index.ts` 的默认导出按固定顺序依次调用各模块工厂,共享同一个
`ExtensionAPI` 实例。

## 常用命令

- `pnpm install` —— 安装依赖(pnpm 是本仓库的包管理器)。
- `pnpm run check` —— lint + 两遍 tsc(主工程与契约工程)。
- `pnpm run test` —— 单元测试,按框架分流:vitest 跑 `test/lib/` 与 `extensions/modes/`(就近摆放),node:test(经 tsx)跑 `extensions/{effort,goal,review,action-fusion,observation-pack,bg-shell,compaction}/tests/`。
- `pnpm run contracts` —— 跨包契约套件(`test/contracts/`)。

**三项门禁全绿(exit 0)才算完成。** 测试一律走 script 入口(`scripts/run-tests.mjs`、
`scripts/check.mjs`),不要直接调 vitest/tsc。升 Pi 之前先跑升级金丝雀:
`pnpm exec vitest run test/lib/upgrade-canary.test.ts --config vitest.config.ts`。

## 仓库布局

`extensions/` 下每个模块一个目录,装配顺序见 `extensions/index.ts`。共享原语在
`lib/`,vitest 套件在 `test/lib/`,契约套件在 `test/contracts/`(其 `README.md`
即契约表),发布的类型在 `types/`,各模块架构文档在 `docs/en/` 与 `docs/zh/`。
从 [docs/zh/architecture.md](docs/zh/architecture.md) 开始。

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
   MCP 形态工具」的唯一权威——复用它,不要重新实现。其纯形态核心在
   `lib/mcp-shape.ts`,与 modes 的 plan 门禁共用(arch B1);用权威函数或
   lib 核心,不要再写第二份形态测试。
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

## 参考

core 消费的环境变量与写盘文件按模块记在 `docs/en/`(各模块文档列自己的;磁盘
布局由契约套件钉住,P0-CT-09——这些路径视为冻结)。一条容易漏的规则:
`PERMISSION_MODES_INHERITED_MODE` 须与 `PI_SUBAGENT_CHILD=1` 同设才生效。
`PI_SUBAGENT_*` 系列由 pi-subagents 生产;core 只读取。

## 遇到阻塞时

停下来问用户。不得私自发明绕过方案、重定义范围,或将未完成的工作标记为完成。
