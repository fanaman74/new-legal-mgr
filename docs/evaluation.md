# Evaluation plan

The POC is judged on **retrieval and provenance**, not on whether generated prose sounds right.
Results go into `docs/poc-results.md`, including the failures.

## Corpus

- 30–50 representative files copied into `data/originals/` (copies only; never the master archive):
  5–8 official decisions/responses, 5–8 complaints/submissions, 3–5 investigation/audit reports,
  5–10 lawyer/court documents, 8–12 emails (`.msg` and `.eml`), several annexes/attachments,
  and 2–4 scanned documents.
- Choose documents that overlap factually (the same events, dates and annexes referred to
  in several places), so that cross-document behaviour is tested.
- The synthetic corpus from `npm run sample-corpus` is for development and automated tests
  only. It is not the evaluation corpus.

## Gold set: `tests/eval/gold_cases.yaml` (Milestone 6)

At least 20 manually curated questions:

| Category | Count | ID prefix |
| --- | --- | --- |
| Exact factual questions | 5 | `FACT-` |
| Chronology questions | 5 | `CHRON-` |
| Cross-document comparison | 4 | `CMP-` |
| Potentially-unaddressed evidence | 3 | `UNADD-` |
| Citation-verification tests (including deliberately wrong citations) | 3 | `CITE-` |

Schema:

```yaml
- id: FACT-001
  question: "When was the Article 24 request registered?"
  expected:
    evidence_ids: [EVID-000002]          # any of these counts as a hit; list all acceptable sources
    pages: [1]                            # for paginated sources
    required_terms: ["20 January 2025"]  # must appear in the answer and in the cited passage
  notes: "Acknowledgement letter, labelled date."

- id: CITE-002
  claim: "The decision addresses the witness statement of Ms Rossi."
  citation: { evidence_id: EVID-000003, page: 1 }
  expected_status: UNSUPPORTED            # VERIFIED | PARTIALLY_SUPPORTED | UNSUPPORTED | SOURCE_ERROR
```

Gold cases reference Evidence IDs. These are stable for a given registry
(`data/indexes/evidence-registry.json`), so keep the registry together with the evaluation
corpus.

## Metrics

| Metric | Definition | Target |
| --- | --- | --- |
| Top-10 recall | Share of questions where an expected Evidence ID is in the top 10 results | ≥ 90 % |
| Top-5 recall | Same, top 5 | ≥ 80 % |
| Page correctness | For paginated expected sources: the returned chunk's page is an expected page | report |
| Citation-support accuracy | Verifier status matches the gold label / the cited passage really supports the claim | ≥ 95 % |
| Unsupported-claim rate | Material generated claims without a valid supporting citation | ≤ 5 % |
| Chronology precision | Timeline events supported by their cited evidence | report |
| Contradiction quality | Manual rating per finding: correct / plausible / overstated / wrong | report |
| Latency | Approximate wall time per query type | report only |
| Original evidence modification | `npm run check-originals -- verify` after all runs | zero changes |

## Procedure

1. `npm run check-originals -- create` before the first ingestion.
2. `npm run ingest`. Review `npm run corpus` and correct obviously wrong metadata with
   `npm run correct` (corrections are logged and kept separate).
3. Run the gold set (Milestone 6: `npm run eval`). It writes per-question results and
   aggregate metrics.
4. Rate the comparison and unaddressed-evidence outputs manually.
5. `npm run check-originals -- verify` must report no changes.
6. Record the results, the failures and their likely causes in `docs/poc-results.md`.

## Milestone 1 checks (automated today)

`npm test` already verifies the ingestion acceptance criteria on the synthetic corpus: originals
unchanged (name, size, mtime, SHA-256), duplicate and rename detection, `.msg`/`.eml` metadata,
attachment linkage (including embedded messages), OCR of scanned pages, page numbers on all
PDF chunks, no invented page numbers elsewhere, exact chunk offsets, failures recorded without
stopping the batch, and no document content in the audit log.
