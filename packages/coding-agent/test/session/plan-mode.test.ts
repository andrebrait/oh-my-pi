import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { type AgentTool, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import { Effort } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { buildPlanReview } from "@oh-my-pi/pi-coding-agent/plan-mode/review";
import { resolvePlanFilePath } from "@oh-my-pi/pi-coding-agent/plan-mode/plan-files";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { PlanModeController, PlanModeOptions } from "@oh-my-pi/pi-coding-agent/session/plan-mode";
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

/** Starts a turn whose reply holds mid-stream; resolves once it streams, with a release that waits for idle. */
type StreamTurn = () => Promise<() => Promise<void>>;

async function withPlanSession(
	options: TestSessionOptions,
	run: (session: AgentSession, planMode: PlanModeController, streamTurn: StreamTurn) => Promise<void>,
	planOptions: PlanModeOptions = {},
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-mode-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const gate = Promise.withResolvers<void>();
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, gate.promise, options);
	const streamTurn: StreamTurn = async () => {
		const streaming = Promise.withResolvers<void>();
		const unsubscribe = session.subscribe(event => {
			if (event.type === "message_update") streaming.resolve();
		});
		const turn = session.prompt("hi");
		await withTimeout(streaming.promise, 10_000, "the reply never started streaming");
		unsubscribe();
		expect(session.isStreaming).toBe(true);
		return async () => {
			gate.resolve();
			await turn;
			await session.waitForIdle();
		};
	};
	try {
		await run(session, session.enablePlanMode(planOptions), streamTurn);
	} finally {
		gate.resolve();
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
}

/** A plan session over a turn that is streaming, held until `release`. */
function withStreamingPlanSession(
	run: (session: AgentSession, planMode: PlanModeController, release: () => Promise<void>) => Promise<void>,
): Promise<void> {
	return withPlanSession({ settings: PLAN_ROLE }, async (session, planMode, streamTurn) =>
		run(session, planMode, await streamTurn()),
	);
}

const modeChanges = (session: AgentSession, mode: string): number =>
	session.sessionManager.getEntries().filter(entry => entry.type === "mode_change" && entry.mode === mode).length;

function lastModeChange(session: AgentSession): { mode: string; data?: Record<string, unknown> } | undefined {
	return session.sessionManager
		.getEntries()
		.filter(entry => entry.type === "mode_change")
		.at(-1);
}

/** Where a plan URL lives on disk in the session's current transcript. */
function planPath(session: AgentSession, planFilePath: string): string {
	return resolvePlanFilePath(planFilePath, {
		localProtocolOptions: {
			getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
			getSessionId: () => session.sessionManager.getSessionId(),
		},
		cwd: session.sessionManager.getCwd(),
	});
}

/** The hidden plan-approved prompts the session has sent. */
const approvedPrompts = (session: AgentSession): string[] =>
	session.messages.map(message => JSON.stringify(message)).filter(text => text.includes("Plan approved."));

const PLAN_URL = "local://ship-plan.md";
const PLAN_TEXT = "# Ship it\n\nStep one.";

/** A plan session whose replies complete at once, in plan mode with {@link PLAN_TEXT} written. */
async function withApprovalSession(
	options: TestSessionOptions,
	run: (session: AgentSession, planMode: PlanModeController) => Promise<void>,
	planOptions: PlanModeOptions = {},
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-approval-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, options);
	try {
		const planMode = session.enablePlanMode(planOptions);
		await planMode.enter({ planFilePath: PLAN_URL });
		await Bun.write(planPath(session, PLAN_URL), PLAN_TEXT);
		await run(session, planMode);
	} finally {
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
}

const DETAILS = { planFilePath: PLAN_URL, title: "ship-it", planExists: true };
const noCompaction = (): Promise<never> => Promise.reject(new Error("unexpected compaction"));
const noNewSession = (): Promise<never> => Promise.reject(new Error("unexpected new session"));

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

	test("entering while a turn streams steers the plan context and switches to the plan model when the turn ends", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");

			// No owner flush: the session feeds the turn's end to the controller.
			await release();
			expect(session.messages.some(m => m.role === "custom" && m.customType === "plan-mode-context")).toBe(true);
			expect(session.model?.id).toBe("claude-haiku-4-5");
		});
	});

	test("a turn end that lands while a fresh turn streams leaves the deferred switch to that turn's end", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			const setModel = vi.spyOn(session, "setModelTemporary");

			// A superseded turn's end: the session already streams the fresh one.
			planMode.observe({ type: "agent_end", messages: [], isTerminal: false });
			expect(setModel).not.toHaveBeenCalled();
			expect(session.model?.id).toBe("claude-sonnet-4-5");

			await release();
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
		await withPlanSession(
			readWriteTools(),
			async (session, planMode) => {
				await expect(planMode.handle({ op: "enter" })).rejects.toThrow("Exit vibe mode first.");
				expect(session.getPlanModeState()).toBeUndefined();
			},
			{ entryBlocked: () => "Exit vibe mode first." },
		);
	});

	test("enter is refused while plan.enabled is off", async () => {
		await withPlanSession({ settings: { "plan.enabled": false } }, async (session, planMode) => {
			await expect(planMode.handle({ op: "enter" })).rejects.toThrow(
				"Plan mode is disabled. Enable it in settings (plan.enabled).",
			);
			expect(session.getPlanModeState()).toBeUndefined();
		});
	});

	test("a second entry after a paused exit is a re-entry", async () => {
		await withPlanSession(readWriteTools(), async (session, planMode) => {
			await planMode.handle({ op: "enter" });
			expect(session.getPlanModeState()?.reentry).toBe(false);
			await planMode.handle({ op: "exit" });
			await planMode.handle({ op: "enter" });
			expect(session.getPlanModeState()?.reentry).toBe(true);
		});
	});

	test("exit mid-turn interrupts the streaming turn", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			await planMode.handle({ op: "exit" });
			expect(planMode.view).toEqual({ enabled: false, paused: true, planFilePath: undefined });
			await release();
			const reply = session.messages.find(message => message.role === "assistant");
			expect(reply && "stopReason" in reply ? reply.stopReason : undefined).toBe("aborted");
		});
	});

	test("exit while a turn streams defers the model restore until the turn ends", async () => {
		await withPlanSession({ settings: PLAN_ROLE }, async (session, planMode, streamTurn) => {
			await planMode.handle({ op: "enter" });
			expect(session.model?.id).toBe("claude-haiku-4-5");
			const release = await streamTurn();

			await planMode.exit({ paused: true });
			expect(session.model?.id).toBe("claude-haiku-4-5");

			await release();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	test("exit with deferModelRestore keeps the plan model until applyDeferredModelTransition, which runs once", async () => {
		await withPlanSession({ settings: PLAN_ROLE }, async (session, planMode) => {
			await planMode.handle({ op: "enter" });
			const haiku = session.model!;
			await planMode.exit({ paused: false, deferModelRestore: true });
			expect(session.model?.id).toBe("claude-haiku-4-5");
			expect(lastModeChange(session)?.mode).toBe("none");

			await planMode.applyDeferredModelTransition();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
			await session.setModelTemporary(haiku);
			await planMode.applyDeferredModelTransition();
			expect(session.model?.id).toBe("claude-haiku-4-5");
		});
	});

	test("applyDeferredModelTransition moves onto the execution model", async () => {
		await withPlanSession({ settings: PLAN_ROLE }, async (session, planMode) => {
			await planMode.handle({ op: "enter" });
			await planMode.exit({ paused: false, deferModelRestore: true });
			const model = getBundledModel("anthropic", "claude-sonnet-4-6")!;

			await planMode.applyDeferredModelTransition({ role: "default", model, explicitThinkingLevel: false });
			expect(session.model?.id).toBe("claude-sonnet-4-6");
		});
	});

	test("reapplyModelOnRoleChange follows a reassigned plan role only while plan mode is on", async () => {
		await withPlanSession({ settings: PLAN_ROLE }, async (session, planMode) => {
			await planMode.handle({ op: "enter" });
			session.settings.setModelRole("plan", "anthropic/claude-sonnet-4-6");
			await planMode.reapplyModelOnRoleChange();
			expect(session.model?.id).toBe("claude-sonnet-4-6");

			await planMode.handle({ op: "exit" });
			session.settings.setModelRole("plan", "anthropic/claude-haiku-4-5");
			await planMode.reapplyModelOnRoleChange();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	test("a plan role reassigned to the current model drops the stale deferred switch", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			session.settings.setModelRole("plan", "anthropic/claude-sonnet-4-5");
			await planMode.reapplyModelOnRoleChange();

			await release();
			await planMode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	test("enter with preserveRestoredModel keeps the current model", async () => {
		await withPlanSession({ settings: PLAN_ROLE }, async (session, planMode) => {
			await planMode.enter({ preserveRestoredModel: true });
			expect(session.getPlanModeState()?.enabled).toBe(true);
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	test("a failed model restore rolls back the plan model and tool presentation", async () => {
		const write = makeTool("write");
		const planSelected = makeTool("plan_selected");
		const read = makeTool("read");
		const mountedTool = makeMcpTool();
		let session: AgentSession | undefined;
		const xdev: XdevState = {
			tools: new Map([
				[read.name, read],
				[write.name, write],
				[planSelected.name, planSelected],
			]),
			mountedNames: new Set(),
			builtInNames: new Set(["read", "write"]),
			isActive: name => session?.getActiveToolNames().includes(name) === true,
		};
		const options: TestSessionOptions = {
			settings: { modelRoles: { plan: "anthropic/claude-haiku-4-5:high" } },
			tools: [read],
			config: { toolRegistry: xdev.tools, builtInToolNames: ["read", "write"], xdev },
		};
		await withPlanSession(options, async (created, planMode) => {
			session = created;
			await planMode.handle({ op: "enter" });
			await created.refreshMCPTools([mountedTool]);
			await created.setActiveToolsByName([...created.getEnabledToolNames(), planSelected.name]);
			const planTools = created.getEnabledToolNames();
			const planActiveTools = created.getActiveToolNames();
			const planMountedTools = created.getMountedXdevToolNames();
			expect(created.model?.id).toBe("claude-haiku-4-5");
			expect(created.configuredThinkingLevel()).toBe(Effort.High);
			expect(planActiveTools).toEqual(["read", "write", planSelected.name]);
			expect(planMountedTools).toEqual([mountedTool.name]);

			const setModelTemporary = created.setModelTemporary.bind(created);
			const restoreModel = vi.spyOn(created, "setModelTemporary").mockImplementationOnce(async (...args) => {
				await setModelTemporary(...args);
				throw new Error("model restore failed after switch");
			});
			await expect(planMode.handle({ op: "exit" })).rejects.toThrow("model restore failed after switch");

			expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
			expect(created.getPlanModeState()?.enabled).toBe(true);
			expect(created.peekPlanProposalHandler()).toBeDefined();
			expect(created.model?.id).toBe("claude-haiku-4-5");
			expect(created.configuredThinkingLevel()).toBe(Effort.High);
			expect(created.getEnabledToolNames()).toEqual(planTools);
			expect(created.getActiveToolNames()).toEqual(planActiveTools);
			expect(created.getMountedXdevToolNames()).toEqual(planMountedTools);

			restoreModel.mockRestore();
			await planMode.handle({ op: "exit" });
			expect(created.getPlanModeState()).toBeUndefined();
			expect(created.model?.id).toBe("claude-sonnet-4-5");
			expect(created.getActiveToolNames()).toContain(mountedTool.name);
			expect(created.getActiveToolNames()).not.toContain(planSelected.name);
		});
	});

	test("enter drops a shadowing extension write and warns the owner", async () => {
		const read = makeTool("read");
		const shadowWrite = makeTool("write");
		const warnings: string[] = [];
		await withPlanSession(
			{
				settings: PLAN_ROLE,
				tools: [read, shadowWrite],
				config: {
					toolRegistry: new Map([
						[read.name, read],
						[shadowWrite.name, shadowWrite],
					]),
					builtInToolNames: ["read"],
				},
			},
			async (session, planMode) => {
				expect(session.getActiveToolNames()).toContain("write");
				await planMode.handle({ op: "enter" });
				expect(session.getActiveToolNames()).not.toContain("write");
				expect(warnings).toEqual([
					"Plan mode: the `write` tool is provided by an extension and cannot submit plans. Disable it to use plan mode.",
				]);
			},
			{ onWarning: text => warnings.push(text) },
		);
	});

	test("dispose drops a deferred model switch", async () => {
		await withStreamingPlanSession(async (session, planMode, release) => {
			await planMode.handle({ op: "enter" });
			planMode.dispose();

			await release();
			await planMode.flushPendingModelSwitch();
			expect(session.model?.id).toBe("claude-sonnet-4-5");
		});
	});

	test("a failed enter rolls back and leaves the view, journal and session as they were", async () => {
		const rebuildGate = { fail: false };
		const views: unknown[] = [];
		const options = readWriteTools({
			rebuildSystemPrompt: async () => {
				if (rebuildGate.fail) throw new Error("rebuild failed");
				return { systemPrompt: ["Test"] };
			},
		});
		await withPlanSession(
			options,
			async (session, planMode) => {
				await planMode.handle({ op: "enter" });
				await planMode.handle({ op: "exit" });
				const before = planMode.view;
				const tools = session.getActiveToolNames();
				const entries = session.sessionManager.getEntries().length;
				const changes = views.length;
				rebuildGate.fail = true;

				await expect(planMode.handle({ op: "enter", planFilePath: "local://b.md" })).rejects.toThrow(
					"rebuild failed",
				);
				expect(before).toEqual({ enabled: false, paused: true, planFilePath: undefined });
				expect(planMode.view).toEqual(before);
				expect(session.getPlanModeState()).toBeUndefined();
				expect(session.peekPlanProposalHandler()).toBeUndefined();
				expect(session.getActiveToolNames()).toEqual(tools);
				expect(session.model?.id).toBe("claude-sonnet-4-5");
				expect(session.sessionManager.getEntries().length).toBe(entries);
				expect(views.length).toBe(changes);

				rebuildGate.fail = false;
				await planMode.handle({ op: "enter" });
				expect(session.getPlanModeState()?.reentry).toBe(true);
			},
			{ onChanged: view => views.push(view) },
		);
	});

	test("concurrent exits run one at a time and journal one plan_paused", async () => {
		const views: unknown[] = [];
		await withPlanSession(
			readWriteTools(),
			async (session, planMode) => {
				await planMode.handle({ op: "enter" });
				const [first, second] = await Promise.all([
					planMode.handle({ op: "exit" }),
					planMode.handle({ op: "exit" }),
				]);
				expect(first).toEqual({ enabled: false, paused: true, planFilePath: undefined });
				expect(second).toEqual(first);
				expect(modeChanges(session, "plan_paused")).toBe(1);
				expect(views.length).toBe(2);
			},
			{ onChanged: view => views.push(view) },
		);
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

	describe("session changes", () => {
		test("resuming a session journaled in plan re-enters plan mode keeping the restored model", async () => {
			await withPlanSession(readWriteTools(), async (session, planMode) => {
				session.sessionManager.appendModeChange("plan", { planFilePath: "local://resumed.md" });

				await planMode.reconcile();

				expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://resumed.md" });
				expect(session.getPlanModeState()?.planFilePath).toBe("local://resumed.md");
				expect(session.getActiveToolNames()).toContain("write");
				expect(session.model?.id).toBe("claude-sonnet-4-5");
			});
		});

		test("resuming a plan_paused session reports a paused view without entering", async () => {
			await withPlanSession(readWriteTools(), async (session, planMode) => {
				session.sessionManager.appendModeChange("plan_paused");

				await planMode.reconcile();

				expect(planMode.view).toEqual({ enabled: false, paused: true, planFilePath: undefined });
				expect(session.getPlanModeState()).toBeUndefined();
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(session.model?.id).toBe("claude-sonnet-4-5");
				await planMode.handle({ op: "enter" });
				expect(session.getPlanModeState()?.reentry).toBe(true);
			});
		});

		test("a stale plan entry is closed with none when plan.enabled is off", async () => {
			await withPlanSession({ settings: { "plan.enabled": false } }, async (session, planMode) => {
				session.sessionManager.appendModeChange("plan", { planFilePath: "local://stale.md" });

				await planMode.reconcile();

				expect(lastModeChange(session)?.mode).toBe("none");
				expect(planMode.view).toEqual({ enabled: false, paused: false, planFilePath: undefined });
				expect(session.getPlanModeState()).toBeUndefined();
			});
		});

		test("new session leaves plan mode; the owner's applyStartupDefault enters it again", async () => {
			await withPlanSession(
				{ ...readWriteTools(), settings: { ...PLAN_ROLE, "plan.defaultOnStartup": true } },
				async (session, planMode) => {
					await planMode.applyStartupDefault();
					expect(planMode.view.enabled).toBe(true);
					const firstSession = session.sessionManager.getSessionId();

					expect(await session.newSession()).toBe(true);

					expect(session.sessionManager.getSessionId()).not.toBe(firstSession);
					expect(planMode.view).toEqual({ enabled: false, paused: false, planFilePath: undefined });
					expect(session.getPlanModeState()).toBeUndefined();
					expect(session.getActiveToolNames()).toEqual(["read"]);
					// The new session records no model, so the pre-plan model comes back.
					expect(session.model?.id).toBe("claude-sonnet-4-5");

					await planMode.applyStartupDefault();
					expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
					expect(lastModeChange(session)?.mode).toBe("plan");
					expect(session.getActiveToolNames()).toContain("write");
					expect(session.model?.id).toBe("claude-haiku-4-5");
				},
			);
		});

		test("branching at the first message does not apply plan.defaultOnStartup", async () => {
			await withPlanSession(
				{ ...readWriteTools(), settings: { ...PLAN_ROLE, "plan.defaultOnStartup": true } },
				async (session, planMode, streamTurn) => {
					await (
						await streamTurn()
					)();
					const first = session.sessionManager.getEntries().find(entry => entry.type === "message");
					if (!first) throw new Error("no message to branch at");

					expect((await session.branch(first.id)).cancelled).toBe(false);

					expect(session.sessionManager.buildSessionContext().messages).toHaveLength(0);
					expect(planMode.view.enabled).toBe(false);
					expect(session.getPlanModeState()).toBeUndefined();
				},
			);
		});

		test("applyStartupDefault does nothing when plan.defaultOnStartup or plan.enabled is off", async () => {
			for (const settings of [
				{ ...PLAN_ROLE, "plan.defaultOnStartup": false },
				{ ...PLAN_ROLE, "plan.defaultOnStartup": true, "plan.enabled": false },
			]) {
				await withPlanSession({ ...readWriteTools(), settings }, async (session, planMode) => {
					await planMode.applyStartupDefault();
					expect(planMode.view.enabled).toBe(false);
					expect(session.getPlanModeState()).toBeUndefined();
				});
			}
		});

		test("applyStartupDefault leaves a session with conversation context or an explicit mode", async () => {
			const options = { ...readWriteTools(), settings: { ...PLAN_ROLE, "plan.defaultOnStartup": true } };
			await withPlanSession(options, async (_session, planMode, streamTurn) => {
				await (
					await streamTurn()
				)();
				await planMode.applyStartupDefault();
				expect(planMode.view.enabled).toBe(false);
			});
			await withPlanSession(options, async (session, planMode) => {
				session.sessionManager.appendModeChange("none");
				await planMode.applyStartupDefault();
				expect(planMode.view.enabled).toBe(false);
			});
		});

		test("a goal live in the previous session leaves before the target's plan mode is restored", async () => {
			const options = readWriteTools({ allowSessionModelFallback: true });
			await withPlanSession(options, async (session, planMode, streamTurn) => {
				const goalMode = session.enableGoalMode({ mode: "interactive", delayMs: 0 });
				await (
					await streamTurn()
				)();
				session.sessionManager.appendModeChange("plan", { planFilePath: "local://b.md" });
				const planSession = session.sessionFile;
				if (!planSession) throw new Error("the plan session has no file");
				expect(await session.newSession()).toBe(true);
				await goalMode.handle({ op: "create", objective: "live goal" });

				expect(await session.switchSession(planSession)).toBe(true);

				expect(session.getGoalModeState()?.goal).toBeUndefined();
				expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://b.md" });
			});
		});

		test("switching to a session that records a model keeps that model, not the pre-plan one", async () => {
			const options = readWriteTools({ allowSessionModelFallback: true });
			await withPlanSession(options, async (session, planMode, streamTurn) => {
				await (
					await streamTurn()
				)();
				await session.setModel(getBundledModel("anthropic", "claude-sonnet-4-6")!);
				const recorded = session.sessionFile;
				if (!recorded) throw new Error("the recorded session has no file");
				expect(await session.newSession()).toBe(true);
				await session.setModelTemporary(getBundledModel("anthropic", "claude-sonnet-4-5")!);
				await planMode.handle({ op: "enter" });
				expect(session.model?.id).toBe("claude-haiku-4-5");

				expect(await session.switchSession(recorded)).toBe(true);

				expect(planMode.view.enabled).toBe(false);
				expect(session.model?.id).toBe("claude-sonnet-4-6");
			});
		});

		test("a cancelled session change leaves plan mode as it was", async () => {
			const views: unknown[] = [];
			await withPlanSession(
				{
					...readWriteTools(),
					extensionFactory: pi => {
						pi.on("session_before_switch", async () => ({ cancel: true }));
					},
				},
				async (session, planMode) => {
					await planMode.handle({ op: "enter" });
					const changes = views.length;

					expect(await session.newSession()).toBe(false);

					expect(views.length).toBe(changes);
					expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
					expect(session.model?.id).toBe("claude-haiku-4-5");
					// The pre-plan model is still recorded: exit restores it.
					await planMode.handle({ op: "exit" });
					expect(session.model?.id).toBe("claude-sonnet-4-5");
				},
				{ onChanged: view => views.push(view) },
			);
		});

		test("a switch that rolls back restores plan mode in the session it stays in", async () => {
			await withPlanSession(readWriteTools(), async (session, planMode, streamTurn) => {
				// The replied turn journals the mock model, which the registry cannot restore.
				await (
					await streamTurn()
				)();
				const unrestorable = session.sessionFile;
				if (!unrestorable) throw new Error("the target session has no file");
				expect(await session.newSession()).toBe(true);
				await planMode.handle({ op: "enter", planFilePath: "local://kept.md" });

				await expect(session.switchSession(unrestorable)).rejects.toThrow("Could not restore model");

				expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://kept.md" });
				expect(session.getPlanModeState()?.enabled).toBe(true);
				expect(session.getActiveToolNames()).toContain("write");
			});
		});

		test("a session change that fails to restore plan mode warns instead of throwing", async () => {
			const warnings: string[] = [];
			await withPlanSession(
				readWriteTools(),
				async (session, planMode) => {
					const started = await session.newSession({
						setup: async sessionManager => {
							sessionManager.appendModeChange("plan", { planFilePath: "local://blocked.md" });
						},
					});

					expect(started).toBe(true);
					expect(planMode.view.enabled).toBe(false);
					expect(warnings).toEqual(["Failed to restore plan mode: Exit vibe mode first."]);
				},
				{ entryBlocked: () => "Exit vibe mode first.", onWarning: text => warnings.push(text) },
			);
		});

		test("a journaled plan path that is not a string falls back to the default", async () => {
			await withPlanSession(readWriteTools(), async (session, planMode) => {
				session.sessionManager.appendModeChange("plan", { planFilePath: 42 });
				await planMode.reconcile();
				expect(planMode.view).toEqual({ enabled: true, paused: false, planFilePath: "local://PLAN.md" });
			});
		});

		test("switching to a session whose journal holds a goal tears plan down and does not re-enter", async () => {
			// The replied turn journals the mock model, which the registry cannot restore.
			const options = readWriteTools({ allowSessionModelFallback: true });
			await withPlanSession(options, async (session, planMode, streamTurn) => {
				const goalMode = session.enableGoalMode({ mode: "interactive", delayMs: 0 });
				// A replied turn makes the session file exist, so it can be switched back to.
				await (
					await streamTurn()
				)();
				const goal = {
					id: "journaled",
					objective: "ship",
					status: "paused",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 0,
					updatedAt: 0,
				};
				session.sessionManager.appendModeChange("goal_paused", { goal });
				const goalSession = session.sessionFile;
				if (!goalSession) throw new Error("the goal session has no file");
				expect(await session.newSession()).toBe(true);
				await planMode.handle({ op: "enter" });
				expect(session.getActiveToolNames()).toContain("write");

				expect(await session.switchSession(goalSession)).toBe(true);

				expect(planMode.view).toEqual({ enabled: false, paused: false, planFilePath: undefined });
				expect(session.getPlanModeState()).toBeUndefined();
				expect(session.peekPlanProposalHandler()).toBeUndefined();
				expect(session.getActiveToolNames()).not.toContain("write");
				expect(session.getGoalModeState()?.goal).toMatchObject({ objective: "ship", status: "paused" });
				expect(lastModeChange(session)?.mode).toBe("goal_paused");
				// Goal mode adopted the pre-plan tools: leaving the goal must not bring plan's `write` back.
				await goalMode.handle({ op: "drop" });
				expect(session.getActiveToolNames()).toEqual(["read"]);
			});
		});
	});

	describe("approval", () => {
		test("approve execute starts a new session, sets the plan reference and sends the approved prompt", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const firstSession = session.sessionManager.getSessionId();
				const review = buildPlanReview(session, DETAILS);
				let messagesAtDispatch: number | undefined;
				await Bun.write(planPath(session, "local://notes.md"), "notes");

				const result = await planMode.approve({
					review,
					choice: "execute",
					hooks: {
						newSession: async () => {
							await session.newSession();
						},
						compact: noCompaction,
						beforeDispatch: () => {
							messagesAtDispatch = session.messages.length;
						},
					},
				});

				expect(result).toEqual({ dispatched: true, savedPlanPath: undefined });
				expect(session.sessionManager.getSessionId()).not.toBe(firstSession);
				expect(planMode.view).toEqual({ enabled: false, paused: false, planFilePath: undefined });
				expect(session.getPlanModeState()).toBeUndefined();
				expect(session.getPlanReferencePath()).toBe(PLAN_URL);
				// The plan travels to the new session's local root.
				expect(await Bun.file(planPath(session, PLAN_URL)).text()).toBe(PLAN_TEXT);
				// …with the other session-local artifacts.
				expect(await Bun.file(planPath(session, "local://notes.md")).text()).toBe("notes");
				expect(session.sessionManager.getSessionName()).toBe("Ship it");
				expect(session.model?.id).toBe("claude-sonnet-4-5");
				expect(session.getActiveToolNames()).toEqual(["read"]);
				expect(messagesAtDispatch).toBe(0);
				const [approved, ...rest] = approvedPrompts(session);
				expect(rest).toEqual([]);
				expect(approved).toContain("Step one.");
				expect(approved).not.toContain("History usable");
			});
		});

		test("approve execute does not re-enter plan mode on the new session", async () => {
			await withApprovalSession(
				{ ...readWriteTools(), settings: { ...PLAN_ROLE, "plan.defaultOnStartup": true } },
				async (session, planMode) => {
					const result = await planMode.approve({
						review: buildPlanReview(session, DETAILS),
						choice: "execute",
						hooks: {
							newSession: async () => {
								await session.newSession();
							},
							compact: noCompaction,
						},
					});

					expect(result.dispatched).toBe(true);
					expect(planMode.view.enabled).toBe(false);
					expect(session.getPlanModeState()).toBeUndefined();
					expect(modeChanges(session, "plan")).toBe(0);
					expect(session.getActiveToolNames()).not.toContain("write");
				},
			);
		});

		test("approve execute runs the plan in the current session when the owner starts no new one", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const firstSession = session.sessionManager.getSessionId();
				const result = await planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "execute",
					hooks: { newSession: async () => {}, compact: noCompaction },
				});

				expect(result).toEqual({ dispatched: true, savedPlanPath: undefined });
				expect(session.sessionManager.getSessionId()).toBe(firstSession);
				expect(await Bun.file(planPath(session, PLAN_URL)).text()).toBe(PLAN_TEXT);
				expect(session.getPlanReferencePath()).toBe(PLAN_URL);
				const [approved, ...rest] = approvedPrompts(session);
				expect(rest).toEqual([]);
				expect(approved).not.toContain("History usable");
			});
		});

		test("approve compact passes the plan-compact instructions and keeps the transcript", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const firstSession = session.sessionManager.getSessionId();
				const seen: Record<string, string | undefined> = {};
				// The reviewed plan can be a newer draft than the one plan mode was entered with.
				const reviewed = "local://reviewed-plan.md";
				await Bun.write(planPath(session, reviewed), PLAN_TEXT);

				const result = await planMode.approve({
					review: buildPlanReview(session, { ...DETAILS, planFilePath: reviewed }),
					choice: "compact",
					hooks: {
						newSession: noNewSession,
						compact: async (instructions, beforeFlush) => {
							seen.instructions = instructions;
							seen.reference = session.getPlanReferencePath();
							seen.compactingOn = session.model?.id;
							await beforeFlush("ok");
							seen.flushedOn = session.model?.id;
							return "ok";
						},
					},
				});

				expect(result.dispatched).toBe(true);
				expect(seen.instructions).toContain("Prepare to execute approved plan");
				expect(seen.instructions).toContain(reviewed);
				// The reference is pinned before compaction, so input queued meanwhile sees the plan.
				expect(seen.reference).toBe(reviewed);
				// Compaction runs on the plan model; queued input after it runs on the execution model.
				expect(seen.compactingOn).toBe("claude-haiku-4-5");
				expect(seen.flushedOn).toBe("claude-sonnet-4-5");
				expect(session.sessionManager.getSessionId()).toBe(firstSession);
				expect(planMode.view.enabled).toBe(false);
				const [approved] = approvedPrompts(session);
				expect(approved).toContain("History usable");
			});
		});

		test("approve compact silences the internal abort through the compaction and clears it after", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const mark = vi.spyOn(session, "markPlanInternalAbortPending");
				const clear = vi.spyOn(session, "clearPlanInternalAbortPending");
				const during: number[] = [];

				const approval = planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "compact",
					hooks: {
						newSession: noNewSession,
						compact: async () => {
							during.push(mark.mock.calls.length, clear.mock.calls.length);
							throw new Error("compaction blew up");
						},
					},
				});

				await expect(approval).rejects.toThrow("compaction blew up");
				expect(during).toEqual([1, 0]);
				expect(clear).toHaveBeenCalledTimes(1);
				expect(approvedPrompts(session)).toEqual([]);
			});
		});

		test("approve keep does not mark an internal abort", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const mark = vi.spyOn(session, "markPlanInternalAbortPending");
				await planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "keep",
					hooks: { newSession: noNewSession, compact: noCompaction },
				});
				expect(mark).not.toHaveBeenCalled();
			});
		});

		test("approve with a cancelled compaction leaves plan mode, sends nothing and warns", async () => {
			const warnings: string[] = [];
			await withApprovalSession(
				readWriteTools(),
				async (session, planMode) => {
					const result = await planMode.approve({
						review: buildPlanReview(session, DETAILS),
						choice: "compact",
						hooks: {
							newSession: noNewSession,
							compact: async (_instructions, beforeFlush) => {
								await beforeFlush("cancelled");
								return "cancelled";
							},
						},
					});

					expect(result).toEqual({ dispatched: false, savedPlanPath: undefined });
					expect(approvedPrompts(session)).toEqual([]);
					expect(warnings).toEqual([
						"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
					]);
					// Only the compaction was cancelled, not the approval: the next turn runs the plan.
					expect(planMode.view.enabled).toBe(false);
					expect(session.getPlanReferencePath()).toBe(PLAN_URL);
					expect(session.model?.id).toBe("claude-sonnet-4-5");
					expect(session.getActiveToolNames()).toEqual(["read"]);
				},
				{ onWarning: text => warnings.push(text) },
			);
		});

		test("approve with a failed compaction stays on the plan model and still dispatches", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const result = await planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "compact",
					hooks: {
						newSession: noNewSession,
						compact: async (_instructions, beforeFlush) => {
							await beforeFlush("failed");
							return "failed";
						},
					},
				});

				expect(result.dispatched).toBe(true);
				expect(session.model?.id).toBe("claude-haiku-4-5");
				expect(approvedPrompts(session)).toHaveLength(1);
			});
		});

		test("approve queues the approved prompt behind a turn that is already running", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const prompt = vi.spyOn(session, "prompt");
				const followUp = vi.spyOn(session, "followUp").mockResolvedValue();
				try {
					const result = await planMode.approve({
						review: buildPlanReview(session, DETAILS),
						choice: "keep",
						hooks: {
							newSession: noNewSession,
							compact: noCompaction,
							// Input queued during compaction started a turn right before dispatch.
							beforeDispatch: () => {
								Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
							},
						},
					});

					expect(result.dispatched).toBe(true);
					expect(prompt).not.toHaveBeenCalled();
					expect(followUp).toHaveBeenCalledTimes(1);
					expect(followUp.mock.calls[0]?.[0]).toContain("Plan approved.");
					expect(followUp.mock.calls[0]?.slice(1)).toEqual([undefined, { synthetic: true }]);
				} finally {
					Reflect.deleteProperty(session, "isStreaming");
				}
			});
		});

		test("approve falls back to a follow-up when the prompt finds the agent busy", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const prompt = vi.spyOn(session, "prompt").mockRejectedValueOnce(new AgentBusyError());
				const followUp = vi.spyOn(session, "followUp").mockResolvedValue();

				const result = await planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "keep",
					hooks: { newSession: noNewSession, compact: noCompaction },
				});

				expect(result.dispatched).toBe(true);
				expect(prompt).toHaveBeenCalledTimes(1);
				expect(followUp).toHaveBeenCalledTimes(1);
				expect(followUp.mock.calls[0]?.[0]).toBe(prompt.mock.calls[0]?.[0]);
				expect(followUp.mock.calls[0]?.slice(1)).toEqual([undefined, { synthetic: true }]);
			});
		});

		test("approve keep turns read back on, keeps an existing name and reports the autosaved copy", async () => {
			const bash = makeTool("bash");
			const read = makeTool("read");
			const write = makeTool("write");
			const options: TestSessionOptions = {
				settings: { ...PLAN_ROLE, "plan.autosave": true, "plan.autosaveDir": "saved-plans" },
				tools: [bash],
				config: {
					toolRegistry: new Map([
						[bash.name, bash],
						[read.name, read],
						[write.name, write],
					]),
					builtInToolNames: ["bash", "read", "write"],
				},
			};
			await withApprovalSession(options, async (session, planMode) => {
				await session.sessionManager.setSessionName("Mine", "auto");

				const announced: string[] = [];
				const result = await planMode.approve({
					review: buildPlanReview(session, DETAILS),
					choice: "keep",
					hooks: {
						newSession: noNewSession,
						compact: noCompaction,
						onPlanSaved: savedPlanPath => announced.push(savedPlanPath),
					},
				});

				expect(result.dispatched).toBe(true);
				// The durable plan copy must stay readable even though planning started without `read`.
				expect(session.getActiveToolNames()).toEqual(["bash", "read"]);
				expect(session.sessionManager.getSessionName()).toBe("Mine");
				const saved = result.savedPlanPath;
				if (!saved) throw new Error("the plan was not autosaved");
				expect(path.dirname(saved)).toBe(path.join(session.sessionManager.getCwd(), "saved-plans"));
				expect(await Bun.file(saved).text()).toBe(PLAN_TEXT);
				expect(announced).toEqual([saved]);
			});
		});

		test("a failed autosave warns and the plan still runs", async () => {
			const warnings: string[] = [];
			await withApprovalSession(
				{ ...readWriteTools(), settings: { ...PLAN_ROLE, "plan.autosave": true, "plan.autosaveDir": "blocker" } },
				async (session, planMode) => {
					// A file where the autosave directory should be.
					await Bun.write(path.join(session.sessionManager.getCwd(), "blocker"), "");

					const result = await planMode.approve({
						review: buildPlanReview(session, DETAILS),
						choice: "keep",
						hooks: { newSession: noNewSession, compact: noCompaction },
					});

					expect(result).toEqual({ dispatched: true, savedPlanPath: undefined });
					expect(warnings).toHaveLength(1);
					expect(warnings[0]).toStartWith("Failed to autosave plan: ");
					expect(approvedPrompts(session)).toHaveLength(1);
				},
				{ onWarning: text => warnings.push(text) },
			);
		});

		test("approve keep runs on the selected tier, and the restored tier keeps the pre-plan model", async () => {
			const roles = {
				modelRoles: {
					plan: "anthropic/claude-haiku-4-5",
					smol: "anthropic/claude-haiku-4-5",
					default: "anthropic/claude-opus-4-5",
					slow: "anthropic/claude-sonnet-4-5",
				},
			};
			for (const [tierIndex, model, role, announced] of [
				[undefined, "claude-opus-4-5", "default", ["default"]],
				[2, "claude-sonnet-4-5", "temporary", []],
				[0, "claude-haiku-4-5", "smol", ["smol"]],
			] as const) {
				await withApprovalSession({ ...readWriteTools(), settings: roles }, async (session, planMode) => {
					const firstSession = session.sessionManager.getSessionId();
					const review = buildPlanReview(session, DETAILS);
					expect(review.restoredTierIndex).toBe(2);
					const applied: string[] = [];

					const result = await planMode.approve({
						review,
						choice: "keep",
						tierIndex,
						hooks: {
							newSession: noNewSession,
							compact: noCompaction,
							onExecutionModel: executionModel => applied.push(executionModel.role),
						},
					});

					expect(result.dispatched).toBe(true);
					expect(session.sessionManager.getSessionId()).toBe(firstSession);
					expect(session.model?.id).toBe(model);
					// The restored tier is not applied again: exit's temporary restore is the last switch.
					expect(session.sessionManager.getLastModelChangeRole()).toBe(role);
					expect(applied).toEqual([...announced]);
					expect(approvedPrompts(session)[0]).toContain("History usable");
				});
			}
		});

		test("a tier switch that fails is warned and not reported as the execution model", async () => {
			const warnings: string[] = [];
			// The review starts on `default` (opus); the pre-plan model is sonnet, so approval switches.
			const settings = {
				modelRoles: {
					plan: "anthropic/claude-haiku-4-5",
					default: "anthropic/claude-opus-4-5",
					slow: "anthropic/claude-sonnet-4-5",
				},
			};
			for (const choice of ["keep", "compact"] as const) {
				await withApprovalSession(
					{ ...readWriteTools(), settings },
					async (session, planMode) => {
						vi.spyOn(session, "applyRoleModel").mockRejectedValue(new Error("boom"));
						const applied: string[] = [];

						const result = await planMode.approve({
							review: buildPlanReview(session, DETAILS),
							choice,
							hooks: {
								newSession: noNewSession,
								compact: async (_instructions, beforeFlush) => {
									await beforeFlush("ok");
									return "ok";
								},
								onExecutionModel: executionModel => applied.push(executionModel.role),
							},
						});

						expect(result.dispatched).toBe(true);
						expect(applied).toEqual([]);
					},
					{ onWarning: text => warnings.push(text) },
				);
			}
			expect(warnings).toEqual([
				"Could not switch to the default model: boom",
				"Could not switch to the default model: boom",
			]);
		});

		test("approve is refused outside plan mode", async () => {
			await withApprovalSession(readWriteTools(), async (session, planMode) => {
				const review = buildPlanReview(session, DETAILS);
				await planMode.exit({ paused: true });

				await expect(
					planMode.approve({
						review,
						choice: "keep",
						hooks: { newSession: noNewSession, compact: noCompaction },
					}),
				).rejects.toThrow("Plan mode is not active.");
				expect(approvedPrompts(session)).toEqual([]);
			});
		});
	});
});
