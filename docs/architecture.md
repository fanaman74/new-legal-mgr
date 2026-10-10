# Architecture

Status: **Milestone 0 (plan) and Milestone 1 (immutable evidence ingestion) implemented.**
Milestones 2–6 are planned below and not yet built.

> The AI must never become the source of truth. The evidence is the source of truth, and
> every useful AI conclusion must lead back to it.

## 1. Key decisions and deviations from the original brief

The brief proposed Python, Docling, `extract-msg`, RAGFlow and Docker Compose. The project
owner asked for **Node.js instead of Docker**. They chose to build the whole POC in
**TypeScript on Node.js, with no containers**. They also asked for **`.eml` support**.

| Brief | This POC | Why / trade-off |
| --- | --- | --- |
| Python + Pydantic | TypeScript (strict) + **zod** schemas | Same role: typed, validated canonical models. JSON output is identical in shape. |
| Docker Compose, originals mounted `:ro` | Plain `npm` scripts, no containers | Read-only is enforced in code (write guard, see §4) and verified by manifest tests instead of a container mount. Cross-platform, so a Windows double-click launcher can wrap it. |
| Docling (PDF/DOCX, OCR) | **pdfjs-dist** (PDF text + page geometry), **mammoth** (DOCX structure), **tesseract.js** (local OCR, WebAssembly) | No Python runtime. Docling's layout model (tables, reading order in multi-column layouts) is stronger; pdfjs + heuristics are adequate for typical letters, decisions and reports. Revisit if evaluation shows table/columns failures. |
| `extract-msg` | **@kenjiuno/msgreader** (message fields) + **cfb** (direct compound-file access for attachments) | Every attachment storage is enumerated, so none is silently missed. Embedded messages are repackaged as standalone `.msg` files. |
| — | **mailparser** for `.eml` | Added at the owner's request; same canonical email schema as `.msg`. |
| RAGFlow (retrieval, citations, timelines, graph) | **Planned (Milestone 2): a small local hybrid retrieval layer in the same process** | RAGFlow ships only as a multi-container Docker deployment (Elasticsearch/Infinity, MySQL, MinIO, Redis). That is incompatible with "no Docker". For 30–50 documents, an in-process BM25 + local-embedding index is simpler and keeps full control of page provenance. |
| `src/mcp/` package | `src/mcp-server/` (planned) | Avoids confusion with the MCP SDK package name. |
| `Makefile` | `npm run …` scripts | `make` is not available by default on Windows. |

## 2. Overview

```text
               data/originals/   (READ ONLY - never written by application code)
                      |
          +-----------+-------------------------------------+
          |  hash (SHA-256) -> Evidence ID registry          |
          |  detect format by file signature                 |
          +-----------+-------------------------------------+
                      |
   +--------+---------+---------+----------+---------+
   |        |                   |          |         |
  PDF     DOCX               .msg        .eml     TXT/MD
 pdfjs   mammoth        msgreader+cfb  mailparser  builtin
   |  \ (no text layer)        |          |
   |   tesseract.js OCR        +----+-----+
   |                                | attachments -> data/attachments/<EVID>/
   |                                |   (ingested recursively, own Evidence IDs,
   |                                |    attachment_of -> parent)
   +--------------------------------+
                      |
         structural blocks with exact char offsets
                      |
          structural chunks (page / section scoped)
                      |
   data/canonical/<EVID>.json        data/extracted/<EVID>.md
   data/extracted/<EVID>.chunks.jsonl data/extracted/<EVID>.structure.json
   data/indexes/evidence-registry.json, relationships.jsonl, ingestion-status.jsonl
   data/corrections/corrections.jsonl (human overrides, separate)
   logs/audit.jsonl (append-only, no document content)
                      |
        [Milestone 2] local hybrid retrieval (BM25 + local embeddings, RRF fusion)
                      |
        [Milestones 3-4] grounded answers, citation verification, chronology,
                         comparison, potentially-unaddressed evidence (deterministic services)
                      |
        [Milestone 5] MCP server (stdio) for Hermes  +  small localhost API/UI
```

## 3. Source layout

```text
src/
  config.ts                 config/*.yaml + .env + overrides -> AppConfig
  audit.ts                  append-only JSONL audit log (ids/hashes only)
  util/fs-guard.ts          ALL writes go through here; refuses writes into originals
  util/versions.ts          dependency versions for provenance
  evidence/
    models.ts               zod schemas: CanonicalEvidence, Chunk, Relationship, Correction, ...
    ids.ts                  Evidence ID registry (EVID <-> SHA-256 <-> paths)
    repository.ts           read/write generated artefacts
    corrections.ts          human corrections store + effective view
  ingestion/
    dispatcher.ts           pipeline orchestration (Ingestor)
    hashing.ts              SHA-256, file listing, originals manifest
    metadata.ts             format detection, date extraction, classification
    chunking.ts             structural chunking with exact offsets
    parsers/                pdf, ocr, docx, msg, eml, text, email-common, headings, types
  app/
    server.ts               local web app + JSON API (127.0.0.1 only)
    prereqs.ts              prerequisite checks (launcher and app)
    public/index.html       the browser interface (no external assets)
  testing/                  synthetic sample corpus + .msg writer (tests and demos only)
scripts/                    CLI entry points (launch, ingest, corpus, check-originals, correct, sample-corpus)
  ensure-deps.mjs           plain JS: Node version check + install/update libraries when needed
  get-node.ps1              Windows: download a private, checksum-verified Node.js into .runtime/
Start Legal Evidence Manager.bat / .command, start.sh   double-click launchers
tests/unit, tests/integration
```

Boundaries kept from the brief: ingestion → evidence/provenance → retrieval → analysis →
verification → MCP. Domain logic does not depend on any parser library's types: parsers
return a format-neutral `ParseOutput`.

## 4. Immutable originals

- Originals are opened only with read flags (`createReadStream(.., {flags: "r"})`, `readFileSync`).
- Every write in the application goes through `src/util/fs-guard.ts`, which resolves the
  target (following symlinks) and throws `OriginalsWriteError` if it is inside a protected
  directory. The ingestor protects the originals directory before doing anything else.
- `npm run check-originals -- create|verify` records and verifies a manifest of
  path, size, modification time and SHA-256.
- The integration test makes the originals read-only, ingests them, and asserts that no
  name, size, mtime or hash changed and that no file was added to the directory.
- Extracted email attachments are written to `data/attachments/<parent EVID>/`, never next to
  the original.

For defence in depth, also make the evidence folder read-only at the OS level (Windows: file
Properties → Read-only, or NTFS permissions; macOS/Linux: `chmod -R a-w`).

## 5. Provenance model

- **Evidence ID** (`EVID-NNNNNN`): allocated sequentially; identity is the SHA-256 of the bytes.
  A duplicate or renamed copy keeps the same ID and is recorded as an alias path.
- **PDF**: physical 1-based page numbers on every chunk. Chunk IDs `EVID-000143-P007-C03`.
  OCR-derived chunks are flagged `ocr: true` with the page's mean OCR confidence.
- **DOCX / TXT / MD**: no page numbers (they are not stable). Instead, section IDs (`S003`)
  and paragraph IDs (`P0012`). Chunk IDs `EVID-000143-S003-C02`.
- **Email**: `HDR` (header block) and `BODY` sections. Native metadata is held in `email`.
  Attachments are linked through `attachments[]`, `attachment_of[]` and
  `relationships.jsonl` (`attachment_of` predicate).
- **Offsets**: `chunk.text === unit.text.slice(char_start, char_end)`, where the unit is the
  page (PDF) or the whole document text. Units are saved in `<EVID>.structure.json`, so any
  citation can be checked mechanically.

## 6. Launchers and local app

The project owner does not want to use a terminal, so a double-click launcher is the main
entry point:

1. **Node.js**: use an installed Node ≥ 20.12. Otherwise download the current Node.js LTS
   (v24) into `.runtime/node` inside the project. No installation and no admin rights are
   needed, and the SHA-256 is verified against `SHASUMS256.txt` from nodejs.org.
2. **Libraries** (`scripts/ensure-deps.mjs`): `npm ci` on a fresh folder. After that
   `npm install` runs only when `package-lock.json` changes, so healthy packages are reused.
   An install stamp in `node_modules` records the lockfile hash.
3. **Prerequisites** (`src/app/prereqs.ts`): Node version, libraries loadable, native canvas,
   OCR model, folder layout (data not inside originals), evidence folder, data folder
   writable, disk space, privacy mode. A FAIL stops start-up with a plain-language fix.
4. **Start or reopen**: if the port is held by this app (checked via `/api/health`), the
   launcher just reopens the browser. Otherwise it starts the server on `127.0.0.1` and opens
   the browser.

App security for a single-user local tool:
- the server binds to `127.0.0.1`, and requests with a foreign `Host` (DNS rebinding) or
  `Origin` are rejected;
- state-changing requests need an `X-Legal-POC: 1` header, which other sites cannot send
  cross-origin;
- originals are streamed read-only, and non-PDF files are sent with `Content-Security-Policy:
  sandbox`;
- every import also compares a manifest taken before and after the run, which proves the
  originals were untouched.

## 7. Planned milestones

| # | Scope | Notes |
| --- | --- | --- |
| 1 | Immutable ingestion | **Done.** See `docs/poc-results.md`. |
| 2 | Retrieval | In-process hybrid: BM25 over chunks (with exact-phrase and reference/ID matching for names, dates, "Article 24", case references), plus local sentence embeddings via `@huggingface/transformers` (ONNX, model files stored locally, multilingual e5-small class). Reciprocal-rank fusion and optional local cross-encoder reranking. Filters: matter, type, date range, author. Results carry `evidence_id, filename, page, heading, chunk_id, score, retrieval_method`. |
| 3 | Grounded Q&A + verification | LLM is optional and **off by default** (`ALLOW_EXTERNAL_LLM=false`). Local inference (e.g. Ollama/llama.cpp HTTP on localhost) preferred. Citation verifier compares claims with the stored chunk text (exact/normalised quote match, then lexical overlap, then optional NLI/LLM check) and returns VERIFIED / PARTIALLY_SUPPORTED / UNSUPPORTED / SOURCE_ERROR. Refuses with "Insufficient evidence found in the indexed corpus." when retrieval is weak. |
| 4 | Analysis | Deterministic services first: chronology from dated chunks and email timestamps (explicit vs inferred dates kept apart); position comparison grouped by issue; potentially-unaddressed evidence (items raised in a submission, searched in the decision, classified cautiously, always labelled probabilistic). |
| 5 | MCP / Hermes, app screens | Local app shell, corpus, import and originals check are **done** (§6). Still to do: search/ask/timeline/compare screens; stdio MCP server (`@modelcontextprotocol/sdk`) exposing read-only `legal_*` tools; example `docs/hermes-mcp-example.yaml` for `~/.hermes/config.yaml` `mcp_servers`. |
| 6 | Evaluation | `tests/eval/gold_cases.yaml` (≥ 20 questions), metrics in `docs/evaluation.md`, results in `docs/poc-results.md`. |

## 8. Dependencies (resolved October 2026)

Runtime (Node.js ≥ 20.12; tested on 22.22):

| Package | Version | Purpose |
| --- | --- | --- |
| pdfjs-dist | 6.4.x | PDF text layer, metadata, page rendering for OCR |
| @napi-rs/canvas | 1.0.x | Canvas for rendering scanned pages (prebuilt binaries incl. Windows) |
| tesseract.js | 7.0.x | Local OCR (WebAssembly) |
| @tesseract.js-data/eng | 1.0.x | English OCR model, bundled; no runtime download |
| mammoth | 1.13.x | DOCX → semantic HTML |
| jszip | 3.10.x | DOCX core properties |
| node-html-parser | 9.0.x | HTML → blocks (DOCX, HTML email bodies) |
| @kenjiuno/msgreader | 1.28.x | Outlook `.msg` message fields |
| cfb | 1.2.x | Compound-file access for `.msg` attachments / embedded messages |
| mailparser | 3.9.x | `.eml` (RFC 822 / MIME) |
| zod | 4.x | Schemas and validation |
| yaml | 2.x | Configuration |
| commander | 15.x | CLIs |
| tsx | 4.x | Runs the TypeScript sources directly (launcher and CLIs) |

Development: typescript 7, vitest 5, pdfkit and docx (sample corpus generation only).

Known advisory: `npm audit` reports a moderate issue in `sprintf-js`, pulled in via
`argparse`, which mammoth uses only for its own command-line tool. It does not affect library
use. Keep an eye on mammoth releases.

## 9. Privacy and security

- Local-first: no network access at runtime. The OCR model is bundled.
- No document text in logs: the audit log holds IDs, hashes, statuses and short errors only (tested).
- `.env` is gitignored, and `data/originals`, generated data and logs are gitignored.
- Future services bind to `127.0.0.1` by default. External LLMs require an explicit
  `ALLOW_EXTERNAL_LLM=true`.
