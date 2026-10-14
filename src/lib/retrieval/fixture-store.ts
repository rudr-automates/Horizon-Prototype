import type { Embedder } from "@/lib/answer/provider";
import { cosineSimilarity } from "@/lib/answer/synthetic-embedder";
import { DEMO_BLOCKS, DEMO_COURSE, type DemoBlockSpec } from "@/lib/demo/lesson";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import { lexicalScore, queryTerms } from "@/lib/retrieval/lexical";
import { describeSource } from "@/lib/retrieval/source-label";
import type {
  CourseSummaryRecord,
  EvidenceBlock,
  EvidenceBoundary,
  EvidenceStore,
  RankedHit,
} from "@/lib/retrieval/types";

/**
 * In-memory evidence store for the synthetic demo corpus.
 *
 * This is SERVER-SIDE, not a front-end mock: it applies the same canonical
 * `isBlockEligible` predicate as the SQL path, and its searches only ever
 * consider eligible blocks. Its retrieval quality is a simple lexical scorer
 * plus cosine similarity, which is weaker than the Supabase full-text search —
 * that difference is reported, not hidden.
 */
export class FixtureEvidenceStore implements EvidenceStore {
  readonly mode = "fixture" as const;
  readonly demoContent = true;

  private readonly blocks: EvidenceBlock[];
  private docEmbeddings: Map<string, number[]> | null = null;

  constructor(
    private readonly embedder: Embedder,
    specs: DemoBlockSpec[] = DEMO_BLOCKS,
  ) {
    this.blocks = specs.map((spec) => ({
      id: spec.id,
      courseId: DEMO_COURSE.courseId,
      resourceId: spec.resourceId,
      resourceKind: spec.resourceKind,
      blockType: spec.blockType,
      text: spec.text,
      startSeconds: spec.startSeconds,
      endSeconds: spec.endSeconds,
      pageNumber: spec.pageNumber,
      slideNumber: spec.slideNumber,
      lineStart: spec.lineStart,
      lineEnd: spec.lineEnd,
      policy: spec.policy,
      reviewState: spec.reviewState,
      lintStatus: spec.lintStatus,
      ingestStatus: spec.ingestStatus,
      unlockSeconds: spec.unlockSeconds,
      sourceLabel: describeSource(spec),
      embedding: null,
    }));
  }

  private eligibleBlocks(boundary: EvidenceBoundary): EvidenceBlock[] {
    return this.blocks.filter((block) => this.isEligible(block, boundary));
  }

  private isEligible(block: EvidenceBlock, boundary: EvidenceBoundary): boolean {
    return isBlockEligible(
      {
        courseId: block.courseId,
        ingestStatus: block.ingestStatus,
        policy: block.policy,
        reviewState: block.reviewState,
        lintStatus: block.lintStatus,
        unlockSeconds: block.unlockSeconds,
      },
      { courseId: boundary.courseId, boundarySeconds: boundary.boundarySeconds },
    );
  }

  async getCourse(courseId: string): Promise<CourseSummaryRecord | null> {
    return courseId === DEMO_COURSE.courseId ? DEMO_COURSE : null;
  }

  async listCourses(): Promise<CourseSummaryRecord[]> {
    return [DEMO_COURSE];
  }

  async listEligible(boundary: EvidenceBoundary, limit: number): Promise<EvidenceBlock[]> {
    return this.eligibleBlocks(boundary)
      .sort((a, b) => {
        const left = a.unlockSeconds ?? -1;
        const right = b.unlockSeconds ?? -1;
        if (left !== right) return left - right;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      })
      .slice(0, Math.max(0, limit));
  }

  async searchFullText(
    boundary: EvidenceBoundary,
    query: string,
    limit: number,
  ): Promise<RankedHit[]> {
    const terms = queryTerms(query);
    if (terms.length === 0) return [];

    return this.eligibleBlocks(boundary)
      .map((block) => ({ block, score: lexicalScore(block.text, terms) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0;
      })
      .slice(0, Math.max(0, limit));
  }

  async searchVector(
    boundary: EvidenceBoundary,
    embedding: number[],
    limit: number,
  ): Promise<RankedHit[]> {
    const embeddings = await this.ensureDocEmbeddings();

    return this.eligibleBlocks(boundary)
      .map((block) => {
        const stored = embeddings.get(block.id);
        const score = stored ? cosineSimilarity(embedding, stored) : 0;
        return { block, score };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0;
      })
      .slice(0, Math.max(0, limit));
  }

  async getBlocksByIds(
    boundary: EvidenceBoundary,
    ids: string[],
  ): Promise<EvidenceBlock[]> {
    const wanted = new Set(ids);
    return this.eligibleBlocks(boundary).filter((block) => wanted.has(block.id));
  }

  async hasMatchingIneligible(
    boundary: EvidenceBoundary,
    query: string,
  ): Promise<boolean> {
    const terms = queryTerms(query);
    if (terms.length === 0) return false;

    return this.blocks.some((block) => {
      if (block.courseId !== boundary.courseId) return false;
      if (block.ingestStatus !== "INDEXED") return false;
      if (this.isEligible(block, boundary)) return false;
      return lexicalScore(block.text, terms) > 0;
    });
  }

  private async ensureDocEmbeddings(): Promise<Map<string, number[]>> {
    if (this.docEmbeddings) return this.docEmbeddings;

    const vectors = await this.embedder.embed(
      this.blocks.map((block) => block.text),
      "document",
    );
    const map = new Map<string, number[]>();
    this.blocks.forEach((block, index) => {
      const vector = vectors[index];
      if (vector) map.set(block.id, vector);
    });
    this.docEmbeddings = map;
    return map;
  }
}

/** Count of currently eligible blocks; used to build the scope chip. */
export async function countEligible(
  store: EvidenceStore,
  boundary: EvidenceBoundary,
): Promise<number> {
  const blocks = await store.listEligible(boundary, 1000);
  return blocks.length;
}
