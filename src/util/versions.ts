import { readFileSync } from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../config.js";

const cache = new Map<string, string>();

/** Installed version of a dependency, for provenance records. */
export function packageVersion(name: string): string {
  const cached = cache.get(name);
  if (cached) return cached;
  let version = "unknown";
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "node_modules", name, "package.json"), "utf8")) as { version?: string };
    version = pkg.version ?? "unknown";
  } catch {
    // leave as unknown
  }
  cache.set(name, version);
  return version;
}
