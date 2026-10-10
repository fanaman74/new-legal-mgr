import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EvidenceId, SourceRoot } from "./models.js";
import { writeJson } from "../util/fs-guard.js";

/**
 * Evidence ID registry: EVID-NNNNNN <-> SHA-256 <-> source paths.
 *
 * - IDs are allocated sequentially and never reused; they are NOT derived from filenames.
 * - Identity is the SHA-256 of the bytes: the same binary at two paths (a duplicate copy, a
 *   renamed file, or an email attachment that is also present as a standalone file) maps to
 *   the same Evidence ID and the extra path is recorded as an alias.
 * - The registry is persisted as JSON in data/indexes/evidence-registry.json.
 */

const PathRef = z.object({
  source_root: SourceRoot,
  relative_path: z.string(),
  first_seen: z.string(),
});
export type PathRef = z.infer<typeof PathRef>;

const RegistryEntry = z.object({
  evidence_id: EvidenceId,
  sha256: z.string(),
  size_bytes: z.number().int().nonnegative(),
  registered_at: z.string(),
  /** All paths ever seen with this content, in order of discovery. paths[0] is the primary path. */
  paths: z.array(PathRef),
  /** Parent emails this content was extracted from (attachment_of). */
  parents: z.array(EvidenceId),
});
export type RegistryEntry = z.infer<typeof RegistryEntry>;

const RegistryFile = z.object({
  registry_version: z.literal(1),
  next_sequence: z.number().int().positive(),
  entries: z.array(RegistryEntry),
});

export interface RegisterResult {
  entry: RegistryEntry;
  /** True if a new Evidence ID was allocated. */
  created: boolean;
  /** True if the content was already registered under another path. */
  duplicateOfExisting: boolean;
  /** True if this exact path had not been seen for this content before. */
  newPath: boolean;
}

export function formatEvidenceId(sequence: number): string {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > 999_999) {
    throw new Error(`Evidence sequence out of range: ${sequence}`);
  }
  return `EVID-${String(sequence).padStart(6, "0")}`;
}

export class EvidenceRegistry {
  private entries = new Map<string, RegistryEntry>();
  private bySha = new Map<string, string>();
  private nextSequence = 1;

  private constructor(private readonly file: string) {}

  static load(indexesDir: string): EvidenceRegistry {
    const reg = new EvidenceRegistry(path.join(indexesDir, "evidence-registry.json"));
    if (existsSync(reg.file)) {
      const data = RegistryFile.parse(JSON.parse(readFileSync(reg.file, "utf8")));
      reg.nextSequence = data.next_sequence;
      for (const entry of data.entries) {
        reg.entries.set(entry.evidence_id, entry);
        if (reg.bySha.has(entry.sha256)) {
          throw new Error(`Corrupt registry: SHA-256 ${entry.sha256} registered twice`);
        }
        reg.bySha.set(entry.sha256, entry.evidence_id);
      }
    }
    return reg;
  }

  save(): void {
    writeJson(this.file, {
      registry_version: 1,
      next_sequence: this.nextSequence,
      entries: [...this.entries.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id)),
    });
  }

  get(evidenceId: string): RegistryEntry | undefined {
    return this.entries.get(evidenceId);
  }

  findBySha(sha256: string): RegistryEntry | undefined {
    const id = this.bySha.get(sha256);
    return id ? this.entries.get(id) : undefined;
  }

  all(): RegistryEntry[] {
    return [...this.entries.values()].sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
  }

  register(args: {
    sha256: string;
    sizeBytes: number;
    sourceRoot: z.infer<typeof SourceRoot>;
    relativePath: string;
    parent?: string;
  }): RegisterResult {
    const now = new Date().toISOString();
    const existing = this.findBySha(args.sha256);
    if (existing) {
      const newPath = !existing.paths.some(
        (p) => p.source_root === args.sourceRoot && p.relative_path === args.relativePath,
      );
      if (newPath) existing.paths.push({ source_root: args.sourceRoot, relative_path: args.relativePath, first_seen: now });
      if (args.parent && !existing.parents.includes(args.parent)) existing.parents.push(args.parent);
      return { entry: existing, created: false, duplicateOfExisting: newPath, newPath };
    }
    const entry: RegistryEntry = {
      evidence_id: formatEvidenceId(this.nextSequence++),
      sha256: args.sha256,
      size_bytes: args.sizeBytes,
      registered_at: now,
      paths: [{ source_root: args.sourceRoot, relative_path: args.relativePath, first_seen: now }],
      parents: args.parent ? [args.parent] : [],
    };
    this.entries.set(entry.evidence_id, entry);
    this.bySha.set(entry.sha256, entry.evidence_id);
    return { entry, created: true, duplicateOfExisting: false, newPath: true };
  }
}
