import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import {
  calendarDate,
  chooseDocumentDate,
  classifyDocumentType,
  classifyMatters,
  detectFormat,
  extractDateCandidates,
  parseHeaderOffset,
  usableEmbeddedTitle,
} from "../../src/ingestion/metadata.js";

const cfg = loadConfig();
const bytes = (s: string) => new TextEncoder().encode(s);

describe("format detection", () => {
  it("uses file signatures, with the extension only to disambiguate containers", () => {
    expect(detectFormat("a.pdf", bytes("%PDF-1.7\n")).kind).toBe("pdf");
    expect(detectFormat("a.docx", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])).kind).toBe("docx");
    expect(detectFormat("a.zip", Uint8Array.from([0x50, 0x4b, 0x03, 0x04])).kind).toBe("unsupported");
    expect(detectFormat("a.msg", Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])).kind).toBe("msg");
    expect(detectFormat("a.eml", bytes("From: a@b\r\nSubject: x\r\n\r\nbody")).kind).toBe("eml");
    expect(detectFormat("a.md", bytes("# Title")).mimeType).toBe("text/markdown");
    expect(detectFormat("a.png", Uint8Array.from([0x89, 0x50, 0x4e, 0x47])).kind).toBe("unsupported");
  });

  it("warns when a PDF signature has another extension", () => {
    const f = detectFormat("scan.jpg", bytes("%PDF-1.4"));
    expect(f.kind).toBe("pdf");
    expect(f.warning).toMatch(/does not match/);
  });
});

describe("date extraction", () => {
  it("recognises common English and French formats", () => {
    const text = "Brussels, 17 January 2025\nSee the letter of March 3, 2024, the note of 2024-11-05, the email of 1er mars 2023 and 25.12.2024.";
    const values = extractDateCandidates(text, 1, "C1").map((c) => c.value);
    expect(values).toEqual(["2025-01-17", "2024-03-03", "2024-11-05", "2023-03-01", "2024-12-25"]);
  });

  it("marks labelled dates and ambiguous numeric dates", () => {
    const [labelled, , ambiguous] = extractDateCandidates("Date: 20 January 2025\nmeeting on 26 November 2024\nreceived 03/04/2025", 1, null);
    expect(labelled).toMatchObject({ value: "2025-01-20", labelled: true, ambiguous: false });
    expect(ambiguous).toMatchObject({ value: "2025-04-03", ambiguous: true });
  });

  it("rejects impossible calendar dates", () => {
    expect(extractDateCandidates("31 February 2025 and 2025-13-01", null, null)).toEqual([]);
  });

  it("never reports machine-extracted dates as high confidence and never guesses", () => {
    expect(chooseDocumentDate(extractDateCandidates("Date: 20 January 2025", 1, null))).toMatchObject({ date: "2025-01-20", confidence: "medium" });
    expect(chooseDocumentDate(extractDateCandidates("final version, 30 September 2024", 1, null))).toMatchObject({ date: "2024-09-30", confidence: "low" });
    expect(chooseDocumentDate(extractDateCandidates("ref 03/04/2025", 1, null))).toMatchObject({ date: null, confidence: null });
    expect(chooseDocumentDate([])).toEqual({ date: null, confidence: null, basis: null });
  });

  it("derives an email's calendar date in the sender's UTC offset", () => {
    expect(parseHeaderOffset("Mon, 10 Feb 2025 00:30:00 +0100")).toBe(60);
    expect(parseHeaderOffset("Mon, 10 Feb 2025 00:30:00 -0530 (EST)")).toBe(-330);
    expect(parseHeaderOffset(null)).toBeNull();
    expect(calendarDate("2025-02-09T23:30:00Z", 60)).toBe("2025-02-10");
    expect(calendarDate("2025-02-09T23:30:00Z", null)).toBe("2025-02-09");
  });
});

describe("classification", () => {
  it("classifies by path (medium) before text (low), defaulting to unknown", () => {
    const rules = cfg.documentTypes;
    expect(classifyDocumentType({ relativePath: "x/2025_decision_final.pdf", openingText: "", isEmail: false, rules })).toMatchObject({ type: "official_decision", confidence: "medium" });
    expect(classifyDocumentType({ relativePath: "x/scan001.pdf", openingText: "The Appointing Authority HAS DECIDED as follows", isEmail: false, rules })).toMatchObject({ type: "official_decision", confidence: "low" });
    expect(classifyDocumentType({ relativePath: "x/scan002.pdf", openingText: "Lorem ipsum", isEmail: false, rules })).toEqual({ type: "unknown", confidence: null, basis: null });
    expect(classifyDocumentType({ relativePath: "x/a.msg", openingText: "", isEmail: true, rules }).type).toBe("email");
  });

  it("assigns matters from folders (high) and keywords (low)", () => {
    const matters = classifyMatters({ relativePath: "article24/scan.pdf", openingText: "concerning the internal audit service", rules: cfg.matters });
    expect(matters).toEqual([
      { matter: "article24", confidence: "high", basis: 'stored under folder "article24/"' },
      { matter: "audit", confidence: "low", basis: 'filename/opening text contains "internal audit service"' },
    ]);
    expect(classifyMatters({ relativePath: "misc/x.pdf", openingText: "nothing relevant", rules: cfg.matters })).toEqual([]);
  });

  it("ignores placeholder embedded titles", () => {
    expect(usableEmbeddedTitle("Microsoft Word - draft.docx")).toBeNull();
    expect(usableEmbeddedTitle("  ")).toBeNull();
    expect(usableEmbeddedTitle("Decision ART24-2025-0012")).toBe("Decision ART24-2025-0012");
  });
});
