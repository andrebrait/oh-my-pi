import { afterAll, describe, expect, test } from "bun:test";
import { float32ToInt16, int16ToFloat32 } from "../src/live/audio-source";
import { type LiveBridgeServerEvent, type LiveBridgeSink, startLiveBridgeServer } from "../src/live/bridge";

type Resolvers = ReturnType<typeof Promise.withResolvers<void>>;

interface SinkCalls {
	audio: Float32Array[];
	muted: boolean[];
	stopped: number;
	attached: number;
	events: LiveBridgeServerEvent[];
	samples: Float32Array[];
	/** Resolved by the next matching handler call, wiring tests to real events. */
	nextAudio: Resolvers | undefined;
	nextMuted: Resolvers | undefined;
	nextStop: Resolvers | undefined;
	nextAttach: Resolvers | undefined;
}

function createSink(): { calls: SinkCalls; sink: LiveBridgeSink } {
	const calls: SinkCalls = {
		audio: [],
		muted: [],
		stopped: 0,
		attached: 0,
		events: [],
		samples: [],
		nextAudio: undefined,
		nextMuted: undefined,
		nextStop: undefined,
		nextAttach: undefined,
	};
	return {
		calls,
		sink: {
			onAudio: samples => {
				calls.audio.push(samples);
				calls.nextAudio?.resolve();
				calls.nextAudio = undefined;
			},
			onMuted: muted => {
				calls.muted.push(muted);
				calls.nextMuted?.resolve();
				calls.nextMuted = undefined;
			},
			onStop: () => {
				calls.stopped += 1;
				calls.nextStop?.resolve();
				calls.nextStop = undefined;
			},
			onAttach: () => {
				calls.attached += 1;
				calls.nextAttach?.resolve();
				calls.nextAttach = undefined;
			},
		},
	};
}

function nextEvent(client: WebSocket): Promise<{ data: string | ArrayBuffer }> {
	const { promise, resolve } = Promise.withResolvers<{ data: string | ArrayBuffer }>();
	const previous = client.onmessage;
	client.onmessage = event => {
		client.onmessage = previous;
		resolve({ data: event.data as string | ArrayBuffer });
	};
	return promise;
}

const servers: Array<{ stop(): void }> = [];
afterAll(() => {
	for (const server of servers) {
		server.stop();
	}
});

function openClient(server: { port: number; token: string }): Promise<WebSocket> {
	const { promise, resolve, reject } = Promise.withResolvers<WebSocket>();
	const client = new WebSocket(`ws://127.0.0.1:${server.port}/live?token=${server.token}`);
	client.binaryType = "arraybuffer";
	client.onopen = () => resolve(client);
	client.onerror = () => reject(new Error("client failed to connect"));
	return promise;
}

describe("live audio frame conversion", () => {
	test("round-trips Int16 LE bytes through Float32", () => {
		const original = new Float32Array([0, 0.25, -0.5, 1, -1]);
		const bytes = float32ToInt16(original);
		expect(bytes.length).toBe(original.length * 2);
		const restored = int16ToFloat32(bytes);
		expect(restored.length).toBe(original.length);
		for (let index = 0; index < original.length; index += 1) {
			// Int16 quantization keeps 15-bit precision; compare with slack.
			expect(Math.abs((restored[index] ?? 0) - (original[index] ?? 0))).toBeLessThan(0.001);
		}
	});

	test("clamps out-of-range samples instead of wrapping", () => {
		const bytes = float32ToInt16(new Float32Array([2, -2]));
		const restored = int16ToFloat32(bytes);
		expect(restored[0]).toBeCloseTo(1, 4);
		expect(restored[1]).toBeCloseTo(-1, 4);
	});

	test("drops a trailing odd byte instead of misaligning", () => {
		const bytes = float32ToInt16(new Float32Array([0.5]));
		const withGarbage = new Uint8Array(bytes.length + 1);
		withGarbage.set(bytes, 0);
		withGarbage[bytes.length] = 0xff;
		const restored = int16ToFloat32(withGarbage);
		expect(restored.length).toBe(1);
		expect(restored[0]).toBeCloseTo(0.5, 2);
	});
});

describe("live bridge server", () => {
	test("rejects missing and wrong tokens with 401", async () => {
		const { sink } = createSink();
		const server = startLiveBridgeServer({ token: "secret-token", sink });
		servers.push(server);

		const missing = await fetch(`http://127.0.0.1:${server.port}/live`);
		expect(missing.status).toBe(401);
		const wrong = await fetch(`http://127.0.0.1:${server.port}/live?token=nope`);
		expect(wrong.status).toBe(401);
	});

	test("accepts the token, relays audio and events, and rejects a second client", async () => {
		const { calls, sink } = createSink();
		const attached = Promise.withResolvers<void>();
		calls.nextAttach = attached;
		const server = startLiveBridgeServer({ token: "secret-token", sink });
		servers.push(server);

		const client = await openClient(server);
		await attached.promise;
		expect(calls.attached).toBe(1);

		// Microphone direction: binary Int16 LE PCM arrives as Float32 on the sink.
		calls.nextAudio = Promise.withResolvers();
		client.send(float32ToInt16(new Float32Array([0.5, -0.25])));
		calls.nextMuted = Promise.withResolvers();
		client.send(JSON.stringify({ type: "mute", muted: true }));
		await calls.nextMuted.promise;
		expect(calls.audio.length).toBe(1);
		expect(calls.audio[0]?.length).toBe(2);
		expect(calls.audio[0]?.[0]).toBeCloseTo(0.5, 2);
		expect(calls.muted).toEqual([true]);

		// Output direction: events as JSON, samples as binary Int16 LE PCM.
		const eventFrame = nextEvent(client);
		server.send({ type: "phase", phase: "listening" });
		const event = await eventFrame;
		const parsed = JSON.parse(event.data as string) as { type: string; phase: string };
		expect(parsed.type).toBe("phase");
		expect(parsed.phase).toBe("listening");

		const sampleFrame = nextEvent(client);
		server.sendSamples(new Float32Array([0.25, -0.75]));
		const samples = await sampleFrame;
		expect(samples.data instanceof ArrayBuffer).toBe(true);
		const output = int16ToFloat32(new Uint8Array(samples.data as ArrayBuffer));
		expect(output.length).toBe(2);
		expect(output[0]).toBeCloseTo(0.25, 2);
		expect(output[1]).toBeCloseTo(-0.75, 2);

		// A second client is refused while the first is attached.
		const second = await fetch(`http://127.0.0.1:${server.port}/live?token=secret-token`);
		expect(second.status).toBe(409);

		// Detach resolves the server and notifies the owner.
		client.close();
		await server.done;
		expect(calls.stopped).toBe(0);
	});

	test("reports client JSON stop requests to the sink", async () => {
		const { calls, sink } = createSink();
		const attached = Promise.withResolvers<void>();
		calls.nextAttach = attached;
		const server = startLiveBridgeServer({ token: "secret-token", sink });
		servers.push(server);

		const client = await openClient(server);
		await attached.promise;
		const stopped = Promise.withResolvers<void>();
		calls.nextStop = stopped;
		client.send(JSON.stringify({ type: "stop" }));
		await stopped.promise;
		expect(calls.stopped).toBe(1);
		client.close();
	});
});
