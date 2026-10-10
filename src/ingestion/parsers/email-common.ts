import { parse as parseHtml } from "node-html-parser";
import type { EmailAddress, EmailMetadata } from "../../evidence/models.js";
import { calendarDate, parseHeaderOffset } from "../metadata.js";
import { UnitBuilder, type ExtractedAttachment, type ParseOutput } from "./types.js";

export function formatAddress(a: EmailAddress): string {
  if (a.name && a.address && a.name !== a.address) return `${a.name} <${a.address}>`;
  return a.address ?? a.name ?? "";
}

export function htmlToText(html: string): string {
  return parseHtml(html.replace(/<br\s*\/?>/gi, "\n"), { blockTextElements: { script: false, style: false } })
    .structuredText.replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Return the value of a header from a raw RFC 822 header block (unfolded). */
export function headerValue(rawHeaders: string | null | undefined, name: string): string | null {
  if (!rawHeaders) return null;
  const unfolded = rawHeaders.replace(/\r?\n[ \t]+/g, " ");
  const m = unfolded.match(new RegExp(`^${name}:[ \\t]*(.*)$`, "im"));
  return m?.[1]?.trim() || null;
}

export function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Build the text units for an email: a header section (HDR) and the body (BODY), each split
 * into paragraph blocks so that chunk provenance points to a section and paragraph IDs.
 */
export function buildEmailUnits(out: ParseOutput, meta: EmailMetadata, body: string, attachments: ExtractedAttachment[], dateHeader: string | null): void {
  const builder = new UnitBuilder();
  const headerLines = [
    meta.from ? `From: ${formatAddress(meta.from)}` : null,
    meta.to.length ? `To: ${meta.to.map(formatAddress).join("; ")}` : null,
    meta.cc.length ? `Cc: ${meta.cc.map(formatAddress).join("; ")}` : null,
    meta.bcc.length ? `Bcc: ${meta.bcc.map(formatAddress).join("; ")}` : null,
    meta.sent_at ? `Sent: ${meta.sent_at}` : null,
    meta.subject ? `Subject: ${meta.subject}` : null,
    attachments.length ? `Attachments: ${attachments.map((a) => a.filename ?? `(unnamed attachment ${a.index + 1})`).join("; ")}` : null,
  ].filter((l): l is string => l !== null);
  builder.add({ id: "H0001", kind: "email_header", text: headerLines.join("\n"), section_id: "HDR" });

  let n = 0;
  for (const raw of body.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const para = raw.split("\n").map((l) => l.trimEnd()).join("\n").trim();
    if (para) builder.add({ id: `P${String(++n).padStart(4, "0")}`, kind: "paragraph", text: para, section_id: "BODY" });
  }
  if (n === 0) out.warnings.push("email has no body text");

  out.units = [{ page: null, text: builder.text, blocks: builder.blocks, ocr: false, ocr_confidence: null }];
  out.markdown = [`# ${meta.subject ?? "(no subject)"}`, "", ...headerLines.map((l) => `- ${l}`), "", body.trim()].join("\n");
  out.email = meta;
  out.attachments = attachments;
  if (meta.subject) out.title = { value: meta.subject, source: "email_subject" };
  if (meta.sent_at) {
    const offset = parseHeaderOffset(dateHeader);
    out.emailDate = {
      date: calendarDate(meta.sent_at, offset),
      basis: offset !== null ? "email sent timestamp (sender's UTC offset from Date header)" : "email sent timestamp (UTC)",
    };
  }
}

/**
 * File name for an extracted attachment, safe on Windows, macOS and Linux: invalid characters
 * replaced, leading dots and trailing dots/spaces removed, length capped, and always prefixed
 * with the attachment index (which also defuses reserved device names such as CON or NUL).
 */
export function safeAttachmentName(name: string | null, index: number, fallbackExt: string): string {
  let base = (name ?? "").normalize("NFC").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  if (base.length > 120) {
    const ext = /\.[A-Za-z0-9]{1,8}$/.exec(base)?.[0] ?? "";
    base = base.slice(0, 120 - ext.length) + ext;
  }
  base = base.replace(/[. ]+$/, "");
  return `${String(index + 1).padStart(2, "0")}_${base || `attachment${fallbackExt}`}`;
}
