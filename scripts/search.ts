import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { SearchService } from "../src/retrieval/search.js";

const list = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const program = new Command()
  .name("search")
  .description("Hybrid (lexical + semantic) search over the ingested evidence.")
  .argument("<query...>", "query text; use quotes inside for exact phrases")
  .option("--matter <list>", "comma-separated matters", list)
  .option("--type <list>", "comma-separated document types", list)
  .option("--from <date>", "document date from (YYYY-MM-DD)")
  .option("--to <date>", "document date to (YYYY-MM-DD)")
  .option("--author <list>", "comma-separated author substrings", list)
  .option("--top <n>", "number of results", "10")
  .option("--mode <mode>", "hybrid | lexical | semantic", "hybrid")
  .option("--data <dir>", "data directory")
  .option("--json", "print JSON")
  .parse();
const o = program.opts<{ matter?: string[]; type?: string[]; from?: string; to?: string; author?: string[]; top: string; mode: "hybrid" | "lexical" | "semantic"; data?: string; json?: boolean }>();
const cfg = loadConfig({ dataDir: o.data });
const res = await new SearchService(cfg).search({
  query: program.args.join(" "),
  matter: o.matter, document_type: o.type, date_from: o.from, date_to: o.to, author: o.author,
  top_k: Number(o.top), mode: o.mode,
});
if (o.json) console.log(JSON.stringify(res, null, 2));
else {
  console.log(`Semantic: ${res.semantic.note}. ${res.filtered_candidates} candidate chunks, ${res.took_ms} ms.\n`);
  res.results.forEach((r, i) => {
    const where = r.page !== null ? `p.${r.page}` : r.section_id;
    console.log(`${String(i + 1).padStart(2)}. [${r.evidence_id}, ${where}] ${r.filename}  score ${r.score} (${r.retrieval_method.join("+")})  ${r.chunk_id}`);
    console.log(`    ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
  });
}
