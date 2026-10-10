import { createReadStream, existsSync, readFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { AppConfig } from "../config.js";
import { AuditLog } from "../audit.js";
import { EvidenceRegistry } from "../evidence/ids.js";
import { EvidenceRepository } from "../evidence/repository.js";
import { CorrectionStore, applyCorrections } from "../evidence/corrections.js";
import { EVIDENCE_ID_PATTERN } from "../evidence/models.js";
import { ingest, type IngestSummary } from "../ingestion/dispatcher.js";
import { buildManifest, compareManifests } from "../ingestion/hashing.js";
import { createBaseline, hasBaseline, verifyOriginals } from "../ingestion/originals-check.js";
import { checkPrerequisites } from "./prereqs.js";

/**
 * Local web app (Milestone 1 scope: corpus, ingestion, originals verification).
 *
 * Security model for a single-user, local POC:
 * - binds to 127.0.0.1 only; requests with a foreign Host header are rejected (DNS rebinding);
 * - state-changing requests need the custom header "X-Legal-POC: 1", which other websites
 *   cannot send cross-origin (no CORS is offered);
 * - originals are streamed read-only, with a sandbox CSP;
 * - nothing here writes inside the originals directory.
 */

export const APP_ID = "legal-evidence-poc";
const PUBLIC_DIR = path.join(import.meta.dirname, "public");
const INLINE_TYPES = new Set(["application/pdf", "text/plain", "text/markdown", "image/png", "image/jpeg", "image/gif"]);

export interface IngestJob {
  id: number;
  status: "running" | "done" | "failed";
  force: boolean;
  started_at: string;
  finished_at: string | null;
  log: string[];
  summary: Omit<IngestSummary, "records"> | null;
  /** Proof for this run: the originals manifest before and after ingestion. */
  originals_check: { ok: boolean; files: number; changes: string[] } | null;
  error: string | null;
}

export interface AppServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new HttpError(413, "request body too large");
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function openInFileManager(dir: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["explorer.exe", [dir]] : process.platform === "darwin" ? ["open", [dir]] : ["xdg-open", [dir]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.on("error", () => undefined);
  child.unref();
}

export async function startServer(cfg: AppConfig, opts: { port: number; host?: string }): Promise<AppServer> {
  const host = opts.host ?? "127.0.0.1";
  const repo = new EvidenceRepository(cfg);
  const audit = new AuditLog(cfg.auditLog);
  const indexHtml = readFileSync(path.join(PUBLIC_DIR, "index.html"));
  let job: IngestJob | null = null;
  let jobCounter = 0;
  let port = opts.port;

  const allowedHosts = () => new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  const effectiveRecords = () => {
    const corrections = new CorrectionStore(cfg).all();
    return repo.listCanonical().map((r) => applyCorrections(r, corrections));
  };

  const runIngest = (force: boolean): IngestJob => {
    const current: IngestJob = {
      id: ++jobCounter,
      status: "running",
      force,
      started_at: new Date().toISOString(),
      finished_at: null,
      log: [],
      summary: null,
      originals_check: null,
      error: null,
    };
    job = current;
    void (async () => {
      try {
        if (!hasBaseline(cfg)) {
          await createBaseline(cfg);
          current.log.push("Created the originals baseline manifest (first import).");
        }
        const before = await buildManifest(cfg.originalsDir);
        const summary = await ingest({ ...cfg, ingestion: { ...cfg.ingestion, forceReparse: force } }, { log: (line) => current.log.push(line) });
        const diff = compareManifests(before, await buildManifest(cfg.originalsDir));
        current.originals_check = {
          ok: diff.ok,
          files: before.file_count,
          changes: [...diff.modified.map((m) => `modified: ${m.relative_path}`), ...diff.missing.map((m) => `missing: ${m}`)],
        };
        const { records: _records, ...rest } = summary;
        current.summary = rest;
        current.status = "done";
      } catch (err) {
        current.status = "failed";
        current.error = (err as Error).message;
      } finally {
        current.finished_at = new Date().toISOString();
      }
    })();
    return current;
  };

  const routes = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const method = req.method ?? "GET";
    const p = url.pathname;

    if (method === "GET" && (p === "/" || p === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(indexHtml);
      return;
    }
    if (method === "GET" && p === "/favicon.ico") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method === "GET" && p === "/api/health") {
      sendJson(res, 200, {
        app: APP_ID,
        originals_dir: cfg.originalsDir,
        data_dir: cfg.dataDir,
        baseline: hasBaseline(cfg),
        prerequisites: await checkPrerequisites(cfg),
      });
      return;
    }
    if (method === "GET" && p === "/api/corpus") {
      const records = effectiveRecords().map((r) => ({
        evidence_id: r.evidence_id,
        filename: r.source.original_filename,
        relative_path: `${r.source.source_root}/${r.source.relative_path}`,
        document_type: r.document.document_type,
        date: r.document.date,
        date_confidence: r.document.date_confidence,
        matter: r.document.matter,
        title: r.document.title,
        page_count: r.provenance.page_count,
        chunk_count: r.content.chunk_count,
        status: r.provenance.status,
        ocr_pages: r.provenance.ocr_pages.length,
        warnings: r.provenance.warnings.length,
        attachment_of: r.attachment_of,
        attachments: r.attachments.length,
        duplicates: r.source.alias_paths.length,
        corrected: r.corrections_applied.length,
      }));
      sendJson(res, 200, { records });
      return;
    }
    const evidenceMatch = /^\/api\/evidence\/(EVID-\d{6})(\/original)?$/.exec(p);
    if (method === "GET" && evidenceMatch) {
      const id = evidenceMatch[1]!;
      if (!EVIDENCE_ID_PATTERN.test(id)) throw new HttpError(400, "invalid Evidence ID");
      const record = repo.loadCanonical(id);
      if (!record) throw new HttpError(404, `unknown Evidence ID ${id}`);
      if (!evidenceMatch[2]) {
        sendJson(res, 200, {
          record: applyCorrections(record, new CorrectionStore(cfg).forEvidence(id)),
          relationships: repo.loadRelationships().filter((r) => r.subject === id || r.object === id),
          chunks: repo.loadChunks(id),
        });
        return;
      }
      // Stream the source file, read-only. Only registry paths are served (no user-supplied paths).
      const entry = EvidenceRegistry.load(cfg.indexesDir).get(id);
      const file = entry?.paths
        .map((ref) => path.join(ref.source_root === "originals" ? cfg.originalsDir : cfg.attachmentsDir, ref.relative_path))
        .find((f) => existsSync(f));
      if (!file) throw new HttpError(404, "the source file is no longer available at any registered path");
      const mime = record.source.mime_type;
      const inline = INLINE_TYPES.has(mime);
      audit.record({ action: "ORIGINAL_OPENED", evidence_id: id, sha256: record.source.sha256 });
      res.writeHead(200, {
        "Content-Type": mime.startsWith("text/") ? `${mime}; charset=utf-8` : mime,
        "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(record.source.original_filename)}`,
        // Browsers refuse to render PDFs in a sandboxed document; their PDF viewer is isolated anyway.
        ...(mime === "application/pdf" ? {} : { "Content-Security-Policy": "sandbox" }),
      });
      createReadStream(file, { flags: "r" }).pipe(res);
      return;
    }
    if (method === "GET" && p === "/api/job") {
      sendJson(res, 200, { job });
      return;
    }

    if (method === "POST") {
      if (req.headers["x-legal-poc"] !== "1") throw new HttpError(403, "missing X-Legal-POC header");
      const body = await readBody(req);
      if (p === "/api/ingest") {
        if (job?.status === "running") throw new HttpError(409, "an import is already running");
        sendJson(res, 202, { job: runIngest(body.force === true) });
        return;
      }
      if (p === "/api/originals/verify") {
        if (!hasBaseline(cfg)) {
          const m = await createBaseline(cfg);
          sendJson(res, 200, { mode: "created", file_count: m.file_count, created_at: m.created_at });
          return;
        }
        sendJson(res, 200, { mode: "verified", ...(await verifyOriginals(cfg)) });
        return;
      }
      if (p === "/api/originals/baseline") {
        if (hasBaseline(cfg)) {
          const v = await verifyOriginals(cfg);
          if (!v.diff.ok) throw new HttpError(409, "files were modified or are missing since the baseline; investigate before replacing it");
        }
        const m = await createBaseline(cfg);
        sendJson(res, 200, { mode: "created", file_count: m.file_count, created_at: m.created_at });
        return;
      }
      if (p === "/api/open-folder") {
        mkdirSync(cfg.originalsDir, { recursive: true });
        openInFileManager(cfg.originalsDir);
        sendJson(res, 200, { opened: cfg.originalsDir });
        return;
      }
    }
    throw new HttpError(404, "not found");
  };

  const server = createServer((req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'");
    if (!allowedHosts().has(req.headers.host ?? "")) {
      sendJson(res, 421, { error: "unexpected Host header" });
      return;
    }
    const origin = req.headers.origin;
    if (origin && !allowedHosts().has(origin.replace(/^https?:\/\//, ""))) {
      sendJson(res, 403, { error: "cross-origin requests are not allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    routes(req, res, url).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
