# P3 idle-maintenance plan assessment and revision decisions

Date: 2026-10-05.

Revised plan: [2026-10-04-session-host-p3-idle-maintenance.md](../plans/2026-10-04-session-host-p3-idle-maintenance.md).

Scope: assessment and documentation only. The user requested simplification without reducing feature parity, then authorized revising and persisting the plan/findings. No implementation or runtime verification was performed for this revision.

Worktree: `/root/git/.oh-my-pi_worktrees/session-host-p3`, branch `feat/session-host-p3`. Current-PR fixes and review handling remain with the user's other session in the `session-host` worktree. Do not apply P3 changes to that PR. Implement only after incorporating its final merged code and reviewing this revised plan.

## Findings and disposition

### 1. The original plan silently reduced parity

Original plan line 43 called main-session-only maintenance an “Accepted change”, although the user had not accepted losing focused-subagent behavior. It also supplied an editor-composing probe only to the in-process TUI, leaving attached clients unable to suppress host idle work.

Evidence on the inspected P3 base:

- `packages/coding-agent/src/modes/controllers/event-controller.ts:2638-2667` checks `viewSession`, the editor draft, context threshold and busy state for idle compaction.
- The same file at `2670-2739` checks the draft and `viewSession` for recap arming/completion and records the generated result.
- `packages/coding-agent/src/modes/controllers/session-focus-controller.ts:175-215` retargets the subscription to the focused live session; focus is real state, not only a cosmetic overlay.
- That controller at `67-70` explicitly refuses hosted-client focus before reviving a local subagent. Therefore preserving local focus does **not** require implementing hosted focus in this slice.

Decision: preserve local focus and editor-draft suppression. Enable the same session scheduler for the locally focused real session, with inactive-view/UI-lifetime blockers. Preserve the hosted-focus refusal. For hosted drafts, send only an epoch-scoped composing boolean per connection and aggregate it on the host; never send draft contents. Removing either behavior requires explicit scope approval, not an implementation shortcut.

### 2. The proposed idle detector duplicated settlement logic

Evidence:

- `src/modes/rpc/rpc-session-settle.ts:43-50` already excludes streaming, admitted submissions, queued messages, pending async work and scheduled turns from settlement.
- Its `check()` at `101-130` handles async-work draining and RPC frame timing.
- `src/modes/controllers/event-controller.ts:2231-2254` already has the local async-drain/supersession behavior the original plan proposed copying again.

Decision: extract the transport-neutral predicate and drain loop into `src/session/session-settle.ts`. Both RPC and idle maintenance consume those functions. Keep RPC active/checking/recheck bookkeeping, scheduled-turn accounting, two-macrotask frame ordering and output in the RPC watcher. Do not introduce a generic scheduling framework or a second independently maintained settlement algorithm.

Additional requirement: invalidation must cover session transition/reload, focus suspension and disposal as well as `agent_start`. Merely cancelling a timer does not invalidate an already-awaiting settle check. Re-check activity generation after every await and before recording/emitting a recap.

### 3. Teardown was spread across three owners unnecessarily

Evidence:

- `src/session/agent-session.ts:2279-2282` exposes `addDisposer()`.
- `beginDispose()` at `5187-5200` synchronously rejects new work and drains disposers before asynchronous teardown.

Decision: register scheduler teardown once with the session's existing lifecycle. It owns settings/event/change unsubscriptions, timer cancellation and recap abort. The TUI owns only its activity/focus bindings; disconnect removes the host client's composing state, not the host scheduler. Keep opt-in activation and passive-replica protection. Drop the original mandatory duplicate-enable exception and returned scheduler-disable handles at every layer; repeated activation by the same owner must not duplicate the component or overwrite another owner's probes.

### 4. Compaction admission safety was a late, unproved dependency

Evidence:

- `src/session/agent-session.ts:6952-6973` routes prompt admission through `waitForManualMaintenanceCleanup()`.
- `src/session/session-maintenance.ts:1926-1935` waits on manual-compaction/handoff cleanup.
- Its `runIdleCompaction()` at `1985-1987` uses automatic maintenance instead.

These reads establish different admission paths. They do **not** prove that automatic idle compaction drops or races a prompt; that requires a runtime scenario.

Decision: prove content/image retention and ordering during automatic idle compaction **before** implementing timer enablement. If necessary, correct the shared admission boundary minimally. If a full compaction-queue ownership move is necessary, make it a prerequisite and update the follow-up order rather than enable unsafe behavior or quietly expand this slice. The revised plan explicitly marks this gate as unexecuted.

### 5. Tests should migrate contracts, not multiply wiring checks

Concrete recipe errors:

- `src/modes/rpc/rpc-types.ts:213` defines `RpcPromptStatus` as `completed | aborted | error`; the original test requested nonexistent `status: "ok"`.
- `test/helpers/rpc-server-harness.ts:38-57,78` applies its supplied gate after the first delta of every stream. Using an unresolved gate for the initial preparation prompt and then waiting for that prompt to settle deadlocks the proposed setup.
- The existing recap fixture in `test/modes/controllers/event-controller-idle-compaction.test.ts:192-197` returns both `replyText` and `assistantMessage`; the original plan's partial return fixture was not a complete typed ephemeral-turn result.

Decision: migrate timer/live-setting/stale-reply coverage to the session level; retain presenter and hosted-replica negative coverage, and add only distinct focus, shared settlement, admission and multi-client contracts. Hold only the summarization call after conversation preparation has settled, use complete results, and assert `completed` for successful RPC completion. Use deterministic timer boundaries plus real event/response barriers, not source-grep, mock forwarding or arbitrary sleeps.

## Deliberate choices retained

- One concrete component owns both timers: cancellation, activity and recap state are closely coupled.
- Keep the typed `idle_recap` event and existing `RecapNotice` presentation. Generic info notices currently route to `showStatus` (`event-controller.ts:1375-1383`), not recap presentation; overloading them would hide semantics in special cases.
- Regenerate wire/schema and TS/Python/Rust/Go SDK outputs. Generated file count is not a reason to weaken the contract.
- Preserve existing settings, clamping, model helpers, recap prompt and history database. No new settings, storage, dependencies, heartbeat, or automatic reconnect behavior.
- Keep separate follow-ups for goal, plan/deferred model switch, queue and loop. The ordering remains provisional until the admission prerequisite is proved.

## Evidence and handoff status

The code relationships above were checked with current source reads. An existing graph in the `session-host` worktree was queried for orientation; its line anchors are older, so the evidence here uses the P3 worktree source instead. No graph was rebuilt.

Plan revision and this decision record are saved locally and linked in both directions. Production code, tests, GitHub and deployment were not changed. The plan is not approved for implementation merely because it is now documented. Preserve the previously chosen subagent-driven execution method after plan review; do not ask the user to choose it again.
