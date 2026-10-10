import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CorrectionStore, applyCorrections } from "../../src/evidence/corrections.js";
import { EvidenceRepository } from "../../src/evidence/repository.js";
import type { CanonicalEvidence } from "../../src/evidence/models.js";
import { makeWorkspace } from "../helpers.js";

function record(): CanonicalEvidence {
  return {
    schema_version: 1,
    evidence_id: "EVID-000043",
    source: { original_filename: "a.pdf", source_root: "originals", relative_path: "a.pdf", alias_paths: [], sha256: "0".repeat(64), mime_type: "application/pdf", size_bytes: 1 },
    document: {
      title: null, title_source: null, document_type: "unknown", document_type_confidence: null, document_type_basis: null,
      matter: [], matter_basis: [], date: "2025-01-16", date_confidence: "low", date_basis: "first date", date_candidates: [],
      author: [], recipients: [], language: null,
    },
    provenance: { parser: "pdf-text", parser_version: "x", ingestion_timestamp: "2025-01-01T00:00:00Z", page_count: 1, ocr_pages: [], status: "parsed", warnings: [], error: null, embedded_metadata: {} },
    content: { markdown_path: null, structured_json_path: null, chunks_path: null, chunk_count: 0, char_count: 0 },
    email: null, attachments: [], attachment_of: [],
    classification: { tags: [], privilege: "unknown", source_type: "unknown", confidence: null },
  };
}

describe("human corrections", () => {
  it("override machine metadata in the effective view without touching the canonical record", () => {
    const { cfg } = makeWorkspace();
    const repo = new EvidenceRepository(cfg);
    const rec = record();
    repo.saveCanonical(rec);
    const before = readFileSync(repo.canonicalPath(rec.evidence_id), "utf8");
    const store = new CorrectionStore(cfg);

    const c = store.add({ record: rec, field: "document.date", newValue: "2025-01-17", reason: "date confirmed from page 1", author: "reviewer" });
    expect(c).toMatchObject({ old_value: "2025-01-16", new_value: "2025-01-17", source: "human" });
    store.add({ record: rec, field: "document.matter", newValue: "article24, article90", reason: "both procedures" });

    const effective = applyCorrections(repo.loadCanonical(rec.evidence_id)!, store.all());
    expect(effective.document.date).toBe("2025-01-17");
    expect(effective.document.date_confidence).toBe("high");
    expect(effective.document.matter).toEqual(["article24", "article90"]);
    expect(effective.corrections_applied.map((a) => [a.field, a.machine_value])).toEqual([
      ["document.date", "2025-01-16"],
      ["document.matter", []],
    ]);
    expect(readFileSync(repo.canonicalPath(rec.evidence_id), "utf8")).toBe(before);
  });

  it("records the previous effective value and lets the latest correction win", () => {
    const { cfg } = makeWorkspace();
    const store = new CorrectionStore(cfg);
    const rec = record();
    store.add({ record: rec, field: "document.document_type", newValue: "official_decision", reason: "letterhead" });
    const second = store.add({ record: rec, field: "document.document_type", newValue: "acknowledgement", reason: "re-read" });
    expect(second.old_value).toBe("official_decision");
    expect(applyCorrections(rec, store.all()).document.document_type).toBe("acknowledgement");
  });

  it("validates fields and values", () => {
    const { cfg } = makeWorkspace();
    const store = new CorrectionStore(cfg);
    expect(() => store.add({ record: record(), field: "source.sha256", newValue: "x", reason: "no" })).toThrow();
    expect(() => store.add({ record: record(), field: "document.date", newValue: "17/01/2025", reason: "bad format" })).toThrow(/YYYY-MM-DD/);
    expect(() => store.add({ record: record(), field: "document.title", newValue: "x", reason: "" })).toThrow();
  });
});
