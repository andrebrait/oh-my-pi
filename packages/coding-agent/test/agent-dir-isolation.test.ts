import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const packageDir = path.resolve(import.meta.dir, "..");
const repoDir = path.resolve(packageDir, "../..");

it.each([repoDir, packageDir])(
	"isolates session writes when bun test runs from %s",
	async cwd => {
		const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "omp-isolation-guard-"));
		const home = path.join(sandbox, "home");
		const homeConfig = path.join(home, ".omp");
		const ambientAgent = path.join(sandbox, "ambient-agent");
		const temp = path.join(sandbox, "tmp");
		const report = path.join(sandbox, "session-file.json");
		try {
			await Promise.all([homeConfig, ambientAgent, temp].map(dir => fs.mkdir(dir, { recursive: true })));
			const probe = path.join(sandbox, "probe.test.ts");
			await Bun.write(
				probe,
				`import { it } from "bun:test";
import { SessionManager } from ${JSON.stringify(path.join(packageDir, "src/session/session-manager.ts"))};
it("persists a moved session", async () => {
	const manager = SessionManager.create(${JSON.stringify(path.join(sandbox, "cwd-a"))});
	try {
		await manager.ensureOnDisk();
		await manager.moveTo(${JSON.stringify(path.join(sandbox, "cwd-b"))});
		await Bun.write(${JSON.stringify(report)}, JSON.stringify(manager.getSessionFile()));
	} finally {
		await manager.close();
	}
});
`,
			);
			const env = { ...process.env };
			for (const key of Object.keys(env)) {
				if (/^(PI_|OMP_|XDG_)/.test(key)) delete env[key];
			}
			Object.assign(env, {
				HOME: home,
				USERPROFILE: home,
				PI_CODING_AGENT_DIR: ambientAgent,
				TMPDIR: temp,
				TMP: temp,
				TEMP: temp,
			});
			const child = Bun.spawn([process.execPath, "test", probe], {
				cwd,
				env,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 15_000,
			});
			const [exitCode, stdout, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			expect(exitCode, stdout + stderr).toBe(0);
			// A missing preload must not be masked by the parent test runner's isolation.
			expect(await fs.readdir(ambientAgent)).toEqual([]);
			expect(await fs.readdir(homeConfig)).toEqual([]);
			const sessionFile: string = await Bun.file(report).json();
			const isolatedRoot = await fs.realpath(temp);
			expect((await fs.realpath(sessionFile)).startsWith(`${isolatedRoot}${path.sep}`)).toBe(true);
			expect((await fs.stat(sessionFile)).isFile()).toBe(true);
		} finally {
			await removeWithRetries(sandbox);
		}
	},
	20_000,
);
