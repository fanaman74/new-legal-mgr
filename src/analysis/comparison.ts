import type { AppConfig } from "../config.js";
import type { Confidence } from "../evidence/models.js";
import { cosine } from "../retrieval/embeddings.js";
import type { SearchService } from "../retrieval/search.js";
import { contentTokens, coverage, hasNegation, jaccard, splitSentences } from "../retrieval/text.js";
import { COMPARISON_CAVEAT, type SourceCitation } from "./common.js";
import { verifyCitation, type VerificationStatus } from "./verification.js";

/**
 * Position comparison. For an issue, extract propositions (verbatim sentences) from the
 * relevant documents, order them chronologically and pair propositions from different
 * documents that address the same subject:
 *   consistent               same polarity, near-identical meaning;
 *   changed_wording          same polarity, different wording;
 *   possible_tension         opposite polarity, moderately similar subject;
 *   potential_contradiction  opposite polarity, closely similar subject.
 * Labels are suggestions for human review, never conclusions.
 */

export type Relation = "consistent" | "changed_wording" | "possible_tension" | "potential_contradiction";

export interface Proposition {
  id: string;
  text: string;
  polarity: "affirmative" | "negative";
  citation: SourceCitation & { verification: VerificationStatus };
}

export interface PropositionPair {
  a: string;
  b: string;
  relation: Relation;
  similarity: number;
  confidence: Confidence;
  explanation: string;
}

export interface Comparison {
  issue: string;
  matter_filter: string[];
  /** Propositions grouped by document, documents in chronological order. */
  documents: { evidence_id: string; filename: string; title: string | null; document_type: string; document_date: string | null; propositions: Proposition[] }[];
  pairs: PropositionPair[];
  caveat: string;
  notes: string[];
}

export interface ComparisonParams {
  issue: string;
  evidence_ids?: string[] | null;
  matter?: string[] | null;
  max_propositions?: number;
}

export async function comparePositions(cfg: AppConfig, search: SearchService, p: ComparisonParams): Promise<Comparison> {
  const notes: string[] = [];
  // Not scoped automatically to a matter: positions on an issue often sit in other matters' documents.
  const matter = p.matter ?? [];
  const res = await search.search({ query: p.issue, matter, evidence_ids: p.evidence_ids, top_k: 40 }, "compare");
  const index = await search.getIndex();
  const minSim = index.embedder?.minSimilarity ?? 0.3;
  const issueTerms = contentTokens(p.issue);

  // 1. Candidate propositions.
  type Cand = { text: string; relevance: number; r: (typeof res.results)[number] };
  const cands: Cand[] = [];
  // A proposition needs a verb: excludes titles, letterheads, signatures and reference lines.
  const HAS_VERB = /\b(?:is|are|was|were|be|been|being|has|have|had|do|does|did|will|would|shall|should|may|might|must|can|could|states?|relates?|considers?|finds?|notes?|concludes?|confirms?|denies|claims?)\b|\b[a-z]{3,}(?:ed|es)\b/;
  for (const r of res.results) {
    if (r.section_id === "HDR") continue; // email header blocks are metadata, not statements
    for (const s of splitSentences(r.text)) {
      const text = s.text.replace(/^[-•*]\s+/, "");
      if (contentTokens(text).length < 4 || !HAS_VERB.test(text)) continue;
      cands.push({ text, relevance: coverage(issueTerms, contentTokens(text)), r });
    }
  }
  // Relevance to the issue: the better of semantic similarity and rarity-weighted lexical
  // coverage (the sentence read with its heading and document title as context).
  const maxIdf = Math.log(1 + index.items.length + 0.5);
  const w = (t: string) => (index.idf(t) > 0 ? index.idf(t) : maxIdf);
  const issueWeight = issueTerms.reduce((sum, t) => sum + w(t), 0) || 1;
  for (const c of cands) {
    const toks = new Set([...contentTokens(c.text), ...contentTokens(`${c.r.title ?? ""} ${c.r.heading ?? ""}`)]);
    c.relevance = issueTerms.filter((t) => toks.has(t)).reduce((sum, t) => sum + w(t), 0) / issueWeight;
  }
  if (index.embedder && cands.length) {
    const vecs = await index.embed([p.issue, ...cands.map((c) => c.text)], "passage");
    if (vecs) cands.forEach((c, i) => (c.relevance = Math.max(c.relevance, cosine(vecs[0]!, vecs[i + 1]!))));
  }
  const threshold = index.embedder ? minSim + 0.1 : 0.3;
  /** Both statements squarely address the issue. */
  const strongly = index.embedder ? minSim + 0.15 : 0.4;
  // Positions are per document: each retrieved document contributes its most relevant statement
  // if it clears a floor; further statements from the same document must clear the stricter threshold.
  const floor = index.embedder ? minSim : 0.2;
  const perDoc = new Map<string, Cand[]>();
  for (const c of cands.filter((x) => x.relevance >= floor).sort((a, b) => b.relevance - a.relevance)) {
    const list = perDoc.get(c.r.evidence_id) ?? [];
    if (list.length >= 3 || list.some((x) => x.text === c.text)) continue;
    if (list.length > 0 && c.relevance < threshold) continue;
    list.push(c);
    perDoc.set(c.r.evidence_id, list);
  }
  let selected = [...perDoc.values()].flat().sort((a, b) => b.relevance - a.relevance).slice(0, p.max_propositions ?? 18);
  if (!selected.length) notes.push("no sufficiently relevant statements found");

  // 2. Verify and build propositions, ordered chronologically by document date.
  selected = selected.sort((a, b) => (a.r.document_date ?? "9999").localeCompare(b.r.document_date ?? "9999"));
  const props: Proposition[] = [];
  const relevanceOf = new Map<string, number>();
  for (const [i, c] of selected.entries()) {
    const v = await verifyCitation(cfg, { claim: c.text, evidence_id: c.r.evidence_id, chunk_id: c.r.chunk_id, quoted_text: c.text });
    relevanceOf.set(`P${i + 1}`, c.relevance);
    props.push({
      id: `P${i + 1}`,
      text: c.text,
      polarity: hasNegation(c.text) ? "negative" : "affirmative",
      citation: {
        evidence_id: c.r.evidence_id,
        filename: c.r.filename,
        title: c.r.title,
        document_type: c.r.document_type,
        document_date: c.r.document_date,
        page: c.r.page,
        section_id: c.r.section_id,
        chunk_id: c.r.chunk_id,
        quote: c.text,
        verification: v.status,
      },
    });
  }

  // 3. Pairwise relations across documents.
  const vecs = index.embedder && props.length ? await index.embed(props.map((x) => x.text), "passage") : null;
  const strip = (t: string) => contentTokens(t);
  const pairs: PropositionPair[] = [];
  for (let i = 0; i < props.length; i++) {
    for (let j = i + 1; j < props.length; j++) {
      const A = props[i]!;
      const B = props[j]!;
      if (A.citation.evidence_id === B.citation.evidence_id) continue;
      const lex = jaccard(strip(A.text), strip(B.text));
      const sem = vecs ? cosine(vecs[i]!, vecs[j]!) : null;
      const sim = sem !== null ? Math.max(sem, lex) : lex;
      const bothOnIssue = Math.min(relevanceOf.get(A.id) ?? 0, relevanceOf.get(B.id) ?? 0) >= strongly;
      // Both statements speak to the same aspect of the issue (share at least two of its key terms).
      const aspect = new Set(issueTerms.filter((t) => strip(A.text).includes(t) && strip(B.text).includes(t)));
      const related = (sem !== null ? sem >= minSim + 0.15 || lex >= 0.25 : lex >= 0.2) || bothOnIssue || aspect.size >= 2;
      if (!related) continue;
      const close = sem !== null ? sem >= minSim + 0.2 || lex >= 0.45 : lex >= 0.35;
      const same = sem !== null ? sem >= 0.88 || lex >= 0.7 : lex >= 0.6;
      const who = (x: Proposition) => `${x.citation.evidence_id} (${x.citation.document_type.replace(/_/g, " ")}${x.citation.document_date ? `, ${x.citation.document_date}` : ""})`;
      let relation: Relation;
      let confidence: Confidence;
      let explanation: string;
      if (A.polarity !== B.polarity) {
        relation = close ? "potential_contradiction" : "possible_tension";
        confidence = close ? "medium" : "low";
        const neg = A.polarity === "negative" ? A : B;
        const aff = A.polarity === "negative" ? B : A;
        explanation = `${who(aff)} makes an affirmative statement and ${who(neg)} a negated statement on a ${close ? "closely" : "partly"} similar subject. This may indicate ${close ? "a potential contradiction" : "a possible tension"}; check whether both refer to the same fact, person and time.`;
      } else if (same) {
        relation = "consistent";
        confidence = "medium";
        explanation = `${who(A)} and ${who(B)} make materially the same statement.`;
      } else {
        relation = "changed_wording";
        confidence = "low";
        explanation = `${who(A)} and ${who(B)} address a similar subject with different wording; review whether the substance changed.`;
      }
      pairs.push({ a: A.id, b: B.id, relation, similarity: Math.round(sim * 1000) / 1000, confidence, explanation });
    }
  }
  const order: Relation[] = ["potential_contradiction", "possible_tension", "changed_wording", "consistent"];
  const issueScore = (pair: PropositionPair) => (relevanceOf.get(pair.a) ?? 0) + (relevanceOf.get(pair.b) ?? 0) + pair.similarity;
  pairs.sort((x, y) => order.indexOf(x.relation) - order.indexOf(y.relation) || issueScore(y) - issueScore(x));

  const documents: Comparison["documents"] = [];
  for (const prop of props) {
    let d = documents.find((x) => x.evidence_id === prop.citation.evidence_id);
    if (!d) {
      d = { evidence_id: prop.citation.evidence_id, filename: prop.citation.filename, title: prop.citation.title, document_type: prop.citation.document_type, document_date: prop.citation.document_date, propositions: [] };
      documents.push(d);
    }
    d.propositions.push(prop);
  }
  if (!index.embedder) notes.push("semantic model unavailable: relations are based on word overlap only");
  return { issue: p.issue, matter_filter: matter, documents, pairs: pairs.slice(0, 60), caveat: COMPARISON_CAVEAT, notes };
}
