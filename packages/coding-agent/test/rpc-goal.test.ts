import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * The rejection of a request to the RPC child. Settled before `expect` sees it:
 * `expect(pending).rejects` against a live child-process request can stall until the
 * request times out (observed with Bun 1.4.2 on Windows).
 */
async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error,
	);
}

describe("RPC goal command", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start(options: {
		continuation: boolean;
		script?: "complete" | "idle" | "slow";
		plan?: boolean;
		persist?: boolean;
	}): Promise<RpcClient> {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "goal-rpc-agent.ts")],
			cwd: directory,
			env: {
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				GOAL_RPC_CONTINUATION: options.continuation ? "1" : "0",
				GOAL_RPC_SCRIPT: options.script ?? "complete",
				GOAL_RPC_PLAN: options.plan ? "1" : "0",
				GOAL_RPC_PERSIST: options.persist ? "1" : "0",
			},
		});
		await client.start();
		return client;
	}

	test("get is a read without a model call; create activates the goal tool without prompting", async () => {
		const rpc = await start({ continuation: false });
		expect(await rpc.goal("get")).toEqual({ goal: null, state: null });
		expect((await rpc.getState()).goal).toBeNull();

		const created = await rpc.goal("create", { objective: "  ship it  ", tokenBudget: 5000 });
		expect(created.goal).toMatchObject({ objective: "ship it", status: "active", tokenBudget: 5000 });
		expect(created.state).toMatchObject({ enabled: true, mode: "active" });

		const state = await rpc.getState();
		expect(state.goal?.goal.objective).toBe("ship it");
		expect(state.dumpTools?.map(tool => tool.name)).toContain("goal");
		// Continuation is off: nothing ran, so no model turn happened.
		expect(state.messageCount).toBe(0);
		expect(state.isStreaming).toBe(false);
	}, 30_000);

	test("plan mode refuses create and resume", async () => {
		const rpc = await start({ continuation: true, plan: true });
		const refused = await rejectionOf(rpc.goal("create", { objective: "not while planning" }));
		expect(refused).toMatchObject({ command: "goal", message: "Exit plan mode before starting a goal." });
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.messageCount).toBe(0);
	}, 30_000);

	test("continuation stops after a turn with no progress and the goal stays active", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "loop forever" });
			await withTimeout(settled.promise, 15_000, "No-progress continuation never settled");
		} finally {
			unsubscribe();
		}
		const state = await rpc.getState();
		expect(state.goal?.goal.status).toBe("active");
		expect(state.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toHaveLength(1);
	}, 30_000);

	test("create refuses a second goal, a paused goal, and invalid input; pause/resume/drop restore tools", async () => {
		const rpc = await start({ continuation: false });
		const refused = { command: "goal" };
		expect(await rejectionOf(rpc.goal("create", { objective: "   " }))).toMatchObject(refused);
		expect(await rejectionOf(rpc.goal("create", { objective: "x", tokenBudget: 0 }))).toMatchObject(refused);
		expect(await rejectionOf(rpc.goal("resume"))).toMatchObject(refused);

		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		expect(toolsBefore).not.toContain("goal");
		await rpc.goal("create", { objective: "first" });
		expect(await rejectionOf(rpc.goal("create", { objective: "second" }))).toMatchObject(refused);

		const paused = await rpc.goal("pause");
		expect(paused.goal?.status).toBe("paused");
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		expect(await rejectionOf(rpc.goal("create", { objective: "second" }))).toMatchObject(refused);

		const resumed = await rpc.goal("resume");
		expect(resumed.goal).toMatchObject({ objective: "first", status: "active" });
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toContain("goal");

		const dropped = await rpc.goal("drop");
		expect(dropped.goal).toBeNull();
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		expect((await rpc.goal("create", { objective: "again" })).goal?.status).toBe("active");
	}, 30_000);

	test("with rpc continuation opted in, create drives turns until the agent completes the goal", async () => {
		const rpc = await start({ continuation: true });
		const updates: Array<string | undefined> = [];
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "goal_updated") updates.push(event.state?.goal.status ?? "none");
		});
		const unsubscribeSettled = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "finish the task" });
			await withTimeout(settled.promise, 15_000, "Goal continuation never settled");
		} finally {
			unsubscribe();
			unsubscribeSettled();
		}
		expect(updates).toContain("complete");
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.isSettled).toBe(true);
		expect(state.dumpTools?.map(tool => tool.name)).not.toContain("goal");
		const messages = await rpc.getMessages();
		const continuations = messages.filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		// One continuation after create, and a second after that turn yielded unfinished.
		expect(continuations).toHaveLength(2);
		// The goal tool, not a text prompt, completed it.
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.toolName === "goal" &&
					JSON.stringify(message.content).includes("complete"),
			),
		).toBe(true);
	}, 30_000);

	test("host abort of a continuation turn pauses the goal and starts no further goal turn", async () => {
		const rpc = await start({ continuation: true, script: "slow" });
		let agentStarts = 0;
		const started = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "agent_start") {
				agentStarts++;
				started.resolve();
			}
		});
		let state: RpcSessionState;
		try {
			await rpc.goal("create", { objective: "long task" });
			await withTimeout(started.promise, 10_000, "Continuation turn never started");
			await rpc.abort();
			// A continuation escaping the abort is admitted synchronously one macrotask after
			// the aborted run's agent_end; this later round-trip would observe it as busy.
			state = await rpc.getState();
		} finally {
			unsubscribe();
		}
		expect(agentStarts).toBe(1);
		expect(state.goal?.goal.status).toBe("paused");
		expect(state.isStreaming).toBe(false);
		expect(state.isSettled).toBe(true);
	}, 30_000);

	test("a new session leaves the previous session's goal, goal tool and continuation behind", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => firstSettle.resolve());
		try {
			await rpc.goal("create", { objective: "belongs to the first session" });
			await withTimeout(firstSettle.promise, 15_000, "First session never settled");
		} finally {
			unsubscribe();
		}
		expect((await rpc.newSession()).cancelled).toBe(false);
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		// A turn in the new session must not pick up the old objective's continuation.
		await rpc.promptAndWait("hello in the second session");
		const s2 = await rpc.getState();
		expect(s2.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toEqual([]);
		expect((await rpc.goal("create", { objective: "second session goal" })).goal?.status).toBe("active");
	}, 30_000);

	test("an extension command that starts a new session leaves the goal behind; navigation within the session keeps it", async () => {
		const rpc = await start({ continuation: false });
		await rpc.goal("create", { objective: "survives in-session navigation" });

		await rpc.promptAndWait("/goaltest-navigate-here");
		const kept = await rpc.getState();
		expect(kept.goal?.goal).toMatchObject({ objective: "survives in-session navigation", status: "active" });
		expect(kept.dumpTools?.map(tool => tool.name)).toContain("goal");

		await rpc.promptAndWait("/goaltest-new-session");
		const fresh = await rpc.getState();
		expect(fresh.goal).toBeNull();
		expect(fresh.dumpTools?.map(tool => tool.name)).not.toContain("goal");
	}, 30_000);

	async function branchAt(rpc: RpcClient, text: string): Promise<void> {
		const entry = (await rpc.getBranchMessages()).find(message => message.text === text);
		if (!entry) throw new Error(`No branch message "${text}"`);
		expect((await rpc.branch(entry.entryId)).cancelled).toBe(false);
	}

	async function untilSettled(rpc: RpcClient, label: string, action: () => Promise<unknown>): Promise<void> {
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => settled.resolve());
		try {
			await action();
			await withTimeout(settled.promise, 15_000, `${label} never settled`);
		} finally {
			unsubscribe();
		}
	}

	test("branching within the process keeps an active goal active", async () => {
		const rpc = await start({ continuation: false, script: "idle", persist: true });
		await rpc.promptAndWait("first");
		await rpc.goal("create", { objective: "survives a branch" });
		await rpc.promptAndWait("second");
		await rpc.promptAndWait("third");
		await branchAt(rpc, "third");

		const state = await rpc.getState();
		expect(state.goal?.goal).toMatchObject({ objective: "survives a branch", status: "active" });
		expect(state.goal?.enabled).toBe(true);
		expect(state.dumpTools?.map(tool => tool.name)).toContain("goal");
		const { entries } = await rpc.getEntries();
		// The branch journaled no pause.
		expect(entries.flatMap(entry => (entry.type === "mode_change" ? [entry.mode] : []))).toEqual(["goal"]);
	}, 30_000);

	test("with rpc continuation opted in, the goal continues in the branch", async () => {
		const rpc = await start({ continuation: true, script: "idle", persist: true });
		await untilSettled(rpc, "First prompt", () => rpc.promptAndWait("first"));
		// Each goal turn makes no progress, so one continuation follows create and each host prompt.
		await untilSettled(rpc, "Goal create", () => rpc.goal("create", { objective: "continues in the branch" }));
		await untilSettled(rpc, "Second prompt", () => rpc.promptAndWait("second"));
		// The branch keeps "first" and the create's continuation, and drops "second" and its continuation.
		await untilSettled(rpc, "Branch", () => branchAt(rpc, "second"));

		const state = await rpc.getState();
		expect(state.goal?.goal.status).toBe("active");
		expect(state.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toHaveLength(2);
	}, 30_000);

	test("an extension session change aborts the detached run's prompt; the command's own result is unaffected", async () => {
		const rpc = await start({ continuation: false, script: "slow" });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			// The command then starts a run of its own in the new session.
			await rpc.promptAndWait("/goaltest-new-session hello from the new session");
			// The detached run never yields; its prompt must still be closed, as aborted.
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(20);
				})(),
				10_000,
				"The detached run's prompt was never reported",
			);
			expect(results.get(first)).toBe("aborted");
			const state = await rpc.getState();
			expect(state.isSettled).toBe(true);
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
		expect([...results.values()].filter(status => status !== "aborted")).toEqual(["completed"]);
	}, 30_000);

	test("an extension navigation during a live run leaves that run's prompt to complete normally", async () => {
		const rpc = await start({ continuation: false, script: "slow" });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			// Navigation does not stop the run, so it must not close the run's prompt.
			await rpc.promptAndWait("/goaltest-navigate-here");
			expect(results.has(first)).toBe(false);
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(50);
				})(),
				20_000,
				"The running prompt was never reported",
			);
			expect(results.get(first)).toBe("completed");
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
	}, 40_000);

	test("an extension reload detaches the live run and closes its prompt as aborted", async () => {
		const rpc = await start({ continuation: false, script: "slow", persist: true });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			await rpc.promptAndWait("/goaltest-reload");
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(20);
				})(),
				5_000,
				"The detached run's prompt was never reported",
			);
			expect(results.get(first)).toBe("aborted");
			expect((await rpc.getState()).isSettled).toBe(true);
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
	}, 30_000);

	test("prompt_result reports the session unsettled when a goal continuation follows the prompt", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribeSettled = rpc.onSessionSettled(() => firstSettle.resolve());
		const results = new Map<string, boolean>();
		const unsubscribeResults = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.sessionSettled);
		});
		try {
			await rpc.goal("create", { objective: "keep going" });
			// The first continuation makes no progress, so the loop stops and the session settles.
			await withTimeout(firstSettle.promise, 15_000, "Initial continuation never settled");
			const events = await rpc.promptAndWait("host input re-arms the goal");
			expect(events.some(event => event.type === "agent_end")).toBe(true);
		} finally {
			unsubscribeSettled();
			unsubscribeResults();
		}
		// The host prompt re-armed continuation; a goal turn follows it, so the prompt's
		// own result must not claim the session settled.
		expect([...results.values()]).toEqual([false]);
	}, 30_000);
});
