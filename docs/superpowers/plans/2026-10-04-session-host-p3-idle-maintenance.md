# P3.1 Session-Owned Idle Compaction and Idle Recap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit or post to GitHub without the authorization required by the repository rules.

**Goal:** Move idle compaction and recap out of the TUI into one session-owned implementation, running exactly once with zero or multiple attached clients, without removing existing focus or draft-suppression behavior.

**Architecture:** A concrete session-owned `IdleMaintenance` component owns both timers and recap cancellation, using shared session-settlement helpers rather than copying another drain loop. The TUI supplies presentation/activity state; the host aggregates per-connection composing flags and owns the scheduler independently of client lifetime. A typed `idle_recap` session event carries the result to presenters; recap storage remains the existing history database.

**Tech Stack:** TypeScript, Bun, existing settings/lifecycle utilities, `bun:test`.

**Spec:** `docs/superpowers/specs/2026-10-01-session-host-design.md`, sections “State machines moved to the session or host” and “Phases”.

**Revision:** 2026-10-05, following the self-assessment. Decision record: [2026-10-05-session-host-p3-idle-maintenance-review.md](../reviews/2026-10-05-session-host-p3-idle-maintenance-review.md). This replaces the original plan, including its unapproved main-session-only simplification.

## Global Constraints

- Work only in `/root/git/.oh-my-pi_worktrees/session-host-p3`, branch `feat/session-host-p3`. Following the user's instruction to resume after updating the first PR, P3 is stacked on its verified head `1052c0dabf` while upstream workflow approval is pending. Rebase onto the final merged parent before publishing the follow-up; do not modify the first PR from this worktree.
- P3 remains separate follow-up PRs. Do not move goal, plan, loop, or the whole compaction input queue merely to make this slice easier.
- One scheduler per real session. Passive replicas never run maintenance. Opt-in remains explicit; stdio RPC, ACP, print mode and unfocused subagents do not acquire idle maintenance by default.
- Preserve the ordinary TUI's focused-subagent behavior. Hosted subagent focus currently throws “Viewing agents is unavailable when attached”; porting hosted focus is not part of this slice.
- Preserve suppression while an editor contains non-whitespace draft text. With multiple hosted clients, any composing UI client suppresses idle work. With zero clients, no client suppresses it. Never transmit or persist draft contents.
- Preserve setting ids/defaults: `compaction.idleEnabled=false`, `compaction.idleThresholdTokens=200000`, `compaction.idleTimeoutSeconds=300` clamped to 60–3600 s; `recap.enabled=true`, `recap.idleSeconds=240` clamped to 1–3600 s. Use `session.settings` and existing settings listeners.
- Stdio RPC wire behavior stays unchanged: no idle scheduler enabled there and no automatic new recap frames. Generate wire/SDK changes from their schema sources, never edit generated outputs manually.
- Use `AgentSession.addDisposer()` for session teardown at `beginDispose()`, existing prompt/model helpers, and centralized logging. No scheduler framework, new dependency, new storage format, polling heartbeat, or generalized client-presence service.
- Use fake timers for scheduler boundaries; await real admission/settlement/socket signals for ordering. Restore spies and clocks per test. No `mock.module()`, source-text tests, static-copy tests, or duplicate coverage across layers.
- Implementation verification includes actual TUI/host smoke proof, not just tests. Documentation changes are part of the behavior's task. This plan does not authorize commits, pushes, PR comments, or deployment.

## Review Focus

1. A prompt submitted during automatic idle compaction retains text/images and is processed after maintenance, without a second or lost turn. Task 1 establishes this prerequisite before any scheduler enablement.
2. Pending async work, admitted submissions, queued messages, or scheduled continuations do not count as idle. Background work that drains without waking the agent can still end the activity stretch. Task 2.
3. Session replacement, same-session reload, focus changes, or disposal invalidate pending checks/timers and late recap replies. Task 2 and Task 3.
4. Draft suppression is preserved locally and aggregated across hosted clients; disconnect cannot leave a permanent blocker. Task 3 and Task 4.
5. One recap model turn and persisted result are produced per idle stretch, whether zero or several clients are attached; passive replicas never produce one. Task 2 and Task 4.

## Follow-up order and prerequisite gate

The provisional order is idle maintenance, goal ownership, plan ownership (including its deferred model switch), compaction queue, then loop ownership. Only the idle-maintenance plan is specified here.

Task 1 is a real prerequisite, not a late test. The current `waitForManualMaintenanceCleanup()` barrier covers manual compaction/handoff, whereas idle compaction uses the automatic maintenance path. Safety during automatic compaction is not yet proved.

- If the existing admission/maintenance path passes Task 1, retain the order.
- If a small shared admission/maintenance fix closes the failure, include it as Task 1 and retain the order. Fix the boundary once for every caller, not just the hosted input controller.
- If correctness requires moving the full queue state machine, make the queue follow-up a prerequisite and update the order before implementing Tasks 2–4. Do not enable unsafe idle compaction or silently drop parity. Record the reproduced failure and dependency in the decision record.

These are evidence-driven execution branches, not approval to expand this slice with unrelated queue, plan or loop work.

## File and interface map

Paths below are relative to `packages/coding-agent/` unless explicitly prefixed otherwise. Paths name existing files except those explicitly marked “Create”. Re-read current sections after rebasing; quoted line anchors in the decision record describe the inspected base, not immutable edit coordinates.

| Area | Files | Responsibility |
|---|---|---|
| Shared admission boundary | `src/session/agent-session.ts`, `src/session/session-maintenance.ts`; existing `test/agent-session-auto-compaction-queue.test.ts`, `test/session-host/host.test.ts` | Prove/fix prompt retention during automatic idle maintenance. |
| Shared settlement | Create `src/session/session-settle.ts`; update `src/modes/rpc/rpc-session-settle.ts`, `rpc-server.ts`, `rpc-connection.ts`, `rpc-prompt-results.ts`, and `test/rpc-session-settle.test.ts` | Extract the reusable predicate/drain algorithm; retain transport timing and RPC output ownership. |
| Idle scheduler | Create `src/session/idle-maintenance.ts`, Create `test/session/idle-maintenance.test.ts`; update `src/session/agent-session.ts`, `agent-session-events.ts` | Own timers, activity generations, settings, recap computation and emission. |
| Local presentation and focus | `src/modes/interactive-mode.ts`, `types.ts`, `controllers/event-controller.ts`, `controllers/input-controller.ts`, `controllers/session-focus-controller.ts`; existing idle, hosted-input and focus tests | Replace TUI timer ownership with activity inputs and event presentation, preserving focus. |
| Hosted activity | `src/modes/rpc/rpc-types.ts`, `rpc-server.ts`, `rpc-connection.ts`, `rpc-client.ts`; `src/session-host/host.ts`, `hosted-client.ts`; existing host/hosted-client tests | Aggregate composing flags, clear them on disconnect/replacement, run maintenance without a client. |
| Wire contract | `src/modes/rpc/wire/commands.ts`, `events.ts`, and generator outputs | Typed composing command and recap event; regenerate TS/schema and Python/Rust/Go SDKs. |
| Documentation | Repository-root `docs/cli-reference.md`, `docs/rpc.md`, `packages/coding-agent/CHANGELOG.md` | Describe actual hosted ownership, composing suppression and recap event; retain unported parity rows. |

### Shared settlement contracts

Move `isRpcSessionSettled`'s transport-neutral predicate to `isSessionSettled(session: SessionSettleState, scheduledTurn?: () => boolean): boolean` in the new session module. `SessionSettleState` is the structural session surface for streaming, admitted submissions, queued messages and pending async work. The idle consumer additionally refuses maintenance during compaction or session transitions.

Extract the background-work loop to `waitForSessionSettlement(session: SessionSettleHost, options: { isCurrent: () => boolean; scheduledTurn?: () => boolean }): Promise<boolean>`. `SessionSettleHost` extends that surface with `settleAsyncWork()`. Wait only while owner-scoped background work can drain without a currently live/admitted run; recheck generation and settlement after every await. Return false when superseded or still busy, true only when the activity is current and quiet.

`RpcSessionSettleWatcher` retains its active/checking/recheck state, RPC scheduled-turn bookkeeping, two-macrotask ordering ahead of `session_settled`, and frame emission. It consumes the shared predicate/drain instead of retaining a second algorithm. Migrate callers/imports; do not keep aliases or move RPC frame-delay policy into the session helper.

### Session-owned scheduler contracts

- `AgentSession.enableIdleMaintenance(options?: { isBlocked?: () => boolean; scheduledTurn?: () => boolean }): void`: lazily create one scheduler, never on a passive replica. Repeated activation by the same owner is idempotent and does not create another scheduler or overwrite its owner probes. No new duplicate-enable exception is required.
- `AgentSession.refreshIdleMaintenance(): void`: re-evaluate activity blockers and existing pending deadlines; abort/cancel invalid work. Unblocking may re-arm a pending idle stretch, but must not generate another recap for an already completed stretch.
- `IdleMaintenance` is one concrete internal component, not a public pluggable service. It consumes the real session and the above probes, plus an internal event-emission callback and access to session transition generation/disposal state supplied by `AgentSession`.
- Register its teardown with `addDisposer()` at creation. Teardown unregisters session/settings/change listeners, cancels both timers, invalidates settling checks and aborts a running recap. Do not add independent scheduler disposal fields in `InteractiveMode` and `runSessionHost`; those owners remove their activity bindings when they leave.
- Keep one invalidation generation covering new activity, maintenance start/end, session transition/reload, focus suspension and disposal. A check or reply captured before invalidation cannot arm, record or emit afterward. Guard transitions at their start, not only after an id-change callback.
- Event: `{ type: "idle_recap"; recap: string }`. Carry the full nonblank generated reply, record it through `sessionManager.recordRecap`, and let the presenter use existing preview/sanitization utilities. Keep the existing recap prompt and goal/title/todo hints. Do not replace the recap with a generic status message or journal it into the model transcript.

### Hosted composing contract

Add a socket-only command `set_idle_activity` with `isComposing: boolean` and the normal optional `ifEpoch` guard. Hosted TUI calls always include their current epoch. Success data: `{ isComposing: boolean }`; stale commands use the existing stale error and perform no mutation. Validate the boolean at the wire boundary. Stdio connections reject the socket-only command without changing their behavior.

`RpcConnection` holds only its current composing flag and associated epoch. The host's `isBlocked` probe is true if any current UI connection is composing, or has not yet reported its initial state. Non-UI connections do not block idle maintenance. Disconnect removes the flag; session replacement invalidates old flags, with current UI clients reporting their state again. No draft text, persisted activity, heartbeat, or preference setting is added.

`RpcClient.setIdleActivity(isComposing: boolean, preconditions?: RpcPreconditions): Promise<void>` wraps this command. `HostedClientLink.setIdleActivity(isComposing: boolean): Promise<void>` supplies its epoch guard. Send the initial state after snapshot attachment, on epoch replacement, and on transitions of `editor.getText().trim() !== ""` through the existing `InputController` editor `onChange` hook. Serialize these updates per connection and coalesce obsolete intermediate booleans; a late clear must not override a newer non-empty draft. An uncertain or stale update must not falsely clear a blocker; surface connection failure through existing hosted-link handling, with no new reconnect policy.

## Task 1: Establish automatic-compaction admission safety

**Consumes:** Existing `AgentSession.runIdleCompaction()`, prompt admission, automatic maintenance lifecycle and real host/socket harness.

**Produces:** A proved shared admission contract, or an explicitly documented prerequisite that reorders the follow-ups before scheduler implementation.

- [ ] Add one consumer-visible regression scenario at the existing session maintenance test level: prepare a session with real retained conversation/context; start idle compaction; submit a prompt with text and an image while its summarization is deliberately held; release summarization; assert the prompt is retained exactly once and the subsequent model request sees the submitted content after maintenance. Keep the existing full-suite-safe stream/model seam.
- [ ] Run that scenario before changing production code. Do not assert `status: "ok"`; valid prompt outcomes are `completed`, `aborted`, or `error`, and the successful RPC outcome is `completed`.
- [ ] Hold **only the summarization call** after the initial prompt has settled. Do not pass an unresolved `createTestSession` gate when preparing the initial prompt: that gate holds every stream after its first text delta and would prevent setup from settling. Use a per-call provider/ephemeral-turn seam with a complete typed result, or install the stream spy only after preparation.
- [ ] If the scenario fails, trace every admission caller and make the minimal shared maintenance-boundary correction, preserving manual compact/handoff interruption/resume semantics. If that cannot be correct without the full queue move, record the blocker and change the follow-up order; do not continue Tasks 2–4 yet.
- [ ] Exercise the corresponding real socket `prompt` path while compaction is held. Observe success admission, `auto_compaction_end`, and the matching `prompt_result` with `status: "completed"`. A passing test is evidence; no source-grep or mock-forwarding assertions.

**Focused verification:** `bun test test/agent-session-auto-compaction-queue.test.ts test/session-host/host.test.ts` from `packages/coding-agent/`. Expected: the submitted content survives and the existing maintenance/resume scenarios remain green.

## Task 2: Shared settlement and session-owned timer behavior

**Consumes:** Task 1's proved admission boundary, existing settlement behavior, settings, recap generation and lifecycle infrastructure.

**Produces:** The shared settlement functions, `enableIdleMaintenance`, `refreshIdleMaintenance`, and `idle_recap` event defined above.

- [ ] Migrate existing timer-boundary, live-setting and stale-reply tests from `test/modes/controllers/event-controller-idle-compaction.test.ts` to the session-level test file. Keep their behavior assertions, not their old controller wiring. Use isolated settings, deterministic clocks, complete `runEphemeralTurn` results (including `assistantMessage`), and actual state transitions rather than inventing impossible event combinations.
- [ ] Add the distinct uncovered cases: background work drains without a wake; admitted/queued/scheduled input prevents idle work; session replacement/reload supersedes a pending settling check; activity/disposal rejects a late recap; repeated activation cannot produce duplicate model turns; a passive replica cannot schedule maintenance. Run the changed behavior tests against the pre-move implementation to establish the missing owner behavior. Already-covered preserved behaviors need not fail artificially.
- [ ] Extract the shared predicate and background-drain functions. Keep `RpcSessionSettleWatcher`'s protocol ordering and migrate all imports of the old predicate/type; preserve the existing RPC settlement suite rather than cloning it into the idle tests.
- [ ] Implement the concrete scheduler and register its cleanup once through `addDisposer()`. Arm only for a current, fully quiet activity stretch. Re-read busy/transition/blocker state at timer fire and after recap completion. Read settings from the session and preserve limits, blank-output suppression, recap persistence and error handling.
- [ ] Generate `idle_recap` from `wire/events.ts`; declare the session union event and regenerate outputs. Check that the event traverses the existing session-event decoder/forwarder, including any explicit event lists. No default scheduler in stdio/ACP/print/subagent creation.

**Focused verification:** Session idle tests, `test/rpc-session-settle.test.ts`, and `test/rpc-wire`. Expected: preserved RPC frame ordering and one generated recap per idle stretch, with none after supersession/disposal.

## Task 3: Local TUI cutover without losing focus/draft parity

**Consumes:** Task 2's session scheduler and typed event.

**Produces:** A local TUI that supplies activity/focus state and presents recaps, without owning timer/model work.

- [ ] Enable maintenance for the ordinary TUI's main session with `isBlocked` reading the current editor, view target and UI lifetime. Supply its existing pending goal/loop continuation state as the scheduled-turn probe; do not move those machines in this task.
- [ ] On local focus attachment, enable the focused real session through the same session method. Its blocker is true whenever it is no longer the active `viewSession`, the UI has left, or the editor is composing. Refresh the old and new targets on focus/unfocus/dispose, cancelling stale work without disposing someone else's live session. Unfocused subagents do not run new autonomous idle work. Preserve the existing hosted-focus refusal; never revive a local subagent from a passive replica.
- [ ] Render `idle_recap` with the existing `RecapNotice` and preview/sanitization functions through `EventController`. Because focus already retargets the event subscription, a recap is presented only in its owning view.
- [ ] Delete timer fields, timer/recap generation methods, refresh methods and their obsolete callsites from `EventController`/`InteractiveMode`/context interfaces. Remove unused imports. Retain the unrelated UI teardown for async-work drains and the goal/loop implementations; shared timer extraction does not authorize deleting that behavior.
- [ ] Keep presenter coverage and the hosted-replica negative contract; replace the old non-hosted controller-timer fixture with a real activated session. Add focus/unfocus and draft-at-fire cases to the existing focus/hosted-input suites: focused recap/compaction targets the focused session; leaving focus cancels its late reply; a nonblank draft prevents work. Do not re-pin incidental recap wording or duplicate all scheduler cases in UI tests.

**Focused verification:** Existing idle presenter, hosted-input and session-focus suites. Expected: same ordinary TUI focus/draft behavior, one displayed recap, and zero model work by a hosted replica.

## Task 4: Host ownership and minimal composing transport

**Consumes:** Tasks 1–3 and the final merged host startup/lifecycle implementation.

**Produces:** Host-owned idle maintenance with zero clients, multi-client draft suppression, and recap delivery to attached clients.

- [ ] Add the composing command and per-connection state defined above to the RPC handler/client/wire schema. Reuse existing epoch validation and disconnect paths; do not store state on the shared replica or serialize draft text. Settle response data from validated state. Ensure initial/epoch activity reporting can complete during extension startup without an idle task running against incomplete initialization.
- [ ] Wire one host scheduler after the RPC session observation machinery is installed, ensuring it observes startup activity before the first completed startup turn is lost. Block maintenance while initialization is incomplete. Give it the host's composing aggregate and existing goal-scheduled-turn probe. Session-owned cleanup starts before asynchronous shutdown work; merely detaching a terminal does not disable it.
- [ ] Extend the existing editor `onChange` path, not a second input listener or raw-key hook. Report only composing transitions plus initial/epoch state, serialize them, and route failures through the existing hosted-client lifecycle. On disconnect/replacement update the blocker and refresh pending idle deadlines. Zero clients remains an unblocked live host.
- [ ] Add host contracts: two attached clients each observe the same recap while the model and history produce only one result; with no clients the persisted recap still appears; one composing client suppresses work despite another being empty; disconnect removes its blocker; rapid composing/clear/composing updates preserve the latest state; a stale epoch update cannot clear a current blocker. Use authoritative persistence/events/ordered command responses, not “wait long enough” sleeps. Cover timer boundaries once in Task 2, not again via a 60-second socket delay.
- [ ] Add a real-process smoke: attach two terminals, produce an idle recap, type a draft in one terminal and observe suppression, detach both and observe a subsequent host-owned persisted recap. Exercise the actual recap surface with a model-backed run or a deterministic provider fixture; record which was used. Verify the ordinary TUI's focused view and draft handling as well. Delete throwaway smoke scaffolding afterward.
- [ ] Regenerate wire/SDK outputs for the command/event together. Update RPC/CLI references and the affected package's Unreleased changelog. Explain composing aggregation, zero-client operation, preserved local focus and hosted focus still being unavailable. Use the new follow-up PR's attribution after its number exists; do not reuse the parent PR number for these changes.

**Final verification, once after integration:** Run affected package-local suites (`test/session/idle-maintenance.test.ts`, existing automatic-compaction queue, RPC settlement, idle presenter, focus, hosted-input, `test/session-host`, and `test/rpc-wire`), then repo-root `bun check`, runtime/UI CI buckets and CLI smoke. Verify the generated SDKs with their existing check/build commands. All changed contracts and the actual surface smoke must pass before claiming completion.

## Self-review and implementation handoff

- [ ] Confirm each Review Focus item has its owning test, with no parity reduction disguised as an accepted simplification.
- [ ] Confirm exact new names/types match across session, RPC/client, wire and presenter code; check consumers with native LSP before changing exported symbols.
- [ ] Confirm the shared settlement algorithm is used by RPC and idle maintenance, while RPC output sequencing remains transport-owned.
- [ ] Confirm one lifecycle owner, passive-replica protection, same-session reload invalidation and no stale client blockers.
- [ ] Obtain plan review before implementation. Preserve the already chosen subagent-driven execution method; task boundaries are sequential dependencies, not parallel edits to shared session files.

This document is a revised plan, not evidence that prerequisites or behavior already pass. Tasks 1–4 are unexecuted. No implementation, commit, PR update or deployment is part of the plan-revision task.
