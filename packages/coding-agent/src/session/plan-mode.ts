/**
 * Plan mode owned by the session: one controller per {@link AgentSession}, whichever
 * owner (in-process TUI, `--mode rpc`, session host) opted it in.
 *
 * It enters and leaves plan mode: the read-only tool set plus `write` for `xd://propose`,
 * the `plan` role model (deferred while a turn streams), the proposal handler and the
 * `plan` / `plan_paused` / `none` journal entries. Exit restores the pre-plan tools and
 * model, and rolls back to plan mode when the restore fails. {@link PlanModeController.approve}
 * applies an approved plan review.
 */
import * as path from "node:path";
import { AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { CompactionOutcome } from "@oh-my-pi/pi-agent-core/compaction";
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import { cfgCycleOrder } from "../config/model-settings";
import type { Settings } from "../config/settings";
import { copyLocalArtifacts, type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls";
import { humanizePlanTitle } from "../plan-mode/approved-plan";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import { autosaveApprovedPlan } from "../plan-mode/plan-autosave";
import { readPlanFile, resolvePlanFilePath } from "../plan-mode/plan-files";
import type { PlanApprovalChoice, PlanReviewModel } from "../plan-mode/review";
import { cfgPlanDefaultOnStartup, cfgPlanEnabled } from "../plan-mode/settings";
import planModeApprovedPrompt from "../prompts/system/plan-mode-approved.md" with { type: "text" };
import planModeCompactInstructionsPrompt from "../prompts/system/plan-mode-compact-instructions.md" with { type: "text" };
import { isMCPToolName } from "../tools/builtin-names";
import type { AgentSession, AgentSessionEvent } from "./agent-session";
import type { ResolvedRoleModel } from "./agent-session-types";
import { USER_INTERRUPT_LABEL } from "./messages";
import type { SessionManager } from "./session-manager";

export type RpcPlanOp = "get" | "enter" | "exit" | "clear";

export interface PlanModeView {
	enabled: boolean;
	paused: boolean;
	planFilePath: string | undefined;
}

export interface PlanModeOptions {
	/** Called after every view change (status line now; `plan_mode_updated` in part 2). */
	onChanged?: (view: PlanModeView) => void;
	/** True while the owner wants entry refused (e.g. vibe mode in the TUI). Returns the refusal text. */
	entryBlocked?: () => string | undefined;
	/** Shows a warning the user should see (the TUI's `showWarning`); it is logged as well. */
	onWarning?: (text: string) => void;
}

/** What {@link PlanModeController.approve} did: whether the approved prompt was sent, and the autosaved copy. */
export interface PlanApprovalResult {
	dispatched: boolean;
	/** Where `plan.autosave` copied the plan; undefined when autosave is off or failed. */
	savedPlanPath: string | undefined;
}

export type PlanModeSession = Pick<
	AgentSession,
	| "settings"
	| "sessionManager"
	| "model"
	| "isStreaming"
	| "configuredThinkingLevel"
	| "resolveRoleModelWithThinking"
	| "setModelTemporary"
	| "setThinkingLevel"
	| "applyRoleModel"
	| "getRoleModelCycle"
	| "getGoalModeState"
	| "getPlanModeState"
	| "setPlanModeState"
	| "getPlanReferencePath"
	| "setPlanReferencePath"
	| "markPlanReferenceSent"
	| "markPlanInternalAbortPending"
	| "clearPlanInternalAbortPending"
	| "prompt"
	| "followUp"
	| "getEnabledToolNames"
	| "getMountedXdevToolNames"
	| "hasBuiltInTool"
	| "setActiveToolsByName"
	| "setActiveToolPresentation"
	| "restoreNonMCPToolPresentation"
	| "setPlanProposalHandler"
	| "preparePlanForReview"
	| "sendPlanModeContext"
	| "runModeExitTeardown"
	| "abort"
>;

export interface ModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
}

/**
 * Whether `plan.defaultOnStartup` applies: plan mode is enabled and the session is fresh, with no
 * conversation context (messages, custom messages, branch and compaction summaries) and no
 * explicit `mode_change`. SDK startup metadata and extension `custom` state entries do not count.
 */
export function shouldEnterPlanModeOnStartup(
	sessionManager: Pick<SessionManager, "buildSessionContext" | "getEntries">,
	settings: Settings,
): boolean {
	return (
		cfgPlanDefaultOnStartup.get(settings) &&
		cfgPlanEnabled.get(settings) &&
		sessionManager.buildSessionContext().messages.length === 0 &&
		!sessionManager.getEntries().some(entry => entry.type === "mode_change")
	);
}

export class PlanModeController {
	readonly #session: PlanModeSession;
	readonly #options: PlanModeOptions;
	#enabled = false;
	#paused = false;
	#planFilePath: string | undefined;
	/** Non-MCP tools (top-level and `xd://`) before entry; MCP tools discovered meanwhile survive exit. */
	#previousToolPresentation: { enabled: string[]; mounted: string[] } | undefined;
	/** The pre-plan model, restored on exit. */
	#previousModelState: ModelState | undefined;
	/** A model switch deferred while a turn streams; {@link flushPendingModelSwitch} applies it. */
	#pendingModelSwitch: ModelState | undefined;
	/** Whether {@link #pendingModelSwitch} moves onto the plan role (rather than back to the pre-plan model). */
	#pendingPlanModelSwitch = false;
	/** Entered since the last full exit; becomes `reentry` in the plan state. */
	#hasEntered = false;
	/** Tail of the transition queue: enter, exit, clear and role reapply run one at a time. */
	#transitions: Promise<void> = Promise.resolve();
	/** Transitions queued or running: with none, the next starts synchronously, as an owner's direct call did. */
	#pendingTransitions = 0;
	/** Nesting depth of session changes between {@link beginSessionChange} and {@link endSessionChange}. */
	#sessionChanges = 0;
	#sessionBeforeChange: string | undefined;
	/** {@link leavePreviousSession} ran inside the change: its end restores plan mode even for the same transcript. */
	#leftDuringChange = false;

	constructor(session: PlanModeSession, options: PlanModeOptions) {
		this.#session = session;
		this.#options = options;
	}

	/** The options its owner enabled it with. */
	get options(): PlanModeOptions {
		return this.#options;
	}

	get view(): PlanModeView {
		return { enabled: this.#enabled, paused: this.#paused, planFilePath: this.#planFilePath };
	}

	/** The pre-plan model exit restores; kept past an exit that defers the restore until it is applied. */
	get previousModel(): ModelState | undefined {
		return this.#previousModelState;
	}

	async handle(command: { op: RpcPlanOp; planFilePath?: string }): Promise<PlanModeView> {
		switch (command.op) {
			case "get":
				await this.#transitions;
				break;
			case "enter":
				await this.enter({ planFilePath: command.planFilePath });
				break;
			case "exit":
				await this.exit({ paused: true, interruptActiveTurn: true });
				break;
			case "clear":
				await this.clearPaused();
				break;
			default: {
				const op: never = command.op;
				throw new Error(`Unknown plan op: ${String(op)}`);
			}
		}
		return this.view;
	}

	/** Run `transition` after every queued one, so concurrent callers see each other's result. */
	#serialize(transition: () => Promise<void>): Promise<void> {
		const run = this.#pendingTransitions++ === 0 ? transition() : this.#transitions.then(transition);
		this.#transitions = run
			.catch(() => {})
			.finally(() => {
				this.#pendingTransitions--;
			});
		return run;
	}

	/** Enter plan mode; a no-op while it is on. Throws the refusal when goal mode or the owner blocks it. */
	enter(options?: { planFilePath?: string; preserveRestoredModel?: boolean }): Promise<void> {
		return this.#serialize(() => this.#enter(options));
	}

	async #enter(options?: { planFilePath?: string; preserveRestoredModel?: boolean }): Promise<void> {
		if (this.#enabled) return;
		const goal = this.#session.getGoalModeState();
		if (goal?.enabled || goal?.goal?.status === "paused") throw new Error("Exit goal mode first.");
		const blocked = this.#options.entryBlocked?.();
		if (blocked) throw new Error(blocked);
		if (!cfgPlanEnabled.get(this.#session.settings)) {
			throw new Error("Plan mode is disabled. Enable it in settings (plan.enabled).");
		}

		const planFilePath = options?.planFilePath || this.#session.getPlanReferencePath() || "local://PLAN.md";
		const previousTools = this.#session.getEnabledToolNames();
		const previousMountedTools = this.#session.getMountedXdevToolNames();
		// `plan-mode-active.md` drafts the plan with `write`/`edit`, and approval is a `write` to
		// `xd://propose`: only the built-in `write` can carry it (issues #3165, #14030). A shadowing
		// extension `write` stays inactive, since plan mode's read-only guarantee relies on the
		// built-in write/edit guard.
		const planAugmentations: string[] = [];
		if (this.#session.hasBuiltInTool("write")) {
			planAugmentations.push("write");
		} else if (previousTools.includes("write")) {
			this.#warn(
				"Plan mode: the `write` tool is provided by an extension and cannot submit plans. Disable it to use plan mode.",
			);
		}
		const uniquePlanTools = [...new Set([...previousTools.filter(name => name !== "write"), ...planAugmentations])];

		// Plan state must land before the tool partition: it keeps `write` active as the staging transport.
		const previousPlanModeState = this.#session.getPlanModeState();
		this.#session.setPlanModeState({
			enabled: true,
			planFilePath,
			workflow: "parallel",
			reentry: this.#hasEntered,
		});
		try {
			await this.#session.setActiveToolsByName(uniquePlanTools);
		} catch (error) {
			this.#session.setPlanModeState(previousPlanModeState);
			throw error;
		}
		// Committed only now: a failed entry leaves the view (paused included) as it was.
		this.#previousToolPresentation = {
			enabled: previousTools.filter(name => !isMCPToolName(name)),
			mounted: previousMountedTools.filter(name => !isMCPToolName(name)),
		};
		this.#planFilePath = planFilePath;
		this.#enabled = true;
		this.#paused = false;
		this.#session.setPlanProposalHandler(title => this.#session.preparePlanForReview(title));
		if (this.#session.isStreaming) {
			await this.#session.sendPlanModeContext({ deliverAs: "steer" });
		}
		this.#hasEntered = true;
		// Session loading already restored the journaled model; reapplying today's plan role
		// would replace a CLI/session-specific selection during --resume or a switch.
		if (!options?.preserveRestoredModel) {
			await this.#applyPlanModeModel();
		}
		this.#session.sessionManager.appendModeChange("plan", { planFilePath });
		this.#changed();
	}

	/**
	 * Leave plan mode (a no-op while it is off), to paused or fully off. `interruptActiveTurn`
	 * aborts a streaming turn first: the plan prompt keeps it planning until `xd://propose`.
	 * `deferModelRestore` leaves the pre-plan model for {@link applyDeferredModelTransition}.
	 */
	exit(options: { paused: boolean; deferModelRestore?: boolean; interruptActiveTurn?: boolean }): Promise<void> {
		return this.#serialize(async () => {
			if (!this.#enabled) return;
			if (options.interruptActiveTurn && this.#session.isStreaming) {
				await this.#session.runModeExitTeardown(async () => {
					await this.#session.abort({ reason: USER_INTERRUPT_LABEL });
					await this.#tearDown(options);
				});
				return;
			}
			await this.#tearDown(options);
		});
	}

	/** Paused → off: tools, model and plan state were already restored; only the marker and journal remain. */
	clearPaused(): Promise<void> {
		return this.#serialize(async () => {
			if (!this.#paused) return;
			this.#paused = false;
			this.#hasEntered = false;
			this.#session.sessionManager.appendModeChange("none");
			this.#changed();
		});
	}

	/**
	 * Point plan mode at a plan under review that is newer than the one it targets, so the next
	 * planning turn (a refine, or after a dismissed review) works on it. Not queued: the owner
	 * calls it synchronously while it mounts the review.
	 */
	retarget(planFilePath: string): void {
		const state = this.#session.getPlanModeState();
		if (!this.#enabled || !state?.enabled || state.planFilePath === planFilePath) return;
		this.#session.setPlanModeState({ ...state, planFilePath });
		this.#planFilePath = planFilePath;
		this.#session.sessionManager.appendModeChange("plan", { planFilePath });
		this.#changed();
	}

	/**
	 * Move the active model onto a reassigned `plan` role while plan mode is on: the active
	 * model IS the plan model there, so a settings-only change would leave the turn on the
	 * model plan mode was entered with (issue #5657).
	 */
	reapplyModelOnRoleChange(): Promise<void> {
		return this.#serialize(async () => {
			if (!this.#enabled) return;
			const resolved = this.#session.resolveRoleModelWithThinking("plan");
			if (!resolved.model) {
				this.#clearPendingPlanModelSwitch();
				return;
			}
			await this.#applyPlanModelTransition(this.#session.model, resolved);
		});
	}

	/**
	 * Apply a model switch deferred while streaming; the owner calls it once the turn ends.
	 * Not queued: an interrupting exit waits for the aborted turn's end, which flushes.
	 */
	async flushPendingModelSwitch(): Promise<void> {
		const pending = this.#pendingModelSwitch;
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
		if (!pending) return;
		try {
			await this.#session.setModelTemporary(pending.model, pending.thinkingLevel);
		} catch (error) {
			this.#warn(
				`Failed to switch model after streaming: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * After `exit({ deferModelRestore: true })` (the compact-approval path): move onto
	 * `executionModel`, or else back to the pre-plan model. Consumes the recorded pre-plan
	 * model, so a second call is a no-op. The caller skips it when compaction failed: the
	 * context is intact and the plan model stays.
	 */
	async applyDeferredModelTransition(executionModel?: ResolvedRoleModel): Promise<void> {
		const deferredPrev = this.#previousModelState;
		if (deferredPrev === undefined) return;
		this.#previousModelState = undefined;
		if (executionModel) {
			await this.#applyExecutionModel(executionModel);
		} else {
			await this.#restorePreviousModel(deferredPrev);
		}
	}

	async #applyExecutionModel(executionModel: ResolvedRoleModel): Promise<void> {
		try {
			await this.#session.applyRoleModel(executionModel);
		} catch (error) {
			this.#warn(
				`Could not switch to the ${executionModel.role} model: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * Apply an approved plan review: leave plan mode, then start a new session (`execute`), compact
	 * the planning transcript (`compact`) or keep it (`keep`), restore the execution tools, move onto
	 * the picked tier and send the plan-approved prompt. Nothing is sent when compaction was cancelled
	 * (the next turn still gets the plan). An owner that does not start the new session leaves the
	 * prompt to run in the current one, as the TUI's `/new` refusal always did.
	 * `compact` runs `beforeFlush` before dispatching input queued during compaction, so that input
	 * runs on the execution model; `beforeDispatch` runs right before the prompt is queued (the prompt
	 * may run for the whole turn), with the autosaved copy's path.
	 */
	async approve(input: {
		review: PlanReviewModel;
		choice: PlanApprovalChoice;
		tierIndex?: number;
		hooks: {
			newSession(): Promise<void>;
			compact(
				instructions: string,
				beforeFlush: (outcome: CompactionOutcome) => Promise<void>,
			): Promise<CompactionOutcome>;
			beforeDispatch?(savedPlanPath: string | undefined): void;
		};
	}): Promise<PlanApprovalResult> {
		const { review, choice, hooks } = input;
		const session = this.#session;
		const sessionManager = session.sessionManager;
		const { planFilePath, title } = review.details;
		if (!this.#enabled) throw new Error("Plan mode is not active.");
		// Resolves `local://` against whichever transcript is current when it is used.
		const files = this.#planFileOptions();
		const planContent = await readPlanFile(planFilePath, files);
		if (!planContent) throw new Error(`Plan file not found at ${planFilePath}`);
		// Resolved while still in plan mode, as the review was: a role without its own model maps to the live one.
		const tierIndex = input.tierIndex ?? review.startTierIndex;
		const tierRole =
			review.tiers.length > 1 && tierIndex !== review.restoredTierIndex ? review.tiers[tierIndex]?.role : undefined;
		const executionModel = tierRole
			? session.getRoleModelCycle(cfgCycleOrder.get(session.settings))?.models.find(entry => entry.role === tierRole)
			: undefined;
		const previousPresentation = this.#previousToolPresentation ?? {
			enabled: session.getEnabledToolNames().filter(name => !isMCPToolName(name)),
			mounted: session.getMountedXdevToolNames().filter(name => !isMCPToolName(name)),
		};

		const compact = choice === "compact";
		// The exit's abort before compaction is internal: keep it silent. Cleared on every outcome.
		if (compact) session.markPlanInternalAbortPending();
		let outcome: CompactionOutcome | undefined;
		try {
			await this.exit({ paused: false, deferModelRestore: compact });
			if (choice === "execute") {
				const oldLocalRoot = path.resolve(resolveLocalRoot(files.localProtocolOptions));
				await hooks.newSession();
				await copyLocalArtifacts(oldLocalRoot, path.resolve(resolveLocalRoot(files.localProtocolOptions)));
				await Bun.write(resolvePlanFilePath(planFilePath, files), planContent);
			} else if (compact) {
				// Pinned before compaction so input queued during it sees the approved plan.
				session.setPlanReferencePath(planFilePath);
				outcome = await hooks.compact(
					prompt.render(planModeCompactInstructionsPrompt, { planFilePath }),
					async compactOutcome => {
						if (compactOutcome !== "failed") await this.applyDeferredModelTransition(executionModel);
					},
				);
			}
		} finally {
			session.clearPlanInternalAbortPending();
		}

		// `read` stays on so the durable plan copy remains reachable if the inline one is lost.
		const executionTools = previousPresentation.enabled.includes("read")
			? previousPresentation.enabled
			: [...previousPresentation.enabled, "read"];
		await session.restoreNonMCPToolPresentation(executionTools, previousPresentation.mounted);
		session.setPlanReferencePath(planFilePath);
		let savedPlanPath: string | undefined;
		try {
			savedPlanPath =
				(await autosaveApprovedPlan({
					settings: session.settings,
					cwd: sessionManager.getCwd(),
					title,
					planContent,
				})) ?? undefined;
		} catch (error) {
			const detail = truncateToWidth(
				shortenEmbeddedPaths(
					replaceTabs(error instanceof Error ? error.message : String(error))
						.replace(/[\r\n]+/g, " ")
						.trim(),
				),
				TRUNCATE_LENGTHS.CONTENT,
			);
			this.#warn(`Failed to autosave plan: ${detail}`);
		}

		// Idempotent after `beforeFlush`; covers a compaction that never ran. A cancelled compaction
		// still moves on (only the compaction was cancelled); a failed one keeps the plan model.
		if (!compact) {
			if (executionModel) await this.#applyExecutionModel(executionModel);
		} else if (outcome !== "failed") {
			await this.applyDeferredModelTransition(executionModel);
		}
		if (outcome === "cancelled") {
			// The plan reference stays unsent, so the next turn carries the plan.
			this.#warn(
				"Plan approved, but compaction was cancelled — execution not dispatched. Submit a turn to continue.",
			);
			return { dispatched: false, savedPlanPath };
		}

		// The approved prompt bypasses title generation; `auto` never replaces a name the user chose.
		const seededName = humanizePlanTitle(title);
		if (seededName && !sessionManager.getSessionName()) await sessionManager.setSessionName(seededName, "auto");
		session.markPlanReferenceSent();
		const approvedPrompt = prompt.render(planModeApprovedPrompt, {
			planFilePath,
			planContent,
			contextPreserved: choice !== "execute",
		});
		hooks.beforeDispatch?.(savedPlanPath);
		// Input queued during compaction may already be running: queue behind it rather than abort it.
		if (session.isStreaming) {
			await session.followUp(approvedPrompt, undefined, { synthetic: true });
		} else {
			try {
				await session.prompt(approvedPrompt, { synthetic: true });
			} catch (error) {
				if (!(error instanceof AgentBusyError)) throw error;
				await session.followUp(approvedPrompt, undefined, { synthetic: true });
			}
		}
		return { dispatched: true, savedPlanPath };
	}

	#planFileOptions(): { localProtocolOptions: LocalProtocolOptions; cwd: string } {
		const sessionManager = this.#session.sessionManager;
		return {
			localProtocolOptions: {
				getArtifactsDir: () => sessionManager.getArtifactsDir(),
				getSessionId: () => sessionManager.getSessionId(),
			},
			cwd: sessionManager.getCwd(),
		};
	}

	/** The session is being disposed: a deferred switch must not land afterwards. */
	dispose(): void {
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
	}

	/**
	 * Fed every session event before any subscriber. A turn's end applies the model switch
	 * deferred while it streamed, as the TUI did on each `agent_end`.
	 */
	observe(event: AgentSessionEvent): void {
		if (event.type === "agent_end") void this.flushPendingModelSwitch();
	}

	/**
	 * Restore plan mode from the session journal (startup, resume): the previous session's plan
	 * state goes first, then `plan` re-enters keeping the restored model and `plan_paused` reports
	 * paused.
	 */
	reconcile(): Promise<void> {
		return this.#serialize(() => this.#reconcile());
	}

	/**
	 * Enter plan mode when `plan.defaultOnStartup` applies: plan mode is enabled and the session is
	 * fresh, with no conversation context and no explicit mode (a journaled goal or vibe has one).
	 * The owner calls it at launch and after a user `/new`, never after an internal new session
	 * (approval, loop reset), which must not be dragged back into plan mode.
	 */
	applyStartupDefault(): Promise<void> {
		return this.#serialize(async () => {
			if (shouldEnterPlanModeOnStartup(this.#session.sessionManager, this.#session.settings)) await this.#enter();
		});
	}

	/** The session calls it before any session change or tree navigation, whoever started it. */
	beginSessionChange(): void {
		if (this.#sessionChanges++ === 0) this.#sessionBeforeChange = this.#session.sessionManager.getSessionId();
	}

	/**
	 * For the change itself, once the target session is loaded: drop the previous session's plan
	 * state and tools, so goal mode reconciles over the pre-plan tool set. The change's end then
	 * restores the target's plan mode.
	 */
	leavePreviousSession(): Promise<void> {
		if (this.#sessionChanges === 0) return this.reconcile();
		this.#leftDuringChange = true;
		return this.#serialize(() => this.#leave());
	}

	/**
	 * Call after the change resolves, is cancelled, or throws, after goal mode's own end so a
	 * journal holding a goal wins. Only a change that switched the transcript (or left it, see
	 * {@link leavePreviousSession}) restores plan mode. Never throws: a failure is warned.
	 */
	async endSessionChange(): Promise<void> {
		if (--this.#sessionChanges > 0) return;
		const switched =
			this.#leftDuringChange || this.#session.sessionManager.getSessionId() !== this.#sessionBeforeChange;
		this.#leftDuringChange = false;
		this.#sessionBeforeChange = undefined;
		if (!switched) return;
		try {
			await this.#serialize(() => this.#reconcile());
		} catch (error) {
			this.#warn(`Failed to restore plan mode: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async #reconcile(): Promise<void> {
		await this.#leave();
		const sessionManager = this.#session.sessionManager;
		const context = sessionManager.buildSessionContext();
		if (context.mode === "plan" || context.mode === "plan_paused") {
			if (!cfgPlanEnabled.get(this.#session.settings)) {
				// Close the stale plan so re-enabling the setting later does not restore an old plan session.
				sessionManager.appendModeChange("none");
				return;
			}
			if (context.mode === "plan") {
				const planFilePath = context.modeData?.planFilePath;
				await this.#enter({
					planFilePath: typeof planFilePath === "string" ? planFilePath : undefined,
					preserveRestoredModel: true,
				});
				return;
			}
			this.#paused = true;
			this.#hasEntered = true;
			this.#changed();
			return;
		}
	}

	/** Drop plan mode without journaling: the state and tools belong to the session that set them. */
	async #leave(): Promise<void> {
		if (!this.#enabled && !this.#paused) return;
		const session = this.#session;
		const previousModel = this.#previousModelState;
		const previousPresentation = this.#previousToolPresentation;
		session.setPlanModeState(undefined);
		try {
			if (previousPresentation) {
				await session.restoreNonMCPToolPresentation(previousPresentation.enabled, previousPresentation.mounted);
			}
		} finally {
			session.setPlanProposalHandler(null);
			this.#enabled = false;
			this.#paused = false;
			this.#planFilePath = undefined;
			this.#previousToolPresentation = undefined;
			this.#previousModelState = undefined;
			this.#pendingModelSwitch = undefined;
			this.#pendingPlanModelSwitch = false;
			this.#hasEntered = false;
			this.#changed();
		}
		// A session that records no model (a `/new` boundary) keeps the live model, which in plan
		// mode is the plan-role model: hand it the pre-plan model. A switch restored a recorded one.
		if (previousModel && Object.keys(session.sessionManager.buildSessionContext().models).length === 0) {
			await this.#restorePreviousModel(previousModel);
		}
	}

	#changed(): void {
		this.#options.onChanged?.(this.view);
	}

	#warn(text: string): void {
		logger.warn(text);
		this.#options.onWarning?.(text);
	}

	async #applyPlanModeModel(): Promise<void> {
		const resolved = this.#session.resolveRoleModelWithThinking("plan");
		if (!resolved.model) return;
		const currentModel = this.#session.model;
		// Only entry records the pre-plan model: a mid-planning role change leaves the active
		// model on the plan role, so recording there would restore the old plan model on exit.
		this.#previousModelState = currentModel
			? { model: currentModel, thinkingLevel: this.#session.configuredThinkingLevel() }
			: undefined;
		await this.#applyPlanModelTransition(currentModel, resolved);
	}

	/** Drop a deferred switch queued for a previous plan-role assignment; a pre-plan restore stays. */
	#clearPendingPlanModelSwitch(): void {
		if (!this.#pendingPlanModelSwitch) return;
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
	}

	/** Apply (or defer) the model/thinking change implied by the resolved plan role. */
	async #applyPlanModelTransition(currentModel: Model | undefined, resolved: ResolvedModelRoleValue): Promise<void> {
		const transition = resolvePlanModelTransition(currentModel, resolved, this.#session.isStreaming);
		if (transition.kind !== "apply" || !transition.deferred) {
			this.#clearPendingPlanModelSwitch();
		}
		switch (transition.kind) {
			case "none":
				return;
			case "thinking":
				this.#session.setThinkingLevel(transition.thinkingLevel);
				return;
			case "apply":
				if (transition.deferred) {
					this.#pendingModelSwitch = { model: transition.model, thinkingLevel: transition.thinkingLevel };
					this.#pendingPlanModelSwitch = true;
					return;
				}
				try {
					await this.#session.setModelTemporary(transition.model, transition.thinkingLevel);
				} catch (error) {
					this.#warn(
						`Failed to switch to plan model for plan mode: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return;
		}
	}

	async #restorePreviousModel(prev: ModelState): Promise<void> {
		if (modelsAreEqual(this.#session.model, prev.model)) {
			// Same model: only the thinking level may differ. setModelTemporary() would reset
			// provider-side sessions and break continuity.
			this.#session.setThinkingLevel(prev.thinkingLevel);
		} else if (this.#session.isStreaming) {
			this.#pendingModelSwitch = prev;
			this.#pendingPlanModelSwitch = false;
		} else {
			await this.#session.setModelTemporary(prev.model, prev.thinkingLevel);
		}
	}

	async #tearDown(options: { paused: boolean; deferModelRestore?: boolean }): Promise<void> {
		const session = this.#session;
		const planModeState = session.getPlanModeState();
		const planModeTools = session.getEnabledToolNames();
		const planModeMountedTools = session.getMountedXdevToolNames();
		const planModeModelState = session.model
			? { model: session.model, thinkingLevel: session.configuredThinkingLevel() }
			: undefined;
		session.setPlanModeState(undefined);
		try {
			const previousPresentation = this.#previousToolPresentation;
			if (previousPresentation) {
				await session.restoreNonMCPToolPresentation(previousPresentation.enabled, previousPresentation.mounted);
			}
			if (this.#previousModelState && !options.deferModelRestore) {
				await this.#restorePreviousModel(this.#previousModelState);
			}
			// A switch to the plan-role model deferred at entry must not land after exit (issue #816),
			// including on the compact-approval path, where it would clobber the restored model.
			if (this.#previousModelState) this.#clearPendingPlanModelSwitch();
		} catch (error) {
			session.setPlanModeState(planModeState);
			if (
				planModeModelState &&
				(!modelsAreEqual(session.model, planModeModelState.model) ||
					session.configuredThinkingLevel() !== planModeModelState.thinkingLevel)
			) {
				try {
					await this.#restorePreviousModel(planModeModelState);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan model after plan exit failure", { error: String(rollbackError) });
				}
			}
			const enabledTools = session.getEnabledToolNames();
			const mountedTools = session.getMountedXdevToolNames();
			if (
				enabledTools.length !== planModeTools.length ||
				enabledTools.some((name, index) => name !== planModeTools[index]) ||
				mountedTools.length !== planModeMountedTools.length ||
				mountedTools.some((name, index) => name !== planModeMountedTools[index])
			) {
				try {
					await session.setActiveToolPresentation(planModeTools, planModeMountedTools);
				} catch (rollbackError) {
					logger.warn("Failed to restore plan tools after plan exit failure", { error: String(rollbackError) });
				}
			}
			throw error;
		}
		session.setPlanProposalHandler(null);
		this.#enabled = false;
		this.#paused = options.paused;
		this.#planFilePath = undefined;
		this.#previousToolPresentation = undefined;
		if (!options.deferModelRestore) this.#previousModelState = undefined;
		session.sessionManager.appendModeChange(options.paused ? "plan_paused" : "none");
		this.#changed();
	}
}
