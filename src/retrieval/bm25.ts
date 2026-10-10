/** Okapi BM25 over pre-tokenised documents. */
export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths: number[] = [];
  private avgLength = 0;

  constructor(docs: string[][], private readonly k1 = 1.2, private readonly b = 0.75) {
    docs.forEach((tokens, i) => {
      this.lengths[i] = tokens.length;
      for (const t of tokens) {
        let p = this.postings.get(t);
        if (!p) this.postings.set(t, (p = new Map()));
        p.set(i, (p.get(i) ?? 0) + 1);
      }
    });
    this.avgLength = this.lengths.reduce((s, l) => s + l, 0) / Math.max(1, this.lengths.length);
  }

  get size(): number {
    return this.lengths.length;
  }

  idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    return Math.log(1 + (this.size - df + 0.5) / (df + 0.5));
  }

  /** Scores for every document matching at least one query term. */
  score(queryTokens: string[], weights?: Map<string, number>): Map<number, number> {
    const scores = new Map<number, number>();
    for (const term of new Set(queryTokens)) {
      const postings = this.postings.get(term);
      if (!postings) continue;
      const idf = this.idf(term) * (weights?.get(term) ?? 1);
      for (const [doc, tf] of postings) {
        const norm = tf * (this.k1 + 1) / (tf + this.k1 * (1 - this.b + this.b * (this.lengths[doc]! / this.avgLength)));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * norm);
      }
    }
    return scores;
  }

  /** Document frequency, for diagnostics and query-term weighting. */
  df(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  vocabulary(): IterableIterator<string> {
    return this.postings.keys();
  }

  termFrequencies(doc: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const [term, p] of this.postings) {
      const tf = p.get(doc);
      if (tf) out.set(term, tf);
    }
    return out;
  }
}
