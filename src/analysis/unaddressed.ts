import type { AppConfig } from "../config.js";
import type { Chunk } from "../evidence/models.js";
import { cosine } from "../retrieval/embeddings.js";
import type { SearchService } from "../retrieval/search.js";
import type { EffectiveEvidence } from "../evidence/corrections.js";
import { contentTokens, coverage, normalise, splitSentences, tokenize } from "../retrieval/text.js";
import { ABSENCE_WARNING, inferMatters, type SourceCitation } from "./common.js";

/**
 * Potentially unaddressed evidence (experimental, probabilistic).
 *
 * 1. Items raised by the source submission(s): annex/exhibit references ("Annex B: witness
 *    statement of ...") and files attached to submission emails.
 * 2. Each target document (decision/response) is searched for direct treatment (the item's
 *    label, e.g. "Annex B", or its distinctive terms) and semantic treatment (similar sentences).
 * 3. Classification:
 *      addressed            mentioned, with assessment language ("examined", "considers", ...);
 *      partially_addressed  subject matter discussed without naming the item;
 *      referenced_only      mentioned without any assessment;
 *      uncertain            only a weak semantic match;
 *      no_treatment_found   no match in the indexed text of the target.
 * Always reported with ABSENCE_WARNING.
 */

export type Treatment = "addressed" | "partially_addressed" | "referenced_only" | "no_treatment_found" | "uncertain";

export interface RaisedItem {
  label: string;
  description: string;
  /** Where the item was raised. */
  raised_in: SourceCitation[];
  /** Evidence ID of the item itself when it was submitted as a file. */
  item_evidence_id: string | null;
}

export interface ItemAssessment extends RaisedItem {
  classification: Treatment;
  confidence: number;
  explanation: string;
  best_match: (SourceCitation & { similarity: number | null }) | null;
}

export interface UnaddressedParams {
  /** Submissions raising the evidence (default: complaint/submission documents in the matter). */
  source_evidence_ids?: string[] | null;
  /** Decision/response to examine (default: the latest official decision in the matter). */
  target_evidence_ids?: string[] | null;
  query?: string | null;
  matter?: string[] | null;
}

export interface UnaddressedReport {
  sources: { evidence_id: string; filename: string; document_date: string | null }[];
  targets: { evidence_id: string; filename: string; document_date: string | null }[];
  sections_searched: { evidence_id: string; chunk_id: string; page: number | null; section_id: string | null; heading: string | null }[];
  items: ItemAssessment[];
  warning: string;
  notes: string[];
}

const ASSESSMENT = /\b(examin\w*|consider\w*|assess\w*|finds?|found|notes?|noted|conclud\w*|establish\w*|constitut\w*|takes? the view|reject\w*|accept\w*|dismiss\w*|in this regard|as regards|regarding|evaluat\w*|reviewed|analys\w*|is not relevant|irrelevant|prove[sd]?|demonstrat\w*|credib\w*)\b/i;
const ITEM_REF = /\b(Annex(?:e)?|Exhibit|Appendix|Attachment|Enclosure)\s+([A-Z]\.?\d{1,3}|[A-Z]|\d{1,3})\b\s*[:\-–(]?\s*([^\n;]{0,180})/g;
/** Words that do not distinguish one item from another. */
const GENERIC = new Set(["ms", "mr", "mrs", "dr", "annex", "exhibit", "appendix", "attachment", "enclosure", "dated", "date", "document", "copy", "submitted", "provided", "attached", "letter", "pdf", "docx", "msg", "eml"]);

function cite(rec: EffectiveEvidence, c: Chunk, quote: string): SourceCitation {
  return {
    evidence_id: rec.evidence_id,
    filename: rec.source.original_filename,
    title: rec.document.title,
    document_type: rec.document.document_type,
    document_date: rec.document.date,
    page: c.page,
    section_id: c.section_id,
    chunk_id: c.chunk_id,
    quote,
  };
}

function anchorToken(label: string): string | null {
  return tokenize(label).find((t) => t.startsWith("annex:")) ?? null;
}

export async function findUnaddressedEvidence(cfg: AppConfig, search: SearchService, p: UnaddressedParams): Promise<UnaddressedReport> {
  const index = await search.getIndex();
  const notes: string[] = [];
  let matter = p.matter ?? [];
  if (!matter.length && p.query) matter = inferMatters(cfg, p.query);
  const inMatter = (r: EffectiveEvidence) => !matter.length || r.document.matter.some((m) => matter.includes(m));
  const all = [...index.records.values()];

  const sources = p.source_evidence_ids?.length
    ? p.source_evidence_ids.map((id) => index.records.get(id)).filter((r): r is EffectiveEvidence => Boolean(r))
    : all.filter((r) => inMatter(r) && r.document.document_type === "complaint_submission");
  const decisions = all.filter((r) => inMatter(r) && r.document.document_type === "official_decision").sort((a, b) => (b.document.date ?? "").localeCompare(a.document.date ?? ""));
  const targets = p.target_evidence_ids?.length
    ? p.target_evidence_ids.map((id) => index.records.get(id)).filter((r): r is EffectiveEvidence => Boolean(r))
    : decisions.slice(0, 1);
  if (!p.source_evidence_ids?.length) notes.push(`sources: complaint/submission documents${matter.length ? ` in matter ${matter.join(", ")}` : ""}`);
  if (!p.target_evidence_ids?.length) notes.push("target: the most recent official decision in scope");

  const report: UnaddressedReport = {
    sources: sources.map((r) => ({ evidence_id: r.evidence_id, filename: r.source.original_filename, document_date: r.document.date })),
    targets: targets.map((r) => ({ evidence_id: r.evidence_id, filename: r.source.original_filename, document_date: r.document.date })),
    sections_searched: [],
    items: [],
    warning: ABSENCE_WARNING,
    notes,
  };
  if (!sources.length || !targets.length) {
    notes.push(!sources.length ? "no source submission found" : "no target decision found");
    return report;
  }

  // 1. Items raised in the sources.
  const items = new Map<string, RaisedItem>();
  const addItem = (label: string, description: string, citation: SourceCitation | null, evidenceId: string | null) => {
    const key = anchorToken(label) ?? normalise(label);
    const existing = items.get(key);
    if (existing) {
      if (description.length > existing.description.length) existing.description = description;
      if (citation && !existing.raised_in.some((c) => c.chunk_id === citation.chunk_id)) existing.raised_in.push(citation);
      existing.item_evidence_id ??= evidenceId;
    } else {
      items.set(key, { label, description, raised_in: citation ? [citation] : [], item_evidence_id: evidenceId });
    }
  };
  const sourceIds = new Set(sources.map((s) => s.evidence_id));
  for (const src of sources) {
    for (const c of index.chunksOf(src.evidence_id)) {
      for (const m of c.text.matchAll(ITEM_REF)) {
        const label = `${m[1]!.replace(/e$/, "")} ${m[2]}`;
        const description = (m[3] ?? "").replace(/\s+/g, " ").replace(/[.)\s]+$/, "").trim();
        const sentence = splitSentences(c.text).find((s) => s.start <= m.index! && s.end >= m.index!)?.text ?? m[0];
        addItem(label, description, cite(src, c, sentence), null);
      }
    }
    // Emails that carried the submission: their other attachments were submitted too.
    for (const parentId of src.attachment_of) {
      const parent = index.records.get(parentId);
      if (!parent) continue;
      for (const att of parent.attachments) {
        if (!att.evidence_id || sourceIds.has(att.evidence_id)) continue;
        const child = index.records.get(att.evidence_id);
        const name = (att.filename ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ");
        const anchor = /\b(annex(?:e)?|exhibit|appendix)\s+([a-z]\.?\d{1,3}|[a-z]|\d{1,3})\b/i.exec(name);
        const label = anchor ? `Annex ${anchor[2]!.toUpperCase()}` : att.filename ?? att.evidence_id;
        const hdr = index.chunksOf(parentId).find((x) => x.section_id === "HDR");
        addItem(label, [child?.document.title, name].filter(Boolean).join(" - "), hdr ? cite(parent, hdr, `Attachments: ${att.filename}`) : null, att.evidence_id);
      }
    }
  }

  // 2. Target sentences.
  const targetSentences: { text: string; chunk: Chunk; rec: EffectiveEvidence }[] = [];
  for (const t of targets) {
    if (t.provenance.status !== "parsed") notes.push(`${t.evidence_id} was only partly extracted (${t.provenance.status}); results are less reliable`);
    for (const c of index.chunksOf(t.evidence_id)) {
      report.sections_searched.push({ evidence_id: t.evidence_id, chunk_id: c.chunk_id, page: c.page, section_id: c.section_id, heading: c.heading });
      for (const s of splitSentences(c.text)) targetSentences.push({ text: s.text, chunk: c, rec: t });
    }
  }
  const sentenceVecs = index.embedder && targetSentences.length ? await index.embed(targetSentences.map((s) => s.text), "passage") : null;
  const minSim = index.embedder?.minSimilarity ?? 1;

  // 3. Assess each item.
  for (const item of items.values()) {
    const anchor = anchorToken(item.label);
    const descTerms = [...new Set(contentTokens(item.description))].filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t));
    let direct: { s: (typeof targetSentences)[number]; how: string } | null = null;
    for (const s of targetSentences) {
      const toks = tokenize(s.text);
      if (anchor && toks.includes(anchor)) {
        direct = { s, how: `names ${item.label}` };
        break;
      }
      if (descTerms.length >= 2 && coverage(descTerms, contentTokens(s.text)) >= 0.6) {
        direct = { s, how: `matches the item's description (${descTerms.filter((t) => contentTokens(s.text).includes(t)).join(", ")})` };
        break;
      }
    }
    let semBest: { s: (typeof targetSentences)[number]; sim: number } | null = null;
    if (sentenceVecs && item.description) {
      // Compare the description only: the label ("Annex B") would match any other annex reference.
      const [iv] = (await index.embed([item.description], "query")) ?? [];
      if (iv) {
        sentenceVecs.forEach((v, i) => {
          const sim = cosine(iv, v);
          if (!semBest || sim > semBest.sim) semBest = { s: targetSentences[i]!, sim };
        });
      }
    }
    const sem = semBest as { s: (typeof targetSentences)[number]; sim: number } | null;

    let classification: Treatment;
    let confidence: number;
    let explanation: string;
    let match: (typeof targetSentences)[number] | null = null;
    if (direct) {
      match = direct.s;
      // Assessment language may sit in the sentence itself or in its immediate neighbours.
      const sents = splitSentences(direct.s.chunk.text).map((x) => x.text);
      const at = sents.indexOf(direct.s.text);
      const window = sents.slice(Math.max(0, at - 1), at + 2).join(" ");
      if (ASSESSMENT.test(direct.s.text) || ASSESSMENT.test(window)) {
        classification = "addressed";
        confidence = 0.8;
        explanation = `The target ${direct.how} in a passage containing assessment language ("${(ASSESSMENT.exec(direct.s.text) ?? ASSESSMENT.exec(window))![0]}").`;
      } else {
        classification = "referenced_only";
        confidence = 0.6;
        explanation = `The target ${direct.how}, but no assessment language was found around the reference; it may only be mentioned.`;
      }
    } else if (sem && sem.sim >= minSim + 0.25) {
      match = sem.s;
      classification = "partially_addressed";
      confidence = 0.5;
      explanation = `The target does not name ${item.label}, but a passage discusses closely similar subject matter (similarity ${sem.sim.toFixed(2)}).`;
    } else if (sem && sem.sim >= minSim + 0.15) {
      match = sem.s;
      classification = "uncertain";
      confidence = 0.35;
      explanation = `No direct reference to ${item.label}; only a weak semantic match (similarity ${sem.sim.toFixed(2)}). Manual review needed.`;
    } else {
      classification = "no_treatment_found";
      const reliable = targets.every((t) => t.provenance.status === "parsed" && !t.provenance.ocr_pages.length);
      confidence = reliable ? 0.7 : 0.45;
      explanation = `Neither "${item.label}" nor its distinctive terms (${descTerms.slice(0, 6).join(", ") || "none"}) appear in the ${report.sections_searched.length} searched section(s) of the target, and no semantically similar passage was found.`;
    }
    report.items.push({
      ...item,
      classification,
      confidence,
      explanation,
      best_match: match
        ? { ...cite(match.rec, match.chunk, match.text), similarity: sem && sem.s === match ? Math.round(sem.sim * 1000) / 1000 : null }
        : null,
    });
  }
  const order: Treatment[] = ["no_treatment_found", "uncertain", "referenced_only", "partially_addressed", "addressed"];
  report.items.sort((a, b) => order.indexOf(a.classification) - order.indexOf(b.classification) || a.label.localeCompare(b.label));
  return report;
}
