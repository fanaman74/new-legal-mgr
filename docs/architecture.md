# Architecture

Status: **Milestones 0–6 implemented** and evaluated on a fictional sample corpus
(see `docs/poc-results.md`).

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
| RAGFlow (retrieval, citations, timelines, graph) | **In-process hybrid retrieval** (BM25 + local sentence embeddings, RRF fusion) and deterministic analysis services | RAGFlow ships only as a multi-container Docker deployment (Elasticsearch/Infinity, MySQL, MinIO, Redis), which is incompatible with "no Docker". For 30–50 documents an in-process index is simpler and keeps full control of page provenance. No graph database (not needed by any workflow so far). |
| LLM-generated answers | **Extractive answers by default**; optional local LLM (Ollama / OpenAI-compatible) whose every claim is verified | Keeps the evidence, not a model, as the source of truth, and works with no model at all. |
| `src/mcp/` package | `src/mcp-server/` | Avoids confusion with the MCP SDK package name. |
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
   RetrievalIndex: BM25 (legal-aware tokens) + local embeddings (transformers.js/ONNX;
   Ollama or built-in LSA as alternatives) -> reciprocal rank fusion, filters, provenance
                      |
   Deterministic services (src/analysis/)                          every output is cited
     answer (extractive / optional LLM) · chronology · comparison  and checked by the
     unaddressed evidence · citation verification                  citation verifier
                      |
        LegalServices facade (src/services.ts)
          |                         |                          |
   local web app + API        MCP server (stdio,          evaluation runner
   (127.0.0.1, launchers)     read-only tools) -> Hermes  (gold + held-out sets)
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
  retrieval/
    text.ts                 tokenisation (references, anchors, dates), stemming, sentences
    bm25.ts                 BM25 index
    embeddings.ts           transformers.js / Ollama / LSA embedders
    models.ts               model catalogue, one-time download + checksum manifest
    search.ts               RetrievalIndex (hybrid search, filters) + SearchService (cache, audit)
  analysis/
    verification.ts         citation verifier
    answer.ts               grounded Q&A (extractive; optional LLM in llm.ts)
    chronology.ts, comparison.ts, unaddressed.ts, common.ts
  services.ts               facade shared by app, MCP, CLIs and evaluation
  mcp-server/server.ts      read-only MCP tools
  evaluation/runner.ts      gold-set runner and report
  app/
    server.ts               local web app + JSON API (127.0.0.1 only)
    prereqs.ts              prerequisite checks (launcher and app)
    public/index.html       the browser interface (no external assets)
  testing/                  synthetic sample corpus + .msg writer (tests and demos only)
scripts/                    CLI entry points (launch, ingest, corpus, check-originals, correct,
                            search, ask, mcp, run-eval, setup-models, sample-corpus)
  ensure-deps.mjs           plain JS: Node version check + install/update libraries when needed
  get-node.ps1              Windows: download a private, checksum-verified Node.js into .runtime/
Start Legal Evidence Manager.bat / .command, start.sh   double-click launchers
tests/unit, tests/integration, tests/eval (gold_cases.yaml, holdout_cases.yaml)
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
3. **Search model**: download the local embedding model once (non-fatal when offline; the
   app then uses the built-in LSA fallback and the launcher retries next time).
4. **Prerequisites** (`src/app/prereqs.ts`): Node version, libraries loadable, native canvas,
   OCR model, search model, folder layout (data not inside originals), evidence folder, data folder
   writable, disk space, privacy mode. A FAIL stops start-up with a plain-language fix.
5. **Start or reopen**: if the port is held by this app (checked via `/api/health`), the
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

## 7. Retrieval and analysis design (Milestones 2–6)

**Retrieval** (`src/retrieval/`)
- *Lexical:* BM25 over chunk text, with document title and heading path as context.
  - Tokens keep references whole and in parts (`ART24-2025-0012`), add anchors (`Article 24` → `art:24`, `Annex A.5` → `annex:a5`) and normalised dates (`17 January 2025` and `2025-01-17` → `date:2025-01-17`), expand abbreviations (`Ref.`) and apply light inflectional and derivational stemming.
  - Fact tokens weigh double; a recognised date's loose parts count little.
  - A coordination factor rewards chunks matching more distinct query terms. Weak matches, below a share of the query terms or 15 % of the best score, are dropped before fusion.
  - `"Quoted phrases"` are mandatory exact matches.
- *Semantic:* sentence embeddings from a local ONNX model (`all-MiniLM-L6-v2` by default, `multilingual-e5-small` optional) via transformers.js. They are cached per chunk and text hash.
  - The model is downloaded once, from Hugging Face with a pinned-checksum mirror as fallback, and recorded in `models/<id>/model.json` with each file's SHA-256.
  - At run time remote loading is disabled.
  - Alternatives: a local Ollama embedding endpoint, or a built-in LSA (TF-IDF + truncated eigendecomposition) when no model is installed.
- *Fusion:* reciprocal rank fusion. For fact-heavy queries (dates, references) the semantic list is down-weighted.
- *Filters* (on the effective, human-corrected metadata): matter, document type, date range, author, Evidence IDs.

**Citation verification** (`analysis/verification.ts`) is deterministic.
- It checks, in order:
  1. Source, page and chunk existence (else SOURCE_ERROR).
  2. Quote presence on the cited page. It is OCR-tolerant, and a quote found on another page is reported as such; a quote that cannot be found makes the citation UNSUPPORTED.
  3. Support for the claim, judged against the single sentence that best matches the claim's subject, with 2–3-sentence windows only as fallback. It looks at content-word and key-fact coverage, negation mismatch, conflicting dates and legal-outcome antonyms (granted vs rejected).
- Paraphrase support needs high semantic similarity *and* all key facts present.

**Grounded answers** (`analysis/answer.ts`)
- Questions are typed (date, amount, count, reference, person, statement).
- Candidate sentences must contain the expected kind of fact and are scored by rarity-weighted coverage of the question terms, with heading and title as context.
- The evidence is insufficient below 50 % weighted coverage, or when a question word that never occurs in the corpus is not bridged by a strong paraphrase. The answer is then *"Insufficient evidence found in the indexed corpus."*
- Corroborating sentences must state the same fact.
- Performative statements ("is opened", "is hereby rejected") are dated by their document, and the date line is cited.
- In the optional LLM mode, the model must return claims with numbered-passage citations and verbatim quotes. Each is verified; unsupported claims are removed and listed. The versioned system prompt is `config/prompts/legal-analysis-system.v1.md`.

**Chronology** (`analysis/chronology.ts`)
- Events come from three sources, each labelled with its date type and the date as written:
  - explicitly dated sentences (letterhead lines excluded);
  - email sent timestamps;
  - document dates, with unlabelled ones marked `inferred`.
- Duplicate events are merged. Confidence comes from primary-source corroboration (working notes count as secondary) and OCR quality.
- Every citation is verified, and events without a verified citation are dropped.
- The analysis is scoped to a matter inferred from the question when possible.

**Comparison** (`analysis/comparison.ts`)
- *Propositions:* sentences with a verb that are relevant to the issue (semantic or rarity-weighted lexical). Each document's best statement is kept, plus up to two more above a stricter threshold, ordered by document date.
- *Pairs* across documents are labelled by topical similarity, shared issue concepts (capitalised names excluded) and polarity. *Potential contradiction* requires opposite polarity, close similarity and at least two shared concepts.
- Explanations are neutral, with a mandatory human-review caveat.

**Unaddressed evidence** (`analysis/unaddressed.ts`)
- *Items:* annex/exhibit references in the submission (`Annex B: …`, `Annex A.5: …`) plus other files attached to the email that carried it.
- *Target:* each target sentence is searched for the item's label anchor, its distinctive description terms, and semantic similarity to the description.
- *Classes:* addressed (named, with assessment language nearby), referenced only, partially addressed, uncertain, no treatment found. Each comes with a confidence, an explanation, the closest passage, the sections searched and a probabilistic warning.

**Evaluation** (`evaluation/runner.ts`): see `docs/evaluation.md`.
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
| @huggingface/transformers | 4.3.x | Local sentence embeddings (ONNX Runtime) |
| @modelcontextprotocol/sdk | 1.32.x | MCP server (stdio) |
| tar | 7.x | Unpacking the search-model archive at setup |

Development: typescript 7, vitest 5, pdfkit and docx (sample corpus generation only).

Size: transformers.js brings `onnxruntime-node` (native binaries for all platforms, about
290 MB) and `onnxruntime-web` (about 140 MB). The launcher skips onnxruntime-node's optional
CUDA download (`ONNXRUNTIME_NODE_INSTALL=skip`), because the POC is CPU-only.

Known advisory: `npm audit` reports a moderate issue in `sprintf-js`, pulled in via
`argparse`, which mammoth uses only for its own command-line tool. It does not affect library
use. Keep an eye on mammoth releases.

## 9. Privacy and security

- **Local-first.** At run time nothing is fetched and no document content leaves the
  machine. Models (OCR, embeddings) are local files, downloaded once at setup (the search model
  by the launcher), with recorded checksums.
- **No document text in logs.** The audit log holds IDs, hashes, statuses and short errors;
  queries are logged as SHA-256 hashes (tested).
- **Git hygiene.** `.env`, evidence, generated data, models and logs are gitignored.
- **Local app only.** The web app binds to `127.0.0.1` and rejects foreign Host/Origin
  headers. State-changing requests need a custom header. Originals are served read-only.
- **No write access over MCP.** MCP tools are read-only.
- **LLMs.** They are off by default. Embedding or LLM endpoints that are not on localhost are
  refused unless `ALLOW_EXTERNAL_LLM=true`; API keys come from `.env` and are never logged.
