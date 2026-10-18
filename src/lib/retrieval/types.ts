import type {
  BlockType,
  IngestStatus,
  LintStatus,
  Policy,
  ReviewState,
} from "@/lib/contracts/domain";

export type ResourceKind = "video" | "transcript" | "pdf" | "ppt" | "notes" | "code";

export interface EvidenceBlock {
  id: string;
  courseId: string;
  resourceId: string;
  resourceKind: ResourceKind;
  blockType: BlockType;
  text: string;
  /**
   * Source line breaks for a transcript block, where the ingest preserved them.
   * A reading-pane affordance only: prompts and quotations use `text`.
   */
  textOriginal?: string | null;

  startSeconds: number | null;
  endSeconds: number | null;
  pageNumber: number | null;
  slideNumber: number | null;
  lineStart: number | null;
  lineEnd: number | null;

  policy: Policy;
  reviewState: ReviewState;
  lintStatus: LintStatus;
  ingestStatus: IngestStatus;
  unlockSeconds: number | null;

  /** Human-readable citation label, always derived server-side. */
  sourceLabel: string;
  embedding: number[] | null;
}

export interface EvidenceBoundary {
  courseId: string;
  boundarySeconds: number;
}

/** A candidate from one retrieval branch, already ordered by that branch. */
export interface RankedHit {
  block: EvidenceBlock;
  score: number;
}

export interface FusedEvidence {
  block: EvidenceBlock;
  ftsRank: number | null;
  vectorRank: number | null;
  fusedScore: number;
}

export interface CourseSummaryRecord {
  courseId: string;
  title: string;
  durationSeconds: number;
  demoContent: boolean;
}

/**
 * The evidence store. EVERY method that returns blocks must apply the
 * canonical eligibility predicate before ordering and limiting. Ineligible
 * blocks must never be returned from a search or listing path.
 */
export interface EvidenceStore {
  readonly mode: "supabase" | "fixture";
  readonly demoContent: boolean;

  getCourse(courseId: string): Promise<CourseSummaryRecord | null>;

  listCourses(): Promise<CourseSummaryRecord[]>;

  listEligible(boundary: EvidenceBoundary, limit: number): Promise<EvidenceBlock[]>;

  searchFullText(
    boundary: EvidenceBoundary,
    query: string,
    limit: number,
  ): Promise<RankedHit[]>;

  searchVector(
    boundary: EvidenceBoundary,
    embedding: number[],
    limit: number,
  ): Promise<RankedHit[]>;

  /**
   * Fetch blocks by id. The store filters to the course and still applies the
   * eligibility predicate; callers MUST re-assert eligibility as the final
   * payload guard even so.
   */
  getBlocksByIds(boundary: EvidenceBoundary, ids: string[]): Promise<EvidenceBlock[]>;

  /**
   * Backend-only diagnostic: does an INDEXED but currently INELIGIBLE block
   * match this query? Returns a boolean only, so nothing about the future
   * material can leak to a learner.
   */
  hasMatchingIneligible(boundary: EvidenceBoundary, query: string): Promise<boolean>;
}
