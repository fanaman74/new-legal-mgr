import { createHash } from "node:crypto";
import type { AppConfig } from "../config.js";
import { MODEL_CATALOG, modelDir, readModelManifest } from "./models.js";
import { tokenize } from "./text.js";

/**
 * Semantic embedding providers. All run locally:
 *  - transformers: transformers.js + a local ONNX sentence model (preferred);
 *  - ollama: a local Ollama server's embedding endpoint (localhost only unless ALLOW_EXTERNAL_LLM);
 *  - lsa: latent semantic analysis fitted on the corpus itself (no download; weaker, always available).
 */

export type EmbedRole = "query" | "passage";

export interface Embedder {
  /** Identifies the exact embedding space (provider, model, dtype); used for vector caches. */
  readonly id: string;
  readonly kind: "transformers" | "ollama" | "lsa";
  readonly description: string;
  /** Cosine similarity above which a match is considered meaningful. */
  readonly minSimilarity: number;
  /** True if vectors depend only on the text (cacheable across corpus changes). */
  readonly cacheable: boolean;
  embed(texts: string[], role: EmbedRole): Promise<Float32Array[]>;
}

export function normaliseVector(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

// ---------------------------------------------------------------------------------------------

export class TransformersEmbedder implements Embedder {
  readonly kind = "transformers" as const;
  readonly cacheable = true;
  readonly id: string;
  readonly description: string;
  readonly minSimilarity: number;
  private extractor: ((texts: string[], opts: Record<string, unknown>) => Promise<{ tolist(): number[][] }>) | null = null;

  constructor(private readonly modelsDir: string, private readonly modelId: string, private readonly dtype: "q8" | "fp32", sourceHash: string) {
    const spec = MODEL_CATALOG[modelId]!;
    this.id = `transformers:${modelId}:${dtype}:${sourceHash.slice(0, 12)}`;
    this.description = `${spec.description} (local ONNX, ${dtype})`;
    this.minSimilarity = spec.minSimilarity;
  }

  private async load() {
    if (this.extractor) return this.extractor;
    const { pipeline, env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false; // never download at run time
    env.allowLocalModels = true;
    env.localModelPath = `${this.modelsDir}/`;
    this.extractor = (await pipeline("feature-extraction", this.modelId, { dtype: this.dtype })) as never;
    return this.extractor!;
  }

  async embed(texts: string[], role: EmbedRole): Promise<Float32Array[]> {
    const spec = MODEL_CATALOG[this.modelId]!;
    const prefix = role === "query" ? spec.queryPrefix : spec.passagePrefix;
    const extractor = await this.load();
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 16) {
      const batch = texts.slice(i, i + 16).map((t) => prefix + t.slice(0, 2000));
      const res = await extractor(batch, { pooling: "mean", normalize: true });
      for (const row of res.tolist()) out.push(Float32Array.from(row));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------

function isLocalUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

export function externalAllowed(): boolean {
  return ["1", "true", "yes", "on"].includes((process.env.ALLOW_EXTERNAL_LLM ?? "").toLowerCase());
}

export class OllamaEmbedder implements Embedder {
  readonly kind = "ollama" as const;
  readonly cacheable = true;
  readonly id: string;
  readonly description: string;
  readonly minSimilarity = 0.5;

  constructor(private readonly url: string, private readonly model: string) {
    if (!isLocalUrl(url) && !externalAllowed()) {
      throw new Error(`Refusing to send document text to non-local embedding service ${url} (set ALLOW_EXTERNAL_LLM=true to allow).`);
    }
    this.id = `ollama:${model}`;
    this.description = `Ollama embeddings (${model}) at ${url}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += 32) {
      const res = await fetch(`${this.url.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + 32) }),
      });
      if (!res.ok) throw new Error(`Ollama embedding request failed: HTTP ${res.status}`);
      const body = (await res.json()) as { embeddings: number[][] };
      for (const e of body.embeddings) out.push(normaliseVector(Float32Array.from(e)));
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------

/** Deterministic pseudo-random numbers (mulberry32) for reproducible LSA. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Latent semantic analysis: TF-IDF term-document matrix reduced by a truncated eigendecomposition
 * of the document Gram matrix. Captures co-occurrence ("termination letter" ~ "notice of
 * dismissal" if the corpus links them) without any external model.
 */
export class LsaEmbedder implements Embedder {
  readonly kind = "lsa" as const;
  readonly cacheable = false;
  readonly id: string;
  readonly description: string;
  readonly minSimilarity = 0.3;
  private readonly vocab = new Map<string, number>();
  private idf: Float64Array = new Float64Array(0);
  /** Term projection (vocab x k), row-major. */
  private projection: Float64Array = new Float64Array(0);
  private k = 0;

  constructor(docs: string[], maxDims = 100) {
    const tokenised = docs.map((d) => tokenize(d));
    const df = new Map<string, number>();
    for (const toks of tokenised) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    for (const [t, n] of df) if (n >= 1) this.vocab.set(t, this.vocab.size);
    const n = docs.length;
    this.idf = new Float64Array(this.vocab.size);
    for (const [t, i] of this.vocab) this.idf[i] = Math.log((1 + n) / (1 + df.get(t)!)) + 1;

    // Sparse normalised TF-IDF document vectors.
    const docVecs = tokenised.map((toks) => this.tfidf(toks));
    this.k = Math.max(1, Math.min(maxDims, n - 1, this.vocab.size));
    const gram = new Float64Array(n * n);
    const postings = new Map<number, [number, number][]>();
    docVecs.forEach((vec, d) => {
      for (const [term, w] of vec) {
        let p = postings.get(term);
        if (!p) postings.set(term, (p = []));
        p.push([d, w]);
      }
    });
    for (const p of postings.values()) {
      for (const [di, wi] of p) for (const [dj, wj] of p) gram[di * n + dj]! += wi * wj;
    }

    // Subspace iteration for the top-k eigenvectors of the Gram matrix.
    const rand = rng(42);
    let V = new Float64Array(n * this.k).map(() => rand() - 0.5);
    const orthonormalise = (M: Float64Array) => {
      for (let c = 0; c < this.k; c++) {
        for (let p = 0; p < c; p++) {
          let dot = 0;
          for (let r = 0; r < n; r++) dot += M[r * this.k + c]! * M[r * this.k + p]!;
          for (let r = 0; r < n; r++) M[r * this.k + c]! -= dot * M[r * this.k + p]!;
        }
        let norm = 0;
        for (let r = 0; r < n; r++) norm += M[r * this.k + c]! ** 2;
        norm = Math.sqrt(norm) || 1;
        for (let r = 0; r < n; r++) M[r * this.k + c]! /= norm;
      }
    };
    orthonormalise(V);
    for (let iter = 0; iter < 25; iter++) {
      const next = new Float64Array(n * this.k);
      for (let r = 0; r < n; r++) {
        for (let s = 0; s < n; s++) {
          const g = gram[r * n + s]!;
          if (g === 0) continue;
          for (let c = 0; c < this.k; c++) next[r * this.k + c]! += g * V[s * this.k + c]!;
        }
      }
      orthonormalise(next);
      V = next;
    }
    // Eigenvalues (sigma^2) and term projection U = D^T V Sigma^-1.
    const sigma = new Float64Array(this.k);
    for (let c = 0; c < this.k; c++) {
      let lambda = 0;
      for (let r = 0; r < n; r++) {
        let gv = 0;
        for (let s = 0; s < n; s++) gv += gram[r * n + s]! * V[s * this.k + c]!;
        lambda += V[r * this.k + c]! * gv;
      }
      sigma[c] = Math.sqrt(Math.max(lambda, 1e-12));
    }
    this.projection = new Float64Array(this.vocab.size * this.k);
    docVecs.forEach((vec, d) => {
      for (const [term, w] of vec) {
        for (let c = 0; c < this.k; c++) this.projection[term * this.k + c]! += (w * V[d * this.k + c]!) / sigma[c]!;
      }
    });
    this.id = `lsa:${createHash("sha256").update(docs.join("\u0000")).digest("hex").slice(0, 12)}:${this.k}`;
    this.description = `Latent semantic analysis fitted on the corpus (${this.k} dimensions, no external model)`;
  }

  private tfidf(tokens: string[]): Map<number, number> {
    const tf = new Map<number, number>();
    for (const t of tokens) {
      const i = this.vocab.get(t);
      if (i !== undefined) tf.set(i, (tf.get(i) ?? 0) + 1);
    }
    const vec = new Map<number, number>();
    let norm = 0;
    for (const [i, f] of tf) {
      const w = (1 + Math.log(f)) * this.idf[i]!;
      vec.set(i, w);
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;
    for (const [i, w] of vec) vec.set(i, w / norm);
    return vec;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => {
      const out = new Float32Array(this.k);
      for (const [term, w] of this.tfidf(tokenize(t))) {
        for (let c = 0; c < this.k; c++) out[c]! += w * this.projection[term * this.k + c]!;
      }
      return normaliseVector(out);
    });
  }
}

// ---------------------------------------------------------------------------------------------

export interface EmbedderChoice {
  embedder: Embedder | null;
  /** Why this provider was chosen / why the preferred one is unavailable. */
  note: string;
}

/** Resolve the configured semantic provider. `corpusTexts` is needed for LSA. */
export function resolveEmbedder(cfg: AppConfig, corpusTexts: string[]): EmbedderChoice {
  const s = cfg.retrieval.semantic;
  const lsa = (): EmbedderChoice =>
    corpusTexts.length >= 3
      ? { embedder: new LsaEmbedder(corpusTexts), note: "built-in LSA (no external model)" }
      : { embedder: null, note: "corpus too small for semantic retrieval" };
  if (s.provider === "none") return { embedder: null, note: "semantic retrieval disabled in configuration" };
  if (s.provider === "lsa") return lsa();
  if (s.provider === "ollama") return { embedder: new OllamaEmbedder(s.ollamaUrl, s.ollamaModel), note: "Ollama (configured)" };
  const manifest = readModelManifest(s.modelsDir, s.model);
  if (manifest && MODEL_CATALOG[s.model]) {
    const sourceHash = createHash("sha256").update(JSON.stringify(manifest.files)).digest("hex");
    return { embedder: new TransformersEmbedder(s.modelsDir, s.model, manifest.dtype, sourceHash), note: `local model ${s.model} (${manifest.source})` };
  }
  if (s.provider === "transformers") throw new Error(`Embedding model ${s.model} is not installed in ${modelDir(s.modelsDir, s.model)}. Start the launcher or run \`npm run setup-models\`.`);
  const fallback = lsa();
  return { ...fallback, note: `${fallback.note}; local model ${s.model} not installed` };
}
