# OPEN-QUESTIONS — 需用户决策项

> 实施会话不等待、不代办;每项给出建议与阻塞点。

1. **npm 发版与切换(阻塞 P1 起)**:P0-SK-04 要求发 `0.1.0-next` 预览一次(允许);1.0.0+ 正式发版、`~/.pi/agent/settings.json` packages 切换、旧四包 deprecate 全部留待用户。P1 完成后是否立即发 1.0.0 并切换,请用户定。
   - **P0-SK-04 现状(2026-09-21)**:publish 因本机 npm 未登录被阻(`ENEEDAUTH`;~/.npmrc 只有 npmmirror registry,无 npmjs 凭据)。包已就绪(commit 4072b22,publishConfig 已显式官方 registry)。用户执行:`npm login` → 仓库目录 `npm publish --tag next`。publishConfig 的 registry 修正已随 chore commit 入库。
2. **EXA_API_KEY(P4 前置)**:本机 env 无此 key(exa 经 pi-web-access 免 key)。P4-WB-03 接官方 exa server 需要用户提供 key 并写入 `~/.pi/agent/mcp.json` 的 env 段。
3. **pi-goal 0.1.7 ↔ 0.6.0 行为 diff——已消解(2026-09-21 实测)**:npm 上 @capyup/pi-goal 不存在 0.1.7(handoff 笔误),版本线 0.1.0-0.1.2→…→0.6.0(最新)。npm 0.6.0 tarball 与本地 fork 基线(ec2bcbe)源码一致,FORK.md 已记录;无行为取舍需要决策。
4. **License 汇聚(P2 前)**:core 声明 MIT;pi-effort / pi-review 源为 Apache-2.0(用户自己的包,有权再许可)。并入后 core 是否改 Apache-2.0 或保持 MIT + 双声明,建议保持 MIT 并在 README 注明各模块来源许可(P2 时落)。
5. **CCTUI 1.5.0(P2-CCTUI 节)**:本次派发不改 CCTUI 仓库;core 1.1.0 发版后由用户在 pi-claude-code-tui 实施 P2-CCTUI-01..04。
6. **P4-MC-07 broker claim 语义实测(需真机 adapter)**:本机未装 pi-mcp-adapter,claim 的同步/异步语义与 approval request 的 callId 未实测。实现按 spec 风险①预案:mirror 为同步纯函数、canonicalId 走 server/tool(不依赖 callId),对两种结论免疫;真机验证归 P4-REL 冒烟(adapter 在场 + exa 首调弹窗 + bypass 组合)。
7. **pm/cctui dev symlink 发版核查**:每次 pi update 后必查(handoff 转述的既有教训);P0 未动本机安装,无影响。
