import { existsSync, statfsSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { listFiles } from "../ingestion/hashing.js";
import { isInside, safeWriteFile } from "../util/fs-guard.js";

/**
 * Prerequisite checks, used by the launcher (before starting) and by the web page.
 * "fail" blocks start-up; "warn" means a feature is degraded (e.g. OCR unavailable).
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface PrereqCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** What the user should do, in plain language. */
  fix: string | null;
}

export interface PrereqReport {
  overall: CheckStatus;
  checks: PrereqCheck[];
}

export const MIN_NODE = [20, 12] as const;

const REQUIRED_MODULES = ["pdfjs-dist/legacy/build/pdf.mjs", "mammoth", "@kenjiuno/msgreader", "mailparser", "cfb", "zod", "yaml", "tesseract.js"];

function nodeVersionCheck(): PrereqCheck {
  const [major, minor] = process.versions.node.split(".").map(Number) as [number, number];
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    id: "node",
    label: "Node.js",
    status: ok ? "ok" : "fail",
    detail: `version ${process.versions.node} (minimum ${MIN_NODE.join(".")})`,
    fix: ok ? null : "Install the current Node.js LTS from https://nodejs.org/ and start the launcher again.",
  };
}

async function dependenciesCheck(): Promise<PrereqCheck> {
  const missing: string[] = [];
  for (const mod of REQUIRED_MODULES) {
    try {
      await import(mod);
    } catch {
      missing.push(mod.split("/").slice(0, mod.startsWith("@") ? 2 : 1).join("/"));
    }
  }
  return {
    id: "dependencies",
    label: "Application libraries",
    status: missing.length ? "fail" : "ok",
    detail: missing.length ? `missing or broken: ${missing.join(", ")}` : `${REQUIRED_MODULES.length} libraries loaded`,
    fix: missing.length ? "Start the launcher again (it reinstalls libraries), or run `npm ci` in the application folder." : null,
  };
}

async function canvasCheck(): Promise<PrereqCheck> {
  try {
    const { createCanvas } = await import("@napi-rs/canvas");
    createCanvas(2, 2).toBuffer("image/png");
    return { id: "canvas", label: "Page rendering (for OCR)", status: "ok", detail: "@napi-rs/canvas loaded", fix: null };
  } catch (err) {
    return {
      id: "canvas",
      label: "Page rendering (for OCR)",
      status: "warn",
      detail: `could not load: ${(err as Error).message.split("\n")[0]}`,
      fix: "Scanned PDFs cannot be OCR'd. Reinstall libraries with `npm ci`; on Windows also install the Microsoft Visual C++ Redistributable.",
    };
  }
}

function ocrDataCheck(cfg: AppConfig): PrereqCheck {
  if (!cfg.ocr.enabled) return { id: "ocr", label: "OCR language data", status: "warn", detail: "OCR is disabled in the configuration", fix: "Set OCR_ENABLED=true to OCR scanned PDFs." };
  const missing = cfg.ocr.langs
    .split("+")
    .filter((lang) => !existsSync(path.join(cfg.ocr.langPath, `${lang}.traineddata.gz`)) && !existsSync(path.join(cfg.ocr.langPath, `${lang}.traineddata`)));
  return {
    id: "ocr",
    label: "OCR language data",
    status: missing.length ? "warn" : "ok",
    detail: missing.length ? `missing for: ${missing.join(", ")} in ${cfg.ocr.langPath}` : `${cfg.ocr.langs} (offline)`,
    fix: missing.length ? "Scanned PDFs will fail to OCR. Check ocr.lang_path / OCR_LANG_PATH." : null,
  };
}

function layoutCheck(cfg: AppConfig): PrereqCheck {
  if (isInside(cfg.dataDir, cfg.originalsDir)) {
    return {
      id: "layout",
      label: "Folder layout",
      status: "fail",
      detail: "the data directory is inside the read-only originals directory",
      fix: "Point LEGAL_DATA_DIR and LEGAL_ORIGINALS_DIR to separate folders.",
    };
  }
  return { id: "layout", label: "Folder layout", status: "ok", detail: "originals and generated data are separate", fix: null };
}

function originalsCheck(cfg: AppConfig): PrereqCheck {
  if (!existsSync(cfg.originalsDir)) {
    return { id: "originals", label: "Evidence folder", status: "fail", detail: `not found: ${cfg.originalsDir}`, fix: "Create the folder or correct LEGAL_ORIGINALS_DIR." };
  }
  const count = listFiles(cfg.originalsDir).filter((f) => path.basename(f) !== ".gitkeep").length;
  return {
    id: "originals",
    label: "Evidence folder",
    status: count ? "ok" : "warn",
    detail: count ? `${count} file(s) in ${cfg.originalsDir}` : `empty: ${cfg.originalsDir}`,
    fix: count ? null : "Copy your evidence files (copies, not the master archive) into the evidence folder, then click Import evidence.",
  };
}

function dataWritableCheck(cfg: AppConfig): PrereqCheck {
  const probe = path.join(cfg.indexesDir, `.write-test-${process.pid}`);
  try {
    safeWriteFile(probe, "ok");
    unlinkSync(probe);
    return { id: "data", label: "Data folder writable", status: "ok", detail: cfg.dataDir, fix: null };
  } catch (err) {
    return { id: "data", label: "Data folder writable", status: "fail", detail: (err as Error).message, fix: "Make sure the application folder is not read-only and that you have write access." };
  }
}

function diskCheck(cfg: AppConfig): PrereqCheck {
  try {
    const target = existsSync(cfg.dataDir) ? cfg.dataDir : path.dirname(cfg.dataDir);
    const s = statfsSync(target);
    const freeMb = Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024 / 1024);
    return {
      id: "disk",
      label: "Free disk space",
      status: freeMb < 500 ? "warn" : "ok",
      detail: `${freeMb.toLocaleString("en-GB")} MB free`,
      fix: freeMb < 500 ? "Free some disk space: extracted text and attachments are stored next to the application." : null,
    };
  } catch {
    return { id: "disk", label: "Free disk space", status: "ok", detail: "not measurable on this system", fix: null };
  }
}

function privacyCheck(): PrereqCheck {
  const external = ["1", "true", "yes", "on"].includes((process.env.ALLOW_EXTERNAL_LLM ?? "").toLowerCase());
  return {
    id: "privacy",
    label: "Privacy mode",
    status: external ? "warn" : "ok",
    detail: external ? "ALLOW_EXTERNAL_LLM=true: document content may be sent to an external service" : "local only: no document content leaves this computer",
    fix: external ? "Set ALLOW_EXTERNAL_LLM=false in .env unless this is intended." : null,
  };
}

export async function checkPrerequisites(cfg: AppConfig): Promise<PrereqReport> {
  const checks: PrereqCheck[] = [
    nodeVersionCheck(),
    await dependenciesCheck(),
    await canvasCheck(),
    ocrDataCheck(cfg),
    layoutCheck(cfg),
    originalsCheck(cfg),
    dataWritableCheck(cfg),
    diskCheck(cfg),
    privacyCheck(),
  ];
  const overall: CheckStatus = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { overall, checks };
}

