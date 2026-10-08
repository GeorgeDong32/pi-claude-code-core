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

# 2. project (plain dir; gitCanonicalRoot falls back to cwd) + 8 queue
#    records (7 routing-matching + 1 deliberately mismatched; > QUEUE_DRAIN_MAX=5
#    so the cap leaves candidates consumable). Evidence-run review (2026-10-08)
#    found the old `Date.now() + i` names could COLLIDE (mismatch at T0+8 vs
#    loop i=7 at T0+1+7) — the final run of the first evidence batch silently
#    overwrote the mismatch record before any session ran. Names now come from
#    a monotonic staging clock with a post-staging uniqueness/count assert, and
#    a manifest records which file is the mismatch.
node - "$HQ" "$EVID" <<'NODE'
const { mkdirSync, writeFileSync, readdirSync } = require("node:fs");
const { join } = require("node:path");
const [hq, evid] = process.argv.slice(2);
const ag = join(hq, "home/.pi/agent");
const proj = join(hq, "proj");
const { realpathSync } = require("node:fs");
const root = realpathSync(proj); // macOS /tmp -> /private/tmp: match gitCanonicalRoot
const sanitized = root.replace(/[/\\]/g, "-");
const projectsDir = join(ag, "projects", sanitized);
console.log("expected projectsDir =", projectsDir);
mkdirSync(join(ag, "memory-queue"), { recursive: true });
mkdirSync(projectsDir, { recursive: true });
const staged = [];
let clock = Date.now();
const stage = (sessionId, record) => {
	clock += 1; // monotonic: no two staged files can share a name
	const name = `${sessionId.slice(0, 8)}-${clock}.json`;
	writeFileSync(join(ag, "memory-queue", name), JSON.stringify(record));
	staged.push({ name, sessionId, mismatch: record.projectsDir !== projectsDir });
};
// #8: deliberately WRONG projectsDir — pins the routing-skip failure path
// (skip -> released back to pending, attempts untouched, no stranded claim).
stage("hq-session-08-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", {
	v: 1,
	sessionId: "hq-session-08-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
	projectsDir: join(ag, "projects", "mismatched-elsewhere"), cwd: proj,
	savedAt: Date.now() - 60_000, attempts: 0,
	parts: [{ role: "user", text: "Remember fact hq-8: routed nowhere." }],
});
for (let i = 1; i <= 7; i++) {
	const sessionId = `hq-session-${String(i).padStart(2, "0")}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`;
	stage(sessionId, {
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
	});
}
const onDisk = readdirSync(join(ag, "memory-queue")).sort();
if (onDisk.length !== 8 || new Set(onDisk).size !== 8) {
	console.error("STAGING ASSERT FAILED:", onDisk);
	process.exit(1);
}
writeFileSync(join(evid, "staging-manifest.json"), JSON.stringify({ staged, onDisk }, null, 1));
console.log("staged", staged.length, "records (7 matching + 1 mismatched); names unique:", new Set(onDisk).size === 8);
NODE

# 3. high-frequency directory sampler — the transfer evidence. Started
#    BEFORE the sessions (the first evidence batch booted it after them and
#    missed the first claim window; the review required the sampling start to
#    cover the claimed transitions, including the staged-ready baseline).
node - "$AG" "$EVID" <<'NODE' &
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

# 4. concurrent REAL sessions. Both fire session_start -> drain overlap. A
#    short task keeps each session alive long enough for the background drain.
cd "$HQ/proj"
env HOME="$HQ/home" PI_CODING_AGENT_DIR="$AG" pi -p "Think step by step, count slowly from one to twenty, then reply with exactly: one-done" > "$EVID/session-A.out" 2> "$EVID/session-A.err" &
PA=$!
sleep 0.4
env HOME="$HQ/home" PI_CODING_AGENT_DIR="$AG" pi -p "Think step by step, count slowly from one to twenty, then reply with exactly: two-done" > "$EVID/session-B.out" 2> "$EVID/session-B.err" &
PB=$!

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
// Verdict 2b (evidence review 2026-10-08): the deliberately-mismatched
// record must have an EXPLICIT captured fate — never "unexplained absence".
const manifest = JSON.parse(readFileSync(join(evid, "staging-manifest.json"), "utf-8"));
const mismatchName = manifest.staged.find((s) => s.mismatch).name;
const mismatchTrajectory = [];
for (const s of timeline) {
	const hit = s.files.find((f) => f === mismatchName || f.startsWith(mismatchName + "."));
	if (hit && mismatchTrajectory[mismatchTrajectory.length - 1]?.file !== hit) {
		mismatchTrajectory.push({
			t: s.t,
			file: hit,
			state: hit === mismatchName ? "ready" : hit.includes(".claim.") ? "claim" : hit.includes(".pending.") ? "pending" : "other",
		});
	}
}
const mismatchFinalFile = final.find((f) => f === mismatchName || f.startsWith(mismatchName + ".")) ?? null;
// Verdict 3: cap — at most QUEUE_DRAIN_MAX (5) consumed by ONE session's
// drain; leftovers must still be consumable (ready/pending remain).
const ready = final.filter((f) => f.endsWith(".json"));
const pending = final.filter((f) => f.includes(".pending."));
const report = {
	exitA: Number(ea), exitB: Number(eb),
	samples: timeline.length,
	doubleClaims,
	strandedClaimsAtEnd: stranded,
	mismatchRecord: {
		name: mismatchName,
		trajectory: mismatchTrajectory,
		finalState: mismatchFinalFile
			? (mismatchFinalFile.includes(".pending.") ? "pending" : mismatchFinalFile.includes(".claim.") ? "claim" : "ready")
			: "gone-settled-or-gc",
	},
	stagedCount: manifest.staged.length,
	finalReady: ready.length, finalPending: pending.length, finalFiles: final,
	verdict: {
		singleLiveOwnerPerRecord: doubleClaims.length === 0,
		noStrandedClaimAfterBothSessions: stranded.length === 0,
	},
};
if (mismatchFinalFile && mismatchFinalFile.includes(".pending.")) {
	try {
		writeFileSync(join(evid, "final-pending-record.json"), readFileSync(join(qdir, mismatchFinalFile)));
	} catch { /* best-effort content capture */ }
}
writeFileSync(join(evid, "verdict.json"), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ ...report, finalFiles: undefined }, null, 1));
NODE
echo "evidence dir: $EVID"
