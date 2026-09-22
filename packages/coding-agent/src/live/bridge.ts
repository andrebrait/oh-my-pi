/**
 * Localhost WebSocket bridge that exposes a live voice session to remote
 * clients such as a browser UI.
 *
 * The bridge keeps every privileged piece — Codex OAuth, device attestation,
 * and the native WebRTC peer — inside the omp process. Clients only stream
 * microphone audio in and receive remote audio plus session events out:
 *
 * - Client → server binary frames: 16 kHz mono Int16 LE PCM (microphone).
 * - Client → server JSON frames: {@link LiveBridgeClientEvent} objects.
 * - Server → client binary frames: 48 kHz mono Int16 LE PCM (remote output).
 * - Server → client JSON frames: {@link LiveBridgeServerEvent} objects.
 *
 * The endpoint requires the single-use token returned by the owner (RPC
 * `live_bridge_start`) and accepts one attached client at a time. Binds
 * loopback only: anything that can reach this port can stream audio.
 */
import { timingSafeEqual } from "node:crypto";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import { logger } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import { float32ToInt16, int16ToFloat32, RemoteLiveAudioSource } from "./audio-source";
import { LiveSessionController, type LiveTranscript } from "./controller";

/** Input sample rate the bridge accepts from clients. */
export const LIVE_BRIDGE_INPUT_SAMPLE_RATE = 16_000;
/** Output sample rate the bridge delivers to clients. */
export const LIVE_BRIDGE_OUTPUT_SAMPLE_RATE = 48_000;

/** JSON frames the bridge sends to attached clients. */
export type LiveBridgeServerEvent =
	| {
			type: "ready";
			inputSampleRate: number;
			outputSampleRate: number;
			voice: string;
			/** Phase at attach time; later transitions arrive as `phase` frames. */
			phase: LivePhase;
	  }
	| { type: "phase"; phase: LivePhase }
	| { type: "levels"; input: number; output: number }
	| { type: "transcript"; transcript: LiveTranscript | undefined }
	| { type: "terminal"; error?: string };

function isLiveBridgeClientEvent(value: unknown): value is { type: "mute"; muted: boolean } | { type: "stop" } {
	if (typeof value !== "object" || value === null) return false;
	if ("type" in value && value.type === "mute") {
		return "muted" in value && typeof value.muted === "boolean";
	}
	return "type" in value && value.type === "stop";
}

/** Handlers the bridge invokes on behalf of the attached client. */
export interface LiveBridgeSink {
	onAudio(samples: Float32Array): void;
	onMuted(muted: boolean): void;
	onStop(): void;
	/** Invoked when a client attaches; one live client exists at a time. */
	onAttach(): void;
}

/** Options for {@link startLiveBridgeServer}. */
export interface LiveBridgeServerOptions {
	port?: number;
	/** Shared secret clients must present as `?token=`. Generated when unset. */
	token?: string;
	sink: LiveBridgeSink;
	/** Invoked once when the attached client disconnects. */
	onDetach?: () => void;
	log?: (message: string, data?: Record<string, unknown>) => void;
}

/** A running live bridge server. */
export interface LiveBridgeServer {
	port: number;
	token: string;
	/** Resolves when the attached client disconnects or the server stops. */
	done: Promise<void>;
	/** Sends one JSON event to the attached client, if any. */
	send(event: LiveBridgeServerEvent): void;
	/** Sends one 48 kHz mono output chunk to the attached client, if any. */
	sendSamples(samples: Float32Array): void;
	stop(): void;
}

interface BridgeSocketData {
	token: string;
}

type BridgeWebSocket = Bun.ServerWebSocket<BridgeSocketData>;

const WS_PING_INTERVAL_MS = 30_000;

function generateToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	return Buffer.from(bytes).toString("base64url");
}

function tokenMatches(presented: string | null, expected: string): boolean {
	if (!presented) return false;
	const presentedBytes = Buffer.from(presented);
	const expectedBytes = Buffer.from(expected);
	if (presentedBytes.length !== expectedBytes.length) return false;
	return timingSafeEqual(presentedBytes, expectedBytes);
}

/** Start the live bridge server on 127.0.0.1. Throws if the port is taken. */
export function startLiveBridgeServer(options: LiveBridgeServerOptions): LiveBridgeServer {
	const log = options.log ?? (() => {});
	const token = options.token ?? generateToken();
	const sink = options.sink;
	let socket: BridgeWebSocket | undefined;
	const pingInterval = setInterval(() => {
		if (socket) {
			socket.ping();
		}
	}, WS_PING_INTERVAL_MS);
	const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
	let settled = false;

	const finish = (): void => {
		if (settled) return;
		settled = true;
		clearInterval(pingInterval);
		resolveDone();
	};

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		fetch(req, srv): Response | undefined {
			const url = new URL(req.url);
			if (url.pathname.replace(/\/+$/, "") !== "/live") {
				return new Response("Not found", { status: 404 });
			}
			if (!tokenMatches(url.searchParams.get("token"), token)) {
				return new Response("Unauthorized", { status: 401 });
			}
			if (socket) {
				return new Response("Another live bridge client is attached", { status: 409 });
			}
			const success = srv.upgrade(req, { data: { token } });
			if (!success) return new Response("websocket upgrade required", { status: 426 });
			return undefined;
		},
		websocket: {
			open(opened: BridgeWebSocket): void {
				socket = opened;
				log("live bridge client attached");
				sink.onAttach();
			},
			message(opened: BridgeWebSocket, message: string | Uint8Array): void {
				if (typeof message === "string") {
					let parsed: unknown;
					try {
						parsed = JSON.parse(message);
					} catch {
						log("live bridge client sent invalid JSON");
						return;
					}
					if (!isLiveBridgeClientEvent(parsed)) {
						log("live bridge client sent unknown event");
						return;
					}
					if (parsed.type === "mute") {
						sink.onMuted(parsed.muted);
					} else {
						sink.onStop();
					}
					return;
				}
				sink.onAudio(int16ToFloat32(message));
			},
			close(closed: BridgeWebSocket): void {
				if (socket !== closed) return;
				socket = undefined;
				log("live bridge client detached");
				finish();
				options.onDetach?.();
			},
		},
	});

	// Bun types the bound port as optional; it is always set once serve() returns.
	const port = server.port ?? 0;

	return {
		port,
		token,
		done,
		send(event: LiveBridgeServerEvent): void {
			if (socket) {
				socket.send(JSON.stringify(event));
			}
		},
		sendSamples(samples: Float32Array): void {
			if (socket) {
				socket.send(float32ToInt16(samples));
			}
		},
		stop(): void {
			if (socket) {
				socket.close(1000, "live bridge stopped");
				socket = undefined;
			}
			finish();
			server.stop(true);
		},
	};
}

/** Options for {@link startLiveBridge}. */
export interface LiveBridgeOptions {
	/** Agent session that performs all delegated coding work. */
	session: AgentSession;
	/** Extracts visible assistant text using the host's normal UI rules. */
	extractAssistantText(message: AssistantMessage): string;
	/** Realtime output voice, defaulting to sol. */
	voice?: string;
	/** Port to bind, defaulting to an ephemeral loopback port. */
	port?: number;
}

/** A running live voice bridge, ready for a client to attach. */
export interface LiveBridgeHandle {
	url: string;
	port: number;
	token: string;
	controller: LiveSessionController;
	/** Resolves after the first controller start attempt settles. */
	started: Promise<void>;
	/** Resolves when the live session reaches a terminal state. */
	done: Promise<void>;
	stop(): Promise<void>;
}

/**
 * Start a live voice session whose microphone and playback live on a remote
 * client. Constructs the controller with a remote audio source, disables
 * local speaker playback, and exposes the WebSocket bridge.
 */
export function startLiveBridge(options: LiveBridgeOptions): LiveBridgeHandle {
	const log = (message: string, data?: Record<string, unknown>): void => {
		logger.debug("live bridge", { message, ...data });
	};
	const audioSource = new RemoteLiveAudioSource();
	const bridge: { server?: LiveBridgeServer } = {};
	const { promise: done, resolve: resolveDone } = Promise.withResolvers<void>();
	let settled = false;

	const settle = (): void => {
		if (!settled) {
			settled = true;
			resolveDone();
		}
	};

	const controller = new LiveSessionController({
		session: options.session,
		extractAssistantText: options.extractAssistantText,
		voice: options.voice,
		audioSource,
		playLocally: false,
		onOutputAudio: samples => bridge.server?.sendSamples(samples),
		callbacks: {
			onPhase: phase => bridge.server?.send({ type: "phase", phase }),
			onLevels: (input, output) => bridge.server?.send({ type: "levels", input, output }),
			onTranscript: transcript => bridge.server?.send({ type: "transcript", transcript }),
			onTerminal: error => {
				bridge.server?.send({ type: "terminal", error: error?.message });
				settle();
				bridge.server?.stop();
			},
		},
	});

	bridge.server = startLiveBridgeServer({
		port: options.port,
		sink: {
			onAudio: samples => audioSource.feed(samples),
			onMuted: muted => controller.setMuted(muted),
			onStop: () => void controller.stop(),
			onAttach: () => {
				bridge.server?.send({
					type: "ready",
					inputSampleRate: LIVE_BRIDGE_INPUT_SAMPLE_RATE,
					outputSampleRate: LIVE_BRIDGE_OUTPUT_SAMPLE_RATE,
					voice: options.voice ?? "",
					phase: controller.phase,
				});
			},
		},
		onDetach: () => void controller.stop(),
		log,
	});
	const server = bridge.server;

	const started = controller.start().catch(cause => {
		settle();
		server.stop();
		throw cause;
	});

	return {
		url: `ws://127.0.0.1:${server.port}/live`,
		port: server.port,
		token: server.token,
		controller,
		started,
		done,
		stop: () => controller.stop(),
	};
}
