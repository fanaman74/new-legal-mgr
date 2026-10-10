import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EvidenceRegistry, formatEvidenceId } from "../../src/evidence/ids.js";

const sha = (c: string) => c.repeat(64);

describe("Evidence ID registry", () => {
  it("formats IDs as EVID-NNNNNN", () => {
    expect(formatEvidenceId(1)).toBe("EVID-000001");
    expect(formatEvidenceId(143)).toBe("EVID-000143");
    expect(() => formatEvidenceId(0)).toThrow();
    expect(() => formatEvidenceId(1_000_000)).toThrow();
  });

  it("allocates sequential IDs by content, not by filename", () => {
    const reg = EvidenceRegistry.load(mkdtempSync(path.join(tmpdir(), "reg-")));
    const a = reg.register({ sha256: sha("a"), sizeBytes: 1, sourceRoot: "originals", relativePath: "x/decision.pdf" });
    const b = reg.register({ sha256: sha("b"), sizeBytes: 1, sourceRoot: "originals", relativePath: "x/decision.pdf" });
    expect(a.entry.evidence_id).toBe("EVID-000001");
    expect(b.entry.evidence_id).toBe("EVID-000002");
    expect(a.created && b.created).toBe(true);
  });

  it("detects duplicates and renamed copies as the same evidential object", () => {
    const reg = EvidenceRegistry.load(mkdtempSync(path.join(tmpdir(), "reg-")));
    const first = reg.register({ sha256: sha("c"), sizeBytes: 5, sourceRoot: "originals", relativePath: "a.pdf" });
    const again = reg.register({ sha256: sha("c"), sizeBytes: 5, sourceRoot: "originals", relativePath: "a.pdf" });
    const renamed = reg.register({ sha256: sha("c"), sizeBytes: 5, sourceRoot: "originals", relativePath: "renamed.pdf" });
    const attached = reg.register({ sha256: sha("c"), sizeBytes: 5, sourceRoot: "attachments", relativePath: "EVID-000009/01_a.pdf", parent: "EVID-000009" });
    expect(again).toMatchObject({ created: false, duplicateOfExisting: false, newPath: false });
    expect(renamed).toMatchObject({ created: false, duplicateOfExisting: true });
    expect(attached.entry.evidence_id).toBe(first.entry.evidence_id);
    expect(attached.entry.paths.map((p) => p.relative_path)).toEqual(["a.pdf", "renamed.pdf", "EVID-000009/01_a.pdf"]);
    expect(attached.entry.parents).toEqual(["EVID-000009"]);
    expect(reg.all()).toHaveLength(1);
  });

  it("persists and never reuses IDs across reloads", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reg-"));
    const reg = EvidenceRegistry.load(dir);
    reg.register({ sha256: sha("d"), sizeBytes: 1, sourceRoot: "originals", relativePath: "d" });
    reg.register({ sha256: sha("e"), sizeBytes: 1, sourceRoot: "originals", relativePath: "e" });
    reg.save();
    const reloaded = EvidenceRegistry.load(dir);
    expect(reloaded.findBySha(sha("e"))?.evidence_id).toBe("EVID-000002");
    expect(reloaded.register({ sha256: sha("f"), sizeBytes: 1, sourceRoot: "originals", relativePath: "f" }).entry.evidence_id).toBe("EVID-000003");
  });
});
