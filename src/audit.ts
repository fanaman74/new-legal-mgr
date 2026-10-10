import { createHash, randomUUID } from "node:crypto";
import { safeAppendLine } from "./util/fs-guard.js";

/**
 * Append-only JSONL audit trail of machine actions.
 *
 * Only identifiers, hashes, statuses and short error messages are recorded. Document text,
 * query text and email bodies must never be written here.
 */
export type AuditAction =
  | "INGEST"
  | "INGEST_UNCHANGED"
  | "DUPLICATE"
  | "PARSE_FAILED"
  | "UNSUPPORTED"
  | "SKIPPED"
  | "ATTACHMENT_EXTRACTED"
  | "ATTACHMENT_NOT_EXTRACTED"
  | "CORRECTION"
  | "MANIFEST_CREATED"
  | "MANIFEST_VERIFIED"
  | "ORIGINAL_OPENED"
  | "QUERY";

export interface AuditEvent {
  action: AuditAction;
  evidence_id?: string;
  sha256?: string;
  parser?: string;
  status?: string;
  /** Short, content-free description (e.g. an exception message). */
  detail?: string;
  [key: string]: unknown;
}

export class AuditLog {
  constructor(private readonly file: string) {}

  record(event: AuditEvent): void {
    const entry = { timestamp: new Date().toISOString(), event_id: randomUUID(), ...event };
    safeAppendLine(this.file, JSON.stringify(entry));
  }
}

/** Hash free text (e.g. a query) so it can be correlated without storing it. */
export function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
