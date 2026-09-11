import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

const image: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
};

describe("RPC external input hooks", () => {
	let client: RpcClient;
	let directory: string;
	let wire: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-input-"));
		wire = "";
		const extensionPath = path.join(directory, "input-extension.ts");
		await Bun.write(
			extensionPath,
			`
import * as fs from "node:fs/promises";
export default function (pi) {
	pi.on("input", async event => {
		await fs.appendFile(${JSON.stringify(path.join(directory, "inputs.jsonl"))}, JSON.stringify(event) + "\\n");
		if (event.text === "stop ponytail" || event.text === "/help") return { handled: true };
		if (event.text === "send raw") {
			pi.sendUserMessage("/raw-command");
			return { handled: true };
		}
		if (event.text.startsWith("intercept ")) return { text: event.text.slice(10), images: [] };
		if (event.text === "normal mode") return { text: "transformed normal mode", images: [${JSON.stringify(image)}] };
	});
	pi.registerCommand("raw-command", { description: "Must stay raw", handler: () => { throw new Error("raw command interpreted"); } });
}
`,
		);
		client = new RpcClient({
			spawn: () => {
				const child = Bun.spawn(
					[process.execPath, path.join(import.meta.dir, "fixtures", "queued-message-rpc-agent.ts")],
					{
						cwd: directory,
						env: {
							...process.env,
							PI_CODING_AGENT_DIR: directory,
							PI_NO_TITLE: "1",
							OMP_RPC_INPUT_EXTENSION: extensionPath,
						},
						stdin: "pipe",
						stdout: "pipe",
						stderr: "pipe",
					},
				);
				const decoder = new TextDecoder();
				let stderr = "";
				void new Response(child.stderr).text().then(text => {
					stderr = text;
				});
				return {
					stdin: child.stdin,
					stdout: child.stdout.pipeThrough(
						new TransformStream({
							transform(chunk, controller) {
								wire += decoder.decode(chunk, { stream: true });
								controller.enqueue(chunk);
							},
						}),
					),
					peekStderr: () => stderr,
					kill: () => {
						child.kill();
					},
					exited: child.exited,
				};
			},
		});
		await client.start();
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	const inputs = async (): Promise<unknown[]> =>
		Bun.JSONL.parse(await Bun.file(path.join(directory, "inputs.jsonl")).text());

	const finishTurn = async (send: () => Promise<unknown>) => {
		const ended = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") ended.resolve();
		});
		try {
			await send();
			await withTimeout(ended.promise, 10_000, "RPC input did not finish its turn");
		} finally {
			unsubscribe();
		}
	};

	for (const method of ["prompt", "steer", "followUp", "abortAndPrompt"] as const) {
		test(`${method} consumes handled input before execution or queueing`, async () => {
			await client[method]("stop ponytail", [image]);
			expect((await client.getState()).queuedMessageCount).toBe(0);
			expect((await client.getMessages()).filter(message => message.role === "user")).toEqual([]);
			expect(await inputs()).toEqual([{ type: "input", text: "stop ponytail", images: [image], source: "rpc" }]);
			if (method === "prompt") {
				expect(Bun.JSONL.parse(wire)).toContainEqual(
					expect.objectContaining({ type: "prompt_result", agentInvoked: false }),
				);
			}
		}, 30_000);
	}

	test("prompt transforms text and images before starting a turn", async () => {
		await finishTurn(() => client.prompt("normal mode"));
		const messages = (await client.getMessages()).filter(message => message.role === "user");
		expect(messages.map(message => message.content)).toEqual([
			[{ type: "text", text: "transformed normal mode" }, expect.objectContaining({ type: "image" })],
		]);
		expect(await inputs()).toEqual([{ type: "input", text: "normal mode", source: "rpc" }]);
	}, 30_000);

	for (const method of ["steer", "followUp"] as const) {
		test(`${method} transforms once before ${method === "steer" ? "its idle turn" : "deferred promotion"}`, async () => {
			if (method === "steer") {
				await finishTurn(() => client.steer("intercept queued request", [image]));
			} else {
				await client.followUp("intercept queued request", [image]);
				expect((await client.getState()).queuedMessageCount).toBe(1);
				await finishTurn(() => client.promoteQueuedMessage("queued request"));
			}
			expect(
				(await client.getMessages()).filter(message => message.role === "user").map(message => message.content),
			).toEqual([[{ type: "text", text: "queued request" }]]);
			expect(await inputs()).toEqual([
				{ type: "input", text: "intercept queued request", images: [image], source: "rpc" },
			]);
		}, 30_000);
	}

	test("handled builtin input does not execute the builtin", async () => {
		await client.prompt("/help");
		await client.getState();
		expect(Bun.JSONL.parse(wire)).not.toContainEqual(expect.objectContaining({ type: "command_output" }));
		expect(await inputs()).toEqual([{ type: "input", text: "/help", source: "rpc" }]);
	}, 30_000);

	test("handled input sending a raw extension message starts one turn without false local completion", async () => {
		await finishTurn(() => client.prompt("send raw"));
		await client.getState();
		expect(Bun.JSONL.parse(wire)).not.toContainEqual(
			expect.objectContaining({ type: "prompt_result", agentInvoked: false }),
		);
		expect(
			(await client.getMessages()).filter(message => message.role === "user").map(message => message.content),
		).toEqual([[{ type: "text", text: "/raw-command" }]]);
		expect(await inputs()).toEqual([{ type: "input", text: "send raw", source: "rpc" }]);
	}, 30_000);
});
