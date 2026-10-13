import { describe, expect, it } from "bun:test";
import {
	type AgentCompactionPolicy,
	validateAgentCompactionOverrides,
	validateAgentCompactionPolicy,
} from "@oh-my-pi/pi-coding-agent/config/agent-compaction";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

describe("agent compaction policy validation", () => {
	it("keeps empty and partial policies sparse, including explicit false and empty method order", () => {
		expect(validateAgentCompactionPolicy({})).toEqual({});
		expect(validateAgentCompactionPolicy({ asyncEnabled: false })).toEqual({ asyncEnabled: false });
		expect(validateAgentCompactionPolicy({ autoContinue: true })).toEqual({ autoContinue: true });
		expect(validateAgentCompactionPolicy({ methodOrder: [] })).toEqual({ methodOrder: [] });
	});

	it("copies method arrays so caller mutation cannot alter a validated policy", () => {
		const methodOrder = ["handoff", "remote", "snapcompact", "soft", "shake"];
		const policy = validateAgentCompactionPolicy({ methodOrder });
		methodOrder.reverse();
		expect(policy.methodOrder).toEqual(["handoff", "remote", "snapcompact", "soft", "shake"]);
	});

	it("does not turn inherited fields into configured policy", () => {
		const policy: Record<string, unknown> = Object.create({ asyncEnabled: false, methodOrder: ["invalid"] });
		policy.autoContinue = false;
		expect(validateAgentCompactionPolicy(policy)).toEqual({ autoContinue: false });
	});

	it.each([
		["null policy", null],
		["missing policy", undefined],
		["scalar policy", false],
		["array policy", []],
		["non-record policy", new Date(0)],
		["unknown field", { enabled: false }],
		["unknown symbol field", { [Symbol("extra")]: true }],
		["non-array method order", { methodOrder: "handoff" }],
		["unsupported method", { methodOrder: ["summary"] }],
		["sparse method array", { methodOrder: Array(1) }],
		["non-boolean async flag", { asyncEnabled: "false" }],
		["non-boolean continuation flag", { autoContinue: 1 }],
		["explicit undefined field", { asyncEnabled: undefined }],
	])("rejects %s", (_name, value) => {
		expect(() => validateAgentCompactionPolicy(value)).toThrow();
	});
});

describe("task.agentCompactionOverrides", () => {
	it("treats absent and YAML-empty maps as no overrides", () => {
		expect(validateAgentCompactionOverrides(undefined)).toEqual({});
		expect(validateAgentCompactionOverrides(null)).toEqual({});
	});

	it("rejects malformed maps and invalid agent entries", () => {
		for (const value of [
			"handoff",
			[],
			new Map(),
			{ [Symbol("task")]: {} },
			{ task: null },
			{ task: { thresholdTokens: 1000 } },
		]) {
			expect(() => validateAgentCompactionOverrides(value)).toThrow();
			expect(() => Settings.isolated({ "task.agentCompactionOverrides": value })).toThrow();
		}
	});

	it("preserves exact names and prototype-like names through settings layer merges", () => {
		const overrides = JSON.parse(
			'{"__proto__":{"asyncEnabled":false},"constructor":{"autoContinue":false},"Task":{"methodOrder":[]},"task":{}}',
		);
		const settings = Settings.isolated({ "task.agentCompactionOverrides": overrides });
		settings.set("task.agentCompactionOverrides", {
			["__proto__"]: { autoContinue: true },
			constructor: { asyncEnabled: true },
		});
		const policies = settings.get("task.agentCompactionOverrides");
		expect(Object.hasOwn(policies, "__proto__")).toBe(true);
		expect(policies.__proto__).toEqual({ asyncEnabled: false, autoContinue: true });
		expect(Object.getOwnPropertyDescriptor(policies, "constructor")?.value).toEqual({
			asyncEnabled: true,
			autoContinue: false,
		});
		expect(policies.Task).toEqual({ methodOrder: [] });
		expect(policies.task).toEqual({});
		expect(Object.getPrototypeOf(policies)).toBe(Object.prototype);
	});

	it("normalizes null maps and detaches settings from caller-owned policy arrays", () => {
		const settings = Settings.isolated({ "task.agentCompactionOverrides": null });
		expect(settings.get("task.agentCompactionOverrides")).toEqual({});
		const methodOrder: ("handoff" | "soft")[] = ["handoff"];
		settings.override("task.agentCompactionOverrides", { task: { methodOrder } });
		methodOrder.push("soft");
		expect(settings.get("task.agentCompactionOverrides").task.methodOrder).toEqual(["handoff"]);
	});

	it("rejects invalid runtime changes without replacing the previous policy", () => {
		const settings = Settings.isolated();
		settings.set("task.agentCompactionOverrides", { task: { asyncEnabled: false } });
		const invalid = { task: { autoContinue: "false" } } as unknown as Record<string, AgentCompactionPolicy>;
		expect(() => settings.set("task.agentCompactionOverrides", invalid)).toThrow();
		expect(() => settings.override("task.agentCompactionOverrides", invalid)).toThrow();
		expect(settings.get("task.agentCompactionOverrides")).toEqual({ task: { asyncEnabled: false } });
	});

	it("keeps ordinary sparse policy merges, array replacement and false override precedence", () => {
		const settings = Settings.isolated({
			"task.agentCompactionOverrides": { task: { methodOrder: [], asyncEnabled: false } },
		});
		settings.set("task.agentCompactionOverrides", {
			task: { methodOrder: ["soft"], asyncEnabled: true, autoContinue: false },
			scout: { asyncEnabled: true },
		});
		expect(settings.get("task.agentCompactionOverrides")).toEqual({
			task: { methodOrder: [], asyncEnabled: false, autoContinue: false },
			scout: { asyncEnabled: true },
		});
	});
});
