import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type RpcAgentProcess, RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { connectSessionHost } from "@oh-my-pi/pi-coding-agent/session-host/client";
import { runSessionHost, type SessionHostOptions } from "@oh-my-pi/pi-coding-agent/session-host/host";
import { listSessionHosts, newHostId, type SessionHostEntry } from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { createTestSession, isolateAgentDir } from "./rpc-server-harness";

/** Polls a condition, not a guessed delay: the registry file is the host's only observable readiness and presence signal. */
export async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error("waitFor timed out");
		await Bun.sleep(25);
	}
}

export interface TestSessionHost {
	hostId: string;
	session: AgentSession;
	/** True once the host's `onExit` ran: the last client sent `exit`. */
	exited: boolean;
	/** `exit` through a throwaway client; stops the host only when no other client is attached. */
	stop(): Promise<void>;
}

export interface TestClientOptions {
	/** Declare the `ui` capability in the hello. Default false. */
	ui?: boolean;
	/** Receives the socket transport on every `start()`, to drop it from the outside like a network failure. */
	onTransport?: (transport: RpcAgentProcess) => void;
}

/**
 * Real in-process session hosts (`runSessionHost` over a registry-published socket) in a temp dir,
 * with `RpcClient`s attached over `connectSessionHost`. {@link dispose} stops every client and host it made.
 */
export class SessionHostFixture {
	readonly dir: string;
	readonly registryDir: string;
	readonly #restoreAgentDir: () => void;
	readonly #hosts: TestSessionHost[] = [];
	readonly #clients: RpcClient[] = [];
	#hostCount = 0;

	private constructor(dir: string) {
		this.dir = dir;
		this.registryDir = path.join(dir, "registry");
		this.#restoreAgentDir = isolateAgentDir(path.join(dir, "agent"));
	}

	static async create(): Promise<SessionHostFixture> {
		return new SessionHostFixture(await fs.mkdtemp(path.join(os.tmpdir(), "omp-session-host-")));
	}

	/**
	 * A host serving a fresh session whose mock model answers `ok`; `gate` holds each reply after its first delta until
	 * it resolves; `inMemory` keeps the transcript in memory, with no session file or artifacts directory.
	 */
	async startHost(
		options: Partial<SessionHostOptions> = {},
		gate?: Promise<void>,
		sessionOptions: { inMemory?: boolean } = {},
	): Promise<TestSessionHost> {
		const sessionDir = path.join(this.dir, `host-${++this.#hostCount}`);
		await fs.mkdir(sessionDir, { recursive: true });
		const session = await createTestSession(sessionDir, { handler: { content: ["ok"] } }, gate, sessionOptions);
		const hostId = newHostId();
		const done = Promise.withResolvers<void>();
		const host: TestSessionHost = {
			hostId,
			session,
			exited: false,
			stop: async () => {
				if (host.exited) return;
				const closer = await this.client(host);
				await closer.start();
				await closer.exit();
				await done.promise;
			},
		};
		void runSessionHost(session, {
			...options,
			hostId,
			registryDir: this.registryDir,
			onExit: async () => {
				await session.dispose();
				host.exited = true;
				done.resolve();
				return new Promise<never>(() => {});
			},
		});
		await waitFor(async () => (await this.#findEntry(hostId)) !== undefined);
		this.#hosts.push(host);
		return host;
	}

	/** The host's published registry entry; throws once the host has withdrawn. */
	async entry(host: TestSessionHost): Promise<SessionHostEntry> {
		const entry = await this.#findEntry(host.hostId);
		if (!entry) throw new Error(`Session host ${host.hostId} is not registered`);
		return entry;
	}

	/** A client for `host` that has not started: register listeners first, then `start()` to attach. */
	async client(host: TestSessionHost, options: TestClientOptions = {}): Promise<RpcClient> {
		const entry = await this.entry(host);
		const client = new RpcClient({
			spawn: async () => {
				const transport = await connectSessionHost({ entry, client: { kind: "test" }, ui: options.ui ?? false });
				options.onTransport?.(transport);
				return transport;
			},
		});
		this.#clients.push(client);
		return client;
	}

	/** Wait until the host's registry entry reports `count` attached clients. */
	async waitForClients(host: TestSessionHost, count: number): Promise<void> {
		await waitFor(async () => (await this.#findEntry(host.hostId))?.clients === count);
	}

	async dispose(): Promise<void> {
		await Promise.all(this.#clients.map(client => client.stop()));
		for (const host of this.#hosts) {
			if (host.exited) continue;
			await this.waitForClients(host, 0);
			await host.stop();
		}
		this.#restoreAgentDir();
		await removeWithRetries(this.dir);
	}

	async #findEntry(hostId: string): Promise<SessionHostEntry | undefined> {
		return (await listSessionHosts(this.registryDir)).find(entry => entry.hostId === hostId);
	}
}
