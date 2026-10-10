import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadConfig, REPO_ROOT, type AppConfig } from "../config.js";
import { EvidenceRegistry } from "../evidence/ids.js";
import { ingest } from "../ingestion/dispatcher.js";
import { buildManifest, compareManifests } from "../ingestion/hashing.js";
import { LegalServices } from "../services.js";
import { generateSampleCorpus } from "../testing/sample-corpus.js";
import { writeJson, safeWriteFile } from "../util/fs-guard.js";

/**
 * Gold-set evaluation (Milestone 6). Measures retrieval and provenance, not prose quality.
 *
 * By default it evaluates the fictional sample corpus in an isolated workspace
 * (data/eval-sample/), so the user's own evidence and indexes are never touched.
 */

const Files = z.array(z.string());
const Case = z.discriminatedUnion("category", [
  z.object({ id: z.string(), category: z.literal("fact"), question: z.string(), expected: z.object({ files: Files, pages: z.array(z.number()).optional(), required_terms: z.array(z.string()) }) }),
  z.object({
    id: z.string(),
    category: z.literal("chronology"),
    question: z.string(),
    expected: z.object({ files: Files, events: z.array(z.object({ date: z.string(), files: Files })) }),
  }),
  z.object({
    id: z.string(),
    category: z.literal("comparison"),
    question: z.string(),
    expected: z.object({ files: Files, pairs: z.array(z.object({ files: z.tuple([z.string(), z.string()]), relations: z.array(z.string()) })) }),
  }),
  z.object({
    id: z.string(),
    category: z.literal("unaddressed"),
    question: z.string(),
    sources: Files,
    targets: Files,
    expected: z.object({ items: z.array(z.object({ label: z.string(), classification: z.array(z.string()) })) }),
  }),
  z.object({
    id: z.string(),
    category: z.literal("citation"),
    claim: z.string(),
    citation: z.object({ file: z.string(), page: z.number().optional(), chunk_id: z.string().optional(), quoted_text: z.string().optional() }),
    expected_status: z.enum(["VERIFIED", "PARTIALLY_SUPPORTED", "UNSUPPORTED", "SOURCE_ERROR"]),
  }),
  z.object({ id: z.string(), category: z.literal("insufficient"), question: z.string(), expected: z.literal("insufficient") }),
]);
const GoldFile = z.object({ version: z.number(), corpus: z.string(), cases: z.array(Case) });
type GoldCase = z.infer<typeof Case>;

export interface CaseResult {
  id: string;
  category: GoldCase["category"];
  passed: boolean;
  latency_ms: number;
  details: Record<string, unknown>;
  failure: string | null;
}

export interface EvalReport {
  generated_at: string;
  corpus: { name: string; originals: number; evidence_objects: number; chunks: number; data_dir: string };
  semantic: string;
  llm: string;
  metrics: {
    retrieval_top5_recall: number;
    retrieval_top10_recall: number;
    page_correctness: number | null;
    fact_answer_accuracy: number;
    citation_support_accuracy: number;
    citation_tests_passed: string;
    unsupported_claim_rate: number;
    chronology_precision: number;
    chronology_expected_event_recall: number;
    comparison_expected_pairs_found: string;
    unaddressed_classification_accuracy: number;
    refusal_accuracy: string;
    originals_unchanged: boolean;
    mean_latency_ms: Record<string, number>;
  };
  cases: CaseResult[];
}

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 1000 : 0);

/** Resolve gold file references to Evidence IDs via the registry (paths and aliases). */
function resolver(cfg: AppConfig): (ref: string) => string | null {
  const reg = EvidenceRegistry.load(cfg.indexesDir);
  return (ref: string) => {
    if (/^EVID-\d{6}$/.test(ref)) return ref;
    if (ref.startsWith("attachment:")) {
      const name = ref.slice("attachment:".length);
      return reg.all().find((e) => e.paths.some((p) => p.source_root === "attachments" && p.relative_path.replace(/^EVID-\d{6}\/\d{2}_/, "") === name))?.evidence_id ?? null;
    }
    return reg.all().find((e) => e.paths.some((p) => p.source_root === "originals" && p.relative_path === ref))?.evidence_id ?? null;
  };
}

export interface EvalOptions {
  goldFile?: string;
  /** "sample" (default): isolated workspace with the fictional corpus; "current": the configured corpus. */
  corpus?: "sample" | "current";
  /** Regenerate and re-ingest the sample workspace from scratch. */
  fresh?: boolean;
  /** Workspace for the sample corpus (default: data/eval-sample). */
  workspace?: string;
  log?: (s: string) => void;
}

export async function runEvaluation(baseCfg: AppConfig, opts: EvalOptions = {}): Promise<EvalReport> {
  const log = opts.log ?? (() => undefined);
  const goldFile = opts.goldFile ?? path.join(REPO_ROOT, "tests", "eval", "gold_cases.yaml");
  const gold = GoldFile.parse(parseYaml(readFileSync(goldFile, "utf8")));
  let cfg = baseCfg;
  if ((opts.corpus ?? "sample") === "sample") {
    const workspace = opts.workspace ?? path.join(REPO_ROOT, "data", "eval-sample");
    if (opts.fresh) rmSync(workspace, { recursive: true, force: true });
    cfg = loadConfig({
      originalsDir: path.join(workspace, "originals"),
      dataDir: path.join(workspace, "data"),
      auditLog: path.join(workspace, "audit.jsonl"),
      semanticProvider: baseCfg.retrieval.semantic.provider,
    });
    if (!existsSync(cfg.originalsDir)) {
      log("Generating the fictional sample corpus...");
      await generateSampleCorpus(cfg.originalsDir);
    }
  }
  const before = await buildManifest(cfg.originalsDir);
  log("Importing the evaluation corpus...");
  await ingest(cfg);
  const services = new LegalServices(cfg, log);
  const index = await services.search.getIndex();
  const resolve = resolver(cfg);
  const ids = (files: string[]) => files.map(resolve).filter((x): x is string => Boolean(x));

  const results: CaseResult[] = [];
  let retrievalCases = 0, top5 = 0, top10 = 0, pageCases = 0, pageOk = 0;
  let factCases = 0, factCorrect = 0, claims = 0, unsupportedClaims = 0, answerCitations = 0, answerCitationsCorrect = 0;
  let citeCases = 0, citeOk = 0, chronEvents = 0, chronVerified = 0, chronExpected = 0, chronFound = 0;
  let pairsExpected = 0, pairsFound = 0, itemsExpected = 0, itemsCorrect = 0, negCases = 0, negOk = 0;

  const retrieval = async (question: string, expectedIds: string[], pages?: number[]) => {
    const res = await services.searchEvidence({ query: question, top_k: 10 });
    const rank = res.results.findIndex((r) => expectedIds.includes(r.evidence_id));
    retrievalCases++;
    if (rank >= 0 && rank < 5) top5++;
    if (rank >= 0) top10++;
    let pageCorrect: boolean | null = null;
    if (pages?.length && rank >= 0 && res.results[rank]!.page !== null) {
      pageCases++;
      pageCorrect = pages.includes(res.results[rank]!.page!);
      if (pageCorrect) pageOk++;
    }
    return { rank: rank >= 0 ? rank + 1 : null, top: res.results.slice(0, 5).map((r) => `${r.evidence_id}${r.page ? ` p.${r.page}` : ` ${r.section_id}`}`), page_correct: pageCorrect };
  };

  for (const c of gold.cases) {
    const t0 = Date.now();
    let passed = false;
    let failure: string | null = null;
    const details: Record<string, unknown> = {};
    try {
      if (c.category === "fact") {
        const exp = ids(c.expected.files);
        if (!exp.length) throw new Error("expected files not found in the corpus");
        details.retrieval = await retrieval(c.question, exp, c.expected.pages);
        const a = await services.ask(c.question);
        factCases++;
        const text = `${a.answer} ${a.claims.map((x) => x.text).join(" ")}`.toLowerCase();
        const termsOk = c.expected.required_terms.every((t) => text.includes(t.toLowerCase()));
        for (const cl of a.claims) {
          claims++;
          if (!["VERIFIED", "PARTIALLY_SUPPORTED"].includes(cl.status)) unsupportedClaims++;
          // A citation is correct when it is verified AND the cited passage itself states the
          // fact being asked for (at least one required term), wherever it comes from.
          for (const ci of cl.citations) {
            answerCitations++;
            const states = c.expected.required_terms.some((t) => ci.quote.toLowerCase().includes(t.toLowerCase()));
            if (ci.verification.status === "VERIFIED" && states) answerCitationsCorrect++;
          }
        }
        const citedExpected = a.claims.some((cl) => cl.citations.some((ci) => exp.includes(ci.evidence_id)));
        passed = a.status === "answered" && termsOk && citedExpected;
        if (passed) factCorrect++;
        else failure = a.status !== "answered" ? `refused: ${a.notes.join("; ")}` : !termsOk ? `answer lacks ${c.expected.required_terms.join(", ")}` : "answer cites none of the expected documents";
        details.answer = a.answer;
        details.citations = a.claims.flatMap((cl) => cl.citations.map((ci) => `${ci.evidence_id}${ci.page ? ` p.${ci.page}` : ` ${ci.section_id}`} ${ci.verification.status}`));
      } else if (c.category === "chronology") {
        const exp = ids(c.expected.files);
        details.retrieval = await retrieval(c.question, exp);
        const ch = await services.chronology({ query: c.question });
        chronEvents += ch.events.length;
        chronVerified += ch.events.filter((e) => e.citations.some((x) => x.verification === "VERIFIED")).length;
        const missing: string[] = [];
        for (const ev of c.expected.events) {
          chronExpected++;
          const evIds = ids(ev.files);
          const hit = ch.events.some((e) => e.date === ev.date && e.citations.some((x) => evIds.includes(x.evidence_id)));
          if (hit) chronFound++;
          else missing.push(ev.date);
        }
        passed = missing.length === 0;
        if (!passed) failure = `expected event(s) not found: ${missing.join(", ")}`;
        details.events = ch.events.length;
        details.matter_filter = ch.matter_filter;
      } else if (c.category === "comparison") {
        const exp = ids(c.expected.files);
        details.retrieval = await retrieval(c.question, exp);
        const cmp = await services.compare({ issue: c.question });
        const byId = new Map(cmp.documents.flatMap((d) => d.propositions.map((pr) => [pr.id, pr.citation.evidence_id] as const)));
        const missing: string[] = [];
        for (const ep of c.expected.pairs) {
          pairsExpected++;
          const [a, b] = [resolve(ep.files[0]), resolve(ep.files[1])];
          const found = cmp.pairs.filter((pr) => {
            const x = byId.get(pr.a);
            const y = byId.get(pr.b);
            return (x === a && y === b) || (x === b && y === a);
          });
          const ok = found.some((f) => ep.relations.includes(f.relation)) && !(ep.relations.every((r) => r === "consistent" || r === "changed_wording") && found.some((f) => f.relation === "potential_contradiction"));
          if (ok) pairsFound++;
          else missing.push(`${a}<>${b} (${found.map((f) => f.relation).join("/") || "not paired"})`);
        }
        passed = missing.length === 0;
        if (!passed) failure = `expected relation not found: ${missing.join("; ")}`;
        details.pairs = cmp.pairs.slice(0, 8).map((pr) => `${byId.get(pr.a)}<>${byId.get(pr.b)} ${pr.relation} ${pr.similarity}`);
      } else if (c.category === "unaddressed") {
        const rep = await services.unaddressed({ source_evidence_ids: ids(c.sources), target_evidence_ids: ids(c.targets) });
        const wrong: string[] = [];
        for (const it of c.expected.items) {
          itemsExpected++;
          const got = rep.items.find((x) => x.label.replace(/[\s.]/g, "").toLowerCase() === it.label.replace(/[\s.]/g, "").toLowerCase());
          if (got && it.classification.includes(got.classification)) itemsCorrect++;
          else wrong.push(`${it.label}: ${got?.classification ?? "not extracted"} (expected ${it.classification.join("|")})`);
        }
        passed = wrong.length === 0;
        if (!passed) failure = wrong.join("; ");
        details.items = rep.items.map((x) => `${x.label}: ${x.classification} (${x.confidence})`);
      } else if (c.category === "citation") {
        const id = resolve(c.citation.file);
        const v = await services.verify({ claim: c.claim, evidence_id: id ?? "EVID-000000", page: c.citation.page ?? null, chunk_id: c.citation.chunk_id ?? null, quoted_text: c.citation.quoted_text ?? null });
        citeCases++;
        passed = v.status === c.expected_status;
        if (passed) citeOk++;
        else failure = `got ${v.status}, expected ${c.expected_status}: ${v.reasons.join("; ")}`;
        details.status = v.status;
        details.reasons = v.reasons;
      } else {
        const a = await services.ask(c.question);
        negCases++;
        passed = a.status === "insufficient_evidence";
        if (passed) negOk++;
        else failure = `answered instead of refusing: ${a.answer.slice(0, 120)}`;
        details.notes = a.notes;
      }
    } catch (err) {
      failure = `error: ${(err as Error).message}`;
    }
    results.push({ id: c.id, category: c.category, passed, latency_ms: Date.now() - t0, details, failure });
    log(`${passed ? "PASS" : "FAIL"} ${c.id}${failure ? `: ${failure}` : ""}`);
  }

  const diff = compareManifests(before, await buildManifest(cfg.originalsDir));
  const latency: Record<string, number> = {};
  for (const cat of [...new Set(results.map((r) => r.category))]) {
    const xs = results.filter((r) => r.category === cat).map((r) => r.latency_ms);
    latency[cat] = Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
  }
  const report: EvalReport = {
    generated_at: new Date().toISOString(),
    corpus: {
      name: gold.corpus,
      originals: before.file_count,
      evidence_objects: index.records.size,
      chunks: index.items.length,
      data_dir: cfg.dataDir,
    },
    semantic: index.semanticNote,
    llm: cfg.llm.provider,
    metrics: {
      retrieval_top5_recall: ratio(top5, retrievalCases),
      retrieval_top10_recall: ratio(top10, retrievalCases),
      page_correctness: pageCases ? ratio(pageOk, pageCases) : null,
      fact_answer_accuracy: ratio(factCorrect, factCases),
      citation_support_accuracy: ratio(citeOk + answerCitationsCorrect, citeCases + answerCitations),
      citation_tests_passed: `${citeOk}/${citeCases}`,
      unsupported_claim_rate: ratio(unsupportedClaims, claims),
      chronology_precision: ratio(chronVerified, chronEvents),
      chronology_expected_event_recall: ratio(chronFound, chronExpected),
      comparison_expected_pairs_found: `${pairsFound}/${pairsExpected}`,
      unaddressed_classification_accuracy: ratio(itemsCorrect, itemsExpected),
      refusal_accuracy: `${negOk}/${negCases}`,
      originals_unchanged: diff.ok && diff.added.length === 0,
      mean_latency_ms: latency,
    },
    cases: results,
  };
  writeJson(path.join(cfg.dataDir, "..", "eval-report.json"), report);
  return report;
}

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)} %`);

export function renderReportMarkdown(r: EvalReport): string {
  const m = r.metrics;
  const failed = r.cases.filter((c) => !c.passed);
  return [
    `Generated ${r.generated_at} by \`npm run eval\` on the **${r.corpus.name}** corpus: ${r.corpus.originals} original files, ${r.corpus.evidence_objects} evidence objects, ${r.corpus.chunks} chunks. Semantic retrieval: ${r.semantic}. LLM: ${r.llm}.`,
    "",
    "| Metric | Result | Target |",
    "| --- | --- | --- |",
    `| Top-10 expected-source recall | ${pct(m.retrieval_top10_recall)} | ≥ 90 % |`,
    `| Top-5 expected-source recall | ${pct(m.retrieval_top5_recall)} | ≥ 80 % |`,
    `| Page correctness (paginated expected sources) | ${pct(m.page_correctness)} | report |`,
    `| Exact-fact answers correct (required terms + expected source cited) | ${pct(m.fact_answer_accuracy)} | report |`,
    `| Citation-support accuracy (citation tests + answer citations) | ${pct(m.citation_support_accuracy)} | ≥ 95 % |`,
    `| Citation tests (incl. deliberately wrong citations) | ${m.citation_tests_passed} | all |`,
    `| Unsupported material claims in answers | ${pct(m.unsupported_claim_rate)} | ≤ 5 % |`,
    `| Chronology precision (events with a verified citation) | ${pct(m.chronology_precision)} | report |`,
    `| Chronology expected-event recall | ${pct(m.chronology_expected_event_recall)} | report |`,
    `| Comparison: expected relations found | ${m.comparison_expected_pairs_found} | report |`,
    `| Unaddressed-evidence classification accuracy | ${pct(m.unaddressed_classification_accuracy)} | report |`,
    `| Refusals when evidence is insufficient | ${m.refusal_accuracy} | all |`,
    `| Original evidence unchanged | ${m.originals_unchanged ? "yes" : "**NO**"} | zero modification |`,
    `| Mean latency per case (ms) | ${Object.entries(m.mean_latency_ms).map(([k, v]) => `${k} ${v}`).join(", ")} | report |`,
    "",
    `Cases: ${r.cases.length - failed.length}/${r.cases.length} passed.`,
    "",
    failed.length ? "Failures:" : "No failing cases.",
    ...failed.map((c) => `- **${c.id}** (${c.category}): ${c.failure}`),
  ].join("\n");
}

/** Replace the generated block in docs/poc-results.md. */
export function writeResultsDoc(report: EvalReport, file = path.join(REPO_ROOT, "docs", "poc-results.md")): void {
  const start = "<!-- eval:start -->";
  const end = "<!-- eval:end -->";
  const doc = readFileSync(file, "utf8");
  const block = `${start}\n${renderReportMarkdown(report)}\n${end}`;
  const next = doc.includes(start) && doc.includes(end) ? doc.replace(new RegExp(`${start}[\\s\\S]*?${end}`), block) : `${doc.trimEnd()}\n\n## Evaluation results (generated)\n\n${block}\n`;
  safeWriteFile(file, next);
}
