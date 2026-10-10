import * as msgreader from "@kenjiuno/msgreader";
import CFB from "cfb";
import type { EmailAddress, EmailMetadata } from "../../evidence/models.js";
import { packageVersion } from "../../util/versions.js";
import { buildEmailUnits, headerValue, htmlToText, toIso } from "./email-common.js";
import { emptyOutput, type ExtractedAttachment, type ParseOutput } from "./types.js";

/**
 * Outlook .msg parser.
 *
 * Message-level fields (sender, recipients incl. BCC, subject, body, transport headers,
 * submit/delivery times, Internet Message-ID) come from @kenjiuno/msgreader.
 *
 * Attachments are enumerated directly from the compound file (cfb) so that every attachment
 * storage is accounted for:
 *   - by-value attachments (PR_ATTACH_METHOD = 1) are extracted byte-for-byte;
 *   - embedded messages (method 5) are re-packaged as standalone .msg files, so they can be
 *     ingested and their own attachments followed recursively;
 *   - anything else (OLE objects, references) is recorded as "unsupported" with a note and
 *     logged; nothing is silently discarded.
 */

// CommonJS interop: depending on the loader the class is exposed as default or default.default.
type MsgReaderClass = typeof msgreader.default.default;
const MsgReader: MsgReaderClass =
  (msgreader.default as unknown as { default?: MsgReaderClass }).default ?? (msgreader.default as unknown as MsgReaderClass);

const ATTACH_BY_VALUE = 1;
const ATTACH_EMBEDDED_MSG = 5;

type CfbContainer = CFB.CFB$Container;

function readStream(cfb: CfbContainer, fullPath: string): Uint8Array | null {
  const entry = CFB.find(cfb, fullPath);
  if (!entry || entry.type !== 2 || !entry.content) return null;
  return Uint8Array.from(entry.content as ArrayLike<number>);
}

function readString(cfb: CfbContainer, dir: string, propId: string): string | null {
  const unicode = readStream(cfb, `${dir}__substg1.0_${propId}001F`);
  if (unicode) return Buffer.from(unicode).toString("utf16le").replace(/\u0000+$/, "") || null;
  const ansi = readStream(cfb, `${dir}__substg1.0_${propId}001E`);
  if (ansi) return Buffer.from(ansi).toString("latin1").replace(/\u0000+$/, "") || null;
  return null;
}

/** Read a fixed-size 32-bit property from a property stream (header size depends on the storage). */
function readInt32Property(cfb: CfbContainer, dir: string, tag: number, headerSize: number): number | null {
  const props = readStream(cfb, `${dir}__properties_version1.0`);
  if (!props) return null;
  const view = Buffer.from(props);
  for (let off = headerSize; off + 16 <= view.length; off += 16) {
    if (view.readUInt32LE(off) === tag) return view.readInt32LE(off + 8);
  }
  return null;
}

/** Re-package an embedded message storage as a standalone .msg compound file. */
function extractEmbeddedMessage(cfb: CfbContainer, embeddedDir: string): Uint8Array {
  const out = CFB.utils.cfb_new();
  const root = cfb.FullPaths[0]!;
  cfb.FullPaths.forEach((fullPath, i) => {
    const entry = cfb.FileIndex[i]!;
    if (entry.type !== 2) return;
    let target: string | null = null;
    if (fullPath.startsWith(embeddedDir)) target = fullPath.slice(embeddedDir.length);
    else if (fullPath.startsWith(`${root}__nameid_version1.0/`)) target = fullPath.slice(root.length);
    if (target === null) return;
    let content = Buffer.from((entry.content ?? []) as ArrayLike<number>);
    // Embedded message property streams have a 24-byte header; top-level ones have 32 bytes.
    if (target === "__properties_version1.0") {
      content = Buffer.concat([content.subarray(0, 24), Buffer.alloc(8), content.subarray(24)]);
    }
    CFB.utils.cfb_add(out, `/${target}`, content);
  });
  CFB.utils.cfb_del(out, "/\u0001Sh33tJ5");
  return Uint8Array.from(CFB.write(out, { type: "buffer", fileType: "cfb" }) as Buffer);
}

function enumerateAttachments(data: Uint8Array): { attachments: ExtractedAttachment[]; warnings: string[] } {
  const cfb = CFB.read(Buffer.from(data), { type: "buffer" });
  const root = cfb.FullPaths[0]!;
  const dirs = cfb.FullPaths.filter((p) => new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}__attach_version1\\.0_#[0-9A-Fa-f]{8}/$`).test(p)).sort();
  const attachments: ExtractedAttachment[] = [];
  const warnings: string[] = [];
  dirs.forEach((dir, index) => {
    const method = readInt32Property(cfb, dir, 0x37050003, 8);
    const filename = readString(cfb, dir, "3707") ?? readString(cfb, dir, "3704") ?? readString(cfb, dir, "3001");
    const mimeType = readString(cfb, dir, "370E");
    const embeddedDir = `${dir}__substg1.0_3701000D/`;
    if (method === ATTACH_EMBEDDED_MSG || cfb.FullPaths.includes(embeddedDir)) {
      try {
        const msgBytes = extractEmbeddedMessage(cfb, embeddedDir);
        const name = filename ?? readString(cfb, embeddedDir, "0037") ?? "embedded message";
        attachments.push({ index, filename: /\.msg$/i.test(name) ? name : `${name}.msg`, mimeType: "application/vnd.ms-outlook", data: msgBytes, kind: "embedded_message", note: null });
      } catch (err) {
        const note = `embedded message could not be extracted: ${(err as Error).message}`;
        warnings.push(`attachment ${index + 1}: ${note}`);
        attachments.push({ index, filename, mimeType, data: null, kind: "unsupported", note });
      }
      return;
    }
    const bytes = readStream(cfb, `${dir}__substg1.0_37010102`);
    if ((method === ATTACH_BY_VALUE || method === null) && bytes) {
      attachments.push({ index, filename, mimeType, data: bytes, kind: "file", note: null });
      return;
    }
    const note = `attachment method ${method ?? "unknown"} is not supported (e.g. OLE object or link); not extracted`;
    warnings.push(`attachment ${index + 1} (${filename ?? "unnamed"}): ${note}`);
    attachments.push({ index, filename, mimeType, data: null, kind: "unsupported", note });
  });
  return { attachments, warnings };
}

function addr(name: string | undefined, address: string | undefined): EmailAddress {
  const a = address?.trim() || null;
  const n = name?.trim() || null;
  return { name: n, address: a };
}

export function parseMsg(data: Uint8Array): ParseOutput {
  const out = emptyOutput("msg", `@kenjiuno/msgreader@${packageVersion("@kenjiuno/msgreader")}; cfb@${packageVersion("cfb")}`);
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  const reader = new MsgReader(ab);
  const f = reader.getFileData();
  if (f.error) throw new Error(`not a readable Outlook message: ${f.error}`);
  if (f.messageClass && !/^IPM\./i.test(f.messageClass)) out.warnings.push(`unusual message class ${f.messageClass}`);

  const headers = f.headers ?? null;
  const recipients = f.recipients ?? [];
  const byType = (t: "to" | "cc" | "bcc") =>
    recipients.filter((r) => (r.recipType ?? "to") === t).map((r) => addr(r.name, r.smtpAddress || r.email));

  const sender = f.senderName || f.senderEmail || f.senderSmtpAddress ? addr(f.senderName, f.senderSmtpAddress || f.senderEmail) : null;
  const dateHeader = headerValue(headers, "Date");
  const htmlBody = f.bodyHtml ?? (f.html ? new TextDecoder().decode(f.html) : null);
  let body = f.body ?? "";
  if (!body.trim() && htmlBody) {
    body = htmlToText(htmlBody);
    out.warnings.push("plain-text body missing; text derived from HTML body");
  }

  const meta: EmailMetadata = {
    format: "msg",
    message_id: f.messageId?.trim() || headerValue(headers, "Message-ID"),
    from: sender,
    to: byType("to"),
    cc: byType("cc"),
    bcc: byType("bcc"),
    sent_at: toIso(f.clientSubmitTime) ?? toIso(dateHeader),
    received_at: toIso(f.messageDeliveryTime),
    subject: f.subject?.trim() || null,
    in_reply_to: headerValue(headers, "In-Reply-To"),
    has_html_body: Boolean(htmlBody),
  };

  const { attachments, warnings } = enumerateAttachments(data);
  out.warnings.push(...warnings);
  buildEmailUnits(out, meta, body, attachments, dateHeader);
  out.embeddedMetadata = {
    "msg.messageClass": f.messageClass ?? null,
    "msg.creationTime": f.creationTime ?? null,
    "msg.lastModificationTime": f.lastModificationTime ?? null,
    "msg.transportHeaders": headers ? "present" : null,
  };
  return out;
}
