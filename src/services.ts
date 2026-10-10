import type { AppConfig } from "./config.js";
import { answerQuestion, type AskOptions } from "./analysis/answer.js";
import { buildChronology, type ChronologyParams } from "./analysis/chronology.js";
import { comparePositions, type ComparisonParams } from "./analysis/comparison.js";
import { findUnaddressedEvidence, type UnaddressedParams } from "./analysis/unaddressed.js";
import { verifyCitation, type CitationInput } from "./analysis/verification.js";
import { applyCorrections, CorrectionStore } from "./evidence/corrections.js";
import { EvidenceRepository } from "./evidence/repository.js";
import { SearchService, type SearchParams } from "./retrieval/search.js";

/**
 * One facade over retrieval and analysis, shared by the web app, the MCP server, the CLIs and
 * the evaluation runner. Everything here is read-only with respect to evidence.
 */
export class LegalServices {
  readonly search: SearchService;
  private readonly repo: EvidenceRepository;

  constructor(readonly cfg: AppConfig, log: (s: string) => void = () => undefined) {
    this.search = new SearchService(cfg, log);
    this.repo = new EvidenceRepository(cfg);
  }

  searchEvidence(p: SearchParams) {
    return this.search.search(p);
  }

  ask(question: string, opts: AskOptions = {}) {
    return answerQuestion(this.cfg, this.search, question, opts);
  }

  chronology(p: ChronologyParams) {
    return buildChronology(this.cfg, this.search, p);
  }

  compare(p: ComparisonParams) {
    return comparePositions(this.cfg, this.search, p);
  }

  unaddressed(p: UnaddressedParams) {
    return findUnaddressedEvidence(this.cfg, this.search, p);
  }

  async verify(input: CitationInput) {
    return verifyCitation(this.cfg, input, await this.search.getIndex());
  }

  getDocument(evidenceId: string) {
    const record = this.repo.loadCanonical(evidenceId);
    if (!record) return null;
    const effective = applyCorrections(record, new CorrectionStore(this.cfg).forEvidence(evidenceId));
    return {
      record: effective,
      chunks: this.repo.loadChunks(evidenceId).map((c) => ({ chunk_id: c.chunk_id, page: c.page, section_id: c.section_id, heading: c.heading, chars: c.text.length, ocr: c.ocr })),
      relationships: this.repo.loadRelationships().filter((r) => r.subject === evidenceId || r.object === evidenceId),
    };
  }

  /** Exact source text for a citation: one chunk, or every chunk on a page, or the whole document. */
  getPassage(evidenceId: string, opts: { page?: number | null; chunk_id?: string | null } = {}) {
    const record = this.repo.loadCanonical(evidenceId);
    if (!record) return null;
    let chunks = this.repo.loadChunks(evidenceId);
    if (opts.chunk_id) chunks = chunks.filter((c) => c.chunk_id === opts.chunk_id);
    else if (opts.page != null) chunks = chunks.filter((c) => c.page === opts.page);
    return {
      evidence_id: evidenceId,
      filename: record.source.original_filename,
      title: record.document.title,
      document_date: record.document.date,
      sha256: record.source.sha256,
      page_count: record.provenance.page_count,
      passages: chunks.map((c) => ({ chunk_id: c.chunk_id, page: c.page, section_id: c.section_id, heading: c.heading, char_start: c.char_start, char_end: c.char_end, ocr: c.ocr, ocr_confidence: c.ocr_confidence, text: c.text })),
    };
  }
}
