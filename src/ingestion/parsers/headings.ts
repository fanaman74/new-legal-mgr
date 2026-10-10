/**
 * Heading heuristics shared by the PDF (text layer and OCR) and plain-text parsers.
 * Deliberately conservative: a false negative only costs a heading label on a chunk.
 */

const NUMBERED = /^((?:\d{1,2}\.)+\d{0,2}|[IVXLC]{1,6}\.|[A-H]\.|(?:Article|Section|Part|Chapter|Annex)\s+[\dIVX]+[a-z]?\.?)\s+\S/;

/** Returns a heading level (1-3) or null for a single, standalone line of text. */
export function headingLevelForLine(line: string): number | null {
  const t = line.trim();
  if (t.length < 3 || t.length > 100) return null;
  if (/[,;:]$/.test(t)) return null;
  const numbered = t.match(NUMBERED);
  if (numbered && !/[.!?]["')]?$/.test(t.slice(numbered[0].length))) {
    const label = numbered[1]!;
    if (/^(Article|Section|Part|Chapter|Annex)/i.test(label)) return 2;
    const depth = label.split(".").filter(Boolean).length;
    return Math.min(depth + 1, 3);
  }
  const letters = t.replace(/[^\p{L}]/gu, "");
  const words = t.split(/\s+/).length;
  if (letters.length >= 6 && words >= 2 && letters === letters.toUpperCase() && !/[.!?]$/.test(t)) return 1;
  return null;
}
