import { describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import {
	RpcSessionSettleWatcher,
	watchedScheduledTurnProbe,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { GoalModeController, type GoalModeSession } from "@oh-my-pi/pi-coding-agent/session/goal-mode";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isSessionSettled, type SessionSettleState } from "@oh-my-pi/pi-coding-agent/session/session-settle";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir } from "../helpers/rpc-server-harness";

function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** A real session with goal mode enabled for `--mode rpc` (continuation only when `continuation`). */
async function withGoalSession(
	continuation: boolean,
	run: (session: AgentSession, goalMode: GoalModeController) => Promise<void>,
): Promise<void> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-goal-ops-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const session = await createTestSession(
		dir,
		{ handler: { content: ["ok"] } },
		undefined,
		continuation ? { settings: { "goal.continuationModes": ["rpc"] } } : {},
	);
	try {
		await run(session, session.enableGoalMode({ mode: "rpc", delayMs: 0 }));
	} finally {
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
}

/** Resolves after `count` terminal `agent_end` events from now. */
function terminalAgentEnds(session: AgentSession, count: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	let seen = 0;
	const unsubscribe = session.subscribe(event => {
		if (event.type !== "agent_end" || event.isTerminal === false || ++seen < count) return;
		unsubscribe();
		resolve();
	});
	return withTimeout(promise, 15_000, `${count} terminal agent_end never arrived`);
}

const continuations = (session: AgentSession): number =>
	session.messages.filter(message => message.role === "custom" && message.customType === "goal-continuation").length;

describe("session-owned goal mode", () => {
	test("an in-process abort stops a scheduled continuation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-goal-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const session = await createTestSession(dir, { handler: { content: ["ok"] } });
		vi.useFakeTimers();
		try {
			// Default settings: `goal.continuationModes` is ["interactive"].
			const controller = session.enableGoalMode({ mode: "interactive", delayMs: 800 });
			expect(session.goalMode).toBe(controller);
			await controller.handle({ op: "create", objective: "keep going" });
			expect(controller.continuationPending).toBe(true);
			// Esc in the TUI, RPC abort, or an extension: whoever calls it, the scheduled turn is void.
			await session.abort({ reason: USER_INTERRUPT_LABEL });
			expect(controller.continuationPending).toBe(false);
			vi.advanceTimersByTime(800);
			await nextMacrotask();
			expect(
				session.messages.filter(message => message.role === "custom" && message.customType === "goal-continuation"),
			).toEqual([]);
		} finally {
			vi.useRealTimers();
			await session.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});

	test("a passive replica never runs goal mode", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-goal-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, {
			passiveReplica: true,
		});
		try {
			expect(() => session.enableGoalMode({ mode: "interactive", delayMs: 800 })).toThrow();
			expect(session.goalMode).toBeUndefined();
		} finally {
			await session.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});

	test("enableGoalMode returns the running controller and refuses different options", async () => {
		await withGoalSession(false, async (session, goalMode) => {
			expect(session.enableGoalMode({ mode: "rpc", delayMs: 0 })).toBe(goalMode);
			expect(() => session.enableGoalMode({ mode: "interactive", delayMs: 800 })).toThrow();
			expect(() => session.enableGoalMode({ mode: "rpc", delayMs: 800 })).toThrow();
		});
	});

	test("disposing the session voids a scheduled continuation", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-goal-mode-"));
		const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
		const session = await createTestSession(dir, { handler: { content: ["ok"] } });
		vi.useFakeTimers();
		try {
			const controller = session.enableGoalMode({ mode: "interactive", delayMs: 800 });
			await controller.handle({ op: "create", objective: "keep going" });
			expect(controller.continuationPending).toBe(true);
			await session.dispose();
			expect(controller.continuationPending).toBe(false);
		} finally {
			vi.useRealTimers();
			await session.dispose();
			restoreAgentDir();
			await removeWithRetries(dir);
		}
	});

	test("a completed goal is journaled after its agent_end reached the subscribers", async () => {
		await withGoalSession(false, async (session, goalMode) => {
			await goalMode.handle({ op: "create", objective: "finish it" });
			await session.goalRuntime.completeGoalFromTool();
			const order: string[] = [];
			session.subscribe(event => {
				if (event.type === "agent_end" && event.isTerminal !== false) order.push("agent_end");
			});
			session.sessionManager.subscribeEntryAppended(entry => {
				if (entry.type === "mode_change") order.push("mode_change");
			});
			const turn = terminalAgentEnds(session, 1);
			await session.prompt("wrap up");
			await turn;
			await goalMode.settled();
			expect(order).toEqual(["agent_end", "mode_change"]);
			expect(session.getGoalModeState()).toBeUndefined();
		});
	});

	test("a direct newSession leaves the goal behind and starts no continuation", async () => {
		await withGoalSession(true, async (session, goalMode) => {
			await goalMode.handle({ op: "create", objective: "belongs to the first session" });
			// Decided, not yet admitted: the change voids it.
			expect(goalMode.continuationPending).toBe(true);
			expect(await session.newSession()).toBe(true);
			await nextMacrotask();
			await session.waitForIdle();
			expect(session.getGoalModeState()).toBeUndefined();
			expect(goalMode.continuationPending).toBe(false);
			expect(continuations(session)).toBe(0);
		});
	});

	test("newSession runs its setup inside the goal hold, so the reattach sees what setup journaled", async () => {
		await withGoalSession(false, async (session, goalMode) => {
			await goalMode.handle({ op: "create", objective: "left behind" });
			const goal = {
				id: "set-up",
				objective: "journaled by setup",
				status: "paused",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			};
			expect(
				await session.newSession({
					setup: async sessionManager => {
						sessionManager.appendModeChange("goal_paused", { goal });
					},
				}),
			).toBe(true);
			expect(session.getGoalModeState()?.goal).toMatchObject({ objective: "journaled by setup", status: "paused" });
		});
	});

	test("a same-session navigateTree holds a scheduled continuation and resumes it exactly once", async () => {
		await withGoalSession(true, async (session, goalMode) => {
			const first = terminalAgentEnds(session, 1);
			await session.prompt("first");
			await first;
			const continued = terminalAgentEnds(session, 1);
			await goalMode.handle({ op: "create", objective: "keep going" });
			const leaf = session.sessionManager.getLeafId();
			if (!leaf) throw new Error("no leaf to navigate to");
			expect((await session.navigateTree(leaf)).cancelled).toBe(false);
			await continued;
			// That continuation made no progress, so nothing follows it.
			await nextMacrotask();
			await session.waitForIdle();
			expect(continuations(session)).toBe(1);
			expect(goalMode.continuationPending).toBe(false);
		});
	});
});

describe("goal ops", () => {
	const userTexts = (session: AgentSession): string[] =>
		session.messages.flatMap(message => (message.role === "user" ? [JSON.stringify(message.content)] : []));

	test("create with submitObjective submits the objective as one user prompt before any continuation", async () => {
		await withGoalSession(true, async (session, goalMode) => {
			// The objective's own turn, then one continuation that makes no progress.
			const turns = terminalAgentEnds(session, 2);
			await goalMode.handle({ op: "create", objective: "ship the release", submitObjective: true });
			await turns;
			// User turns and hidden continuations, in order (each turn also carries a goal-mode context message).
			const kinds = session.messages.flatMap(message =>
				message.role === "user"
					? ["user"]
					: message.role === "custom" && message.customType === "goal-continuation"
						? [message.customType]
						: [],
			);
			expect(kinds).toEqual(["user", "goal-continuation"]);
			expect(userTexts(session).filter(text => text.includes("ship the release"))).toHaveLength(1);
		});
	});

	test("replace swaps an active goal's objective and submits it once; without an active goal it is refused", async () => {
		await withGoalSession(false, async (session, goalMode) => {
			await expect(goalMode.handle({ op: "replace", objective: "nothing to replace" })).rejects.toThrow(
				"No active goal to replace.",
			);
			await goalMode.handle({ op: "create", objective: "first objective" });
			const turn = terminalAgentEnds(session, 1);
			const replaced = await goalMode.handle({
				op: "replace",
				objective: "second objective",
				token_budget: 7000,
				submitObjective: true,
			});
			await turn;
			expect(replaced.goal).toMatchObject({ objective: "second objective", status: "active", tokenBudget: 7000 });
			expect(userTexts(session).filter(text => text.includes("second objective"))).toHaveLength(1);
			expect(userTexts(session).some(text => text.includes("first objective"))).toBe(false);
		});
	});

	test("budget changes an active goal's budget and an omitted one clears it; a paused goal or a bad budget is refused", async () => {
		await withGoalSession(false, async (_session, goalMode) => {
			await goalMode.handle({ op: "create", objective: "budgeted", token_budget: 5000 });
			expect((await goalMode.handle({ op: "budget", token_budget: 9000 })).goal?.tokenBudget).toBe(9000);
			expect((await goalMode.handle({ op: "budget" })).goal?.tokenBudget).toBeUndefined();
			await expect(goalMode.handle({ op: "budget", token_budget: 0 })).rejects.toThrow(
				"token_budget must be a positive integer when provided",
			);
			// A JSON client may still send `null`; it is not a clear.
			await expect(goalMode.handle(JSON.parse('{"op":"budget","token_budget":null}'))).rejects.toThrow(
				"token_budget must be a positive integer when provided",
			);
			await goalMode.handle({ op: "pause" });
			await expect(goalMode.handle({ op: "budget", token_budget: 100 })).rejects.toThrow("No active goal.");
		});
	});

	// This harness session registers no tools, so the `goal` tool's exposure is covered over RPC (test/rpc-goal.test.ts).
	test("guided sends the interview kickoff as a hidden message", async () => {
		await withGoalSession(false, async (session, goalMode) => {
			const turn = terminalAgentEnds(session, 1);
			const result = await goalMode.handle({ op: "guided", rough: "ship the release" });
			await turn;
			expect(result).toEqual({ goal: null, state: null });
			// The kickoff is the guided-goal interview prompt around the rough idea, never a user message.
			expect(userTexts(session)).toEqual([]);
			expect(JSON.stringify(session.messages)).toContain("<rough-goal>");
			expect(JSON.stringify(session.messages)).toContain("ship the release");
			// An active or paused goal refuses it, like create.
			await goalMode.handle({ op: "create", objective: "now a goal" });
			await expect(goalMode.handle({ op: "guided" })).rejects.toThrow("A goal is already active.");
		});
	});
});

describe("GoalModeController continuation gate", () => {
	const agentEnd = { type: "agent_end", messages: [], isTerminal: true } as unknown as AgentSessionEvent;
	const hostInput = { type: "message_start", message: { role: "user", content: [] } } as unknown as AgentSessionEvent;

	function fakeSession(admit: (customType: string) => Promise<boolean>) {
		let goalState: GoalModeState | undefined = {
			enabled: true,
			mode: "active",
			goal: {
				id: "g1",
				objective: "o",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		};
		let idle = Promise.withResolvers<void>();
		idle.resolve();
		const journal: string[] = [];
		let tools: string[] = ["read"];
		let journaledGoal = false;
		let resumed = Promise.withResolvers<void>();
		resumed.resolve();
		let threadResumes = 0;
		const preservedActive: boolean[] = [];
		const transcript = { id: "t1" };
		const session = {
			settings: Settings.isolated({ "goal.continuationModes": ["rpc"] }),
			// Provider-facing id pinned by the host: must not be used to detect a session change.
			sessionId: "pinned-provider-id",
			sessionManager: {
				getSessionId: () => transcript.id,
				buildSessionContext: () =>
					journaledGoal
						? {
								mode: "goal_paused",
								modeData: {
									goal: {
										id: "j1",
										objective: "journaled",
										status: "paused",
										tokensUsed: 0,
										timeUsedSeconds: 0,
										createdAt: 0,
										updatedAt: 0,
									},
								},
							}
						: { mode: "none" },
				appendModeChange: (mode: string) => journal.push(`${transcript.id}:mode:${mode}`),
				appendCustomEntry: (type: string) => journal.push(`${transcript.id}:${type}`),
			},
			isDisposed: false,
			isSessionTransitioning: false,
			isStreaming: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			hasPendingAsyncWork: () => false,
			settleAsyncWork: async () => {},
			getPlanModeState: () => undefined,
			getGoalModeState: () => goalState,
			setGoalModeState: (state: GoalModeState | undefined) => {
				goalState = state;
			},
			getEnabledToolNames: () => [...tools],
			setActiveToolsByName: async (names: string[]) => {
				tools = [...names];
			},
			getTodoPhases: () => [],
			goalRuntime: {
				buildContinuationPrompt: () => "continue",
				clearAccounting: () => {},
				onThreadResumed: async (options?: { preserveActiveGoal?: boolean }) => {
					threadResumes++;
					preservedActive.push(options?.preserveActiveGoal === true);
					await resumed.promise;
					return goalState;
				},
				createGoal: async ({ objective }: { objective: string }): Promise<GoalModeState> => ({
					enabled: true,
					mode: "active",
					goal: {
						id: "g2",
						objective,
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				}),
			},
			promptCustomMessage: (message: { customType: string }) => admit(message.customType),
			waitForIdle: () => idle.promise,
		};
		let dropped = 0;
		const controller = new GoalModeController(session as unknown as GoalModeSession, {
			mode: "rpc",
			delayMs: 0,
			onContinuationDropped: () => dropped++,
		});
		return {
			session,
			controller,
			journal,
			transcript,
			goalState: () => goalState,
			tools: () => tools,
			threadResumes: () => threadResumes,
			/** `preserveActiveGoal` of each `onThreadResumed` call, in order. */
			preservedActive: () => preservedActive,
			journalGoal: () => {
				journaledGoal = true;
			},
			holdResume: () => {
				resumed = Promise.withResolvers<void>();
			},
			releaseResume: () => resumed.resolve(),
			dropped: () => dropped,
			/** Hold waitForIdle until {@link release}. */
			hold: () => {
				idle = Promise.withResolvers<void>();
			},
			release: () => idle.resolve(),
		};
	}

	test("a continuation decided before the session closes is never admitted after it", async () => {
		const admitted: string[] = [];
		const { session, controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		controller.observe(agentEnd);
		expect(controller.continuationPending).toBe(true);
		session.isDisposed = true;
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(controller.continuationPending).toBe(false);

		// A host abort closes the gate before the aborted run's agent_end arrives.
		session.isDisposed = false;
		controller.stopForAbort();
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);

		// Host input re-arms it; the next yield continues exactly once.
		controller.observe(hostInput);
		controller.observe(agentEnd);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a host abort of a continuation turn that ran a tool admits no further continuation", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		const toolTurnEnd = {
			type: "agent_end",
			isTerminal: true,
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }] },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x" }], isError: false },
			],
		} as unknown as AgentSessionEvent;

		// A yield admits continuation #1, so the next run is a continuation turn.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);

		// The host aborts that turn after it ran a tool (new activity); its agent_end follows.
		controller.stopForAbort();
		controller.observe(toolTurnEnd);
		await nextMacrotask();
		expect(controller.continuationPending).toBe(false);
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a turn that was not a continuation re-arms after a no-progress stop, but never after a host abort", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		// Continuation #1 makes no progress, so continuation stops.
		controller.observe(agentEnd);
		await nextMacrotask();
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(controller.continuationPending).toBe(false);

		// A turn nobody prompted (a delivery or job wake) ends: as in the TUI, the goal continues.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);

		// After a host abort, such a turn does not re-arm; only host input does.
		controller.stopForAbort();
		controller.observe(agentEnd);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);
		controller.observe(hostInput);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation", "goal-continuation"]);
	});

	test("a rejected continuation does not claim the next run as its own", async () => {
		let calls = 0;
		const { controller } = fakeSession(async () => {
			calls++;
			if (calls === 1) throw new Error("Agent is busy");
			return true;
		});

		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(calls).toBe(1);
		// Another source's run ends without tool activity. It is not a continuation turn,
		// so it must not count as "no progress" and stop the goal loop.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(calls).toBe(2);
	});

	test("a continuation that finds the session busy or is refused releases settlement", async () => {
		let result = true;
		const admitted: string[] = [];
		const { session, controller, dropped } = fakeSession(async customType => {
			admitted.push(customType);
			return result;
		});

		// Another turn was admitted while the continuation waited: dropped, settle re-checked.
		session.hasAdmittedSubmission = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(1);

		// Mid-transition: dropped the same way.
		session.hasAdmittedSubmission = false;
		session.isSessionTransitioning = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(2);

		// Admitted but the session refuses to start it: no run follows, so settlement is released.
		session.isSessionTransitioning = false;
		result = false;
		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(dropped()).toBe(3);
		expect(controller.continuationPending).toBe(false);
	});

	test("a change that stays in the same session holds, then resumes the goal without settling in between", async () => {
		const admitted: string[] = [];
		const { controller, hold, release, dropped } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		hold();
		controller.observe(agentEnd);
		await controller.beginSessionChange();
		// The change may be cancelled and the goal resumed: still reported as pending.
		expect(controller.continuationPending).toBe(true);
		release();
		await nextMacrotask();
		// A run that yields during the change (for example while a before-switch hook waits) is held too.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		const droppedDuringChange = dropped();

		// Same session afterwards (cancelled, or navigation within it): the goal resumes exactly once.
		await controller.endSessionChange();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(controller.continuationPending).toBe(false);
		// Settlement is re-checked only once the change has ended.
		expect(dropped()).toBeGreaterThan(droppedDuringChange);
	});

	test("a transcript switch is detected even when the host pins the provider session id", async () => {
		const admitted: string[] = [];
		const { controller, transcript, goalState } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		await controller.beginSessionChange();
		transcript.id = "t2";
		await controller.endSessionChange();
		await nextMacrotask();
		// The old goal is left behind, and nothing continues it in the new transcript.
		expect(goalState()).toBeUndefined();
		expect(admitted).toEqual([]);
	});

	test("a goal completed while a switch is pending is journaled in its own session", async () => {
		const { session, controller, transcript, journal } = fakeSession(async () => true);
		await controller.beginSessionChange();
		// The goal tool completes the goal while a before-switch hook is still pending; the records
		// are journaled synchronously at that yield, before the switch can commit.
		const current = session.getGoalModeState();
		session.setGoalModeState(current && { ...current, enabled: false, mode: "exiting", reason: "completed" });
		controller.observe(agentEnd);
		controller.observeAfterListeners(agentEnd);
		// The switch commits before any queued exit work could run.
		transcript.id = "t2";
		await controller.settled();
		await controller.endSessionChange();
		expect(journal).toEqual(["t1:mode:none", "t1:goal-completed"]);
	});

	test("a session change with no goal turn to hold does not withhold settlement", async () => {
		const { session, controller } = fakeSession(async () => true);
		session.setGoalModeState(undefined);
		await controller.beginSessionChange();
		expect(controller.continuationPending).toBe(false);
		await controller.endSessionChange();
	});

	test("a goal created while a session change is in progress is held, not reported settled", async () => {
		const admitted: string[] = [];
		const { session, controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		session.setGoalModeState(undefined);
		await controller.beginSessionChange();
		expect(controller.continuationPending).toBe(false);
		await controller.handle({ op: "create", objective: "during the change" });
		expect(controller.continuationPending).toBe(true);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		await controller.endSessionChange();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a pending goal turn reported during a change is always closed by session_settled", async () => {
		const frames: string[] = [];
		const { session, controller, transcript } = fakeSession(async () => true);
		session.setGoalModeState(undefined);
		// Same wiring as rpc-mode: the probe marks the watcher active whenever it reports pending.
		// The same probe rpc-mode wires: every "pending" answer marks the watcher active.
		const ref: { watcher?: RpcSessionSettleWatcher } = {};
		const probe = watchedScheduledTurnProbe(
			() => controller.continuationPending,
			() => ref.watcher,
		);
		const watcher = new RpcSessionSettleWatcher(
			session as unknown as ConstructorParameters<typeof RpcSessionSettleWatcher>[0],
			frame => frames.push(frame.type),
			probe,
		);
		ref.watcher = watcher;
		await controller.beginSessionChange();
		await controller.handle({ op: "create", objective: "held during the change" });
		expect(isSessionSettled(session as unknown as SessionSettleState, probe)).toBe(false);
		// The change switches away, so the held turn is abandoned and nothing will run.
		transcript.id = "t2";
		await controller.endSessionChange();
		await watcher.check();
		expect(isSessionSettled(session as unknown as SessionSettleState, probe)).toBe(true);
		expect(frames).toEqual(["session_settled"]);
	});

	test("a change that overlaps a running reconcile reconciles after it, never alongside it", async () => {
		const f = fakeSession(async () => true);
		f.session.setGoalModeState(undefined);
		f.journalGoal();
		// Change A switches t1 -> t2; its reconcile stalls inside onThreadResumed.
		f.holdResume();
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		const endA = f.controller.endSessionChange();
		await nextMacrotask();
		expect(f.threadResumes()).toBe(1);
		// Change B begins and ends in the same transcript while A is still running.
		await f.controller.beginSessionChange();
		const endB = f.controller.endSessionChange();
		await nextMacrotask();
		// B queued a reconcile behind A instead of running one concurrently.
		expect(f.threadResumes()).toBe(1);
		f.releaseResume();
		await endA;
		await endB;
		await f.controller.settled();
		for (let i = 0; i < 5; i++) await nextMacrotask();
		expect(f.threadResumes()).toBe(2);
		// The pre-goal tool set was captured without the goal tool.
		expect(f.tools()).toEqual(["read", "goal"]);
		// When the goal later completes, exactly the pre-goal tools come back.
		const current = f.session.getGoalModeState();
		f.session.setGoalModeState(current && { ...current, enabled: false, mode: "exiting", reason: "completed" });
		f.controller.observe(agentEnd);
		f.controller.observeAfterListeners(agentEnd);
		await f.controller.settled();
		expect(f.tools()).toEqual(["read"]);
	});

	test("settled() waits for a reattach queued behind a running one", async () => {
		const f = fakeSession(async () => true);
		f.session.setGoalModeState(undefined);
		f.journalGoal();
		f.holdResume();
		// An extension change's reconcile is running (stalled in onThreadResumed).
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		const endExtension = f.controller.endSessionChange();
		await nextMacrotask();
		// A host command's change ends meanwhile: its reattach is queued, not awaited.
		await f.controller.beginSessionChange();
		f.transcript.id = "t3";
		await f.controller.endSessionChange();
		let settled = false;
		const done = f.controller.settled().then(() => {
			settled = true;
		});
		await nextMacrotask();
		expect(settled).toBe(false);
		f.releaseResume();
		await endExtension;
		await done;
		expect(f.threadResumes()).toBe(2);
	});

	test("the startup reattach lets the runtime pause an active goal; an in-process change preserves it", async () => {
		const f = fakeSession(async () => true);
		f.journalGoal();
		await f.controller.reconcile();
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		await f.controller.endSessionChange();
		await f.controller.settled();
		expect(f.preservedActive()).toEqual([false, true]);
	});

	test("a change that detached a continuation turn does not count the next turn as a continuation", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		// A yield admits continuation #1.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);

		// A reload reopens the same transcript and detaches that turn: its terminal agent_end never comes.
		await controller.beginSessionChange();
		await controller.endSessionChange({ detachedRun: true });
		await nextMacrotask();
		// The goal resumes with continuation #2, which makes no progress, so continuation stops.
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toHaveLength(2);

		// A turn nobody prompted ends. It is not a continuation (#1 was detached), so as after
		// any no-progress stop the goal continues.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation", "goal-continuation"]);
	});
});
