import type {
  IngestStatus,
  LintStatus,
  Policy,
  ReviewState,
} from "@/lib/contracts/domain";

/**
 * The canonical eligibility predicate (blueprint §9.1).
 *
 * A block is eligible at boundary B only when it belongs to the selected course,
 * is indexed, and satisfies exactly one of the two policy branches:
 *
 *   TIMELINE_BOUND: review_state IN (AUTO_APPROVED, HUMAN_APPROVED)
 *                   AND unlock_seconds IS NOT NULL
 *                   AND unlock_seconds <= B
 *   COURSE_WIDE:    review_state = HUMAN_APPROVED
 *                   AND lint_status IN (PASSED, ACKNOWLEDGED)
 *
 * This single predicate must be used by full-text retrieval, vector retrieval,
 * summary, quiz, answer generation, follow-ups and any evidence-based
 * recommendation. Do not re-implement it per call site.
 */
export interface BlockEligibility {
  courseId: string;
  ingestStatus: IngestStatus;
  policy: Policy;
  reviewState: ReviewState;
  lintStatus: LintStatus;
  unlockSeconds: number | null;
}

export interface EligibilityContext {
  courseId: string;
  boundarySeconds: number;
}

export function isBlockEligible(
  block: BlockEligibility,
  context: EligibilityContext,
): boolean {
  if (block.courseId !== context.courseId) return false;
  if (block.ingestStatus !== "INDEXED") return false;

  if (block.policy === "TIMELINE_BOUND") {
    if (block.unlockSeconds === null) return false;
    const approved =
      block.reviewState === "AUTO_APPROVED" ||
      block.reviewState === "HUMAN_APPROVED";
    if (!approved) return false;
    return block.unlockSeconds <= context.boundarySeconds;
  }

  // COURSE_WIDE
  return (
    block.reviewState === "HUMAN_APPROVED" &&
    (block.lintStatus === "PASSED" || block.lintStatus === "ACKNOWLEDGED")
  );
}

/**
 * The SQL twin of the predicate above, so both retrieval branches filter with
 * identical logic. Placeholders: $1 = course_id, $2 = boundary seconds.
 * The block table must be aliased as `b` (or pass the alias you use).
 */
export function canonicalEligibilitySql(blockAlias = "b"): string {
  return [
    `(${blockAlias}.course_id = $1)`,
    `AND (${blockAlias}.ingest_status = 'INDEXED')`,
    `AND (`,
    `  (${blockAlias}.policy = 'TIMELINE_BOUND'`,
    `    AND ${blockAlias}.review_state IN ('AUTO_APPROVED','HUMAN_APPROVED')`,
    `    AND ${blockAlias}.unlock_seconds IS NOT NULL`,
    `    AND ${blockAlias}.unlock_seconds <= $2)`,
    `  OR`,
    `  (${blockAlias}.policy = 'COURSE_WIDE'`,
    `    AND ${blockAlias}.review_state = 'HUMAN_APPROVED'`,
    `    AND ${blockAlias}.lint_status IN ('PASSED','ACKNOWLEDGED'))`,
    `)`,
  ].join(" ");
}
