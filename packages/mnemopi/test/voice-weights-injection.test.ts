/**
 * Ported from can1357/oh-my-pi#9840: voice weights are injectable so an A/B harness runs
 * challenger configs through the production path; the default is the PR's adopted weights.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type BeamMemoryState, initBeam } from "@oh-my-pi/pi-mnemopi/core/beam";
import {
	getPolyphonicEngine,
	PolyphonicRecallEngine,
	type PolyphonicVoice,
	type VoiceRecallResult,
} from "@oh-my-pi/pi-mnemopi/core/polyphonic-recall";

function makeEngine(weights?: Partial<Record<PolyphonicVoice, number>>): PolyphonicRecallEngine {
	const db = new Database(":memory:");
	initBeam(db);
	return new PolyphonicRecallEngine({ db, sessionId: "bank-a", channelId: "bank-a", voiceWeights: weights });
}

function voiceHit(memoryId: string, voice: PolyphonicVoice): VoiceRecallResult[] {
	return [{ memoryId, voice, score: 1, metadata: {} }];
}

const previousWeights = process.env.MEMEVAL_VOICE_WEIGHTS;
afterEach(() => {
	if (previousWeights === undefined) delete process.env.MEMEVAL_VOICE_WEIGHTS;
	else process.env.MEMEVAL_VOICE_WEIGHTS = previousWeights;
});

describe("injectable voice weights", () => {
	test("default engine keeps the PR's holdout-adopted weights, hybrid off", () => {
		expect(makeEngine().voiceWeights).toEqual({ hybrid: 0, vector: 0.2, graph: 0.4, fact: 0.4, temporal: 0 });
	});

	test("injected weights flip fusion order between single-voice candidates", () => {
		const rank = (engine: PolyphonicRecallEngine) =>
			[...engine.combineVoices(voiceHit("row-vec", "vector"), voiceHit("row-graph", "graph")).values()].sort(
				(a, b) => b.combinedScore - a.combinedScore,
			)[0]?.memoryId;
		expect(rank(makeEngine({ vector: 0.9, graph: 0.05 }))).toBe("row-vec");
		expect(rank(makeEngine({ vector: 0.05, graph: 0.9 }))).toBe("row-graph");
	});

	test("invalid injected weights are rejected loudly", () => {
		expect(() => makeEngine({ vector: Number.NaN })).toThrow(/voiceWeights/);
		expect(() => makeEngine({ vector: -0.1 })).toThrow(/voiceWeights/);
	});

	test("MEMEVAL_VOICE_WEIGHTS overrides the beam engine's weights", () => {
		process.env.MEMEVAL_VOICE_WEIGHTS = '{"hybrid":0.35}';
		const db = new Database(":memory:");
		initBeam(db);
		const beam: BeamMemoryState = {
			db,
			sessionId: "bank-a",
			authorId: null,
			authorType: null,
			channelId: "bank-a",
			useCloud: false,
			pluginManager: null,
			annotations: null,
			triples: null,
			episodicGraph: null,
			veracityConsolidator: null,
			caches: { timestampParse: new Map(), extractionBuffer: [] },
			config: {
				workingMemoryLimit: 1000,
				workingMemoryTtlHours: 24,
				recencyHalflifeHours: 72,
				vecWeight: 0.5,
				ftsWeight: 0.3,
				importanceWeight: 0.2,
				useCloud: false,
				localLlmEnabled: false,
				maxEpisodeChars: 100_000,
			},
		};
		expect(getPolyphonicEngine(beam).voiceWeights.hybrid).toBe(0.35);
		expect(getPolyphonicEngine(beam).voiceWeights.graph).toBe(0.4);
	});
});
