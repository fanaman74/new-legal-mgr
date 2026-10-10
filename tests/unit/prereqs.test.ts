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

  it("reuses the installed libraries of this repository", () => {
    expect(installReason()).toBeNull();
  });
});
