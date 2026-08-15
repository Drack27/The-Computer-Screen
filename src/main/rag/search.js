/* The search index.
 *
 * BM25 over the campaign, with no model and no download: it works the moment
 * the app opens, offline, and on a machine that will never run a neural net.
 * When a local model is present, its embeddings are layered on top and the two
 * rankings are fused — but retrieval never *depends* on that being there.
 */

const { tokenize } = require('./text');

const K1 = 1.2;   // term-frequency saturation
const B = 0.75;   // length normalisation

class SearchIndex {
  constructor(saved = null) {
    this.chunks = [];        // { id, kind, title, ref, text, length, terms }
    this.df = new Map();     // term → how many chunks contain it
    this.averageLength = 0;
    this.vectors = null;     // id → Float32Array, when embeddings exist
    this.builtAt = null;
    if (saved) this.#restore(saved);
  }

  get size() {
    return this.chunks.length;
  }

  /** Replace the whole index. Cheap enough to do on demand — a large campaign
   *  is a few thousand chunks, not a corpus. */
  build(documents) {
    this.chunks = [];
    this.df = new Map();

    for (const document of documents) {
      const terms = new Map();
      for (const token of tokenize(`${document.title} ${document.title} ${document.text}`)) {
        terms.set(token, (terms.get(token) || 0) + 1);
      }
      if (!terms.size) continue;

      this.chunks.push({
        id: document.id,
        kind: document.kind,
        title: document.title,
        ref: document.ref || null,
        text: document.text,
        length: [...terms.values()].reduce((sum, n) => sum + n, 0),
        terms,
      });

      for (const term of terms.keys()) this.df.set(term, (this.df.get(term) || 0) + 1);
    }

    this.averageLength = this.chunks.length
      ? this.chunks.reduce((sum, chunk) => sum + chunk.length, 0) / this.chunks.length
      : 0;
    this.builtAt = Date.now();
    this.vectors = null;
    return this.chunks.length;
  }

  /** Rank by BM25, then nudge with two signals a bare bag of words misses:
   *  an exact phrase appearing verbatim, and a hit in the chunk's title. */
  search(query, { limit = 8, kinds = null } = {}) {
    if (!this.chunks.length) return [];

    const queryTerms = tokenize(query);
    if (!queryTerms.length) return [];

    const total = this.chunks.length;
    const phrase = query.trim().toLowerCase();
    const usePhrase = phrase.length > 8;

    const scored = [];
    for (const chunk of this.chunks) {
      if (kinds && !kinds.includes(chunk.kind)) continue;

      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const frequency = chunk.terms.get(term);
        if (!frequency) continue;
        matched++;

        const documentFrequency = this.df.get(term) || 1;
        const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
        const norm = frequency * (K1 + 1)
          / (frequency + K1 * (1 - B + B * (chunk.length / (this.averageLength || 1))));
        score += idf * norm;
      }
      if (!score) continue;

      // Covering more of the question matters more than hammering one word.
      score *= 0.6 + 0.4 * (matched / queryTerms.length);

      if (usePhrase && chunk.text.toLowerCase().includes(phrase)) score *= 1.6;
      if (chunk.title.toLowerCase().includes(phrase)) score *= 1.3;

      scored.push({ chunk, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(entry => ({
      id: entry.chunk.id,
      kind: entry.chunk.kind,
      title: entry.chunk.title,
      ref: entry.chunk.ref,
      text: entry.chunk.text,
      score: entry.score,
    }));
  }

  // ── Optional dense layer ───────────────────────────────────────────────────

  setVectors(map) {
    this.vectors = map && map.size ? map : null;
  }

  get hasVectors() {
    return !!this.vectors;
  }

  /** Reciprocal rank fusion: combine the keyword and vector rankings without
   *  needing their scores to be on the same scale. */
  hybridSearch(query, queryVector, { limit = 8 } = {}) {
    const lexical = this.search(query, { limit: limit * 3 });
    if (!this.vectors || !queryVector) return lexical.slice(0, limit);

    const dense = [];
    for (const chunk of this.chunks) {
      const vector = this.vectors.get(chunk.id);
      if (!vector) continue;
      dense.push({ id: chunk.id, score: cosine(queryVector, vector) });
    }
    dense.sort((a, b) => b.score - a.score);

    const fused = new Map();
    const add = (id, rank, weight) => {
      fused.set(id, (fused.get(id) || 0) + weight / (60 + rank));
    };
    lexical.forEach((hit, rank) => add(hit.id, rank, 1));
    dense.slice(0, limit * 3).forEach((hit, rank) => add(hit.id, rank, 1));

    const byId = new Map(this.chunks.map(chunk => [chunk.id, chunk]));
    return [...fused.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => {
        const chunk = byId.get(id);
        return { id, kind: chunk.kind, title: chunk.title, ref: chunk.ref, text: chunk.text, score };
      });
  }

  // ── Persistence ────────────────────────────────────────────────────────────

  toJSON() {
    return {
      version: 1,
      builtAt: this.builtAt,
      averageLength: this.averageLength,
      chunks: this.chunks.map(chunk => ({
        id: chunk.id,
        kind: chunk.kind,
        title: chunk.title,
        ref: chunk.ref,
        text: chunk.text,
        length: chunk.length,
        terms: Object.fromEntries(chunk.terms),
      })),
      df: Object.fromEntries(this.df),
      vectors: this.vectors ? Object.fromEntries([...this.vectors].map(([id, v]) => [id, Array.from(v)])) : null,
    };
  }

  #restore(saved) {
    if (!saved || saved.version !== 1) return;
    this.chunks = (saved.chunks || []).map(chunk => ({
      ...chunk,
      terms: new Map(Object.entries(chunk.terms || {})),
    }));
    this.df = new Map(Object.entries(saved.df || {}));
    this.averageLength = saved.averageLength || 0;
    this.builtAt = saved.builtAt || null;
    this.vectors = saved.vectors
      ? new Map(Object.entries(saved.vectors).map(([id, v]) => [id, Float32Array.from(v)]))
      : null;
  }
}

function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

module.exports = { SearchIndex };
