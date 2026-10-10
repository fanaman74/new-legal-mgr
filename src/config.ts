import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

/** Repository root (one level above src/). */
export const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const AppYaml = z.object({
  version: z.number(),
  paths: z.object({
    data_dir: z.string(),
    originals_dir: z.string(),
    audit_log: z.string(),
  }),
  ingestion: z.object({
    supported_extensions: z.array(z.string()),
    ignore_patterns: z.array(z.string()),
    force_reparse: z.boolean(),
  }),
  pdf: z.object({
    min_text_chars_per_page: z.number().int().nonnegative(),
    ocr_render_scale: z.number().positive(),
  }),
  ocr: z.object({
    enabled: z.boolean(),
    langs: z.string(),
    lang_path: z.string(),
  }),
  chunking: z.object({
    target_chars: z.number().int().positive(),
    max_chars: z.number().int().positive(),
  }),
  retrieval: z.object({
    candidate_depth: z.number().int().positive(),
    rrf_k: z.number().positive(),
    semantic: z.object({
      provider: z.enum(["auto", "transformers", "ollama", "lsa", "none"]),
      model: z.string(),
      models_dir: z.string(),
      ollama_url: z.string(),
      ollama_model: z.string(),
    }),
  }),
  answer: z.object({
    min_lexical_coverage: z.number().min(0).max(1),
    max_passages: z.number().int().positive(),
  }),
  llm: z.object({
    provider: z.enum(["none", "ollama", "openai-compatible"]),
    url: z.string(),
    model: z.string(),
    timeout_seconds: z.number().positive(),
  }),
});

const DocumentTypesYaml = z.object({
  version: z.number(),
  types: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      path_patterns: z.array(z.string()).default([]),
      text_patterns: z.array(z.string()).default([]),
    }),
  ),
});

const MattersYaml = z.object({
  version: z.number(),
  matters: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      path_prefixes: z.array(z.string()).default([]),
      keywords: z.array(z.string()).default([]),
    }),
  ),
});

export type DocumentTypeRule = z.infer<typeof DocumentTypesYaml>["types"][number];
export type MatterRule = z.infer<typeof MattersYaml>["matters"][number];

export interface AppConfig {
  dataDir: string;
  originalsDir: string;
  extractedDir: string;
  canonicalDir: string;
  attachmentsDir: string;
  indexesDir: string;
  correctionsDir: string;
  auditLog: string;
  ingestion: {
    supportedExtensions: string[];
    ignorePatterns: string[];
    forceReparse: boolean;
  };
  pdf: { minTextCharsPerPage: number; ocrRenderScale: number };
  ocr: { enabled: boolean; langs: string; langPath: string };
  chunking: { targetChars: number; maxChars: number };
  retrieval: {
    candidateDepth: number;
    rrfK: number;
    semantic: {
      provider: "auto" | "transformers" | "ollama" | "lsa" | "none";
      model: string;
      modelsDir: string;
      ollamaUrl: string;
      ollamaModel: string;
    };
  };
  answer: { minLexicalCoverage: number; maxPassages: number };
  llm: { provider: "none" | "ollama" | "openai-compatible"; url: string; model: string; timeoutSeconds: number; apiKey: string | null };
  documentTypes: DocumentTypeRule[];
  matters: MatterRule[];
}

function loadYaml<T>(file: string, schema: z.ZodType<T>): T {
  if (!existsSync(file)) throw new Error(`Configuration file not found: ${file}`);
  const parsed = schema.safeParse(parseYaml(readFileSync(file, "utf8")));
  if (!parsed.success) {
    throw new Error(`Invalid configuration in ${file}: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

let dotEnvLoaded = false;

/** Load <repo>/.env once, if present. Variables already set in the environment take precedence. */
function loadDotEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;
  const file = path.join(REPO_ROOT, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

function resolveFromRoot(p: string, root: string): string {
  return path.isAbsolute(p) ? path.normalize(p) : path.resolve(root, p);
}

function envBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export interface ConfigOverrides {
  dataDir?: string;
  originalsDir?: string;
  auditLog?: string;
  ocrEnabled?: boolean;
  forceReparse?: boolean;
  semanticProvider?: AppConfig["retrieval"]["semantic"]["provider"];
}

/**
 * Load configuration from config/*.yaml, then environment variables, then explicit overrides.
 * Generated directories are always derived from dataDir so that tests can isolate them.
 */
export function loadConfig(overrides: ConfigOverrides = {}, configDir = path.join(REPO_ROOT, "config")): AppConfig {
  loadDotEnv();
  const app = loadYaml(path.join(configDir, "app.yaml"), AppYaml);
  const docTypes = loadYaml(path.join(configDir, "document_types.yaml"), DocumentTypesYaml);
  const matters = loadYaml(path.join(configDir, "matters.yaml"), MattersYaml);
  const env = process.env;

  const dataDir = resolveFromRoot(overrides.dataDir ?? env.LEGAL_DATA_DIR ?? app.paths.data_dir, REPO_ROOT);
  const originalsDir = resolveFromRoot(
    overrides.originalsDir ?? env.LEGAL_ORIGINALS_DIR ?? app.paths.originals_dir,
    REPO_ROOT,
  );
  const auditLog = resolveFromRoot(overrides.auditLog ?? env.LEGAL_AUDIT_LOG ?? app.paths.audit_log, REPO_ROOT);

  return {
    dataDir,
    originalsDir,
    extractedDir: path.join(dataDir, "extracted"),
    canonicalDir: path.join(dataDir, "canonical"),
    attachmentsDir: path.join(dataDir, "attachments"),
    indexesDir: path.join(dataDir, "indexes"),
    correctionsDir: path.join(dataDir, "corrections"),
    auditLog,
    ingestion: {
      supportedExtensions: app.ingestion.supported_extensions.map((e) => e.toLowerCase()),
      ignorePatterns: app.ingestion.ignore_patterns,
      forceReparse: overrides.forceReparse ?? app.ingestion.force_reparse,
    },
    pdf: {
      minTextCharsPerPage: app.pdf.min_text_chars_per_page,
      ocrRenderScale: app.pdf.ocr_render_scale,
    },
    ocr: {
      enabled: overrides.ocrEnabled ?? envBool(env.OCR_ENABLED, app.ocr.enabled),
      langs: env.OCR_LANGS || app.ocr.langs,
      langPath: resolveFromRoot(env.OCR_LANG_PATH || app.ocr.lang_path, REPO_ROOT),
    },
    chunking: { targetChars: app.chunking.target_chars, maxChars: app.chunking.max_chars },
    retrieval: {
      candidateDepth: app.retrieval.candidate_depth,
      rrfK: app.retrieval.rrf_k,
      semantic: {
        provider: overrides.semanticProvider ?? (env.SEMANTIC_PROVIDER as AppConfig["retrieval"]["semantic"]["provider"] | undefined) ?? app.retrieval.semantic.provider,
        model: env.SEMANTIC_MODEL || app.retrieval.semantic.model,
        modelsDir: resolveFromRoot(env.LEGAL_MODELS_DIR || app.retrieval.semantic.models_dir, REPO_ROOT),
        ollamaUrl: env.OLLAMA_URL || app.retrieval.semantic.ollama_url,
        ollamaModel: env.OLLAMA_EMBED_MODEL || app.retrieval.semantic.ollama_model,
      },
    },
    answer: { minLexicalCoverage: app.answer.min_lexical_coverage, maxPassages: app.answer.max_passages },
    llm: {
      provider: (env.LLM_PROVIDER as AppConfig["llm"]["provider"] | undefined) || app.llm.provider,
      url: env.LLM_URL || app.llm.url,
      model: env.LLM_MODEL || app.llm.model,
      timeoutSeconds: app.llm.timeout_seconds,
      apiKey: env.LLM_API_KEY || null,
    },
    documentTypes: docTypes.types,
    matters: matters.matters,
  };
}
