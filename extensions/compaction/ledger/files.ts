/*
 * Ledger file-activity rendering (SPEC SC §5.6, task W6).
 *
 * The verification scan (verification.ts#scanFileActivity) collects the
 * raw lists; this module renders them into the ledger's compact forms used
 * by the Closed section annotation and the narrative prompt context:
 * modified files (most relevant for continuation) capped, then read-only
 * files capped, with an overflow count.
 */

import type { FileActivity } from "./types.ts";

export interface RenderedFileActivity {
	lines: string[];
	overflow: number;
}

export function renderFileActivity(activity: FileActivity, capPerList = 6): RenderedFileActivity {
	const lines: string[] = [];
	const push = (prefix: string, files: string[]): number => {
		let overflow = 0;
		for (let i = 0; i < files.length; i += 1) {
			if (i < capPerList) lines.push(`${prefix} ${files[i]}`);
			else overflow += 1;
		}
		return overflow;
	};
	const overflow = push("modified:", activity.modifiedFiles) + push("read:", activity.readFiles);
	return { lines, overflow };
}
