import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AuditLog, hashText } from "../audit.js";
import { applyCorrections, CorrectionStore, type EffectiveEvidence } from "../evidence/corrections.js";
import type { Chunk } from "../evidence/models.js";
import { EvidenceRepository } from "../evidence/repository.js";
import { writeJson } from "../util/fs-guard.js";
import { Bm25Index } from "./bm25.js";
import { cosine, resolveEmbedder, type Embedder } from "./embeddings.js";
import { canonicalForQuote, contentTokens, tokenize } from "./text.js";

/**
 * Hybrid retrieval over evidence chunks: BM25 (exact names, dates, references, quoted text)
 * plus local semantic embeddings, fused with reciprocal rank fusion. Every result carries full
 * provenance (Evidence ID, file, page or section, chunk ID, offsets).
 */

export interface SearchParams {
  query: string;
  matter?: string[] | null;
  document_type?: string[] | null;
  /** ISO dates (inclusive), compared with the effective document date. */
  date_from?: string | null;
  date_to?: string | null;
  author?: string[] | null;
  evidence_ids?: string[] | null;
  top_k?: number;
  mode?: "hybrid" | "lexical" | "semantic";
}

export interface SearchResult {
  evidence_id: string;
  filename: string;
  page: number | null;
  section_id: string | null;
  heading: string | null;
  text: string;
  score: number;
  retrieval_method: ("lexical" | "semantic")[];
  chunk_id: string;
  paragraph_ids: string[];
  char_start: number;
  char_end: number;
  document_date: string | null;
  document_type: string;
  title: string | null;
  matter: string[];
  source_path: string;
  ocr: boolean;
  ocr_confidence: number | null;
  lexical_rank: number | null;
  semantic_rank: number | null;
  /** Raw BM25 score (lexical) and cosine similarity (semantic), for diagnostics. */
  lexical_score: number | null;
  semantic_similarity: number | null;
  /** Share of the query's content words present in this chunk. */
  query_coverage: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  semantic: { provider: string | null; note: string };
  filtered_candidates: number;
  took_ms: number;
}

interface IndexedChunk {
  chunk: Chunk;
  record: EffectiveEvidence;
  /** Text indexed lexically: title, headings and chunk text. */
  indexText: string;
  tokens: Set<string>;
}

/** Changes whenever canonical records, chunks or corrections change. */
export function corpusFingerprint(cfg: AppConfig): string {
  const h = createHash("sha256");
  for (const dir of [cfg.canonicalDir, cfg.extractedDir, cfg.correctionsDir]) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      const st = statSync(path.join(dir, f));
      h.update(`${dir}/${f}:${st.size}:${st.mtimeMs}\n`);
    }
  }
  return h.digest("hex");
}

export class RetrievalIndex {
  private constructor(
    private readonly cfg: AppConfig,
    readonly fingerprint: string,
    readonly items: IndexedChunk[],
    private readonly bm25: Bm25Index,
    readonly embedder: Embedder | null,
    readonly semanticNote: string,
    private readonly vectors: Float32Array[] | null,
    readonly records: Map<string, EffectiveEvidence>,
  ) {}

  static async build(cfg: AppConfig, log: (s: string) => void = () => undefined): Promise<RetrievalIndex> {
    const fingerprint = corpusFingerprint(cfg);
    const repo = new EvidenceRepository(cfg);
    const corrections = new CorrectionStore(cfg).all();
    const records = new Map(repo.listCanonical().map((r) => [r.evidence_id, applyCorrections(r, corrections)]));
    const items: IndexedChunk[] = [];
    for (const record of records.values()) {
      for (const chunk of repo.loadChunks(record.evidence_id)) {
        const indexText = [record.document.title, chunk.heading_path.join(" / "), chunk.text].filter(Boolean).join("\n");
        items.push({ chunk, record, indexText, tokens: new Set(contentTokens(chunk.text)) });
      }
    }
    const bm25 = new Bm25Index(items.map((i) => tokenize(i.indexText)));

    let embedder: Embedder | null = null;
    let note = "no chunks indexed";
    let vectors: Float32Array[] | null = null;
    if (items.length) {
      try {
        const choice = resolveEmbedder(cfg, items.map((i) => i.indexText));
        embedder = choice.embedder;
        note = choice.note;
        if (embedder) vectors = await embedChunks(cfg, embedder, items, log);
      } catch (err) {
        embedder = null;
        vectors = null;
        note = `semantic retrieval unavailable: ${(err as Error).message}`;
      }
    }
    return new RetrievalIndex(cfg, fingerprint, items, bm25, embedder, note, vectors, records);
  }

  /** Inverse document frequency of a token over the indexed chunks (rare = informative). */
  idf(token: string): number {
    return this.bm25.idf(token);
  }

  isStale(): boolean {
    return corpusFingerprint(this.cfg) !== this.fingerprint;
  }

  private passesFilters(item: IndexedChunk, p: SearchParams): boolean {
    const d = item.record.document;
    if (p.evidence_ids?.length && !p.evidence_ids.includes(item.record.evidence_id)) return false;
    if (p.matter?.length && !p.matter.some((m) => d.matter.includes(m))) return false;
    if (p.document_type?.length && !p.document_type.includes(d.document_type)) return false;
    if (p.date_from && (!d.date || d.date < p.date_from)) return false;
    if (p.date_to && (!d.date || d.date > p.date_to)) return false;
    if (p.author?.length) {
      const authors = d.author.join(" ").toLowerCase();
      if (!p.author.some((a) => authors.includes(a.toLowerCase()))) return false;
    }
    return true;
  }

  async search(p: SearchParams): Promise<SearchResponse> {
    const started = Date.now();
    const topK = Math.max(1, Math.min(p.top_k ?? 10, 100));
    const depth = Math.max(this.cfg.retrieval.candidateDepth, topK);
    const mode = p.mode ?? "hybrid";
    const allowed = new Set<number>();
    this.items.forEach((item, i) => {
      if (this.passesFilters(item, p)) allowed.add(i);
    });

    // Quoted phrases in the query are mandatory exact matches (whitespace/punctuation-insensitive).
    const phrases = [...p.query.matchAll(/"([^"]{3,})"/g)].map((m) => canonicalForQuote(m[1]!));
    if (phrases.length) {
      for (const i of [...allowed]) {
        const hay = canonicalForQuote(this.items[i]!.chunk.text);
        if (!phrases.every((ph) => hay.includes(ph))) allowed.delete(i);
      }
    }

    const queryTokens = tokenize(p.query);
    const queryContent = new Set(contentTokens(p.query));
    // Hard facts (references, anchors, dates) weigh more than ordinary words.
    const weights = new Map(queryTokens.map((t) => [t, t.includes(":") || /\d/.test(t) ? 2 : 1]));

    let lexical: [number, number][] = [];
    if (mode !== "semantic") {
      // Coordination factor: chunks matching more of the distinct query terms rank higher.
      const distinct = [...new Set(queryTokens)];
      lexical = [...this.bm25.score(queryTokens, weights)]
        .filter(([i]) => allowed.has(i))
        .map(([i, sc]): [number, number, number] => {
          const toks = this.itemTokens(i);
          const share = distinct.filter((t) => toks.has(t)).length / distinct.length;
          return [i, sc * Math.pow(share, 1.5), share];
        })
        // Rank fusion ignores score magnitudes, so drop chunks that share only a stray term
        // (e.g. just the year of a date) with the query.
        .filter(([, , share]) => share >= 0.5 || (share >= 0.34 && distinct.length >= 4))
        .map(([i, sc]): [number, number] => [i, sc])
        .sort((a, b) => b[1] - a[1])
        .slice(0, depth);
    }
    let semantic: [number, number][] = [];
    if (mode !== "lexical" && this.embedder && this.vectors) {
      const [qv] = await this.embedder.embed([p.query], "query");
      semantic = [...allowed]
        .map((i): [number, number] => [i, cosine(qv!, this.vectors![i]!)])
        .filter(([, s]) => s > 0)
        .sort((a, b) => b[1] - a[1])
        .slice(0, depth);
    }

    const k = this.cfg.retrieval.rrfK;
    // Fact-heavy queries (dates, references, article numbers) rely on exact matching:
    // semantic similarity then only acts as a tie-breaker.
    const factTokens = queryTokens.filter((t) => t.includes(":") || /\d/.test(t)).length;
    const semanticWeight = factTokens / Math.max(1, new Set(queryTokens).size) >= 0.4 ? 0.35 : 1;
    const fused = new Map<number, { rrf: number; lr: number | null; ls: number | null; sr: number | null; ss: number | null }>();
    lexical.forEach(([i, s], rank) => fused.set(i, { rrf: 1 / (k + rank + 1), lr: rank + 1, ls: s, sr: null, ss: null }));
    semantic.forEach(([i, s], rank) => {
      const e = fused.get(i) ?? { rrf: 0, lr: null, ls: null, sr: null, ss: null };
      // A semantic hit below the model's threshold only counts weakly.
      const weight = (s >= (this.embedder?.minSimilarity ?? 0) ? 1 : 0.5) * semanticWeight;
      e.rrf += weight / (k + rank + 1);
      e.sr = rank + 1;
      e.ss = s;
      fused.set(i, e);
    });
    const maxRrf = ((lexical.length ? 1 : 0) + (semantic.length ? (lexical.length ? semanticWeight : 1) : 0)) / (k + 1) || 1;

    const results: SearchResult[] = [...fused.entries()]
      .sort((a, b) => b[1].rrf - a[1].rrf || (b[1].ls ?? 0) - (a[1].ls ?? 0))
      .slice(0, topK)
      .map(([i, f]) => {
        const { chunk, record } = this.items[i]!;
        return {
          evidence_id: chunk.evidence_id,
          filename: record.source.original_filename,
          page: chunk.page,
          section_id: chunk.section_id,
          heading: chunk.heading,
          text: chunk.text,
          score: Math.round((f.rrf / maxRrf) * 1000) / 1000,
          retrieval_method: [...(f.lr ? (["lexical"] as const) : []), ...(f.sr ? (["semantic"] as const) : [])],
          chunk_id: chunk.chunk_id,
          paragraph_ids: chunk.paragraph_ids,
          char_start: chunk.char_start,
          char_end: chunk.char_end,
          document_date: record.document.date,
          document_type: record.document.document_type,
          title: record.document.title,
          matter: record.document.matter,
          source_path: `${record.source.source_root}/${record.source.relative_path}`,
          ocr: chunk.ocr,
          ocr_confidence: chunk.ocr_confidence,
          lexical_rank: f.lr,
          semantic_rank: f.sr,
          lexical_score: f.ls === null ? null : Math.round(f.ls * 1000) / 1000,
          semantic_similarity: f.ss === null ? null : Math.round(f.ss * 1000) / 1000,
          query_coverage: queryContent.size ? Math.round(([...queryContent].filter((t) => this.items[i]!.tokens.has(t)).length / queryContent.size) * 1000) / 1000 : 0,
        };
      });

    return {
      query: p.query,
      results,
      semantic: { provider: this.embedder?.id ?? null, note: this.semanticNote },
      filtered_candidates: allowed.size,
      took_ms: Date.now() - started,
    };
  }

  private tokenCache = new Map<number, Set<string>>();
  private itemTokens(i: number): Set<string> {
    let t = this.tokenCache.get(i);
    if (!t) this.tokenCache.set(i, (t = new Set(tokenize(this.items[i]!.indexText))));
    return t;
  }

  /** Embed arbitrary texts in this index's semantic space (null when unavailable). */
  async embed(texts: string[], role: "query" | "passage"): Promise<Float32Array[] | null> {
    if (!this.embedder) return null;
    return this.embedder.embed(texts, role);
  }

  vectorFor(chunkId: string): Float32Array | null {
    if (!this.vectors) return null;
    const i = this.items.findIndex((x) => x.chunk.chunk_id === chunkId);
    return i >= 0 ? this.vectors[i]! : null;
  }

  chunksOf(evidenceId: string): Chunk[] {
    return this.items.filter((x) => x.chunk.evidence_id === evidenceId).map((x) => x.chunk);
  }
}

/** Embed chunks, reusing cached vectors for unchanged text (cacheable embedders only). */
async function embedChunks(cfg: AppConfig, embedder: Embedder, items: IndexedChunk[], log: (s: string) => void): Promise<Float32Array[]> {
  const textHash = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 16);
  const cacheFile = path.join(cfg.indexesDir, `vectors.${embedder.id.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  let cache: Record<string, { h: string; v: string }> = {};
  if (embedder.cacheable && existsSync(cacheFile)) {
    try {
      cache = (JSON.parse(readFileSync(cacheFile, "utf8")) as { entries: typeof cache }).entries;
    } catch {
      cache = {};
    }
  }
  const out: (Float32Array | null)[] = items.map((it) => {
    const c = cache[it.chunk.chunk_id];
    return c && c.h === textHash(it.indexText) ? new Float32Array(new Uint8Array(Buffer.from(c.v, "base64")).buffer) : null;
  });
  const missing = out.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
  if (missing.length) {
    log(`Embedding ${missing.length} chunk(s) with ${embedder.description}...`);
    const vecs = await embedder.embed(missing.map((i) => items[i]!.indexText), "passage");
    missing.forEach((i, j) => (out[i] = vecs[j]!));
    if (embedder.cacheable) {
      const entries: typeof cache = {};
      items.forEach((it, i) => {
        entries[it.chunk.chunk_id] = { h: textHash(it.indexText), v: Buffer.from(out[i]!.buffer, out[i]!.byteOffset, out[i]!.byteLength).toString("base64") };
      });
      writeJson(cacheFile, { embedder: embedder.id, entries });
    }
  }
  return out as Float32Array[];
}

/**
 * Process-wide index cache. Rebuilt automatically when the corpus or corrections change.
 */
export class SearchService {
  private index: RetrievalIndex | null = null;
  private building: Promise<RetrievalIndex> | null = null;
  private readonly audit: AuditLog;

  constructor(private readonly cfg: AppConfig, private readonly log: (s: string) => void = () => undefined) {
    this.audit = new AuditLog(cfg.auditLog);
  }

  async getIndex(): Promise<RetrievalIndex> {
    if (this.index && !this.index.isStale()) return this.index;
    if (!this.building) {
      this.building = RetrievalIndex.build(this.cfg, this.log).finally(() => (this.building = null));
    }
    this.index = await this.building;
    return this.index;
  }

  async search(p: SearchParams, purpose = "search"): Promise<SearchResponse> {
    const index = await this.getIndex();
    const res = await index.search(p);
    this.audit.record({
      action: "QUERY",
      purpose,
      query_hash: hashText(p.query),
      filters: { matter: p.matter ?? null, document_type: p.document_type ?? null, date_from: p.date_from ?? null, date_to: p.date_to ?? null },
      result_evidence_ids: [...new Set(res.results.map((r) => r.evidence_id))],
      took_ms: res.took_ms,
    });
    return res;
  }
}
