import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { ensureModel, MODEL_CATALOG, readModelManifest } from "../src/retrieval/models.js";

const program = new Command()
  .name("setup-models")
  .description("Download the local semantic-search model (once). Document content is never sent anywhere.")
  .option("--model <id>", `model id (${Object.keys(MODEL_CATALOG).join(", ")})`)
  .option("--quiet", "only report problems")
  .parse();
const opts = program.opts<{ model?: string; quiet?: boolean }>();
const cfg = loadConfig();
const id = opts.model ?? cfg.retrieval.semantic.model;

if (cfg.retrieval.semantic.provider === "none" || cfg.retrieval.semantic.provider === "lsa" || cfg.retrieval.semantic.provider === "ollama") {
  if (!opts.quiet) console.log(`Semantic provider is "${cfg.retrieval.semantic.provider}"; no model download needed.`);
  process.exit(0);
}
const existing = readModelManifest(cfg.retrieval.semantic.modelsDir, id);
if (existing) {
  if (!opts.quiet) console.log(`      Search model ${id} is installed (${existing.source}).`);
  process.exit(0);
}
console.log(`      Downloading the search model ${id} (one time, about 25-90 MB)...`);
try {
  const m = await ensureModel(cfg.retrieval.semantic.modelsDir, id, (s) => console.log(`      ${s.trim()}`));
  console.log(`      Search model installed from ${m.source}.`);
} catch (err) {
  // Not fatal: the app falls back to built-in LSA semantic search.
  console.log(`      Could not download the search model (${(err as Error).message}).`);
  console.log("      The app will use its built-in (simpler) semantic search instead. It retries next time.");
}
