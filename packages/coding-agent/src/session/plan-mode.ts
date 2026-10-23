/**
 * Plan mode owned by the session: one controller per {@link AgentSession}, whichever
 * owner (in-process TUI, `--mode rpc`, session host) opted it in.
 *
 * It enters and leaves plan mode: the read-only tool set plus `write` for `xd://propose`,
 * the `plan` role model (deferred while a turn streams), the proposal handler and the
 * `plan` / `plan_paused` / `none` journal entries. Exit restores the pre-plan tools and
 * model, and rolls back to plan mode when the restore fails.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ResolvedModelRoleValue } from "../config/model-resolver";
import { resolvePlanModelTransition } from "../plan-mode/model-transition";
import { cfgPlanEnabled } from "../plan-mode/settings";
import { isMCPToolName } from "../tools/builtin-names";
import type { AgentSession } from "./agent-session";
import type { ResolvedRoleModel } from "./agent-session-types";
import { USER_INTERRUPT_LABEL } from "./messages";

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
	| "getGoalModeState"
	| "getPlanModeState"
	| "setPlanModeState"
	| "getPlanReferencePath"
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

interface ModelState {
	model: Model;
	thinkingLevel?: ConfiguredThinkingLevel;
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
		const run = this.#transitions.then(transition);
		this.#transitions = run.catch(() => {});
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
		if (!executionModel) {
			await this.#restorePreviousModel(deferredPrev);
			return;
		}
		try {
			await this.#session.applyRoleModel(executionModel);
		} catch (error) {
			this.#warn(
				`Could not switch to the ${executionModel.role} model: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/** The session is being disposed: a deferred switch must not land afterwards. */
	dispose(): void {
		this.#pendingModelSwitch = undefined;
		this.#pendingPlanModelSwitch = false;
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
