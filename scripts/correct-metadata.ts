import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { EvidenceRepository } from "../src/evidence/repository.js";
import { CorrectionStore } from "../src/evidence/corrections.js";
import { CORRECTABLE_FIELDS } from "../src/evidence/models.js";

const program = new Command()
  .name("correct")
  .description(`Record a human correction of extracted metadata (the original file and the machine record are not modified).\nFields: ${CORRECTABLE_FIELDS.join(", ")}`)
  .requiredOption("--id <evidenceId>", "Evidence ID, e.g. EVID-000003")
  .requiredOption("--field <field>", "field to correct, e.g. document.date")
  .requiredOption("--value <value>", 'new value (lists: comma-separated; use "null" to clear)')
  .requiredOption("--reason <reason>", 'why, e.g. "date confirmed from page 1"')
  .option("--author <name>", "who made the correction")
  .option("--data <dir>", "data directory")
  .parse();

const opts = program.opts<{ id: string; field: string; value: string; reason: string; author?: string; data?: string }>();
const cfg = loadConfig({ dataDir: opts.data });
const record = new EvidenceRepository(cfg).loadCanonical(opts.id);
if (!record) {
  console.error(`Unknown Evidence ID ${opts.id}`);
  process.exit(1);
}
const correction = new CorrectionStore(cfg).add({
  record,
  field: opts.field,
  newValue: opts.value === "null" ? null : opts.value,
  reason: opts.reason,
  author: opts.author ?? null,
});
new AuditLog(cfg.auditLog).record({ action: "CORRECTION", evidence_id: correction.evidence_id, field: correction.field, correction_id: correction.correction_id });
console.log(JSON.stringify(correction, null, 2));
