import { beforeAll, describe, expect, it } from "bun:test";
import type { SegmentContext } from "../src/status-line/segments";
import { renderSegment } from "../src/status-line/segments";
import { initTheme } from "../src/theme";

beforeAll(async () => {
	await initTheme();
});

function collabContext(collab: SegmentContext["collab"]): SegmentContext {
	return { width: 80, options: {}, collab } as unknown as SegmentContext;
}

/** Segment content carries SGR color; assert on the text the user reads. */
function plain(content: string): string {
	return content.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("status line collab segment", () => {
	it("stays hidden without a shared session", () => {
		expect(renderSegment("collab", collabContext(null))).toMatchObject({ content: "", visible: false });
	});

	it("names how this terminal takes part and how many are in the session", () => {
		const labels = { host: "⇄ collab:3", guest: "⇄ collab guest:3", hosted: "⇄ hosted:3" } as const;
		for (const role of ["host", "guest", "hosted"] as const) {
			const rendered = renderSegment("collab", collabContext({ role, participantCount: 3 }));
			expect(rendered.visible).toBe(true);
			expect(plain(rendered.content)).toBe(labels[role]);
		}
	});
});
