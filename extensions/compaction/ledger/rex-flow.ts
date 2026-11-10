/*
 * rex-flow ledger provider (SPEC SC §5.6 LED-05/05b/05c, task W7).
 *
 * Read-only, fail-open (INV-6): never writes ~/.rex-flow, never imports
 * rex-flow code, board reads are synchronous with a 2 MiB cap.
 *
 * DISCOVERY (E8 — never hardcode one layout; three fixture layouts must all
 * resolve): ① settings.ledger.rexFlow.boardPath; ② paths the session itself
 * used (--board args / dispatch|evidence file paths → project_dir); ③
 * enumeration of <rexRoot>/projects/<name>/board.json plus the legacy
 * ~/rex-flow/boards/<name>.json layout.
 *
 * ASSOCIATION (R1-6 / LED-05b — "the only active board on the machine" is
 * NOT proof): a candidate board is TRUSTED only when (a) its source is ①/②
 * (the session used it), or (b) board.deploy.repo matches the cwd's git
 * origin (owner/name from .git/config) AND at least one of its run ids was
 * OBSERVED in this session's branch (sentinel / --run arg / previous ledger
 * block). Untrusted → sentinel-only ledger; the narrative header must NOT
 * claim board truth (LED-06).
 *
 * Run-level filter: detail rows ONLY for observed run ids; other open runs
 * on a trusted board collapse to one count line (LED-05).
 */

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { lastLedgerBlockBody } from "./directives.ts";
import type { CompressedRegionView, FlowLedgerState } from "./types.ts";
import type { CompactionSettings } from "../settings.ts";

const BOARD_MAX_BYTES = 2 * 1024 * 1024;

interface BoardTask {
	id: string;
	run?: string;
	status?: string;
	branch?: string;
	window?: string;
	rework_count?: number;
	notes?: Array<{ text?: string }>;
	title?: string;
}

interface BoardRun {
	id: string;
	objective?: string;
	stage?: string;
	spec?: string;
}

interface BoardFile {
	deploy?: { repo?: string; project_dir?: string; ws_root?: string };
	runs?: BoardRun[];
	tasks?: BoardTask[];
	gates?: Array<{ id?: string; run?: string; task?: string; question?: string; status?: string }>;
}

/** Sentinel markers (LED-05/05c) — rex-flow's in-conversation reporting. */
const SENTINEL = /===FLOW-REPORT===/;
const RUN_DONE = /\brun-done\b|\brun_done\b/;
const RUN_ID = /\br([0-9][0-9a-z_-]*)\b/;

export interface SessionObservation {
	/** Run ids seen in the branch (sentinels, --run args, tool calls). */
	observedRunIds: Set<string>;
	/** Board paths / project dirs the session itself used. */
	usedBoardHints: string[];
	/** Sentinel one-liners for the sentinel-only degradation view. */
	sentinels: string[];
}

/** Scan the compressed region for sentinels, run ids and board-usage hints. */
export function observeSession(region: CompressedRegionView): SessionObservation {
	const observedRunIds = new Set<string>();
	const usedBoardHints: string[] = [];
	const sentinels: string[] = [];
	for (const { messages } of region.entries) {
		for (const message of messages) {
			const text = textualContent(message);
			if (text.length === 0) continue;
			for (const line of text.split("\n")) {
				if (SENTINEL.test(line) || /flow-board|flow-dispatch|flow-watch/.test(line)) {
					sentinels.push(line.trim().slice(0, 120));
					const ids = line.match(new RegExp(RUN_ID, "g")) ?? [];
					for (const id of ids) observedRunIds.add(id);
				}
				// --board <path> hints.
				const boardArg = /--board[ =]+(\S+)/.exec(line);
				if (boardArg) usedBoardHints.push(boardArg[1]);
				// dispatch/evidence file paths → project dir hint.
				const dispatchPath = /(\S*\.rex-flow\/projects\/\S+?)\/(?:dispatch|evidence)\//.exec(line);
				if (dispatchPath) usedBoardHints.push(dispatchPath[1]);
			}
		}
	}
	return { observedRunIds, usedBoardHints, sentinels };
}

function textualContent(message: unknown): string {
	const record = message as { content?: unknown };
	const content = record.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return (content as Array<{ type?: string; text?: string; output?: string }>)
		.map((block) => (typeof block.text === "string" ? block.text : typeof block.output === "string" ? block.output : ""))
		.join("\n");
}

function readBoard(path: string): BoardFile | undefined {
	try {
		const stat = statSync(path);
		if (stat.size > BOARD_MAX_BYTES) return undefined; // board-too-large
		return JSON.parse(readFileSync(path, "utf-8")) as BoardFile;
	} catch {
		return undefined; // missing / corrupt / unreadable
	}
}

function gitOriginRepo(cwd: string): string | null {
	try {
		const config = readFileSync(join(cwd, ".git", "config"), "utf-8");
		const match = /url\s*=\s*(?:git@github\.com:|https:\/\/github\.com\/|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^\s./]+?)(?:\.git)?\s*$/im.exec(config);
		return match ? `${match[1]}/${match[2]}` : null;
	} catch {
		return null;
	}
}

function discoverCandidatePaths(settings: CompactionSettings, homeDir: string, hints: string[]): string[] {
	const candidates: string[] = [];
	if (settings.ledger.rexFlow.boardPath) candidates.push(settings.ledger.rexFlow.boardPath);
	for (const hint of hints) candidates.push(join(hint, "board.json"));
	const projectsRoot = join(homeDir, ".rex-flow", "projects");
	if (existsSync(projectsRoot)) {
		for (const name of readdirSync(projectsRoot)) {
			const board = join(projectsRoot, name, "board.json");
			if (existsSync(board)) candidates.push(board);
		}
	}
	// Legacy layout (E8): ~/rex-flow/boards/*.json
	const legacy = join(homeDir, "rex-flow", "boards");
	if (existsSync(legacy)) {
		for (const name of readdirSync(legacy)) {
			if (name.endsWith(".json")) candidates.push(join(legacy, name));
		}
	}
	return [...new Set(candidates)];
}

export interface FlowLedgerInput {
	cwd: string;
	homeDir: string;
	settings: CompactionSettings;
	region: CompressedRegionView;
	/** Run ids carried over from the previous ledger block (LED-02b). */
	previousRunIds?: Set<string>;
}

export interface FlowLedgerResult {
	state: FlowLedgerState;
	/** Why a board was not used (telemetry reason codes, LED-05b). */
	reason?: "board-none" | "board-unassociated" | "board-too-large" | "board-corrupt";
}

/** Build the flow ledger state (LED-05b discovery + association + LED-05). */
export function buildFlowLedger(input: FlowLedgerInput): FlowLedgerResult {
	const observation = observeSession(input.region);
	const observed = new Set([...observation.observedRunIds, ...(input.previousRunIds ?? [])]);
	const sentinelOnly = (reason?: FlowLedgerResult["reason"]): FlowLedgerResult => ({
		state: { associated: false, openRuns: [], closed: [], sentinels: observation.sentinels, otherOpenRuns: 0 },
		reason: observation.sentinels.length > 0 || (reason !== "board-none" && reason !== undefined) ? reason : "board-none",
	});

	if (!input.settings.ledger.rexFlow.enabled) return sentinelOnly();

	const candidates = discoverCandidatePaths(input.settings, input.homeDir, observation.usedBoardHints);
	if (candidates.length === 0) return sentinelOnly("board-none");

	// Association: (a) explicit source (settings/hints) or (b) repo match +
	// observed run. Pick the FIRST associated board. Reason codes: readable
	// candidates that simply did not associate win over corrupt ones.
	let sawReadableBoard = false;
	let sawCorruptBoard = false;
	let explicitBoardWasCorrupt = false;
	for (const path of candidates) {
		const explicit = path === input.settings.ledger.rexFlow.boardPath || observation.usedBoardHints.some((hint) => path === join(hint, "board.json"));
		const board = readBoard(path);
		if (!board) {
			sawCorruptBoard = true;
			if (explicit) explicitBoardWasCorrupt = true;
			continue;
		}
		sawReadableBoard = true;
		if (explicit) return trusted(board, path, observed, observation);
		const origin = gitOriginRepo(input.cwd);
		if (origin && board.deploy?.repo === origin && board.runs?.some((run) => observed.has(run.id))) {
			return trusted(board, path, observed, observation);
		}
	}
	if (explicitBoardWasCorrupt) return sentinelOnly("board-corrupt");
	return sentinelOnly(sawReadableBoard ? "board-unassociated" : sawCorruptBoard ? "board-corrupt" : "board-none");
}

function trusted(board: BoardFile, boardPath: string, observed: Set<string>, observation: SessionObservation): FlowLedgerResult {
	const runs = board.runs ?? [];
	const tasks = board.tasks ?? [];
	const gates = board.gates ?? [];
	const openRuns: FlowLedgerState["openRuns"] = [];
	const closed: FlowLedgerState["closed"] = [];
	let otherOpenRuns = 0;

	for (const run of runs) {
		const runTasks = tasks.filter((task) => task.run === run.id || task.id.startsWith(`${run.id}/`));
		const mergedCount = runTasks.filter((task) => task.status === "merged").length;
		if (run.stage === "done") {
			closed.push({ id: run.id, label: (run.objective ?? "").slice(0, 60), detail: `${mergedCount}/${runTasks.length} merged` });
			continue;
		}
		if (!observed.has(run.id)) {
			otherOpenRuns += 1; // on this board, not touched by this session
			continue;
		}
		const lastNote = runTasks
			.flatMap((task) => task.notes ?? [])
			.map((note) => note.text ?? "")
			.filter((text) => text.length > 0)
			.at(-1);
		openRuns.push({
			runId: run.id,
			objective: (run.objective ?? "").slice(0, 120),
			stage: run.stage ?? "unknown",
			spec: run.spec && run.spec.length > 0 ? run.spec : undefined,
			tasks: runTasks.map((task) => ({
				id: task.id,
				status: task.status ?? "unknown",
				branch: task.branch,
				tab: task.window,
				reworkCount: task.rework_count,
				note: lastNote?.slice(0, 100),
			})),
			openGates: gates
				.filter((gate) => (gate.run === run.id || gate.task?.startsWith(`${run.id}/`)) && gate.status !== "resolved")
				.map((gate) => ({ id: gate.id ?? "?", question: (gate.question ?? "").slice(0, 150), ref: gate.task })),
			lastSentinels: observation.sentinels.filter((line) => line.includes(run.id)).slice(-12),
		});
	}
	// Closed rows cap (LED-05): ≤8 lines + overflow pointer.
	const closedCapped = closed.slice(0, 8);
	if (closed.length > 8) closedCapped.push({ id: "+K", label: `+${closed.length - 8} older (see board)` });

	return {
		state: { associated: true, boardPath, openRuns, closed: closedCapped, sentinels: observation.sentinels, otherOpenRuns },
	};
}

/** Parse run ids out of a previous ledger block for the LED-02b carry-over. */
export function previousLedgerRunIds(previousSummary: string | undefined): Set<string> {
	const ids = new Set<string>();
	if (!previousSummary) return ids;
	// D4 (2026-11-10 review D): read ONLY the LAST complete v1 block (shared
	// helper with parseCarriedDirectives) — a forged block echoed in the
	// narrative must not shadow the real one; unknown versions are ignored
	// (INV-9), superseding B6's any-version match.
	const body = lastLedgerBlockBody(previousSummary);
	if (body === undefined) return ids;
	for (const id of body.match(new RegExp(RUN_ID, "g")) ?? []) ids.add(id);
	return ids;
}
