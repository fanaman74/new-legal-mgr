import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { ingest } from "../src/ingestion/dispatcher.js";

const program = new Command()
  .name("ingest")
  .description("Ingest all files under the originals directory (read-only) into canonical evidence records.")
  .option("--originals <dir>", "originals directory (default: config / LEGAL_ORIGINALS_DIR)")
  .option("--data <dir>", "data directory for generated artefacts (default: config / LEGAL_DATA_DIR)")
  .option("--force", "re-parse documents even if an up-to-date canonical record exists")
  .option("--no-ocr", "disable OCR of scanned PDF pages")
  .option("--quiet", "only print the summary")
  .parse();

const opts = program.opts<{ originals?: string; data?: string; force?: boolean; ocr: boolean; quiet?: boolean }>();
const cfg = loadConfig({
  originalsDir: opts.originals,
  dataDir: opts.data,
  forceReparse: opts.force,
  ocrEnabled: opts.ocr === false ? false : undefined,
});

console.log(`Originals (read-only): ${cfg.originalsDir}`);
console.log(`Data directory:        ${cfg.dataDir}`);
console.log(`OCR:                   ${cfg.ocr.enabled ? `enabled (${cfg.ocr.langs})` : "disabled"}\n`);

const started = Date.now();
const summary = await ingest(cfg, { log: opts.quiet ? undefined : (line) => console.log(line) });
const { records: _records, missing_originals, ...counts } = summary;
console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(1)}s`);
console.table(counts);
if (missing_originals.length) {
  console.log("Registered original paths no longer present (renamed/moved/deleted copies):");
  for (const p of missing_originals) console.log(`  - ${p}`);
}
process.exitCode = summary.failed > 0 ? 2 : 0;
