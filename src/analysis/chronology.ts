import type { AppConfig } from "../config.js";
import type { Confidence } from "../evidence/models.js";
import { extractDateCandidates } from "../ingestion/metadata.js";
import type { SearchResult, SearchService } from "../retrieval/search.js";
import { contentTokens, jaccard, splitSentences } from "../retrieval/text.js";
import { inferMatters, type SourceCitation } from "./common.js";
import { verifyCitation, type VerificationStatus } from "./verification.js";

/**
 * Chronology service. Deterministic: events come from
 *  - sentences that state a date explicitly ("On 17 January 2025 Ms Doe submitted ...")  [explicit]
 *  - email sent timestamps (native metadata)                                            [explicit]
 *  - document dates (letterhead/"Date:" lines; unlabelled dates are marked inferred)   [document_date]
 * Every event cites its source passage, and each citation is verified. Duplicate events
 * (same date, similar wording) are merged; corroboration by several documents raises confidence.
 */

export interface TimelineEvent {
  date: string;
  date_type: "explicit" | "email_sent" | "document_date";
  /** The date exactly as written in the source (e.g. "20 January 2025"). */
  date_text: string;
  /** True when the date was not stated as the date of this event (e.g. an unlabelled document date). */
  inferred: boolean;
  event: string;
  citations: (SourceCitation & { verification: VerificationStatus })[];
  confidence: Confidence;
  corroborating_documents: number;
  notes: string[];
}

export interface ChronologyParams {
  query: string;
  matter?: string[] | null;
  date_from?: string | null;
  date_to?: string | null;
  evidence_ids?: string[] | null;
  max_events?: number;
}

export interface Chronology {
  query: string;
  matter_filter: string[];
  events: TimelineEvent[];
  documents_considered: number;
  notes: string[];
}

const SECONDARY = new Set(["notes"]);

function cite(r: SearchResult, quote: string): SourceCitation {
  return {
    evidence_id: r.evidence_id,
    filename: r.filename,
    title: r.title,
    document_type: r.document_type,
    document_date: r.document_date,
    page: r.page,
    section_id: r.section_id,
    chunk_id: r.chunk_id,
    quote,
  };
}

export async function buildChronology(cfg: AppConfig, search: SearchService, p: ChronologyParams): Promise<Chronology> {
  const notes: string[] = [];
  let matter = p.matter ?? [];
  if (!matter.length && !p.evidence_ids?.length) {
    matter = inferMatters(cfg, p.query);
    if (matter.length) notes.push(`scoped to matter(s) ${matter.join(", ")} inferred from the question`);
  }
  const res = await search.search({ query: p.query, matter, evidence_ids: p.evidence_ids, top_k: 100 }, "chronology");
  const index = await search.getIndex();
  // With a matter or document scope, every passage in scope is relevant; otherwise use retrieval relevance.
  const scoped = matter.length > 0 || Boolean(p.evidence_ids?.length);
  const relevant = scoped
    ? res.results
    : res.results.filter((r) => r.lexical_rank !== null || (r.semantic_similarity ?? 0) >= (index.embedder?.minSimilarity ?? 1));
  if (scoped && res.filtered_candidates > res.results.length) notes.push(`${res.filtered_candidates - res.results.length} lower-ranked passage(s) in scope were not examined`);

  type RawEvent = Omit<TimelineEvent, "citations" | "confidence" | "corroborating_documents"> & {
    cite: SourceCitation;
    ocrLow: boolean;
    secondary: boolean;
    dateConfidence: Confidence | null;
  };
  const events: RawEvent[] = [];

  // 1. Explicitly dated sentences.
  for (const r of relevant) {
    const ocrLow = r.ocr && (r.ocr_confidence ?? 0) < 80;
    for (const s of splitSentences(r.text)) {
      const sentence = s.text.replace(/^[-•*]\s+/, "");
      const dates = extractDateCandidates(sentence, r.page, r.chunk_id).filter((d) => !d.ambiguous);
      if (!dates.length) continue;
      for (const d of dates) {
        // Letterhead/date lines ("Brussels, 12 May 2025", "Date: 7 February 2025") are document dates, handled below.
        const prefix = sentence.slice(0, sentence.indexOf(d.raw));
        if (/^\s*(?:[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?,\s*|(?:Date[d]?|Dated)\s*:?\s*)$/u.test(prefix)) continue;
        if (contentTokens(sentence.replace(d.raw, "")).length < 2) continue;
        events.push({
          date: d.value,
          date_type: "explicit",
          date_text: d.raw,
          inferred: false,
          event: sentence.length > 320 ? `${sentence.slice(0, 317)}...` : sentence,
          notes: [],
          cite: cite(r, sentence),
          ocrLow,
          secondary: SECONDARY.has(r.document_type),
          dateConfidence: null,
        });
      }
    }
  }

  // 2. Documents and emails behind the relevant passages.
  const docIds = [...new Set(relevant.map((r) => r.evidence_id))];
  for (const id of docIds) {
    const rec = index.records.get(id);
    if (!rec || !rec.document.date) continue;
    const chunks = index.chunksOf(id);
    const asResult = (chunkId: string, quote: string): SourceCitation => {
      const c = chunks.find((x) => x.chunk_id === chunkId) ?? chunks[0]!;
      return {
        evidence_id: id,
        filename: rec.source.original_filename,
        title: rec.document.title,
        document_type: rec.document.document_type,
        document_date: rec.document.date,
        page: c.page,
        section_id: c.section_id,
        chunk_id: c.chunk_id,
        quote,
      };
    };
    const label = rec.document.title ?? rec.source.original_filename;
    if (rec.email?.sent_at) {
      const hdr = chunks.find((c) => c.section_id === "HDR");
      if (!hdr) continue;
      const sentLine = hdr.text.split("\n").find((l) => l.startsWith("Sent:")) ?? hdr.text.split("\n")[0]!;
      const from = rec.email.from?.name ?? rec.email.from?.address ?? "unknown sender";
      events.push({
        date: rec.document.date,
        date_type: "email_sent",
        date_text: rec.email.sent_at,
        inferred: false,
        event: `Email "${rec.email.subject ?? "(no subject)"}" sent by ${from}${rec.attachments.length ? ` with ${rec.attachments.length} attachment(s)` : ""}`,
        notes: [rec.document.date_basis ?? ""].filter(Boolean),
        cite: asResult(hdr.chunk_id, sentLine),
        ocrLow: false,
        secondary: false,
        dateConfidence: "high",
      });
      continue;
    }
    const cand = rec.document.date_candidates.find((d) => d.value === rec.document.date && d.chunk_id);
    if (!cand) continue;
    const chunk = chunks.find((c) => c.chunk_id === cand.chunk_id);
    const line = chunk?.text.split("\n").find((l) => l.includes(cand.raw)) ?? cand.raw;
    const inferredFromCorrection = rec.corrections_applied.some((c) => c.field === "document.date");
    events.push({
      date: rec.document.date,
      date_type: "document_date",
      date_text: cand.raw,
      inferred: !cand.labelled && !inferredFromCorrection,
      event: `${rec.document.document_type.replace(/_/g, " ")}: ${label} (document date)`,
      notes: [rec.document.date_basis ?? ""].filter(Boolean),
      cite: asResult(cand.chunk_id!, line.trim()),
      ocrLow: Boolean(chunk?.ocr && (chunk.ocr_confidence ?? 0) < 80),
      secondary: SECONDARY.has(rec.document.document_type),
      dateConfidence: rec.document.date_confidence,
    });
  }

  // 3. Merge duplicates: same date and similar wording, or identical source quote.
  const merged: TimelineEvent[] = [];
  const groups: RawEvent[][] = [];
  for (const e of events) {
    if (p.date_from && e.date < p.date_from) continue;
    if (p.date_to && e.date > p.date_to) continue;
    const toks = contentTokens(e.event);
    const g = groups.find(
      (grp) => grp[0]!.date === e.date && grp[0]!.date_type === e.date_type && (jaccard(contentTokens(grp[0]!.event), toks) >= 0.5 || grp.some((x) => x.cite.chunk_id === e.cite.chunk_id && x.cite.quote === e.cite.quote)),
    );
    if (g) g.push(e);
    else groups.push([e]);
  }
  for (const g of groups) {
    // Prefer a primary source's wording as the event text.
    const lead = g.find((x) => !x.secondary) ?? g[0]!;
    const docs = new Set(g.map((x) => x.cite.evidence_id));
    const primaryDocs = new Set(g.filter((x) => !x.secondary).map((x) => x.cite.evidence_id));
    let confidence: Confidence;
    if (lead.date_type === "email_sent") confidence = "high";
    else if (lead.date_type === "document_date") confidence = lead.dateConfidence === "medium" && !lead.inferred ? "medium" : "low";
    else confidence = primaryDocs.size >= 2 ? "high" : primaryDocs.size === 1 ? "medium" : "low";
    if (g.every((x) => x.ocrLow)) confidence = "low";
    const evNotes = [...new Set(g.flatMap((x) => x.notes))];
    if (!primaryDocs.size) evNotes.push("only supported by secondary material (e.g. working notes)");
    if (g.some((x) => x.ocrLow)) evNotes.push("partly based on OCR text with low confidence");
    const citations = [];
    const seen = new Set<string>();
    for (const x of g) {
      const key = `${x.cite.chunk_id}|${x.cite.quote}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const v = await verifyCitation(cfg, { claim: x.cite.quote, evidence_id: x.cite.evidence_id, chunk_id: x.cite.chunk_id, quoted_text: x.cite.quote });
      citations.push({ ...x.cite, verification: v.status });
    }
    const verified = citations.filter((c) => c.verification === "VERIFIED" || c.verification === "PARTIALLY_SUPPORTED");
    if (!verified.length) continue; // never emit an uncited event
    merged.push({
      date: lead.date,
      date_type: lead.date_type,
      date_text: lead.date_text,
      inferred: lead.inferred,
      event: lead.event,
      citations: verified,
      confidence,
      corroborating_documents: docs.size,
      notes: evNotes,
    });
  }

  const typeOrder = { explicit: 0, email_sent: 1, document_date: 2 } as const;
  merged.sort((a, b) => a.date.localeCompare(b.date) || typeOrder[a.date_type] - typeOrder[b.date_type]);
  return {
    query: p.query,
    matter_filter: matter,
    events: merged.slice(0, p.max_events ?? 200),
    documents_considered: docIds.length,
    notes,
  };
}
