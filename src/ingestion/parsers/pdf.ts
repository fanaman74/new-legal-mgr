import path from "node:path";
import { REPO_ROOT } from "../../config.js";
import { packageVersion } from "../../util/versions.js";
import { headingLevelForLine } from "./headings.js";
import { OcrEngine } from "./ocr.js";
import { emptyOutput, UnitBuilder, type ParseOutput, type ParserContext, type ParsedUnit } from "./types.js";
import { usableEmbeddedTitle } from "../metadata.js";

/**
 * PDF parser.
 *
 * - Text-layer pages: pdfjs-dist text items are assembled into lines, lines into paragraphs
 *   (by vertical gap) and headings (by font size or numbering/capitals heuristics).
 * - Pages with (almost) no text layer are treated as scanned: rendered with @napi-rs/canvas and
 *   OCR'd locally with tesseract.js. OCR-derived chunks are flagged with their confidence.
 * - Page numbers are the physical 1-based page index in the file (not printed page labels).
 */

interface TextItem {
  str: string;
  hasEOL: boolean;
  height: number;
  width: number;
  transform: number[];
}

interface Line {
  text: string;
  y: number;
  size: number;
}

const PDFJS_DIR = path.join(REPO_ROOT, "node_modules", "pdfjs-dist");

async function loadPdfjs() {
  return import("pdfjs-dist/legacy/build/pdf.mjs");
}

function buildLines(items: TextItem[]): Line[] {
  const lines: Line[] = [];
  let text = "";
  let y: number | null = null;
  let size = 0;
  let lastXEnd: number | null = null;
  const push = () => {
    if (text.trim()) lines.push({ text: text.replace(/\s+$/u, ""), y: y ?? 0, size });
    text = "";
    y = null;
    size = 0;
    lastXEnd = null;
  };
  for (const it of items) {
    const itemY = it.transform[5] ?? 0;
    const itemX = it.transform[4] ?? 0;
    const itemSize = Math.abs(it.transform[3] ?? it.height) || it.height;
    if (y !== null && it.str && Math.abs(itemY - y) > Math.max(2, 0.5 * Math.max(size, itemSize))) push();
    if (it.str) {
      if (y === null) y = itemY;
      if (lastXEnd !== null && itemX - lastXEnd > itemSize * 0.15 && !/\s$/.test(text) && !/^\s/.test(it.str)) text += " ";
      text += it.str;
      size = Math.max(size, itemSize);
      lastXEnd = itemX + it.width;
    }
    if (it.hasEOL) push();
  }
  push();
  return lines;
}

/** Group lines into blocks and append them to a unit builder. */
function addLinesAsBlocks(builder: UnitBuilder, lines: Line[], bodySize: number, page: number): void {
  let para: Line[] = [];
  let blockNo = 0;
  const id = () => `P${String(page).padStart(3, "0")}-B${String(++blockNo).padStart(3, "0")}`;
  const flushPara = () => {
    if (!para.length) return;
    const text = para.map((l) => l.text).join("\n");
    const level = para.length === 1 ? headingLevelForLine(text) : null;
    builder.add({ id: id(), kind: level ? "heading" : "paragraph", text, level });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const prev = lines[i - 1];
    const big = bodySize > 0 && line.size >= bodySize * 1.2 && line.text.length <= 150;
    if (big) {
      flushPara();
      const level = line.size >= bodySize * 1.5 ? 1 : 2;
      builder.add({ id: id(), kind: "heading", text: line.text, level });
      continue;
    }
    if (prev && para.length) {
      const gap = prev.y - line.y;
      const lineHeight = Math.max(prev.size, line.size) * 1.2;
      if (gap > lineHeight * 1.35 || gap < 0 || Math.abs(prev.size - line.size) > 1) flushPara();
    }
    para.push(line);
  }
  flushPara();
}

/** Split OCR text into paragraphs (blank-line separated) and headings. */
function addOcrTextAsBlocks(builder: UnitBuilder, text: string, page: number): void {
  let blockNo = 0;
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.split("\n").map((l) => l.trimEnd()).filter((l) => l.trim()).join("\n");
    if (!para) continue;
    const level = !para.includes("\n") ? headingLevelForLine(para) : null;
    builder.add({ id: `P${String(page).padStart(3, "0")}-B${String(++blockNo).padStart(3, "0")}`, kind: level ? "heading" : "paragraph", text: para, level });
  }
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
}

export async function parsePdf(data: Uint8Array, ctx: ParserContext, ocr: OcrEngine | null): Promise<ParseOutput> {
  const pdfjs = await loadPdfjs();
  const out = emptyOutput("pdf-text", `pdfjs-dist@${packageVersion("pdfjs-dist")}`);
  // pdfjs may transfer/detach the buffer: always pass a private copy.
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    cMapUrl: `${path.join(PDFJS_DIR, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(PDFJS_DIR, "standard_fonts")}/`,
  });
  const doc = await loadingTask.promise;

  try {
    out.pageCount = doc.numPages;
    const meta = await doc.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    for (const key of ["Title", "Author", "Subject", "Creator", "Producer", "CreationDate", "ModDate"]) {
      const v = info[key];
      out.embeddedMetadata[`pdf.${key}`] = typeof v === "string" && v.trim() ? v.trim() : null;
    }
    const embeddedTitle = usableEmbeddedTitle(out.embeddedMetadata["pdf.Title"]);
    if (embeddedTitle) out.title = { value: embeddedTitle, source: "pdf_metadata" };

    // First pass: text layers, and the body font size across the document.
    const pageLines: Line[][] = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      pageLines.push(buildLines(content.items.filter((i) => "str" in i) as TextItem[]));
      page.cleanup();
    }
    const sizes: number[] = [];
    for (const lines of pageLines) for (const l of lines) for (let k = 0; k < Math.min(l.text.length, 200); k += 10) sizes.push(l.size);
    const bodySize = median(sizes);

    let usedOcr = false;
    for (let p = 1; p <= doc.numPages; p++) {
      const lines = pageLines[p - 1]!;
      const textChars = lines.reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
      const builder = new UnitBuilder();
      const unit: ParsedUnit = { page: p, text: "", blocks: [], ocr: false, ocr_confidence: null };

      if (textChars >= ctx.minTextCharsPerPage) {
        addLinesAsBlocks(builder, lines, bodySize, p);
      } else if (ocr && ctx.ocr.enabled) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: ctx.ocrRenderScale });
        const { createCanvas } = await import("@napi-rs/canvas");
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const c2d = canvas.getContext("2d");
        c2d.fillStyle = "#ffffff";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvas: canvas as never, canvasContext: c2d as never, viewport }).promise;
        page.cleanup();
        const result = await ocr.recognize(canvas.toBuffer("image/png"));
        addOcrTextAsBlocks(builder, result.text, p);
        unit.ocr = true;
        unit.ocr_confidence = Math.round(result.confidence * 10) / 10;
        out.ocrPages.push(p);
        usedOcr = true;
        if (!builder.blocks.length) out.warnings.push(`page ${p}: OCR produced no text`);
        else if (result.confidence < 60) out.warnings.push(`page ${p}: low OCR confidence (${unit.ocr_confidence})`);
      } else {
        addLinesAsBlocks(builder, lines, bodySize, p);
        out.status = "partial";
        out.warnings.push(`page ${p}: no usable text layer and OCR is disabled; page content not extracted`);
      }
      unit.text = builder.text;
      unit.blocks = builder.blocks;
      out.units.push(unit);
    }

    if (usedOcr) {
      out.parser = "pdf-text+ocr";
      out.parserVersion += `; tesseract.js@${packageVersion("tesseract.js")}`;
    }
    out.markdown = out.units
      .map((u) => {
        const body = u.blocks
          .map((b) => {
            const t = u.text.slice(b.char_start, b.char_end);
            return b.kind === "heading" ? `${"#".repeat(Math.min((b.level ?? 1) + 1, 6))} ${t.replace(/\n/g, " ")}` : t;
          })
          .join("\n\n");
        return `<!-- page ${u.page}${u.ocr ? ` (OCR, confidence ${u.ocr_confidence})` : ""} -->\n\n${body}`;
      })
      .join("\n\n");
    if (!out.title) {
      const firstHeading = out.units.flatMap((u) => u.blocks.filter((b) => b.kind === "heading").map((b) => u.text.slice(b.char_start, b.char_end)))[0];
      if (firstHeading) out.title = { value: firstHeading.replace(/\s+/g, " ").trim(), source: "first_heading" };
    }
  } finally {
    await loadingTask.destroy();
  }
  return out;
}
