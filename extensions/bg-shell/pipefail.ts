/*
 * pipefail.ts — exit-code guard for check pipelines.
 *
 * The model routinely writes `pnpm test 2>&1 | tail -25`; the status the bash
 * tool then reports is tail's, so a red test run reads as success. In the
 * user's own 30-day session logs 55.6% of test/build/check command segments
 * went straight into a pipe, and a prose rule against it changed nothing.
 * The tool does: when a command contains a check-command pipeline and does
 * not set pipefail itself, the shell for THAT invocation runs with
 * `-o pipefail`, so the reported status is the rightmost non-zero exit of
 * the pipeline.
 *
 * Scope on purpose:
 *   - only bash/zsh: `-o pipefail` is a bash/zsh option; dash `sh` rejects it
 *     and would fail every command. Other shells: no-op.
 *   - only when a check-like command is the UPSTREAM of a real pipe (`|`,
 *     `|&`; never `||`). `ls x | wc -l` keeps its tolerant status.
 *   - pipelines ending in `grep -q` / `rg -q` are skipped: there the model
 *     reads grep's status on purpose (`if pnpm test | grep -q failed; …`).
 *   - a command that already mentions pipefail is left alone.
 * The flag applies to the whole invocation, so other pipelines in the same
 * command also become truthful; that is the intended exit-code semantics.
 */

const CHECK_COMMAND =
	/^(?:\(\s*)?(?:(?:[A-Za-z_][A-Za-z0-9_]*)=(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s+)*(?:time\s+|nice\s+)?(?:(?:pnpm|npm|yarn|bun|npx)\s+(?:run\s+|exec\s+)?(?:test|check|lint|build|typecheck|contracts|coverage|vitest|tsc|eslint|jest)\b|vitest\b|jest\b|tsc\b|cargo\s+(?:test|build|check|clippy)\b|go\s+(?:test|build|vet)\b|pytest\b|python[0-9.]*\s+-m\s+pytest\b|make\b|just\b|\.\/gradlew\b|\.\/mvnw\b|dotnet\s+(?:test|build)\b)/;

/** Last stages whose own exit status is the information the model wants. */
const STATUS_IS_THE_ANSWER = /^(?:grep|rg|ag)\s+(?:-[a-zA-Z]*q[a-zA-Z]*\s|--quiet\s|--silent\s|-c\b|--count\b)/;

const QUOTED = /"(?:[^"\\]|\\.)*"|'[^']*'/g;
/** `||` is gone by now (COMMAND_SPLIT ran), so every remaining `|` is a real pipe. */
const REAL_PIPE = /\|&?/g;
const HAS_PIPE = /\|&?/;
const COMMAND_SPLIT = /(?:&&|\|\||;)/;

function stripQuoted(text: string): string {
	return text.replace(QUOTED, '""');
}

/** True when `command` contains a check-command pipeline without pipefail. */
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

/** The shell argv for one invocation, with `-o pipefail` when supported. */
export function pipefailArgs(shell: string, args: readonly string[]): string[] {
	const base = shell.split("/").at(-1) ?? shell;
	if (base !== "bash" && base !== "zsh") return [...args];
	return ["-o", "pipefail", ...args];
}
