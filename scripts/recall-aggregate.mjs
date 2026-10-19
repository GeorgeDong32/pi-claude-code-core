#!/usr/bin/env node
/**
 * recall-aggregate.mjs — entropy-control G3 [C22]: offline recall latency
 * report from existing session transcripts (docs/zh/entropy-control-spec.md).
 *
 * Reads session jsonl files, extracts pi-memory-recall details v1 records
 * (delivery/model/files/bytes/elapsedMs — shape pinned by P0-CT-08), and
 * emits a Markdown report: delivery distribution, elapsedMs p50/p90,
 * delivered-turn distance distribution, sample counts (stated when
 * insufficient), and a data-backed waitMs recommendation. Read-only; the
 * waitMs default is NOT modified by running this.
 *
 * Usage:
 *   node scripts/recall-aggregate.mjs [sessionsRoot]     # default ~/.pi/agent/sessions
 *   node scripts/recall-aggregate.mjs <dir> > report.md
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const root = process.argv[2] ?? join(homedir(), ".pi/agent", "sessions");

/** Recursively collect .jsonl files (bounded depth for mount safety). */
function jsonlFiles(dir, depth = 0, out = []) {
	if (depth > 6) return out;
	let entries;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = join(dir, e.name);
		if (e.isDirectory()) jsonlFiles(full, depth + 1, out);
		else if (e.name.endsWith(".jsonl")) out.push(full);
	}
	return out;
}

function percentile(sorted, p) {
	if (sorted.length === 0) return null;
	const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
	return sorted[Math.max(0, idx)];
}

const files = jsonlFiles(root);
const records = [];
const turnDistances = []; // landing positions: which user-turn index each delivered block landed on (G3-C22)
let scanned = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
		scanned++;
	} catch {
		continue;
	}
	// Walk the transcript in line order and record each delivered
	// pi-memory-recall block's LANDING POSITION: the index of the last user
	// message started before the block landed (0-based). Both immediate and
	// deferred deliveries land before the NEXT user message (immediate blocks
	// persist right after their user message; deferred ones flush at the same
	// run's turn_end), so this measures where in the session the block landed
	// — NOT how many turns after its trigger. It grows with session length by
	// construction; treat it as a position gauge, not a delivery-delay gauge.
	// (A true trigger→landing distance would need the trigger turn recorded in
	// details v1 — a frozen surface (P0-CT-08); would take a v2 contract.)
	let userMessagesSeen = -1; // -1 until the first user message
	for (const line of text.split("\n")) {
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		const msg = entry?.message ?? entry;
		const type = msg?.type ?? entry?.type;
		if (type === "user" || msg?.role === "user") userMessagesSeen += 1;
		if (!line.includes("pi-memory-recall")) continue;
		const details = msg?.details;
		if (details && details.v === 1 && typeof details.elapsedMs === "number") {
			records.push({ file, ...pick(details), delivery: details.delivery });
			if (userMessagesSeen >= 0) turnDistances.push(userMessagesSeen);
		}
	}
}

function pick(d) {
	return { elapsedMs: d.elapsedMs, bytes: d.bytes, files: Array.isArray(d.files) ? d.files.length : 0, model: d.model };
}

const deliveries = records.filter((r) => r.delivery === "immediate").length;
const deferred = records.filter((r) => r.delivery === "deferred").length;
const elapsed = records.map((r) => r.elapsedMs).sort((a, b) => a - b);
const p50 = percentile(elapsed, 50);
const p90 = percentile(elapsed, 90);

console.log(`# Recall latency report (G3-C22)`);
console.log();
console.log(`- sessions scanned: ${scanned} jsonl file(s) under \`${root}\``);
console.log(`- recall records (details v1): **${records.length}**`);
if (records.length === 0) {
	console.log();
	console.log("> **Sample insufficient** — no pi-memory-recall details found. Nothing to aggregate; the waitMs question cannot be answered from this data.");
	console.log("> (Records only exist for sessions that ran memory recall with a resolvable selector model.)");
	process.exit(0);
}
console.log(`- delivery: immediate ${deliveries} / deferred ${deferred} (immediate ratio ${(100 * deliveries / records.length).toFixed(1)}%)`);
console.log(`- selector elapsedMs: p50 ${p50} / p90 ${p90} (n=${elapsed.length})`);
console.log(`- bytes per delivered block: median ${percentile(records.map((r) => r.bytes).sort((a, b) => a - b), 50)}`);
console.log();

// landing-position distribution (G3-C22): at which user-turn index each
// recall block landed (0 = session's first user turn). Position gauge only —
// see the note above the collector for why this is not a delivery delay.
const distances = turnDistances.slice().sort((a, b) => a - b);
if (distances.length === 0) {
	console.log(`- landing position: **insufficient samples** (no delivered block with a preceding user message found — the metric needs transcripted deliveries)`);
} else {
	const counts = new Map();
	for (const d of distances) counts.set(d, (counts.get(d) ?? 0) + 1);
	const rows = [...counts.entries()].sort((a, b) => a[0] - b[0]).map(([d, n]) => `  - landed at user turn ${d}: ${n} (${((100 * n) / distances.length).toFixed(1)}%)`);
	console.log(`- landing position (n=${distances.length}, median ${percentile(distances, 50)}):`);
	for (const row of rows) console.log(row);
}
console.log();

// waitMs recommendation logic — data-backed, explicit
console.log(`## waitMs recommendation`);
if (deferred === 0 && deliveries === 0) {
	console.log(`- no delivered samples — cannot recommend.`);
} else if (p50 === null) {
	console.log(`- no elapsed samples — cannot recommend.`);
} else if (p50 <= 2000) {
	console.log(`- p50 selector time is ${p50}ms (≤2s): a small waitMs (≈ p50, e.g. ${Math.ceil(p50 / 500) * 500}ms) is worth trying so first turns can see recall immediately — validate with the evaluation set before making it default.`);
} else {
	console.log(`- p50 selector time is ${p50}ms (>2s): keeping waitMs=0 (deferred) is the right trade — blocking the first turn this long costs more than the late delivery does.`);
}
console.log();
console.log(`_The waitMs default in extensions/memory is unchanged by this report (spec out-of-scope)._`);
