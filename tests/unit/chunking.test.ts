import { describe, expect, it } from "vitest";
import { chunkUnits } from "../../src/ingestion/chunking.js";
import { UnitBuilder, type ParsedUnit } from "../../src/ingestion/parsers/types.js";

const opts = { evidenceId: "EVID-000007", filename: "f.pdf", parser: "test", targetChars: 120, maxChars: 200 };

function page(n: number, blocks: { kind: "heading" | "paragraph"; text: string; level?: number }[]): ParsedUnit {
  const b = new UnitBuilder();
  blocks.forEach((x, i) => b.add({ id: `B${i}`, kind: x.kind, text: x.text, level: x.level ?? null }));
  return { page: n, text: b.text, blocks: b.blocks, ocr: false, ocr_confidence: null };
}

describe("structural chunking", () => {
  it("keeps exact offsets, page provenance and page-scoped chunk IDs", () => {
    const units = [
      page(1, [{ kind: "heading", text: "1. Facts", level: 2 }, { kind: "paragraph", text: "Alpha." }, { kind: "paragraph", text: "Beta." }]),
      page(2, [{ kind: "paragraph", text: "Gamma continues the facts." }, { kind: "heading", text: "2. Law", level: 2 }, { kind: "paragraph", text: "Delta." }]),
    ];
    const chunks = chunkUnits(units, opts);
    expect(chunks.map((c) => c.chunk_id)).toEqual(["EVID-000007-P001-C01", "EVID-000007-P002-C01", "EVID-000007-P002-C02"]);
    for (const c of chunks) {
      const unit = units.find((u) => u.page === c.page)!;
      expect(unit.text.slice(c.char_start, c.char_end)).toBe(c.text);
    }
    // Headings carry across a page boundary, and a new heading starts a new chunk.
    expect(chunks[1]).toMatchObject({ page: 2, heading: "1. Facts", text: "Gamma continues the facts." });
    expect(chunks[2]).toMatchObject({ heading: "2. Law", text: "2. Law\n\nDelta." });
  });

  it("splits oversized paragraphs at sentence boundaries without losing text", () => {
    const long = Array.from({ length: 30 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const unit = page(1, [{ kind: "paragraph", text: long }]);
    const chunks = chunkUnits([unit], opts);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(opts.maxChars);
      expect(unit.text.slice(c.char_start, c.char_end)).toBe(c.text);
    }
    expect(chunks.map((c) => c.text).join(" ")).toBe(long);
  });

  it("uses section IDs and no page numbers for non-paginated documents", () => {
    const b = new UnitBuilder();
    b.add({ id: "P0001", kind: "paragraph", text: "Preamble.", section_id: "S000" });
    b.add({ id: "P0002", kind: "heading", text: "Reasons", level: 1, section_id: "S001" });
    b.add({ id: "P0003", kind: "paragraph", text: "Because.", section_id: "S001" });
    const chunks = chunkUnits([{ page: null, text: b.text, blocks: b.blocks, ocr: false, ocr_confidence: null }], opts);
    expect(chunks.map((c) => [c.chunk_id, c.page, c.section_id, c.paragraph_ids])).toEqual([
      ["EVID-000007-S000-C01", null, "S000", ["P0001"]],
      ["EVID-000007-S001-C01", null, "S001", ["P0002", "P0003"]],
    ]);
  });
});
