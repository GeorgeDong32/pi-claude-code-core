/**
 * SC-MET-01: aggregate recorded runtime checkpoints, never replay messages.
 * Run with pnpm exec tsx scripts/compaction-metrics.mjs <jsonl-or-directory>...
 * Output contains counts/durations only; real session content is never printed.
 */
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { metricFromEntry, summarizeCompactionMetrics } from "../extensions/compaction/metrics.ts";

async function sessionFiles(path, seen) {
	const absolute = resolve(path);
	if (seen.has(absolute)) return [];
	seen.add(absolute);
	const info = await stat(absolute);
	if (info.isFile()) return absolute.endsWith(".jsonl") ? [absolute] : [];
	if (!info.isDirectory()) return [];
	const files = [];
	for (const entry of await readdir(absolute, { withFileTypes: true })) {
		// Do not follow directory symlinks or traverse the same tree twice.
		if (entry.isDirectory() || entry.isFile()) files.push(...await sessionFiles(resolve(absolute, entry.name), seen));
	}
	return files;
}

export async function collectCompactionMetrics(paths) {
	const sessions = [];
	const seen = new Set();
	let malformedLines = 0;
	for (const path of paths) {
		for (const file of await sessionFiles(path, seen)) {
			const rows = [];
			const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
			for await (const line of lines) {
				if (!line.trim()) continue;
				try {
					const metric = metricFromEntry(JSON.parse(line));
					if (metric) rows.push(metric);
				} catch {
					// An interrupted JSONL write must not leak the partial line.
					malformedLines += 1;
				}
			}
			sessions.push(rows);
		}
	}
	return { ...summarizeCompactionMetrics(sessions), filesRead: sessions.length, malformedLines };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const paths = process.argv.slice(2);
	if (!paths.length) {
		console.error("Usage: pnpm exec tsx scripts/compaction-metrics.mjs <jsonl-or-directory>...");
		process.exitCode = 1;
	} else {
		try {
			console.log(JSON.stringify(await collectCompactionMetrics(paths), null, 2));
		} catch {
			console.error("Unable to read metrics input.");
			process.exitCode = 1;
		}
	}
}
