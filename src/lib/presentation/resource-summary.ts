import type { IngestStatus, LintStatus, Policy, ReviewState } from "@/lib/contracts/domain";
import { isBlockEligible } from "@/lib/eligibility/predicate";

/**
 * The course-materials list: one row per source, with two counts a learner has
 * to be able to trust — how many blocks are permitted at this position, and how
 * many are still waiting for review.
 *
 * WHY THIS IS A SEPARATE MODULE
 *   This count used to be computed inline in the route, with its own copy of the
 *   availability rule. That copy was wrong: it treated any approved COURSE_WIDE
 *   block as available and never checked `lint_status`, so a block the answer
 *   path would refuse to cite could be counted as available here. Two
 *   implementations of one rule diverge eventually; the fix is to have one.
 *
 *   Availability is decided by `isBlockEligible` — the same function the
 *   database-backed store applies after every query and the same rule the SQL
 *   functions in `0002_search_functions.sql` encode — so the library and the
 *   answer path cannot disagree. This module adds only presentation concerns:
 *   which block belongs to which source, and how to describe that source.
 */

export interface ResourceRow {
  id: string;
  kind: string | null;
  title: string | null;
  extraction_coverage: number | string | null;
  parser_version: string | null;
  default_policy: string | null;
}

export interface ResourceBlockRow {
  course_id: string;
  resource_id: string;
  policy: string;
  review_state: string;
  lint_status: string;
  ingest_status: string;
  unlock_seconds: number | string | null;
}

export interface ResourceSummary {
  id: string;
  kind: "video" | "transcript" | "pdf" | "ppt" | "notes" | "code";
  title: string;
  coverage: number | null;
  parser: string | null;
  policy: "COURSE_WIDE" | "TIMELINE_BOUND" | "MIXED";
  /** Every block the source has, whether or not it is available yet. */
  blocks: number;
  /** Blocks permitted at this position, by the canonical predicate. */
  eligibleNow: number;
  pendingReview: number;
  rejected: number;
}

const KINDS: ReadonlyArray<ResourceSummary["kind"]> = [
  "video",
  "transcript",
  "pdf",
  "ppt",
  "notes",
  "code",
];

function toKind(value: string | null): ResourceSummary["kind"] {
  return value !== null && (KINDS as ReadonlyArray<string>).includes(value)
    ? (value as ResourceSummary["kind"])
    : "notes";
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Convert a stored row into the predicate's input.
 *
 * Unlock time is kept as a number or null: the predicate treats null as "has no
 * unlock time" and refuses it, which is exactly the desired outcome for a
 * timeline-bound block with no alignment.
 */
function toPredicateBlock(row: ResourceBlockRow) {
  return {
    courseId: row.course_id,
    ingestStatus: row.ingest_status as IngestStatus,
    policy: row.policy as Policy,
    reviewState: row.review_state as ReviewState,
    lintStatus: row.lint_status as LintStatus,
    unlockSeconds: toNumber(row.unlock_seconds),
  };
}

export function summarizeResources(input: {
  courseId: string;
  boundarySeconds: number;
  resources: ResourceRow[];
  blocks: ResourceBlockRow[];
}): ResourceSummary[] {
  const { courseId, boundarySeconds, resources, blocks } = input;

  const byResource = new Map<string, ResourceBlockRow[]>();
  for (const block of blocks) {
    // A course scope guard, so a mismatched row can never inflate a count.
    if (block.course_id !== courseId) continue;
    const list = byResource.get(block.resource_id) ?? [];
    list.push(block);
    byResource.set(block.resource_id, list);
  }

  return resources.map((resource) => {
    const rows = byResource.get(resource.id) ?? [];
    const policies = new Set(rows.map((row) => row.policy));

    const eligibleNow = rows.filter((row) =>
      isBlockEligible(toPredicateBlock(row), { courseId, boundarySeconds }),
    ).length;

    return {
      id: resource.id,
      kind: toKind(resource.kind),
      title: resource.title ?? "Untitled resource",
      coverage: toNumber(resource.extraction_coverage),
      parser: resource.parser_version ? String(resource.parser_version) : null,
      // The rows are the truth, not the resource's default: a source declared
      // COURSE_WIDE whose blocks were all rewritten TIMELINE_BOUND must not still
      // be described as course-wide in the library.
      policy:
        policies.size === 0
          ? resource.default_policy === "COURSE_WIDE"
            ? "COURSE_WIDE"
            : "TIMELINE_BOUND"
          : policies.size > 1
            ? "MIXED"
            : (rows[0].policy as ResourceSummary["policy"]),
      blocks: rows.length,
      eligibleNow,
      pendingReview: rows.filter((row) => row.review_state === "PENDING").length,
      rejected: rows.filter((row) => row.review_state === "REJECTED").length,
    };
  });
}
