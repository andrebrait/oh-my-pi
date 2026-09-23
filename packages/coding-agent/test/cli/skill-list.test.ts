import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { handleSkillList, runSkillsCommand } from "../../src/cli/skill-list";
import { resetSettingsForTest } from "../../src/config/settings";
import { removeWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

describe("runSkillsCommand", () => {
	test("lists skills for a directory with public metadata", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-skills-cmd-"));
		const skillsRoot = path.join(directory, "skills-fixture");
		await fs.mkdir(path.join(skillsRoot, "first", "calendar"), { recursive: true });
		await fs.mkdir(path.join(skillsRoot, "second", "reviewer"), { recursive: true });
		await Bun.write(
			path.join(skillsRoot, "first", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: First calendar.\n---\n\n# Calendar (First)\n",
		);
		await Bun.write(
			path.join(skillsRoot, "second", "reviewer", "SKILL.md"),
			"---\nname: reviewer\ndescription: Review code.\n---\n\n# Reviewer\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: [path.join(skillsRoot, "first"), path.join(skillsRoot, "second")] },
			});

			// Skills installed on the developer's machine also resolve here, so the
			// fixtures are matched by name instead of pinning the whole listing.
			expect(result.skills.map(skill => skill.name)).toEqual(expect.arrayContaining(["calendar", "reviewer"]));
			const reviewer = result.skills.find(skill => skill.name === "reviewer");
			expect(reviewer?.description).toBe("Review code.");
			expect(reviewer?.filePath).toBe(path.join(skillsRoot, "second", "reviewer", "SKILL.md"));
			expect(reviewer?.baseDir).toBe(path.join(skillsRoot, "second", "reviewer"));
			expect(reviewer?.source).toBe("custom:user");
			expect(reviewer?.hide).toBe(false);
			// The public shape is fixed: internal `_source`/`containRoot` stay out.
			expect(Object.keys(reviewer ?? {}).sort()).toEqual([
				"baseDir",
				"description",
				"filePath",
				"hide",
				"name",
				"source",
			]);
		} finally {
			await removeWithRetries(directory);
		}
	});

	test("resolves relative custom directories against the requested directory", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skills-rel-${Snowflake.next()}-`));
		await fs.mkdir(path.join(directory, "rel-root", "calendar"), { recursive: true });
		await Bun.write(
			path.join(directory, "rel-root", "calendar", "SKILL.md"),
			"---\nname: calendar\ndescription: Relative calendar.\n---\n\n# Calendar\n",
		);

		try {
			const result = await runSkillsCommand({
				cwd: directory,
				skillsSettings: { customDirectories: ["rel-root"] },
			});
			const calendar = result.skills.find(
				skill => skill.filePath === path.join(directory, "rel-root", "calendar", "SKILL.md"),
			);
			expect(calendar?.name).toBe("calendar");
		} finally {
			await removeWithRetries(directory);
		}
	});
});

describe("handleSkillList", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	test("keeps stdout to TSV rows and sends warnings to stderr", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), `omp-skills-list-${Snowflake.next()}-`));
		for (const root of ["first", "second"]) {
			await fs.mkdir(path.join(directory, root, "calendar"), { recursive: true });
			await Bun.write(
				path.join(directory, root, "calendar", "SKILL.md"),
				`---\nname: calendar\ndescription: ${root} calendar.\n---\n\n# Calendar\n`,
			);
		}
		await Bun.write(
			path.join(directory, ".omp", "config.yml"),
			"skills:\n  customDirectories:\n    - first\n    - second\n",
		);

		let stdout = "";
		let stderr = "";
		const originalStdoutWrite = process.stdout.write;
		const originalStderrWrite = process.stderr.write;
		process.stdout.write = ((chunk: string | Uint8Array) => {
			stdout += chunk.toString();
			return true;
		}) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			stderr += chunk.toString();
			return true;
		}) as typeof process.stderr.write;
		try {
			expect(await handleSkillList([], directory, false)).toBe(0);
		} finally {
			process.stdout.write = originalStdoutWrite;
			process.stderr.write = originalStderrWrite;
			await removeWithRetries(directory);
		}

		// `omp skill list | cut -f1` must see skill rows only.
		const rows = stdout.split("\n").filter(Boolean);
		expect(rows).toContain("calendar\tfirst calendar.");
		for (const row of rows) expect(row).toMatch(/^[^\t]+\t/);
		expect(stderr).toContain('warning: name collision: "calendar"');
	});
});
