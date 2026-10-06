/**
 * Keeps a transcript's first-turn memory recall with the transcript.
 *
 * The recall block becomes part of the system prompt. Recalling again when a
 * session is resumed in a new process queries a memory store that has changed
 * since, so the prompt bytes, and every provider prompt-cache entry built on
 * them, would differ from what the transcript was sent with. Backends record
 * each recall here and reuse the latest one for the same scope (backend and
 * the banks it read) before recalling again.
 */
import type { SessionManager } from "../session/session-manager";

export const MEMORY_RECALL_ENTRY_TYPE = "memory_recall";

/** A recorded recall, or (`text: null`) a marker that discards every earlier recall on the branch. */
interface MemoryRecallEntryData {
	version: 1;
	/**
	 * Backend and memory banks the recall read. A recall is only restored into
	 * the same scope, so a backend switch or a cwd move never carries one
	 * project's memories into another. Empty on discard markers.
	 */
	scope: string;
	/** Recall block, `""` when the recall found nothing, `null` on a discard marker. */
	text: string | null;
}

function isMemoryRecallEntryData(data: unknown): data is MemoryRecallEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 1 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"text" in data &&
		(typeof data.text === "string" || data.text === null)
	);
}

/**
 * The latest recall for `scope` recorded on the current branch, `""` when that
 * recall found nothing. Undefined when the branch needs a fresh recall: none
 * was recorded since the last context reset or discard marker, or no turn
 * followed the recall on this branch (a branch that edits the first prompt
 * asks a different question).
 */
export function findPersistedRecall(
	sessionManager: Pick<SessionManager, "getBranch">,
	scope: string,
): string | undefined {
	const entries = sessionManager.getBranch();
	let turnFollowed = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") return undefined;
		if (entry.type === "message") turnFollowed = true;
		if (entry.type !== "custom" || entry.customType !== MEMORY_RECALL_ENTRY_TYPE) continue;
		if (!isMemoryRecallEntryData(entry.data)) continue;
		if (entry.data.text === null) return undefined;
		if (entry.data.scope !== scope) continue;
		return turnFollowed ? entry.data.text : undefined;
	}
	return undefined;
}

/** Records a committed recall; `""` records a recall that found nothing. */
export function persistRecall(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	scope: string,
	text: string,
): void {
	sessionManager.appendCustomEntry(MEMORY_RECALL_ENTRY_TYPE, {
		version: 1,
		scope,
		text,
	} satisfies MemoryRecallEntryData);
}

/**
 * Stops every earlier recall on the branch from being restored, whatever its
 * scope, once memories it may contain were cleared or edited.
 */
export function discardPersistedRecalls(sessionManager: Pick<SessionManager, "appendCustomEntry">): void {
	sessionManager.appendCustomEntry(MEMORY_RECALL_ENTRY_TYPE, {
		version: 1,
		scope: "",
		text: null,
	} satisfies MemoryRecallEntryData);
}
