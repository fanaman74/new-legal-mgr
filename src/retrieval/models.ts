import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import * as tar from "tar";

/**
 * Local sentence-embedding models: catalogue, download (setup time only) and verification.
 *
 * Models are downloaded once into <models_dir>/<model id>/ by the launcher (or
 * `npm run setup-models`). At run time the app only loads local files; document text is never
 * sent anywhere. Every installed model has a model.json manifest recording its source and the
 * SHA-256 of each file, so results can be traced to the exact model used.
 */

type Source =
  | { kind: "huggingface"; repo: string; revision: string; dtype: "q8" | "fp32"; files: string[] }
  | { kind: "tarball"; url: string; sha256: string; dtype: "q8" | "fp32"; map: Record<string, string> };

export interface ModelSpec {
  id: string;
  description: string;
  dims: number;
  queryPrefix: string;
  passagePrefix: string;
  /** Cosine similarity above which a passage is considered a meaningful semantic match. */
  minSimilarity: number;
  sources: Source[];
}

export const MODEL_CATALOG: Record<string, ModelSpec> = {
  "all-MiniLM-L6-v2": {
    id: "all-MiniLM-L6-v2",
    description: "English sentence embeddings (384 dimensions), sentence-transformers/all-MiniLM-L6-v2",
    dims: 384,
    queryPrefix: "",
    passagePrefix: "",
    minSimilarity: 0.3,
    sources: [
      {
        kind: "huggingface",
        repo: "Xenova/all-MiniLM-L6-v2",
        revision: "main",
        dtype: "q8",
        files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
      },
      {
        // Mirror used by the Chroma project; pinned by SHA-256.
        kind: "tarball",
        url: "https://chroma-onnx-models.s3.amazonaws.com/all-MiniLM-L6-v2/onnx.tar.gz",
        sha256: "913d7300ceae3b2dbc2c50d1de4baacab4be7b9380491c27fab7418616a16ec3",
        dtype: "fp32",
        map: {
          "onnx/config.json": "config.json",
          "onnx/tokenizer.json": "tokenizer.json",
          "onnx/tokenizer_config.json": "tokenizer_config.json",
          "onnx/special_tokens_map.json": "special_tokens_map.json",
          "onnx/model.onnx": "onnx/model.onnx",
        },
      },
    ],
  },
  "multilingual-e5-small": {
    id: "multilingual-e5-small",
    description: "Multilingual sentence embeddings (384 dimensions, ~100 languages), intfloat/multilingual-e5-small",
    dims: 384,
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    minSimilarity: 0.78,
    sources: [
      {
        kind: "huggingface",
        repo: "Xenova/multilingual-e5-small",
        revision: "main",
        dtype: "q8",
        files: ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model_quantized.onnx"],
      },
    ],
  },
};

export interface ModelManifest {
  id: string;
  dtype: "q8" | "fp32";
  source: string;
  installed_at: string;
  files: Record<string, string>;
}

export function modelDir(modelsDir: string, id: string): string {
  return path.join(modelsDir, id);
}

export function readModelManifest(modelsDir: string, id: string): ModelManifest | null {
  const file = path.join(modelDir(modelsDir, id), "model.json");
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as ModelManifest;
  } catch {
    return null;
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function download(url: string, target: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  mkdirSync(path.dirname(target), { recursive: true });
  await streamPipeline(Readable.fromWeb(res.body as never), createWriteStream(target));
}

async function installFrom(source: Source, staging: string, log: (s: string) => void): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  if (source.kind === "huggingface") {
    for (const f of source.files) {
      const url = `https://huggingface.co/${source.repo}/resolve/${source.revision}/${f}`;
      log(`  downloading ${source.repo}/${f}`);
      await download(url, path.join(staging, f));
      files[f] = await sha256File(path.join(staging, f));
    }
    return files;
  }
  const archive = path.join(staging, "..", `${path.basename(staging)}.tar.gz`);
  log(`  downloading ${source.url}`);
  await download(source.url, archive);
  const actual = await sha256File(archive);
  if (actual !== source.sha256) {
    rmSync(archive, { force: true });
    throw new Error(`checksum mismatch for ${source.url}`);
  }
  log("  checksum verified");
  const unpack = `${staging}-unpack`;
  mkdirSync(unpack, { recursive: true });
  await tar.x({ file: archive, cwd: unpack, preserveOwner: false });
  for (const [from, to] of Object.entries(source.map)) {
    mkdirSync(path.dirname(path.join(staging, to)), { recursive: true });
    copyFileSync(path.join(unpack, from), path.join(staging, to));
    files[to] = await sha256File(path.join(staging, to));
  }
  rmSync(unpack, { recursive: true, force: true });
  rmSync(archive, { force: true });
  return files;
}

/** Download and install a model if it is not installed yet. Returns the manifest. */
export async function ensureModel(modelsDir: string, id: string, log: (s: string) => void = () => undefined): Promise<ModelManifest> {
  const existing = readModelManifest(modelsDir, id);
  if (existing) return existing;
  const spec = MODEL_CATALOG[id];
  if (!spec) throw new Error(`Unknown model "${id}". Known models: ${Object.keys(MODEL_CATALOG).join(", ")}`);
  const target = modelDir(modelsDir, id);
  const errors: string[] = [];
  for (const source of spec.sources) {
    const staging = path.join(modelsDir, `.staging-${id}`);
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      const files = await installFrom(source, staging, log);
      const manifest: ModelManifest = {
        id,
        dtype: source.dtype,
        source: source.kind === "huggingface" ? `huggingface:${source.repo}@${source.revision}` : source.url,
        installed_at: new Date().toISOString(),
        files,
      };
      writeFileSync(path.join(staging, "model.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(target, { recursive: true, force: true });
      renameSync(staging, target);
      return manifest;
    } catch (err) {
      errors.push(`${source.kind === "huggingface" ? source.repo : source.url}: ${(err as Error).message}`);
      rmSync(staging, { recursive: true, force: true });
      log(`  source failed: ${(err as Error).message}`);
    }
  }
  throw new Error(`Could not download model ${id}. ${errors.join("; ")}`);
}
