import { mkdirSync, renameSync, writeFileSync, appendFileSync, realpathSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * Write guard enforcing the immutable-originals rule.
 *
 * Every write performed by application code goes through this module. A write whose
 * destination resolves (after following symlinks) to a location inside the originals
 * directory is refused with an exception. Originals are only ever opened for reading.
 */
export class OriginalsWriteError extends Error {
  constructor(target: string) {
    super(`Refusing to write inside the read-only originals directory: ${target}`);
    this.name = "OriginalsWriteError";
  }
}

let protectedRoots: string[] = [];

/** Register a directory as read-only for the lifetime of the process. */
export function protectDirectory(dir: string): void {
  const resolved = resolveExisting(dir);
  if (!protectedRoots.includes(resolved)) protectedRoots.push(resolved);
}

/** For tests only. */
export function resetProtectedDirectories(): void {
  protectedRoots = [];
}

/** Resolve a path, following symlinks for the longest existing ancestor. */
function resolveExisting(p: string): string {
  let current = path.resolve(p);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  const real = existsSync(current) ? realpathSync(current) : current;
  return path.join(real, ...tail);
}

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

export function assertWritable(target: string): void {
  const resolved = resolveExisting(target);
  for (const root of protectedRoots) {
    if (isInside(resolved, root)) throw new OriginalsWriteError(target);
  }
}

export function ensureDir(dir: string): void {
  assertWritable(dir);
  mkdirSync(dir, { recursive: true });
}

/** Atomic write: write to a temporary sibling then rename. */
export function safeWriteFile(target: string, data: string | Uint8Array): void {
  assertWritable(target);
  mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data);
  renameSync(tmp, target);
}

/** Write a new file, failing if it already exists (used for extracted attachments). */
export function safeWriteNewFile(target: string, data: Uint8Array): void {
  assertWritable(target);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, data, { flag: "wx" });
}

export function safeAppendLine(target: string, line: string): void {
  assertWritable(target);
  mkdirSync(path.dirname(target), { recursive: true });
  appendFileSync(target, line.endsWith("\n") ? line : `${line}\n`);
}

export function writeJson(target: string, value: unknown): void {
  safeWriteFile(target, `${JSON.stringify(value, null, 2)}\n`);
}
