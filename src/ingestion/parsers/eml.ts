import { simpleParser, type AddressObject } from "mailparser";
import type { EmailAddress, EmailMetadata } from "../../evidence/models.js";
import { packageVersion } from "../../util/versions.js";
import { buildEmailUnits, htmlToText, toIso } from "./email-common.js";
import { emptyOutput, type ExtractedAttachment, type ParseOutput } from "./types.js";

/**
 * RFC 822 / MIME .eml parser (mailparser).
 *
 * Every MIME attachment, including inline (cid:) images and attached messages
 * (message/rfc822, saved as .eml), is extracted byte-for-byte and linked to the parent.
 */

function addresses(obj: AddressObject | AddressObject[] | undefined): EmailAddress[] {
  if (!obj) return [];
  const list = Array.isArray(obj) ? obj : [obj];
  const out: EmailAddress[] = [];
  const visit = (entries: AddressObject["value"]) => {
    for (const e of entries) {
      if (e.group) visit(e.group);
      else out.push({ name: e.name?.trim() || null, address: e.address?.trim() || null });
    }
  };
  for (const a of list) visit(a.value);
  return out;
}

export async function parseEml(data: Uint8Array): Promise<ParseOutput> {
  const out = emptyOutput("eml", `mailparser@${packageVersion("mailparser")}`);
  const parsed = await simpleParser(Buffer.from(data), { skipTextToHtml: true, skipImageLinks: true });
  const rawDate = parsed.headerLines.find((h) => h.key === "date")?.line.replace(/^date:\s*/i, "") ?? null;
  const from = addresses(parsed.from);
  if (!parsed.headerLines.length) throw new Error("no RFC 822 headers found");

  let body = parsed.text ?? "";
  if (!body.trim() && typeof parsed.html === "string") {
    body = htmlToText(parsed.html);
    out.warnings.push("plain-text body missing; text derived from HTML body");
  }

  const meta: EmailMetadata = {
    format: "eml",
    message_id: parsed.messageId?.trim() || null,
    from: from[0] ?? null,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    bcc: addresses(parsed.bcc),
    sent_at: toIso(parsed.date ?? null),
    received_at: null,
    subject: parsed.subject?.trim() || null,
    in_reply_to: typeof parsed.inReplyTo === "string" ? parsed.inReplyTo.trim() : null,
    has_html_body: typeof parsed.html === "string" && parsed.html.length > 0,
  };
  if (from.length > 1) out.warnings.push(`multiple From addresses; first one recorded as sender`);

  const attachments: ExtractedAttachment[] = parsed.attachments.map((a, index) => {
    const isMessage = a.contentType?.toLowerCase() === "message/rfc822";
    let filename = a.filename ?? null;
    if (isMessage && filename && !/\.eml$/i.test(filename)) filename = `${filename}.eml`;
    if (isMessage && !filename) filename = "attached message.eml";
    return {
      index,
      filename,
      mimeType: a.contentType ?? null,
      data: Uint8Array.from(a.content),
      kind: isMessage ? "embedded_message" : "file",
      note: a.related ? "inline (related) MIME part" : null,
    };
  });

  buildEmailUnits(out, meta, body, attachments, rawDate);
  out.embeddedMetadata = {
    "eml.x-mailer": parsed.headers.get("x-mailer")?.toString() ?? null,
    "eml.date-header": rawDate,
  };
  return out;
}
