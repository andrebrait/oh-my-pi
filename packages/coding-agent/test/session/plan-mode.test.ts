import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PlanModeController } from "@oh-my-pi/pi-coding-agent/session/plan-mode";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir, type TestSessionOptions } from "../helpers/rpc-server-harness";

const PLAN_ROLE = { modelRoles: { plan: "anthropic/claude-haiku-4-5" } };

function makeTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `Fake ${name}`,
		parameters: type({}),
		async execute() {
			return { content: [{ type: "text" as const, text: "ok" }] };
		},
	};
}

function makeMcpTool(): CustomTool {
	return {
		name: "mcp__ambient_search",
		label: "ambient/search",
		description: "Search ambient data",
		parameters: type({}),
		loadMode: "discoverable",
		mcpServerName: "ambient",
		mcpToolName: "search",
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
}

/** Session options with a built-in `read` (active) and `write` (registered), as plan mode expects. */
function readWriteTools(extra: TestSessionOptions["config"] = {}): TestSessionOptions {
	const read = makeTool("read");
	const write = makeTool("write");
	return {
		settings: PLAN_ROLE,
		tools: [read],
		config: {
			toolRegistry: new Map([
				[read.name, read],
				[write.name, write],
			]),
			builtInToolNames: ["read", "write"],
			...extra,
		},
	};
}

async function withPlanSession(
	options: TestSessionOptions,
	run: (session: AgentSession, planMode: PlanModeController) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, options);
	try {
		await run(session, session.enablePlanMode({}));
	} finally {
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
}

/** A session whose first reply holds mid-stream until `gate` resolves. */
async function withStreamingPlanSession(
	run: (session: AgentSession, planMode: PlanModeController, release: () => Promise<void>) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const gate = Promise.withResolvers<void>();
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, gate.promise, {
		settings: PLAN_ROLE,
	});
	try {
		const planMode = session.enablePlanMode({});
		const streaming = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "message_update") streaming.resolve();
		});
		const turn = session.prompt("hi");
		await withTimeout(streaming.promise, 10_000, "the reply never started streaming");
		unsubscribe();
		expect(session.isStreaming).toBe(true);
		await run(session, planMode, async () => {
			gate.resolve();
			await turn;
			await session.waitForIdle();
		});
	} finally {
		gate.resolve();
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
}

function lastModeChange(session: AgentSession): { mode: string; data?: Record<string, unknown> } | undefined {
	return session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "mode_change")
		.at(-1);
}

describe("session-owned plan mode", () => {
	test("enter switches to the plan role model and plan tools, and journals plan", async () => {
		await withPlanSession(readWriteTools(), async (session, planMode) => {
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.getActiveToolNames()).not.toContain("write");

			const view = await planMode.handle({ op: "enter" });

			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.getActiveToolNames()).toContain("write");
			expect(session.peekPlanProposalHandler()).toBeDefined();
			expect(lastModeChange(session)).toMatchObject({ mode: "plan", data: { planFilePath: "local://PLAN.md" } });
			expect(view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
			expect(planMode.view).toEqual(view);
		});
	});

	test("exit to paused restores the previous model and tools and journals plan_paused", async () => {
		await withPlanSession(readWriteTools(), async (session, planMode) => {
			await planMode.handle({ op: "enter", planFilePath: "local://custom.md" });
			expect(session.getPlanModeState()?.planFilePath).toBe("local://custom.md");

			const view = await planMode.handle({ op: "exit" });

			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(session.getActiveToolNames()).toEqual(["read"]);
			expect(session.getPlanModeState()).toBeUndefined();
			expect(session.peekPlanProposalHandler()).toBeUndefined();
			expect(lastModeChange(session)?.mode).toBe("plan_paused");
			expect(view).toEqual({ enabled: false, paused: true, planFilePath: undefined });
			// A second exit is a no-op.
			expect(await planMode.handle({ op: "exit" })).toEqual(view);
		});
	});

	test("clear after paused journals none and reports a disabled view", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const options = readWriteTools();
		const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, options);
		const views: unknown[] = [];
		try {
			const planMode = session.enablePlanMode({ onChanged: view => views.push(view) });
			await planMode.handle({ op: "enter" });
			await planMode.handle({ op: "exit" });
			const view = await planMode.handle({ op: "clear" });

			expect(lastModeChange(session)?.mode).toBe("none");
			expect(view).toEqual({ enabled: false, paused: false, planFilePath: undefined });
			expect(views).toEqual([
				{ enabled: true, paused: false, planFilePath: "local://PLAN.md" },
				{ enabled: false, paused: true, planFilePath: undefined },
				{ enabled: false, paused: false, planFilePath: undefined },
			]);
			// Clearing ends the plan session: the next entry is not a re-entry.
			await planMode.handle({ op: "enter" });
			expect(session.getPlanModeState()?.reentry).toBe(false);
		} finally {
			await session.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});

	test("entering while a turn streams defers the model switch to the turn end", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");

			await release();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			// The owner flushes at the turn's end (the TUI on agent_end).
			await planMode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-haiku-4-5");
		});
	});

	test("exit drops a deferred plan model switch", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			await planMode.exit({ paused: true });

			await release();
			await planMode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			expect(planMode.view).toEqual({ enabled: false, paused: true, planFilePath: undefined });
		});
	});

	test("exit keeps MCP tools mounted during plan mode", async () => {
		const mcpTool = makeMcpTool();
		const write = makeTool("write");
		let session: AgentSession | undefined;
		const xdev: XdevState = {
			tools: new Map(),
			mountedNames: new Set(),
			builtInNames: new Set(["read", "write"]),
			isActive: name => session?.getActiveToolNames().includes(name) === true,
		};
		const read = makeTool("read");
		xdev.tools.set(read.name, read);
		xdev.tools.set(write.name, write);
		await withPlanSession(
			{
				settings: PLAN_ROLE,
				tools: [read, write],
				config: { toolRegistry: xdev.tools, builtInToolNames: ["read", "write"], xdev },
			},
			async (created, planMode) => {
				session = created;
				await planMode.handle({ op: "enter" });
				await created.refreshMCPTools([mcpTool]);
				expect(created.getEnabledToolNames()).toContain(mcpTool.name);
				expect(created.getMountedXdevToolNames()).toContain(mcpTool.name);

				await planMode.handle({ op: "exit" });

				expect(planMode.view.enabled).toBe(false);
				expect(created.getEnabledToolNames()).toContain(mcpTool.name);
				expect(created.getMountedXdevToolNames()).toContain(mcpTool.name);
			},
		);
	});

	test("a failed tool restore rolls back and keeps plan mode", async () => {
		const rebuildGate = { fail: false };
		const options = readWriteTools({
			rebuildSystemPrompt: async () => {
				if (rebuildGate.fail) throw new Error("rebuild failed");
				return { systemPrompt: ["Test"] };
			},
		});
		await withPlanSession(options, async (session, planMode) => {
			await planMode.handle({ op: "enter" });
			const activeBefore = session.getActiveToolNames();
			rebuildGate.fail = true;

			await expect(planMode.handle({ op: "exit" })).rejects.toThrow("rebuild failed");
			expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.getActiveToolNames()).toEqual(activeBefore);
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(lastModeChange(session)?.mode).toBe("plan");

			rebuildGate.fail = false;
			await planMode.handle({ op: "exit" });
			expect(planMode.view.enabled).toBe(false);
			expect(session.getPlanModeState()).toBeUndefined();
			expect(session.getActiveToolNames()).toEqual(["read"]);
		});
	});

	test("enter is refused while a goal is active", async () => {
		await withPlanSession(readWriteTools(), async (session, planMode) => {
			await session.enableGoalMode({ mode: "interactive", delayMs: 0 }).handle({ op: "create", objective: "ship" });

			await expect(planMode.handle({ op: "enter" })).rejects.toThrow("Exit goal mode first.");
			expect(session.getPlanModeState()).toBeUndefined();
			expect(planMode.view.enabled).toBe(false);
		});
	});

	test("enter is refused while the owner blocks it", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, readWriteTools());
		try {
			const planMode = session.enablePlanMode({ entryBlocked: () => "Exit vibe mode first." });
			await expect(planMode.handle({ op: "enter" })).rejects.toThrow("Exit vibe mode first.");
			expect(session.getPlanModeState()).toBeUndefined();
		} finally {
			await session.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});

	test("enablePlanMode returns the running controller, refuses other options, and never runs on a passive replica", async () => {
		await withPlanSession(readWriteTools(), async (session, planMode) => {
			expect(session.planMode).toBe(planMode);
			expect(() => session.enablePlanMode({ onChanged: () => {} })).toThrow();
		});
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const replica = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, {
			passiveReplica: true,
		});
		try {
			expect(() => replica.enablePlanMode({})).toThrow();
			expect(replica.planMode).toBeUndefined();
		} finally {
			await replica.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});
});
