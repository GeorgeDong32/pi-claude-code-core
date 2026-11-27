/*
 * `-o pipefail` is a bash/zsh option; dash `sh` rejects it and would fail
 * every command — other shells get a no-op.
 */

const CHECK_COMMAND =
	/^(?:\(\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:time\s+|nice\s+)?(?:(?:pnpm|npm|yarn|bun|npx)\s+(?:run\s+|exec\s+)?(?:test|check|lint|build|typecheck|contracts|coverage|vitest|tsc|eslint|jest)\b|vitest\b|jest\b|tsc\b|cargo\s+(?:test|build|check|clippy)\b|go\s+(?:test|build|vet)\b|pytest\b|python[0-9.]*\s+-m\s+pytest\b|make\b|just\b|\.\/gradlew\b|\.\/mvnw\b|dotnet\s+(?:test|build)\b)/;

const STATUS_IS_THE_ANSWER = /^(?:grep|rg|ag)\s+(?:-[a-zA-Z]*q[a-zA-Z]*\s|--quiet\s|--silent\s|-c\b|--count\b)/;

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
const REAL_PIPE = /\|&?/g;
const HAS_PIPE = /\|&?/;
const COMMAND_SPLIT = /(?:&&|\|\||;)/;

function stripQuoted(text: string): string {
	return text.replace(QUOTED, '""');
}

export function needsPipefail(command: string): boolean {
	if (!command.includes("|")) return false;
	if (/\bpipefail\b/.test(command)) return false;
	for (const line of command.split("\n")) {
		for (const part of line.split(COMMAND_SPLIT)) {
			const bare = stripQuoted(part);
			if (!HAS_PIPE.test(bare)) continue;
			const stages = bare.split(REAL_PIPE);
			const first = stages[0]?.trim() ?? "";
			const last = stages.at(-1)?.trim() ?? "";
			if (stages.length < 2) continue;
			if (!CHECK_COMMAND.test(first)) continue;
			if (STATUS_IS_THE_ANSWER.test(last)) continue;
			return true;
		}
	}
	return false;
}

export function pipefailArgs(shell: string, args: readonly string[]): string[] {
	const base = shell.split("/").at(-1) ?? shell;
	if (base !== "bash" && base !== "zsh") return [...args];
	return ["-o", "pipefail", ...args];
}
