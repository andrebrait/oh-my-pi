#!/usr/bin/env bun
/**
 * Throwaway smoke test for the live voice bridge (not a permanent test).
 *
 * Spawns `omp --mode rpc` speaking raw JSONL, starts the live bridge with
 * the local Codex OAuth credential, attaches a WebSocket client, and prints
 * the first bridge events (ready + phase). Never opens the microphone and
 * never sends audio, so the call carries no speech and costs nothing.
 */
import * as path from "node:path";

const repo = path.resolve(import.meta.dir, "..");

function eventType(entry: unknown): string {
	if (typeof entry === "object" && entry !== null && "type" in entry) {
		const value = entry.type;
		if (typeof value === "string") return value;
	}
	return "unknown";
}

function readEndpoint(value: unknown): { url: string; token: string } | undefined {
	if (typeof value !== "object" || value === null || !("url" in value) || !("token" in value)) {
		return undefined;
	}
	const { url, token } = value;
	if (typeof url !== "string" || typeof token !== "string") return undefined;
	return { url, token };
}

const proc = Bun.spawn([process.execPath, path.join(repo, "src/cli.ts"), "--mode", "rpc", "--no-session"], {
	stdin: "pipe",
	stdout: "pipe",
	stderr: "pipe",
	cwd: repo,
	env: { ...process.env, PI_NO_TITLE: "1" },
});

function cleanup(code: number): never {
	proc.kill();
	process.exit(code);
}

// The child's stderr must be drained or a full pipe deadlocks the process.
const stderrChunks: string[] = [];
const stderrDecoder = new TextDecoder();
void (async () => {
	const reader = proc.stderr.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return;
		const text = stderrDecoder.decode(value, { stream: true });
		stderrChunks.push(text);
		if (stderrChunks.length > 400) stderrChunks.splice(0, 200);
	}
})();

function dumpStderr(reason: string): never {
	console.error(`SMOKE ABORT (${reason}). stderr tail:`);
	console.error(stderrChunks.join(""));
	cleanup(1);
}

const stdout = proc.stdout.getReader();
const decoder = new TextDecoder();
let buffer = "";

async function nextFrame(): Promise<Record<string, unknown>> {
	for (;;) {
		const newline = buffer.indexOf("\n");
		if (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			buffer = buffer.slice(newline + 1);
			if (line) return JSON.parse(line) as Record<string, unknown>;
			continue;
		}
		const { done, value } = await stdout.read();
		if (done) throw new Error("rpc process closed stdout");
		buffer += decoder.decode(value, { stream: true });
	}
}

async function waitFor(type: string, id?: string): Promise<Record<string, unknown>> {
	for (;;) {
		const frame = await nextFrame();
		if (id !== undefined && frame.id !== id) continue;
		if (frame.type === type) return frame;
	}
}

function send(frame: Record<string, unknown>): void {
	proc.stdin.write(`${JSON.stringify(frame)}\n`);
}

const readyTimer = setTimeout(() => dumpStderr("no ready frame within 60s"), 60_000);
await waitFor("ready");
clearTimeout(readyTimer);
send({ id: "start", type: "live_bridge_start", voice: "sol" });
const start = await waitFor("response", "start");
if (start.success !== true) {
	console.error("live_bridge_start failed:", start.error);
	cleanup(1);
}
const endpoint = readEndpoint(start.data);
if (!endpoint) {
	console.error("live_bridge_start returned no endpoint data");
	cleanup(1);
}
const url = endpoint.url;
const token = endpoint.token;
console.log("bridge listening at", url);

const events: unknown[] = [];
let binaryFrames = 0;
await new Promise<void>((resolveSocket, rejectSocket) => {
	const ws = new WebSocket(`${url}?token=${token}`);
	const finish = (error?: Error) => {
		clearTimeout(timer);
		try {
			ws.close(1000, "done");
		} catch {}
		error ? rejectSocket(error) : resolveSocket();
	};
	const timer = setTimeout(() => finish(new Error("timed out waiting for bridge events")), 45_000);
	ws.onmessage = event => {
		if (typeof event.data !== "string") {
			binaryFrames += 1;
			if (events.some(entry => eventType(entry) === "terminal") || (events.length >= 8 && binaryFrames >= 3)) {
				finish();
			}
			return;
		}
		events.push(JSON.parse(event.data));
		if (events.some(entry => eventType(entry) === "terminal") || events.length >= 8) {
			finish();
		}
	};
	ws.onerror = () => finish(new Error("bridge websocket failed"));
});

console.log("bridge events:", JSON.stringify(events, null, 2));

send({ id: "stop", type: "live_bridge_stop" });
const stop = await waitFor("response", "stop");
console.log("live_bridge_stop:", stop.success === true ? "ok" : stop.error);

const sawReady = events.some(entry => eventType(entry) === "ready");
const ready = events.find(entry => eventType(entry) === "ready") as { phase?: string } | undefined;
const sawPhase = typeof ready?.phase === "string" && ready.phase.length > 0;
console.log(`initial phase: ${ready?.phase ?? "none"}`);
console.log(`binary audio frames received: ${binaryFrames}`);
console.log(sawReady && sawPhase && binaryFrames > 0 ? "SMOKE OK" : "SMOKE FAILED");
cleanup(sawReady && sawPhase && binaryFrames > 0 ? 0 : 1);
