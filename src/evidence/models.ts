import { z } from "zod";

/**
 * Canonical evidence schema (see docs/evidence-schema.md).
 *
 * Rules:
 * - missing metadata is null / [] / "unknown", never guessed;
 * - every machine-derived value that is uncertain carries a confidence;
 * - page numbers are only present for formats with stable pagination (PDF).
 */

export const EVIDENCE_ID_PATTERN = /^EVID-\d{6}$/;
export const EvidenceId = z.string().regex(EVIDENCE_ID_PATTERN);

export const Confidence = z.enum(["high", "medium", "low"]);
export type Confidence = z.infer<typeof Confidence>;

export const ParseStatus = z.enum(["parsed", "partial", "failed", "unsupported"]);
export type ParseStatus = z.infer<typeof ParseStatus>;

export const SourceRoot = z.enum(["originals", "attachments"]);
export type SourceRoot = z.infer<typeof SourceRoot>;

export const DateCandidate = z.object({
  /** ISO date (YYYY-MM-DD). */
  value: z.string(),
  /** Exact text as it appears in the source. */
  raw: z.string(),
  page: z.number().int().positive().nullable(),
  chunk_id: z.string().nullable(),
  /** True when introduced by a label such as "Date:" or "Brussels, ". */
  labelled: z.boolean(),
  /** True when the textual format is ambiguous (e.g. 03/04/2025). */
  ambiguous: z.boolean(),
});
export type DateCandidate = z.infer<typeof DateCandidate>;

export const EmailAddress = z.object({
  name: z.string().nullable(),
  address: z.string().nullable(),
});
export type EmailAddress = z.infer<typeof EmailAddress>;

export const EmailMetadata = z.object({
  format: z.enum(["msg", "eml"]),
  message_id: z.string().nullable(),
  from: EmailAddress.nullable(),
  to: z.array(EmailAddress),
  cc: z.array(EmailAddress),
  bcc: z.array(EmailAddress),
  /** ISO 8601 timestamp, as recorded by the mail client / Date header. */
  sent_at: z.string().nullable(),
  received_at: z.string().nullable(),
  subject: z.string().nullable(),
  in_reply_to: z.string().nullable(),
  has_html_body: z.boolean(),
});
export type EmailMetadata = z.infer<typeof EmailMetadata>;

export const AttachmentRef = z.object({
  /** Position of the attachment in the parent message (0-based). */
  index: z.number().int().nonnegative(),
  filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  size_bytes: z.number().int().nonnegative().nullable(),
  kind: z.enum(["file", "embedded_message", "unsupported"]),
  /** Evidence ID allocated to the extracted attachment, if extracted. */
  evidence_id: EvidenceId.nullable(),
  sha256: z.string().nullable(),
  /** Path of the extracted copy relative to the attachments directory. */
  extracted_path: z.string().nullable(),
  /** Why the attachment could not be extracted, if applicable. */
  note: z.string().nullable(),
});
export type AttachmentRef = z.infer<typeof AttachmentRef>;

export const Chunk = z.object({
  chunk_id: z.string(),
  evidence_id: EvidenceId,
  filename: z.string(),
  /** 1-based page number. Only set for paginated formats (PDF). Never invented. */
  page: z.number().int().positive().nullable(),
  /** Section identifier for non-paginated formats (e.g. "S003" in DOCX, "BODY" in email). */
  section_id: z.string().nullable(),
  /** Paragraph identifiers covered by this chunk (e.g. ["P0012", "P0013"]). */
  paragraph_ids: z.array(z.string()),
  heading: z.string().nullable(),
  heading_path: z.array(z.string()),
  text: z.string(),
  /**
   * Character offsets of `text` within the unit text: the page text for PDFs
   * (see <EVID>.structure.json), the full document text otherwise.
   */
  char_start: z.number().int().nonnegative(),
  char_end: z.number().int().nonnegative(),
  parser: z.string(),
  ocr: z.boolean(),
  /** Mean OCR confidence (0-100) for OCR-derived text, else null. */
  ocr_confidence: z.number().nullable(),
});
export type Chunk = z.infer<typeof Chunk>;

export const CanonicalEvidence = z.object({
  schema_version: z.literal(1),
  evidence_id: EvidenceId,
  source: z.object({
    original_filename: z.string(),
    source_root: SourceRoot,
    /** Path relative to the source root (data/originals or data/attachments). */
    relative_path: z.string(),
    /** Other paths with byte-identical content (duplicates / renamed copies). */
    alias_paths: z.array(z.object({ source_root: SourceRoot, relative_path: z.string() })),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    mime_type: z.string(),
    size_bytes: z.number().int().nonnegative(),
  }),
  document: z.object({
    title: z.string().nullable(),
    title_source: z.enum(["email_subject", "pdf_metadata", "docx_metadata", "first_heading"]).nullable(),
    document_type: z.string(),
    document_type_confidence: Confidence.nullable(),
    document_type_basis: z.string().nullable(),
    matter: z.array(z.string()),
    matter_basis: z.array(z.object({ matter: z.string(), confidence: Confidence, basis: z.string() })),
    /** ISO date (YYYY-MM-DD) or null. */
    date: z.string().nullable(),
    date_confidence: Confidence.nullable(),
    date_basis: z.string().nullable(),
    date_candidates: z.array(DateCandidate),
    /** Authors explicitly established (e.g. email sender). File-metadata authors are NOT used. */
    author: z.array(z.string()),
    recipients: z.array(z.string()),
    language: z.string().nullable(),
  }),
  provenance: z.object({
    parser: z.string(),
    parser_version: z.string(),
    ingestion_timestamp: z.string(),
    page_count: z.number().int().nonnegative().nullable(),
    ocr_pages: z.array(z.number().int().positive()),
    status: ParseStatus,
    warnings: z.array(z.string()),
    error: z.string().nullable(),
    /** Metadata embedded in the file (PDF info dict, DOCX core properties). Not trusted as document metadata. */
    embedded_metadata: z.record(z.string(), z.string().nullable()),
  }),
  content: z.object({
    markdown_path: z.string().nullable(),
    structured_json_path: z.string().nullable(),
    chunks_path: z.string().nullable(),
    chunk_count: z.number().int().nonnegative(),
    char_count: z.number().int().nonnegative(),
  }),
  email: EmailMetadata.nullable(),
  attachments: z.array(AttachmentRef),
  /** Set when this evidence was extracted from an email. */
  attachment_of: z.array(EvidenceId),
  classification: z.object({
    tags: z.array(z.string()),
    privilege: z.enum(["unknown", "privileged", "not_privileged"]),
    source_type: z.enum(["primary", "secondary", "unknown"]),
    confidence: Confidence.nullable(),
  }),
});
export type CanonicalEvidence = z.infer<typeof CanonicalEvidence>;

export const RelationshipPredicate = z.enum([
  "attachment_of",
  "responds_to",
  "references",
  "supersedes",
  "submitted_with",
  "authored_by",
  "sent_to",
  "concerns",
  "challenges",
  "supports",
  "contradicts",
  "duplicate_of",
]);

export const Relationship = z.object({
  subject: EvidenceId,
  predicate: RelationshipPredicate,
  object: z.string(),
  source: z.enum(["extracted", "manual"]),
  confidence: z.number().min(0).max(1),
  detail: z.string().nullable(),
  timestamp: z.string(),
});
export type Relationship = z.infer<typeof Relationship>;

export const CORRECTABLE_FIELDS = [
  "document.title",
  "document.document_type",
  "document.matter",
  "document.date",
  "document.author",
  "document.recipients",
  "document.language",
  "classification.tags",
  "classification.privilege",
  "classification.source_type",
] as const;
export const CorrectableField = z.enum(CORRECTABLE_FIELDS);
export type CorrectableField = z.infer<typeof CorrectableField>;

export const Correction = z.object({
  correction_id: z.string(),
  evidence_id: EvidenceId,
  field: CorrectableField,
  old_value: z.unknown(),
  new_value: z.unknown(),
  reason: z.string().min(1),
  source: z.literal("human"),
  author: z.string().nullable(),
  timestamp: z.string(),
});
export type Correction = z.infer<typeof Correction>;

export const IngestionStatusRecord = z.object({
  evidence_id: EvidenceId.nullable(),
  source_root: SourceRoot,
  relative_path: z.string(),
  status: z.enum(["parsed", "partial", "failed", "unsupported", "duplicate", "unchanged", "skipped"]),
  error: z.string().nullable(),
  parser: z.string().nullable(),
  timestamp: z.string(),
});
export type IngestionStatusRecord = z.infer<typeof IngestionStatusRecord>;
