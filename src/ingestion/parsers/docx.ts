import mammoth from "mammoth";
import JSZip from "jszip";
import { parse as parseHtml, HTMLElement, NodeType } from "node-html-parser";
import { packageVersion } from "../../util/versions.js";
import { usableEmbeddedTitle } from "../metadata.js";
import { emptyOutput, UnitBuilder, type ParseOutput } from "./types.js";

/**
 * DOCX parser (mammoth -> semantic HTML -> blocks).
 *
 * DOCX has no stable pagination, so no page numbers are produced. Provenance is expressed as
 * section identifiers (S000 = before the first heading, S001 = first heading, ...) and
 * paragraph identifiers (P0001, P0002, ... in document order).
 */

async function readCoreProperties(data: Uint8Array): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  try {
    const zip = await JSZip.loadAsync(data);
    const core = await zip.file("docProps/core.xml")?.async("string");
    const fields: [string, string][] = [
      ["docx.title", "dc:title"],
      ["docx.creator", "dc:creator"],
      ["docx.lastModifiedBy", "cp:lastModifiedBy"],
      ["docx.created", "dcterms:created"],
      ["docx.modified", "dcterms:modified"],
    ];
    for (const [key, tag] of fields) {
      const m = core?.match(new RegExp(`<${tag}[^>]*>([^<]*)</${tag}>`));
      out[key] = m?.[1]?.trim() ? decodeXml(m[1].trim()) : null;
    }
  } catch {
    // Missing/corrupt core properties are not fatal.
  }
  return out;
}

function decodeXml(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function textOf(el: HTMLElement): string {
  return el.text.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
}

export async function parseDocx(data: Uint8Array): Promise<ParseOutput> {
  const out = emptyOutput("docx", `mammoth@${packageVersion("mammoth")}`);
  const result = await mammoth.convertToHtml({ buffer: Buffer.from(data) });
  for (const m of result.messages) if (m.type === "error") out.warnings.push(`mammoth: ${m.message}`);

  const html = result.value.replace(/<br\s*\/?>/gi, "\n");
  const root = parseHtml(html);
  const builder = new UnitBuilder();
  let section = 0;
  let paragraph = 0;
  const sectionId = () => `S${String(section).padStart(3, "0")}`;
  const nextId = () => `P${String(++paragraph).padStart(4, "0")}`;
  const md: string[] = [];

  const visitList = (list: HTMLElement, depth: number, ordered: boolean) => {
    let n = 0;
    for (const li of list.childNodes) {
      if (!(li instanceof HTMLElement) || li.tagName !== "LI") continue;
      n++;
      const nested = li.childNodes.filter((c): c is HTMLElement => c instanceof HTMLElement && (c.tagName === "UL" || c.tagName === "OL"));
      for (const c of nested) c.remove();
      const text = textOf(li);
      if (text) {
        builder.add({ id: nextId(), kind: "list_item", text, section_id: sectionId() });
        md.push(`${"  ".repeat(depth)}${ordered ? `${n}.` : "-"} ${text.replace(/\n/g, " ")}`);
      }
      for (const c of nested) visitList(c, depth + 1, c.tagName === "OL");
    }
  };

  for (const node of root.childNodes) {
    if (node.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName;
    const heading = /^H([1-6])$/.exec(tag);
    if (heading) {
      const text = textOf(el);
      if (!text) continue;
      section++;
      const level = Number(heading[1]);
      builder.add({ id: nextId(), kind: "heading", text, level, section_id: sectionId() });
      md.push(`${"#".repeat(level)} ${text.replace(/\n/g, " ")}`);
    } else if (tag === "UL" || tag === "OL") {
      visitList(el, 0, tag === "OL");
    } else if (tag === "TABLE") {
      const rows = el.querySelectorAll("tr").map((tr) => tr.querySelectorAll("td,th").map((cell) => textOf(cell).replace(/\n/g, " ")));
      const text = rows.map((r) => r.join(" | ")).join("\n");
      if (text.trim()) {
        builder.add({ id: nextId(), kind: "table", text, section_id: sectionId() });
        if (rows.length) {
          md.push([`| ${rows[0]!.join(" | ")} |`, `|${rows[0]!.map(() => " --- ").join("|")}|`, ...rows.slice(1).map((r) => `| ${r.join(" | ")} |`)].join("\n"));
        }
      }
    } else {
      const text = textOf(el);
      if (!text) continue;
      builder.add({ id: nextId(), kind: "paragraph", text, section_id: sectionId() });
      md.push(text);
    }
  }

  out.units = [{ page: null, text: builder.text, blocks: builder.blocks, ocr: false, ocr_confidence: null }];
  out.markdown = md.join("\n\n");
  out.embeddedMetadata = await readCoreProperties(data);
  const embeddedTitle = usableEmbeddedTitle(out.embeddedMetadata["docx.title"]);
  if (embeddedTitle) out.title = { value: embeddedTitle, source: "docx_metadata" };
  else {
    const h = builder.blocks.find((b) => b.kind === "heading");
    if (h) out.title = { value: builder.text.slice(h.char_start, h.char_end).replace(/\s+/g, " "), source: "first_heading" };
  }
  if (!builder.blocks.length) out.warnings.push("document contains no extractable text");
  return out;
}
