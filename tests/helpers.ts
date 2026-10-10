import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";

export interface Workspace {
  root: string;
  originals: string;
  cfg: AppConfig;
}

/** An isolated originals + data + audit layout under the OS temp directory. */
export function makeWorkspace(opts: { ocr?: boolean } = {}): Workspace {
  const root = mkdtempSync(path.join(tmpdir(), "legal-evidence-test-"));
  const originals = path.join(root, "originals");
  mkdirSync(originals, { recursive: true });
  const cfg = loadConfig({
    originalsDir: originals,
    dataDir: path.join(root, "data"),
    auditLog: path.join(root, "logs", "audit.jsonl"),
    ocrEnabled: opts.ocr ?? true,
  });
  return { root, originals, cfg };
}
