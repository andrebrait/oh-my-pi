import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isExternalUrlPath } from "@oh-my-pi/pi-coding-agent/tools/path-utils";

/**
 * Direct unit coverage of the classification `resolveToolSearchScope` inlined
 * before extraction (see search-url-paths.test.ts for the end-to-end tool
 * behavior this helper backs). These exercise the extracted `isExternalUrlPath`
 * export directly against the divergences between it and a naive scheme/glob
 * reconstruction: `file://` stays local, a fuzzy `www.`-style spelling only
 * counts as remote when no same-named local path exists, and an unrecognized
 * scheme falls through to the local pipeline.
 */
describe("isExternalUrlPath", () => {
	let testDir: string;

	beforeEach(async () => {
		testDir = await fs.mkdtemp(path.join(os.tmpdir(), "is-external-url-path-"));
	});

	afterEach(async () => {
		await fs.rm(testDir, { recursive: true, force: true });
	});

	it("treats a file:// URL to a real local file as local", async () => {
		const target = path.join(testDir, "hosts");
		await fs.writeFile(target, "127.0.0.1 localhost\n");
		expect(await isExternalUrlPath(`file://${target}`, testDir)).toBe(false);
	});

	it("treats a fuzzy www. path as local when the same-named local path exists", async () => {
		await fs.mkdir(path.join(testDir, "www.foo"), { recursive: true });
		await fs.writeFile(path.join(testDir, "www.foo", "bar"), "local\n");
		expect(await isExternalUrlPath("www.foo/bar", testDir)).toBe(false);
	});

	it("treats a fuzzy www. path as remote when no same-named local path exists", async () => {
		expect(await isExternalUrlPath("www.foo/bar", testDir)).toBe(true);
	});

	it("treats strict http/https/ftp/ws/wss schemes as remote", async () => {
		expect(await isExternalUrlPath("http://example.com/x", testDir)).toBe(true);
		expect(await isExternalUrlPath("https://example.com/x", testDir)).toBe(true);
		expect(await isExternalUrlPath("ftp://example.com/x", testDir)).toBe(true);
		expect(await isExternalUrlPath("ws://example.com/x", testDir)).toBe(true);
		expect(await isExternalUrlPath("wss://example.com/x", testDir)).toBe(true);
	});

	it("treats an unrecognized scheme as local, matching the real host classifier", async () => {
		expect(await isExternalUrlPath("myscheme://x", testDir)).toBe(false);
	});

	it("treats a plain relative path as local", async () => {
		expect(await isExternalUrlPath("src/foo.ts", testDir)).toBe(false);
	});

	it("normalizes surrounding whitespace and quoting like resolveToolSearchScope does before classifying", async () => {
		// resolveToolSearchScope runs normalizePathLikeInput on every raw path
		// before this classifier ever sees it (see path-utils.ts). A caller
		// that skips that step, such as the extension-facing isRemotePath, must
		// still land on the host's real answer instead of silently returning
		// the un-trimmed/quoted verdict (issue caught in review: PR #8).
		expect(await isExternalUrlPath(" https://example.com/x ", testDir)).toBe(true);
		expect(await isExternalUrlPath('"https://example.com/x"', testDir)).toBe(true);
	});
});
