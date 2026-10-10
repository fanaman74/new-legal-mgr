import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AuditLog } from "../audit.js";
import { EvidenceRegistry, type RegistryEntry } from "../evidence/ids.js";
import { EvidenceRepository } from "../evidence/repository.js";
import type { AttachmentRef, CanonicalEvidence, DateCandidate, IngestionStatusRecord, SourceRoot } from "../evidence/models.js";
import { ensureDir, protectDirectory, safeWriteNewFile } from "../util/fs-guard.js";
import { chunkUnits } from "./chunking.js";
import { listFiles, matchesIgnore, sha256Bytes, sha256File, toPosixRelative } from "./hashing.js";
import {
  chooseDocumentDate,
  classifyDocumentType,
  classifyMatters,
  detectFormat,
  extractDateCandidates,
  type DetectedFormat,
} from "./metadata.js";
import { formatAddress, safeAttachmentName } from "./parsers/email-common.js";
import { parseDocx } from "./parsers/docx.js";
import { parseEml } from "./parsers/eml.js";
import { parseMsg } from "./parsers/msg.js";
import { OcrEngine } from "./parsers/ocr.js";
import { parsePdf } from "./parsers/pdf.js";
import { parseText } from "./parsers/text.js";
import type { ParseOutput, ParserContext } from "./parsers/types.js";

/**
 * Ingestion pipeline (Milestone 1). Deterministic; no LLM involved.
 *
 * For each file under the originals directory (sorted, for reproducible ID allocation):
 *   hash -> register Evidence ID -> detect format -> parse -> chunk -> metadata ->
 *   write extracted/<EVID>.md, .structure.json, .chunks.jsonl and canonical/<EVID>.json
 * Email attachments are written to data/attachments/<parent EVID>/ and ingested recursively.
 *
 * Originals are only ever read. A failure on one file is recorded and the batch continues.
 */

const MAX_ATTACHMENT_DEPTH = 8;

export interface IngestOptions {
  log?: (line: string) => void;
}

export interface IngestSummary {
  files_seen: number;
  new_evidence: number;
  parsed: number;
  partial: number;
  failed: number;
  unsupported: number;
  duplicates: number;
  unchanged: number;
  skipped: number;
  attachments_extracted: number;
  attachments_not_extracted: number;
  /** Registered original paths that no longer exist (renamed, moved or deleted copies). */
  missing_originals: string[];
  records: IngestionStatusRecord[];
}

interface WorkItem {
  sourceRoot: SourceRoot;
  absPath: string;
  relativePath: string;
  originalFilename: string;
  parent: string | null;
  depth: number;
}

function readHead(file: string, bytes = 4096): Uint8Array {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Original filename for a registry path: extracted attachments carry an "NN_" index prefix. */
function filenameFromPath(item: WorkItem): string {
  const base = path.basename(item.relativePath);
  return item.sourceRoot === "attachments" ? base.replace(/^\d{2}_/, "") : base;
}

export class Ingestor {
  private readonly registry: EvidenceRegistry;
  private readonly repo: EvidenceRepository;
  private readonly audit: AuditLog;
  private ocr: OcrEngine | null = null;
  private readonly inProgress = new Set<string>();
  private readonly log: (line: string) => void;
  private summary: IngestSummary = {
    files_seen: 0,
    new_evidence: 0,
    parsed: 0,
    partial: 0,
    failed: 0,
    unsupported: 0,
    duplicates: 0,
    unchanged: 0,
    skipped: 0,
    attachments_extracted: 0,
    attachments_not_extracted: 0,
    missing_originals: [],
    records: [],
  };

  constructor(private readonly cfg: AppConfig, opts: IngestOptions = {}) {
    if (!existsSync(cfg.originalsDir)) throw new Error(`Originals directory does not exist: ${cfg.originalsDir}`);
    protectDirectory(cfg.originalsDir);
    for (const dir of [cfg.dataDir, cfg.extractedDir, cfg.canonicalDir, cfg.attachmentsDir, cfg.indexesDir, cfg.correctionsDir]) ensureDir(dir);
    this.registry = EvidenceRegistry.load(cfg.indexesDir);
    this.repo = new EvidenceRepository(cfg);
    this.audit = new AuditLog(cfg.auditLog);
    this.log = opts.log ?? (() => undefined);
  }

  private get parserContext(): ParserContext {
    return { minTextCharsPerPage: this.cfg.pdf.minTextCharsPerPage, ocrRenderScale: this.cfg.pdf.ocrRenderScale, ocr: this.cfg.ocr };
  }

  private getOcr(): OcrEngine | null {
    if (!this.cfg.ocr.enabled) return null;
    this.ocr ??= new OcrEngine({ langs: this.cfg.ocr.langs, langPath: this.cfg.ocr.langPath });
    return this.ocr;
  }

  async run(): Promise<IngestSummary> {
    try {
      for (const file of listFiles(this.cfg.originalsDir)) {
        const item: WorkItem = {
          sourceRoot: "originals",
          absPath: file,
          relativePath: toPosixRelative(this.cfg.originalsDir, file),
          originalFilename: path.basename(file),
          parent: null,
          depth: 0,
        };
        try {
          await this.process(item);
        } catch (err) {
          // Unexpected errors (unreadable file, I/O error) must not stop the batch.
          const message = (err as Error).message.slice(0, 500);
          this.summary.failed++;
          this.audit.record({ action: "PARSE_FAILED", relative_path: item.relativePath, detail: message });
          this.status(item, null, "failed", null, message);
        }
        this.registry.save();
      }
      this.summary.missing_originals = this.registry
        .all()
        .flatMap((e) => e.paths)
        .filter((p) => p.source_root === "originals" && !existsSync(path.join(this.cfg.originalsDir, p.relative_path)))
        .map((p) => p.relative_path);
    } finally {
      this.registry.save();
      await this.ocr?.close();
    }
    return this.summary;
  }

  private status(item: WorkItem, evidenceId: string | null, status: IngestionStatusRecord["status"], parser: string | null, error: string | null): void {
    const rec: IngestionStatusRecord = {
      evidence_id: evidenceId,
      source_root: item.sourceRoot,
      relative_path: item.relativePath,
      status,
      error,
      parser,
      timestamp: new Date().toISOString(),
    };
    this.repo.recordStatus(rec);
    this.summary.records.push(rec);
    this.log(`${(evidenceId ?? "-").padEnd(11)}  ${status.padEnd(11)}  ${item.sourceRoot}/${item.relativePath}${error ? `  (${error})` : ""}`);
  }

  /** Process one file; returns its Evidence ID (or null if skipped). */
  private async process(item: WorkItem): Promise<string | null> {
    if (item.parent === null) this.summary.files_seen++;
    if (matchesIgnore(path.basename(item.absPath), this.cfg.ingestion.ignorePatterns)) {
      this.summary.skipped++;
      this.audit.record({ action: "SKIPPED", relative_path: item.relativePath, detail: "matches ignore pattern" });
      this.status(item, null, "skipped", null, null);
      return null;
    }

    const sha256 = await sha256File(item.absPath);
    const size = statSync(item.absPath).size;
    const reg = this.registry.register({
      sha256,
      sizeBytes: size,
      sourceRoot: item.sourceRoot,
      relativePath: item.relativePath,
      parent: item.parent ?? undefined,
    });
    const evidenceId = reg.entry.evidence_id;
    if (item.parent) {
      this.repo.addRelationship({
        subject: evidenceId,
        predicate: "attachment_of",
        object: item.parent,
        source: "extracted",
        confidence: 1,
        detail: `extracted from email attachment "${item.originalFilename}"`,
        timestamp: new Date().toISOString(),
      });
    }

    const existing = this.repo.loadCanonical(evidenceId);
    if (!reg.created) {
      if (reg.duplicateOfExisting) {
        this.summary.duplicates++;
        this.audit.record({
          action: "DUPLICATE",
          evidence_id: evidenceId,
          sha256,
          relative_path: item.relativePath,
          source_root: item.sourceRoot,
          detail: `identical content already registered at ${reg.entry.paths[0]!.source_root}/${reg.entry.paths[0]!.relative_path}`,
        });
      }
      const upToDate = existing && existing.provenance.status !== "failed" && !this.cfg.ingestion.forceReparse;
      if (upToDate || this.inProgress.has(evidenceId)) {
        if (existing) this.refreshLinks(existing, reg.entry);
        this.summary.unchanged += reg.duplicateOfExisting ? 0 : 1;
        this.audit.record({ action: "INGEST_UNCHANGED", evidence_id: evidenceId, sha256 });
        this.status(item, evidenceId, reg.duplicateOfExisting ? "duplicate" : "unchanged", existing?.provenance.parser ?? null, null);
        return evidenceId;
      }
    } else {
      this.summary.new_evidence++;
    }
    // Parse under the entry's primary path so the canonical record is stable, unless that copy
    // no longer exists (e.g. it was renamed), in which case the path just discovered is used.
    const primary = reg.entry.paths[0]!;
    const primaryAbs = path.join(primary.source_root === "originals" ? this.cfg.originalsDir : this.cfg.attachmentsDir, primary.relative_path);
    const primaryItem: WorkItem =
      (primary.source_root === item.sourceRoot && primary.relative_path === item.relativePath) || !existsSync(primaryAbs)
        ? item
        : { ...item, sourceRoot: primary.source_root, relativePath: primary.relative_path, absPath: primaryAbs };
    this.inProgress.add(evidenceId);
    try {
      await this.parseAndStore(primaryItem, reg.entry, item);
    } finally {
      this.inProgress.delete(evidenceId);
    }
    return evidenceId;
  }

  /** Keep alias paths / parents of an existing canonical record in sync with the registry. */
  private refreshLinks(record: CanonicalEvidence, entry: RegistryEntry): void {
    const aliases = entry.paths.slice(1).map((p) => ({ source_root: p.source_root, relative_path: p.relative_path }));
    if (JSON.stringify(aliases) !== JSON.stringify(record.source.alias_paths) || JSON.stringify(entry.parents) !== JSON.stringify(record.attachment_of)) {
      record.source.alias_paths = aliases;
      record.attachment_of = [...entry.parents];
      this.repo.saveCanonical(record);
    }
  }

  private async runParser(format: DetectedFormat, data: Uint8Array): Promise<ParseOutput> {
    switch (format.kind) {
      case "pdf":
        return parsePdf(data, this.parserContext, this.getOcr());
      case "docx":
        return parseDocx(data);
      case "msg":
        return parseMsg(data);
      case "eml":
        return parseEml(data);
      case "text":
        return parseText(data, format.mimeType === "text/markdown");
      default:
        throw new Error(`unsupported format ${format.mimeType}`);
    }
  }

  private async parseAndStore(item: WorkItem, entry: RegistryEntry, discoveredAs: WorkItem): Promise<void> {
    const evidenceId = entry.evidence_id;
    const format = detectFormat(item.absPath, readHead(item.absPath)); // a read error here is caught per file in run()
    const now = new Date().toISOString();
    const parentRecords = entry.parents.map((p) => this.repo.loadCanonical(p)).filter((r): r is CanonicalEvidence => Boolean(r));

    const record: CanonicalEvidence = {
      schema_version: 1,
      evidence_id: evidenceId,
      source: {
        original_filename: item === discoveredAs ? item.originalFilename : filenameFromPath(item),
        source_root: item.sourceRoot,
        relative_path: item.relativePath,
        alias_paths: entry.paths.slice(1).map((p) => ({ source_root: p.source_root, relative_path: p.relative_path })),
        sha256: entry.sha256,
        mime_type: format.mimeType,
        size_bytes: entry.size_bytes,
      },
      document: {
        title: null,
        title_source: null,
        document_type: "unknown",
        document_type_confidence: null,
        document_type_basis: null,
        matter: [],
        matter_basis: [],
        date: null,
        date_confidence: null,
        date_basis: null,
        date_candidates: [],
        author: [],
        recipients: [],
        language: null,
      },
      provenance: {
        parser: "none",
        parser_version: "n/a",
        ingestion_timestamp: now,
        page_count: null,
        ocr_pages: [],
        status: "parsed",
        warnings: format.warning ? [format.warning] : [],
        error: null,
        embedded_metadata: {},
      },
      content: { markdown_path: null, structured_json_path: null, chunks_path: null, chunk_count: 0, char_count: 0 },
      email: null,
      attachments: [],
      attachment_of: [...entry.parents],
      classification: { tags: [], privilege: "unknown", source_type: "unknown", confidence: null },
    };

    // Matter from folder placement / keywords, plus inheritance from parent emails.
    const applyMatters = (openingText: string) => {
      const matters = classifyMatters({ relativePath: item.sourceRoot === "originals" ? item.relativePath : record.source.original_filename, openingText, rules: this.cfg.matters });
      for (const parent of parentRecords) {
        for (const m of parent.document.matter) {
          if (!matters.some((x) => x.matter === m)) matters.push({ matter: m, confidence: "medium", basis: `inherited from parent email ${parent.evidence_id}` });
        }
      }
      record.document.matter = matters.map((m) => m.matter);
      record.document.matter_basis = matters;
    };

    if (format.kind === "unsupported") {
      record.provenance.status = "unsupported";
      record.provenance.warnings.push(`format ${format.mimeType} is not parsed; registered with hash only`);
      applyMatters("");
      this.repo.saveCanonical(record);
      this.summary.unsupported++;
      this.audit.record({ action: "UNSUPPORTED", evidence_id: evidenceId, sha256: entry.sha256, detail: format.mimeType });
      this.status(discoveredAs, evidenceId, "unsupported", null, null);
      return;
    }

    let parsed: ParseOutput;
    try {
      const data = new Uint8Array(readFileSync(item.absPath)); // read-only access to the source
      if (sha256Bytes(data) !== entry.sha256) throw new Error("file changed while being ingested (hash mismatch)");
      parsed = await this.runParser(format, data);
    } catch (err) {
      const message = (err as Error).message.slice(0, 500);
      record.provenance.status = "failed";
      record.provenance.error = message;
      record.provenance.parser = format.kind;
      applyMatters("");
      this.repo.saveCanonical(record);
      this.summary.failed++;
      this.audit.record({ action: "PARSE_FAILED", evidence_id: evidenceId, sha256: entry.sha256, parser: format.kind, detail: message });
      this.status(discoveredAs, evidenceId, "failed", format.kind, message);
      return;
    }

    // Chunks and generated artefacts.
    const chunks = chunkUnits(parsed.units, {
      evidenceId,
      filename: record.source.original_filename,
      parser: parsed.parser,
      targetChars: this.cfg.chunking.targetChars,
      maxChars: this.cfg.chunking.maxChars,
    });
    const md = `<!-- ${evidenceId} | ${record.source.original_filename} | sha256 ${entry.sha256} | parser ${parsed.parser} -->\n\n${parsed.markdown}\n`;
    record.content = {
      markdown_path: this.repo.dataRelative(this.repo.saveMarkdown(evidenceId, md)),
      structured_json_path: this.repo.dataRelative(
        this.repo.saveStructure(evidenceId, {
          evidence_id: evidenceId,
          parser: parsed.parser,
          note: "char offsets in blocks and chunks are relative to each unit's text",
          units: parsed.units,
        }),
      ),
      chunks_path: this.repo.dataRelative(this.repo.saveChunks(evidenceId, chunks)),
      chunk_count: chunks.length,
      char_count: parsed.units.reduce((n, u) => n + u.text.length, 0),
    };

    record.provenance = {
      ...record.provenance,
      parser: parsed.parser,
      parser_version: parsed.parserVersion,
      page_count: parsed.pageCount,
      ocr_pages: parsed.ocrPages,
      status: parsed.status,
      warnings: [...record.provenance.warnings, ...parsed.warnings],
      embedded_metadata: parsed.embeddedMetadata,
    };
    if (parsed.title) {
      record.document.title = parsed.title.value;
      record.document.title_source = parsed.title.source;
    }

    // Dates: explicit candidates from the opening of the document.
    const firstPage = chunks.find((c) => c.page !== null)?.page ?? null;
    const opening = chunks.filter((c, i) => (c.page !== null ? c.page === firstPage : i < 3));
    const candidates: DateCandidate[] = opening.flatMap((c) => extractDateCandidates(c.text, c.page, c.chunk_id));
    record.document.date_candidates = candidates;
    if (parsed.email) {
      record.email = parsed.email;
      if (parsed.emailDate) {
        record.document.date = parsed.emailDate.date;
        record.document.date_confidence = "high";
        record.document.date_basis = parsed.emailDate.basis;
      }
      if (parsed.email.from) record.document.author = [formatAddress(parsed.email.from)];
      record.document.recipients = [...parsed.email.to, ...parsed.email.cc, ...parsed.email.bcc].map(formatAddress);
    } else {
      const choice = chooseDocumentDate(candidates);
      record.document.date = choice.date;
      record.document.date_confidence = choice.confidence;
      record.document.date_basis = choice.basis;
    }

    const openingText = opening.map((c) => c.text).join("\n").slice(0, 3000);
    const type = classifyDocumentType({
      relativePath: item.sourceRoot === "originals" ? item.relativePath : record.source.original_filename,
      openingText,
      isEmail: Boolean(parsed.email),
      rules: this.cfg.documentTypes,
    });
    record.document.document_type = type.type;
    record.document.document_type_confidence = type.confidence;
    record.document.document_type_basis = type.basis;
    applyMatters(openingText);
    record.classification.confidence = type.confidence;

    // Save before following attachments so that children can inherit the parent's matter.
    this.repo.saveCanonical(record);
    if (parsed.attachments.length) {
      record.attachments = await this.extractAttachments(evidenceId, parsed, item.depth);
      this.repo.saveCanonical(record);
    }

    if (parsed.status === "partial") this.summary.partial++;
    else this.summary.parsed++;
    this.audit.record({
      action: "INGEST",
      evidence_id: evidenceId,
      sha256: entry.sha256,
      parser: parsed.parser,
      status: parsed.status,
      chunk_count: chunks.length,
      ocr_pages: parsed.ocrPages.length,
    });
    this.status(discoveredAs, evidenceId, parsed.status, parsed.parser, parsed.warnings.length ? `${parsed.warnings.length} warning(s)` : null);
  }

  private async extractAttachments(parentId: string, parsed: ParseOutput, depth: number): Promise<AttachmentRef[]> {
    const refs: AttachmentRef[] = [];
    for (const att of parsed.attachments) {
      const ref: AttachmentRef = {
        index: att.index,
        filename: att.filename,
        mime_type: att.mimeType,
        size_bytes: att.data?.length ?? null,
        kind: att.kind,
        evidence_id: null,
        sha256: att.data ? sha256Bytes(att.data) : null,
        extracted_path: null,
        note: att.note,
      };
      if (!att.data) {
        this.summary.attachments_not_extracted++;
        this.audit.record({ action: "ATTACHMENT_NOT_EXTRACTED", evidence_id: parentId, attachment_index: att.index, detail: att.note ?? "no data" });
        refs.push(ref);
        continue;
      }
      if (depth + 1 > MAX_ATTACHMENT_DEPTH) {
        ref.note = `not ingested: attachment nesting deeper than ${MAX_ATTACHMENT_DEPTH}`;
        this.summary.attachments_not_extracted++;
        this.audit.record({ action: "ATTACHMENT_NOT_EXTRACTED", evidence_id: parentId, attachment_index: att.index, detail: ref.note });
        refs.push(ref);
        continue;
      }
      const ext = att.kind === "embedded_message" ? (parsed.email?.format === "eml" ? ".eml" : ".msg") : ".bin";
      const relative = `${parentId}/${safeAttachmentName(att.filename, att.index, ext)}`;
      const abs = path.join(this.cfg.attachmentsDir, relative);
      if (existsSync(abs)) {
        if (sha256Bytes(new Uint8Array(readFileSync(abs))) !== ref.sha256) {
          throw new Error(`extracted attachment ${relative} already exists with different content`);
        }
      } else {
        safeWriteNewFile(abs, att.data);
      }
      ref.extracted_path = relative;
      this.summary.attachments_extracted++;
      const childId = await this.process({
        sourceRoot: "attachments",
        absPath: abs,
        relativePath: relative,
        originalFilename: att.filename ?? path.basename(relative),
        parent: parentId,
        depth: depth + 1,
      });
      ref.evidence_id = childId;
      this.audit.record({ action: "ATTACHMENT_EXTRACTED", evidence_id: childId ?? undefined, parent_evidence_id: parentId, sha256: ref.sha256 ?? undefined, attachment_index: att.index });
      refs.push(ref);
    }
    return refs;
  }
}

export async function ingest(cfg: AppConfig, opts: IngestOptions = {}): Promise<IngestSummary> {
  return new Ingestor(cfg, opts).run();
}
