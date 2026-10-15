/**
 * Goal mode owned by the session: one controller per {@link AgentSession}, whichever
 * owner (in-process TUI, `--mode rpc`, session host) opted it in, so a goal continues
 * exactly once with zero or many clients.
 *
 * The durable lifecycle (create/resume/pause/drop, accounting, persistence) is
 * `GoalRuntime`, shared with the TUI and the `goal` tool. This controller adds the
 * goal tool's place in the active tool set, completion/drop exit, reattach after a
 * session change, and an opt-in continuation driver keyed to agent lifecycle events.
 * The session feeds it events, interrupting aborts and session changes.
 */
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { cfgGoalContinuationModes, cfgGoalEnabled } from "../goals/settings";
import { type GoalModeState, goalContinuationActivity, goalFromModeData } from "../goals/state";
import guidedGoalInterviewPrompt from "../prompts/goals/guided-goal-interview.md" with { type: "text" };
import { nextActionableTask } from "../tools/todo";
import type { AgentSession, AgentSessionEvent } from "./agent-session";
import type { PromptOptions } from "./agent-session-types";

/** The `goal.continuationModes` entry that lets an owner continue goals automatically. */
export type GoalContinuationMode = "interactive" | "rpc";

export interface GoalModeOptions {
	mode: GoalContinuationMode;
	/** Wait before a decided continuation is admitted (0: the next macrotask). */
	delayMs: number;
	/** Owner-side condition that holds continuation back (for example a draft being composed); see {@link GoalModeController.reschedule}. */
	isBlocked?: () => boolean;
	/** Called when a pending continuation is abandoned (a gate closed while it waited), so settle reporting can re-check. */
	onContinuationDropped?: () => void;
}

export type RpcGoalOp = "get" | "create" | "replace" | "resume" | "pause" | "drop" | "budget" | "guided";

export interface RpcGoalCommand {
	op: RpcGoalOp;
	/** `create`/`replace`. */
	objective?: string;
	/** `create`/`replace`: optional positive budget. `budget`: the new budget; omitted clears it. */
	token_budget?: number;
	/** `create`/`replace`: submit the objective as a user prompt (its first turn) instead of a hidden continuation. */
	submitObjective?: boolean;
	/** Images submitted with the objective (`submitObjective`) or with the `guided` interview kickoff. */
	images?: ImageContent[];
	/** `guided`: the rough idea the interview starts from. */
	rough?: string;
}

export interface RpcGoalResult {
	goal: Goal | null;
	state: GoalModeState | null;
}

export type GoalModeSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "goalRuntime"
	| "getGoalModeState"
	| "setGoalModeState"
	| "getPlanModeState"
	| "getEnabledToolNames"
	| "setActiveToolsByName"
	| "sendGoalModeContext"
	| "getTodoPhases"
	| "promptCustomMessage"
	| "prompt"
	| "followUp"
	| "waitForIdle"
	| "isStreaming"
	| "isDisposed"
	| "isSessionTransitioning"
	| "hasAdmittedSubmission"
	| "queuedMessageCount"
>;

export class GoalModeController {
	readonly #session: GoalModeSession;
	readonly #options: GoalModeOptions;
	/** Active tool set before goal mode added `goal`; restored when the goal ends. */
	#previousTools: string[] | undefined;
	/** Continuation turns submitted whose terminal `agent_end` has not arrived. */
	#pendingContinuationTurns = 0;
	#previousContinuationActivity: string | undefined;
	/** A continuation turn made no new progress; wait for input before continuing. */
	#suppressContinuation = false;
	/**
	 * Set by an interrupting abort; only new input (a prompt, or `goal create`/`resume`) clears it.
	 * Unlike {@link #suppressContinuation}, no turn's `agent_end` can re-arm it, so the
	 * aborted turn's own end cannot schedule another goal turn whatever its activity.
	 */
	#abortStopped = false;
	/** A continuation has been decided and is waiting for the session to go idle. */
	#continuationScheduled = false;
	/** Bumped by an abort or session change; a waiting continuation from before is void. */
	#continuationGeneration = 0;
	/** The `delayMs` wait of the scheduled continuation; cleared on dispose. */
	#continuationTimer: NodeJS.Timeout | undefined;
	/** Resolves once the outermost in-progress session change has reattached the goal; see {@link reattached}. */
	#reattach: PromiseWithResolvers<void> | undefined;
	/** Tool-set restoration triggered by session events; commands and reads wait for it. */
	#exitTask: Promise<void> = Promise.resolve();
	/** Session changes in progress; goal turns are held until they end. */
	#sessionChanges = 0;
	/** Transcript (session manager) id when the outermost in-progress change began. */
	#sessionBeforeChange: string | undefined;
	/** A goal turn was waiting or became due during the change; report busy until it ends. */
	#heldDuringChange = false;
	/** Reconciles run one at a time, each against the transcript current when it starts. */
	#reconcileTask: Promise<void> = Promise.resolve();
	/** Reconciles queued or running. */
	#reconcilesPending = 0;
	/**
	 * The in-progress change began while a reconcile was queued or running, so that
	 * reconcile may have read a transcript this change later replaced or rolled back:
	 * reconcile again (after it) when the change ends, whatever the ids say.
	 */
	#changeOverlappedReconcile = false;

	constructor(session: GoalModeSession, options: GoalModeOptions) {
		this.#session = session;
		this.#options = options;
	}

	/** The options its owner enabled it with. */
	get options(): GoalModeOptions {
		return this.#options;
	}

	/**
	 * True while a goal continuation has been decided but not yet admitted. Hosts and
	 * quiescence checks must treat the session as busy during this window.
	 */
	get continuationPending(): boolean {
		// A change that is holding a goal turn may resume it when cancelled: not settled meanwhile.
		return this.#continuationScheduled || (this.#sessionChanges > 0 && this.#heldDuringChange);
	}

	/**
	 * While a session change is in progress: resolves once it has reattached the goal of the
	 * session it lands in (including a reattach queued behind a running one). A snapshot taken
	 * after it carries that session's goal. `undefined` when no change is in progress.
	 */
	get reattached(): Promise<void> | undefined {
		return this.#reattach?.promise;
	}

	/**
	 * The session was interrupted (`abort` with the user-interrupt reason, whoever called it).
	 * Stop automatic continuation until new input. Runs before the abort unwinds, so the
	 * aborted run's own `agent_end` cannot schedule another goal turn. The runtime separately
	 * pauses the interrupted goal, so in practice only `goal resume`/`create` restarts it.
	 */
	stopForAbort(): void {
		this.#abortStopped = true;
		this.#suppressContinuation = true;
		this.#continuationScheduled = false;
		this.#continuationGeneration++;
	}

	/** The session is being disposed: void a scheduled continuation and drop its timer. */
	dispose(): void {
		clearTimeout(this.#continuationTimer);
		this.#continuationTimer = undefined;
		this.#continuationScheduled = false;
		this.#continuationGeneration++;
	}

	/** Re-check continuation after an owner's {@link GoalModeOptions.isBlocked} condition cleared. */
	reschedule(): void {
		this.#scheduleContinuation();
	}

	get #state(): RpcGoalResult {
		const state = this.#session.getGoalModeState();
		return { goal: state?.goal ?? null, state: state ?? null };
	}

	/**
	 * Resolves once queued goal exits and reconciles (including ones queued while
	 * waiting) have run. Host commands and reads wait for it so they never act on
	 * the previous transcript's goal. Not for use inside extension notifications.
	 */
	async settled(): Promise<void> {
		for (let tail = this.#reconcileTask; ; tail = this.#reconcileTask) {
			await this.#exitTask;
			await tail;
			if (tail === this.#reconcileTask) return;
		}
	}

	/**
	 * The session calls it before any session change or tree navigation, whoever started
	 * it. Waits for a pending goal exit so it cannot land in the next session, voids a
	 * waiting continuation, and holds new goal turns until {@link endSessionChange}.
	 */
	async beginSessionChange(): Promise<void> {
		if (this.#sessionChanges++ === 0) {
			// The transcript id, not `session.sessionId`: a host-pinned provider session id
			// (`--provider-session-id`) does not change when the transcript does.
			this.#sessionBeforeChange = this.#session.sessionManager.getSessionId();
			this.#heldDuringChange = this.#continuationScheduled || this.#continuationWanted();
			this.#reattach = Promise.withResolvers<void>();
		}
		if (this.#reconcilesPending > 0) this.#changeOverlappedReconcile = true;
		this.#continuationScheduled = false;
		this.#continuationGeneration++;
		await this.#exitTask;
	}

	/**
	 * Call after the change resolves, is cancelled, or throws. Only a change that
	 * actually switched the transcript adopts the target session's goal; an active
	 * goal stays active across it, as in the TUI. A cancelled or no-op change (same
	 * session, for example tree navigation or reopening the open session) leaves the
	 * running goal untouched and resumes continuation.
	 *
	 * `detachedRun`: the change stopped the running agent (new, switch, reload). A
	 * detached continuation turn never reaches its terminal `agent_end`, so it no
	 * longer counts as pending. Never throws; settlement is re-checked afterwards.
	 */
	async endSessionChange(options?: { detachedRun?: boolean }): Promise<void> {
		if (options?.detachedRun) {
			this.#pendingContinuationTurns = 0;
			this.#previousContinuationActivity = undefined;
		}
		if (--this.#sessionChanges > 0) return;
		const switched =
			this.#changeOverlappedReconcile || this.#session.sessionManager.getSessionId() !== this.#sessionBeforeChange;
		this.#changeOverlappedReconcile = false;
		this.#sessionBeforeChange = undefined;
		this.#heldDuringChange = false;
		const reattach = this.#reattach;
		this.#reattach = undefined;
		try {
			if (switched && this.#reconcilesPending > 0) {
				// A reconcile is running, possibly the one whose extension notification
				// started this change: queue behind it without waiting, or the two would
				// wait on each other. Settlement is re-checked once it has run.
				void this.reconcile({ preserveActiveGoal: true })
					.then(() => this.#scheduleContinuation())
					.catch(reportControllerError)
					.finally(() => {
						reattach?.resolve();
						this.#options.onContinuationDropped?.();
					});
				return;
			}
			if (switched) await this.reconcile({ preserveActiveGoal: true });
			this.#scheduleContinuation();
		} catch (error) {
			reportControllerError(error);
		}
		reattach?.resolve();
		this.#options.onContinuationDropped?.();
	}

	#queueExit(exit: () => Promise<void>): void {
		this.#exitTask = this.#exitTask.then(exit).catch(reportControllerError);
	}

	async handle(command: RpcGoalCommand): Promise<RpcGoalResult> {
		await this.settled();
		switch (command.op) {
			case "get":
				return this.#state;
			case "create":
				return await this.#create(command);
			case "replace":
				return await this.#replace(command);
			case "resume":
				return await this.#resume();
			case "pause":
				await this.#session.goalRuntime.pauseGoal();
				await this.#exit();
				return this.#state;
			case "drop":
				// The runtime's `goal_updated(dropped)` queues the exit.
				await this.#session.goalRuntime.dropGoal();
				await this.#exitTask;
				return this.#state;
			case "budget":
				return await this.#budget(command);
			case "guided":
				return await this.#guided(command);
			default: {
				const op: never = command.op;
				throw new Error(`Unknown goal op: ${String(op)}`);
			}
		}
	}

	#assertCanEnter(): void {
		if (!cfgGoalEnabled.get(this.#session.settings)) {
			throw new Error("Goal mode is disabled (goal.enabled).");
		}
		if (this.#session.getPlanModeState()?.enabled) {
			throw new Error("Exit plan mode before starting a goal.");
		}
	}

	#assertNoGoal(): void {
		const current = this.#session.getGoalModeState();
		if (current?.enabled) throw new Error("A goal is already active. Drop it before creating another.");
		if (current?.goal.status === "paused") {
			throw new Error("Resume or drop the paused goal before creating another.");
		}
	}

	async #create(command: RpcGoalCommand): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		const objective = command.objective?.trim();
		if (!objective) throw new Error("objective is required when op=create");
		const tokenBudget = optionalTokenBudget(command.token_budget);
		this.#assertNoGoal();
		await this.#enter(
			() => this.#session.goalRuntime.createGoal({ objective, tokenBudget }),
			command.submitObjective ? objective : undefined,
			command.images,
		);
		return this.#state;
	}

	async #replace(command: RpcGoalCommand): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		const objective = command.objective?.trim();
		if (!objective) throw new Error("objective is required when op=replace");
		const tokenBudget = optionalTokenBudget(command.token_budget);
		if (!this.#session.getGoalModeState()?.enabled) throw new Error("No active goal to replace.");
		const state = await this.#session.goalRuntime.replaceGoal({ objective, tokenBudget });
		this.#session.setGoalModeState(state);
		this.#resetContinuation();
		await this.#startTurn(command.submitObjective ? objective : undefined, command.images);
		return this.#state;
	}

	async #resume(): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		const current = this.#session.getGoalModeState();
		if (current?.enabled) return this.#state;
		if (current?.goal.status !== "paused") throw new Error("No paused goal to resume.");
		await this.#enter(() => this.#session.goalRuntime.resumeGoal());
		return this.#state;
	}

	async #budget(command: RpcGoalCommand): Promise<RpcGoalResult> {
		const budget = optionalTokenBudget(command.token_budget);
		const current = this.#session.getGoalModeState();
		if (!current?.enabled) throw new Error("No active goal.");
		if (current.goal.status === "complete") throw new Error("Goal is already complete.");
		await this.#session.goalRuntime.onBudgetMutated(budget);
		// A raised budget may let a budget-limited goal continue.
		this.#resetContinuation();
		this.#scheduleContinuation();
		return this.#state;
	}

	/**
	 * Start the guided-goal interview: expose the `goal` tool before any goal exists, so the
	 * agent can finish with `goal create`, and send the interview kickoff as a hidden message,
	 * queued behind a run in flight. The eventual goal's exit restores the pre-interview tools.
	 */
	async #guided(command: RpcGoalCommand): Promise<RpcGoalResult> {
		this.#assertCanEnter();
		this.#assertNoGoal();
		const session = this.#session;
		const enabledTools = session.getEnabledToolNames();
		this.#previousTools ??= enabledTools;
		if (!enabledTools.includes("goal")) await session.setActiveToolsByName([...enabledTools, "goal"]);
		const kickoff = prompt.render(guidedGoalInterviewPrompt, { initial: command.rough?.trim() || undefined });
		const images = command.images?.length ? command.images : undefined;
		if (session.isStreaming) {
			await session.followUp(kickoff, images, { synthetic: true });
			return this.#state;
		}
		try {
			await this.#submit(kickoff, { synthetic: true, images });
		} catch (error) {
			if (!(error instanceof AgentBusyError)) throw error;
			await session.followUp(kickoff, images, { synthetic: true });
		}
		return this.#state;
	}

	async #enter(start: () => Promise<GoalModeState>, objective?: string, images?: ImageContent[]): Promise<void> {
		// The pre-goal tool set is captured once, when this controller first adds `goal`
		// (a reattached paused goal already holds it). A `goal` tool the host enabled
		// before the goal stays enabled afterwards.
		const previousTools = this.#previousTools ?? this.#session.getEnabledToolNames();
		const state = await start();
		this.#previousTools = previousTools;
		await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
		this.#session.setGoalModeState(state);
		this.#resetContinuation();
		await this.#startTurn(objective, images);
	}

	/**
	 * The goal's first turn: `objective` as a user prompt (steering a run in flight), or else a
	 * continuation once idle. A run in flight is told about the goal either way.
	 */
	async #startTurn(objective: string | undefined, images: ImageContent[] | undefined): Promise<void> {
		const streaming = this.#session.isStreaming;
		if (streaming) await this.#session.sendGoalModeContext({ deliverAs: "steer" });
		if (objective) {
			await this.#submit(objective, { streamingBehavior: "steer", images: images?.length ? images : undefined });
		} else if (!streaming) {
			this.#scheduleContinuation();
		}
	}

	/** Submit a prompt and resolve once it is admitted, not when its turn ends. A failure before admission throws. */
	async #submit(text: string, options: PromptOptions): Promise<void> {
		const admitted = Promise.withResolvers<void>();
		this.#session.prompt(text, { ...options, onPromptAdmitted: () => admitted.resolve() }).then(
			() => admitted.resolve(),
			(error: unknown) => {
				admitted.reject(error);
				reportControllerError(error);
			},
		);
		await admitted.promise;
	}

	/** Restore the pre-goal tool set. Idempotent. */
	async #exit(): Promise<void> {
		const previousTools = this.#previousTools;
		this.#previousTools = undefined;
		this.#resetContinuation();
		if (previousTools) await this.#session.setActiveToolsByName(previousTools);
	}

	/** Write the completion records into the current transcript and clear goal state. Synchronous. */
	#journalCompletion(): void {
		const state = this.#session.getGoalModeState();
		this.#session.setGoalModeState(undefined);
		this.#session.sessionManager.appendModeChange("none");
		this.#session.sessionManager.appendCustomEntry("goal-completed", {
			objective: state?.goal.objective,
			tokensUsed: state?.goal.tokensUsed,
			tokenBudget: state?.goal.tokenBudget,
			timeUsedSeconds: state?.goal.timeUsedSeconds,
		});
	}

	#resetContinuation(): void {
		this.#pendingContinuationTurns = 0;
		this.#previousContinuationActivity = undefined;
		this.#suppressContinuation = false;
		this.#abortStopped = false;
	}

	/**
	 * Leave the previous session's goal behind and restore a goal journaled in the
	 * current session (startup, new/switch/branch/open), mirroring the TUI's reattach.
	 * `preserveActiveGoal` keeps an active goal active (in-process session changes);
	 * without it an active goal is paused (startup, a resumed process).
	 * Queued behind any reconcile already running; resolves when this one has run.
	 * Never awaited from {@link beginSessionChange}: `onThreadResumed` notifies
	 * extensions, which may start another change.
	 */
	async reconcile(options?: { preserveActiveGoal?: boolean }): Promise<void> {
		this.#reconcilesPending++;
		const run = this.#reconcileTask.then(() => this.#reconcileOnce(options));
		this.#reconcileTask = run.catch(reportControllerError).finally(() => {
			this.#reconcilesPending--;
		});
		await run;
	}

	/**
	 * For an owner's session-switch reconciler, which runs inside the change: leave the
	 * previous session's goal and restore its tool set now, so the owner can restore the
	 * target's other modes on top. The change's end then adopts the target's goal, even
	 * if the transcript id did not change. Not queued behind a running reconcile, which
	 * may itself be waiting on this change.
	 */
	async leavePreviousGoal(): Promise<void> {
		if (this.#sessionChanges === 0) return await this.reconcile({ preserveActiveGoal: true });
		this.#changeOverlappedReconcile = true;
		await this.#exit();
		this.#session.setGoalModeState(undefined);
	}

	async #reconcileOnce(options: { preserveActiveGoal?: boolean } | undefined): Promise<void> {
		// Goal state and the goal tool belong to the session that set them; the
		// session itself keeps both across a switch, so clear them here first.
		this.#continuationScheduled = false;
		this.#continuationGeneration++;
		await this.#exitTask;
		await this.#exit();
		this.#session.setGoalModeState(undefined);
		const context = this.#session.sessionManager.buildSessionContext();
		const runtime = this.#session.goalRuntime;
		if (context.mode !== "goal" && context.mode !== "goal_paused") {
			runtime.clearAccounting();
			return;
		}
		const goal = cfgGoalEnabled.get(this.#session.settings) ? goalFromModeData(context.modeData) : undefined;
		if (!goal) {
			runtime.clearAccounting();
			this.#session.sessionManager.appendModeChange("none");
			return;
		}
		this.#session.setGoalModeState({ enabled: context.mode === "goal", mode: "active", goal });
		const restored = await runtime.onThreadResumed({ preserveActiveGoal: options?.preserveActiveGoal });
		if (!restored?.goal) return;
		const previousTools = this.#session.getEnabledToolNames();
		this.#previousTools = previousTools;
		await this.#session.setActiveToolsByName([...new Set([...previousTools, "goal"])]);
	}

	/**
	 * Feed session events. The session calls it before any other subscriber (an RPC settle
	 * watcher included) so a continuation is decided before settlement is evaluated.
	 * A completed goal is journaled afterwards, by {@link observeAfterListeners}.
	 */
	observe(event: AgentSessionEvent): void {
		if (event.type === "message_start" && event.message.role === "user" && !event.message.synthetic) {
			// New input re-arms continuation after a no-progress stop.
			this.#resetContinuation();
			return;
		}
		if (event.type === "goal_updated") {
			const status = event.state?.goal.status;
			if (status === "dropped") {
				this.#queueExit(() => this.#exit());
			} else if (event.state?.enabled && this.#previousTools === undefined) {
				// Created by the agent's `goal` tool rather than this controller.
				this.#previousTools = this.#session.getEnabledToolNames();
			}
			return;
		}
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		if (this.#pendingContinuationTurns > 0) {
			this.#pendingContinuationTurns--;
			const activity = goalContinuationActivity(event.messages);
			this.#suppressContinuation = activity.length === 0 || activity === this.#previousContinuationActivity;
			this.#previousContinuationActivity = activity;
		} else {
			// As in the TUI: a turn that was not a goal continuation (a prompt, a delivery
			// or job wake, an extension-triggered turn) re-arms after a no-progress stop.
			// An interrupting abort stays in force (#abortStopped).
			this.#suppressContinuation = false;
			this.#previousContinuationActivity = undefined;
		}
		// Completed: journaled once subscribers have seen this agent_end (observeAfterListeners).
		if (this.#session.getGoalModeState()?.mode === "exiting") return;
		this.#scheduleContinuation();
	}

	/**
	 * Called after every subscriber saw `event`, so a client gets the terminal `agent_end` before
	 * the completion's journal entries. Journals now, while the transcript is certainly the one that
	 * completed the goal; only the tool-set restore is queued (a later reconcile also restores it).
	 */
	observeAfterListeners(event: AgentSessionEvent): void {
		if (event.type !== "agent_end" || event.isTerminal === false) return;
		if (this.#session.getGoalModeState()?.mode !== "exiting") return;
		this.#journalCompletion();
		this.#queueExit(() => this.#exit());
	}

	/**
	 * Whether goal continuation is wanted at all, independent of whether the session
	 * is momentarily busy. Every gate is read from the live session.
	 */
	#continuationWanted(): boolean {
		const session = this.#session;
		if (!cfgGoalContinuationModes.get(session.settings).includes(this.#options.mode)) return false;
		if (this.#abortStopped || this.#suppressContinuation || session.isDisposed) return false;
		if (this.#options.isBlocked?.()) return false;
		if (session.getPlanModeState()?.enabled) return false;
		const state = session.getGoalModeState();
		if (!state?.enabled || state.goal.status !== "active") return false;
		const phases = session.getTodoPhases();
		return !(
			!nextActionableTask(phases) && phases.some(phase => phase.tasks.some(task => task.status === "blocked"))
		);
	}

	/**
	 * Decide at a yield to continue the goal; admit the continuation once the yielding
	 * run has fully unwound. While waiting, {@link continuationPending} is true, so no
	 * settle report calls the session settled. At admission every gate is re-read:
	 * an abort, disposal, pause, plan mode, or another turn starting meanwhile drops it.
	 */
	#scheduleContinuation(): void {
		if (this.#sessionChanges > 0) {
			// Held until the change ends; a same-session change resumes it.
			if (this.#continuationWanted()) this.#heldDuringChange = true;
			return;
		}
		if (this.#continuationScheduled || !this.#continuationWanted()) return;
		this.#continuationScheduled = true;
		const generation = this.#continuationGeneration;
		void (async () => {
			const { promise, resolve } = Promise.withResolvers<void>();
			if (this.#options.delayMs > 0) this.#continuationTimer = setTimeout(resolve, this.#options.delayMs);
			else setImmediate(resolve);
			await promise;
			this.#continuationTimer = undefined;
			await this.#session.waitForIdle();
			if (!this.#continuationScheduled || generation !== this.#continuationGeneration) {
				this.#options.onContinuationDropped?.();
				return;
			}
			this.#continuationScheduled = false;
			const session = this.#session;
			const idle =
				!session.isStreaming &&
				!session.hasAdmittedSubmission &&
				session.queuedMessageCount === 0 &&
				!session.isSessionTransitioning;
			const prompt = idle && this.#continuationWanted() ? session.goalRuntime.buildContinuationPrompt() : undefined;
			if (!prompt) {
				this.#options.onContinuationDropped?.();
				return;
			}
			this.#pendingContinuationTurns++;
			const unclaim = () => {
				this.#pendingContinuationTurns = Math.max(0, this.#pendingContinuationTurns - 1);
				// No run follows, so nothing else will end this activity stretch.
				this.#options.onContinuationDropped?.();
			};
			// promptCustomMessage counts the submission as admitted synchronously, so every
			// settle report sees it from here on. A continuation that is refused or bails
			// before its run starts must neither stay counted nor withhold settlement.
			session
				.promptCustomMessage(
					{ customType: "goal-continuation", content: prompt, display: false, attribution: "agent" },
					{ streamingBehavior: "followUp" },
				)
				.then(
					dispatched => {
						if (!dispatched) unclaim();
					},
					error => {
						unclaim();
						reportControllerError(error);
					},
				);
		})().catch(error => {
			this.#continuationScheduled = false;
			this.#options.onContinuationDropped?.();
			reportControllerError(error);
		});
	}
}

/** A `token_budget`: absent, or a positive integer. */
function optionalTokenBudget(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (!Number.isInteger(value) || value <= 0) throw new Error("token_budget must be a positive integer when provided");
	return value;
}

function reportControllerError(error: unknown): void {
	logger.warn("Goal mode controller failed", { error: error instanceof Error ? error.message : String(error) });
}
