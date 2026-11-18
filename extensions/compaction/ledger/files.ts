
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
