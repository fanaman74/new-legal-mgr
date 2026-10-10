import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { applyCorrections, CorrectionStore } from "../evidence/corrections.js";
import type { Chunk } from "../evidence/models.js";
import { EvidenceRepository } from "../evidence/repository.js";
import type { RetrievalIndex } from "../retrieval/search.js";
import { cosine } from "../retrieval/embeddings.js";
import { canonicalForQuote, contentTokens, coverage, hasNegation, keyFactTokens, splitSentences, tokenize } from "../retrieval/text.js";

/**
 * Citation verification: does the cited source actually support the claim?
 *
 * Deterministic and explainable. For each (claim, citation) pair:
 *  1. the source must exist and have extracted text, and the cited page/chunk must exist
 *     (otherwise SOURCE_ERROR);
 *  2. a quoted passage, if given, must appear on the cited page/chunk (whitespace-, case- and
 *     punctuation-insensitive; near matches tolerated for OCR noise);
 *  3. the claim is compared with the best-matching sentence window of the cited text: content
 *     words, hard facts (dates, numbers, references, article numbers), negation and conflicting
 *     dates/numbers.
 *
 * VERIFIED            claim's facts and wording are found in the cited passage;
 * PARTIALLY_SUPPORTED some of the claim is supported, or the quote is on another page;
 * UNSUPPORTED         the passage does not support the claim (or states the opposite);
 * SOURCE_ERROR        the cited source/page/chunk is unavailable.
 */

export type VerificationStatus = "VERIFIED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "SOURCE_ERROR";

export interface CitationInput {
  claim: string;
  evidence_id: string;
  page?: number | null;
  chunk_id?: string | null;
  quoted_text?: string | null;
}

export interface VerificationResult {
  status: VerificationStatus;
  evidence_id: string;
  filename: string | null;
  page: number | null;
  chunk_id: string | null;
  /** The best-matching passage in the cited scope (exact source text). */
  supporting_passage: string | null;
  quote_check: "not_provided" | "exact" | "near" | "found_on_other_page" | "not_found";
  scores: { content_coverage: number; key_fact_coverage: number; semantic_similarity: number | null };
  reasons: string[];
}

interface Window {
  text: string;
  sentences: number;
  chunk: Chunk | null;
  page: number | null;
}

interface StructureUnit {
  page: number | null;
  text: string;
}

function loadUnits(cfg: AppConfig, structurePath: string | null): StructureUnit[] {
  if (!structurePath) return [];
  const file = path.join(cfg.dataDir, structurePath);
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")) as { units: StructureUnit[] }).units;
}

/** Token-window match tolerant to OCR noise: best share of quote tokens found in order-free windows. */
function nearQuoteScore(quote: string, text: string): number {
  const q = tokenize(quote, { keepStopwords: true, specialTokens: false });
  const t = tokenize(text, { keepStopwords: true, specialTokens: false });
  if (!q.length || t.length < q.length * 0.5) return 0;
  const need = new Map<string, number>();
  for (const x of q) need.set(x, (need.get(x) ?? 0) + 1);
  let best = 0;
  const w = q.length;
  for (let start = 0; start + Math.min(w, t.length) <= t.length; start++) {
    const have = new Map<string, number>();
    for (const x of t.slice(start, start + w)) have.set(x, (have.get(x) ?? 0) + 1);
    let hit = 0;
    for (const [x, n] of need) hit += Math.min(n, have.get(x) ?? 0);
    best = Math.max(best, hit / q.length);
    if (best === 1) break;
  }
  return best;
}

/** Legal outcomes are often expressed with antonyms rather than negation ("granted" vs "rejected"). */
function outcomeOf(text: string): "positive" | "negative" | null {
  const t = text.toLowerCase();
  const neg = /\b(reject\w*|dismiss\w*|refus\w*|declin\w*|denied|deny|inadmissible|unfounded)\b/.test(t);
  const pos = /\b(grant\w*|upheld|uphold\w*|accept\w*|allow(?:ed|s)?|annul\w*|admissible and well founded)\b/.test(t);
  if (neg === pos) return null;
  return neg ? "negative" : "positive";
}

function dateTokens(tokens: string[]): string[] {
  return tokens.filter((t) => t.startsWith("date:"));
}

export async function verifyCitation(cfg: AppConfig, input: CitationInput, index?: RetrievalIndex | null): Promise<VerificationResult> {
  const repo = new EvidenceRepository(cfg);
  const base: VerificationResult = {
    status: "SOURCE_ERROR",
    evidence_id: input.evidence_id,
    filename: null,
    page: input.page ?? null,
    chunk_id: input.chunk_id ?? null,
    supporting_passage: null,
    quote_check: input.quoted_text ? "not_found" : "not_provided",
    scores: { content_coverage: 0, key_fact_coverage: 0, semantic_similarity: null },
    reasons: [],
  };
  const raw = /^EVID-\d{6}$/.test(input.evidence_id) ? repo.loadCanonical(input.evidence_id) : undefined;
  if (!raw) return { ...base, reasons: [`unknown Evidence ID ${input.evidence_id}`] };
  const record = applyCorrections(raw, new CorrectionStore(cfg).forEvidence(raw.evidence_id));
  base.filename = record.source.original_filename;
  const chunks = repo.loadChunks(record.evidence_id);
  if (!chunks.length) return { ...base, reasons: [`no extracted text for ${record.evidence_id} (status: ${record.provenance.status})`] };

  const paginated = record.provenance.page_count !== null;
  const units = loadUnits(cfg, record.content.structured_json_path);
  let scopeChunks = chunks;
  let scopeText: string;
  const reasons: string[] = [];

  if (input.chunk_id) {
    const c = chunks.find((x) => x.chunk_id === input.chunk_id);
    if (!c) return { ...base, reasons: [`chunk ${input.chunk_id} does not belong to ${record.evidence_id}`] };
    if (input.page != null && c.page !== input.page) return { ...base, reasons: [`chunk ${input.chunk_id} is on page ${c.page}, not page ${input.page}`] };
    scopeChunks = [c];
    scopeText = c.text;
  } else if (input.page != null) {
    if (!paginated) {
      reasons.push(`page ${input.page} ignored: ${record.source.mime_type} has no stable page numbers; the whole document was checked`);
      scopeText = units.map((u) => u.text).join("\n\n") || chunks.map((c) => c.text).join("\n\n");
    } else {
      if (input.page < 1 || input.page > (record.provenance.page_count ?? 0)) {
        return { ...base, reasons: [`page ${input.page} does not exist (document has ${record.provenance.page_count} page(s))`] };
      }
      scopeChunks = chunks.filter((c) => c.page === input.page);
      scopeText = units.find((u) => u.page === input.page)?.text ?? scopeChunks.map((c) => c.text).join("\n\n");
      if (!scopeText.trim()) return { ...base, reasons: [`no extracted text on page ${input.page}`] };
    }
  } else {
    scopeText = units.map((u) => u.text).join("\n\n") || chunks.map((c) => c.text).join("\n\n");
  }

  // 1. Quote check.
  let quoteCheck: VerificationResult["quote_check"] = "not_provided";
  if (input.quoted_text?.trim()) {
    const q = canonicalForQuote(input.quoted_text);
    if (canonicalForQuote(scopeText).includes(q)) quoteCheck = "exact";
    else if (nearQuoteScore(input.quoted_text, scopeText) >= 0.9) quoteCheck = "near";
    else {
      const other = paginated ? chunks.find((c) => c.page !== input.page && canonicalForQuote(c.text).includes(q)) : undefined;
      quoteCheck = other ? "found_on_other_page" : "not_found";
      if (other) reasons.push(`quoted text found on page ${other.page}, not on the cited page`);
      else reasons.push("quoted text not found in the cited source");
    }
  }

  // 2. Claim support: best sentence window (1-3 consecutive sentences) in the cited scope.
  const windows: Window[] = [];
  for (const c of scopeChunks) {
    const sents = splitSentences(c.text);
    for (let i = 0; i < sents.length; i++) {
      for (let len = 1; len <= 3 && i + len <= sents.length; len++) {
        windows.push({ text: sents.slice(i, i + len).map((s) => s.text).join(" "), sentences: len, chunk: c, page: c.page });
      }
    }
  }
  if (!windows.length) windows.push({ text: scopeText, sentences: 1, chunk: scopeChunks[0] ?? null, page: input.page ?? null });

  const claimContent = contentTokens(input.claim);
  const claimFacts = keyFactTokens(input.claim);
  const claimDates = dateTokens(tokenize(input.claim));
  // Judge the claim against single sentences first: a fact must be attributed to the right
  // subject ("Rossi ... 20 March. Hale ... 24 March" must not verify "Rossi ... 24 March").
  // Multi-sentence windows are only used when no single sentence covers the claim's content.
  const scoreWindow = (w: Window) => {
    const content = coverage(claimContent, contentTokens(w.text));
    const facts = claimFacts.length ? coverage(claimFacts, tokenize(w.text)) : 1;
    return { w, content, facts, score: 0.6 * content + 0.4 * facts - w.text.length / 100000 };
  };
  const singles = windows.filter((w) => w.sentences === 1).map(scoreWindow);
  const bestSingle = singles.reduce<ReturnType<typeof scoreWindow> | null>((a, b) => (!a || b.content > a.content || (b.content === a.content && b.score > a.score) ? b : a), null);
  let best = { w: windows[0]!, content: 0, facts: 0, score: -1 };
  if (bestSingle && bestSingle.content >= 0.6) {
    // The sentence that best matches who/what the claim is about is the one judged; its facts
    // (dates, numbers) are then checked in that same sentence.
    best = bestSingle;
  } else {
    for (const cand of windows.map(scoreWindow)) if (cand.score > best.score) best = cand;
  }


  let semantic: number | null = null;
  if (index?.embedder) {
    const vecs = await index.embed([input.claim, best.w.text], "passage");
    if (vecs) semantic = Math.round(cosine(vecs[0]!, vecs[1]!) * 1000) / 1000;
  }

  const windowTokens = tokenize(best.w.text);
  const windowDates = dateTokens(windowTokens);
  const negationMismatch = hasNegation(input.claim) !== hasNegation(best.w.text) && best.content >= 0.4;
  const dateConflict = claimDates.length > 0 && windowDates.length > 0 && claimDates.some((d) => !windowDates.includes(d)) && best.content >= 0.4;
  const missingFacts = claimFacts.filter((f) => !windowTokens.includes(f));

  const claimOutcome = outcomeOf(input.claim);
  const passageOutcome = outcomeOf(best.w.text);
  const outcomeConflict = claimOutcome !== null && passageOutcome !== null && claimOutcome !== passageOutcome && best.content >= 0.3;

  let status: VerificationStatus;
  if (outcomeConflict) {
    status = "UNSUPPORTED";
    reasons.push(`the cited passage records the opposite outcome (${passageOutcome === "negative" ? "rejected/dismissed" : "granted/upheld"})`);
  } else if (negationMismatch) {
    status = "UNSUPPORTED";
    reasons.push("the cited passage expresses the opposite polarity (one statement is negated, the other is not)");
  } else if (dateConflict) {
    status = "UNSUPPORTED";
    reasons.push(`the cited passage gives a different date (${windowDates.map((d) => d.slice(5)).join(", ")})`);
  } else if (best.content >= 0.6 && best.facts === 1) {
    status = "VERIFIED";
  } else if (semantic !== null && index?.embedder && semantic >= index.embedder.minSimilarity + 0.35 && best.facts === 1 && best.content >= 0.4) {
    status = "VERIFIED";
    reasons.push("supported as a paraphrase (high semantic similarity, all key facts present)");
  } else if (best.content >= 0.35 || (best.facts >= 0.5 && claimFacts.length > 0 && best.content >= 0.2)) {
    status = "PARTIALLY_SUPPORTED";
    if (missingFacts.length) reasons.push(`not found in the passage: ${missingFacts.join(", ")}`);
    if (best.content < 0.6) reasons.push(`only ${Math.round(best.content * 100)}% of the claim's content words appear in the passage`);
  } else {
    status = "UNSUPPORTED";
    reasons.push("the cited passage does not contain the claim's content");
  }

  // A quote that does not exist in the source invalidates the citation.
  if (quoteCheck === "not_found") status = "UNSUPPORTED";
  if (quoteCheck === "found_on_other_page" && status === "VERIFIED") status = "PARTIALLY_SUPPORTED";
  if (status === "VERIFIED" && !reasons.length) reasons.push("claim content and key facts found in the cited passage");

  return {
    status,
    evidence_id: record.evidence_id,
    filename: record.source.original_filename,
    page: best.w.page ?? input.page ?? null,
    chunk_id: best.w.chunk?.chunk_id ?? input.chunk_id ?? null,
    supporting_passage: best.w.text,
    quote_check: quoteCheck,
    scores: {
      content_coverage: Math.round(best.content * 1000) / 1000,
      key_fact_coverage: Math.round(best.facts * 1000) / 1000,
      semantic_similarity: semantic,
    },
    reasons,
  };
}
