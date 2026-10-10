import { createHash } from "node:crypto";
import { createReadStream, readdirSync, statSync, lstatSync } from "node:fs";
import path from "node:path";

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  // Opened read-only ("r"): originals are never opened in a writable mode.
  for await (const chunk of createReadStream(file, { flags: "r" })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Convert an OS path to a stable, forward-slash relative path. */
export function toPosixRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

/** Glob-lite matcher for ignore patterns: supports "*" wildcards on the basename. */
export function matchesIgnore(basename: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "i");
    return re.test(basename);
  });
}

/** List regular files under a directory, sorted for reproducible ID allocation. Symlinks are not followed. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) walk(root);
  return out;
}

export interface ManifestEntry {
  relative_path: string;
  size_bytes: number;
  mtime_ms: number;
  sha256: string;
}

export interface Manifest {
  manifest_version: 1;
  created_at: string;
  root: string;
  file_count: number;
  files: ManifestEntry[];
}

export async function buildManifest(root: string): Promise<Manifest> {
  const files: ManifestEntry[] = [];
  for (const file of listFiles(root)) {
    const st = statSync(file);
    files.push({
      relative_path: toPosixRelative(root, file),
      size_bytes: st.size,
      mtime_ms: st.mtimeMs,
      sha256: await sha256File(file),
    });
  }
  return { manifest_version: 1, created_at: new Date().toISOString(), root, file_count: files.length, files };
}

export interface ManifestDiff {
  ok: boolean;
  unchanged: string[];
  /** Files present in the manifest but missing now (renamed, moved or deleted). */
  missing: string[];
  /** New files that were not in the manifest. Not a modification, reported for information. */
  added: string[];
  /** Files whose content, size or modification time changed. */
  modified: { relative_path: string; changes: string[] }[];
}

export function compareManifests(before: Manifest, after: Manifest): ManifestDiff {
  const prev = new Map(before.files.map((f) => [f.relative_path, f]));
  const curr = new Map(after.files.map((f) => [f.relative_path, f]));
  const diff: ManifestDiff = { ok: true, unchanged: [], missing: [], added: [], modified: [] };
  for (const [rel, old] of prev) {
    const now = curr.get(rel);
    if (!now) {
      diff.missing.push(rel);
      continue;
    }
    const changes: string[] = [];
    if (now.sha256 !== old.sha256) changes.push("sha256");
    if (now.size_bytes !== old.size_bytes) changes.push("size");
    if (now.mtime_ms !== old.mtime_ms) changes.push("mtime");
    if (changes.length) diff.modified.push({ relative_path: rel, changes });
    else diff.unchanged.push(rel);
  }
  for (const rel of curr.keys()) if (!prev.has(rel)) diff.added.push(rel);
  diff.ok = diff.missing.length === 0 && diff.modified.length === 0;
  return diff;
}
