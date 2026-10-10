import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../../src/config.js";
import { ingest } from "../../src/ingestion/dispatcher.js";
import { createMcpServer } from "../../src/mcp-server/server.js";
import { readModelManifest } from "../../src/retrieval/models.js";
import { LegalServices } from "../../src/services.js";
import { EvidenceRegistry } from "../../src/evidence/ids.js";
import { generateSampleCorpus } from "../../src/testing/sample-corpus.js";
import { resetProtectedDirectories } from "../../src/util/fs-guard.js";
import { runEvaluation } from "../../src/evaluation/runner.js";
import { makeWorkspace, type Workspace } from "../helpers.js";

/**
 * Milestones 2-6 on the fictional sample corpus. Uses the local embedding model when it is
 * installed, otherwise the built-in LSA fallback (so the suite runs without any download).
 */

const base = loadConfig();
const provider = readModelManifest(base.retrieval.semantic.modelsDir, base.retrieval.semantic.model) ? "auto" : "lsa";
let ws: Workspace;
let cfg: AppConfig;
let services: LegalServices;
let id: (rel: string) => string;

beforeAll(async () => {
  resetProtectedDirectories();
  ws = makeWorkspace();
  cfg = { ...ws.cfg, retrieval: { ...ws.cfg.retrieval, semantic: { ...ws.cfg.retrieval.semantic, provider } } };
  await generateSampleCorpus(ws.originals);
  await ingest(cfg);
  services = new LegalServices(cfg);
  const reg = EvidenceRegistry.load(cfg.indexesDir);
  id = (rel) => reg.all().find((e) => e.paths.some((p) => p.relative_path === rel))!.evidence_id;
}, 300_000);

describe("hybrid retrieval", () => {
  it("finds exact references first and returns full provenance", async () => {
    const res = await services.searchEvidence({ query: "R/123/25", top_k: 5 });
    const top = res.results[0]!;
    expect([id("article90/2025-11-28_reply_to_complaint_article90.pdf"), id("article90/2025-08-04_acknowledgement_of_complaint.eml")]).toContain(top.evidence_id);
    expect(top).toMatchObject({ retrieval_method: expect.arrayContaining(["lexical"]) });
    expect(top.chunk_id.startsWith(top.evidence_id)).toBe(true);
    expect(top.text).toContain("R/123/25");
    for (const r of res.results) {
      if (r.filename.endsWith(".pdf")) expect(r.page).toBeGreaterThanOrEqual(1);
      else expect(r.page).toBeNull();
    }
  });

  it("matches dates across formats and applies filters", async () => {
    const res = await services.searchEvidence({ query: "2025-01-20", top_k: 5 });
    expect(res.results[0]!.text).toMatch(/20 January 2025/);
    const scoped = await services.searchEvidence({ query: "decision", matter: ["court"], document_type: ["court_submission"], date_from: "2026-01-01" });
    expect(scoped.results.length).toBeGreaterThan(0);
    for (const r of scoped.results) {
      expect(r.matter).toContain("court");
      expect(r.document_type).toBe("court_submission");
      expect(r.document_date! >= "2026-01-01").toBe(true);
    }
  });

  it("treats quoted phrases as mandatory and finds paraphrases semantically", async () => {
    const quoted = await services.searchEvidence({ query: '"did not establish a repeated pattern"' });
    expect(quoted.results.map((r) => r.evidence_id)).toEqual([id("investigation/2025-04-14_administrative_inquiry_report.pdf")]);
    const para = await services.searchEvidence({ query: "was the employee blamed for the auditors' findings", top_k: 10 });
    expect(para.results.some((r) => r.retrieval_method.includes("semantic"))).toBe(true);
  });
});

describe("grounded answers", () => {
  it("answers with a concise fact and a verified citation", async () => {
    const a = await services.ask("When was the Article 90 complaint registered and under which reference?");
    expect(a.status).toBe("answered");
    expect(a.answer).toMatch(/^4 August 2025\./);
    expect(a.answer).toContain("R/123/25");
    expect(a.verification).toBe("VERIFIED");
    expect(a.formatted).toContain("Verification: VERIFIED");
  });

  it("uses the document date for performative statements and cites the date line", async () => {
    const a = await services.ask("When was the administrative inquiry opened?");
    expect(a.answer).toContain("3 March 2025");
    expect(a.claims[0]!.citations.map((c) => c.quote)).toContain("Brussels, 3 March 2025");
  });

  it("refuses when the corpus does not contain the answer", async () => {
    for (const q of ["How much compensation did the General Court award?", "When was Mr Hale dismissed?", "What is the capital of France?"]) {
      const a = await services.ask(q);
      expect(a.status, q).toBe("insufficient_evidence");
      expect(a.answer).toBe("Insufficient evidence found in the indexed corpus.");
    }
  });
});

describe("citation verification", () => {
  const decision = () => id("article24/2025-05-12_decision_on_request_for_assistance.pdf");
  it("verifies correct citations and rejects deliberately wrong ones", async () => {
    const v = (x: Parameters<LegalServices["verify"]>[0]) => services.verify(x).then((r) => r.status);
    expect(await v({ claim: "The request was registered on 20 January 2025.", evidence_id: decision(), page: 1 })).toBe("VERIFIED");
    expect(await v({ claim: "The request was registered on 21 January 2025.", evidence_id: decision(), page: 1 })).toBe("UNSUPPORTED");
    expect(await v({ claim: "The decision granted the request.", evidence_id: decision(), page: 2 })).toBe("UNSUPPORTED");
    expect(await v({ claim: "The request was rejected.", evidence_id: decision(), page: 2, quoted_text: "the request is hereby granted" })).toBe("UNSUPPORTED");
    expect(await v({ claim: "The request for assistance was rejected.", evidence_id: decision(), page: 1, quoted_text: "the request for assistance is rejected" })).toBe("PARTIALLY_SUPPORTED");
    expect(await v({ claim: "x", evidence_id: decision(), page: 9 })).toBe("SOURCE_ERROR");
    expect(await v({ claim: "x", evidence_id: "EVID-999999" })).toBe("SOURCE_ERROR");
    const report = id("investigation/2025-04-14_administrative_inquiry_report.pdf");
    expect(await v({ claim: "Ms Rossi was interviewed on 24 March 2025.", evidence_id: report, page: 1 })).toBe("UNSUPPORTED");
    expect(await v({ claim: "Ms Rossi was interviewed on 20 March 2025.", evidence_id: report, page: 1 })).toBe("VERIFIED");
  });
});

describe("analysis services", () => {
  it("builds a cited, sorted chronology with inferred dates flagged", async () => {
    const c = await services.chronology({ query: "Build the chronology of the Article 24 procedure from submission to final decision" });
    expect(c.matter_filter).toEqual(["article24"]);
    const dates = c.events.map((e) => e.date);
    expect([...dates].sort()).toEqual(dates);
    for (const d of ["2025-01-17", "2025-01-20", "2025-05-12"]) expect(dates).toContain(d);
    for (const e of c.events) {
      expect(e.citations.length).toBeGreaterThan(0);
      expect(e.citations.every((x) => x.verification === "VERIFIED" || x.verification === "PARTIALLY_SUPPORTED")).toBe(true);
    }
    expect(c.events.find((e) => e.date === "2025-01-17" && e.date_type === "explicit")?.confidence).toBe("high");
    expect(c.events.some((e) => e.inferred)).toBe(true);
  });

  it("flags the termination letter against counsel's letter, with a caveat", async () => {
    const c = await services.compare({ issue: "Compare the organisation's position on the audit report across the termination material, lawyer correspondence and later submissions" });
    const owner = new Map(c.documents.flatMap((d) => d.propositions.map((p) => [p.id, d.evidence_id] as const)));
    const [t, l] = [id("termination/2025-02-28_termination_letter.docx"), id("lawyer/2025-03-15_letter_from_counsel.docx")];
    const pair = c.pairs.find((p) => new Set([owner.get(p.a), owner.get(p.b)]).has(t) && new Set([owner.get(p.a), owner.get(p.b)]).has(l));
    expect(["potential_contradiction", "possible_tension"]).toContain(pair?.relation);
    expect(c.caveat).toMatch(/human review/);
    const dates = c.documents.map((d) => d.document_date ?? "9999");
    expect([...dates].sort()).toEqual(dates);
  });

  it("classifies annexes cautiously, with the probabilistic warning", async () => {
    const r = await services.unaddressed({
      source_evidence_ids: [id("article90/2025-07-30_complaint_article90_against_decision.pdf")],
      target_evidence_ids: [id("article90/2025-11-28_reply_to_complaint_article90.pdf")],
    });
    const cls = Object.fromEntries(r.items.map((i) => [i.label, i.classification]));
    expect(cls).toMatchObject({ "Annex 1": "no_treatment_found", "Annex 2": "addressed", "Annex 3": "addressed", "Annex 4": "referenced_only" });
    expect(r.warning).toMatch(/probabilistic/);
    expect(r.sections_searched.length).toBeGreaterThan(0);
    expect(r.items.find((i) => i.label === "Annex 1")!.raised_in[0]!.page).toBe(2);
  });
});

describe("MCP server", () => {
  it("exposes only read-only tools and answers through the protocol", async () => {
    const server = createMcpServer(services);
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual([
      "legal_ask", "legal_build_chronology", "legal_compare_positions", "legal_find_unaddressed_evidence",
      "legal_get_document", "legal_get_passage", "legal_search", "legal_verify_citation",
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true && t.annotations?.destructiveHint === false)).toBe(true);
    expect(tools.some((t) => /write|delete|rename|import|ingest/i.test(t.name))).toBe(false);
    const text = (r: Awaited<ReturnType<typeof client.callTool>>) => (r.content as { text: string }[])[0]!.text;
    const search = JSON.parse(text(await client.callTool({ name: "legal_search", arguments: { query: "T-123/26", top_k: 3 } })));
    expect(search.results[0].text).toContain("T-123/26");
    const passage = JSON.parse(text(await client.callTool({ name: "legal_get_passage", arguments: { evidence_id: search.results[0].evidence_id, chunk_id: search.results[0].chunk_id } })));
    expect(passage.passages[0].text).toBe(search.results[0].text);
    const chron = JSON.parse(text(await client.callTool({ name: "legal_build_chronology", arguments: { query: "proceedings before the General Court" } })));
    expect(chron.events.length).toBeGreaterThan(0);
    const bad = await client.callTool({ name: "legal_get_document", arguments: { evidence_id: "EVID-999999" } });
    expect(bad.isError).toBe(true);
    await client.close();
  });
});

describe("optional LLM mode", () => {
  let mock: Server;
  let url: string;
  let reply: unknown;
  beforeAll(async () => {
    mock = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: { content: JSON.stringify(reply) } }));
      });
    });
    await new Promise<void>((r) => mock.listen(0, "127.0.0.1", () => r()));
    url = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => mock.close(() => r())));

  it("keeps verified claims and drops a fabricated one", async () => {
    const llmCfg: AppConfig = { ...cfg, llm: { ...cfg.llm, provider: "ollama", url } };
    const llmServices = new LegalServices(llmCfg);
    // The mock "model" cites passage 1 correctly once and invents a second claim.
    const probe = await llmServices.searchEvidence({ query: "When was the request registered?", top_k: 12 });
    const p1 = probe.results[0]!;
    const sentence = p1.text.split(/(?<=\.)\s+/).find((s) => /registered/.test(s)) ?? p1.text.slice(0, 80);
    reply = {
      answer: "It was registered.",
      claims: [
        { text: sentence, citations: [{ passage: 1, quote: sentence }] },
        { text: "The request was registered by the President of the General Court on 1 April 2026.", citations: [{ passage: 1, quote: "registered by the President of the General Court" }] },
      ],
    };
    const a = await llmServices.ask("When was the request registered?");
    expect(a.mode).toBe("llm");
    expect(a.llm?.prompt_version).toBe("legal-analysis-system.v1");
    expect(a.claims).toHaveLength(1);
    expect(a.rejected_claims).toHaveLength(1);
    expect(a.rejected_claims[0]!.status).toBe("UNSUPPORTED");
    expect(a.answer).not.toContain("President");
  });

  it("refuses to send document text to a non-local LLM unless explicitly allowed", async () => {
    const remote: AppConfig = { ...cfg, llm: { ...cfg.llm, provider: "ollama", url: "https://llm.example.com" } };
    const a = await new LegalServices(remote).ask("When was the request registered?");
    expect(a.mode).toBe("extractive");
    expect(a.notes.join(" ")).toMatch(/Refusing to send document text to non-local LLM/);
  });
});

describe("evaluation", () => {
  it("meets the POC targets on the gold set and leaves the originals unchanged", async () => {
    const report = await runEvaluation({ ...base, retrieval: { ...base.retrieval, semantic: { ...base.retrieval.semantic, provider } } }, {
      workspace: path.join(mkdtempSync(path.join(tmpdir(), "legal-eval-")), "ws"),
    });
    const m = report.metrics;
    expect(m.retrieval_top10_recall).toBeGreaterThanOrEqual(0.9);
    expect(m.retrieval_top5_recall).toBeGreaterThanOrEqual(0.8);
    expect(m.citation_support_accuracy).toBeGreaterThanOrEqual(0.95);
    expect(m.unsupported_claim_rate).toBeLessThanOrEqual(0.05);
    expect(m.refusal_accuracy).toBe("3/3");
    expect(m.originals_unchanged).toBe(true);
  }, 300_000);
});
