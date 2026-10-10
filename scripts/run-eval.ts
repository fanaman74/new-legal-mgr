import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { renderReportMarkdown, runEvaluation, writeResultsDoc } from "../src/evaluation/runner.js";

const program = new Command()
  .name("eval")
  .description("Run the gold evaluation set and report retrieval/provenance metrics.")
  .option("--corpus <name>", "sample (isolated fictional corpus, default) | current (the configured corpus)", "sample")
  .option("--gold <file>", "gold cases YAML (default: tests/eval/gold_cases.yaml)")
  .option("--fresh", "rebuild the sample evaluation workspace from scratch")
  .option("--write-docs", "update the generated results block in docs/poc-results.md")
  .option("--quiet", "only print the summary")
  .parse();
const o = program.opts<{ corpus: "sample" | "current"; gold?: string; fresh?: boolean; writeDocs?: boolean; quiet?: boolean }>();
const report = await runEvaluation(loadConfig(), { corpus: o.corpus, goldFile: o.gold, fresh: o.fresh, log: o.quiet ? undefined : (s) => console.log(s) });
console.log(`\n${renderReportMarkdown(report)}`);
if (o.writeDocs) {
  writeResultsDoc(report);
  console.log("\ndocs/poc-results.md updated.");
}
process.exitCode = report.cases.every((c) => c.passed) ? 0 : 1;
