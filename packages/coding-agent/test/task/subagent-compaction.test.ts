import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentCompactionPolicy } from "@oh-my-pi/pi-coding-agent/config/agent-compaction";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings, runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createSessionDefaults } from "../helpers/session-defaults";

function compactionPolicy(settings: Settings): AgentCompactionPolicy {
	return {
		methodOrder: [...settings.get("compaction.methodOrder")],
		asyncEnabled: settings.get("compaction.asyncEnabled"),
		autoContinue: settings.get("compaction.autoContinue"),
	};
}

describe("subagent compaction policy isolation", () => {
	it("isolates scoped policy from parents, siblings, and unrelated compaction settings", () => {
		const baseline: AgentCompactionPolicy = {
			methodOrder: ["remote", "handoff"],
			asyncEnabled: true,
			autoContinue: true,
		};
		const parent = Settings.isolated({
			"compaction.methodOrder": baseline.methodOrder,
			"compaction.asyncEnabled": baseline.asyncEnabled,
			"compaction.autoContinue": baseline.autoContinue,
			"compaction.thresholdPercent": 85,
			"compaction.thresholdTokens": 111412,
			"compaction.keepRecentTokens": 12345,
			modelRoles: { default: "cloud/default", compaction: "cloud/compaction" },
		});
		const policy: AgentCompactionPolicy = {
			methodOrder: ["handoff"],
			asyncEnabled: false,
			autoContinue: false,
		};
		const child = createSubagentSettings(parent, undefined, undefined, policy);
		const sibling = createSubagentSettings(parent);

		expect(compactionPolicy(child)).toEqual(policy);
		expect(compactionPolicy(parent)).toEqual(baseline);
		expect(compactionPolicy(sibling)).toEqual(baseline);
		expect(child.get("compaction.thresholdPercent")).toBe(85);
		expect(child.get("compaction.thresholdTokens")).toBe(111412);
		expect(child.get("compaction.keepRecentTokens")).toBe(12345);
		expect(child.getModelRoles()).toEqual(parent.getModelRoles());
		policy.methodOrder?.push("shake");
		expect(child.get("compaction.methodOrder")).toEqual(["handoff"]);
		expect(parent.get("compaction.methodOrder")).toEqual(["remote", "handoff"]);
	});

	it("restores the original baseline for nested agents and applies each nested policy independently", () => {
		const parent = Settings.isolated({
			"compaction.methodOrder": ["remote", "soft"],
			"compaction.asyncEnabled": true,
			"compaction.autoContinue": true,
		});
		const worker = createSubagentSettings(parent, undefined, undefined, {
			methodOrder: ["handoff"],
			asyncEnabled: false,
			autoContinue: false,
		});
		const unmatched = createSubagentSettings(worker);
		const empty = createSubagentSettings(worker, undefined, undefined, {});
		const matched = createSubagentSettings(worker, undefined, undefined, { methodOrder: ["shake"] });
		const greatGrandchild = createSubagentSettings(matched);

		expect(compactionPolicy(unmatched)).toEqual(compactionPolicy(parent));
		expect(compactionPolicy(empty)).toEqual(compactionPolicy(parent));
		expect(compactionPolicy(matched)).toEqual({
			methodOrder: ["shake"],
			asyncEnabled: true,
			autoContinue: true,
		});
		expect(compactionPolicy(greatGrandchild)).toEqual(compactionPolicy(parent));
		unmatched.override("compaction.methodOrder", ["remote", "soft", "shake"]);
		expect(createSubagentSettings(worker).get("compaction.methodOrder")).toEqual(["remote", "soft"]);
		expect(worker.get("compaction.asyncEnabled")).toBe(false);
	});

	it("preserves explicit factory override precedence and legacy callers without a scoped policy", () => {
		const parent = Settings.isolated({ "compaction.asyncEnabled": false });
		const explicit = {
			"compaction.methodOrder": ["soft"],
			"compaction.asyncEnabled": true,
			"compaction.autoContinue": false,
		};
		const child = createSubagentSettings(parent, explicit, undefined, {
			methodOrder: ["handoff"],
			asyncEnabled: false,
			autoContinue: true,
		});
		expect(compactionPolicy(child)).toEqual({
			methodOrder: ["soft"],
			asyncEnabled: true,
			autoContinue: false,
		});
		const legacy = createSubagentSettings(parent, explicit);
		expect(compactionPolicy(createSubagentSettings(legacy))).toEqual(compactionPolicy(legacy));
		expect(parent.get("compaction.asyncEnabled")).toBe(false);
	});
});

describe("runSubprocess compaction policy selection", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("selects exact definition names, persists empty selections, and resets nested nonmatching agents", async () => {
		const policy: AgentCompactionPolicy = {
			methodOrder: ["handoff"],
			asyncEnabled: false,
			autoContinue: false,
		};
		const overrides = Object.fromEntries([
			["task", policy],
			["__proto__", { methodOrder: ["shake"] }],
		]);
		const settings = Settings.isolated({
			"compaction.methodOrder": ["remote", "soft"],
			"compaction.asyncEnabled": true,
			"compaction.autoContinue": true,
			"task.agentCompactionOverrides": overrides,
		});
		const children = new Map<string, Settings>();
		const journals = new Map<string, SessionManager>();
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options?.agentId || !options.settings || !options.sessionManager) {
				throw new Error("Expected subagent creation options");
			}
			children.set(options.agentId, options.settings);
			journals.set(options.agentId, options.sessionManager);
			const listeners: Array<(event: AgentSessionEvent) => void> = [];
			const session = {
				...createSessionDefaults(),
				state: { messages: [] },
				agent: { state: { systemPrompt: ["test"] } },
				model: undefined,
				extensionRunner: undefined,
				sessionManager: options.sessionManager,
				getActiveToolNames: () => ["yield"],
				getEnabledToolNames: () => ["yield"],
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.push(listener);
					return () => {};
				},
				prompt: async () => {
					for (const listener of listeners) {
						listener({
							type: "tool_execution_end",
							toolCallId: "compaction-yield",
							toolName: "yield",
							result: { content: [], details: { status: "success", data: { ok: true } } },
							isError: false,
						});
					}
				},
			} as unknown as AgentSession;
			return { session } as CreateAgentSessionResult;
		});
		const modelRegistry = {
			authStorage: {},
			getAvailable: () => [],
			hasConfiguredAuth: () => true,
		} as unknown as ModelRegistry;
		const run = async (name: string, baseSettings = settings): Promise<Settings> => {
			const id = `compaction-${name}`;
			const result = await runSubprocess({
				cwd: "/tmp",
				agent: { name, description: "test", systemPrompt: "test", source: "user" },
				task: "test",
				index: 0,
				id,
				settings: baseSettings,
				modelRegistry,
				enableLsp: false,
				enableIrc: false,
			});
			expect(result.exitCode).toBe(0);
			const child = children.get(id);
			if (!child) throw new Error("Expected child settings");
			const init = journals
				.get(id)
				?.getEntries()
				.findLast(entry => entry.type === "session_init");
			expect(init?.compactionPolicy).toEqual(Object.hasOwn(overrides, name) ? overrides[name] : {});
			return child;
		};

		const task = await run("task");
		expect(compactionPolicy(task)).toEqual(policy);
		expect(compactionPolicy(await run("Task"))).toEqual(compactionPolicy(settings));
		expect(compactionPolicy(await run("__proto__"))).toEqual({
			methodOrder: ["shake"],
			asyncEnabled: true,
			autoContinue: true,
		});
		expect(compactionPolicy(await run("constructor"))).toEqual(compactionPolicy(settings));
		expect(compactionPolicy(await run("cloud", task))).toEqual(compactionPolicy(settings));
		expect(settings.get("compaction.asyncEnabled")).toBe(true);
		expect(task.get("task.agentCompactionOverrides")).toEqual(overrides);
	});
});
