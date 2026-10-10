import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import { safeAppendLine, writeJson, safeWriteFile } from "../util/fs-guard.js";
import {
  CanonicalEvidence,
  Chunk,
  IngestionStatusRecord,
  Relationship,
  type CanonicalEvidence as CanonicalEvidenceT,
  type Chunk as ChunkT,
  type IngestionStatusRecord as IngestionStatusRecordT,
  type Relationship as RelationshipT,
} from "./models.js";

/** Read/write access to generated evidence artefacts. Never touches the originals directory. */
export class EvidenceRepository {
  constructor(private readonly cfg: AppConfig) {}

  canonicalPath(evidenceId: string): string {
    return path.join(this.cfg.canonicalDir, `${evidenceId}.json`);
  }
  markdownPath(evidenceId: string): string {
    return path.join(this.cfg.extractedDir, `${evidenceId}.md`);
  }
  structurePath(evidenceId: string): string {
    return path.join(this.cfg.extractedDir, `${evidenceId}.structure.json`);
  }
  chunksPath(evidenceId: string): string {
    return path.join(this.cfg.extractedDir, `${evidenceId}.chunks.jsonl`);
  }
  private relationshipsPath(): string {
    return path.join(this.cfg.indexesDir, "relationships.jsonl");
  }
  private statusPath(): string {
    return path.join(this.cfg.indexesDir, "ingestion-status.jsonl");
  }

  /** Path stored inside records: relative to the data directory, forward slashes. */
  dataRelative(file: string): string {
    return path.relative(this.cfg.dataDir, file).split(path.sep).join("/");
  }

  saveCanonical(record: CanonicalEvidenceT): void {
    writeJson(this.canonicalPath(record.evidence_id), CanonicalEvidence.parse(record));
  }

  loadCanonical(evidenceId: string): CanonicalEvidenceT | undefined {
    const file = this.canonicalPath(evidenceId);
    if (!existsSync(file)) return undefined;
    return CanonicalEvidence.parse(JSON.parse(readFileSync(file, "utf8")));
  }

  listCanonical(): CanonicalEvidenceT[] {
    if (!existsSync(this.cfg.canonicalDir)) return [];
    return readdirSync(this.cfg.canonicalDir)
      .filter((f) => /^EVID-\d{6}\.json$/.test(f))
      .sort()
      .map((f) => CanonicalEvidence.parse(JSON.parse(readFileSync(path.join(this.cfg.canonicalDir, f), "utf8"))));
  }

  saveMarkdown(evidenceId: string, markdown: string): string {
    const file = this.markdownPath(evidenceId);
    safeWriteFile(file, markdown);
    return file;
  }

  saveStructure(evidenceId: string, structure: unknown): string {
    const file = this.structurePath(evidenceId);
    writeJson(file, structure);
    return file;
  }

  saveChunks(evidenceId: string, chunks: ChunkT[]): string {
    const file = this.chunksPath(evidenceId);
    safeWriteFile(file, chunks.map((c) => JSON.stringify(Chunk.parse(c))).join("\n") + (chunks.length ? "\n" : ""));
    return file;
  }

  loadChunks(evidenceId: string): ChunkT[] {
    const file = this.chunksPath(evidenceId);
    if (!existsSync(file)) return [];
    return readJsonl(file).map((row) => Chunk.parse(row));
  }

  addRelationship(rel: RelationshipT): void {
    const exists = this.loadRelationships().some(
      (r) => r.subject === rel.subject && r.predicate === rel.predicate && r.object === rel.object,
    );
    if (!exists) safeAppendLine(this.relationshipsPath(), JSON.stringify(Relationship.parse(rel)));
  }

  loadRelationships(): RelationshipT[] {
    const file = this.relationshipsPath();
    return existsSync(file) ? readJsonl(file).map((r) => Relationship.parse(r)) : [];
  }

  recordStatus(rec: IngestionStatusRecordT): void {
    safeAppendLine(this.statusPath(), JSON.stringify(IngestionStatusRecord.parse(rec)));
  }

  loadStatuses(): IngestionStatusRecordT[] {
    const file = this.statusPath();
    return existsSync(file) ? readJsonl(file).map((r) => IngestionStatusRecord.parse(r)) : [];
  }
}

export function readJsonl(file: string): unknown[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      try {
        return JSON.parse(line) as unknown;
      } catch (err) {
        throw new Error(`Invalid JSON on line ${i + 1} of ${file}: ${(err as Error).message}`);
      }
    });
}
