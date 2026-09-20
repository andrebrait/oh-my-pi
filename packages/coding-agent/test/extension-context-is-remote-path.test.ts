import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

function createRunner(cwd: string): ExtensionRunner {
	const runtime = {
		flagValues: new Map(),
		pendingProviderRegistrations: [],
	} as unknown as ExtensionRuntime;
	return new ExtensionRunner([], runtime, cwd, { getCwd: () => cwd } as never, {} as never);
}

describe("ExtensionContext.isRemotePath", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await fs.mkdtemp(path.join(os.tmpdir(), "ext-ctx-is-remote-path-"));
	});

	afterEach(async () => {
		await fs.rm(cwd, { recursive: true, force: true });
	});

	it("classifies a strict external URL as remote from an extension context", async () => {
		const ctx = createRunner(cwd).createContext();
		expect(await ctx.isRemotePath("https://example.com/x")).toBe(true);
	});

	it("classifies a plain relative path as local from an extension context", async () => {
		const ctx = createRunner(cwd).createContext();
		expect(await ctx.isRemotePath("src/foo.ts")).toBe(false);
	});

	it("resolves the fuzzy www. divergence against this session's cwd, not process.cwd()", async () => {
		await fs.mkdir(path.join(cwd, "www.foo"), { recursive: true });
		await fs.writeFile(path.join(cwd, "www.foo", "bar"), "local\n");
		const ctx = createRunner(cwd).createContext();
		expect(await ctx.isRemotePath("www.foo/bar")).toBe(false);
	});

	it("command context inherits isRemotePath()", async () => {
		const ctx = createRunner(cwd).createCommandContext();
		expect(await ctx.isRemotePath("https://example.com/x")).toBe(true);
	});
});
