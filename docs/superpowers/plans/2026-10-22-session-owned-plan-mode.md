# Session-Owned Plan Mode (P3, part 1 of 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Plan mode's state machine (enter, exit, pause, model and tool restore, session-change reconcile, approval) lives in the session, behind a `PlanModeController`, with the in-process TUI as its first owner and no user-visible change.

**Architecture:** Mirror the goal slice (`src/session/goal-mode.ts`). A `PlanModeController` owns the state that `InteractiveMode` keeps today in private fields, and is enabled once per session through `AgentSession.enablePlanMode(options)`. The review overlay stays in the terminal; the review *decision* (options, tiers, approval effects) moves into pure functions plus `controller.approve(...)`, with owner-supplied hooks for "new session" and "compact". Part 2 (separate plan, stacked PR) adds the wire: a `plan` RPC command, a plan field in session state, a `plan_mode_updated` event, a `plan_review` UI request, host enablement and the hosted terminal.

**Tech Stack:** TypeScript on Bun, `bun test`, `packages/coding-agent`.

**Spec:** `docs/superpowers/specs/2026-10-01-session-host-design.md` (P3 row: "plan, goal, loop, idle compaction and recap move to the session or host"). Code map from the scout: `agent://PlanModeMap` (read-only report; line numbers below refer to `feat/session-host-plan` at `301ca29cc1`).

## Global Constraints

- `AGENTS.md` (repository root) applies: `#private` fields, no `private`/`protected` keywords, `Promise.withResolvers`, no inline imports, no `ReturnType<>`, no `mock.module()`, no source-grep tests, `bun check` (never `tsc`).
- No model- or provider-conditional logic in TypeScript; model choice goes through `resolvePlanModelTransition` (`src/plan-mode/model-transition.ts`) and role models as today.
- Journal format is unchanged: the same `appendModeChange("plan" | "plan_paused" | "none", ...)` entries at the same transitions. Old sessions must resume exactly as before.
- No wire change in this part: nothing under `src/modes/rpc/wire/` changes, and `test/rpc-wire/generated.test.ts` stays green without regeneration.
- In-process behavior is the contract: the existing plan-mode tests listed in Task 4 keep passing; only tests that assert removed private internals may be rewritten against the controller.
- Changelog: one `### Changed` line under `## [Unreleased]` in `packages/coding-agent/CHANGELOG.md` only if a behavior a user can see changes; a pure move gets none.

## Review Focus

1. **Plan entered while a turn streams:** the plan-role model switch is deferred to the turn's end, then applied once (today `#pendingPlanModelSwitch`). Test in Task 1.
2. **Exit while that deferred switch is pending:** the pending switch is dropped and the pre-plan model stays. Test in Task 1.
3. **MCP tools mounted during plan mode:** exit restores only the non-MCP presentation captured on entry; tools mounted meanwhile stay. Test in Task 1.
4. **Approval whose compaction is cancelled or fails:** plan mode stays active, the model is not switched, no approved prompt is sent. Test in Task 3.
5. **Switching mid-plan to a session whose journal holds a goal:** plan is torn down (tools and model restored), goal reconcile runs, plan does not re-enter. Test in Task 2.

---

## File Structure

| File | Responsibility |
| --- | --- |
| Create `src/session/plan-mode.ts` | `PlanModeController`: state, enter/exit/clear, model and tool restore, deferred model switch, reconcile, approve. |
| Create `src/plan-mode/review.ts` | Pure review decision: options, tiers and the extension request payload from `PlanApprovalDetails`. Shared by the TUI overlay now and the `plan_review` request in part 2. |
| Modify `src/session/agent-session.ts` | `enablePlanMode`, `planMode` getter, controller hooks in the session-change wrapper next to goal (`#goalSessionChange`, ~7497), dispose. |
| Modify `src/modes/interactive-mode.ts` | Delete the plan fields (1328-1337, 1657, 1680-1708 except overlay/annotation UI fields) and the moved methods (4878-4970, 5101-5340, 5777-5898); delegate to the controller. |
| Modify `src/modes/types.ts` | `planModeEnabled`/`planModePaused`/`planModePlanFilePath` on `InteractiveModeContext` become getters reading `session.planMode?.view`. |
| Create `test/session/plan-mode.test.ts` | Controller contract tests (real `AgentSession` via `test/helpers/rpc-server-harness.ts#createTestSession`, mock model). |

---

### Task 1: `PlanModeController` with enter, exit, clear and restore

**Files:**
- Create: `packages/coding-agent/src/session/plan-mode.ts`
- Modify: `packages/coding-agent/src/session/agent-session.ts` (add `enablePlanMode`, `get planMode`, dispose next to `#goalMode` at ~7479 and ~6044)
- Test: `packages/coding-agent/test/session/plan-mode.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type RpcPlanOp = "get" | "enter" | "exit" | "clear";
  export interface PlanModeView { enabled: boolean; paused: boolean; planFilePath: string | undefined }
  export interface PlanModeOptions {
  	/** Called after every view change (status line now; `plan_mode_updated` in part 2). */
  	onChanged?: (view: PlanModeView) => void;
  	/** True while the owner wants entry refused (e.g. vibe mode in the TUI). Returns the refusal text. */
  	entryBlocked?: () => string | undefined;
  }
  export type PlanModeSession = Pick<AgentSession, /* only what the controller calls */>;
  export class PlanModeController {
  	constructor(session: PlanModeSession, options: PlanModeOptions);
  	get view(): PlanModeView;
  	handle(command: { op: RpcPlanOp; planFilePath?: string }): Promise<PlanModeView>;
  	enter(options?: { planFilePath?: string; preserveRestoredModel?: boolean }): Promise<void>;
  	exit(options: { paused: boolean; deferModelRestore?: boolean }): Promise<void>;
  	clearPaused(): void;
  	reapplyModelOnRoleChange(): Promise<void>;
  	flushPendingModelSwitch(): Promise<void>;
  	dispose(): void;
  }
  // AgentSession
  enablePlanMode(options: PlanModeOptions): PlanModeController; // idempotent like enableGoalMode; throws on a passive replica
  get planMode(): PlanModeController | undefined;
  ```
- `handle` semantics: `enter` = `#enterPlanMode` (IM 5107); `exit` = exit to paused (IM 5233 with `paused: true`); `clear` = paused → off (IM 6001-6012); `get` returns the view. Refusals throw `Error` with today's TUI warning text ("Exit goal mode first." etc. from IM 5115).

- [ ] **Step 1: Write the failing tests** in `test/session/plan-mode.test.ts`:
  - `"enter switches to the plan role model and plan tools, and journals plan"`: after `handle({op:"enter"})`, `session.model` is the plan-role model, `getPlanModeState()?.enabled === true`, the last mode-change entry is `plan` with the plan file path, `view` is `{enabled:true, paused:false, planFilePath}`.
  - `"exit to paused restores the previous model and tools and journals plan_paused"`.
  - `"clear after paused journals none and reports a disabled view"`.
  - `"entering while a turn streams defers the model switch to the turn end"` (Review Focus 1): gate the mock reply, enter, assert model unchanged, release, assert plan-role model.
  - `"exit drops a deferred plan model switch"` (Review Focus 2).
  - `"exit keeps MCP tools mounted during plan mode"` (Review Focus 3).
  - `"a failed tool restore rolls back and keeps plan mode"` (port of the rollback case in `test/interactive-mode-default-plan-mode.test.ts`).
  - `"enter is refused while a goal is active"`: create a goal through `session.enableGoalMode(...).handle({op:"create",...})`, then `handle({op:"enter"})` rejects with "Exit goal mode first."

- [ ] **Step 2: Run** `bun test test/session/plan-mode.test.ts` from `packages/coding-agent`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement** `PlanModeController` by moving `#applyPlanModeModel`, `#reapplyPlanModeModelOnRoleChange`, `#clearPendingPlanModelSwitch`, `#applyPlanModelTransition`, `flushPendingModelSwitch`'s plan branch, `#enterPlanMode`, `#restorePlanPreviousModel`, `#applyDeferredPlanModelTransition`, `#exitPlanMode`, `#tearDownPlanMode` (IM 4878-4970, 5107-5340) with their fields (IM 1657, 1680-1684). Replace UI calls with `onChanged`; `interruptActiveTurn` uses `session.runModeExitTeardown` as today. `enablePlanMode` mirrors `enableGoalMode` (AS 7479): store, throw on mismatched options or passive replica, no event-listener registration needed yet.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(session): own plan mode state in the session`.

### Task 2: Reconcile on session change and startup default

**Files:**
- Modify: `src/session/plan-mode.ts`, `src/session/agent-session.ts` (session-change wrapper ~7497 and `#reconcileModeAfterTransition` 3137)
- Test: `test/session/plan-mode.test.ts`

**Interfaces:**
- Consumes: Task 1 controller.
- Produces:
  ```ts
  // PlanModeOptions gains:
  /** Enter plan mode on a fresh session when `plan.defaultOnStartup` says so (TUI and, in part 2, hosts). */
  applyStartupDefault?: boolean;
  // PlanModeController gains:
  reconcile(): Promise<void>;           // from buildSessionContext().mode, as IM 5027-5095
  beginSessionChange(): void;
  endSessionChange(): Promise<void>;
  /** Suppress the startup default for the next new session (approval's own "new session"). */
  suppressNextStartupDefault(): void;
  ```
- Ordering: plan teardown runs before goal reconcile, plan reconcile after it, so a journal holding a goal wins (IM 5059-5063 today).

- [ ] **Step 1: Write the failing tests:**
  - `"resuming a session journaled in plan re-enters plan mode keeping the restored model"`.
  - `"resuming a plan_paused session reports a paused view without entering"`.
  - `"a stale plan entry is closed with none when plan.enabled is off"`.
  - `"new session re-enters plan mode when plan.defaultOnStartup is set"` and `"... not after suppressNextStartupDefault"`.
  - `"switching to a session whose journal holds a goal tears plan down and does not re-enter"` (Review Focus 5).

- [ ] **Step 2: Run** `bun test test/session/plan-mode.test.ts`. Expected: the new tests FAIL.

- [ ] **Step 3: Implement** `reconcile` from IM `#reconcileModeFromSession` (5027) and `#clearTransientModeState` (4974), `#applyPlanModeDefault` (5101) and `shouldEnterPlanModeOnStartup` (637). Call `beginSessionChange`/`endSessionChange` from the same AgentSession wrapper that drives goal (rename `#goalSessionChange` to `#modeSessionChange` and call both controllers, plan first on begin, goal first on end).

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(session): reconcile plan mode on session changes`.

### Task 3: Review decision and approval in the session

**Files:**
- Create: `src/plan-mode/review.ts`
- Modify: `src/session/plan-mode.ts`
- Test: `test/session/plan-mode.test.ts`, `test/plan-mode/review.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // src/plan-mode/review.ts
  export type PlanApprovalChoice = "execute" | "compact" | "keep";
  export interface PlanReviewModel {
  	details: PlanApprovalDetails;          // from session.preparePlanForReview
  	options: PlanReviewOption[];           // extension type, types.ts:1287-1301
  	tiers: PlanReviewTier[];               // from session.getRoleModelCycle
  	restoredTierIndex: number;
  }
  export function buildPlanReview(session: PlanReviewSession, details: PlanApprovalDetails): PlanReviewModel;
  // PlanModeController gains:
  approve(input: {
  	review: PlanReviewModel;
  	choice: PlanApprovalChoice;
  	tierIndex?: number;
  	hooks: { newSession(): Promise<boolean>; compact(instructions: string): Promise<CompactionOutcome> };
  }): Promise<boolean>; // false when the owner's hook declined or compaction did not finish
  ```
- `approve` carries IM `#approvePlan` (5777-5898) and `#applyPlanExecutionModel` (5772) minus statuses: `exit({paused:false, deferModelRestore:true})`, then `hooks.newSession()` + `copyLocalArtifacts` (execute) or `hooks.compact(planCompactPrompt)` (compact), `restoreNonMCPToolPresentation`, `setPlanReferencePath`, `autosaveApprovedPlan`, execution model, `setSessionName(humanizePlanTitle(...))`, `markPlanReferenceSent`, approved prompt. Calls `suppressNextStartupDefault()` before `hooks.newSession()`.

- [ ] **Step 1: Write the failing tests:**
  - `review.test.ts`: `"buildPlanReview lists execute, compact and keep and the role tiers with the current one restored"`.
  - `plan-mode.test.ts`: `"approve execute starts a new session, sets the plan reference and sends the approved prompt"` (hooks backed by `session.newSession`), `"approve compact passes the plan-compact instructions and keeps the transcript"`, `"approve with a cancelled compaction stays in plan mode and sends nothing"` (Review Focus 4), `"approve execute does not re-enter plan mode on the new session"`.

- [ ] **Step 2: Run** `bun test test/session/plan-mode.test.ts test/plan-mode/review.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `buildPlanReview` from the option and tier building in IM `handlePlanApproval` (6621-6728) and `approve` as above.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(session): decide and apply plan approval in the session`.

### Task 4: `InteractiveMode` delegates to the controller

**Files:**
- Modify: `src/modes/interactive-mode.ts`, `src/modes/types.ts`, `src/modes/controllers/input-controller.ts` (shortcut at 691-696 keeps calling `handlePlanModeCommand`)
- Test: existing suites only

**Interfaces:**
- Consumes: Tasks 1-3.
- `init` calls `session.enablePlanMode({ onChanged: () => this.#updatePlanModeStatus(), entryBlocked: () => vibe/plan warnings, applyStartupDefault: true })` when not `hostedClientMode` (next to `enableGoalMode` at IM 2633), and drops `#applyPlanModeDefault` calls at 2650 and 8038.
- `handlePlanModeCommand` (5977) keeps its draft-confirm dialog (5992) and maps to `handle({op})`.
- `handlePlanApproval` (6621) keeps the silent abort, the overlay, the slider, annotations and extension events, and on close calls `buildPlanReview` + `planMode.approve(...)` with hooks `newSession: () => this.handleClearCommand(...)`, `compact: i => this.handleCompactCommand(i)`.
- `#reconcileModeFromSession` keeps only vibe and goal; plan reconcile is the controller's.

- [ ] **Step 1: Make the change** (delete the moved fields and methods; add getters in `types.ts`).

- [ ] **Step 2: Run** from `packages/coding-agent`:
  `bun test test/interactive-mode-plan-review.test.ts test/interactive-mode-plan-mode-exit.test.ts test/interactive-mode-plan-paused-guard.test.ts test/interactive-mode-default-plan-mode.test.ts test/agent-session-plan-mode-convergence.test.ts test/modes/controllers/event-controller-plan-approval-dispatch.test.ts test/plan-autosave.test.ts test/plan-mode test/goals test/session`
  Expected: all PASS. A test that fails only because it reads a removed private field is rewritten to assert the same behavior through `session.planMode.view` or the session; any other failure is a regression to fix.

- [ ] **Step 3: Run** repository-root `bun run check:ts`. Expected: no errors, no format issues.

- [ ] **Step 4: Commit** `refactor(tui): drive plan mode from the session controller`.

### Task 5: Docs and verification

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-session-host-design.md` (P3 row: mark plan state as session-owned, review over RPC pending part 2)
- Modify: `packages/coding-agent/CHANGELOG.md` only if Task 4 changed visible behavior

- [ ] **Step 1: Update the spec row.**
- [ ] **Step 2: Run** `bun test test/session-host test/session test/goals test/modes test/plan-mode test/rpc-goal.test.ts` from `packages/coding-agent` and root `bun run check:ts`. Expected: all PASS (the known Mermaid rendering failure on plain `main` excepted).
- [ ] **Step 3: Commit** `docs: record session-owned plan mode`.

---

## Part 2 outline (separate plan after part 1 lands on the branch)

- Wire: `plan` command (`RpcPlanOp`), `plan: PlanModeView | null` on session state, `plan_mode_updated` event; regenerate with `scripts/gen-rpc`.
- `plan_review` extension UI request carrying `PlanReviewModel` (plan text, options, tiers), opt-in like `set_ask_dialog`; clients that did not opt in get a `select` fallback. The answer carries `choice`, `tierIndex` and refine feedback.
- `RpcServer` enables the controller (hosts with `applyStartupDefault: true`, plain RPC with `false`) and installs the proposal handler that sends `plan_review`.
- Hosted terminal: `/plan`, `/plan-review` and the shortcut route to `link.plan(...)`; the overlay answers `plan_review`; mirror `plan_mode_updated` and snapshot state; guard the replica's propose dispatch (scout §6 latent bug); extension `plan_review_requested`/`resolved` fire on the host.
