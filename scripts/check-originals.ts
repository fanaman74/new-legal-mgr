import { Command } from "commander";
import { loadConfig } from "../src/config.js";
import { createBaseline, hasBaseline, manifestPath, verifyOriginals } from "../src/ingestion/originals-check.js";

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

if (mode === "create") {
  const manifest = await createBaseline(cfg, opts.manifest);
  console.log(`Manifest of ${manifest.file_count} file(s) written to ${manifestPath(cfg, opts.manifest)}`);
} else if (mode === "verify") {
  if (!hasBaseline(cfg, opts.manifest)) {
    console.error(`No manifest at ${manifestPath(cfg, opts.manifest)}. Run: npm run check-originals -- create`);
    process.exit(1);
  }
  const { ok, diff } = await verifyOriginals(cfg, { strict: opts.strict, manifest: opts.manifest });
  console.log(`Unchanged: ${diff.unchanged.length}`);
  for (const m of diff.modified) console.log(`MODIFIED  ${m.relative_path} (${m.changes.join(", ")})`);
  for (const m of diff.missing) console.log(`MISSING   ${m}`);
  for (const a of diff.added) console.log(`ADDED     ${a}`);
  console.log(ok ? "\nOK: original evidence is unchanged." : "\nFAILED: original evidence differs from the manifest.");
  process.exitCode = ok ? 0 : 1;
} else {
  program.help({ error: true });
}
