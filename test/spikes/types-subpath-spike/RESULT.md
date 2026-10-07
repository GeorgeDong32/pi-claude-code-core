# P0-SK-05 spike ① 结论 — `/types` subpath 发布布局

> **已归档(2026-10-08)**:本 spike 验证的 runtime 布局(`core-status.mjs` +
> import 条件)已随 D4=B 决策撤除——`./types` 现为纯类型子路径(验收见
> `test/contracts/types-subpath.test.ts`)。本目录保留作历史证据,其结论
> 不再描述现行发布形态。

**结论:可行,采纳此布局**(2026-09-20 实测,`zsh verify.sh` 全绿)。

验证矩阵(全部通过):

| 消费方式 | 结果 |
|---|---|
| `npm pack` 装箱(files 含 `types/`) | `package/types/index.js` + `index.d.ts` 均入包 |
| node 运行时 `import { readCoreStatus } from "mini-core/types"` | exports map `"./types"` 正确解析;total reader 矩阵(默认/新 key/legacy/垃圾输入)全过 |
| **jiti 运行时**(CCTUI 消费方式) | `jiti.import("mini-core/types")` 拿到运行时函数 |
| tsc `import type`(strict + nodenext) | `.d.ts` 经 exports map `types` 条件解析成功 |

布局定稿(P1-BUS-02 采纳):

```jsonc
// package.json
"exports": {
  ".":   { "import": "./index.js" },            // 主入口(占位;pi 经文件路径加载,不走 exports)
  "./types": {
    "types": "./types/index.d.ts",
    "import": "./types/index.js"
  }
},
"files": ["extensions", "lib", "types", "README.md", "LICENSE"]
```

要点:
- subpath 侧发**纯 .js + .d.ts**(消费方零 TS transform 成本;jiti 直读)。
- pi 加载 extension 走文件路径(`pi.extensions` → jiti import 绝对路径),**不经 exports map**,与 subpath 互不干扰。
- 本地验证时 tsc 会向上层目录找 tsconfig(踩坑 TS5112),consumer 需自带 tsconfig。

## P0-SK-05 spike ② 结论 — 显式 per-channel patch

见 `../per-channel-patch.ts`:DESIGN-BUS 的 frozen 快照 + 显式 per-channel patch
(`ModesPatch | EffortPatch | ...` 联合,无泛型 DeepPartial)在 tsc strict 下可写可维护;
5 个 `@ts-expect-error` 编译期证明(部分通道对象/未知通道/错误字面量/version 不可 patch)全部生效,
`bun run check` 通过 = 证明有效。P1-BUS-03 按此形状实施 `extensions/bus.ts`。
