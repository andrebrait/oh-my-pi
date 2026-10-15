import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { pidAlive } from "@oh-my-pi/pi-coding-agent/ipc/private-endpoint";
import { runRootCommand } from "@oh-my-pi/pi-coding-agent/main";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { INTERRUPTED_TURN_ERROR } from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { connectSessionHost } from "@oh-my-pi/pi-coding-agent/session-host/client";
import {
	assertHostedLaunchSupported,
	ensureHostForResolvedSession,
	ensureSessionHost,
	type HostLaunch,
	hostLaunchArgs,
	resolveAttachTarget,
} from "@oh-my-pi/pi-coding-agent/session-host/hosted-startup";
import {
	listSessionHosts,
	SESSION_HOST_REGISTRY_VERSION,
	type SessionHostEntry,
	writeHostEntry,
} from "@oh-my-pi/pi-coding-agent/session-host/registry";
import { IpcServer, ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getProjectDir, removeWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";
import { holdLeaseInAnotherProcess, killLeaseProcesses } from "../helpers/session-lease-process";
import { type IsolatedConfigRoot, isolateConfigRoot, waitFor } from "../helpers/session-host-harness";

/** A host that boots without network: a dummy key makes the model available, and discovery hits a closed port. */
const MODEL_ARGS = [
	"--no-extensions",
	"--no-skills",
	"--no-rules",
	"--provider",
	"anthropic",
	"--model",
	"claude-sonnet-4-5",
];

let dir: string;
let registryDir: string;
let sessionsDir: string;
const servers: IpcServer[] = [];
/** Every host a test started; a failed test must not leave a detached host running. */
const hostPids: number[] = [];

beforeEach(async () => {
	dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-hosted-startup-"));
	registryDir = path.join(dir, "registry");
	sessionsDir = path.join(dir, "sessions");
	await Bun.write(
		path.join(dir, "models.yml"),
		"providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:9\n    apiKey: test-dummy-key\n",
	);
});

afterEach(async () => {
	await Promise.all(servers.splice(0).map(server => server.close()));
	killLeaseProcesses();
	for (const pid of hostPids.splice(0)) if (pidAlive(pid)) process.kill(pid, "SIGKILL");
	await removeWithRetries(dir);
});

function launch(args: readonly string[] = []): HostLaunch {
	return {
		cwd: dir,
		args,
		sessionDir: sessionsDir,
		registryDir,
		env: { PI_CODING_AGENT_DIR: dir, HOME: dir, USERPROFILE: dir },
	};
}

/** A session file other tools can open, without any model: header only. */
async function persistedSession(): Promise<{ file: string; id: string }> {
	const manager = SessionManager.create(dir, sessionsDir);
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("session was not given a file");
	const id = manager.getSessionId();
	await manager.close();
	return { file, id };
}

/** A session its last process left mid-turn: a prompt the model never answered, and no exit record. */
async function interruptedSession(): Promise<string> {
	const manager = SessionManager.create(dir, sessionsDir);
	manager.appendMessage({ role: "user", content: "keep going", timestamp: Date.now() });
	await manager.ensureOnDisk();
	const file = manager.getSessionFile();
	if (!file) throw new Error("session was not given a file");
	await manager.close();
	return file;
}

/** A listening stand-in for a live host serving `sessionFile`; the registry probes it alive. */
async function standInHost(hostId: string, sessionFile: string | undefined): Promise<SessionHostEntry> {
	await fs.promises.mkdir(registryDir, { recursive: true, mode: 0o700 });
	const endpoint = ipcEndpoint(registryDir, hostId);
	servers.push(await IpcServer.listen(endpoint, { framing: "raw" }, () => {}));
	const entry: SessionHostEntry = {
		version: SESSION_HOST_REGISTRY_VERSION,
		hostId,
		pid: process.pid,
		endpoint,
		token: "t".repeat(64),
		cwd: dir,
		sessionFile,
		title: undefined,
		clients: 0,
		busy: false,
		startedAt: Date.now(),
	};
	await writeHostEntry(entry, registryDir);
	return entry;
}

describe("hostLaunchArgs", () => {
	it("keeps the configuration the host needs and drops what only this terminal consumes", () => {
		const args = hostLaunchArgs(
			[
				"--model",
				"claude-sonnet-4-5",
				"--cwd",
				"/elsewhere",
				"--resume",
				"abc123",
				"fix the bug",
				"@notes.md",
				"--no-tools",
				"-c",
				"--tools=read",
				"--omp-profile-boundary",
				"another prompt",
				"--cwd=/again",
				"--hide-thinking",
				"--no-title",
				"--print-thoughts",
				"--allow-home",
				"--no-pty",
			],
			dir,
		);
		expect(args).toEqual(["--model", "claude-sonnet-4-5", "--no-tools", "--tools=read"]);
	});

	it("resolves relative path flags against the launch directory, since the host may run in another", () => {
		const launchCwd = path.join(dir, "launch");
		fs.mkdirSync(launchCwd);
		fs.writeFileSync(path.join(launchCwd, "overlay.yml"), "{}\n");
		fs.writeFileSync(path.join(launchCwd, "prompt.md"), "be brief\n");
		const at = (name: string): string => path.join(launchCwd, name);

		const args = hostLaunchArgs(
			[
				"--config",
				"overlay.yml",
				"--config=sub/../overlay.yml",
				"--add-dir",
				"src",
				"--session-dir=sessions",
				"-e",
				"ext.ts",
				"--extension",
				"~/ext.ts",
				"--hook",
				"/abs/hook.ts",
				"--plugin-dir",
				"plugins",
				"--system-prompt-template",
				"tpl.md",
				"--system-prompt",
				"prompt.md",
				"--append-system-prompt",
				"be brief",
				"--model",
				"overlay.yml",
			],
			launchCwd,
		);

		expect(args).toEqual([
			"--config",
			at("overlay.yml"),
			`--config=${at("overlay.yml")}`,
			"--add-dir",
			at("src"),
			`--session-dir=${at("sessions")}`,
			"-e",
			at("ext.ts"),
			"--extension",
			"~/ext.ts",
			"--hook",
			"/abs/hook.ts",
			"--plugin-dir",
			at("plugins"),
			"--system-prompt-template",
			at("tpl.md"),
			"--system-prompt",
			at("prompt.md"),
			"--append-system-prompt",
			"be brief",
			"--model",
			"overlay.yml",
		]);
		expect(fs.existsSync(args[1])).toBe(true);
	});
});

describe("assertHostedLaunchSupported", () => {
	it("refuses options a host cannot honor instead of dropping them", () => {
		expect(() => assertHostedLaunchSupported(parseArgs(["--fork", "abc"]))).toThrow(/--fork/);
		expect(() => assertHostedLaunchSupported(parseArgs(["--from-claude"]))).toThrow(/--from-claude/);
		expect(() => assertHostedLaunchSupported(parseArgs(["--from-codex"]))).toThrow(/--from-codex/);
		expect(() => assertHostedLaunchSupported(parseArgs(["--goal", "ship it"]))).toThrow(/--goal/);
		expect(() => assertHostedLaunchSupported(parseArgs(["--registered-by-an-extension"]))).toThrow(
			/--registered-by-an-extension/,
		);
	});

	it("accepts the ordinary launch flags a host receives", () => {
		expect(() =>
			assertHostedLaunchSupported(parseArgs(["--model", "claude-sonnet-4-5", "--no-tools", "-c", "hello"])),
		).not.toThrow();
	});
});

describe("resolving what to attach to", () => {
	it("resolves a host id to that host", async () => {
		const host = await standInHost("aaaaaaaaaaaaaaaa", undefined);
		expect((await resolveAttachTarget(host.hostId, launch())).hostId).toBe(host.hostId);
	});

	it("resolves a session id and a session path to the host already running that session", async () => {
		const { file, id } = await persistedSession();
		const host = await standInHost("bbbbbbbbbbbbbbbb", file);
		expect((await resolveAttachTarget(id, launch())).hostId).toBe(host.hostId);
		expect((await resolveAttachTarget(file, launch())).hostId).toBe(host.hostId);
		expect((await listSessionHosts(registryDir)).map(entry => entry.hostId)).toEqual([host.hostId]);
	});

	it("rejects a target that names nothing", async () => {
		await expect(resolveAttachTarget("nothing-by-this-name", launch())).rejects.toThrow(
			/No session host or session matches/,
		);
		const notASession = path.join(dir, "notes.jsonl");
		await Bun.write(notASession, "not a session\n");
		await expect(resolveAttachTarget(notASession, launch())).rejects.toThrow(/Not a session file/);
		await expect(resolveAttachTarget("  ", launch())).rejects.toThrow(/needs a target/);
	});

	it("resumes into the host already running the session, and refuses launch flags that cannot apply to it", async () => {
		const { file } = await persistedSession();
		const host = await standInHost("cccccccccccccccc", file);

		const reused = await ensureHostForResolvedSession(await SessionManager.open(file, sessionsDir), launch());
		expect(reused.hostId).toBe(host.hostId);

		await expect(
			ensureHostForResolvedSession(await SessionManager.open(file, sessionsDir), launch(["--no-tools"])),
		).rejects.toThrow(/already runs this session/);
		expect((await listSessionHosts(registryDir)).map(entry => entry.hostId)).toEqual([host.hostId]);
	});

	it("attaches under --restore to the host already running the session: a live host's turn was never interrupted", async () => {
		const { file } = await persistedSession();
		const host = await standInHost("dddddddddddddddd", file);

		const reused = await ensureHostForResolvedSession(await SessionManager.open(file, sessionsDir), launch(), {
			restore: true,
		});

		expect(reused.hostId).toBe(host.hostId);
		expect((await listSessionHosts(registryDir)).map(entry => entry.hostId)).toEqual([host.hostId]);
	});

	it("resumes into the host already running the session with flags that only shape this terminal", async () => {
		const { file } = await persistedSession();
		const host = await standInHost("eeeeeeeeeeeeeeee", file);

		const reused = await ensureHostForResolvedSession(
			await SessionManager.open(file, sessionsDir),
			launch(hostLaunchArgs(["--resume", file, "--hide-thinking", "--no-title"], dir)),
		);
		expect(reused.hostId).toBe(host.hostId);

		await expect(
			ensureHostForResolvedSession(
				await SessionManager.open(file, sessionsDir),
				launch(hostLaunchArgs(["--resume", file, "--hide-thinking", "--no-tools"], dir)),
			),
		).rejects.toThrow(/already runs this session/);
	});

	it("does not take a session another process leases for a registered host", async () => {
		const { file, id } = await persistedSession();
		await holdLeaseInAnotherProcess(file, id);
		await expect(ensureSessionHost(file, launch())).rejects.toThrow(/open in a non-host process/);
		expect(await listSessionHosts(registryDir)).toEqual([]);
	});
});

describe("starting hosts", () => {
	it("starts one host for two terminals resuming the same session at once", async () => {
		const { file } = await persistedSession();
		const [first, second] = await Promise.all([
			ensureSessionHost(file, launch(MODEL_ARGS)),
			ensureSessionHost(file, launch(MODEL_ARGS)),
		]);
		hostPids.push(first.pid, second.pid);

		expect(second.hostId).toBe(first.hostId);
		expect((await listSessionHosts(registryDir)).map(entry => entry.hostId)).toEqual([first.hostId]);
		expect(first.sessionFile && path.resolve(first.sessionFile)).toBe(path.resolve(file));
	}, 150_000);

	it("starts a host without --resume for a new session and never reuses another terminal's", async () => {
		const [first, second] = await Promise.all([
			ensureSessionHost(undefined, launch(MODEL_ARGS)),
			ensureSessionHost(undefined, launch(MODEL_ARGS)),
		]);
		hostPids.push(first.pid, second.pid);

		expect(second.hostId).not.toBe(first.hostId);
		expect((await listSessionHosts(registryDir)).map(entry => entry.hostId).sort()).toEqual(
			[first.hostId, second.hostId].sort(),
		);
	}, 150_000);

	it("has the host it starts under --restore go on with the interrupted turn, with no client attached", async () => {
		const file = await interruptedSession();

		const host = await ensureHostForResolvedSession(
			await SessionManager.open(file, sessionsDir),
			launch(MODEL_ARGS),
			{
				restore: true,
			},
		);
		hostPids.push(host.pid);

		// Restoring closes the cut-off turn with the interrupted-turn record before retrying it; a plain resume never does.
		await waitFor(async () => (await Bun.file(file).text()).includes(INTERRUPTED_TURN_ERROR), 30_000);
	}, 150_000);

	it("never restores a session a host opens on a plain resume", async () => {
		const plainFile = await interruptedSession();
		const plain = await ensureHostForResolvedSession(
			await SessionManager.open(plainFile, sessionsDir),
			launch(MODEL_ARGS),
		);
		hostPids.push(plain.pid);
		const client = new RpcClient({
			spawn: () => connectSessionHost({ entry: plain, client: { kind: "test" }, ui: false }),
		});
		await client.start();
		// Answered once extension startup finished: the point a restore would start from.
		await client.getState();

		// A restoring host started only now records the interrupted turn: by then, a restore the plain host had started would have too.
		const restoredFile = await interruptedSession();
		const restored = await ensureHostForResolvedSession(
			await SessionManager.open(restoredFile, sessionsDir),
			launch(MODEL_ARGS),
			{ restore: true },
		);
		hostPids.push(restored.pid);
		await waitFor(async () => (await Bun.file(restoredFile).text()).includes(INTERRUPTED_TURN_ERROR), 30_000);

		expect(await Bun.file(plainFile).text()).not.toContain(INTERRUPTED_TURN_ERROR);
		await client.detach();
	}, 150_000);
});

describe("the opt-in gate", () => {
	let config: IsolatedConfigRoot;

	// The default registry lives under the base config root: a launch that wrongly started a host must not read,
	// prune, or fill the developer's real one.
	beforeEach(() => {
		config = isolateConfigRoot();
	});

	afterEach(async () => {
		await config.restore();
	});

	it("keeps an interactive launch in process while tui.hosted is off", async () => {
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		const settings = Settings.isolated({ "tui.hosted": false, "startup.checkUpdate": false });
		const stop = new Error("ordinary createSession reached");
		const rawArgs = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-tools", "--no-lsp"];
		const originalIsTTY = process.stdin.isTTY;
		const originalStdoutIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			await expect(
				runRootCommand(parseArgs(rawArgs), rawArgs, {
					settings,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async () => {
						throw stop;
					},
				}),
			).rejects.toBe(stop);
			// A host this launch wrongly started is detached: record it first so the cleanup stops it.
			const hosts = await listSessionHosts();
			hostPids.push(...hosts.map(host => host.pid));
			expect(hosts).toEqual([]);
		} finally {
			vi.restoreAllMocks();
			Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
			if (originalStdoutIsTTY) Object.defineProperty(process.stdout, "isTTY", originalStdoutIsTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			authStorage.close();
		}
	});

	it("refuses a hosted --restore that carries a prompt, before starting a host", async () => {
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		const settings = Settings.isolated({ "tui.hosted": true, "startup.checkUpdate": false });
		const file = await interruptedSession();
		const rawArgs = [...MODEL_ARGS, "--session-dir", sessionsDir, "--restore", file, "keep going"];
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		// A host this launch wrongly started reads its configuration from `dir`, never the developer's.
		process.env.PI_CODING_AGENT_DIR = dir;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		try {
			await expect(
				runRootCommand(parseArgs(rawArgs), rawArgs, {
					settings,
					discoverAuthStorage: async () => authStorage,
					createAgentSession: async () => {
						throw new Error("hosted terminal session reached");
					},
				}),
			).rejects.toThrow("--restore takes no prompt");
			const hosts = await listSessionHosts();
			hostPids.push(...hosts.map(host => host.pid));
			expect(hosts).toEqual([]);
		} finally {
			const hosts = await listSessionHosts();
			hostPids.push(...hosts.map(host => host.pid));
			if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			authStorage.close();
		}
	}, 30_000);
	it("rejects a missing attachment without leaving a detached host", async () => {
		const authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
		const settings = Settings.isolated({ "tui.hosted": true, "startup.checkUpdate": false });
		const missing = path.join(dir, "missing-attachment.txt");
		const rawArgs = [...MODEL_ARGS, "--no-session", "--cwd", dir, `@${missing}`];
		const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		// `--cwd` moves the whole process into `dir`, which `afterEach` deletes.
		const originalProjectDir = getProjectDir();
		const stdinTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
		const exit = new Error("CLI exited");
		const stderr: string[] = [];
		let exitCode: string | number | null | undefined;
		process.env.PI_CODING_AGENT_DIR = dir;
		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
		vi.spyOn(process, "exit").mockImplementation(code => {
			exitCode = code;
			throw exit;
		});
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderr.push(String(chunk));
			return true;
		});
		vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			stderr.push(args.map(String).join(" "));
		});
		try {
			await expect(
				runRootCommand(parseArgs(rawArgs), rawArgs, {
					settings,
					discoverAuthStorage: async () => authStorage,
				}),
			).rejects.toBe(exit);
			expect(exitCode).toBe(1);
			expect(stderr.join("")).toContain("missing-attachment.txt");
			const hosts = await listSessionHosts();
			hostPids.push(...hosts.map(host => host.pid));
			expect(hosts).toEqual([]);
		} finally {
			const hosts = await listSessionHosts();
			hostPids.push(...hosts.map(host => host.pid));
			vi.restoreAllMocks();
			if (stdinTTY) Object.defineProperty(process.stdin, "isTTY", stdinTTY);
			else Reflect.deleteProperty(process.stdin, "isTTY");
			if (stdoutTTY) Object.defineProperty(process.stdout, "isTTY", stdoutTTY);
			else Reflect.deleteProperty(process.stdout, "isTTY");
			if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
			setProjectDir(originalProjectDir);
			authStorage.close();
		}
	}, 30_000);
});
