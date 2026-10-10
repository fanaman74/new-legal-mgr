import { writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AppServer } from "../../src/app/server.js";
import { buildManifest, compareManifests, listFiles } from "../../src/ingestion/hashing.js";
import { makeEml, makePdf } from "../../src/testing/sample-corpus.js";
import { resetProtectedDirectories } from "../../src/util/fs-guard.js";
import { makeWorkspace, type Workspace } from "../helpers.js";

let ws: Workspace;
let app: AppServer;
const POST = { method: "POST", headers: { "X-Legal-POC": "1", "Content-Type": "application/json" }, body: "{}" };

interface Job {
  status: string;
  summary: Record<string, number>;
  originals_check: { ok: boolean; files: number };
}

async function waitForJob(): Promise<Job> {
  for (let i = 0; i < 300; i++) {
    const { job } = (await (await fetch(`${app.url}api/job`)).json()) as { job: Job | null };
    if (job && job.status !== "running") return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("import did not finish");
}

/** Raw request with a custom Host header (fetch does not allow overriding it). */
function rawGet(pathname: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: app.port, path: pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  resetProtectedDirectories();
  ws = makeWorkspace();
  mkdirSync(path.join(ws.originals, "article24"));
  writeFileSync(path.join(ws.originals, "article24", "decision.pdf"), await makePdf([{ h: "DECISION" }, { p: "Brussels, 12 May 2025" }, "pagebreak", { p: "The request is rejected." }]));
  writeFileSync(path.join(ws.originals, "reply.eml"), makeEml({ from: "a@example.org", to: "b@example.org", subject: "Reply", date: "Mon, 10 Feb 2025 09:12:00 +0100", messageId: "<r@example.org>", body: "Hello", attachments: [{ filename: "note.txt", contentType: "text/plain", data: new TextEncoder().encode("A note") }] }));
  for (const f of listFiles(ws.originals)) chmodSync(f, 0o444);
  app = await startServer(ws.cfg, { port: 0 });
});
afterAll(() => app?.close());

describe("local web app", () => {
  it("serves the interface and a health report with prerequisites", async () => {
    const page = await fetch(app.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Legal Evidence Manager");
    const health = (await (await fetch(`${app.url}api/health`)).json()) as { app: string; baseline: boolean; prerequisites: { overall: string; checks: { id: string; status: string }[] } };
    expect(health.app).toBe("legal-evidence-poc");
    expect(health.baseline).toBe(false);
    expect(health.prerequisites.overall).not.toBe("fail");
    expect(health.prerequisites.checks.find((c) => c.id === "originals")?.status).toBe("ok");
  });

  it("imports evidence from a button, proves originals unchanged, and lists the corpus", async () => {
    const before = await buildManifest(ws.originals);
    const start = await fetch(`${app.url}api/ingest`, POST);
    expect(start.status).toBe(202);
    const job = await waitForJob();
    expect(job.status).toBe("done");
    expect(job.summary.new_evidence).toBe(3); // pdf, eml, eml attachment
    expect(job.originals_check).toMatchObject({ ok: true, files: 2 });
    expect(compareManifests(before, await buildManifest(ws.originals)).ok).toBe(true);

    const { records } = (await (await fetch(`${app.url}api/corpus`)).json()) as { records: { evidence_id: string; filename: string; matter: string[]; page_count: number | null }[] };
    expect(records.map((r) => r.filename).sort()).toEqual(["decision.pdf", "note.txt", "reply.eml"]);
    expect(records.find((r) => r.filename === "decision.pdf")).toMatchObject({ matter: ["article24"], page_count: 2 });
  });

  it("returns a record with provenance and streams the original read-only", async () => {
    const detail = (await (await fetch(`${app.url}api/evidence/EVID-000001`)).json()) as { record: { source: { sha256: string } }; chunks: { page: number }[] };
    expect(detail.chunks.map((c) => c.page)).toEqual([1, 2]);
    const original = await fetch(`${app.url}api/evidence/EVID-000001/original`);
    expect(original.headers.get("content-type")).toBe("application/pdf");
    const bytes = new Uint8Array(await original.arrayBuffer());
    const { sha256Bytes } = await import("../../src/ingestion/hashing.js");
    expect(sha256Bytes(bytes)).toBe(detail.record.source.sha256);
    const text = await fetch(`${app.url}api/evidence/EVID-000003/original`);
    expect(text.headers.get("content-security-policy")).toBe("sandbox");
    expect((await fetch(`${app.url}api/evidence/EVID-999999`)).status).toBe(404);
    expect((await fetch(`${app.url}api/evidence/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it("creates a baseline, then verifies originals unchanged", async () => {
    const first = (await (await fetch(`${app.url}api/originals/verify`, POST)).json()) as { mode: string };
    expect(first.mode).toBe("verified"); // the first import already created the baseline
    expect(first).toMatchObject({ ok: true });
  });

  it("rejects state-changing requests without the app header, and foreign hosts", async () => {
    expect((await fetch(`${app.url}api/ingest`, { method: "POST", body: "{}" })).status).toBe(403);
    expect((await fetch(`${app.url}api/ingest`, { ...POST, headers: { ...POST.headers, Origin: "https://evil.example" } })).status).toBe(403);
    expect(await rawGet("/api/corpus", `evil.example:${app.port}`)).toBe(421);
    expect(await rawGet("/api/corpus", `localhost:${app.port}`)).toBe(200);
  });

  it("never wrote inside the originals directory", () => {
    expect(listFiles(ws.originals).map((f) => path.relative(ws.originals, f)).sort()).toEqual([path.join("article24", "decision.pdf"), "reply.eml"]);
  });
});
