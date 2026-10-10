import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildManifest, compareManifests, matchesIgnore, sha256Bytes, sha256File } from "../../src/ingestion/hashing.js";

describe("hashing", () => {
  it("computes SHA-256 of bytes and files identically", async () => {
    const abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe(abc);
    const dir = mkdtempSync(path.join(tmpdir(), "hash-"));
    writeFileSync(path.join(dir, "a.txt"), "abc");
    expect(await sha256File(path.join(dir, "a.txt"))).toBe(abc);
  });

  it("matches ignore patterns on basenames", () => {
    expect(matchesIgnore(".DS_Store", [".DS_Store"])).toBe(true);
    expect(matchesIgnore("~$draft.docx", ["~$*"])).toBe(true);
    expect(matchesIgnore("decision.pdf", ["~$*", ".DS_Store"])).toBe(false);
  });

  it("manifest comparison detects modified, missing and added files", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
    writeFileSync(path.join(dir, "keep.txt"), "same");
    writeFileSync(path.join(dir, "edit.txt"), "before");
    writeFileSync(path.join(dir, "gone.txt"), "x");
    const before = await buildManifest(dir);
    expect(compareManifests(before, await buildManifest(dir)).ok).toBe(true);

    writeFileSync(path.join(dir, "edit.txt"), "after, and longer");
    rmSync(path.join(dir, "gone.txt"));
    writeFileSync(path.join(dir, "new.txt"), "n");
    const diff = compareManifests(before, await buildManifest(dir));
    expect(diff.ok).toBe(false);
    expect(diff.unchanged).toEqual(["keep.txt"]);
    expect(diff.modified).toHaveLength(1);
    expect(diff.modified[0]!.relative_path).toBe("edit.txt");
    expect(diff.modified[0]!.changes).toEqual(expect.arrayContaining(["sha256", "size"]));
    expect(diff.missing).toEqual(["gone.txt"]);
    expect(diff.added).toEqual(["new.txt"]);
  });

  it("manifest comparison detects a touched (mtime-only) file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-"));
    writeFileSync(path.join(dir, "a.txt"), "x");
    const before = await buildManifest(dir);
    utimesSync(path.join(dir, "a.txt"), new Date("2020-01-01"), new Date("2020-01-01"));
    const diff = compareManifests(before, await buildManifest(dir));
    expect(diff.modified).toEqual([{ relative_path: "a.txt", changes: ["mtime"] }]);
  });
});
