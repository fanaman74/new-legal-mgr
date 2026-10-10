import CFB from "cfb";
import { afterAll, describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { parseDocx } from "../../src/ingestion/parsers/docx.js";
import { parseEml } from "../../src/ingestion/parsers/eml.js";
import { parseMsg } from "../../src/ingestion/parsers/msg.js";
import { OcrEngine } from "../../src/ingestion/parsers/ocr.js";
import { parsePdf } from "../../src/ingestion/parsers/pdf.js";
import { parseText } from "../../src/ingestion/parsers/text.js";
import type { ParserContext } from "../../src/ingestion/parsers/types.js";
import { buildMsg } from "../../src/testing/msg-writer.js";
import { makeDocx, makeEml, makePdf, makeScannedPdf } from "../../src/testing/sample-corpus.js";

const cfg = loadConfig();
const ctx: ParserContext = { minTextCharsPerPage: cfg.pdf.minTextCharsPerPage, ocrRenderScale: cfg.pdf.ocrRenderScale, ocr: { ...cfg.ocr, enabled: true } };
const ocr = new OcrEngine(cfg.ocr);
afterAll(() => ocr.close());

const enc = (s: string) => new TextEncoder().encode(s);
const alice = { name: "Alice Example", address: "alice@example.org" };
const bob = { name: "Bob Example", address: "bob@example.org" };

describe("PDF parser", () => {
  it("keeps physical page numbers, paragraphs and headings", async () => {
    const pdf = await makePdf([{ h: "DECISION OF THE AUTHORITY", size: 16 }, { p: "Date: 12 May 2025" }, { h: "1. Procedure" }, { p: "First page text." }, "pagebreak", { h: "2. Assessment" }, { p: "Second page text." }], "My decision");
    const out = await parsePdf(pdf, ctx, null);
    expect(out.pageCount).toBe(2);
    expect(out.units.map((u) => u.page)).toEqual([1, 2]);
    expect(out.title).toEqual({ value: "My decision", source: "pdf_metadata" });
    const headings = out.units.flatMap((u) => u.blocks.filter((b) => b.kind === "heading").map((b) => u.text.slice(b.char_start, b.char_end)));
    expect(headings).toEqual(["DECISION OF THE AUTHORITY", "1. Procedure", "2. Assessment"]);
    expect(out.units[1]!.text).toContain("Second page text.");
    expect(out.markdown).toContain("<!-- page 2 -->");
  });

  it("OCRs image-only pages locally and flags them", async () => {
    const pdf = await makeScannedPdf([{ h: "MEDICAL CERTIFICATE", size: 16 }, { p: "The patient is unfit for work from 2 December 2024.", size: 13 }]);
    const out = await parsePdf(pdf, ctx, ocr);
    expect(out.ocrPages).toEqual([1]);
    expect(out.parser).toBe("pdf-text+ocr");
    expect(out.units[0]!.ocr).toBe(true);
    expect(out.units[0]!.ocr_confidence).toBeGreaterThan(70);
    expect(out.units[0]!.text).toMatch(/unfit for work from 2 December 2024/);
  });

  it("marks scanned pages as partial (not silently empty) when OCR is disabled", async () => {
    const pdf = await makeScannedPdf([{ p: "Scanned content only.", size: 13 }]);
    const out = await parsePdf(pdf, { ...ctx, ocr: { ...ctx.ocr, enabled: false } }, null);
    expect(out.status).toBe("partial");
    expect(out.warnings.join(" ")).toMatch(/OCR is disabled/);
  });

  it("rejects a corrupt PDF with an error", async () => {
    await expect(parsePdf(enc("%PDF-1.4\nthis is not a pdf"), ctx, null)).rejects.toThrow();
  });
});

describe("DOCX parser", () => {
  it("produces sections and paragraph IDs, no page numbers, and ignores file-metadata authors", async () => {
    const docx = await makeDocx({
      title: "Termination letter",
      creator: "Template Author",
      blocks: [{ p: "Brussels, 28 February 2025" }, { h: "Reasons", level: 1 }, { p: "Shortcomings & delays." }, { bullets: ["First point.", "Second point."] }],
    });
    const out = await parseDocx(docx);
    const unit = out.units[0]!;
    expect(unit.page).toBeNull();
    expect(unit.blocks.map((b) => [b.id, b.kind, b.section_id])).toEqual([
      ["P0001", "paragraph", "S000"],
      ["P0002", "heading", "S001"],
      ["P0003", "paragraph", "S001"],
      ["P0004", "list_item", "S001"],
      ["P0005", "list_item", "S001"],
    ]);
    expect(unit.text).toContain("Shortcomings & delays.");
    expect(out.title).toEqual({ value: "Termination letter", source: "docx_metadata" });
    expect(out.embeddedMetadata["docx.creator"]).toBe("Template Author");
  });
});

describe("text parser", () => {
  it("honours Markdown headings", () => {
    const out = parseText(enc("# Notes\n\nSome text.\n\n## Dates\n\n- 17 January 2025"), true);
    expect(out.units[0]!.blocks.map((b) => [b.kind, b.section_id])).toEqual([["heading", "S001"], ["paragraph", "S001"], ["heading", "S002"], ["paragraph", "S002"]]);
  });
});

describe("Outlook .msg parser", () => {
  const spec = {
    subject: "Submission",
    from: alice,
    to: [bob],
    cc: [{ name: "Carol", address: "carol@example.org" }],
    bcc: [{ name: "Dan", address: "dan@example.org" }],
    sentAt: new Date("2025-01-17T23:30:00Z"),
    utcOffsetMinutes: 60,
    messageId: "<m1@example.org>",
    inReplyTo: "<m0@example.org>",
    body: "Dear Bob,\r\n\r\nSee attached.",
    attachments: [
      { filename: "annex.txt", mimeType: "text/plain", data: enc("annex body") },
      { displayName: "Original message", message: { subject: "Inner", from: bob, to: [alice], sentAt: new Date("2025-01-01T10:00:00Z"), messageId: "<inner@example.org>", body: "Inner body" } },
    ],
  };

  it("preserves native email metadata including BCC and Message-ID", () => {
    const out = parseMsg(buildMsg(spec));
    expect(out.email).toMatchObject({
      format: "msg",
      message_id: "<m1@example.org>",
      from: alice,
      to: [bob],
      cc: [{ name: "Carol", address: "carol@example.org" }],
      bcc: [{ name: "Dan", address: "dan@example.org" }],
      sent_at: "2025-01-17T23:30:00.000Z",
      subject: "Submission",
      in_reply_to: "<m0@example.org>",
    });
    // 23:30 UTC is already 18 January for a sender at UTC+1.
    expect(out.emailDate?.date).toBe("2025-01-18");
    expect(out.units[0]!.blocks.map((b) => b.section_id)).toEqual(["HDR", "BODY", "BODY"]);
  });

  it("extracts file attachments byte-for-byte and embedded messages as standalone .msg", () => {
    const out = parseMsg(buildMsg(spec));
    expect(out.attachments.map((a) => [a.index, a.filename, a.kind])).toEqual([
      [0, "annex.txt", "file"],
      [1, "Original message.msg", "embedded_message"],
    ]);
    expect(new TextDecoder().decode(out.attachments[0]!.data!)).toBe("annex body");
    const inner = parseMsg(out.attachments[1]!.data!);
    expect(inner.email).toMatchObject({ subject: "Inner", from: bob, message_id: "<inner@example.org>" });
  });

  it("falls back to MAPI properties when transport headers are absent", () => {
    const out = parseMsg(buildMsg({ ...spec, transportHeaders: false, attachments: [] }));
    expect(out.email).toMatchObject({ from: alice, sent_at: "2025-01-17T23:30:00.000Z", message_id: "<m1@example.org>" });
    expect(out.emailDate?.basis).toMatch(/UTC\)$/);
  });

  it("records attachments it cannot extract instead of dropping them", () => {
    const cfb = CFB.read(Buffer.from(buildMsg({ ...spec, attachments: [spec.attachments[0]!] })), { type: "buffer" });
    // Rewrite the attachment as an OLE object (PR_ATTACH_METHOD = 6) with no data stream.
    const dir = cfb.FullPaths.find((p) => /__attach_version1\.0_#00000000\/$/.test(p))!;
    const props = CFB.find(cfb, `${dir}__properties_version1.0`)!;
    const buf = Buffer.from(props.content as Uint8Array);
    for (let off = 8; off + 16 <= buf.length; off += 16) if (buf.readUInt32LE(off) === 0x37050003) buf.writeInt32LE(6, off + 8);
    props.content = buf;
    CFB.utils.cfb_del(cfb, `${dir}__substg1.0_37010102`);
    const out = parseMsg(Uint8Array.from(CFB.write(cfb, { type: "buffer" }) as Buffer));
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]).toMatchObject({ kind: "unsupported", data: null, filename: "annex.txt" });
    expect(out.warnings.join(" ")).toMatch(/not supported/);
  });

  it("rejects a file that is not an Outlook message", () => {
    expect(() => parseMsg(enc("not an OLE file at all"))).toThrow();
  });
});

describe(".eml parser", () => {
  it("preserves headers, sender offset and attachments, including attached messages", async () => {
    const inner = makeEml({ from: "Bob <bob@example.org>", to: "Alice <alice@example.org>", subject: "Inner", date: "Wed, 1 Jan 2025 10:00:00 +0000", messageId: "<in@example.org>", body: "Inner body" });
    const eml = makeEml({
      from: '"Alice Example" <alice@example.org>',
      to: '"Bob Example" <bob@example.org>',
      cc: "carol@example.org",
      subject: "Re: Request",
      date: "Tue, 18 Feb 2025 00:30:00 +0100",
      messageId: "<e1@example.org>",
      inReplyTo: "<e0@example.org>",
      body: "Dear Bob,\r\n\r\nPlease see the note.",
      attachments: [
        { filename: "note.txt", contentType: "text/plain", data: enc("note body") },
        { filename: "forwarded.eml", contentType: "message/rfc822", data: inner },
      ],
    });
    const out = await parseEml(eml);
    expect(out.email).toMatchObject({
      format: "eml",
      message_id: "<e1@example.org>",
      from: alice,
      to: [bob],
      cc: [{ name: null, address: "carol@example.org" }],
      sent_at: "2025-02-17T23:30:00.000Z",
      in_reply_to: "<e0@example.org>",
      subject: "Re: Request",
    });
    expect(out.emailDate).toMatchObject({ date: "2025-02-18" });
    expect(out.attachments.map((a) => [a.filename, a.kind])).toEqual([
      ["note.txt", "file"],
      ["forwarded.eml", "embedded_message"],
    ]);
    expect(new TextDecoder().decode(out.attachments[0]!.data!)).toBe("note body");
    expect((await parseEml(out.attachments[1]!.data!)).email?.subject).toBe("Inner");
  });

  it("derives body text from HTML-only messages", async () => {
    const eml = enc("From: a@example.org\r\nTo: b@example.org\r\nSubject: html\r\nDate: Mon, 3 Mar 2025 10:00:00 +0000\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Hello <b>there</b></p><p>Second paragraph</p>");
    const out = await parseEml(eml);
    expect(out.units[0]!.text).toContain("Hello there");
    expect(out.email?.has_html_body).toBe(true);
  });
});
