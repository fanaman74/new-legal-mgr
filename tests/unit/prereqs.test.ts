import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkPrerequisites } from "../../src/app/prereqs.js";
import { loadConfig } from "../../src/config.js";
import { makeWorkspace } from "../helpers.js";
// @ts-expect-error plain JavaScript module without type declarations
import { installReason, nodeVersionOk } from "../../scripts/ensure-deps.mjs";

describe("prerequisite checks", () => {
  it("pass in a correctly installed workspace, warning about an empty evidence folder", async () => {
    const { cfg } = makeWorkspace();
    const report = await checkPrerequisites(cfg);
    const byId = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(byId).toMatchObject({ node: "ok", dependencies: "ok", canvas: "ok", ocr: "ok", layout: "ok", data: "ok", privacy: "ok", originals: "warn" });
    expect(report.overall).toBe("warn");
  });

  it("fail when the data directory is inside the originals directory", async () => {
    const { originals, root } = makeWorkspace();
    const cfg = loadConfig({ originalsDir: originals, dataDir: path.join(originals, "data"), auditLog: path.join(root, "audit.jsonl") });
    const report = await checkPrerequisites(cfg);
    expect(report.overall).toBe("fail");
    expect(report.checks.find((c) => c.id === "layout")?.status).toBe("fail");
  });

  it("fail when the evidence folder does not exist", async () => {
    const { root } = makeWorkspace();
    const cfg = loadConfig({ originalsDir: path.join(root, "nope"), dataDir: path.join(root, "data"), auditLog: path.join(root, "audit.jsonl") });
    expect((await checkPrerequisites(cfg)).checks.find((c) => c.id === "originals")?.status).toBe("fail");
  });
});

describe("launcher dependency check", () => {
  it("accepts supported Node.js versions only", () => {
    expect(nodeVersionOk("20.12.0")).toBe(true);
    expect(nodeVersionOk("24.1.0")).toBe(true);
    expect(nodeVersionOk("20.11.1")).toBe(false);
    expect(nodeVersionOk("18.20.0")).toBe(false);
  });

  it("installs when missing, reuses healthy installs and reinstalls after an update", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deps-"));
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { alpha: "1.0.0" }, devDependencies: { beta: "1.0.0" } }));
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3}');
    expect(installReason(root)).toBe("libraries not installed yet");
    mkdirSync(path.join(root, "node_modules", "alpha"), { recursive: true });
    expect(installReason(root)).toBe("some libraries are missing");
    mkdirSync(path.join(root, "node_modules", "beta"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", "alpha", "package.json"), "{}");
    writeFileSync(path.join(root, "node_modules", "beta", "package.json"), "{}");
    expect(installReason(root)).toBeNull(); // healthy install is reused (and stamped)
    expect(existsSync(path.join(root, "node_modules", ".legal-poc-install-stamp"))).toBe(true);
    writeFileSync(path.join(root, "package-lock.json"), '{"lockfileVersion":3,"changed":true}');
    expect(installReason(root)).toBe("the application was updated");
  });
});
