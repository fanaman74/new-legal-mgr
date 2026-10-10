import { extractDateCandidates } from "../ingestion/metadata.js";

/**
 * Text normalisation shared by lexical retrieval, sentence matching and verification.
 *
 * Tokens:
 *  - words: lower-cased, accents removed, light English stemming, stop-words removed;
 *  - references: "ART24-2025-0012" is kept whole AND split into parts;
 *  - legal anchors: "Article 24" -> "art:24", "Annex B" -> "annex:b", "Section 3" -> "section:3";
 *  - dates in any supported format -> "date:2025-01-17" (so "17 January 2025" matches "2025-01-17").
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be been being but by can could did do does doing for from had has have having he her hers him his how i if in into is it its " +
    "itself me my of on or our ours she should so than that the their them then there these they this those to too under until up very was we were what " +
    "when where which while who whom why will with would you your yours also any each about against between both during further more most other own same " +
    "some such only once here all no nor not off out over again ever per via upon " +
    "le la les un une des du de et en dans pour par sur au aux ce ces cette est sont qui que"
  ).split(/\s+/),
);

/** Words whose presence changes the meaning of a statement; never dropped as stop-words in polarity checks. */
export const NEGATIONS = new Set(["not", "no", "never", "none", "neither", "nor", "without", "cannot", "nothing", "nobody"]);

export function normalise(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export function stem(word: string): string {
  let w = word;
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith("'s")) w = w.slice(0, -2);
  if ((w.endsWith("ies") || w.endsWith("ied")) && w.length > 4) w = `${w.slice(0, -3)}y`;
  else if (w.endsWith("sses")) w = w.slice(0, -2);
  else if (w.endsWith("ss") || w.endsWith("us") || w.endsWith("is")) return w;
  // Derivational forms common in legal text: responsibility ~ responsible, liability ~ liable,
  // attribution ~ attribute.
  else if ((w.endsWith("ibilities") || w.endsWith("abilities")) && w.length > 12) w = w.slice(0, -9);
  else if ((w.endsWith("ibility") || w.endsWith("ability")) && w.length > 10) w = w.slice(0, -7);
  else if ((w.endsWith("ible") || w.endsWith("able")) && w.length > 8) w = w.slice(0, -4);
  else if (w.endsWith("utions") && w.length > 8) w = w.slice(0, -4);
  else if (w.endsWith("ution") && w.length > 7) w = w.slice(0, -3);
  else if (w.endsWith("ments") && w.length > 7) w = w.slice(0, -5);
  else if (w.endsWith("ment") && w.length > 6) w = w.slice(0, -4);
  else if (w.endsWith("ing") && w.length > 5) w = w.slice(0, -3);
  else if (w.endsWith("ed") && w.length > 4) w = w.slice(0, -2);
  else if (/(?:ch|sh|x|z)es$/.test(w)) w = w.slice(0, -2);
  else if (w.endsWith("s")) w = w.slice(0, -1);
  // "attribute" / "attributed" / "attributes" -> "attribut"
  if (w.length > 5 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

const ANCHOR = /\b(article|art|section|annex|annexe|appendix|exhibit|finding|paragraph|point)\.?\s+([a-z]\.?\d{1,3}|[0-9]+[a-z]?|[a-h])\b/g;
const ANCHOR_CANON: Record<string, string> = { article: "art", art: "art", annexe: "annex", appendix: "annex", exhibit: "annex" };

export interface TokenOptions {
  /** Keep stop-words (used for phrase/quote matching). */
  keepStopwords?: boolean;
  /** Add date and anchor tokens (default true). */
  specialTokens?: boolean;
}

/** Common abbreviations in legal correspondence, expanded before stemming. */
const ABBREVIATIONS: Record<string, string> = { ref: "reference", refs: "references", dept: "department", reg: "regulation", regs: "regulations" };

export function tokenize(text: string, opts: TokenOptions = {}): string[] {
  const norm = normalise(text);
  const out: string[] = [];
  for (const m of norm.matchAll(/[\p{L}\p{N}]+(?:[-_./'][\p{L}\p{N}]+)*/gu)) {
    const raw = m[0];
    const parts = raw.split(/[-_./']/).filter(Boolean);
    if (parts.length > 1 && /\d/.test(raw)) out.push(raw.replace(/[_./]/g, "-"));
    for (const part of parts) {
      const p = ABBREVIATIONS[part] ?? part;
      if (!opts.keepStopwords && STOPWORDS.has(p)) continue;
      if (p.length === 1 && !/\d/.test(p) && !opts.keepStopwords) continue;
      out.push(stem(p));
    }
  }
  if (opts.specialTokens !== false) {
    for (const m of norm.matchAll(ANCHOR)) out.push(`${ANCHOR_CANON[m[1]!] ?? m[1]}:${m[2]!.replace(".", "")}`);
    for (const d of extractDateCandidates(text, null, null)) out.push(`date:${d.value}`);
  }
  return out;
}

/** Content tokens (no special tokens) for overlap measures. */
export function contentTokens(text: string): string[] {
  return tokenize(text, { specialTokens: false });
}

/** Tokens that carry hard facts: dates, numbers, references and legal anchors. */
export function keyFactTokens(text: string): string[] {
  const toks = tokenize(text);
  return [...new Set(toks.filter((t) => t.startsWith("date:") || t.includes(":") || /\d/.test(t)))].filter(
    // A bare year/number that is part of a date is already covered by the date token.
    (t) => !/^\d{1,2}$/.test(t),
  );
}

/** Whitespace/punctuation-insensitive form for quote matching. */
export function canonicalForQuote(text: string): string {
  return normalise(text)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[-‐-―]\s*\n\s*/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function hasNegation(text: string): boolean {
  return normalise(text)
    .split(/[^\p{L}']+/u)
    .some((w) => NEGATIONS.has(w) || w.endsWith("n't"));
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

/** Split into sentences with offsets (handles common abbreviations and list/line structure). */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  const abbrev = /\b(?:art|no|nos|p|pp|para|ref|refs|mr|mrs|ms|dr|prof|e\.g|i\.e|cf|vs|st|co|ltd|inc|fig|sec|ch|vol|op|cit)\.$/i;
  let start = 0;
  const push = (end: number) => {
    const raw = text.slice(start, end);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed.replace(/\s*\n\s*/g, " "), start: start + lead, end: start + lead + trimmed.length });
    start = end;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n" && text[i + 1] === "\n") {
      push(i);
      continue;
    }
    if ((ch === "." || ch === "!" || ch === "?" || ch === ";") && /\s/.test(text[i + 1] ?? " ")) {
      const before = text.slice(Math.max(0, i - 6), i + 1);
      if (ch === "." && (abbrev.test(before) || /\b[A-Z]\.$/.test(before) || /\d\.$/.test(before) && /^\s*\d/.test(text.slice(i + 1, i + 4)))) continue;
      push(i + 1);
    }
  }
  push(text.length);
  return out;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Share of `needles` contained in `hay`. */
export function coverage(needles: Iterable<string>, hay: Iterable<string>): number {
  const N = new Set(needles);
  const H = new Set(hay);
  if (!N.size) return 0;
  let hit = 0;
  for (const x of N) if (H.has(x)) hit++;
  return hit / N.size;
}
