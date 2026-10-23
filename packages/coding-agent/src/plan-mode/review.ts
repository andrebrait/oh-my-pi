/**
 * The plan review's decision, shared by every owner of the review UI: the choices offered,
 * the role tiers the approved plan may run on, and which tier the pre-plan model already is.
 * {@link PlanModeController.approve} applies the pick.
 */
import { modelsAreEqual } from "@oh-my-pi/pi-catalog/models";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { cfgCycleOrder } from "../config/model-settings";
import type { PlanReviewOption, PlanReviewTier } from "../extensibility/extensions/types";
import type { AgentSession } from "../session/agent-session";
import type { PlanApprovalDetails } from "./approved-plan";

/** The review choices that approve the plan. */
export type PlanApprovalChoice = "execute" | "compact" | "keep";

export interface PlanReviewModel {
	details: PlanApprovalDetails;
	/** All five choices in display order; `keep` is disabled when the context is nearly full. */
	options: PlanReviewOption[];
	/** Role tiers in slider order; empty when fewer than two resolve (a lone tier is no choice). */
	tiers: PlanReviewTier[];
	/** The tier the slider starts on: `default`, else the active role. */
	startTierIndex: number;
	/** The tier whose model and thinking level the pre-plan model already is, or -1. */
	restoredTierIndex: number;
}

export type PlanReviewSession = Pick<
	AgentSession,
	"settings" | "model" | "planMode" | "getContextUsage" | "getRoleModelCycle"
>;

const KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT = 95;

export function buildPlanReview(session: PlanReviewSession, details: PlanApprovalDetails): PlanReviewModel {
	const restored = session.planMode?.previousModel;
	// Execution runs on the pre-plan model, so measure the context against its window.
	const contextWindow = (restored?.model ?? session.model)?.contextWindow;
	const usage = session.getContextUsage(typeof contextWindow === "number" ? { contextWindow } : undefined);
	const tokens = (value: number) => formatNumber(Math.max(0, Math.round(value))).toLowerCase();
	const options: PlanReviewOption[] = [
		{ id: "execute", label: "Approve and execute", disabled: false },
		{ id: "compact", label: "Approve and compact context", disabled: false },
		{
			id: "keep",
			label: usage
				? `Approve and keep context (~${tokens(usage.tokens)} / ${tokens(usage.contextWindow)})`
				: "Approve and keep context",
			disabled: usage !== undefined && usage.percent > KEEP_CONTEXT_DISABLE_THRESHOLD_PERCENT,
		},
		{ id: "refine", label: "Refine plan", disabled: false },
		{ id: "save", label: "Save and quit", disabled: false },
	];

	const cycle = session.getRoleModelCycle(cfgCycleOrder.get(session.settings));
	if (!cycle || cycle.models.length < 2) {
		return { details, options, tiers: [], startTierIndex: 0, restoredTierIndex: -1 };
	}
	const defaultTierIndex = cycle.models.findIndex(entry => entry.role === "default");
	// Applying a tier that lands on the restored model and thinking level is no choice: exit already restores it.
	const restoredTierIndex = restored
		? cycle.models.findIndex(
				entry =>
					modelsAreEqual(entry.model, restored.model) &&
					(!entry.explicitThinkingLevel || entry.thinkingLevel === restored.thinkingLevel),
			)
		: -1;
	return {
		details,
		options,
		tiers: cycle.models.map(entry => ({
			role: entry.role,
			provider: entry.model.provider,
			model: entry.model.id,
			...(entry.explicitThinkingLevel && entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		})),
		startTierIndex: defaultTierIndex >= 0 ? defaultTierIndex : cycle.currentIndex,
		restoredTierIndex,
	};
}
