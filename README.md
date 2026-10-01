# @georgedong32/pi-claude-code-core

Unified core extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): permission modes + effort + goal + review in one package, plus rules / memory / mcp-gov / web-gov modules.

> Contributing? Start with [AGENTS.md](AGENTS.md) (agent working guide, 中文版 [AGENTS.zh.md](AGENTS.zh.md)) and the architecture docs under [docs/](docs/README.md) (bilingual, `en/` + `zh/`).

> **Status: P0 scaffold preview (0.1.0-next).** This is an empty shell + shared lib + contract test suite. Function modules land phase by phase (P1 modes/effort/bus → P2 goal/review → P3 rules/memory → P4 mcp-gov/web-gov). Specs live in the parent workspace `../specs/`.

## Install (once released)

```
pi install npm:@georgedong32/pi-claude-code-core
```

## Development

```
bun install
bun run check      # tsc gate (main + contracts w/ documented allowlist)
bun run test       # unit tests (lib/, later module suites — per-framework)
bun run contracts  # cross-package contract suite (test/contracts)
```

The contract suite pins every cross-package surface (globalThis keys, env vars, status slots, session entry types, disk layout) so the phase-by-phase migration cannot silently break consumers. See [test/contracts/README.md](test/contracts/README.md) for the contract → consumer → removal-condition table.

## Web search (P4, exa MCP)

The default search channel is the official exa MCP server. Add to `~/.pi/agent/mcp.json`:

```json
{ "mcpServers": { "exa": { "command": "npx", "args": ["-y", "exa-mcp-server"], "env": { "EXA_API_KEY": "<your key>" } } } }
```

Requires `EXA_API_KEY`. (Bare `exa_search`-style direct tool naming is only claimed when the server id is on the mcp-gov knownServers list — set `PI_CORE_MCP_DIRECT_SERVERS=exa` in the environment; native `mcp__…` naming always is.) With the adapter installed (`pi install npm:pi-mcp-adapter`), `mcp_exa_*` tools get one first-seen approval prompt, then server-wide rules (`mcp_exa_*`) or session grants govern them. Pre-approved documentation domains (MDN, GitHub, …, overridable via `~/.pi/agent/pi-core-web.json`) pass the web family without prompting. pi-web-access is retired alongside 1.3.0.

## License

MIT. Phase 2 will vendor a fork of capyup/pi-goal (MIT); see `extensions/goal/FORK.md` when it lands.
