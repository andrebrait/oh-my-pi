import type { Database } from "bun:sqlite";
import { logger, withLoopPhase } from "@oh-my-pi/pi-utils";
import { type Env, polyphonicRecallEnabled } from "../config";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import { backfillConsolidatedFacts, ensureVeracityConsolidator } from "./beam/consolidate";
import { STOP_WORDS } from "./beam/recall";
import type { BeamMemoryState, JsonValue, Metadata, RecallResult, RecallTierLabel } from "./beam/types";
import { EpisodicGraph, isPlausibleFactSubject } from "./episodic-graph";
import { COMMON_SENTENCE_WORDS, GRAPH_COMMON_WORD_LEXICON, SUBJECT_PLACEHOLDERS } from "./graph-lexicon";
import { mmrRerank } from "./mmr";
import { VeracityConsolidator } from "./veracity-consolidation";

export type PolyphonicVoice = "hybrid" | "vector" | "graph" | "fact" | "temporal";

export interface VoiceRecallResult {
	readonly memoryId: string;
	readonly score: number;
	readonly voice: PolyphonicVoice;
	readonly metadata: Metadata;
}

export interface PolyphonicResult {
	readonly memoryId: string;
	combinedScore: number;
	readonly voiceScores: Partial<Record<PolyphonicVoice, number>>;
	readonly metadata: Metadata;
}

/** A hydrated recall row with its fused score and per-voice RRF contributions. */
export interface PolyphonicMemoryResult extends RecallResult {
	score: number;
	combined_score: number;
	voice_scores: Partial<Record<PolyphonicVoice, number>>;
	metadata: Metadata;
	tier: RecallTierLabel;
}

/** Per-call options that shape which memories the voices may surface. */
export interface PolyphonicCallOptions {
	/**
	 * Extra visibility channel, mirroring linear recall: rows are visible when they
	 * belong to the engine session, are `global`, or carry this `channel_id`.
	 */
	readonly channelId?: string | null;
	/** Anchor for the temporal voice ("recent" is measured back from this instant). */
	readonly queryTime?: string | Date | null;
	/** Keep non-memory rows (extracted facts) contributed by the `hybrid` voice. */
	readonly includeFacts?: boolean;
	/**
	 * Ranked results of the standard (linear) recall for the same query. They form
	 * the `hybrid` voice and are reused verbatim when a fused hit is one of them.
	 */
	readonly baseline?: readonly RecallResult[];
}

export interface PolyphonicRecallOptions extends PolyphonicCallOptions {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	/**
	 * Approximate token budget for the returned rows (default 4000); rows past it are
	 * dropped even below `topK`. `Infinity` disables the budget.
	 */
	readonly contextBudget?: number;
}

interface PolyphonicEngineOptions {
	readonly dbPath?: DatabasePath;
	readonly db?: Database;
	readonly graph?: EpisodicGraph;
	readonly consolidator?: VeracityConsolidator;
	readonly sessionId?: string | null;
	readonly channelId?: string | null;
	/**
	 * Per-voice RRF weight override (PR #9840 injection seam); voices left out keep
	 * {@link DEFAULT_VOICE_WEIGHTS}.
	 */
	readonly voiceWeights?: Partial<Record<PolyphonicVoice, number>>;
}

/** SQL visibility predicate shared by every voice and by hydration. */
interface Visibility {
	readonly clause: string;
	readonly params: readonly string[];
}

interface MemoryHydrationRow {
	readonly id: string;
	readonly content: string;
	readonly source: string | null;
	readonly timestamp: string | null;
	readonly session_id: string;
	readonly importance: number;
	readonly metadata_json: string | null;
	readonly veracity: string;
	readonly memory_type: string | null;
	readonly recall_count: number | null;
	readonly last_recalled: string | null;
	readonly valid_until: string | null;
	readonly superseded_by: string | null;
	readonly scope: string | null;
	readonly author_id: string | null;
	readonly author_type: string | null;
	readonly channel_id: string | null;
	readonly trust_tier: string | null;
	readonly created_at: string;
	readonly rowid?: number;
	readonly summary_of?: string;
	readonly tier?: number;
	readonly tier_name: "working" | "episodic";
}

interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly embedding_tier: "working" | "episodic";
}

interface TemporalRow {
	readonly id: string;
	readonly timestamp: string | null;
	readonly importance: number;
}

/** Reciprocal rank fusion constant: a voice's rank-`r` hit contributes `1 / (RRF_K + r)`. */
export const POLYPHONIC_RRF_K = 60;
export const POLYPHONIC_VOICES: readonly PolyphonicVoice[] = ["hybrid", "vector", "graph", "fact", "temporal"];
/**
 * PR #9840 holdout-validated weights `.2/.4/.4/0` for vector/graph/fact/temporal. The PR
 * engine has no `hybrid` voice, so it gets 0 here (its candidates still enter the pool
 * with no score, as the PR's zero-weight temporal voice does).
 */
export const DEFAULT_VOICE_WEIGHTS: Readonly<Record<PolyphonicVoice, number>> = Object.freeze({
	hybrid: 0,
	vector: 0.2,
	graph: 0.4,
	fact: 0.4,
	temporal: 0,
});
/** MMR relevance/novelty tradeoff, matching the linear path's default. */
const MMR_LAMBDA = 0.7;
/** Visible candidates considered per requested row before MMR selection. */
const DIVERSITY_OVERFETCH = 8;
const DIVERSITY_MIN_WINDOW = 64;
const TEMPORAL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * Cosine a memory needs to count as a vector-voice hit: the bar linear recall applies
 * to candidates with no keyword match. Without it the voice's nearest neighbours pad
 * every result list with unrelated memories.
 */
const VECTOR_VOICE_MIN_COSINE = 0.65;
/**
 * Graph voice bounds. Proactive linking makes banks dense (every memory sharing an
 * entity links to every other), so an unbounded walk grows with the cube of the bank.
 * The voice reports at most `MAX_DIRECT` entity matches, expands the `MAX_SEEDS`
 * strongest of them and at most `MAX_FRONTIER` nodes per later hop, reads at most
 * `MAX_EDGE_ROWS` edges per hop, and reports at most `MAX_RESULTS` memories in total.
 */
export const GRAPH_VOICE_MAX_DEPTH = 2;
export const GRAPH_VOICE_MAX_DIRECT = 32;
export const GRAPH_VOICE_MAX_SEEDS = 16;
export const GRAPH_VOICE_MAX_FRONTIER = 32;
export const GRAPH_VOICE_MAX_EDGE_ROWS = 512;
export const GRAPH_VOICE_MAX_RESULTS = 64;
const GRAPH_VOICE_MIN_EDGE_WEIGHT = 0.3;

/**
 * Polyphonic recall gate: `MNEMOPI_POLYPHONIC_RECALL` wins when set, then the
 * per-instance `configured` flag, then the process-wide default.
 */
export function polyphonicRecallIsEnabled(env: Env = process.env, configured?: boolean): boolean {
	return polyphonicRecallEnabled(env, configured);
}
function envDisabled(name: string, env: Env = process.env): boolean {
	const value = env[name];
	if (value === undefined) return false;
	return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function metadataValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(metadataValue);
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		const record = value as Record<string, unknown>;
		for (const key in record) {
			out[key] = metadataValue(record[key]);
		}
		return out;
	}
	return String(value);
}

function parseMetadata(raw: string | null): Metadata {
	if (raw === null || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return metadataValue(parsed) as Metadata;
		}
	} catch {
		// Malformed metadata must not make recall fail.
	}
	return {};
}

function normalizeVector(vector: readonly number[] | Float32Array): Float32Array | null {
	if (vector.length === 0) return null;
	let normSq = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i];
		if (value === undefined || !Number.isFinite(value)) return null;
		normSq += value * value;
	}
	if (normSq === 0) return null;
	const norm = Math.sqrt(normSq);
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
	return out;
}

function cosineAgainstUnit(unit: Float32Array, raw: unknown): number | null {
	if (!Array.isArray(raw) || raw.length !== unit.length) return null;
	let normSq = 0;
	let dot = 0;
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		normSq += value * value;
		const unitValue = unit[i];
		if (unitValue === undefined) return null;
		dot += unitValue * value;
	}
	if (normSq === 0) return null;
	return dot / Math.sqrt(normSq);
}

function queryTokens(query: string): string[] {
	const tokens: string[] = [];
	for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)) tokens.push(match[0]);
	return tokens;
}

/** Subject candidates for the fact voice: every 3+ char query word plus adjacent word pairs. */
function factSubjectCandidates(query: string): string[] {
	const tokens = queryTokens(query);
	const seen = new Set<string>();
	for (let i = 0; i < tokens.length; i++) {
		const word = tokens[i] as string;
		if (word.length >= 3) seen.add(word);
		const next = tokens[i + 1];
		if (next !== undefined) seen.add(`${word} ${next}`);
	}
	return [...seen];
}

/**
 * `MEMEVAL_VOICE_WEIGHTS` (JSON, e.g. `{"hybrid":0.35}`) overrides voice weights for
 * benchmark arms. shortcut: ablation-only seam, delete with this branch.
 */
function memevalVoiceWeights(env: Env = process.env): Partial<Record<PolyphonicVoice, number>> | undefined {
	const raw = env.MEMEVAL_VOICE_WEIGHTS;
	if (raw === undefined || raw.trim() === "") return undefined;
	return JSON.parse(raw) as Partial<Record<PolyphonicVoice, number>>;
}

/** Milliseconds for the temporal voice anchor; `null` means "now, open-ended". */
function anchorTime(queryTime: string | Date | null | undefined): number | null {
	if (queryTime === null || queryTime === undefined) return null;
	const parsed = queryTime instanceof Date ? queryTime.getTime() : Date.parse(queryTime);
	return Number.isFinite(parsed) ? parsed : null;
}

function looksTemporal(query: string): boolean {
	const lower = query.toLowerCase();
	return ["yesterday", "today", "recent", "last", "latest", "this week", "this month", "ago", "before"].some(keyword =>
		lower.includes(keyword),
	);
}

export class PolyphonicRecallEngine {
	readonly dbPath: DatabasePath;
	readonly db: Database;
	readonly ownsConnection: boolean;
	readonly graph: EpisodicGraph;
	readonly consolidator: VeracityConsolidator;
	readonly sessionId: string;
	readonly channelId: string | null;
	readonly voiceWeights: Readonly<Record<PolyphonicVoice, number>>;
	/** Memoised subject dictionary. See {@link subjectDictionary} and {@link invalidateDictionary}. */
	#dictionary: readonly string[] | null = null;
	#dictionaryStamp = "";
	/** Memoised `PRAGMA table_info(facts)` probe for the optional `scope` column. */
	#factsScopeColumn: boolean | null = null;

	constructor(options: PolyphonicEngineOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.db = options.db ?? openDatabase(this.dbPath);
		this.ownsConnection = options.db === undefined;
		this.graph = options.graph ?? new EpisodicGraph({ db: this.db, dbPath: this.dbPath });
		this.consolidator = options.consolidator ?? new VeracityConsolidator(this.dbPath, this.db);
		this.sessionId = options.sessionId ?? "default";
		this.channelId = options.channelId ?? null;
		const weights = { ...DEFAULT_VOICE_WEIGHTS, ...options.voiceWeights };
		for (const voice of POLYPHONIC_VOICES) {
			const weight = weights[voice];
			if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
				throw new Error(`voiceWeights.${voice} must be a finite non-negative number, got ${String(weight)}`);
			}
		}
		this.voiceWeights = Object.freeze(weights);
	}

	/** Highest possible fused score: rank 1 in every voice, under this engine's weights. */
	get maxCombinedScore(): number {
		let total = 0;
		for (const voice of POLYPHONIC_VOICES) total += this.voiceWeights[voice];
		return total / (POLYPHONIC_RRF_K + 1);
	}

	/**
	 * Drop the memoised subject dictionary. Called from `invalidateCaches()` in
	 * `beam/store.ts` on every write, because the `MAX(rowid)` stamp only sees appends.
	 */
	invalidateDictionary(): void {
		this.#dictionary = null;
		this.#dictionaryStamp = "";
	}

	recall(
		query: string,
		queryEmbedding: readonly number[] | Float32Array | null = null,
		topK = 10,
		contextBudget = 4000,
		options: PolyphonicCallOptions = {},
	): PolyphonicMemoryResult[] {
		const baseline = options.baseline ?? [];
		const combined = this.combineVoices(
			this.hybridVoice(baseline, options),
			this.vectorVoice(queryEmbedding, options),
			this.graphVoice(query),
			this.factVoice(query),
			this.temporalVoice(query, options),
		);
		const baselineById = new Map<string, RecallResult>();
		for (const result of baseline) if (!baselineById.has(result.id)) baselineById.set(result.id, result);
		const reranked = this.diversityRerank(combined, topK, candidate =>
			this.#hydrate(candidate, baselineById, options),
		);
		return this.assembleContext(reranked, contextBudget);
	}

	/** The standard recall ranking for the same query, fused as one more voice. */
	hybridVoice(baseline: readonly RecallResult[], options: PolyphonicCallOptions = {}): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_HYBRID")) return [];
		const results: VoiceRecallResult[] = [];
		const seen = new Set<string>();
		for (const result of baseline) {
			if (options.includeFacts !== true && result.tier_label === "fact") continue;
			if (result.id.length === 0 || seen.has(result.id)) continue;
			seen.add(result.id);
			// RRF only reads ranks; a rank-derived score keeps the baseline's own order.
			results.push({
				memoryId: result.id,
				score: 1 / (results.length + 1),
				voice: "hybrid",
				metadata: { hybrid_rank: results.length + 1, hybrid_score: result.score ?? 0 },
			});
		}
		return results;
	}

	vectorVoice(
		queryEmbedding: readonly number[] | Float32Array | null,
		options: PolyphonicCallOptions = {},
	): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_VECTOR") || queryEmbedding === null) return [];
		const queryUnit = normalizeVector(queryEmbedding);
		if (queryUnit === null) return [];
		const now = new Date().toISOString();
		const working = this.#visibility("wm", options.channelId);
		const episodic = this.#visibility("em", options.channelId);
		let rows: EmbeddingRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT me.memory_id, me.embedding_json, 'working' AS embedding_tier
					FROM memory_embeddings me
					JOIN working_memory wm ON wm.id = me.memory_id
					WHERE wm.superseded_by IS NULL
						AND (wm.valid_until IS NULL OR wm.valid_until > ?)
						AND ${working.clause}
					UNION ALL
					SELECT me.memory_id, me.embedding_json, 'episodic' AS embedding_tier
					FROM memory_embeddings me
					JOIN episodic_memory em ON em.id = me.memory_id
					WHERE em.superseded_by IS NULL
						AND (em.valid_until IS NULL OR em.valid_until > ?)
						AND ${episodic.clause}
					LIMIT 50000
				`)
				.all(now, ...working.params, now, ...episodic.params) as EmbeddingRow[];
		} catch {
			return [];
		}

		const byId = new Map<string, VoiceRecallResult>();
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.embedding_json) as unknown;
			} catch {
				continue;
			}
			const cosine = cosineAgainstUnit(queryUnit, parsed);
			if (cosine === null || cosine < VECTOR_VOICE_MIN_COSINE) continue;
			const similarity = (cosine + 1) / 2;
			const existing = byId.get(row.memory_id);
			if (existing === undefined || similarity > existing.score) {
				byId.set(row.memory_id, {
					memoryId: row.memory_id,
					score: similarity,
					voice: "vector",
					metadata: {
						similarity,
						cosine_similarity: cosine,
						embedding_tier: row.embedding_tier,
						backend: "memory_embeddings",
					},
				});
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId)).slice(0, 20);
	}
	/**
	 * Subjects and gist participants this bank actually stores, filtered to plausible
	 * entities and ordered longest-first for greedy non-overlapping matching. Replaces
	 * query-side proper-case regex extraction (PR #9840). Memoised and rebuilt when either
	 * source table grows.
	 */
	subjectDictionary(): readonly string[] {
		let stamp = "";
		try {
			const row: unknown = this.db
				.query("SELECT (SELECT MAX(rowid) FROM facts) AS f, (SELECT MAX(rowid) FROM gists) AS g")
				.get();
			if (row !== null && typeof row === "object" && "f" in row && "g" in row) {
				stamp = `${String(row.f)}:${String(row.g)}`;
			}
		} catch {
			stamp = "";
		}
		const cached = this.#dictionary;
		if (cached !== null && stamp === this.#dictionaryStamp) return cached;

		const seen = new Map<string, string>();
		const consider = (raw: unknown): void => {
			if (typeof raw !== "string") return;
			const value = raw.trim();
			if (value.length < 3) return;
			const key = value.toLowerCase();
			// Writer placeholders (`fact`, `entity`, ...) are field labels, not entities.
			if (SUBJECT_PLACEHOLDERS[key] === true) return;
			// Snake_case identifiers are metric keys; they never appear in a natural query.
			if (value.includes("_")) return;
			if (!isPlausibleFactSubject(value)) return;
			if (!seen.has(key)) seen.set(key, value);
		};
		try {
			for (const row of this.db.query("SELECT DISTINCT subject FROM facts").iterate()) {
				if (row !== null && typeof row === "object" && "subject" in row) consider(row.subject);
			}
			// Gist participants come from a capitalisation regex, so single-word ones that are
			// not corroborated by a `facts.subject` are filtered by the common-word lists.
			const corroborated = new Set(seen.keys());
			const participants = new Map<string, string>();
			for (const row of this.db.query("SELECT participants_json FROM gists").iterate()) {
				if (row === null || typeof row !== "object" || !("participants_json" in row)) continue;
				const raw = row.participants_json;
				if (typeof raw !== "string") continue;
				try {
					const parsed: unknown = JSON.parse(raw);
					if (!Array.isArray(parsed)) continue;
					for (const entry of parsed) {
						if (typeof entry !== "string") continue;
						const trimmed = entry.trim();
						if (trimmed.length > 0) participants.set(trimmed.toLowerCase(), trimmed);
					}
				} catch {
					// A malformed participants blob is skipped, not fatal.
				}
			}
			const lexiconActive = !envDisabled("MNEMOPI_GRAPH_LEXICON");
			for (const [key, display] of participants) {
				if (!display.includes(" ") && !corroborated.has(key)) {
					if (COMMON_SENTENCE_WORDS[key] === true) continue;
					if (lexiconActive && GRAPH_COMMON_WORD_LEXICON[key] === true) continue;
				}
				consider(display);
			}
		} catch {
			// Missing tables (a fresh bank) simply yield an empty dictionary.
		}
		const dictionary = [...seen.values()].sort((a, b) => b.length - a.length || a.localeCompare(b));
		this.#dictionary = dictionary;
		this.#dictionaryStamp = stamp;
		return dictionary;
	}

	/** Greedy longest-first, whole-word, case-insensitive dictionary matches in `query`. */
	matchStoredSubjects(query: string): string[] {
		const dictionary = this.subjectDictionary();
		if (dictionary.length === 0 || query.length === 0) return [];
		const lowered = query.toLowerCase();
		// Tracks which characters are already consumed so `Bash tool` wins over a nested match.
		// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
		const taken = new Array<boolean>(lowered.length).fill(false);
		const wordChar = /[\p{L}\p{N}_]/u;
		const matches: string[] = [];
		for (const subject of dictionary) {
			const needle = subject.toLowerCase();
			let from = 0;
			for (;;) {
				const at = lowered.indexOf(needle, from);
				if (at < 0) break;
				from = at + 1;
				const afterIndex = at + needle.length;
				const before = at === 0 ? "" : (lowered[at - 1] ?? "");
				const after = lowered[afterIndex] ?? "";
				if ((before !== "" && wordChar.test(before)) || (after !== "" && wordChar.test(after))) continue;
				let overlaps = false;
				for (let i = at; i < afterIndex; i++) {
					if (taken[i] === true) {
						overlaps = true;
						break;
					}
				}
				if (overlaps) continue;
				for (let i = at; i < afterIndex; i++) taken[i] = true;
				matches.push(subject);
				break;
			}
		}
		return matches;
	}

	/**
	 * Lexical fact matches on `facts.object` text, mapped back through `facts.source_msg_id`
	 * and reported as the `fact` voice. Flat extracted statements carry a placeholder subject,
	 * so subject lookup can never reach them. (PR #9840 also searched `fts_memoria_facts`,
	 * which this schema does not have.)
	 */
	factObjectMatches(query: string): VoiceRecallResult[] {
		// Quoted word tokens only, so query punctuation never becomes an FTS5 operator.
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])]
			.filter(term => !STOP_WORDS.has(term))
			.slice(0, 8);
		if (terms.length === 0) return [];
		const expression = terms.map(term => `"${term}"`).join(" OR ");
		const scope = this.#factsHaveScope()
			? "(facts.session_id = ? OR facts.scope = 'global')"
			: "facts.session_id = ?";
		let rows: Array<{ memory_id: string | null; confidence: number | null; object: string | null }>;
		try {
			// Column-scoped so `subject`/`predicate` placeholders cannot match.
			rows = this.db
				.query(`
					SELECT facts.source_msg_id AS memory_id, facts.confidence AS confidence, facts.object AS object
					FROM fts_facts
					JOIN facts ON facts.rowid = fts_facts.rowid
					WHERE fts_facts MATCH ? AND facts.source_msg_id IS NOT NULL AND ${scope}
					ORDER BY fts_facts.rank, fts_facts.rowid
					LIMIT 25
				`)
				.all(`object : (${expression})`, this.sessionId) as typeof rows;
		} catch {
			return [];
		}
		const seeds: VoiceRecallResult[] = [];
		rows.forEach((row, position) => {
			const memoryId = (row.memory_id ?? "").trim();
			if (memoryId.length === 0) return;
			// Rank-aware: BM25 order decays the stored confidence.
			seeds.push({
				memoryId,
				score: ((row.confidence ?? 0.5) * 0.45) / (1 + position),
				voice: "fact",
				metadata: { match_kind: "fact_object", fact_rank: position, fact_text: (row.object ?? "").slice(0, 120) },
			});
		});
		return seeds;
	}

	/** Older banks have no `facts.scope` column. */
	#factsHaveScope(): boolean {
		if (this.#factsScopeColumn === null) {
			let present = false;
			try {
				for (const row of this.db.query("PRAGMA table_info(facts)").iterate()) {
					if (row !== null && typeof row === "object" && "name" in row && String(row.name) === "scope") {
						present = true;
						break;
					}
				}
			} catch {
				present = false;
			}
			this.#factsScopeColumn = present;
		}
		return this.#factsScopeColumn;
	}
	/**
	 * Memories whose gist or KG facts name a query entity (seeds), plus memories reached
	 * from the strongest seeds over `ctx` edges. The walk is one multi-source BFS: each
	 * node expands at most once, every hop is one batched edge query, and seeds, frontier,
	 * edge rows and results are all capped, so dense proactively linked banks cost the
	 * same bounded work as sparse ones.
	 */
	graphVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_GRAPH")) return [];
		const seeds = new Map<string, VoiceRecallResult>();
		const addSeed = (hit: VoiceRecallResult): void => {
			const existing = seeds.get(hit.memoryId);
			if (existing === undefined || hit.score > existing.score) seeds.set(hit.memoryId, hit);
		};
		for (const entity of this.matchStoredSubjects(query)) {
			for (const gist of this.graph.findGistsByParticipant(entity)) {
				const memoryId = gist.id.startsWith("gist_") ? gist.id.slice(5) : gist.id;
				addSeed({ memoryId, score: 0.6, voice: "graph", metadata: { entity, gist: gist.text } });
			}
			for (const fact of this.graph.findFactsBySubject(entity)) {
				// Facts are graph nodes of their own; the memory they came from is what recall returns.
				const memoryId = fact.memoryId ?? null;
				if (memoryId === null || memoryId.length === 0) continue;
				addSeed({
					memoryId,
					score: fact.confidence * 0.5,
					voice: "graph",
					metadata: { entity, fact: `${fact.subject} ${fact.predicate} ${fact.object}` },
				});
			}
		}
		// Stable sort: equal scores keep lookup order (gists newest first).
		const direct = [...seeds.values()].sort((a, b) => b.score - a.score).slice(0, GRAPH_VOICE_MAX_DIRECT);
		const results: VoiceRecallResult[] = [...direct];
		const seen = new Set(seeds.keys());
		let frontier = direct.slice(0, GRAPH_VOICE_MAX_SEEDS).map(seed => seed.memoryId);
		const seedOf = new Map(frontier.map(id => [id, id]));
		for (let depth = 1; depth <= GRAPH_VOICE_MAX_DEPTH && frontier.length > 0; depth++) {
			if (results.length >= GRAPH_VOICE_MAX_RESULTS) break;
			const expanding = new Set(frontier);
			const next: string[] = [];
			for (const edge of this.graph.findEdgesTouching(
				frontier,
				"ctx",
				GRAPH_VOICE_MIN_EDGE_WEIGHT,
				GRAPH_VOICE_MAX_EDGE_ROWS,
			)) {
				const from = expanding.has(edge.source) ? edge.source : edge.target;
				const neighbor = from === edge.source ? edge.target : edge.source;
				// A `gist_<memoryId>` node only links back to its own memory, already seen.
				if (neighbor.startsWith("gist_") || seen.has(neighbor)) continue;
				seen.add(neighbor);
				const seed = seedOf.get(from) ?? from;
				seedOf.set(neighbor, seed);
				if (next.length < GRAPH_VOICE_MAX_FRONTIER) next.push(neighbor);
				results.push({
					memoryId: neighbor,
					score: 0.4 / depth,
					voice: "graph",
					metadata: { seed, edge_type: edge.edgeType, depth, weight: edge.weight },
				});
				if (results.length >= GRAPH_VOICE_MAX_RESULTS) break;
			}
			frontier = next;
		}
		return results;
	}
	factVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_FACT")) return [];
		const byId = new Map<string, VoiceRecallResult>();
		// Lexical object-text matches first; consolidated facts only replace a weaker seed.
		for (const seed of this.factObjectMatches(query)) {
			const existing = byId.get(seed.memoryId);
			if (existing === undefined || existing.score < seed.score) byId.set(seed.memoryId, seed);
		}
		for (const fact of this.consolidator.getConsolidatedFactsBySubjects(factSubjectCandidates(query), 0.5)) {
			for (const source of fact.sources) {
				const memoryId = source.trim();
				if (memoryId.length === 0) continue;
				const existing = byId.get(memoryId);
				if (existing !== undefined && existing.score >= fact.confidence) continue;
				byId.set(memoryId, {
					memoryId,
					score: fact.confidence,
					voice: "fact",
					metadata: {
						fact_id: fact.id ?? "",
						subject: fact.subject,
						predicate: fact.predicate,
						object: fact.object,
						mentions: fact.mention_count,
					},
				});
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
	}
	temporalVoice(query: string, options: PolyphonicCallOptions = {}): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_TEMPORAL") || !looksTemporal(query)) return [];
		const anchor = anchorTime(options.queryTime);
		const anchorMs = anchor ?? Date.now();
		const windowStart = new Date(anchorMs - TEMPORAL_WINDOW_MS).toISOString();
		const visibility = this.#visibility("", options.channelId);
		// An explicit anchor bounds the window on both sides; "now" leaves it open-ended.
		const upperBound = anchor === null ? "" : "AND timestamp <= ?";
		const upperParams = anchor === null ? [] : [new Date(anchor).toISOString()];
		let rows: TemporalRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT id, timestamp, importance
					FROM working_memory
					WHERE timestamp > ?
						${upperBound}
						AND superseded_by IS NULL
						AND (valid_until IS NULL OR valid_until > ?)
						AND ${visibility.clause}
					ORDER BY timestamp DESC
					LIMIT 20
				`)
				.all(windowStart, ...upperParams, new Date().toISOString(), ...visibility.params) as TemporalRow[];
		} catch {
			return [];
		}
		const results: VoiceRecallResult[] = [];
		for (const row of rows) {
			if (row.timestamp === null) continue;
			const then = Date.parse(row.timestamp);
			if (!Number.isFinite(then)) continue;
			const ageDays = Math.max(0, (anchorMs - then) / 86_400_000);
			const temporalScore = Math.exp(-ageDays / 7) * row.importance;
			results.push({
				memoryId: row.id,
				score: temporalScore,
				voice: "temporal",
				metadata: { age_days: ageDays, importance: row.importance },
			});
		}
		return results;
	}
	/**
	 * Weighted reciprocal rank fusion (PR #9840). A voice may report the same memory several
	 * times (e.g. the graph voice once per matching gist or fact); only its best rank counts,
	 * so each voice contributes at most `weight / (RRF_K + 1)` and the fused score stays
	 * bounded by {@link PolyphonicRecallEngine.maxCombinedScore}.
	 */
	combineVoices(...voiceResults: readonly VoiceRecallResult[][]): Map<string, PolyphonicResult> {
		const combined = new Map<string, PolyphonicResult>();
		for (const results of voiceResults) {
			if (results.length === 0) continue;
			const sorted = [...results].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
			const ranked = new Set<string>();
			for (const result of sorted) {
				if (ranked.has(result.memoryId)) continue;
				ranked.add(result.memoryId);
				let existing = combined.get(result.memoryId);
				if (existing === undefined) {
					existing = { memoryId: result.memoryId, combinedScore: 0, voiceScores: {}, metadata: {} };
					combined.set(result.memoryId, existing);
				}
				const contribution = this.voiceWeights[result.voice] / (POLYPHONIC_RRF_K + ranked.size);
				existing.voiceScores[result.voice] = contribution;
				existing.combinedScore += contribution;
				Object.assign(existing.metadata, result.metadata);
			}
		}
		return combined;
	}
	/**
	 * Select a diverse top-`topK` (PR #9840): hydrate fused candidates best-first, skipping
	 * invisible ones so they never occupy a window slot, until a window of
	 * `max(topK * 8, 64)` visible rows is filled; then MMR-rerank that window on content.
	 */
	diversityRerank(
		results: ReadonlyMap<string, PolyphonicResult>,
		topK: number,
		hydrate: (candidate: PolyphonicResult) => PolyphonicMemoryResult | null,
	): PolyphonicMemoryResult[] {
		const limit = Math.max(0, Math.trunc(topK));
		if (limit === 0) return [];
		// RRF score first, memory id as a stable tiebreak; `mmrRerank` sorts stably.
		const sorted = [...results.values()].sort(
			(a, b) => b.combinedScore - a.combinedScore || a.memoryId.localeCompare(b.memoryId),
		);
		const windowSize = Math.max(limit * DIVERSITY_OVERFETCH, DIVERSITY_MIN_WINDOW);
		const window: PolyphonicMemoryResult[] = [];
		for (const candidate of sorted) {
			if (window.length >= windowSize) break;
			const hydrated = hydrate(candidate);
			if (hydrated !== null) window.push(hydrated);
		}
		return mmrRerank(window, MMR_LAMBDA, limit);
	}
	assembleContext(results: readonly PolyphonicMemoryResult[], budget: number): PolyphonicMemoryResult[] {
		const maxChars = Math.max(0, Math.trunc(budget)) * 4;
		let chars = 0;
		const selected: PolyphonicMemoryResult[] = [];
		for (const result of results) {
			const size = JSON.stringify(result.metadata.polyphonic ?? {}).length + 100;
			if (chars + size > maxChars) break;
			selected.push(result);
			chars += size;
		}
		return selected;
	}
	getStats(): Record<string, JsonValue> {
		let embeddedRows = 0;
		try {
			const row = this.db.query("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			embeddedRows = row.count;
		} catch {
			embeddedRows = 0;
		}
		return {
			voice_weights: { ...this.voiceWeights },
			vector_stats: { embedded_rows: embeddedRows },
			graph_stats: this.graph.getStats() as unknown as Record<string, JsonValue>,
			consolidation_stats: this.consolidator.getStats() as unknown as Record<string, JsonValue>,
		};
	}
	close(): void {
		if (this.ownsConnection) closeQuietly(this.db);
	}

	/** Visibility predicate mirroring linear recall: own session, `global`, or the requested channel. */
	#visibility(alias: string, channelId: string | null | undefined): Visibility {
		const prefix = alias.length === 0 ? "" : `${alias}.`;
		if (channelId !== null && channelId !== undefined && channelId !== "") {
			return {
				clause: `(${prefix}session_id = ? OR ${prefix}scope = 'global' OR ${prefix}channel_id = ?)`,
				params: [this.sessionId, channelId],
			};
		}
		return { clause: `(${prefix}session_id = ? OR ${prefix}scope = 'global')`, params: [this.sessionId] };
	}

	#hydrate(
		candidate: PolyphonicResult,
		baselineById: ReadonlyMap<string, RecallResult>,
		options: PolyphonicCallOptions,
	): PolyphonicMemoryResult | null {
		const voiceScores = sortedVoiceScores(candidate.voiceScores);
		const baseline = baselineById.get(candidate.memoryId);
		if (baseline !== undefined) {
			const tier = baseline.tier_label ?? baseline.tier ?? "working";
			if (options.includeFacts !== true && tier === "fact") return null;
			return {
				...baseline,
				metadata: {
					...(baseline.metadata ?? parseMetadata(baseline.metadata_json ?? null)),
					polyphonic: candidate.metadata,
				},
				score: candidate.combinedScore,
				combined_score: candidate.combinedScore,
				voice_scores: voiceScores,
				tier,
				tier_label: tier,
			};
		}
		const row = this.#lookupMemory(candidate.memoryId, options.channelId);
		if (row === null) return null;
		return {
			...row,
			metadata: { ...parseMetadata(row.metadata_json), polyphonic: candidate.metadata },
			recall_count: row.recall_count ?? undefined,
			scope: row.scope ?? undefined,
			trust_tier: row.trust_tier ?? undefined,
			score: candidate.combinedScore,
			combined_score: candidate.combinedScore,
			voice_scores: voiceScores,
			tier: row.tier_name,
			tier_label: row.tier_name,
		};
	}

	#lookupMemory(memoryId: string, channelId: string | null | undefined): MemoryHydrationRow | null {
		const now = new Date().toISOString();
		const visibility = this.#visibility("", channelId);
		const working = this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, 'working' AS tier_name
				FROM working_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND ${visibility.clause}
			`)
			.get(memoryId, now, ...visibility.params) as MemoryHydrationRow | null;
		if (working !== null) return working;
		return this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, rowid, summary_of,
					tier, 'episodic' AS tier_name
				FROM episodic_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND ${visibility.clause}
			`)
			.get(memoryId, now, ...visibility.params) as MemoryHydrationRow | null;
	}
}

function sortedVoiceScores(scores: Partial<Record<PolyphonicVoice, number>>): Partial<Record<PolyphonicVoice, number>> {
	const out: Partial<Record<PolyphonicVoice, number>> = {};
	for (const voice of POLYPHONIC_VOICES) {
		const score = scores[voice];
		if (score !== undefined && Number.isFinite(score)) out[voice] = score;
	}
	return out;
}

/** Engines whose `consolidated_facts` backfill has succeeded. */
const backfilledEngines = new WeakSet<PolyphonicRecallEngine>();

/**
 * The beam's polyphonic engine, built on first use. Building it creates the fact voice
 * tables; until it succeeds once, each call also backfills `consolidated_facts` from KG
 * facts extracted while polyphonic recall was off, so enabling the flag on an existing
 * bank starts with a fact voice and a failed backfill (e.g. a busy database) is retried.
 */
export function getPolyphonicEngine(beam: BeamMemoryState): PolyphonicRecallEngine {
	const cached = beam.caches.polyphonicEngine;
	let engine: PolyphonicRecallEngine;
	if (cached instanceof PolyphonicRecallEngine && cached.db === beam.db) {
		engine = cached;
	} else {
		engine = new PolyphonicRecallEngine({
			db: beam.db,
			dbPath: beam.dbPath,
			sessionId: beam.sessionId,
			channelId: beam.channelId,
			graph: beam.episodicGraph instanceof EpisodicGraph ? beam.episodicGraph : undefined,
			consolidator: ensureVeracityConsolidator(beam),
			voiceWeights: memevalVoiceWeights(),
		});
		beam.caches.polyphonicEngine = engine;
	}
	if (!backfilledEngines.has(engine)) {
		try {
			backfillConsolidatedFacts(beam, engine.consolidator);
			backfilledEngines.add(engine);
		} catch (error) {
			// Backfill only enriches the fact voice; recall proceeds with what is consolidated.
			logger.warn("mnemopi: consolidated fact backfill failed; retrying on next polyphonic recall", {
				error: String(error),
			});
		}
	}
	return engine;
}
export function polyphonicRecall(
	beam: BeamMemoryState,
	query: string,
	topK = 10,
	options: PolyphonicRecallOptions = {},
): PolyphonicMemoryResult[] {
	// Voice fan-out, graph walk and fusion run synchronously on the caller's event loop;
	// label them so a stall is attributable.
	return withLoopPhase("mnemopi.recall", () => {
		return getPolyphonicEngine(beam).recall(
			query,
			options.queryEmbedding ?? null,
			topK,
			options.contextBudget ?? 4000,
			options,
		);
	});
}
