# Evaluation

The POC is judged on **retrieval and provenance**, not on whether generated prose sounds right.
Results, including failures, are in `docs/poc-results.md`.

## How to run

- In the app: **Evaluation** tab → **Run evaluation**.
- Terminal: `npm run eval`. Options:
  - `--fresh` rebuilds the evaluation workspace;
  - `--write-docs` updates the generated block in `docs/poc-results.md`;
  - `--gold <file>` uses another case file;
  - `--corpus current` evaluates the configured corpus instead of the sample.

By default the runner works on the **fictional sample corpus**, in an isolated workspace
(`data/eval-sample/`). It generates the corpus, imports it and runs every case. It also
manifests the originals before and after the run, to prove that nothing was modified. Your own
evidence and indexes are never used or touched.

## Case files

| File | Purpose |
| --- | --- |
| `tests/eval/gold_cases.yaml` | 30 hand-curated cases: 7 exact facts, 5 chronologies, 4 comparisons, 3 unaddressed-evidence analyses, 8 citation tests (5 deliberately wrong or degraded), 3 questions that must be refused. Used during development. |
| `tests/eval/holdout_cases.yaml` | 14 cases written after development and run **once** before any further change, to estimate overfitting. Do not tune against them; add new held-out cases instead. |

Expected evidence is given by file path (`files:`), or `attachment:<name>` for extracted
attachments. The runner resolves these to Evidence IDs through the registry, so cases don't
depend on ID allocation. For a real corpus with a fixed registry, `evidence_ids:` can be
used directly. Several acceptable sources may be listed.

```yaml
- id: FACT-002
  category: fact
  question: "Under which reference was the request for assistance registered?"
  expected:
    files: [article24/2025-01-20_acknowledgement_of_registration.pdf, article24/2025-05-12_decision_on_request_for_assistance.pdf]
    pages: [1]
    required_terms: ["ART24-2025-0012"]

- id: CITE-002
  category: citation
  claim: "The request was registered on 21 January 2025."
  citation: { file: article24/2025-05-12_decision_on_request_for_assistance.pdf, page: 1 }
  expected_status: UNSUPPORTED
```

Other categories: `chronology` (expected `events` with date + acceptable files), `comparison`
(expected `pairs` of files with acceptable relations; a pair expected to be consistent fails
if it is flagged as a potential contradiction), `unaddressed` (`sources`, `targets`, expected
classification per annex label), `insufficient` (must be refused).

## Metrics (as implemented)

| Metric | Definition | Target |
| --- | --- | --- |
| Top-10 / top-5 recall | Share of fact, chronology and comparison questions for which an expected Evidence ID appears in the top 10 / top 5 search results for the question | ≥ 90 % / ≥ 80 % |
| Page correctness | For the highest-ranked expected source that is paginated: its page is one of the expected pages | report |
| Exact-fact answer accuracy | The answer contains every required term and cites at least one expected source | report |
| Citation-support accuracy | (citation tests whose status matches the expected status + answer citations that are VERIFIED **and** whose cited passage itself contains a required term) ÷ all of them | ≥ 95 % |
| Unsupported-claim rate | Answer claims whose citation is not VERIFIED/PARTIALLY_SUPPORTED ÷ all answer claims | ≤ 5 % |
| Chronology precision | Events with at least one VERIFIED citation ÷ all events produced | report |
| Chronology expected-event recall | Expected events found (same date, cited from an acceptable file) ÷ expected events | report |
| Comparison relations | Expected pairs found with an acceptable relation | report |
| Unaddressed-evidence accuracy | Annexes classified as expected ÷ annexes | report |
| Refusals | Questions without an answer in the corpus that are refused | all |
| Originals unchanged | Manifest (name, size, mtime, SHA-256) identical before and after the run | must be true |
| Latency | Mean wall time per case and category | report |

**Contradiction quality** is rated **manually** (correct / plausible / overstated / wrong) on
the suggested relations. A rating sheet is in `docs/poc-results.md`.

## Evaluating a real corpus

1. Copy 30–50 representative files into `data/originals/` and import them in the app.
2. Write `my_gold.yaml` (≥ 20 cases) in the format above, referencing your files by
   path under `data/originals`.
3. Run `npm run eval -- --corpus current --gold my_gold.yaml`.
4. Rate the comparison and unaddressed-evidence outputs manually.
5. Click **Check originals unchanged** (or `npm run check-originals -- verify`).
6. Record results and failures in `docs/poc-results.md`.

Keep a held-out subset you only run once at the end. Results on cases you tuned against are
optimistic.
