import type { EmailMetadata } from "../../evidence/models.js";

/**
 * Format-neutral parser output. Parsers produce text units with structural blocks whose
 * character offsets point into the unit text, so every chunk can be traced back exactly.
 */

export type BlockKind = "heading" | "paragraph" | "list_item" | "table" | "email_header";

export interface ParsedBlock {
  /** Stable block/paragraph identifier within the document (e.g. "P0012" or "B004"). */
  id: string;
  kind: BlockKind;
  /** Heading level (1 = top) for headings. */
  level: number | null;
  char_start: number;
  char_end: number;
  /** Section identifier for non-paginated formats ("S003", "HDR", "BODY"). Null for PDF. */
  section_id: string | null;
}

export interface ParsedUnit {
  /** 1-based page number for paginated formats; null otherwise. */
  page: number | null;
  text: string;
  blocks: ParsedBlock[];
  ocr: boolean;
  ocr_confidence: number | null;
}

export interface ExtractedAttachment {
  index: number;
  filename: string | null;
  mimeType: string | null;
  /** Bytes of the attachment; null when it could not be extracted (see note). */
  data: Uint8Array | null;
  kind: "file" | "embedded_message" | "unsupported";
  note: string | null;
}

export interface ParseOutput {
  parser: string;
  parserVersion: string;
  pageCount: number | null;
  units: ParsedUnit[];
  markdown: string;
  embeddedMetadata: Record<string, string | null>;
  title: { value: string; source: "email_subject" | "pdf_metadata" | "docx_metadata" | "first_heading" } | null;
  email: EmailMetadata | null;
  /** Calendar date of the email in the sender's offset when known (YYYY-MM-DD). */
  emailDate: { date: string; basis: string } | null;
  attachments: ExtractedAttachment[];
  ocrPages: number[];
  warnings: string[];
  /** "partial" when some content could not be extracted (e.g. scanned pages with OCR disabled). */
  status: "parsed" | "partial";
}

export interface ParserContext {
  minTextCharsPerPage: number;
  ocrRenderScale: number;
  ocr: { enabled: boolean; langs: string; langPath: string };
}

export function emptyOutput(parser: string, parserVersion: string): ParseOutput {
  return {
    parser,
    parserVersion,
    pageCount: null,
    units: [],
    markdown: "",
    embeddedMetadata: {},
    title: null,
    email: null,
    emailDate: null,
    attachments: [],
    ocrPages: [],
    warnings: [],
    status: "parsed",
  };
}

/** Helper used by parsers that build a unit text incrementally. */
export class UnitBuilder {
  private parts: string[] = [];
  private length = 0;
  readonly blocks: ParsedBlock[] = [];

  add(args: { id: string; kind: BlockKind; text: string; level?: number | null; section_id?: string | null }): void {
    const text = args.text.trim();
    if (!text) return;
    if (this.length > 0) {
      this.parts.push("\n\n");
      this.length += 2;
    }
    const start = this.length;
    this.parts.push(text);
    this.length += text.length;
    this.blocks.push({
      id: args.id,
      kind: args.kind,
      level: args.level ?? null,
      char_start: start,
      char_end: this.length,
      section_id: args.section_id ?? null,
    });
  }

  get text(): string {
    return this.parts.join("");
  }
}
