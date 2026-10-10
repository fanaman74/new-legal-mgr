# Legal Evidence Manager: proof of concept

A small, **local-first** proof of concept for ingesting, searching and analysing a legal
evidence corpus (30–50 files) while keeping **strict provenance** back to the original
evidence: Evidence ID, SHA-256, file, page or section, and exact character offsets.

It is **not** a production legal platform and it does not give legal advice.

> The AI must never become the source of truth. The evidence is the source of truth, and every
> useful AI conclusion must lead back to it.

## Quick start: no terminal needed

1. Download or copy this folder to your computer.
2. **Double-click the launcher**:
   - Windows: `Start Legal Evidence Manager.bat`
   - macOS: `Start Legal Evidence Manager.command` (the first time, right-click → Open to allow it)
   - Linux: `start.sh`
3. A setup window shows progress. On first use it:
   - downloads a private copy of Node.js into this folder (`.runtime/`) if no recent Node.js
     is installed. No admin rights are needed, and the download is checksum-verified against
     nodejs.org;
   - installs the application libraries (later runs reuse them and download only what is
     missing or changed);
   - checks the prerequisites and opens the app in your browser at `http://127.0.0.1:8787/`.
4. In the app, click **Open evidence folder**, copy your evidence files (copies) into it, then
   click **Import evidence**. Click **Check originals unchanged** at any time to verify that
   no original was modified.

Double-clicking again while the app is running just reopens the browser page; it never starts
a second copy. Close the setup window to stop the app. To try the app with the fictional
sample corpus, run the launcher with `--sample` (or `npm run start:sample`).

## Status

| Milestone | State |
| --- | --- |
| 0 Inspect and plan (`docs/architecture.md`) | ✅ done |
| 1 Immutable evidence ingestion (PDF, scanned PDF, DOCX, `.msg`, `.eml`, TXT/MD) | ✅ done, 56 tests |
| 2 Retrieval (hybrid lexical + semantic, filters, provenance) | planned |
| 3 Grounded Q&A and citation verification | planned |
| 4 Chronology, comparison, potentially-unaddressed evidence | planned |
| 5 Local web app (corpus, import, originals check) and double-click launchers | ✅ first part done |
| 5 MCP server for Hermes, search/ask/timeline/compare screens | planned |
| 6 Gold-set evaluation | planned |

## Architecture in one paragraph

Everything runs in **Node.js (TypeScript), with no Docker and no Python**. Originals are
hashed and registered under stable Evidence IDs. They are then parsed: PDFs with pdfjs-dist,
scanned pages OCR'd locally with tesseract.js, DOCX with mammoth, `.msg` with msgreader and
cfb, `.eml` with mailparser. The output is structural chunks with exact offsets, plus
canonical JSON records. Email attachments are extracted to `data/attachments/` and ingested
as evidence in their own right, linked to the parent email. See
[`docs/architecture.md`](docs/architecture.md) for the design, the dependency list and how
this deviates from the original brief (RAGFlow and Docling are replaced by in-process
components).

## Prerequisites

- **Node.js 20.12 or newer** (tested on 22 LTS) with npm. Nothing else: no Docker, no Python,
  no system OCR install. Works on Windows, macOS and Linux.
- About 400 MB of disk space for `node_modules` (OCR model included).

## Setup from a terminal (developers)

```bash
npm install
cp .env.example .env        # optional; the defaults work without it (Windows: copy .env.example .env)
npm test                    # optional: runs the test suite
```

## Where to put evidence: the read-only rule

Put **copies** of your test files in `data/originals/`. Sub-folders are allowed and
recommended. A folder name listed in `config/matters.yaml` (e.g. `article24/`) assigns that
matter to everything inside it.

```text
data/originals/
  article24/   decisions, requests, acknowledgements, annexes…
  audit/       audit / IAS material
  emails/      .msg and .eml files
  lawyer/      lawyer correspondence and court documents
```

`data/originals/` is **read-only for the application**. Code never renames, moves, deletes,
edits, overwrites or converts anything there: all writes go through a guard that refuses
paths inside it. Generated files go to `data/extracted`, `data/canonical`,
`data/attachments` and `data/indexes`. For extra safety, also make the folder read-only in
your operating system. Everything under `data/` (except `.gitkeep`) is gitignored. Never
commit evidence.

To try the POC without real documents, generate a small, entirely fictional corpus:

```bash
npm run sample-corpus                                                      # writes data/sample-originals/
npm run ingest -- --originals data/sample-originals --data data/sample-data
npm run corpus -- --data data/sample-data
```

Using a separate `--data` directory keeps the fictional evidence out of your real registry.

## Ingestion

```bash
npm run check-originals -- create   # record name/size/mtime/SHA-256 of every original
npm run ingest                      # ingest everything under data/originals
npm run corpus                      # table: Evidence ID, filename, type, date, matter, status
npm run corpus -- --id EVID-000003  # one full record, plus its relationships
npm run check-originals -- verify   # prove that nothing in data/originals changed
```

Options: `npm run ingest -- --force` re-parses everything, and `--no-ocr` skips OCR.
Re-running ingestion is idempotent. New files get new IDs. A duplicate or renamed copy keeps
its existing Evidence ID and is recorded as an alias. A file that fails to parse is recorded
(`status: failed`) without stopping the batch.

Outputs per document: `data/canonical/EVID-NNNNNN.json`, plus `data/extracted/EVID-NNNNNN.md`,
`.chunks.jsonl` and `.structure.json`. The format is described in
[`docs/evidence-schema.md`](docs/evidence-schema.md).

### Correcting metadata

Machine-extracted dates, types and matters are deliberately conservative and may be wrong.
Corrections are stored separately, override the machine value, and are audited. The original
file and the machine record are never modified:

```bash
npm run correct -- --id EVID-000003 --field document.date --value 2025-05-12 --reason "date confirmed from page 1"
npm run correct -- --id EVID-000007 --field document.matter --value "article24,article90" --reason "annex to both"
```

## Asking questions, timelines, comparison, MCP/Hermes, evaluation

These are Milestones 2–6 and are **not implemented yet**. The plan is in
[`docs/architecture.md`](docs/architecture.md) §6 and [`docs/evaluation.md`](docs/evaluation.md).
In summary:

- Search, Ask, Timeline and Compare screens in the local app; `npm run mcp` (a stdio MCP server
  with read-only `legal_*` tools: search, get passage, chronology, compare, verify citation).
- Hermes will connect through `~/.hermes/config.yaml` → `mcp_servers`. An example will be
  provided in `docs/hermes-mcp-example.yaml`.
- `npm run eval` will run `tests/eval/gold_cases.yaml` and report recall, page correctness and
  citation accuracy.

## Data protection and privacy

- **Local-first**: no network access at runtime, and OCR runs locally with a bundled model.
  No telemetry.
- No document text in logs: `logs/audit.jsonl` records IDs, hashes, statuses and short
  errors only.
- `.env`, evidence, generated data and logs are gitignored.
- External LLMs (later milestones) are **off by default** and need an explicit
  `ALLOW_EXTERNAL_LLM=true`.
- Future services bind to `127.0.0.1` only.

## Known limitations

See [`docs/poc-results.md`](docs/poc-results.md). The main ones: PDF layout reconstruction is
heuristic (multi-column layouts and complex tables are not handled as well as Docling would);
OCR is English-only by default; dates, document types and matters are rule-based and need
human review; RTF-only `.msg` bodies are not decoded.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` | Check prerequisites, start the app and open the browser (what the launchers run) |
| `npm run start:sample` | The same, with the fictional sample corpus |
| `npm install` | Install dependencies |
| `npm test` | Unit + integration tests |
| `npm run typecheck` | TypeScript type check |
| `npm run ingest` | Ingest `data/originals` |
| `npm run corpus` | List ingested evidence |
| `npm run check-originals -- create\|verify` | Originals manifest |
| `npm run correct -- …` | Human metadata correction |
| `npm run sample-corpus` | Generate the fictional demo corpus |
