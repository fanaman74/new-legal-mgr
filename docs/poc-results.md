# POC results

Status: **Milestone 1 (immutable evidence ingestion) complete.** The retrieval, analysis, MCP
and evaluation milestones have not started. The gold-set evaluation has therefore not been
run, and no retrieval accuracy figures exist yet.

## Milestone 1: ingestion acceptance criteria

Verified by `npm test` (56 tests) on the synthetic sample corpus (13 original files,
plus 2 deliberately corrupt files and 1 ignored system file in the test).

| Criterion | Result | Evidence |
| --- | --- | --- |
| PDF works | ✅ | Text layer with physical page numbers; headings from font size and numbering |
| Scanned PDF works with OCR | ✅ | Image-only page OCR'd locally (tesseract.js), confidence ~95 on the synthetic scan; chunks flagged `ocr: true` |
| DOCX works | ✅ | Headings → sections, paragraph IDs, lists, tables |
| `.msg` metadata preserved | ✅ | From/To/CC/BCC, subject, sent/received, Message-ID, In-Reply-To, transport headers |
| `.msg` attachments linked to parent | ✅ | By-value attachments and embedded messages (recursive); `attachment_of` relationships |
| `.eml` supported (added) | ✅ | Same schema as `.msg`; MIME attachments and attached messages |
| SHA-256 stored | ✅ | Registry and every canonical record |
| Originals unchanged | ✅ | Manifest before/after on read-only originals: name, size, mtime and SHA-256 identical |
| Duplicate detection | ✅ | Identical copy, email-attachment copy and renamed file all map to one Evidence ID |
| Failures do not stop the batch | ✅ | Corrupt PDF and `.msg` recorded as `failed`; the remaining files ingested |
| No content in the audit log | ✅ | Asserted in the test |

Sample run (synthetic corpus, 4-core cloud VM, OCR on): 13 originals → 15 evidence objects
(4 extracted attachments, 2 of them duplicates of known content), about 3 s including one
OCR page.

## Known limitations (Milestone 1)

- **Layout**: pdfjs text order follows the PDF content stream. Multi-column layouts, complex
  tables, headers/footers and footnotes are not reconstructed as Docling would. Running
  headers and footers end up in chunk text.
- **Headings** in PDFs are heuristic (font size, numbering such as `2.1`, ALL-CAPS lines).
  Bold body-size headings without numbering are not detected.
- **OCR** quality depends on the scan. Typical errors such as `I` → `|` occur. Only
  English is configured by default. Mixed pages (a partial text layer plus scanned content)
  are OCR'd only when the page's text layer is below the threshold.
- **Dates** come from regex over the opening page/section. They are never `high` confidence,
  and ambiguous numeric dates (`03/04/2025`) are not used as the document date.
- **Classification** (document type, matter) is rule-based from `config/*.yaml`. Expect to
  tune the rules to the real corpus and to correct records via `npm run correct`.
- `.msg` files with only RTF bodies (no plain-text or HTML body) are not decoded. Such
  emails are flagged with "email has no body text".
- Password-protected PDFs fail with an error (recorded, not skipped silently).
- Language detection is not implemented (`document.language` is `null`).

## Final POC assessment

To be completed after Milestone 6:

- What worked
- What failed
- Accuracy/results
- Known risks
- What should be built next
- What should NOT be built yet
