import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MENTAL_MODEL_FIRST_TURN_DEADLINE_MS } from "@oh-my-pi/pi-coding-agent/hindsight/mental-models";
import { type MCPLoadResult, MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { type CustomTool, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Contract: UI/RPC sessions (`hasUI`) defer MCP discovery off startup. A prompt that
// arrives while discovery is still connecting must not send its first request without
// the MCP routes: every later request (and, on resume, the previous process) carries
// them, so a first request without them changes the system prompt bytes and misses the
// provider prompt cache. The wait is bounded: a discovery slower than the deadline
// cannot hold the turn past it.

const MCP_TOOL_NAME = "mcp__probe_lookup";
const MCP_ROUTE = `xd://${MCP_TOOL_NAME}`;

const cleanups: Array<() => unknown> = [];

afterEach(async () => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Spins real event-loop turns (I/O included) without advancing fake timers. */
async function yieldUntil(done: () => boolean, turns = 1_000): Promise<void> {
	for (let turn = 0; turn < turns && !done(); turn++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

function connectedProbe(): MCPLoadResult {
	const tool: CustomTool = {
		name: MCP_TOOL_NAME,
		label: "probe/lookup",
		description: "Look a value up.",
		parameters: type({ q: "string" }),
		mcpServerName: "probe",
		mcpToolName: "lookup",
		async execute() {
			return { content: [{ type: "text", text: "found" }] };
		},
	};
	return {
		tools: [tool as MCPLoadResult["tools"][number]],
		errors: new Map(),
		connectedServers: ["probe"],
		exaApiKeys: [],
	};
}

async function createDeferredSession() {
	const discovery = Promise.withResolvers<MCPLoadResult>();
	vi.spyOn(MCPManager.prototype, "discoverAndConnect").mockImplementation(() => discovery.promise);
	const root = TempDir.createSync("@pi-mcp-first-turn-");
	cleanups.push(() => root.removeSync());
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	cleanups.push(() => auth.close());
	const mock = createMockModel({ responses: [{ content: ["done"] }] });
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: new ModelRegistry(auth),
		model: mock,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
		}),
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableLsp: false,
		skipPythonPreflight: true,
		enableMCP: true,
		hasUI: true,
	});
	cleanups.push(() => session.dispose());
	const systemPrompts: string[] = [];
	const requested = Promise.withResolvers<void>();
	session.agent.streamFn = (model, context, options) => {
		systemPrompts.push((context.systemPrompt ?? []).join("\n"));
		requested.resolve();
		return mock.stream(model, context, options);
	};
	return { session, discovery, systemPrompts, requested };
}

describe("createAgentSession deferred MCP discovery and the first turn", () => {
	it("holds the first request until in-flight discovery lands so it carries the MCP routes", async () => {
		const { session, discovery, systemPrompts } = await createDeferredSession();
		vi.useFakeTimers();
		const prompted = session.prompt("hello");
		// Run the turn's real I/O and short timers while fake time stays short of the
		// deadline: without the wait the request leaves here, still lacking MCP.
		for (let ms = 1; ms < MENTAL_MODEL_FIRST_TURN_DEADLINE_MS && systemPrompts.length === 0; ms++) {
			await yieldUntil(() => systemPrompts.length > 0, 20);
			vi.advanceTimersByTime(1);
		}
		expect(systemPrompts.length).toBe(0);
		vi.useRealTimers();
		discovery.resolve(connectedProbe());
		await prompted;
		expect(systemPrompts[0]).toContain(MCP_ROUTE);
	});

	it("sends the first request at the deadline when discovery is still connecting", async () => {
		const { session, systemPrompts } = await createDeferredSession();
		vi.useFakeTimers();
		const prompted = session.prompt("hello");
		// The bounded wait arms the turn's first timer; park on it before moving the clock,
		// then step it to either side of the deadline.
		await yieldUntil(() => vi.getTimerCount() > 0, 100_000);
		vi.advanceTimersByTime(MENTAL_MODEL_FIRST_TURN_DEADLINE_MS - 1);
		await yieldUntil(() => systemPrompts.length > 0, 100);
		expect(systemPrompts.length).toBe(0);
		vi.advanceTimersByTime(1);
		vi.useRealTimers();
		await prompted;
		expect(systemPrompts).toHaveLength(1);
		expect(systemPrompts[0]).not.toContain(MCP_ROUTE);
	});
});
