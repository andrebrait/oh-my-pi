import { expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { buildPlanReview } from "@oh-my-pi/pi-coding-agent/plan-mode/review";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir } from "../helpers/rpc-server-harness";

test("buildPlanReview lists execute, compact and keep and the role tiers with the current one restored", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-review-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, {
		settings: {
			modelRoles: {
				plan: "anthropic/claude-haiku-4-5",
				smol: "anthropic/claude-haiku-4-5",
				default: "anthropic/claude-opus-4-5",
				slow: "anthropic/claude-sonnet-4-5",
			},
		},
	});
	try {
		const planMode = session.enablePlanMode({});
		await planMode.enter();
		expect(session.model?.id).toBe("claude-haiku-4-5");
		const details = { planFilePath: "local://PLAN.md", title: "PLAN", planExists: true };

		const review = buildPlanReview(session, details);

		expect(review.details).toBe(details);
		expect(review.options.map(option => option.id)).toEqual(["execute", "compact", "keep", "refine", "save"]);
		expect(review.options.slice(0, 2)).toEqual([
			{ id: "execute", label: "Approve and execute", disabled: false },
			{ id: "compact", label: "Approve and compact context", disabled: false },
		]);
		expect(review.options[2]!.label).toStartWith("Approve and keep context");
		expect(review.options[2]!.disabled).toBe(false);
		expect(review.tiers).toEqual([
			{ role: "smol", provider: "anthropic", model: "claude-haiku-4-5" },
			{ role: "default", provider: "anthropic", model: "claude-opus-4-5" },
			{ role: "slow", provider: "anthropic", model: "claude-sonnet-4-5" },
		]);
		// The slider starts on `default`; the pre-plan model (sonnet) is the restored tier.
		expect(review.startTierIndex).toBe(1);
		expect(review.restoredTierIndex).toBe(2);
	} finally {
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
});

test("buildPlanReview offers no tiers when fewer than two role models resolve, and disables a nearly full keep", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-plan-review-"));
	const restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	const session = await createTestSession(dir, { handler: { content: ["ok"] } }, undefined, {
		// The plan model has a 1M window; the pre-plan sonnet 4.5 has 200k.
		settings: { modelRoles: { plan: "anthropic/claude-sonnet-4-6" } },
	});
	try {
		await session.enablePlanMode({}).enter();
		const contextWindows: Array<number | undefined> = [];
		vi.spyOn(session, "getContextUsage").mockImplementation(options => {
			contextWindows.push(options?.contextWindow);
			return { tokens: 196_000, contextWindow: 200_000, percent: 98 };
		});

		const review = buildPlanReview(session, { planFilePath: "local://PLAN.md", title: "PLAN", planExists: true });

		expect(review.tiers).toEqual([]);
		expect(review.restoredTierIndex).toBe(-1);
		expect(review.options[2]).toEqual({
			id: "keep",
			label: "Approve and keep context (~196k / 200k)",
			disabled: true,
		});
		// Usage is measured against the pre-plan model's window, the one execution runs on.
		expect(contextWindows).toEqual([200_000]);
	} finally {
		await session.dispose();
		restoreAgentDir();
		await removeWithRetries(dir);
	}
});
