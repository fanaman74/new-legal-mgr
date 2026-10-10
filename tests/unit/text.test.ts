import { describe, expect, it } from "vitest";
import { Bm25Index } from "../../src/retrieval/bm25.js";
import { canonicalForQuote, hasNegation, keyFactTokens, splitSentences, stem, tokenize } from "../../src/retrieval/text.js";

describe("legal-aware tokenisation", () => {
  it("keeps references whole and in parts, and adds anchor and date tokens", () => {
    const t = tokenize("Ref.: ART24-2025-0012, Article 24 and Annex A.5, dated 17 January 2025");
    expect(t).toEqual(expect.arrayContaining(["referenc", "art24-2025-0012", "art24", "0012", "art:24", "annex:a5", "date:2025-01-17"]));
    expect(tokenize("on 2025-01-17")).toContain("date:2025-01-17");
    expect(tokenize("Article 90")).not.toContain("art:24");
  });

  it("stems inflected and derived forms consistently", () => {
    const same = (a: string, b: string) => expect(stem(a)).toBe(stem(b));
    same("attributed", "attribute");
    same("attribution", "attributes");
    same("responsibility", "responsible");
    same("certified", "certify");
    same("registered", "register");
    expect(stem("process")).toBe("process");
  });

  it("splits sentences without breaking on abbreviations", () => {
    const s = splitSentences("Dr. Thomas Weber examined her. Art. 24 applies; see p. 3.\n\nNew paragraph");
    expect(s.map((x) => x.text)).toEqual(["Dr. Thomas Weber examined her.", "Art. 24 applies;", "see p. 3.", "New paragraph"]);
  });

  it("detects negation and key facts, and canonicalises quotes", () => {
    expect(hasNegation("The report did not attribute any shortcoming")).toBe(true);
    expect(hasNegation("The request is rejected")).toBe(false);
    expect(keyFactTokens("registered on 20 January 2025 under R/123/25")).toEqual(expect.arrayContaining(["date:2025-01-20", "r-123-25"]));
    expect(canonicalForQuote("“The request,  is\nrejected”")).toBe(canonicalForQuote('"the request is rejected"'));
  });
});

describe("BM25", () => {
  it("ranks rarer matching terms higher", () => {
    const idx = new Bm25Index([tokenize("audit report findings"), tokenize("audit report"), tokenize("witness statement Rossi")]);
    const scores = idx.score(tokenize("Rossi statement"));
    expect([...scores.keys()]).toEqual([2]);
    expect(idx.idf("rossi")).toBeGreaterThan(idx.idf("audit"));
    expect(idx.df("audit")).toBe(2);
  });
});
