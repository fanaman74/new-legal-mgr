import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { EvidenceRepository } from "../src/evidence/repository.js";
import { CorrectionStore, applyCorrections } from "../src/evidence/corrections.js";

const program = new Command()
  .name("corpus")
  .description("List ingested evidence: Evidence ID, filename, type, date, matter, parsing status.")
  .option("--data <dir>", "data directory")
  .option("--json", "print the effective (corrected) records as JSON")
  .option("--id <evidenceId>", "show a single record in full")
  .parse();

const opts = program.opts<{ data?: string; json?: boolean; id?: string }>();
const cfg = loadConfig({ dataDir: opts.data });
const repo = new EvidenceRepository(cfg);
const corrections = new CorrectionStore(cfg).all();
const records = repo.listCanonical().map((r) => applyCorrections(r, corrections));

if (opts.id) {
  const rec = records.find((r) => r.evidence_id === opts.id);
  if (!rec) {
    console.error(`Unknown Evidence ID ${opts.id}`);
    process.exit(1);
  }
  console.log(JSON.stringify({ ...rec, relationships: repo.loadRelationships().filter((x) => x.subject === opts.id || x.object === opts.id) }, null, 2));
} else if (opts.json) {
  console.log(JSON.stringify(records, null, 2));
} else {
  console.table(
    records.map((r) => ({
      id: r.evidence_id,
      filename: r.source.original_filename.length > 48 ? `${r.source.original_filename.slice(0, 45)}...` : r.source.original_filename,
      type: r.document.document_type,
      date: r.document.date ? `${r.document.date} (${r.document.date_confidence})` : "-",
      matter: r.document.matter.join(",") || "-",
      pages: r.provenance.page_count ?? "-",
      chunks: r.content.chunk_count,
      status: r.provenance.status + (r.provenance.ocr_pages.length ? " +OCR" : ""),
      parent: r.attachment_of.join(",") || "",
      corrected: r.corrections_applied.length || "",
    })),
  );
}
