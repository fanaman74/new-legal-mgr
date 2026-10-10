import { headingLevelForLine } from "./headings.js";
import { emptyOutput, UnitBuilder, type ParseOutput } from "./types.js";

/** Plain text / Markdown parser. Markdown "#" headings and blank-line paragraphs are honoured. */
export function parseText(data: Uint8Array, isMarkdown: boolean): ParseOutput {
  const out = emptyOutput(isMarkdown ? "markdown" : "text", "builtin@1");
  const text = new TextDecoder("utf-8", { fatal: false }).decode(data).replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  if (text.includes("�")) out.warnings.push("file is not valid UTF-8; undecodable bytes were replaced");
  const builder = new UnitBuilder();
  let section = 0;
  let paragraph = 0;
  for (const raw of text.split(/\n\s*\n/)) {
    const para = raw.trim();
    if (!para) continue;
    const md = isMarkdown ? /^(#{1,6})\s+(.+)$/.exec(para) : null;
    const level = md ? md[1]!.length : !para.includes("\n") ? headingLevelForLine(para) : null;
    if (level) section++;
    builder.add({
      id: `P${String(++paragraph).padStart(4, "0")}`,
      kind: level ? "heading" : "paragraph",
      text: md ? md[2]! : para,
      level,
      section_id: `S${String(section).padStart(3, "0")}`,
    });
  }
  out.units = [{ page: null, text: builder.text, blocks: builder.blocks, ocr: false, ocr_confidence: null }];
  out.markdown = text;
  const h = builder.blocks.find((b) => b.kind === "heading");
  if (h) out.title = { value: builder.text.slice(h.char_start, h.char_end), source: "first_heading" };
  return out;
}
