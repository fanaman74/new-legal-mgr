import { existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppConfig } from "../config.js";
import { safeAppendLine } from "../util/fs-guard.js";
import { readJsonl } from "./repository.js";
import { Correction, CorrectableField, type CanonicalEvidence } from "./models.js";

/**
 * Human corrections of machine-extracted metadata.
 *
 * Corrections are stored append-only in data/corrections/corrections.jsonl, separately from the
 * machine-derived canonical records (which are never edited by a correction). The "effective"
 * view of a record applies the latest correction per field on top of the canonical record.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface EffectiveEvidence extends CanonicalEvidence {
  corrections_applied: { field: string; correction_id: string; machine_value: unknown; timestamp: string }[];
}

export class CorrectionStore {
  private readonly file: string;

  constructor(cfg: AppConfig) {
    this.file = path.join(cfg.correctionsDir, "corrections.jsonl");
  }

  all(): Correction[] {
    return existsSync(this.file) ? readJsonl(this.file).map((r) => Correction.parse(r)) : [];
  }

  forEvidence(evidenceId: string): Correction[] {
    return this.all().filter((c) => c.evidence_id === evidenceId);
  }

  add(args: {
    record: CanonicalEvidence;
    field: string;
    newValue: unknown;
    reason: string;
    author?: string | null;
  }): Correction {
    const field = CorrectableField.parse(args.field);
    const newValue = normaliseValue(field, args.newValue);
    const current = getField(applyCorrections(args.record, this.forEvidence(args.record.evidence_id)), field);
    const correction = Correction.parse({
      correction_id: randomUUID(),
      evidence_id: args.record.evidence_id,
      field,
      old_value: current ?? null,
      new_value: newValue,
      reason: args.reason,
      source: "human",
      author: args.author ?? null,
      timestamp: new Date().toISOString(),
    });
    safeAppendLine(this.file, JSON.stringify(correction));
    return correction;
  }
}

function normaliseValue(field: CorrectableField, value: unknown): unknown {
  const listFields: CorrectableField[] = ["document.matter", "document.author", "document.recipients", "classification.tags"];
  if (listFields.includes(field)) {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === "string") return value.split(",").map((s) => s.trim()).filter(Boolean);
    throw new Error(`${field} expects a list of strings`);
  }
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`${field} expects a string`);
  if (field === "document.date" && !ISO_DATE.test(value)) throw new Error("document.date must be YYYY-MM-DD");
  if (field === "classification.privilege" && !["unknown", "privileged", "not_privileged"].includes(value)) {
    throw new Error("classification.privilege must be unknown | privileged | not_privileged");
  }
  if (field === "classification.source_type" && !["primary", "secondary", "unknown"].includes(value)) {
    throw new Error("classification.source_type must be primary | secondary | unknown");
  }
  return value;
}

function getField(record: CanonicalEvidence, field: string): unknown {
  const [group, key] = field.split(".") as [string, string];
  return (record as unknown as Record<string, Record<string, unknown>>)[group]?.[key];
}

/** Return a copy of the record with corrections applied (latest wins per field). */
export function applyCorrections(record: CanonicalEvidence, corrections: Correction[]): EffectiveEvidence {
  const out = structuredClone(record) as EffectiveEvidence;
  out.corrections_applied = [];
  const ordered = [...corrections]
    .filter((c) => c.evidence_id === record.evidence_id)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  for (const c of ordered) {
    const [group, key] = c.field.split(".") as [string, string];
    const target = (out as unknown as Record<string, Record<string, unknown>>)[group]!;
    out.corrections_applied = out.corrections_applied.filter((a) => a.field !== c.field);
    out.corrections_applied.push({
      field: c.field,
      correction_id: c.correction_id,
      machine_value: getField(record, c.field) ?? null,
      timestamp: c.timestamp,
    });
    target[key] = c.new_value;
    if (c.field === "document.date") {
      out.document.date_confidence = c.new_value === null ? null : "high";
      out.document.date_basis = `human correction: ${c.reason}`;
    }
    if (c.field === "document.document_type") {
      out.document.document_type_confidence = "high";
      out.document.document_type_basis = `human correction: ${c.reason}`;
    }
  }
  return out;
}
