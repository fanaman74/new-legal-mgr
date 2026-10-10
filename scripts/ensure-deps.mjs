// Plain JavaScript on purpose: this runs before any dependency is installed.
// Checks the Node.js version and installs/updates the application libraries when needed.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIN_NODE = [20, 12];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STAMP = ".legal-poc-install-stamp";

export function nodeVersionOk(version = process.versions.node) {
  const [major, minor] = version.split(".").map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function lockHash(root) {
  return createHash("sha256").update(readFileSync(path.join(root, "package-lock.json"))).digest("hex");
}

/** Decide whether `npm ci` is needed. Returns a reason string, or null when up to date. */
export function installReason(root = ROOT) {
  const modules = path.join(root, "node_modules");
  if (!existsSync(modules)) return "libraries not installed yet";
  const stampFile = path.join(modules, STAMP);
  const hash = lockHash(root);
  if (existsSync(stampFile)) return readFileSync(stampFile, "utf8").trim() === hash ? null : "the application was updated";
  // Installed without the launcher (e.g. `npm install`): accept if every dependency is present.
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  if (names.every((n) => existsSync(path.join(modules, n, "package.json")))) {
    writeFileSync(stampFile, hash);
    return null;
  }
  return "some libraries are missing";
}

/**
 * Run the npm that ships with the running Node.js (system install or the launcher's private
 * copy), called through node itself so that paths with spaces need no shell quoting.
 */
function runNpm(args) {
  const dir = path.dirname(process.execPath);
  const cli = [path.join(dir, "node_modules", "npm", "bin", "npm-cli.js"), path.join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")].find((f) => existsSync(f));
  // onnxruntime-node would otherwise download optional CUDA (GPU) binaries on Linux; this POC is CPU-only.
  const env = { ...process.env, ONNXRUNTIME_NODE_INSTALL: process.env.ONNXRUNTIME_NODE_INSTALL ?? "skip" };
  if (cli) return spawnSync(process.execPath, [cli, ...args], { cwd: ROOT, stdio: "inherit", env });
  // Fallback: npm from PATH (on Windows .cmd files need a shell since Node 20.12).
  return spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32", env });
}

function main() {
  console.log(`[1/4] Node.js ${process.versions.node} found.`);
  if (!nodeVersionOk()) {
    console.error(`\nThis application needs Node.js ${MIN_NODE.join(".")} or newer.`);
    console.error("Start the application with the double-click launcher (it downloads a suitable private copy),");
    console.error("or install the current LTS version from https://nodejs.org/");
    process.exit(1);
  }

  console.log("[2/4] Checking application libraries...");
  const reason = installReason();
  if (!reason) {
    console.log("      Libraries are up to date.");
    return;
  }
  const fresh = !existsSync(path.join(ROOT, "node_modules"));
  console.log(fresh
    ? `      Installing libraries (${reason}). This can take a few minutes the first time...`
    : `      Updating libraries (${reason}); only missing or changed packages are downloaded...`);
  // Fresh install: exact lockfile install. Existing install: reuse what is healthy.
  const result = runNpm(fresh ? ["ci", "--no-audit", "--no-fund"] : ["install", "--no-audit", "--no-fund"]);
  if (result.status !== 0) {
    console.error("\nInstalling the libraries failed. Check your internet connection (and proxy settings, if any), then try again.");
    process.exit(1);
  }
  writeFileSync(path.join(ROOT, "node_modules", STAMP), lockHash(ROOT));
  console.log("      Libraries installed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
