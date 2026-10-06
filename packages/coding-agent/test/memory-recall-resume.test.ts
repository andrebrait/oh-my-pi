/**
 * A transcript's first-turn memory recall is part of its system prompt. A
 * session resumed in a new process must send the same recall, not a fresh one
 * from a memory store that has changed since, or the prompt bytes differ and
 * every provider prompt-cache entry for the transcript misses. Recalls that no
 * longer describe the transcript's memories (other banks, a context reset, a
 * wiped or edited store, an edited first prompt) must be recalled afresh.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { hindsightBackend } from "@oh-my-pi/pi-coding-agent/hindsight/backend";
import type { HindsightApi } from "@oh-my-pi/pi-coding-agent/hindsight/client";
import type { HindsightConfig } from "@oh-my-pi/pi-coding-agent/hindsight/config";
import { HindsightSessionState } from "@oh-my-pi/pi-coding-agent/hindsight/state";
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

async function firstTurnRecall(state: MnemopiSessionState): Promise<string | undefined> {
	const preparation = await mnemopiBackend.beforeAgentStartPrompt?.(state.session, PROMPT);
	expect(preparation?.commit()).toBe(true);
	return preparation?.context;
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

describe("Mnemopi recall across a resume", () => {
	it("reuses the transcript's recall after the memory store changed, without growing the session", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		const sent = await firstTurnRecall(live);
		expect(sent).toContain("alpha-7");
		const sessionFile = await writeTranscript(live.session.sessionManager);

		// Memories retained after the first turn would change a fresh recall.
		live.rememberScoped("The deploy host moved to beta-9.");

		const resumed = await resume(dir, sessionFile, dir);
		expect(await firstTurnRecall(resumed)).toBe(sent);
		expect(recallEntryCount(resumed.session.sessionManager)).toBe(1);
	});

	it("reuses it when the first turn's background agent_start recall committed it", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		const sent = await firstTurnRecall(live);
		const sessionFile = await writeTranscript(live.session.sessionManager);
		live.rememberScoped("The deploy host moved to beta-9.");

		const resumed = await resume(dir, sessionFile, dir);
		await resumed.maybeRecallOnAgentStart();
		expect(resumed.lastRecallSnippet).toBe(sent);
	});

	it("keeps a first turn that recalled nothing memory-free after the store fills", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		expect(await firstTurnRecall(live)).toBeUndefined();
		const sessionFile = await writeTranscript(live.session.sessionManager);
		live.rememberScoped("The deploy host is alpha-7.");

		const resumed = await resume(dir, sessionFile, dir);
		expect(await firstTurnRecall(resumed)).toBeUndefined();
	});

	it("recalls afresh from a different memory store", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		await firstTurnRecall(live);
		const sessionFile = await writeTranscript(live.session.sessionManager);

		const otherStore = tempDir();
		const elsewhere = await resume(otherStore, sessionFile, dir);
		elsewhere.rememberScoped("The deploy host is gamma-3.");
		const recalled = await firstTurnRecall(elsewhere);
		expect(recalled).toContain("gamma-3");
		expect(recalled).not.toContain("alpha-7");
	});

	it("recalls afresh after a context reset", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		await firstTurnRecall(live);
		live.rememberScoped("The deploy host moved to beta-9.");
		live.session.sessionManager.appendResetBoundary();
		const sessionFile = await writeTranscript(live.session.sessionManager);

		const resumed = await resume(dir, sessionFile, dir);
		expect(await firstTurnRecall(resumed)).toContain("beta-9");
	});

	it("recalls afresh for a branch that edits the first prompt", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		await firstTurnRecall(live);
		const sessionManager = live.session.sessionManager;
		await writeTranscript(sessionManager);
		live.rememberScoped("The deploy host moved to beta-9.");

		const firstPrompt = sessionManager.getEntries().find(entry => entry.type === "message");
		if (!firstPrompt?.parentId) throw new Error("first prompt has no parent");
		sessionManager.createBranchedSession(firstPrompt.parentId);
		const branched = startProcess(dir, sessionManager);
		expect(await firstTurnRecall(branched)).toContain("beta-9");
	});

	it("does not bring back memories wiped by /memory clear", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		expect(await firstTurnRecall(live)).toContain("alpha-7");

		await mnemopiBackend.clear(dir.path(), dir.path(), live.session);
		const rehydrated = getMnemopiSessionState(live.session);
		if (!rehydrated) throw new Error("clear did not rehydrate the session state");
		states.push(rehydrated);
		rehydrated.rememberScoped("The deploy host is beta-9.");
		const sessionFile = await writeTranscript(live.session.sessionManager);

		const recalled = await firstTurnRecall(await resume(dir, sessionFile, dir));
		expect(recalled).toContain("beta-9");
		expect(recalled).not.toContain("alpha-7");
	});

	it("does not bring back a memory removed with memory_edit", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		const id = live.rememberScoped("The deploy password is hunter2.");
		expect(await firstTurnRecall(live)).toContain("hunter2");
		expect(live.editScopedMemory("forget", id).status).toBe("deleted");
		const sessionFile = await writeTranscript(live.session.sessionManager);

		expect(await firstTurnRecall(await resume(dir, sessionFile, dir))).toBeUndefined();
	});

	it("does not restore another scope's recall after a memory_edit", async () => {
		const dir = tempDir();
		const live = startProcess(dir, newSession(dir));
		live.rememberScoped("The deploy host is alpha-7.");
		await firstTurnRecall(live);
		let sessionFile = await writeTranscript(live.session.sessionManager);

		// Resumed against another store, the transcript gains a second scope's recall, then an edit there.
		const otherStore = tempDir();
		const elsewhere = await resume(otherStore, sessionFile, dir);
		const id = elsewhere.rememberScoped("The deploy host is gamma-3.");
		await firstTurnRecall(elsewhere);
		expect(elsewhere.editScopedMemory("forget", id).status).toBe("deleted");
		sessionFile = await writeTranscript(elsewhere.session.sessionManager);

		// Back on the first store, its old recall must not be restored: the turn recalls afresh and records it.
		const back = await resume(dir, sessionFile, dir);
		const recorded = recallEntryCount(back.session.sessionManager);
		await firstTurnRecall(back);
		expect(recallEntryCount(back.session.sessionManager)).toBe(recorded + 1);
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

	it("recalls afresh after /memory clear", async () => {
		const dir = tempDir();
		const live = startHindsight(newSession(dir), "project", "The deploy host is alpha-7.");
		await hindsightFirstTurn(live);
		let current: HindsightSessionState | undefined = live;
		const session = {
			sessionManager: live.session.sessionManager,
			getHindsightSessionState: () => current,
			setHindsightSessionState: (next: HindsightSessionState | undefined) => {
				const previous = current;
				current = next;
				return previous;
			},
		};
		await hindsightBackend.clear("/tmp", "/tmp", session as never);
		const sessionFile = await writeTranscript(live.session.sessionManager);

		const resumed = startHindsight(await SessionManager.open(sessionFile, dir.join("sessions")), "project", "beta-9");
		expect(await hindsightFirstTurn(resumed)).toContain("beta-9");
	});
});
