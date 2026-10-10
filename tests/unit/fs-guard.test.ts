import { mkdtempSync, mkdirSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { OriginalsWriteError, protectDirectory, resetProtectedDirectories, safeAppendLine, safeWriteFile, safeWriteNewFile } from "../../src/util/fs-guard.js";

describe("originals write guard", () => {
  afterEach(() => resetProtectedDirectories());

  it("refuses any write inside the protected originals directory", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guard-"));
    const originals = path.join(root, "originals");
    mkdirSync(originals);
    protectDirectory(originals);
    expect(() => safeWriteFile(path.join(originals, "x.pdf"), "x")).toThrow(OriginalsWriteError);
    expect(() => safeWriteNewFile(path.join(originals, "sub", "y.pdf"), new Uint8Array([1]))).toThrow(OriginalsWriteError);
    expect(() => safeAppendLine(path.join(originals, "log.jsonl"), "{}")).toThrow(OriginalsWriteError);
    expect(() => safeWriteFile(path.join(root, "data", "..", "originals", "z.pdf"), "x")).toThrow(OriginalsWriteError);
    expect(existsSync(path.join(originals, "x.pdf"))).toBe(false);
  });

  // Creating symlinks on Windows needs extra privileges.
  it.skipIf(process.platform === "win32")("refuses writes that reach the originals through a symlink", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guard-"));
    const originals = path.join(root, "originals");
    mkdirSync(originals);
    symlinkSync(originals, path.join(root, "link"));
    protectDirectory(originals);
    expect(() => safeWriteFile(path.join(root, "link", "x.pdf"), "x")).toThrow(OriginalsWriteError);
  });

  it("allows writes elsewhere, including sibling directories with similar names", () => {
    const root = mkdtempSync(path.join(tmpdir(), "guard-"));
    mkdirSync(path.join(root, "originals"));
    protectDirectory(path.join(root, "originals"));
    safeWriteFile(path.join(root, "originals-extracted", "a.md"), "ok");
    expect(existsSync(path.join(root, "originals-extracted", "a.md"))).toBe(true);
  });
});
