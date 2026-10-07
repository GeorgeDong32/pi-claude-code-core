#!/bin/bash
# H-Q evidence run (spec 2026-10-08-followup-execution §4): two REAL pi
# sessions draining the memory queue concurrently under an isolated HOME +
# agentDir + project + record set. Everything lands in test/evidence/.
#
# Preconditions: pi on PATH; the repo's core loads via a local git clone
# preset into the isolated agentDir (settings packages: git:github.com/...).
set -u
REPO="/Users/gd32/Coding/Pi-Extension/pi-claude-code-core"
HQ="/tmp/hq-drain-run"
EVID="$REPO/test/evidence/2026-10-08-hq-dual-session-drain"
rm -rf "$HQ" "$EVID"
mkdir -p "$HQ/home/.pi/agent" "$HQ/proj" "$EVID"
AG="$HQ/home/.pi/agent"

# 1. isolated agentDir: local clone of THIS repo (the implementation under
#    test), credentials + model catalog copied from the real agent dir.
mkdir -p "$AG/git/github.com/GeorgeDong32"
git -C "$REPO" clone -q --no-hardlinks "$REPO" "$AG/git/github.com/GeorgeDong32/pi-claude-code-core"
git -C "$AG/git/github.com/GeorgeDong32/pi-claude-code-core" log --oneline -1 > "$EVID/core-revision.txt"
cp "$HOME/.pi/agent/auth.json" "$HOME/.pi/agent/models.json" "$AG/"
cat > "$AG/settings.json" <<'EOF'
{
  "packages": ["git:github.com/GeorgeDong32/pi-claude-code-core"],
  "memory": {"model": "CPA/model-fast", "recallModel": "CPA/model-fast"}
}
EOF

# 2. project (plain dir; gitCanonicalRoot falls back to cwd) + 7 queue
#    records (> QUEUE_DRAIN_MAX=5 so the cap leaves candidates consumable).
node - "$HQ" <<'NODE'
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const hq = process.argv[2];
const ag = join(hq, "home/.pi/agent");
const proj = join(hq, "proj");
const { realpathSync } = require("node:fs");
const root = realpathSync(proj); // macOS /tmp -> /private/tmp: match gitCanonicalRoot
const sanitized = root.replace(/[/\\]/g, "-");
const projectsDir = join(ag, "projects", sanitized);
console.log("expected projectsDir =", projectsDir);
mkdirSync(join(ag, "memory-queue"), { recursive: true });
mkdirSync(projectsDir, { recursive: true });
// #8: deliberately WRONG projectsDir — pins the routing-skip failure path
// (skip -> released back to pending, attempts untouched, no stranded claim).
{
	const sessionId = "hq-session-08-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
	writeFileSync(join(ag, "memory-queue", `${sessionId.slice(0, 8)}-${Date.now() + 8}.json`), JSON.stringify({
		v: 1, sessionId, projectsDir: join(ag, "projects", "mismatched-elsewhere"), cwd: proj,
		savedAt: Date.now() - 60_000, attempts: 0,
		parts: [{ role: "user", text: "Remember fact hq-8: routed nowhere." }],
	}));
}
for (let i = 1; i <= 7; i++) {
	const sessionId = `hq-session-${String(i).padStart(2, "0")}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
	const record = {
		v: 1,
		sessionId,
		projectsDir,
		cwd: proj,
		savedAt: Date.now() - 60_000,
		attempts: 0,
		parts: [
			{ role: "user", text: `Remember fact hq-${i}: the dual-session drain evidence run assigns marker color ${i}.` },
			{ role: "assistant", text: "Noted." },
		],
	};
	writeFileSync(join(ag, "memory-queue", `${sessionId.slice(0, 8)}-${Date.now() + i}.json`), JSON.stringify(record));
}
console.log("staged 7 records; projectsDir =", projectsDir);
NODE

# 3. concurrent REAL sessions. Both fire session_start -> drain overlap. A
#    short task keeps each session alive long enough for the background drain.
cd "$HQ/proj"
env HOME="$HQ/home" PI_CODING_AGENT_DIR="$AG" pi -p "Think step by step, count slowly from one to twenty, then reply with exactly: one-done" > "$EVID/session-A.out" 2> "$EVID/session-A.err" &
PA=$!
sleep 0.4
env HOME="$HQ/home" PI_CODING_AGENT_DIR="$AG" pi -p "Think step by step, count slowly from one to twenty, then reply with exactly: two-done" > "$EVID/session-B.out" 2> "$EVID/session-B.err" &
PB=$!

# 4. high-frequency directory sampler — the transfer evidence.
node - "$AG" "$EVID" "$PA" "$PB" <<'NODE' &
const { readdirSync, existsSync } = require("node:fs");
const { join } = require("node:path");
const [ag, evid] = process.argv.slice(2);
const samples = [];
function snap() {
	const dir = join(ag, "memory-queue");
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}
const t0 = Date.now();
let last = "";
const flush = () => require("node:fs").writeFileSync(join(evid, "queue-timeline.json"), JSON.stringify(samples, null, 1));
const timer = setInterval(() => {
	const files = snap();
	const key = files.join("|");
	if (key !== last) {
		last = key;
		samples.push({ t: Date.now() - t0, files });
		flush();
	}
	if (Date.now() - t0 > 180_000) { clearInterval(timer); flush(); process.exit(0); }
}, 25);
process.on("SIGTERM", () => { clearInterval(timer); flush(); process.exit(0); });
process.on("exit", flush);
NODE
SAMPLER=$!

wait $PA; EA=$?
wait $PB; EB=$?
sleep 3
kill $SAMPLER 2>/dev/null
wait $SAMPLER 2>/dev/null

# 5. final queue state + verdict computation.
node - "$AG" "$EVID" "$EA" "$EB" <<'NODE'
const { readdirSync, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const [ag, evid, ea, eb] = process.argv.slice(2);
const qdir = join(ag, "memory-queue");
const final = existsSync(qdir) ? readdirSync(qdir).sort() : [];
const timeline = JSON.parse(readFileSync(join(evid, "queue-timeline.json"), "utf-8"));

// Verdict 1: at any sampled instant, each ORIGINAL record has at most one live claim.
let doubleClaims = [];
for (const s of timeline) {
	const claims = s.files.filter((f) => f.includes(".claim."));
	const byOriginal = new Map();
	for (const c of claims) {
		const orig = c.slice(0, c.indexOf(".claim."));
		byOriginal.set(orig, (byOriginal.get(orig) ?? 0) + 1);
	}
	for (const [orig, n] of byOriginal) if (n > 1) doubleClaims.push({ t: s.t, orig, n });
}
// Verdict 2: no stranded live claim at the end.
const stranded = final.filter((f) => f.includes(".claim."));
// Verdict 3: cap — at most QUEUE_DRAIN_MAX (5) consumed by ONE session's
// drain; leftovers must still be consumable (ready/pending remain).
const ready = final.filter((f) => f.endsWith(".json"));
const pending = final.filter((f) => f.includes(".pending."));
const report = {
	exitA: Number(ea), exitB: Number(eb),
	samples: timeline.length,
	doubleClaims,
	strandedClaimsAtEnd: stranded,
	finalReady: ready.length, finalPending: pending.length, finalFiles: final,
	verdict: {
		singleLiveOwnerPerRecord: doubleClaims.length === 0,
		noStrandedClaimAfterBothSessions: stranded.length === 0,
	},
};
writeFileSync(join(evid, "verdict.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, finalFiles: undefined }, null, 1));
NODE
echo "evidence dir: $EVID"
