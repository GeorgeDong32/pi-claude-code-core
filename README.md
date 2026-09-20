# @georgedong32/pi-claude-code-core

Unified core extension for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent): permission modes + effort + goal + review in one package, plus rules / memory / mcp-gov / web-gov modules.

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

## License

MIT. Phase 2 will vendor a fork of capyup/pi-goal (MIT); see `extensions/goal/FORK.md` when it lands.
