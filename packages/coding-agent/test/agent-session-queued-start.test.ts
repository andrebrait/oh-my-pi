import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanups.length) await cleanups.pop()!();
});

async function createSession(factory: ExtensionFactory, handler: MockHandler = { content: ["Done"] }) {
	const dir = TempDir.createSync("@pi-queued-start-");
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const modelRegistry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	const sessionManager = SessionManager.inMemory(dir.path());
	const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
	const runtime = new ExtensionRuntime();
	const extension = await loadExtensionFromFactory(factory, dir.path(), new EventBus(), runtime, "queued-start-test");
	const runner = new ExtensionRunner(
		[extension],
		runtime,
		dir.path(),
		sessionManager,
		modelRegistry,
		undefined,
		settings,
	);
	const errors: string[] = [];
	const requests: Context[] = [];
	const mock = createMockModel({ handler });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: getBundledModel("anthropic", "claude-sonnet-4-5")!,
			systemPrompt: ["base-system"],
			tools: [],
		},
		convertToLlm,
		streamFn: (model, context, options) => {
			requests.push(structuredClone(context));
			return mock.stream(model, context, options);
		},
	});
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, extensionRunner: runner });
	cleanups.push(async () => {
		await session.dispose();
		authStorage.close();
		dir.removeSync();
		expect(errors).toEqual([]);
	});
	await initializeExtensions(session, {
		reportSendError: (_action, error) => errors.push(error.message),
		reportRuntimeError: error => errors.push(error.error),
	});
	return { session, requests };
}

function requestText(context: Context): string {
	return context.messages
		.map(message =>
			typeof message.content === "string"
				? message.content
				: message.content.flatMap(part => (part.type === "text" && "text" in part ? [part.text] : [])).join("\n"),
		)
		.join("\n");
}

describe("AgentSession queued run before_agent_start", () => {
	it.each(["steer", "followUp"] as const)("prepares an idle %s before its queued provider request", async delivery => {
		const { session, requests } = await createSession(pi => {
			pi.on("before_agent_start", async event => {
				await Promise.resolve();
				return {
					systemPrompt: ["queued-system"],
					message: { customType: "queue-context", content: `Context for ${event.prompt}`, display: false },
				};
			});
		});
		// Fresh follow-ups intentionally wait for promotion; exercise their normal
		// auto-drain path after a completed turn without changing queue scheduling.
		if (delivery === "followUp") {
			await session.prompt("initial request");
			await session.waitForIdle();
		}

		await session[delivery]("first queued request");
		await session.waitForIdle();

		expect(requests).toHaveLength(delivery === "steer" ? 1 : 2);
		const request = requests.at(-1)!;
		expect(request.systemPrompt).toEqual(["queued-system"]);
		expect(requestText(request)).toContain("Context for first queued request");
	});

	it("does not repeat bootstrap messages when steering an already-running turn", async () => {
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let calls = 0;
		const { session, requests } = await createSession(
			pi => {
				pi.on("before_agent_start", event => ({
					message: { customType: "queue-context", content: `Bootstrap for ${event.prompt}`, display: false },
				}));
			},
			async () => {
				if (calls++ === 0) {
					entered.resolve();
					await release.promise;
				}
				return { content: ["Done"] };
			},
		);
		const prompt = session.prompt("original request");
		try {
			await entered.promise;
			await session.steer("mid-run correction");
		} finally {
			release.resolve();
		}
		await prompt;
		await session.waitForIdle();

		expect(requests).toHaveLength(2);
		const text = requestText(requests[1]);
		expect(text).toContain("mid-run correction");
		expect(text.match(/Bootstrap for /g)).toHaveLength(1);
		expect(text).toContain("Bootstrap for original request");
	});

	it("retains policy for synthetic continuations but refreshes it for the next idle user steer", async () => {
		const { session, requests } = await createSession(pi => {
			let enabled = true;
			pi.registerCommand("policy-off", {
				description: "Disable the test policy",
				handler: async () => {
					enabled = false;
				},
			});
			pi.on("before_agent_start", event => ({
				systemPrompt: enabled ? [...event.systemPrompt, "active-policy"] : event.systemPrompt,
				message: { customType: "queue-context", content: `Bootstrap for ${event.prompt}`, display: false },
			}));
		});
		await session.prompt("original request");
		await session.waitForIdle();
		await session.prompt("/policy-off");
		await session.followUp("internal continuation", undefined, { synthetic: true });
		await session.waitForIdle();

		expect(requests).toHaveLength(2);
		expect(requests[1].systemPrompt).toContain("active-policy");
		expect(requestText(requests[1])).toContain("internal continuation");
		expect(requestText(requests[1]).match(/Bootstrap for /g)).toHaveLength(1);

		await session.steer("next user request");
		await session.waitForIdle();

		expect(requests).toHaveLength(3);
		expect(requests[2].systemPrompt).not.toContain("active-policy");
		expect(requestText(requests[2])).toContain("Bootstrap for next user request");
	});
});
