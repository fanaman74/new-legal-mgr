import { z } from "zod";
import type { AppConfig } from "../config.js";
import { cosine } from "../retrieval/embeddings.js";
import type { SearchParams, SearchResult, SearchService } from "../retrieval/search.js";
import { contentTokens, keyFactTokens, splitSentences, tokenize } from "../retrieval/text.js";
import { extractDateCandidates } from "../ingestion/metadata.js";
import { chatJson, llmEnabled, loadSystemPrompt, type LlmInfo } from "./llm.js";
import { verifyCitation, type VerificationResult, type VerificationStatus } from "./verification.js";

/**
 * Grounded question answering.
 *
 * Default (no LLM): extractive. The answer is the best supporting sentence(s) quoted verbatim
 * from the evidence, with a concise fact (e.g. the date) when the question asks for one.
 * Optional LLM mode: the model must return claims with citations; every citation is verified
 * and unsupported claims are dropped. In both modes no answer is given without verified
 * evidence: "Insufficient evidence found in the indexed corpus."
 */

export const INSUFFICIENT = "Insufficient evidence found in the indexed corpus.";

export interface AnswerCitation {
  evidence_id: string;
  filename: string;
  title: string | null;
  document_date: string | null;
  document_type: string;
  page: number | null;
  section_id: string | null;
  chunk_id: string;
  quote: string;
  verification: VerificationResult;
}

export interface AnswerClaim {
  text: string;
  citations: AnswerCitation[];
  status: VerificationStatus;
}

export interface Answer {
  question: string;
  status: "answered" | "insufficient_evidence";
  answer: string;
  claims: AnswerClaim[];
  /** Claims proposed by the LLM that failed verification (LLM mode only). */
  rejected_claims: AnswerClaim[];
  /** Other retrieved passages, for transparency. */
  related: Pick<SearchResult, "evidence_id" | "filename" | "page" | "section_id" | "chunk_id" | "score" | "heading">[];
  mode: "extractive" | "llm";
  llm: LlmInfo | null;
  verification: VerificationStatus | "NONE";
  formatted: string;
  notes: string[];
}

const QUESTION_WORDS = new Set(["what", "when", "which", "who", "whom", "whose", "where", "why", "how", "did", "does", "do", "is", "was", "were", "are", "has", "have"]);
/** Words that ask for provenance or answer format rather than describing the fact sought. */
const META_WORDS = new Set(["document", "prove", "proof", "show", "evidence", "source", "date", "number", "name", "state", "indicate", "mention", "say"].map((w) => w));

function questionTerms(q: string): string[] {
  const meta = new Set([...META_WORDS].flatMap((w) => contentTokens(w)));
  return contentTokens(q).filter((t) => !QUESTION_WORDS.has(t) && !meta.has(t));
}

type Expect = "date" | "amount" | "count" | "reference" | "person" | "statement";
function expectedAnswer(q: string): Expect {
  const s = q.toLowerCase();
  if (/\bwhen\b|\bwhat date\b|\bwhich date\b|\bon what day\b/.test(s)) return "date";
  if (/\bhow much\b|\bwhat amount\b|\bwhat sum\b/.test(s)) return "amount";
  if (/\bhow many\b/.test(s)) return "count";
  if (/\b(case number|reference|ref\.|registration number|file number|case no)\b/.test(s)) return "reference";
  if (/\bwho\b|\bwhom\b|\bwhich (?:doctor|person|official|officer|lawyer|counsel|witness|manager|judge|member|staff member|agent)\b|\bname of\b/.test(s)) return "person";
  return "statement";
}

const PERSON_RE = /\b(?:Dr|Mr|Mrs|Ms|Miss|Prof|Maître|Me)\.?\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?/gu;
const REFERENCE_RE = /\b[A-Z]{1,8}\d*(?:[-/][A-Z0-9]+){1,4}\b|\b[A-Z]\/\d+\/\d+\b/;
const AMOUNT_RE = /(?:€|eur\b|euros?\b|\$|£|chf\b)\s*\d|\d[\d.,\s]*\s*(?:€|eur\b|euros?\b|chf\b)|\bamount of\b\s*\d/i;

/** Does a sentence contain the kind of fact the question asks for? */
function hasExpectedFact(expect: Expect, text: string): boolean {
  switch (expect) {
    case "date":
      return extractDateCandidates(text, null, null).some((d) => !d.ambiguous);
    case "amount":
      return AMOUNT_RE.test(text);
    case "count":
      return /\b\d+\b/.test(extractDateCandidates(text, null, null).reduce((t, d) => t.replace(d.raw, ""), text));
    case "reference":
      return REFERENCE_RE.test(text);
    case "person":
      return new RegExp(PERSON_RE.source, "u").test(text) || /\b[A-Z][a-z]+ [A-Z][a-z]+\b/.test(text);
    default:
      return true;
  }
}

interface Candidate {
  sentence: string;
  /** The following sentence in the same chunk, if any. */
  next: string | null;
  result: SearchResult;
  coverage: number;
  semantic: number | null;
  score: number;
}

function worst(statuses: VerificationStatus[]): VerificationStatus {
  const order: VerificationStatus[] = ["SOURCE_ERROR", "UNSUPPORTED", "PARTIALLY_SUPPORTED", "VERIFIED"];
  return statuses.reduce((w, s) => (order.indexOf(s) < order.indexOf(w) ? s : w), "VERIFIED" as VerificationStatus);
}

function citationLine(c: AnswerCitation): string {
  const where = c.page !== null ? `Page ${c.page}` : `Section ${c.section_id}`;
  return `[${c.evidence_id}] ${c.title ?? c.filename}${c.document_date ? ` (${c.document_date})` : ""}\n${where} · ${c.chunk_id}\nSupporting passage: "${c.quote}"\nVerification: ${c.verification.status}`;
}

export function formatAnswer(a: Pick<Answer, "status" | "answer" | "claims">): string {
  if (a.status !== "answered") return INSUFFICIENT;
  const parts = [a.answer, ""];
  a.claims.forEach((c, i) => {
    if (a.claims.length > 1) parts.push(`Finding ${i + 1}: ${c.text}`);
    parts.push(...c.citations.map((x) => `Source:\n${citationLine(x)}`), "");
  });
  return parts.join("\n").trim();
}

async function toCitation(cfg: AppConfig, search: SearchService, r: SearchResult, claim: string, quote: string): Promise<AnswerCitation> {
  const index = await search.getIndex();
  const verification = await verifyCitation(cfg, { claim, evidence_id: r.evidence_id, page: r.page, chunk_id: r.chunk_id, quoted_text: quote }, index);
  return {
    evidence_id: r.evidence_id,
    filename: r.filename,
    title: r.title,
    document_date: r.document_date,
    document_type: r.document_type,
    page: r.page,
    section_id: r.section_id,
    chunk_id: r.chunk_id,
    quote,
    verification,
  };
}

export interface AskOptions extends Omit<SearchParams, "query" | "mode"> {
  /** Force extractive mode even if an LLM is configured. */
  extractive_only?: boolean;
}

export async function answerQuestion(cfg: AppConfig, search: SearchService, question: string, opts: AskOptions = {}): Promise<Answer> {
  const retrieved = await search.search({ ...opts, query: question, top_k: Math.max(12, opts.top_k ?? 12) }, "ask");
  const index = await search.getIndex();
  const terms = questionTerms(question);
  const expect = expectedAnswer(question);
  const prefersOfficial = /\b(decid|decision|formally|register|official|adopted|rejected|granted)/i.test(question);
  const notes: string[] = [];
  const base: Omit<Answer, "status" | "answer" | "claims" | "formatted" | "verification"> = {
    question,
    rejected_claims: [],
    related: retrieved.results.map((r) => ({ evidence_id: r.evidence_id, filename: r.filename, page: r.page, section_id: r.section_id, chunk_id: r.chunk_id, score: r.score, heading: r.heading })),
    mode: "extractive",
    llm: null,
    notes,
  };
  const insufficient = (why: string): Answer => {
    notes.push(why);
    return { ...base, status: "insufficient_evidence", answer: INSUFFICIENT, claims: [], verification: "NONE", formatted: INSUFFICIENT };
  };
  if (!retrieved.results.length) return insufficient("no passages retrieved");

  // Sentence-level candidates from the retrieved chunks.
  const candidates: Candidate[] = [];
  const top = retrieved.results.slice(0, 10);
  const qVec = index.embedder ? (await index.embed([question], "query"))?.[0] ?? null : null;
  const SECONDARY_TYPES = new Set(["notes"]);
  const questionLower = question.toLowerCase();
  /** Names a person other than those mentioned in the question. */
  const namesNewPerson = (text: string) => [...text.matchAll(PERSON_RE)].some((m) => !questionLower.includes(m[0].split(/\s+/).at(-1)!.toLowerCase()));
  // Coverage weighted by rarity: names and words that occur everywhere (e.g. the parties) count little.
  const maxIdf = Math.log(1 + index.items.length + 0.5);
  const weight = (t: string) => (index.idf(t) > 0 ? index.idf(t) : maxIdf);
  const totalWeight = terms.reduce((sum, t) => sum + weight(t), 0);
  // A sentence is read in its context: its heading and the document title count towards coverage.
  const weightedCoverage = (sentence: string, context: string) => {
    if (!totalWeight) return 0;
    const toks = new Set([...contentTokens(sentence), ...contentTokens(context)]);
    return terms.filter((t) => toks.has(t)).reduce((sum, t) => sum + weight(t), 0) / totalWeight;
  };
  for (const r of top) {
    const sentences = splitSentences(r.text).map((x) => ({ ...x, text: x.text.replace(/^[-•*]\s+/, "") }));
    for (const [si, s] of sentences.entries()) {
      // Headings, letterheads and signature lines are not answers.
      if (s.text.length < 12 || contentTokens(s.text).length < 3 || s.text === s.text.toUpperCase()) continue;
      const next = sentences[si + 1]?.text ?? null;
      // The expected kind of fact (date, amount, reference, person...) must be present,
      // possibly in the following sentence (e.g. a signature naming the certifying doctor).
      const typed = hasExpectedFact(expect, s.text) || (expect === "person" && next !== null && hasExpectedFact(expect, next));
      if (!typed) continue;
      const cov = terms.length ? weightedCoverage(s.text, [r.title ?? "", r.heading ?? ""].join(" ")) : 0;
      let score = cov + 0.3 * r.score;
      if (prefersOfficial && ["official_decision", "acknowledgement"].includes(r.document_type)) score += 0.1;
      // Prefer primary evidence over working notes and other secondary material.
      if (SECONDARY_TYPES.has(r.document_type)) score -= 0.2;
      if (expect === "person" && (namesNewPerson(s.text) || (next !== null && namesNewPerson(next)))) score += 0.1;
      candidates.push({ sentence: s.text, next, result: r, coverage: cov, semantic: null, score });
    }
  }
  if (qVec && candidates.length) {
    const vecs = await index.embed(candidates.map((c) => c.sentence), "passage");
    vecs?.forEach((v, i) => {
      const sim = cosine(qVec, v);
      candidates[i]!.semantic = sim;
      candidates[i]!.score += 0.5 * Math.max(0, sim);
    });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  const minSim = (index.embedder?.minSimilarity ?? 1) + 0.15;
  const sufficient =
    best && (best.coverage >= cfg.answer.minLexicalCoverage || (best.semantic !== null && best.semantic >= minSim && best.coverage >= 0.3));
  if (!best) {
    return insufficient(expect === "statement" ? "no usable passage retrieved" : `no retrieved passage contains the kind of fact asked for (${expect})`);
  }
  if (!sufficient) {
    return insufficient(`best passage covers ${Math.round(best.coverage * 100)}% of the question's key terms, weighted by rarity (minimum ${Math.round(cfg.answer.minLexicalCoverage * 100)}%)`);
  }

  if (llmEnabled(cfg) && !opts.extractive_only) {
    try {
      return await llmAnswer(cfg, search, question, retrieved.results.slice(0, cfg.answer.maxPassages), base);
    } catch (err) {
      notes.push(`LLM unavailable, extractive answer given instead: ${(err as Error).message}`);
    }
  }

  // The specific fact the question asks for, as stated in the best sentence. For dates, pick the
  // date nearest to the question's most distinctive word (e.g. "registered", not "lodged").
  let answerFact: string | null = null;
  let factLead = "";
  if (expect === "date") {
    const sentence = best.sentence;
    const dates = extractDateCandidates(sentence, null, null).filter((d) => !d.ambiguous);
    const lower = sentence.toLowerCase();
    const anchors = terms
      .map((t) => ({ t, at: lower.indexOf(t.slice(0, Math.max(4, Math.min(t.length, 6)))), w: weight(t) }))
      .filter((a) => a.at >= 0 && !/^\d+$/.test(a.t))
      .sort((a, b) => b.w - a.w);
    const anchor = anchors[0]?.at ?? 0;
    const pick = dates.reduce<(typeof dates)[number] | null>((acc, d) => (!acc || Math.abs(sentence.indexOf(d.raw) - anchor) < Math.abs(sentence.indexOf(acc.raw) - anchor) ? d : acc), null);
    if (pick) {
      answerFact = `date:${pick.value}`;
      factLead = `${pick.raw}. `;
    }
  } else if (expect === "reference") {
    const m = REFERENCE_RE.exec(best.sentence);
    if (m) answerFact = m[0].toLowerCase();
  } else if (expect === "person") {
    const names = [...`${best.sentence} ${best.next ?? ""}`.matchAll(PERSON_RE)].map((m) => m[0].split(/\s+/).at(-1)!.toLowerCase()).filter((n) => !questionLower.includes(n));
    answerFact = names[0] ?? null;
  }
  const states = (text: string) => {
    if (!answerFact) return true;
    if (answerFact.startsWith("date:")) return tokenize(text).includes(answerFact);
    return text.toLowerCase().includes(answerFact);
  };

  // Extractive answer: best sentence, plus up to two corroborating sentences from other documents
  // that state the same fact (not merely something similar).
  const keyFacts = (text: string) => new Set(keyFactTokens(text));
  const bestFacts = keyFacts(best.sentence);
  const chosen: Candidate[] = [best];
  for (const c of candidates.slice(1)) {
    if (chosen.length >= 3) break;
    if (chosen.some((x) => x.result.evidence_id === c.result.evidence_id)) continue;
    if (c.coverage < Math.max(cfg.answer.minLexicalCoverage, best.coverage * 0.75)) continue;
    if (answerFact ? !states(c.sentence) : bestFacts.size > 0 && ![...keyFacts(c.sentence)].some((f) => bestFacts.has(f))) continue;
    chosen.push(c);
  }
  const claims: AnswerClaim[] = [];
  for (const c of chosen) {
    // "Who" questions: include the next sentence when it names a person and this one does not.
    if (expect === "person" && c.next && !namesNewPerson(c.sentence) && namesNewPerson(c.next)) c.sentence = `${c.sentence} ${c.next}`;
    const citation = await toCitation(cfg, search, c.result, c.sentence, c.sentence);
    claims.push({ text: c.sentence, citations: [citation], status: citation.verification.status });
  }
  const verified = claims.filter((c) => c.status === "VERIFIED" || c.status === "PARTIALLY_SUPPORTED");
  if (!verified.length) return insufficient("no retrieved passage passed citation verification");

  const answer = verified[0] === claims[0] ? `${factLead}${verified[0]!.text}` : verified[0]!.text;
  if (verified.length > 1) notes.push(`${verified.length - 1} corroborating passage(s) from other documents`);
  const result = { ...base, status: "answered" as const, answer, claims: verified, verification: worst(verified.map((c) => c.status)) };
  return { ...result, formatted: formatAnswer(result) };
}

const LlmOutput = z.object({
  insufficient: z.boolean().optional(),
  answer: z.string().optional(),
  claims: z
    .array(
      z.object({
        text: z.string(),
        citations: z.array(z.object({ passage: z.number().int().positive(), quote: z.string() })).min(1),
      }),
    )
    .optional(),
});

async function llmAnswer(
  cfg: AppConfig,
  search: SearchService,
  question: string,
  passages: SearchResult[],
  base: Omit<Answer, "status" | "answer" | "claims" | "formatted" | "verification">,
): Promise<Answer> {
  const system = loadSystemPrompt();
  const user = [
    `Question: ${question}`,
    "",
    "Evidence passages (cite them by number):",
    ...passages.map((p, i) => `[${i + 1}] ${p.evidence_id}, ${p.page !== null ? `page ${p.page}` : `section ${p.section_id}`}, ${p.filename}${p.document_date ? `, dated ${p.document_date}` : ""}\n${p.text}`),
    "",
    'Reply with a JSON object: {"answer": "...", "claims": [{"text": "one factual proposition", "citations": [{"passage": <number>, "quote": "exact words copied from that passage"}]}]}.',
    'If the passages do not answer the question, reply {"insufficient": true}.',
  ].join("\n");
  const { json, info } = await chatJson(cfg, system.text, user);
  const out = LlmOutput.parse(json);
  const answered: AnswerClaim[] = [];
  const rejected: AnswerClaim[] = [];
  if (!out.insufficient) {
    for (const c of out.claims ?? []) {
      const citations: AnswerCitation[] = [];
      for (const ref of c.citations) {
        const p = passages[ref.passage - 1];
        if (!p) continue;
        citations.push(await toCitation(cfg, search, p, c.text, ref.quote));
      }
      const status = citations.length ? worst(citations.map((x) => x.verification.status)) : "SOURCE_ERROR";
      (status === "VERIFIED" || status === "PARTIALLY_SUPPORTED" ? answered : rejected).push({ text: c.text, citations, status });
    }
  }
  const resultBase = { ...base, mode: "llm" as const, llm: info, rejected_claims: rejected };
  if (!answered.length) {
    const notes = [...base.notes, out.insufficient ? "the model reported insufficient evidence" : "no generated claim passed citation verification"];
    return { ...resultBase, notes, status: "insufficient_evidence", answer: INSUFFICIENT, claims: [], verification: "NONE", formatted: INSUFFICIENT };
  }
  // Only verified claims are shown; the model's free-text answer is replaced by them if any claim was rejected.
  const answer = rejected.length ? answered.map((c) => c.text).join(" ") : out.answer ?? answered.map((c) => c.text).join(" ");
  if (rejected.length) base.notes.push(`${rejected.length} generated claim(s) removed because citation verification failed`);
  const result = { ...resultBase, status: "answered" as const, answer, claims: answered, verification: worst(answered.map((c) => c.status)) };
  return { ...result, formatted: formatAnswer(result) };
}
