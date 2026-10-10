import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { SearchService } from "../src/retrieval/search.js";
import { answerQuestion } from "../src/analysis/answer.js";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const program = new Command()
  .name("ask")
  .description("Ask a question; the answer is grounded in cited, verified evidence (or refused).")
  .argument("<question...>")
  .option("--matter <list>", "comma-separated matters", list)
  .option("--extractive", "do not use an LLM even if configured")
  .option("--data <dir>", "data directory")
  .option("--json", "print JSON")
  .parse();
const o = program.opts<{ matter?: string[]; extractive?: boolean; data?: string; json?: boolean }>();
const cfg = loadConfig({ dataDir: o.data });
const a = await answerQuestion(cfg, new SearchService(cfg), program.args.join(" "), { matter: o.matter, extractive_only: o.extractive });
console.log(o.json ? JSON.stringify(a, null, 2) : `${a.formatted}\n${a.notes.length ? `\nNotes: ${a.notes.join("; ")}` : ""}`);
