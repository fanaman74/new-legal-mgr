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
   - downloads the local search model once (about 25–90 MB). If you are offline, the app uses
     a simpler built-in semantic search and retries next time;
   - checks the prerequisites and opens the app in your browser at `http://127.0.0.1:8787/`.
4. In the app, click **Open evidence folder**, copy your evidence files (copies) into it, then
   click **Import evidence**.

Double-clicking again while the app is running just reopens the browser page; it never starts
a second copy. Close the setup window to stop the app. To try the app with the fictional
sample corpus, run the launcher with `--sample` (or `npm run start:sample`).

### What you can do in the app

| Tab | What it does |
| --- | --- |
| **Evidence** | Prerequisites; import; *Check originals unchanged*; the corpus (Evidence ID, file, type, date, matter, status); per-document provenance, extracted text by page/section, *Open original*, and **Correct metadata** (audited, never touches the file). |
| **Search** | Hybrid search: exact names, dates, references and `"quoted phrases"` plus meaning-based matches. Filters: matter, type, date range, author. Every hit shows Evidence ID, file, page/section and chunk. |
| **Ask** | A question answered **only from the evidence**, quoting the supporting passage with page and verification status. Otherwise it says *"Insufficient evidence found in the indexed corpus."* |
| **Timeline** | A cited chronology: dates stated in documents, emails sent, document dates. Inferred dates are marked, and confidence rises with corroboration. |
| **Compare** | Statements on an issue from several documents, in chronological order, with suggested relations (consistent, changed wording, possible tension, potential contradiction) for human review. |
| **Unaddressed evidence** | Which annexes/attachments raised in a submission are not treated in a decision, with confidence, explanation and the sections searched. Probabilistic. |
| **Verify citation** | Checks a claim against its cited source: VERIFIED, PARTIALLY_SUPPORTED, UNSUPPORTED or SOURCE_ERROR, with reasons. |
| **Evaluation** | Runs the gold question set on the fictional sample corpus (your evidence is not used) and shows the metrics. |

## Status

| Milestone | State |
| --- | --- |
| 0 Inspect and plan | ✅ done (`docs/architecture.md`) |
| 1 Immutable evidence ingestion (PDF, scanned PDF, DOCX, `.msg`, `.eml`, TXT/MD) | ✅ done |
| 2 Retrieval: hybrid lexical + semantic, filters, page provenance | ✅ done |
| 3 Grounded Q&A, citation verification, refusal | ✅ done (extractive by default; optional local LLM) |
| 4 Chronology, position comparison, potentially-unaddressed evidence | ✅ done |
| 5 MCP server for Hermes; local web app and double-click launchers | ✅ done (MCP tested with an MCP client; not yet with a live Hermes install) |
| 6 Gold-set evaluation | ✅ done, results in [`docs/poc-results.md`](docs/poc-results.md) |

All of this was evaluated on a **fictional** corpus. Test it on a real 30–50-file corpus
before drawing conclusions (see `docs/evaluation.md`).

## Architecture in one paragraph

Everything runs in **Node.js (TypeScript), with no Docker and no Python**. Originals are
hashed and registered under stable Evidence IDs, then parsed: PDFs with pdfjs-dist, scanned
pages OCR'd locally with tesseract.js, DOCX with mammoth, `.msg` with msgreader and cfb,
`.eml` with mailparser. The output is structural chunks with exact offsets, plus canonical
JSON records. Retrieval fuses BM25 (legal-aware tokens for references, articles, annexes and
dates) with local sentence embeddings (transformers.js + ONNX, offline). Answers, chronology,
comparison and unaddressed-evidence analysis are deterministic services whose every output
cites, and is verified against, the source text. The same services are exposed to the web
app and, read-only, to Hermes over MCP. See [`docs/architecture.md`](docs/architecture.md),
including how this deviates from the original brief (RAGFlow and Docling are replaced by
in-process components).

## Prerequisites

- **Node.js 20.12 or newer** (tested on 22 and 24), which the launchers can download for you.
  No Docker, no Python, no system OCR. Works on Windows, macOS and Linux.
- About 1 GB of disk space (libraries, including ONNX Runtime for all platforms; OCR and
  search models).

## Where to put evidence: the read-only rule

Put **copies** of your evidence in `data/originals/` (the app's **Open evidence folder**
button opens it). Sub-folders are recommended. A folder name listed in `config/matters.yaml`
(e.g. `article24/`) assigns that matter to everything inside it.

```text
data/originals/
  article24/   decisions, requests, acknowledgements, annexes…
  article90/   complaint and reply
  audit/       audit / IAS material
  court/       court pleadings
  emails/      .msg and .eml files
  lawyer/      lawyer correspondence
```

`data/originals/` is **read-only for the application**. Code never renames, moves, deletes,
edits, overwrites or converts anything there: all writes go through a guard that refuses
paths inside it, and every import compares a manifest taken before and after the run.
Generated files go to `data/extracted`, `data/canonical`, `data/attachments` and
`data/indexes`. For extra safety, also make the folder read-only in your operating system.
Everything under `data/` (except `.gitkeep`) is gitignored. Never commit evidence.

## Connecting Hermes (MCP)

The MCP server exposes eight **read-only** tools: `legal_search`, `legal_get_document`,
`legal_get_passage`, `legal_ask`, `legal_build_chronology`, `legal_compare_positions`,
`legal_find_unaddressed_evidence` and `legal_verify_citation`. None of them can write,
rename or delete evidence.

1. Import your evidence with the app first (the MCP server serves what has been imported).
2. Copy the `mcp_servers` block from [`docs/hermes-mcp-example.yaml`](docs/hermes-mcp-example.yaml)
   into `~/.hermes/config.yaml` and replace `/path/to/legal-evidence-poc` with this folder.
3. Restart Hermes. The tools appear with Hermes' server prefix
   (e.g. `mcp_legal_evidence_legal_search`).

The server runs as `node node_modules/tsx/dist/cli.mjs scripts/mcp.ts` (stdio), which is
what Hermes starts. Developers can run it with `npm run mcp`.

## Optional: generative answers with a local LLM

By default, answers are **extractive**: quoted verbatim from the evidence and verified, with
no language model involved. To let a local model phrase answers, run e.g.
[Ollama](https://ollama.com) and set in `.env`:

```bash
LLM_PROVIDER=ollama
LLM_URL=http://127.0.0.1:11434
LLM_MODEL=llama3.1:8b
```

The model must return claims with citations. Every citation is verified, and claims that fail
are removed and listed separately. A non-local endpoint is refused unless
`ALLOW_EXTERNAL_LLM=true`, because the request contains document text.

## Evaluation

Click **Run evaluation** in the app, or run `npm run eval` (`--write-docs` updates
`docs/poc-results.md`). It runs `tests/eval/gold_cases.yaml` (30 cases) on the fictional
sample corpus in a separate workspace. For your own corpus, write a gold file in the same
format and run `npm run eval -- --corpus current --gold <file>`. See
[`docs/evaluation.md`](docs/evaluation.md).

## Data protection and privacy

- **Local-first**: no network access at run time. The OCR and search models are local files,
  downloaded once at setup. No telemetry.
- The web app listens on `127.0.0.1` only, rejects foreign Host/Origin headers, and requires a
  custom header for actions.
- No document text in logs: `logs/audit.jsonl` records IDs, hashes, statuses and short
  errors. Queries are logged only as a hash.
- `.env`, evidence, generated data, models and logs are gitignored.
- LLMs are off by default; external ones need an explicit `ALLOW_EXTERNAL_LLM=true`.

## Known limitations

See [`docs/poc-results.md`](docs/poc-results.md). The main ones:
- **Evaluated on fictional data only.** The gold set was also used during development; the
  held-out set's first run (11/14) is the more honest estimate.
- **Verifier.** It is deterministic and conservative: loose paraphrases may come out
  UNSUPPORTED.
- **Comparison.** Lower-severity relation labels are noisy.
- **Layout.** PDF layout reconstruction is heuristic (multi-column layouts and complex
  tables).
- **OCR and languages.** OCR is English-only by default, and the default search model is
  English (`multilingual-e5-small` is available).
- **Metadata.** Dates, types and matters are rule-based and need human review.

## Commands (developers)

| Command | Purpose |
| --- | --- |
| `npm start` | Check prerequisites, start the app and open the browser (what the launchers run) |
| `npm run start:sample` | The same, with the fictional sample corpus |
| `npm install` / `npm test` / `npm run typecheck` | Install, test, type-check |
| `npm run ingest` | Import `data/originals` (`--force` to re-parse, `--no-ocr`) |
| `npm run corpus` | List imported evidence (`-- --id EVID-000003` for one record) |
| `npm run check-originals -- create\|verify` | Originals manifest |
| `npm run correct -- --id … --field … --value … --reason …` | Human metadata correction |
| `npm run search -- "query"` / `npm run ask -- "question"` | Search / grounded answer |
| `npm run mcp` | MCP server (stdio) for Hermes |
| `npm run eval` | Gold-set evaluation |
| `npm run setup-models` | Download the local search model |
| `npm run sample-corpus` | Generate the fictional demo corpus |
