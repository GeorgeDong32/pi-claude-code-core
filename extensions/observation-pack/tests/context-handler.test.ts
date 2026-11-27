import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { coreBus, resetCoreBusForTests } from "../../bus.ts";
import createObservationPackExtension from "../index.ts";

const THRESHOLD_PLUS = "z".repeat(11 * 1024);

type ContextHandler = (event: unknown, ctx: unknown) => Promise<unknown>;

function captureContextHandler(): { handler: ContextHandler } {
	const handlers: ContextHandler[] = [];
	const pi = {
		registerTool: () => {},
		on: (event: string, handler: ContextHandler) => {
			if (event === "context") handlers.push(handler);
		},
		registerCommand: () => {},
	} as unknown as ExtensionAPI;
	createObservationPackExtension({})(pi);
	return { handler: handlers[0]! };
}

function healthyCtx(root: string): unknown {
	return {
		cwd: root,
		hasUI: false,
		sessionManager: {
			getSessionId: () => "sess-e3c",
			getSessionDir: () => root,
			getSessionFile: () => "",
		},
	};
}

function brokenCtx(): unknown {
	return {
		cwd: "/t",
		hasUI: false,
		sessionManager: {
			getSessionDir: () => {
				throw new Error("host bug: session dir exploded");
			},
		},
	};
}

function largeToolResult(): unknown {
	return {
		role: "toolResult",
		toolCallId: "tc-e3c",
		toolName: "bash",
		isError: false,
		content: [{ type: "text", text: THRESHOLD_PLUS }],
	};
}

test("BH-E3c: a throw inside the context handler fails open — unmodified context, later requests still project", async () => {
	resetCoreBusForTests();
	const { handler } = captureContextHandler();
	const errors: string[] = [];
	const originalError = console.error;
	console.error = ((message?: unknown) => {
		errors.push(String(message));
	}) as typeof console.error;
	try {
		const broken = await handler({ type: "context", messages: [largeToolResult()] }, brokenCtx());
		assert.equal(broken, undefined, "a throwing handler body fails open to the unmodified context");
		assert.equal(errors.length, 1, "the failure is reported once");
		assert.match(errors[0] ?? "", /\[observation-pack\] context projection failed open: host bug/);

		const root = await mkdtemp(join(tmpdir(), "e3c-"));
		await mkdir(join(root, "observation-pack", "sess-e3c"), { recursive: true });
		const ctx = healthyCtx(root);
		const messages = [largeToolResult()];
		let sawPlaceholder = false;
		for (let i = 0; i < 4; i += 1) {
			const result = (await handler({ type: "context", messages }, ctx)) as {
				messages: Array<{ content: Array<{ type: string; text: string }> }>;
			};
			const body = result.messages[0].content[0].text;
			if (i >= 2) {
				assert.match(body, /retrieve: call obs_recall/);
				sawPlaceholder = true;
			} else {
				assert.equal(body, THRESHOLD_PLUS, "the full-send window passes the bytes through");
			}
		}
		assert.ok(sawPlaceholder, "projection still works after the failed request");
	} finally {
		console.error = originalError;
		resetCoreBusForTests();
	}
});
