import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { Command } from "commander";
import { loadConfig, REPO_ROOT } from "../src/config.js";
import { checkPrerequisites } from "../src/app/prereqs.js";
import { APP_ID, startServer, type AppServer } from "../src/app/server.js";

/**
 * Start the local web app: check prerequisites, start the server on localhost, open the browser.
 * Used by the double-click launchers (Start Legal Evidence Manager.bat / .command / start.sh).
 */

const program = new Command()
  .name("launch")
  .description("Check prerequisites, start the local app and open it in the browser.")
  .option("--port <port>", "port to listen on (default: API_PORT or 8787)")
  .option("--no-browser", "do not open the browser")
  .option("--sample", "use the fictional sample corpus (data/sample-originals, data/sample-data)")
  .parse();
const opts = program.opts<{ port?: string; browser: boolean; sample?: boolean }>();

const sampleOriginals = path.join(REPO_ROOT, "data", "sample-originals");
const cfg = loadConfig(opts.sample ? { originalsDir: sampleOriginals, dataDir: path.join(REPO_ROOT, "data", "sample-data") } : {});

const symbol = { ok: "OK  ", warn: "WARN", fail: "FAIL" } as const;

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32" ? ["cmd.exe", ["/c", "start", '""', url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsVerbatimArguments: process.platform === "win32" });
  child.on("error", () => console.log(`Open ${url} in your browser.`));
  child.unref();
}

async function alreadyRunning(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { app?: string; originals_dir?: string };
    return body.app === APP_ID && body.originals_dir === cfg.originalsDir;
  } catch {
    return false;
  }
}

console.log("[3/4] Checking the local search model...");
if (["auto", "transformers"].includes(cfg.retrieval.semantic.provider)) {
  const { ensureModel, readModelManifest } = await import("../src/retrieval/models.js");
  if (readModelManifest(cfg.retrieval.semantic.modelsDir, cfg.retrieval.semantic.model)) {
    console.log("      Search model is installed.");
  } else {
    console.log(`      Downloading the search model ${cfg.retrieval.semantic.model} (one time, about 25-90 MB)...`);
    try {
      const m = await ensureModel(cfg.retrieval.semantic.modelsDir, cfg.retrieval.semantic.model, (s) => console.log(`      ${s.trim()}`));
      console.log(`      Installed from ${m.source}.`);
    } catch (err) {
      console.log(`      Could not download it (${(err as Error).message}).`);
      console.log("      The app will use its built-in, simpler semantic search and retry next time.");
    }
  }
} else {
  console.log(`      Not needed (semantic provider: ${cfg.retrieval.semantic.provider}).`);
}
console.log("\n[4/4] Checking prerequisites...\n");
if (opts.sample && !existsSync(sampleOriginals)) {
  const { generateSampleCorpus } = await import("../src/testing/sample-corpus.js");
  const files = await generateSampleCorpus(sampleOriginals);
  console.log(`Generated the fictional sample corpus (${files.length} files) in ${sampleOriginals}\n`);
}
// The evidence folder itself may be created (empty); nothing is ever written inside it.
mkdirSync(cfg.originalsDir, { recursive: true });

const report = await checkPrerequisites(cfg);
for (const c of report.checks) {
  console.log(`  ${symbol[c.status]}  ${c.label.padEnd(26)} ${c.detail}`);
  if (c.fix && c.status !== "ok") console.log(`        -> ${c.fix}`);
}
console.log("");
if (report.overall === "fail") {
  console.error("Cannot start: fix the problems marked FAIL above, then start the launcher again.");
  process.exit(1);
}

const preferred = Number(opts.port ?? process.env.API_PORT ?? 8787);
let server: AppServer | null = null;
for (let port = preferred; port < preferred + 10 && !server; port++) {
  try {
    server = await startServer(cfg, { port, host: process.env.API_HOST || "127.0.0.1" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    if (await alreadyRunning(port)) {
      const url = `http://127.0.0.1:${port}/`;
      console.log(`The application is already running at ${url}; opening it.`);
      if (opts.browser) openBrowser(url);
      process.exit(0);
    }
  }
}
if (!server) {
  console.error(`No free port between ${preferred} and ${preferred + 9}. Set API_PORT in .env to another port.`);
  process.exit(1);
}

console.log("Legal Evidence Manager is running.");
console.log(`  Address:         ${server.url}`);
console.log(`  Evidence folder: ${cfg.originalsDir} (read-only for the application)`);
console.log("\nKeep this window open while you use the application. Close it (or press Ctrl+C) to stop.\n");
if (opts.browser) openBrowser(server.url);

const stop = async () => {
  await server?.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
