import { chmodSync, cpSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";
import { REPO_ROOT } from "../../src/config.js";
import { buildManifest, compareManifests, listFiles } from "../../src/ingestion/hashing.js";
import { ingest, type IngestSummary } from "../../src/ingestion/dispatcher.js";
import { EvidenceRepository, readJsonl } from "../../src/evidence/repository.js";
import { EvidenceRegistry } from "../../src/evidence/ids.js";
import { resetProtectedDirectories } from "../../src/util/fs-guard.js";
import { generateSampleCorpus } from "../../src/testing/sample-corpus.js";
import { makeWorkspace, type Workspace } from "../helpers.js";

/**
 * End-to-end Milestone 1 tests on the synthetic sample corpus, plus two deliberately corrupt
 * files. The originals are made read-only before ingestion.
 */

let ws: Workspace;
let summary: IngestSummary;
let repo: EvidenceRepository;
let manifestBefore: Awaited<ReturnType<typeof buildManifest>>;

const byPath = (rel: string) => repo.listCanonical().find((r) => r.source.relative_path === rel || r.source.alias_paths.some((a) => a.relative_path === rel))!;

function setReadOnly(dir: string): void {
  for (const f of listFiles(dir)) chmodSync(f, 0o444);
}

beforeAll(async () => {
  resetProtectedDirectories();
  ws = makeWorkspace();
  await generateSampleCorpus(ws.originals);
  writeFileSync(path.join(ws.originals, "misc", "corrupt.pdf"), "%PDF-1.4\nthis is not really a pdf");
  writeFileSync(path.join(ws.originals, "misc", "corrupt.msg"), Buffer.from("d0cf11e0a1b11ae1000000000000", "hex"));
  writeFileSync(path.join(ws.originals, "misc", ".DS_Store"), "junk");
  setReadOnly(ws.originals);
  manifestBefore = await buildManifest(ws.originals);
  summary = await ingest(ws.cfg);
  repo = new EvidenceRepository(ws.cfg);
}, 300_000);

describe("immutable originals", () => {
  it("does not change any original's name, size, modification time or SHA-256", async () => {
    const diff = compareManifests(manifestBefore, await buildManifest(ws.originals));
    expect(diff).toMatchObject({ ok: true, missing: [], added: [], modified: [] });
    expect(diff.unchanged).toHaveLength(manifestBefore.file_count);
  });

  it("writes nothing inside the originals directory", () => {
    expect(listFiles(ws.originals).map((f) => path.relative(ws.originals, f)).sort()).toEqual(manifestBefore.files.map((f) => f.relative_path.split("/").join(path.sep)).sort());
  });

  it("check-originals CLI creates and verifies a manifest", () => {
    const tsx = path.join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const run = (mode: string) =>
      execFileSync(process.execPath, [tsx, path.join(REPO_ROOT, "scripts", "check-originals.ts"), mode, "--originals", ws.originals, "--data", ws.cfg.dataDir], {
        env: { ...process.env, LEGAL_AUDIT_LOG: ws.cfg.auditLog },
        encoding: "utf8",
      });
    expect(run("create")).toMatch(/Manifest of \d+ file\(s\)/);
    expect(run("verify")).toMatch(/OK: original evidence is unchanged/);
  });
});

describe("ingestion results", () => {
  it("continues past failures and records them", () => {
    expect(summary.failed).toBe(2);
    for (const rel of ["misc/corrupt.pdf", "misc/corrupt.msg"]) {
      const rec = byPath(rel);
      expect(rec.provenance.status).toBe("failed");
      expect(rec.provenance.error).toBeTruthy();
      expect(rec.content.chunk_count).toBe(0);
    }
    const statuses = repo.loadStatuses();
    expect(statuses.filter((s) => s.status === "failed").map((s) => s.relative_path).sort()).toEqual(["misc/corrupt.msg", "misc/corrupt.pdf"]);
    expect(statuses.find((s) => s.relative_path === "misc/.DS_Store")?.status).toBe("skipped");
    expect(summary.parsed).toBeGreaterThanOrEqual(13);
  });

  it("stores SHA-256 and stable Evidence IDs for every object", () => {
    const records = repo.listCanonical();
    for (const r of records) {
      expect(r.evidence_id).toMatch(/^EVID-\d{6}$/);
      expect(r.source.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    const registry = EvidenceRegistry.load(ws.cfg.indexesDir);
    expect(registry.all().map((e) => e.evidence_id)).toEqual(records.map((r) => r.evidence_id));
  });

  it("detects byte-identical duplicates, including an email attachment copy", () => {
    const original = byPath("article24/2025-01-17_request_for_assistance_article24.pdf");
    expect(byPath("article24/copy_of_request_for_assistance.pdf").evidence_id).toBe(original.evidence_id);
    const email = byPath("emails/2025-01-17_submission_of_request.msg");
    const attachmentRef = email.attachments.find((a) => a.filename === "Request_for_assistance_Article24.pdf")!;
    expect(attachmentRef.evidence_id).toBe(original.evidence_id);
    expect(original.attachment_of).toEqual([email.evidence_id]);
    expect(original.source.alias_paths.map((a) => a.relative_path)).toEqual([
      "article24/copy_of_request_for_assistance.pdf",
      `${email.evidence_id}/01_Request_for_assistance_Article24.pdf`,
    ]);
  });

  it("preserves .msg metadata and links attachments to the parent", () => {
    const email = byPath("emails/2025-01-17_submission_of_request.msg");
    expect(email.document).toMatchObject({ document_type: "email", date: "2025-01-17", date_confidence: "high", author: ["Jane Doe <jane.doe@example.org>"] });
    expect(email.email).toMatchObject({ message_id: "<20250117164200.jd01@example.org>", subject: "Request for assistance under Article 24 - J. Doe" });
    const annexB = repo.loadCanonical(email.attachments[1]!.evidence_id!)!;
    expect(annexB.source).toMatchObject({ source_root: "attachments", original_filename: "Annex_B_witness_statement_Rossi.docx" });
    expect(annexB.attachment_of).toEqual([email.evidence_id]);
    expect(annexB.document.matter).toContain("article24");
    expect(repo.loadRelationships()).toContainEqual(expect.objectContaining({ subject: annexB.evidence_id, predicate: "attachment_of", object: email.evidence_id }));
    // Extracted copies are stored outside the originals directory.
    expect(existsSync(path.join(ws.cfg.attachmentsDir, email.evidence_id, "02_Annex_B_witness_statement_Rossi.docx"))).toBe(true);
  });

  it("ingests embedded .msg messages as their own evidence, recursively", () => {
    const fwd = byPath("emails/2025-03-20_fwd_hr_position_on_audit.msg");
    const embedded = repo.loadCanonical(fwd.attachments[0]!.evidence_id!)!;
    expect(fwd.attachments[0]!.kind).toBe("embedded_message");
    expect(embedded.email).toMatchObject({ subject: "Audit report - attribution", sent_at: "2024-10-02T08:30:00.000Z" });
    expect(embedded.attachment_of).toEqual([fwd.evidence_id]);
  });

  it("ingests .eml files and their attachments", () => {
    const eml = byPath("emails/2025-02-10_reply_from_hr.eml");
    expect(eml.email).toMatchObject({ format: "eml", in_reply_to: "<20250117164200.jd01@example.org>" });
    expect(eml.document.date).toBe("2025-02-10");
    const note = repo.loadCanonical(eml.attachments[0]!.evidence_id!)!;
    expect(note.source.mime_type).toBe("application/pdf");
    expect(note.provenance.page_count).toBe(1);
    expect(note.attachment_of).toEqual([eml.evidence_id]);
  });

  it("gives every PDF chunk a page number and never invents pages for other formats", () => {
    for (const r of repo.listCanonical()) {
      for (const c of repo.loadChunks(r.evidence_id)) {
        if (r.source.mime_type === "application/pdf") {
          expect(c.page).toBeGreaterThanOrEqual(1);
          expect(c.page).toBeLessThanOrEqual(r.provenance.page_count!);
          expect(c.chunk_id).toMatch(new RegExp(`^${r.evidence_id}-P\\d{3}-C\\d{2}$`));
        } else {
          expect(c.page).toBeNull();
          expect(c.section_id).toBeTruthy();
        }
      }
    }
  });

  it("chunk offsets point exactly into the stored page/unit text", () => {
    for (const r of repo.listCanonical().filter((x) => x.content.structured_json_path)) {
      const structure = JSON.parse(readFileSync(path.join(ws.cfg.dataDir, r.content.structured_json_path!), "utf8")) as { units: { page: number | null; text: string }[] };
      for (const c of repo.loadChunks(r.evidence_id)) {
        const unit = c.page !== null ? structure.units.find((u) => u.page === c.page)! : structure.units[0]!;
        expect(unit.text.slice(c.char_start, c.char_end)).toBe(c.text);
      }
    }
  });

  it("finds facts on the right page, including OCR'd scanned pages", () => {
    const decision = byPath("article24/2025-05-12_decision_on_request_for_assistance.pdf");
    const chunks = repo.loadChunks(decision.evidence_id);
    expect(chunks.find((c) => c.text.includes("HAS DECIDED"))?.page).toBe(2);
    expect(decision.document).toMatchObject({ date: "2025-05-12", document_type: "official_decision" });

    const scan = byPath("article24/annex_A_medical_certificate_scanned.pdf");
    expect(scan.provenance.ocr_pages).toEqual([1]);
    const ocrChunk = repo.loadChunks(scan.evidence_id).find((c) => /unfit for work/i.test(c.text));
    expect(ocrChunk).toMatchObject({ page: 1, ocr: true });
  });

  it("registers unsupported formats with a hash instead of dropping them", () => {
    const logo = byPath("misc/agency_logo.png");
    expect(logo.provenance.status).toBe("unsupported");
    expect(logo.source.mime_type).toBe("image/png");
  });

  it("keeps document content out of the audit log", () => {
    const audit = readFileSync(ws.cfg.auditLog, "utf8");
    expect(readJsonl(ws.cfg.auditLog).length).toBeGreaterThan(10);
    for (const secret of ["unfit for work", "HAS DECIDED", "shouted at Ms Doe", "Dear colleagues"]) expect(audit).not.toContain(secret);
  });
});

describe("re-ingestion", () => {
  it("is idempotent: no new IDs, nothing re-parsed", async () => {
    const before = repo.listCanonical().map((r) => r.evidence_id);
    const again = await ingest(ws.cfg);
    expect(again.new_evidence).toBe(0);
    expect(again.parsed).toBe(0);
    expect(repo.listCanonical().map((r) => r.evidence_id)).toEqual(before);
  });

  it("treats a renamed copy as the same evidential object", async () => {
    // Rename in a writable copy of the corpus (the test, not the application, renames).
    const copy = makeWorkspace();
    cpSync(ws.originals, copy.originals, { recursive: true });
    cpSync(ws.cfg.dataDir, copy.cfg.dataDir, { recursive: true });
    for (const f of listFiles(copy.originals)) chmodSync(f, 0o644);
    renameSync(path.join(copy.originals, "audit", "IAS_audit_report_2024-07.pdf"), path.join(copy.originals, "audit", "renamed_report.pdf"));
    const countBefore = new EvidenceRepository(copy.cfg).listCanonical().length;

    const result = await ingest(copy.cfg);
    const copyRepo = new EvidenceRepository(copy.cfg);
    expect(result.new_evidence).toBe(0);
    expect(copyRepo.listCanonical()).toHaveLength(countBefore);
    const rec = copyRepo.listCanonical().find((r) => r.source.relative_path === "audit/IAS_audit_report_2024-07.pdf")!;
    expect(rec.source.alias_paths.map((a) => a.relative_path)).toContain("audit/renamed_report.pdf");
    expect(result.missing_originals).toContain("audit/IAS_audit_report_2024-07.pdf");
    expect(statSync(path.join(copy.originals, "audit", "renamed_report.pdf")).size).toBe(rec.source.size_bytes);

    // A forced re-parse must work although the registry's primary path no longer exists.
    const forced = await ingest({ ...copy.cfg, ingestion: { ...copy.cfg.ingestion, forceReparse: true } });
    expect(forced.failed).toBe(2); // only the two deliberately corrupt files
    const reparsed = copyRepo.loadCanonical(rec.evidence_id)!;
    expect(reparsed.provenance.status).toBe("parsed");
    expect(reparsed.source.relative_path).toBe("audit/renamed_report.pdf");
  });
});
