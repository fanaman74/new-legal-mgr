import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { AuditLog } from "../src/audit.js";
import { buildManifest, compareManifests, type Manifest } from "../src/ingestion/hashing.js";
import { protectDirectory, writeJson } from "../src/util/fs-guard.js";

const program = new Command()
  .name("check-originals")
  .description("Create or verify a manifest (path, size, mtime, SHA-256) of the original evidence.")
  .argument("<mode>", "create | verify")
  .option("--originals <dir>", "originals directory")
  .option("--data <dir>", "data directory")
  .option("--manifest <file>", "manifest file (default: <data>/indexes/originals-manifest.json)")
  .option("--strict", "also fail when new files have been added")
  .parse();

const [mode] = program.args;
const opts = program.opts<{ originals?: string; data?: string; manifest?: string; strict?: boolean }>();
const cfg = loadConfig({ originalsDir: opts.originals, dataDir: opts.data });
protectDirectory(cfg.originalsDir);
const manifestFile = path.resolve(opts.manifest ?? path.join(cfg.indexesDir, "originals-manifest.json"));
const audit = new AuditLog(cfg.auditLog);

if (mode === "create") {
  const manifest = await buildManifest(cfg.originalsDir);
  writeJson(manifestFile, manifest);
  audit.record({ action: "MANIFEST_CREATED", file_count: manifest.file_count, manifest: manifestFile });
  console.log(`Manifest of ${manifest.file_count} file(s) written to ${manifestFile}`);
} else if (mode === "verify") {
  if (!existsSync(manifestFile)) {
    console.error(`No manifest at ${manifestFile}. Run: npm run check-originals -- create`);
    process.exit(1);
  }
  const before = JSON.parse(readFileSync(manifestFile, "utf8")) as Manifest;
  const diff = compareManifests(before, await buildManifest(cfg.originalsDir));
  const ok = diff.ok && (!opts.strict || diff.added.length === 0);
  audit.record({
    action: "MANIFEST_VERIFIED",
    status: ok ? "ok" : "changed",
    unchanged: diff.unchanged.length,
    missing: diff.missing.length,
    modified: diff.modified.length,
    added: diff.added.length,
  });
  console.log(`Unchanged: ${diff.unchanged.length}`);
  for (const m of diff.modified) console.log(`MODIFIED  ${m.relative_path} (${m.changes.join(", ")})`);
  for (const m of diff.missing) console.log(`MISSING   ${m}`);
  for (const a of diff.added) console.log(`ADDED     ${a}`);
  console.log(ok ? "\nOK: original evidence is unchanged." : "\nFAILED: original evidence differs from the manifest.");
  process.exitCode = ok ? 0 : 1;
} else {
  program.help({ error: true });
}
