// Vendored from gvanderclay/pi-bg-bash v0.2.1 (MIT). Copyright (c) 2026 Gage Vander Clay.
import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { gunzipSync } from "node:zlib";

import type { Task } from "./registry.ts";

export type Marker = { start: number; end: number; code: number };

const CHUNK = 64 * 1024;
const TAIL = 16;

export function markerNeedle(nonce: string): Buffer {
	return Buffer.from(`\n__CC_BG_EXIT__:${nonce}:`);
}

export function locateMarker(task: Task): Marker | undefined {
	if (task.marker !== undefined) return task.marker;
	if (task.logPath.endsWith(".gz")) return undefined;
	const needle = markerNeedle(task.nonce);
	const overlap = needle.length + TAIL;
	const fd = openSync(task.logPath, "r");
	try {
		const size = fstatSync(fd).size;
		let pos = task.scanFrom;
		while (pos < size) {
			const length = Math.min(CHUNK + overlap, size - pos);
			const buffer = Buffer.alloc(length);
			readSync(fd, buffer, 0, length, pos);
			const index = buffer.indexOf(needle);
			if (index >= 0) {
				const rest = /^(\d+)\n/.exec(buffer.toString("latin1", index + needle.length, index + needle.length + TAIL));
				if (rest !== null) {
					const start = pos + index;
					task.marker = { start, end: start + needle.length + rest[0].length, code: Number(rest[1]) };
					return task.marker;
				}
				if (pos + length >= size) {
					task.scanFrom = pos + index;
					return undefined;
				}
			}
			if (pos + CHUNK >= size) break;
			pos += CHUNK;
		}
		task.scanFrom = Math.max(task.scanFrom, size - overlap, 0);
		return undefined;
	} finally {
		closeSync(fd);
	}
}

export type View = {
	size: number;
	marker: Marker | undefined;
	read(start: number, end: number): Buffer;
	close(): void;
};

export function openView(task: Task): View {
	if (task.logPath.endsWith(".gz")) return openGzView(task);
	const fd = openSync(task.logPath, "r");
	try {
		const physicalSize = fstatSync(fd).size;
		return viewFor(
			task,
			physicalSize,
			(start, end) => {
				const buffer = Buffer.alloc(end - start);
				readSync(fd, buffer, 0, buffer.length, start);
				return buffer;
			},
			() => closeSync(fd),
		);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

type Region = { start: number; end: number };

function cutRegions(task: Task): Region[] {
	const regions: Region[] = [];
	locateMarker(task);
	if (task.marker !== undefined) regions.push(task.marker);
	if (task.limitMarker !== undefined) regions.push(task.limitMarker);
	return regions.sort((a, b) => a.start - b.start);
}

function viewFor(
	task: Task,
	physicalSize: number,
	read: (start: number, end: number) => Buffer,
	close: () => void,
): View {
	const segments: { virtual: number; physical: number; length: number }[] = [];
	let physical = 0;
	let virtual = 0;
	for (const cut of cutRegions(task)) {
		if (cut.start > physical) {
			const length = cut.start - physical;
			segments.push({ virtual, physical, length });
			virtual += length;
		}
		physical = Math.max(physical, cut.end);
	}
	if (physicalSize > physical) segments.push({ virtual, physical, length: physicalSize - physical });
	return {
		size: virtual + Math.max(physicalSize - physical, 0),
		marker: task.marker,
		read(start, end) {
			const parts: Buffer[] = [];
			for (const segment of segments) {
				const from = Math.max(start, segment.virtual);
				const to = Math.min(end, segment.virtual + segment.length);
				if (to > from)
					parts.push(read(segment.physical + (from - segment.virtual), segment.physical + (to - segment.virtual)));
			}
			return parts.length === 1 ? parts[0] : Buffer.concat(parts);
		},
		close,
	};
}

function openGzView(task: Task): View {
	const buffer = gunzipSync(readFileSync(task.logPath));
	return viewFor(
		task,
		buffer.length,
		(start, end) => Buffer.from(buffer.subarray(start, end)),
		() => {},
	);
}
