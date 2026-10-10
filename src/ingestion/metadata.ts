import path from "node:path";
import type { DocumentTypeRule, MatterRule } from "../config.js";
import type { Confidence, DateCandidate } from "../evidence/models.js";

// ---------------------------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------------------------

export type FormatKind = "pdf" | "docx" | "msg" | "eml" | "text" | "unsupported";

export interface DetectedFormat {
  kind: FormatKind;
  mimeType: string;
  /** Set when the extension and the file signature disagree. */
  warning: string | null;
}

const OLE_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  return magic.every((b, i) => bytes[i] === b);
}

function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  let control = 0;
  for (const b of head) {
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) control++;
  }
  return control / head.length < 0.02;
}

/** Detect a file's format from its leading bytes, using the extension only to disambiguate containers. */
export function detectFormat(filename: string, head: Uint8Array): DetectedFormat {
  const ext = path.extname(filename).toLowerCase();
  const ascii = Buffer.from(head.subarray(0, 8)).toString("latin1");
  const mismatch = (expected: string) => (ext && ext !== expected ? `extension ${ext} does not match ${expected} signature` : null);

  if (ascii.startsWith("%PDF-")) return { kind: "pdf", mimeType: "application/pdf", warning: mismatch(".pdf") };
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    if (ext === ".docx") {
      return { kind: "docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", warning: null };
    }
    return { kind: "unsupported", mimeType: "application/zip", warning: null };
  }
  if (startsWith(head, OLE_MAGIC)) {
    if (ext === ".msg") return { kind: "msg", mimeType: "application/vnd.ms-outlook", warning: null };
    return { kind: "unsupported", mimeType: "application/x-ole-storage", warning: null };
  }
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47])) return { kind: "unsupported", mimeType: "image/png", warning: null };
  if (startsWith(head, [0xff, 0xd8, 0xff])) return { kind: "unsupported", mimeType: "image/jpeg", warning: null };
  if (ascii.startsWith("GIF8")) return { kind: "unsupported", mimeType: "image/gif", warning: null };
  if (looksLikeText(head)) {
    if (ext === ".eml") return { kind: "eml", mimeType: "message/rfc822", warning: null };
    if (ext === ".txt") return { kind: "text", mimeType: "text/plain", warning: null };
    if (ext === ".md") return { kind: "text", mimeType: "text/markdown", warning: null };
    return { kind: "unsupported", mimeType: "text/plain", warning: null };
  }
  return { kind: "unsupported", mimeType: "application/octet-stream", warning: null };
}

// ---------------------------------------------------------------------------------------------
// Date extraction
// ---------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, janvier: 1,
  february: 2, feb: 2, février: 2, fevrier: 2,
  march: 3, mar: 3, mars: 3,
  april: 4, apr: 4, avril: 4,
  may: 5, mai: 5,
  june: 6, jun: 6, juin: 6,
  july: 7, jul: 7, juillet: 7,
  august: 8, aug: 8, août: 8, aout: 8,
  september: 9, sep: 9, sept: 9, septembre: 9,
  october: 10, oct: 10, octobre: 10,
  november: 11, nov: 11, novembre: 11,
  december: 12, dec: 12, décembre: 12, decembre: 12,
};
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");

const DATE_PATTERNS: { re: RegExp; parse: (m: RegExpExecArray) => { y: number; mo: number; d: number; ambiguous: boolean } | null }[] = [
  {
    // 17 January 2025, 1st March 2024, 17 Jan. 2025
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th|er)?\\s+(${MONTH_ALT})\\.?,?\\s+(\\d{4})\\b`, "giu"),
    parse: (m) => ({ d: Number(m[1]), mo: MONTHS[m[2]!.toLowerCase()]!, y: Number(m[3]), ambiguous: false }),
  },
  {
    // January 17, 2025
    re: new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "giu"),
    parse: (m) => ({ d: Number(m[2]), mo: MONTHS[m[1]!.toLowerCase()]!, y: Number(m[3]), ambiguous: false }),
  },
  {
    // 2025-01-17
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    parse: (m) => ({ y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), ambiguous: false }),
  },
  {
    // 17/01/2025 or 17.01.2025: read as day/month/year (UK/EU convention); ambiguous when both <= 12.
    re: /\b(\d{1,2})[./](\d{1,2})[./](\d{4})\b/g,
    parse: (m) => {
      const d = Number(m[1]);
      const mo = Number(m[2]);
      return { d, mo, y: Number(m[3]), ambiguous: d <= 12 && mo <= 12 && d !== mo };
    },
  },
];

function validDate(y: number, mo: number, d: number): string | null {
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** "Date:", "Dated", "Date of decision:" or a letterhead line such as "Brussels, 17 January 2025". */
function isLabelled(linePrefix: string): boolean {
  if (/\bdated?\b[^.\n]{0,25}[:\s]\s*$/i.test(linePrefix)) return true;
  return /^\s*(?:[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?),\s*(?:(?:le|the)\s+)?$/u.test(linePrefix);
}

export function extractDateCandidates(text: string, page: number | null, chunkId: string | null): DateCandidate[] {
  const found: (DateCandidate & { index: number })[] = [];
  const taken: [number, number][] = [];
  for (const { re, parse } of DATE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (taken.some(([s, e]) => start < e && end > s)) continue;
      const parts = parse(m);
      const value = parts ? validDate(parts.y, parts.mo, parts.d) : null;
      if (!value || !parts) continue;
      taken.push([start, end]);
      const lineStart = text.lastIndexOf("\n", start - 1) + 1;
      found.push({
        index: start,
        value,
        raw: m[0],
        page,
        chunk_id: chunkId,
        labelled: isLabelled(text.slice(lineStart, start)),
        ambiguous: parts.ambiguous,
      });
    }
  }
  return found.sort((a, b) => a.index - b.index).map(({ index: _index, ...c }) => c);
}

export interface DateChoice {
  date: string | null;
  confidence: Confidence | null;
  basis: string | null;
}

/**
 * Choose a document date from candidates found in the opening part of a document.
 * Machine-extracted dates are never "high" confidence: at best "medium" (explicitly labelled).
 */
export function chooseDocumentDate(candidates: DateCandidate[]): DateChoice {
  const unambiguous = candidates.filter((c) => !c.ambiguous);
  const labelled = unambiguous.find((c) => c.labelled);
  const where = (c: DateCandidate) => (c.page ? `page ${c.page}` : c.chunk_id ?? "opening text");
  if (labelled) {
    return { date: labelled.value, confidence: "medium", basis: `labelled date "${labelled.raw}" on ${where(labelled)}` };
  }
  const first = unambiguous[0];
  if (first) {
    return { date: first.value, confidence: "low", basis: `first date "${first.raw}" on ${where(first)} (unlabelled)` };
  }
  return { date: null, confidence: null, basis: candidates.length ? "only ambiguous numeric dates found" : null };
}

/** Calendar date (YYYY-MM-DD) of an instant in the sender's UTC offset when known, else UTC. */
export function calendarDate(isoInstant: string, offsetMinutes: number | null): string {
  const t = new Date(isoInstant).getTime() + (offsetMinutes ?? 0) * 60_000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Parse the UTC offset of an RFC 2822 Date header, e.g. "+0100" -> 60. */
export function parseHeaderOffset(dateHeader: string | null | undefined): number | null {
  const m = dateHeader?.match(/([+-])(\d{2})(\d{2})\s*(?:\(.*\))?\s*$/);
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

// ---------------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------------

function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/[_\-.]+/g, " ").replace(/\s+/g, " ");
}

export interface TypeChoice {
  type: string;
  confidence: Confidence | null;
  basis: string | null;
}

export function classifyDocumentType(args: {
  relativePath: string;
  openingText: string;
  isEmail: boolean;
  rules: DocumentTypeRule[];
}): TypeChoice {
  if (args.isEmail) return { type: "email", confidence: "high", basis: "email file format" };
  // In legal file names the head noun usually comes first ("decision on request...",
  // "complaint ... against decision", "reply to complaint"): the earliest match in the file
  // name wins (longest pattern on ties); folder names are only used when the file name is silent.
  const pickEarliest = (hay: string) => {
    let best: { rule: string; pattern: string; at: number } | null = null;
    for (const rule of args.rules) {
      for (const pat of rule.path_patterns) {
        const n = normaliseForMatch(pat);
        const at = hay.indexOf(n);
        if (at >= 0 && (!best || at < best.at || (at === best.at && n.length > best.pattern.length))) best = { rule: rule.id, pattern: n, at };
      }
    }
    return best;
  };
  const filename = normaliseForMatch(path.basename(args.relativePath).replace(/\.[a-z0-9]+$/i, ""));
  const folders = normaliseForMatch(path.dirname(args.relativePath));
  const fromName = pickEarliest(filename);
  if (fromName) return { type: fromName.rule, confidence: "medium", basis: `file name contains "${fromName.pattern}"` };
  const fromFolder = folders !== "." ? pickEarliest(folders) : null;
  if (fromFolder) return { type: fromFolder.rule, confidence: "low", basis: `stored in folder containing "${fromFolder.pattern}"` };
  const t = args.openingText.toLowerCase().replace(/\s+/g, " ");
  for (const rule of args.rules) {
    const hit = rule.text_patterns.find((pat) => t.includes(pat.toLowerCase()));
    if (hit) return { type: rule.id, confidence: "low", basis: `opening text contains "${hit}"` };
  }
  return { type: "unknown", confidence: null, basis: null };
}

export interface MatterChoice {
  matter: string;
  confidence: Confidence;
  basis: string;
}

export function classifyMatters(args: { relativePath: string; openingText: string; rules: MatterRule[] }): MatterChoice[] {
  const out = new Map<string, MatterChoice>();
  const rel = args.relativePath.toLowerCase();
  for (const rule of args.rules) {
    const prefix = rule.path_prefixes.find((pre) => rel.startsWith(pre.toLowerCase()));
    if (prefix) out.set(rule.id, { matter: rule.id, confidence: "high", basis: `stored under folder "${prefix}"` });
  }
  const hay = `${normaliseForMatch(args.relativePath)} ${args.openingText.toLowerCase().replace(/\s+/g, " ")}`;
  for (const rule of args.rules) {
    if (out.has(rule.id)) continue;
    const kw = rule.keywords.find((k) => hay.includes(k.toLowerCase()));
    if (kw) out.set(rule.id, { matter: rule.id, confidence: "low", basis: `filename/opening text contains "${kw}"` });
  }
  return [...out.values()];
}

/** Reject placeholder titles commonly found in PDF/DOCX metadata. */
export function usableEmbeddedTitle(title: string | null | undefined): string | null {
  const t = title?.trim();
  if (!t) return null;
  if (/^(untitled|document\d*|microsoft word - .*|title)$/i.test(t)) return null;
  return t;
}
