import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { LegalServices } from "../services.js";

/**
 * MCP server exposing the evidence layer to Hermes (or any MCP client).
 *
 * All tools are READ-ONLY: there is no tool that writes, renames or deletes evidence, and the
 * originals directory is never written. Results are JSON with full provenance (Evidence ID,
 * file, page or section, chunk ID) so that the client can cite and verify them.
 */

const evid = z.string().regex(/^EVID-\d{6}$/).describe("Evidence ID, e.g. EVID-000043");
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function notFound(what: string) {
  return { content: [{ type: "text" as const, text: `${what} not found` }], isError: true };
}

export function createMcpServer(services: LegalServices): McpServer {
  const server = new McpServer(
    { name: "legal-evidence", version: "0.1.0" },
    {
      instructions:
        "Read-only access to a legal evidence corpus. Every factual statement you make must cite an Evidence ID and a page (or section/chunk) returned by these tools, and should be checked with legal_verify_citation. If the tools return no sufficient evidence, say 'Insufficient evidence found in the indexed corpus.' Do not treat differences in wording as contradictions without checking the sources.",
    },
  );

  server.registerTool(
    "legal_search",
    {
      title: "Search evidence",
      description: "Hybrid lexical + semantic search over the evidence. Exact names, dates, references (e.g. ART24-2025-0012) and quoted phrases are matched lexically; paraphrases semantically. Returns passages with Evidence ID, filename, page/section, chunk ID and score.",
      inputSchema: {
        query: z.string().min(1),
        matter: z.array(z.string()).optional(),
        document_type: z.array(z.string()).optional(),
        date_from: isoDate.optional(),
        date_to: isoDate.optional(),
        author: z.array(z.string()).optional(),
        top_k: z.number().int().min(1).max(50).optional(),
      },
      annotations: readOnly,
    },
    async (a) => {
      const res = await services.searchEvidence({ ...a, top_k: a.top_k ?? 10 });
      return json({ ...res, results: res.results.map(({ lexical_score: _l, semantic_similarity: _s, lexical_rank: _lr, semantic_rank: _sr, ...r }) => r) });
    },
  );

  server.registerTool(
    "legal_get_document",
    {
      title: "Get document metadata",
      description: "Metadata and provenance of one evidence item (source, hash, dates, type, matter, email fields, attachments, relationships) and the list of its chunks.",
      inputSchema: { evidence_id: evid },
      annotations: readOnly,
    },
    async ({ evidence_id }) => {
      const doc = services.getDocument(evidence_id);
      return doc ? json(doc) : notFound(evidence_id);
    },
  );

  server.registerTool(
    "legal_get_passage",
    {
      title: "Get cited passage",
      description: "Exact source text for a citation: a chunk (chunk_id), all text on a PDF page (page), or the whole document. Use it to quote evidence verbatim.",
      inputSchema: { evidence_id: evid, page: z.number().int().positive().optional(), chunk_id: z.string().optional() },
      annotations: readOnly,
    },
    async ({ evidence_id, page, chunk_id }) => {
      const p = services.getPassage(evidence_id, { page, chunk_id });
      if (!p) return notFound(evidence_id);
      if (!p.passages.length) return notFound(`${evidence_id} ${chunk_id ?? `page ${page}`}`);
      return json(p);
    },
  );

  server.registerTool(
    "legal_ask",
    {
      title: "Grounded answer",
      description: "Answer a question from the evidence only. Returns the answer with verified citations, or 'Insufficient evidence found in the indexed corpus.'",
      inputSchema: { question: z.string().min(1), matter: z.array(z.string()).optional() },
      annotations: readOnly,
    },
    async ({ question, matter }) => json(await services.ask(question, { matter })),
  );

  server.registerTool(
    "legal_build_chronology",
    {
      title: "Build chronology",
      description: "Chronologically ordered events with citations, date type (explicit / email_sent / document_date), inferred flag and confidence. Scoped to a matter inferred from the query when possible.",
      inputSchema: { query: z.string().min(1), date_from: isoDate.optional(), date_to: isoDate.optional(), matter: z.array(z.string()).optional() },
      annotations: readOnly,
    },
    async (a) => json(await services.chronology(a)),
  );

  server.registerTool(
    "legal_compare_positions",
    {
      title: "Compare positions",
      description: "Propositions on an issue from several documents, in chronological order, with machine-suggested relations (consistent, changed_wording, possible_tension, potential_contradiction). Suggestions only; requires human review.",
      inputSchema: { issue: z.string().min(1), evidence_ids: z.array(evid).optional(), matter: z.array(z.string()).optional() },
      annotations: readOnly,
    },
    async (a) => json(await services.compare(a)),
  );

  server.registerTool(
    "legal_find_unaddressed_evidence",
    {
      title: "Find potentially unaddressed evidence",
      description: "Items raised in submissions (annexes, attachments) checked against a decision: addressed / partially_addressed / referenced_only / uncertain / no_treatment_found, with confidence and explanation. Probabilistic: absence of a match is not proof of absence.",
      inputSchema: {
        source_evidence_ids: z.array(evid).optional(),
        target_evidence_ids: z.array(evid).optional(),
        query: z.string().optional(),
        matter: z.array(z.string()).optional(),
      },
      annotations: readOnly,
    },
    async (a) => json(await services.unaddressed(a)),
  );

  server.registerTool(
    "legal_verify_citation",
    {
      title: "Verify citation",
      description: "Check a claim against its cited source: VERIFIED, PARTIALLY_SUPPORTED, UNSUPPORTED or SOURCE_ERROR, with the supporting passage and reasons. Provide quoted_text to also check a verbatim quote.",
      inputSchema: {
        claim: z.string().min(1),
        evidence_id: evid,
        page: z.number().int().positive().nullable().optional(),
        chunk_id: z.string().optional(),
        quoted_text: z.string().nullable().optional(),
      },
      annotations: readOnly,
    },
    async (a) => json(await services.verify(a)),
  );

  return server;
}
