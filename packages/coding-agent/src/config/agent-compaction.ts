import { type CompactionMethod, isCompactionMethod } from "../session/compaction-methods";

/** Sparse compaction settings applied only to an exact-name subagent. */
export interface AgentCompactionPolicy {
	methodOrder?: CompactionMethod[];
	asyncEnabled?: boolean;
	autoContinue?: boolean;
}

/** Validate a policy without filling in inherited fields or retaining caller-owned arrays. */
export function validateAgentCompactionPolicy(value: unknown): AgentCompactionPolicy {
	if (value === null || typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]") {
		throw new Error("Invalid agent compaction policy: expected an object.");
	}
	for (const key of Reflect.ownKeys(value)) {
		if (key !== "methodOrder" && key !== "asyncEnabled" && key !== "autoContinue") {
			throw new Error(`Invalid agent compaction policy: unknown field ${String(key)}.`);
		}
	}

	const raw = value as Record<string, unknown>;
	const policy: AgentCompactionPolicy = {};
	if (Object.hasOwn(raw, "methodOrder")) {
		if (!Array.isArray(raw.methodOrder)) {
			throw new Error("Invalid agent compaction policy.methodOrder: expected an array of compaction methods.");
		}
		const methods: CompactionMethod[] = [];
		for (const method of raw.methodOrder) {
			if (!isCompactionMethod(method)) {
				throw new Error(`Invalid agent compaction policy.methodOrder: unsupported method ${String(method)}.`);
			}
			methods.push(method);
		}
		policy.methodOrder = methods;
	}
	for (const key of ["asyncEnabled", "autoContinue"] as const) {
		if (!Object.hasOwn(raw, key)) continue;
		const flag = raw[key];
		if (typeof flag !== "boolean") {
			throw new Error(`Invalid agent compaction policy.${key}: expected a boolean.`);
		}
		policy[key] = flag;
	}
	return policy;
}

/** An absent or YAML-empty map means no overrides; agent names are preserved exactly. */
export function validateAgentCompactionOverrides(value: unknown): Record<string, AgentCompactionPolicy> {
	if (value === undefined || value === null) return {};
	if (typeof value !== "object" || Object.prototype.toString.call(value) !== "[object Object]") {
		throw new Error("Invalid task.agentCompactionOverrides: expected a map of agent names to compaction policies.");
	}
	return Object.fromEntries(
		Reflect.ownKeys(value).map(agentName => {
			if (typeof agentName !== "string") {
				throw new Error("Invalid task.agentCompactionOverrides: agent names must be strings.");
			}
			try {
				return [agentName, validateAgentCompactionPolicy((value as Record<string, unknown>)[agentName])];
			} catch (error) {
				throw new Error(`Invalid task.agentCompactionOverrides.${agentName}: ${String(error)}`, { cause: error });
			}
		}),
	);
}
