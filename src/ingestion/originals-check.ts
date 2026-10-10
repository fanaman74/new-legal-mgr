import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { AuditLog } from "../audit.js";
import { protectDirectory, writeJson } from "../util/fs-guard.js";
import { buildManifest, compareManifests, type Manifest, type ManifestDiff } from "./hashing.js";

/** Baseline manifest of the originals (name, size, mtime, SHA-256) and its verification. */

export function manifestPath(cfg: AppConfig, override?: string): string {
  return path.resolve(override ?? path.join(cfg.indexesDir, "originals-manifest.json"));
}

export function hasBaseline(cfg: AppConfig, override?: string): boolean {
  return existsSync(manifestPath(cfg, override));
}

export async function createBaseline(cfg: AppConfig, override?: string): Promise<Manifest> {
  protectDirectory(cfg.originalsDir);
  const manifest = await buildManifest(cfg.originalsDir);
  const file = manifestPath(cfg, override);
  writeJson(file, manifest);
  new AuditLog(cfg.auditLog).record({ action: "MANIFEST_CREATED", file_count: manifest.file_count, manifest: file });
  return manifest;
}

export interface VerifyResult {
  ok: boolean;
  baseline_created_at: string;
  diff: ManifestDiff;
}

export async function verifyOriginals(cfg: AppConfig, opts: { strict?: boolean; manifest?: string } = {}): Promise<VerifyResult> {
  const file = manifestPath(cfg, opts.manifest);
  if (!existsSync(file)) throw new Error(`No baseline manifest at ${file}. Create one first.`);
  const before = JSON.parse(readFileSync(file, "utf8")) as Manifest;
  const diff = compareManifests(before, await buildManifest(cfg.originalsDir));
  const ok = diff.ok && (!opts.strict || diff.added.length === 0);
  new AuditLog(cfg.auditLog).record({
    action: "MANIFEST_VERIFIED",
    status: ok ? "ok" : "changed",
    unchanged: diff.unchanged.length,
    missing: diff.missing.length,
    modified: diff.modified.length,
    added: diff.added.length,
  });
  return { ok, baseline_created_at: before.created_at, diff };
}
