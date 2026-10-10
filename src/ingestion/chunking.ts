import type { Chunk } from "../evidence/models.js";
import type { ParsedBlock, ParsedUnit } from "./parsers/types.js";

/**
 * Structural chunking.
 *
 * - A chunk never crosses a unit boundary (a PDF page, or a whole non-paginated document).
 * - A heading always starts a new chunk; the heading line is kept at the top of that chunk.
 * - Paragraphs within a section are merged until `targetChars`; a single block longer than
 *   `maxChars` is split at sentence boundaries.
 * - chunk.text is always exactly unit.text.slice(char_start, char_end).
 *
 * Chunk IDs:
 *   PDF:            EVID-000143-P007-C03   (page 7, 3rd chunk on that page)
 *   DOCX / text:    EVID-000143-S004-C02   (section 4, 2nd chunk in that section)
 *   email:          EVID-000143-HDR-C01, EVID-000143-BODY-C02
 */

export interface ChunkOptions {
  evidenceId: string;
  filename: string;
  parser: string;
  targetChars: number;
  maxChars: number;
}

interface Span {
  start: number;
  end: number;
  blocks: ParsedBlock[];
}

function splitLong(unitText: string, block: ParsedBlock, maxChars: number): Span[] {
  const spans: Span[] = [];
  let start = block.char_start;
  while (block.char_end - start > maxChars) {
    const window = unitText.slice(start, start + maxChars);
    // Prefer a sentence end, then a line break, then a space.
    let cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("; "));
    if (cut < maxChars * 0.4) cut = window.lastIndexOf("\n");
    if (cut < maxChars * 0.4) cut = window.lastIndexOf(" ");
    if (cut <= 0) cut = maxChars - 1;
    const end = start + cut + 1;
    spans.push({ start, end, blocks: [block] });
    start = end;
    while (start < block.char_end && /\s/.test(unitText[start]!)) start++;
  }
  if (start < block.char_end) spans.push({ start, end: block.char_end, blocks: [block] });
  return spans;
}

export function chunkUnits(units: ParsedUnit[], opts: ChunkOptions): Chunk[] {
  const chunks: Chunk[] = [];
  let headingPath: { level: number; text: string }[] = [];

  for (const unit of units) {
    const counters = new Map<string, number>();
    let current: Span | null = null;
    let currentSection: string | null = null;
    let currentHeadingPath: string[] = headingPath.map((h) => h.text);

    const flush = (): void => {
      if (!current) return;
      const key = unit.page !== null ? `P${String(unit.page).padStart(3, "0")}` : currentSection ?? "S000";
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      chunks.push({
        chunk_id: `${opts.evidenceId}-${key}-C${String(n).padStart(2, "0")}`,
        evidence_id: opts.evidenceId,
        filename: opts.filename,
        page: unit.page,
        section_id: unit.page !== null ? null : currentSection,
        paragraph_ids: [...new Set(current.blocks.map((b) => b.id))],
        heading: currentHeadingPath.at(-1) ?? null,
        heading_path: currentHeadingPath,
        text: unit.text.slice(current.start, current.end),
        char_start: current.start,
        char_end: current.end,
        parser: opts.parser,
        ocr: unit.ocr,
        ocr_confidence: unit.ocr_confidence,
      });
      current = null;
    };

    for (const block of unit.blocks) {
      const sectionChanged = block.section_id !== currentSection;
      if (block.kind === "heading" || sectionChanged) {
        flush();
        currentSection = block.section_id;
      }
      if (block.kind === "heading") {
        const level = block.level ?? 1;
        headingPath = headingPath.filter((h) => h.level < level);
        headingPath.push({ level, text: unit.text.slice(block.char_start, block.char_end).replace(/\s+/g, " ").trim() });
        currentHeadingPath = headingPath.map((h) => h.text);
        current = { start: block.char_start, end: block.char_end, blocks: [block] };
        continue;
      }
      if (block.kind === "email_header") headingPath = [];

      const length = block.char_end - block.char_start;
      if (length > opts.maxChars) {
        flush();
        for (const span of splitLong(unit.text, block, opts.maxChars)) {
          current = span;
          flush();
        }
        continue;
      }
      if (current) {
        const isHeadingOnly = current.blocks.every((b) => b.kind === "heading");
        if (!isHeadingOnly && block.char_end - current.start > opts.targetChars) flush();
      }
      if (current) {
        current.end = block.char_end;
        current.blocks.push(block);
      } else {
        current = { start: block.char_start, end: block.char_end, blocks: [block] };
      }
    }
    flush();
  }
  return chunks;
}
