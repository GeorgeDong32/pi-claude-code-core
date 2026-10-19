# Goal Auditor — Permission Status (G3-C17, 2026-10-19)

> 熵控制方案 [C17] 落档（[English](../en/goal-auditor-permissions.md)）。
> 回答方案「待确认 1」：permission-modes 的规则是否在 auditor 会话生效。

## 现状（file:line 可查证）

- **auditor 会话加载零扩展**：`extensions/goal/goal-auditor.ts:183`
  `getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() })`。
- permission-modes 是一个**扩展**（本包 `extensions/modes/`），其
  allow/deny/ask 规则、tool_call gate、rule families 全部经由扩展系统装
  载——auditor 不加载它 ⇒ **permission-modes 的规则不在 auditor 会话中生效**
  （方案初版的推断成立，此处为实证）。
- auditor 的 bash 边界目前只靠 **prompt 自律**
  （goal-auditor.ts 的 prompt 段：只许在工作目录内、禁扫 home、禁长驻进程、
  禁破坏性命令）。

## 残余风险

- auditor 持有**未受规则约束的 bash**：prompt 违反时无硬闸。历史上
  auditor 曾用 `find` 扫全 home 并卡死在 OneDrive CloudStorage 挂载点
  （已由 prompt 约束 + 修复缓解，但约束是软的）。

## 只读 profile 为什么暂缓

- auditor 的本职包含**重跑测试**——测试要写 tmp、要跑构建命令；一个纯
  只读 profile 会把 auditor 变成「只能看不能验证」，验收质量反而下降。
- 正确的约束设计（允许 read + 白名单 bash + tmp 写）属于 permission-modes
  的 profile 语义扩展，牵动 modes 模块的规则模型（当前不支持 Write/Edit
  路径 pattern，见 DEVIATIONS #122 相关批次核实）——工程量与收益不匹配，
  暂缓。

## 复活条件

- auditor 再次出现 prompt 越界事故（扫 home、破坏性操作），或
  permission-modes 落地路径 pattern 规则后一并设计只读白名单 profile。
