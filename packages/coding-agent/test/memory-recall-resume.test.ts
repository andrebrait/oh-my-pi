/**
 * A transcript's first-turn memory recall is part of its system prompt, so it
 * is history: a session resumed in a new process must send the same block, not
 * a fresh recall from a memory store that has changed since, or the prompt
 * bytes differ and every provider prompt-cache entry for the transcript misses.
 * What changed in the recalled memories since is reported once, as a note
 * delivered with the next turn, instead of rewriting the block. A fresh recall
 * replaces the block only where the transcript asks a new question: another
 * memory store, a context reset, or a branch that edits the first prompt.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
import type { MemoryPromptPreparation } from "@oh-my-pi/pi-coding-agent/memory-backend/types";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
	setMnemopiSessionState,
} from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Mnemopi is lazy-loaded at runtime; preload it for synchronous state construction.
await Promise.all([loadMnemopi(), loadMnemopiCore()]);

const PROMPT = "Where is the deploy host?";
const states: MnemopiSessionState[] = [];
const dirs: TempDir[] = [];

afterEach(async () => {
	for (const state of states.splice(0)) await state.dispose({ consolidate: false });
	for (const dir of dirs.splice(0)) await dir.remove();
});

function tempDir(): TempDir {
	const dir = TempDir.createSync("@memory-recall-resume-");
	dirs.push(dir);
	return dir;
}

/** One omp process: a session over `sessionManager` with its own Mnemopi state on the store in `storeDir`. */
function startProcess(storeDir: TempDir, sessionManager: SessionManager): MnemopiSessionState {
	const settings = Settings.isolated({
		"memory.backend": "mnemopi",
		"mnemopi.scoping": "global",
		"mnemopi.dbPath": storeDir.join("mnemopi.db"),
		"mnemopi.noEmbeddings": true,
		"mnemopi.llmMode": "none",
	});
	const session = {
		sessionId: sessionManager.getSessionId(),
		settings,
		sessionManager,
		modelRegistry: {
			getApiKeyForProvider: async () => undefined,
			resolver: () => async () => undefined,
		},
		getXdevToolEntries: () => [],
		emitNotice: () => {},
		getHindsightSessionState: () => undefined,
		subscribe: () => () => {},
		refreshBaseSystemPrompt: async () => {},
	};
	const state = new MnemopiSessionState({
		sessionId: session.sessionId,
		config: loadMnemopiConfig(settings, storeDir.path()),
		session: session as never,
	});
	setMnemopiSessionState(session as never, state);
	states.push(state);
	return state;
}

async function resume(storeDir: TempDir, sessionFile: string, sessionDir: TempDir): Promise<MnemopiSessionState> {
	return startProcess(storeDir, await SessionManager.open(sessionFile, sessionDir.join("sessions")));
}

async function prepareFirstTurn(state: MnemopiSessionState): Promise<MemoryPromptPreparation> {
	const preparation = await mnemopiBackend.beforeAgentStartPrompt?.(state.session, PROMPT);
	if (!preparation) throw new Error("no first-turn recall was prepared");
	return preparation;
}

/** Runs the first turn's recall; returns the block and the change note delivered with it. */
async function firstTurn(state: MnemopiSessionState): Promise<{ block?: string; notice?: string }> {
	const preparation = await prepareFirstTurn(state);
	expect(preparation.commit()).toBe(true);
	return { block: preparation.context, notice: preparation.notice };
}

function newSession(dir: TempDir): SessionManager {
	return SessionManager.create(dir.path(), dir.join("sessions"));
}

async function writeTranscript(sessionManager: SessionManager): Promise<string> {
	sessionManager.appendMessage({ role: "user", content: PROMPT, timestamp: Date.now() });
	sessionManager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "alpha-7" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	});
	await sessionManager.flush();
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) throw new Error("session was not persisted");
	return sessionFile;
}

function recallEntryCount(sessionManager: SessionManager): number {
	return sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "memory_recall")
		.length;
}

/** A transcript whose first turn recalled `memory`, with its store and session file. */
async function recalledTranscript(memory: string) {
	const dir = tempDir();
	const live = startProcess(dir, newSession(dir));
	const id = live.rememberScoped(memory);
	const { block } = await firstTurn(live);
	expect(block).toContain(memory);
	const sessionFile = await writeTranscript(live.session.sessionManager);
	return { dir, live, id, block, sessionFile };
}

describe("Mnemopi recall across a resume", () => {
	it("sends the recalled block unchanged, with no note, when its memories are unchanged", async () => {
		const { dir, live, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		// A memory retained after the first turn would change a fresh recall.
		live.rememberScoped("The deploy host moved to beta-9.");

		const resumed = await resume(dir, sessionFile, dir);
		expect(await firstTurn(resumed)).toEqual({ block, notice: undefined });
		expect(recallEntryCount(resumed.session.sessionManager)).toBe(1);
	});

	it("reuses the block when the first turn's background agent_start recall claims it", async () => {
		const { dir, live, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		live.rememberScoped("The deploy host moved to beta-9.");

		const resumed = await resume(dir, sessionFile, dir);
		await resumed.maybeRecallOnAgentStart();
		expect(resumed.lastRecallSnippet).toBe(block);
	});

	it("keeps a first turn that recalled nothing memory-free after the store fills", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		expect((await firstTurn(live)).block).toBeUndefined();
		const sessionFile = await writeTranscript(live.session.sessionManager);
		live.rememberScoped("The deploy host is alpha-7.");

		expect(await firstTurn(await resume(dir, sessionFile, dir))).toEqual({ block: undefined, notice: undefined });
	});

	it("reports a forgotten memory once, keeping the block", async () => {
		const { dir, live, id, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		expect(live.editScopedMemory("forget", id).status).toBe("deleted");

		const resumed = await resume(dir, sessionFile, dir);
		const turn = await firstTurn(resumed);
		expect(turn.block).toBe(block);
		expect(turn.notice).toContain("No longer in memory");
		expect(turn.notice).toContain("The deploy host is alpha-7.");

		// Once reported, a later resume does not report it again.
		const reportedFile = await writeTranscript(resumed.session.sessionManager);
		expect(await firstTurn(await resume(dir, reportedFile, dir))).toEqual({ block, notice: undefined });
	});

	it("reports an invalidated memory as no longer in memory", async () => {
		const { dir, live, id, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		expect(live.editScopedMemory("invalidate", id).status).toBe("invalidated");

		const turn = await firstTurn(await resume(dir, sessionFile, dir));
		expect(turn.block).toBe(block);
		expect(turn.notice).toContain("No longer in memory");
	});

	it("reports an updated memory with its current content", async () => {
		const { dir, live, id, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		expect(live.editScopedMemory("update", id, { content: "The deploy host is beta-9." }).status).toBe("updated");

		const turn = await firstTurn(await resume(dir, sessionFile, dir));
		expect(turn.block).toBe(block);
		expect(turn.notice).toContain("Recalled as: The deploy host is alpha-7.");
		expect(turn.notice).toContain("Now: The deploy host is beta-9.");
	});

	it("reports memories wiped by /memory clear", async () => {
		const { dir, live, block, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		await mnemopiBackend.clear(dir.path(), dir.path(), live.session);
		const rehydrated = getMnemopiSessionState(live.session);
		if (rehydrated) states.push(rehydrated);

		const turn = await firstTurn(await resume(dir, sessionFile, dir));
		expect(turn.block).toBe(block);
		expect(turn.notice).toContain("No longer in memory");
		expect(turn.notice).toContain("The deploy host is alpha-7.");
	});

	it("reports a change again when the turn that carried the note never ran", async () => {
		const { dir, live, id, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");
		expect(live.editScopedMemory("forget", id).status).toBe("deleted");

		// The note's turn is prepared and committed, but no message follows it.
		const interrupted = await resume(dir, sessionFile, dir);
		await firstTurn(interrupted);
		await interrupted.session.sessionManager.flush();

		expect((await firstTurn(await resume(dir, sessionFile, dir))).notice).toContain("No longer in memory");
	});

	it("recalls afresh from a different memory store", async () => {
		const { dir, sessionFile } = await recalledTranscript("The deploy host is alpha-7.");

		const otherStore = tempDir();
		const elsewhere = await resume(otherStore, sessionFile, dir);
		elsewhere.rememberScoped("The deploy host is gamma-3.");
		const { block, notice } = await firstTurn(elsewhere);
		expect(block).toContain("gamma-3");
		expect(block).not.toContain("alpha-7");
		expect(notice).toBeUndefined();
	});

	it("recalls afresh after a context reset", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		await firstTurn(live);
		live.rememberScoped("The deploy host moved to beta-9.");
		live.session.sessionManager.appendResetBoundary();
		const sessionFile = await writeTranscript(live.session.sessionManager);

		expect((await firstTurn(await resume(dir, sessionFile, dir))).block).toContain("beta-9");
	});

	it("recalls afresh for a branch that edits the first prompt", async () => {
		const { live } = await recalledTranscript("The deploy host is alpha-7.");
		live.rememberScoped("The deploy host moved to beta-9.");

		const sessionManager = live.session.sessionManager;
		const firstPrompt = sessionManager.getEntries().find(entry => entry.type === "message");
		if (!firstPrompt?.parentId) throw new Error("first prompt has no parent");
		sessionManager.createBranchedSession(firstPrompt.parentId);
		const store = tempDir();
		const branched = startProcess(store, sessionManager);
		branched.rememberScoped("The deploy host is gamma-3.");
		expect((await firstTurn(branched)).block).toContain("gamma-3");
	});
});

describe("Hindsight recall across a resume", () => {
	const config: HindsightConfig = {
		hindsightApiUrl: "http://localhost:8888",
		hindsightApiToken: null,
		bankId: null,
		bankIdPrefix: "",
		scoping: "global",
		bankMission: "",
		retainMission: null,
		autoRecall: true,
		autoRetain: false,
		retainMode: "full-session",
		retainEveryNTurns: 3,
		retainOverlapTurns: 2,
		retainContext: "omp",
		recallBudget: "mid",
		recallMaxTokens: 1024,
		recallTypes: [],
		recallContextTurns: 1,
		recallMaxQueryChars: 800,
		recallPromptPreamble: "preamble",
		debug: false,
		requestTimeoutMs: 30_000,
		reflectTimeoutMs: 120_000,
		recallTimeoutMs: 30_000,
		retainTimeoutMs: 60_000,
		mentalModelsEnabled: false,
		mentalModelAutoSeed: false,
		mentalModelMaxRenderChars: 16_000,
	};

	function startHindsight(
		sessionManager: SessionManager,
		bankId: string,
		memory: string,
		hindsightApiToken: string | null = null,
	): HindsightSessionState {
		const client = { recall: async () => ({ results: [{ id: "m", text: memory }] }) } as unknown as HindsightApi;
		return new HindsightSessionState({
			sessionId: sessionManager.getSessionId(),
			client,
			bankId,
			config: { ...config, hindsightApiToken },
			session: { sessionManager, subscribe: () => () => {} } as never,
			banksSet: new Set(),
		});
	}

	async function hindsightFirstTurn(state: HindsightSessionState): Promise<string | undefined> {
		const preparation = await state.beforeAgentStartPrompt(PROMPT);
		expect(preparation?.commit()).toBe(true);
		return preparation?.context;
	}

	it("reuses the transcript's recall for the same bank and account only", async () => {
		const dir = tempDir();
		const live = startHindsight(newSession(dir), "project", "The deploy host is alpha-7.");
		const sent = await hindsightFirstTurn(live);
		expect(sent).toContain("alpha-7");
		const sessionFile = await writeTranscript(live.session.sessionManager);

		const sessions = dir.join("sessions");
		const resumed = startHindsight(await SessionManager.open(sessionFile, sessions), "project", "moved to beta-9");
		expect(await hindsightFirstTurn(resumed)).toBe(sent);

		const otherBank = startHindsight(await SessionManager.open(sessionFile, sessions), "other", "gamma-3");
		expect(await hindsightFirstTurn(otherBank)).toContain("gamma-3");

		const otherAccount = startHindsight(
			await SessionManager.open(sessionFile, sessions),
			"project",
			"delta-4",
			"token",
		);
		expect(await hindsightFirstTurn(otherAccount)).toContain("delta-4");
	});
});
