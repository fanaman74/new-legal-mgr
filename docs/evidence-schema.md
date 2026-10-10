# Evidence schema

The authoritative definitions are the zod schemas in `src/evidence/models.ts`. This document
explains them. Every record is validated when written and when read.

General rules:

- Missing metadata is `null`, `[]` or `"unknown"`. It is **never guessed**.
- Uncertain machine-derived values carry a confidence (`high` | `medium` | `low`) and a `*_basis`
  explaining where they came from.
- Machine-extracted document dates are at most `medium`. Only email timestamps and human
  corrections are `high`.
- Page numbers exist only for PDFs.

## Files produced per evidence object

| File | Content |
| --- | --- |
| `data/canonical/<EVID>.json` | Canonical record (below). Machine-derived; never edited by corrections. |
| `data/extracted/<EVID>.md` | Readable Markdown rendering, with `<!-- page N -->` markers for PDFs. |
| `data/extracted/<EVID>.structure.json` | Parsed units (pages, or the whole text) and blocks with character offsets. |
| `data/extracted/<EVID>.chunks.jsonl` | Retrievable chunks, one JSON object per line. |

Shared indexes:

| File | Content |
| --- | --- |
| `data/indexes/evidence-registry.json` | EVID ↔ SHA-256 ↔ paths (primary path + aliases) ↔ parent emails. |
| `data/indexes/relationships.jsonl` | Relationship records (e.g. `attachment_of`). |
| `data/indexes/ingestion-status.jsonl` | One line per file per run: status, error, parser, timestamp. |
| `data/indexes/originals-manifest.json` | Created by `npm run check-originals -- create`. |
| `data/corrections/corrections.jsonl` | Human corrections (append-only). |
| `logs/audit.jsonl` | Append-only audit trail (no document content). |

## Canonical record

```jsonc
{
  "schema_version": 1,
  "evidence_id": "EVID-000003",
  "source": {
    "original_filename": "2025-05-12_decision_on_request_for_assistance.pdf",
    "source_root": "originals",            // or "attachments" for files extracted from emails
    "relative_path": "article24/2025-05-12_decision_on_request_for_assistance.pdf",
    "alias_paths": [],                     // other paths with byte-identical content
    "sha256": "a5b7…",
    "mime_type": "application/pdf",        // detected from the file signature
    "size_bytes": 3456
  },
  "document": {
    "title": "Decision on request for assistance ART24-2025-0012",
    "title_source": "pdf_metadata",        // email_subject | pdf_metadata | docx_metadata | first_heading
    "document_type": "official_decision",  // ids from config/document_types.yaml, "email", or "unknown"
    "document_type_confidence": "medium",
    "document_type_basis": "path contains \"decision\"",
    "matter": ["article24"],
    "matter_basis": [{ "matter": "article24", "confidence": "high", "basis": "stored under folder \"article24/\"" }],
    "date": "2025-05-12",
    "date_confidence": "medium",
    "date_basis": "labelled date \"12 May 2025\" on page 1",
    "date_candidates": [
      { "value": "2025-05-12", "raw": "12 May 2025", "page": 1, "chunk_id": "EVID-000003-P001-C01", "labelled": true, "ambiguous": false }
    ],
    "author": [],                          // only established authors (email sender); never file-metadata authors
    "recipients": [],
    "language": null
  },
  "provenance": {
    "parser": "pdf-text",                  // pdf-text | pdf-text+ocr | docx | msg | eml | text | markdown
    "parser_version": "pdfjs-dist@6.4.299",
    "ingestion_timestamp": "2026-10-10T20:52:11.767Z",
    "page_count": 2,
    "ocr_pages": [],
    "status": "parsed",                    // parsed | partial | failed | unsupported
    "warnings": [],
    "error": null,
    "embedded_metadata": { "pdf.Title": "…", "pdf.Author": null }   // informational, not trusted
  },
  "content": {
    "markdown_path": "extracted/EVID-000003.md",
    "structured_json_path": "extracted/EVID-000003.structure.json",
    "chunks_path": "extracted/EVID-000003.chunks.jsonl",
    "chunk_count": 5,
    "char_count": 1234
  },
  "email": null,                           // see below
  "attachments": [],                       // see below
  "attachment_of": [],                     // parent email Evidence IDs
  "classification": { "tags": [], "privilege": "unknown", "source_type": "unknown", "confidence": "medium" }
}
```

### Status values

| Status | Meaning |
| --- | --- |
| `parsed` | Content fully extracted. |
| `partial` | Some content could not be extracted (e.g. a scanned page with OCR disabled). See `warnings`. |
| `failed` | Parsing failed; `error` holds the reason. The object is still registered with its hash. |
| `unsupported` | Format not parsed (e.g. images, ZIP). Registered with its hash, so nothing is silently dropped. |

### `email` (for `.msg` and `.eml`)

```jsonc
{
  "format": "msg",                          // or "eml"
  "message_id": "<20250117164200.jd01@example.org>",
  "from": { "name": "Jane Doe", "address": "jane.doe@example.org" },
  "to": [ … ], "cc": [ … ], "bcc": [ … ],   // BCC only when the file contains it (sender's copy)
  "sent_at": "2025-01-17T16:42:00.000Z",    // UTC instant
  "received_at": "2025-01-17T16:43:00.000Z",
  "subject": "…",
  "in_reply_to": null,
  "has_html_body": false
}
```

For emails, `document.date` is the calendar date of `sent_at` in the **sender's UTC offset**
when the Date header provides it, otherwise in UTC (stated in `date_basis`).

### `attachments[]`

```jsonc
{
  "index": 1,
  "filename": "Annex_B_witness_statement_Rossi.docx",
  "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "size_bytes": 9728,
  "kind": "file",                           // file | embedded_message | unsupported
  "evidence_id": "EVID-000007",             // the attachment's own Evidence ID
  "sha256": "fcf9…",
  "extracted_path": "EVID-000006/02_Annex_B_witness_statement_Rossi.docx",  // under data/attachments
  "note": null                              // e.g. why an attachment could not be extracted
}
```

Embedded messages (Outlook "attach item", or `message/rfc822` in `.eml`) are extracted as
standalone `.msg`/`.eml` files. They are ingested recursively, so their own attachments are
followed too.

## Chunk

```jsonc
{
  "chunk_id": "EVID-000003-P002-C02",       // PDF: P<page>-C<n>; others: <section>-C<n>
  "evidence_id": "EVID-000003",
  "filename": "2025-05-12_decision_on_request_for_assistance.pdf",
  "page": 2,                                // PDFs only; null otherwise (never invented)
  "section_id": null,                       // S000.. (DOCX/TXT/MD), HDR/BODY (email)
  "paragraph_ids": ["P002-B003", "P002-B004"],
  "heading": "4. Decision",
  "heading_path": ["4. Decision"],
  "text": "4. Decision\n\nThe Appointing Authority HAS DECIDED: …",
  "char_start": 210,                        // offsets into the page text (PDF) or document text
  "char_end": 318,
  "parser": "pdf-text",
  "ocr": false,
  "ocr_confidence": null
}
```

Chunks never cross a page boundary (PDF) or a section boundary (DOCX/email). A heading always
starts a new chunk.

## Relationship

```json
{ "subject": "EVID-000007", "predicate": "attachment_of", "object": "EVID-000006",
  "source": "extracted", "confidence": 1, "detail": "extracted from email attachment \"…\"",
  "timestamp": "…" }
```

Predicates: `attachment_of`, `responds_to`, `references`, `supersedes`, `submitted_with`,
`authored_by`, `sent_to`, `concerns`, `challenges`, `supports`, `contradicts`, `duplicate_of`.
Milestone 1 only extracts `attachment_of`. The others are reserved for manual entry and later
milestones.

## Human corrections

```json
{ "correction_id": "…", "evidence_id": "EVID-000043", "field": "document.date",
  "old_value": "2025-01-16", "new_value": "2025-01-17", "reason": "date confirmed from page 1",
  "source": "human", "author": "reviewer", "timestamp": "…" }
```

Correctable fields: `document.title`, `document.document_type`, `document.matter`,
`document.date`, `document.author`, `document.recipients`, `document.language`,
`classification.tags`, `classification.privilege`, `classification.source_type`.

Corrections are stored separately and applied as an overlay (`applyCorrections`): the latest
correction per field wins. The effective record lists `corrections_applied`, with the machine
value that was overridden. Neither the original file nor the canonical record is modified.
