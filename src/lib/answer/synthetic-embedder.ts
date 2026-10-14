import type { Embedder } from "@/lib/answer/provider";

/**
 * OFFLINE DEMO EMBEDDER — NOT A SEMANTIC MODEL.
 *
 * This is a deterministic lexical hashing embedder. It exists only so the
 * retrieval pipeline (including the vector branch and rank fusion) can run
 * end-to-end when no embedding provider credential is configured.
 *
 * It has no semantic understanding: it matches surface tokens. It must never
 * be described as the configured embedding model, and it must never be used
 * when a real embedding provider is available. The providerId is deliberately
 * explicit so every response can report which embedder produced the vectors.
 */
export class SyntheticLexicalEmbedder implements Embedder {
  readonly providerId = "synthetic-lexical-v1";
  readonly dimensions: number;

  constructor(dimensions = 768) {
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      throw new Error("SyntheticLexicalEmbedder requires a positive integer dimension");
    }
    this.dimensions = dimensions;
  }

  /**
   * `EmbedPurpose` is accepted by callers but is meaningless here: a lexical
   * hashing embedder has no separate query/document mode. The parameter is
   * therefore omitted rather than accepted-and-ignored.
   */
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 1);

    for (const token of tokens) {
      const index = fnv1a(token) % this.dimensions;
      // Sublinear term weighting keeps long blocks from dominating.
      vector[index] += 1 + Math.log(1 + token.length);
    }

    return l2Normalize(vector);
  }
}

/** FNV-1a 32-bit hash. Deterministic across runs and platforms. */
function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export function l2Normalize(vector: number[]): number[] {
  let sumSquares = 0;
  for (const value of vector) sumSquares += value * value;
  const norm = Math.sqrt(sumSquares);
  if (norm === 0) return vector;
  return vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Embedding dimension mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
