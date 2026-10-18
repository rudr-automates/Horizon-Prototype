/**
 * The registered late-only facts of the selected lesson.
 *
 * WHY A REGISTRY AND NOT A LITERAL PER CALL SITE
 *   Three different things need the same list: the temporal canary (which proves
 *   the fact is unreachable before its unlock time), the course-wide lint (which
 *   refuses to approve a document containing it), and any evaluation that reports
 *   on it. Three copies would drift, and the drift would be silent — the lint
 *   would keep passing a document the canary says leaks.
 *
 * WHERE THE VALUES COME FROM
 *   The recording's own automatic captions: the instructor states this threshold
 *   once, late in the lesson. `firstStatedAtSeconds` is the earliest timestamp of
 *   a stored block containing it, which is also where the transcript block
 *   unlocks.
 */
export const LESSON_LATE_MARKERS = ["compliance score", "75%"] as const;

/** Earliest moment in the recording where a late marker is spoken. */
export const LESSON_LATE_FACT_SECONDS = 2699;

/** A registered late-only fact: what it is and when it first appears. */
export interface LateFact {
  label: string;
  terms: string[];
  firstStatedAtSeconds: number;
}

export const LESSON_LATE_FACT: LateFact = {
  label: "the compliance-score threshold stated late in the lesson",
  terms: [...LESSON_LATE_MARKERS],
  firstStatedAtSeconds: LESSON_LATE_FACT_SECONDS,
};
