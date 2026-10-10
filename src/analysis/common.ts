import type { AppConfig } from "../config.js";
import { normalise } from "../retrieval/text.js";

/** Matters whose keywords appear in a free-text query (used to scope analyses automatically). */
export function inferMatters(cfg: AppConfig, query: string): string[] {
  const q = normalise(query);
  return cfg.matters.filter((m) => m.keywords.some((k) => q.includes(normalise(k))) || q.includes(m.id)).map((m) => m.id);
}

export interface SourceCitation {
  evidence_id: string;
  filename: string;
  title: string | null;
  document_type: string;
  document_date: string | null;
  page: number | null;
  section_id: string | null;
  chunk_id: string;
  quote: string;
}

export function citeLabel(c: Pick<SourceCitation, "evidence_id" | "page" | "section_id">): string {
  return c.page !== null ? `${c.evidence_id}, p.${c.page}` : `${c.evidence_id}, ${c.section_id}`;
}

export const ABSENCE_WARNING =
  "Absence detection is probabilistic. \"No treatment found\" means that no matching passage was found in the indexed text of the target document(s); it is not proof that the document ignores the item. Check the listed sections manually.";

export const COMPARISON_CAVEAT =
  "Relations are machine-suggested from wording and polarity only. A difference in wording is not necessarily a contradiction; every pairing requires human review against the full documents.";
