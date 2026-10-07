/**
 * Keeps a transcript's first-turn memory recall with the transcript.
 *
 * The recall block becomes part of the system prompt, so it is history: a
 * session resumed in a new process sends the block it was sent with instead of
 * recalling again from a memory store that has changed since, which would
 * change the prompt bytes and miss every provider prompt-cache entry built on
 * them. Backends that can look memories up again also record which memories
 * the block holds, so a resume can report what changed since as a new message
 * rather than rewriting the block.
 */
import type { SessionEntry } from "../session/session-entries";
import type { SessionManager } from "../session/session-manager";

export const MEMORY_RECALL_ENTRY_TYPE = "memory_recall";

/** One memory in a recall block, as last reported to the model. */
export interface RecalledMemory {
	id: string;
	/** `Bun.hash` of the memory's stored content, hex. */
	hash: string;
	/** The memory's text as the model last saw it. */
	text: string;
}

export interface PersistedRecall {
	/** Recall block, `""` when the recall found nothing. */
	text: string;
	/** Memories the block holds that are still current as far as the model knows. */
	memories: RecalledMemory[];
}

interface MemoryRecallEntryData extends PersistedRecall {
	version: 2;
	/**
	 * Backend and memory banks the recall read. A recall is only restored into
	 * the same scope, so a backend switch or a cwd move never carries one
	 * project's memories into another.
	 */
	scope: string;
}

function isRecalledMemory(value: unknown): value is RecalledMemory {
	return (
		typeof value === "object" &&
		value !== null &&
		"id" in value &&
		typeof value.id === "string" &&
		"hash" in value &&
		typeof value.hash === "string" &&
		"text" in value &&
		typeof value.text === "string"
	);
}

function isMemoryRecallEntryData(data: unknown): data is MemoryRecallEntryData {
	return (
		typeof data === "object" &&
		data !== null &&
		"version" in data &&
		data.version === 2 &&
		"scope" in data &&
		typeof data.scope === "string" &&
		"text" in data &&
		typeof data.text === "string" &&
		"memories" in data &&
		Array.isArray(data.memories) &&
		data.memories.every(isRecalledMemory)
	);
}

/**
 * The latest recall for `scope` on the current branch that a turn followed.
 * Undefined when the branch needs a fresh recall: none was recorded since the
 * last context reset, or no turn followed one (a branch that edits the first
 * prompt asks a different question; an update whose turn never ran was never
 * reported).
 */
export function findPersistedRecall(
	sessionManager: Pick<SessionManager, "getBranch">,
	scope: string,
): PersistedRecall | undefined {
	const entries: SessionEntry[] = sessionManager.getBranch();
	let turnFollowed = false;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "reset_boundary") return undefined;
		if (entry.type === "message") turnFollowed = true;
		if (!turnFollowed || entry.type !== "custom" || entry.customType !== MEMORY_RECALL_ENTRY_TYPE) continue;
		if (!isMemoryRecallEntryData(entry.data) || entry.data.scope !== scope) continue;
		return { text: entry.data.text, memories: entry.data.memories };
	}
	return undefined;
}

/** Records a recall, or the memories still current after a change report. */
export function persistRecall(
	sessionManager: Pick<SessionManager, "appendCustomEntry">,
	scope: string,
	recall: PersistedRecall,
): void {
	sessionManager.appendCustomEntry(MEMORY_RECALL_ENTRY_TYPE, {
		version: 2,
		scope,
		text: recall.text,
		memories: recall.memories,
	} satisfies MemoryRecallEntryData);
}
