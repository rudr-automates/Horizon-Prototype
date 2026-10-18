import { describe, expect, it } from "vitest";
import type { IngestStatus, LintStatus, Policy, ReviewState } from "@/lib/contracts/domain";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import {
  summarizeResources,
  type ResourceBlockRow,
  type ResourceRow,
} from "@/lib/presentation/resource-summary";

/**
 * The materials library used to answer "how much of this source is available?"
 * with its own copy of the availability rule. That copy omitted the lint check
 * for course-wide blocks, so a FLAGGED reference was counted as available while
 * the answer path would refuse to cite it.
 *
 * These cases pin the count to the canonical predicate: for every review, lint
 * and ingest combination below, the number the library reports must equal the
 * number of rows `isBlockEligible` admits. The regression case is explicit —
 * a course-wide block that is approved but flagged must count as zero.
 */

const COURSE_ID = "course-1";
const RESOURCE_ID = "resource-1";

function resource(overrides: Partial<ResourceRow> = {}): ResourceRow {
  return {
    id: RESOURCE_ID,
    kind: "pdf",
    title: "Study guide",
    extraction_coverage: "0.9",
    parser_version: "unpdf@1",
    default_policy: "TIMELINE_BOUND",
    ...overrides,
  };
}

function block(overrides: Partial<ResourceBlockRow> = {}): ResourceBlockRow {
  return {
    course_id: COURSE_ID,
    resource_id: RESOURCE_ID,
    policy: "TIMELINE_BOUND",
    review_state: "AUTO_APPROVED",
    lint_status: "NA",
    ingest_status: "INDEXED",
    unlock_seconds: 300,
    ...overrides,
  };
}

function summarize(blocks: ResourceBlockRow[], boundarySeconds = 300) {
  return summarizeResources({
    courseId: COURSE_ID,
    boundarySeconds,
    resources: [resource()],
    blocks,
  })[0];
}

function eligibleCount(blocks: ResourceBlockRow[], boundarySeconds = 300): number {
  return blocks.filter((row) =>
    isBlockEligible(
      {
        courseId: row.course_id,
        ingestStatus: row.ingest_status as IngestStatus,
        policy: row.policy as Policy,
        reviewState: row.review_state as ReviewState,
        lintStatus: row.lint_status as LintStatus,
        unlockSeconds: row.unlock_seconds === null ? null : Number(row.unlock_seconds),
      },
      { courseId: COURSE_ID, boundarySeconds },
    ),
  ).length;
}

describe("resource availability counts", () => {
  it("counts a timeline-bound block only once the recording has reached its end", () => {
    const rows = [block({ unlock_seconds: 600 })];

    expect(summarize(rows, 599).eligibleNow).toBe(0);
    expect(summarize(rows, 600).eligibleNow).toBe(1);
    expect(summarize(rows, 900).eligibleNow).toBe(1);
  });

  it("refuses a timeline-bound block with no unlock time, or one still pending or rejected", () => {
    const rows = [
      block({ unlock_seconds: null }),
      block({ review_state: "PENDING" }),
      block({ review_state: "REJECTED" }),
      block({ ingest_status: "FAILED" }),
    ];

    expect(summarize(rows).eligibleNow).toBe(0);
  });

  it("counts a course-wide reference once it is human-approved and its lint passed or was acknowledged", () => {
    const rows = [
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "PASSED", unlock_seconds: null }),
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "ACKNOWLEDGED", unlock_seconds: null }),
    ];

    expect(summarize(rows, 0).eligibleNow).toBe(2);
  });

  it("does not count a flagged, un-linted, auto-approved or unindexed course-wide block", () => {
    const rows = [
      // The regression: approved, available in the old count, refused by the
      // canonical predicate because its lint flagged it.
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "FLAGGED", unlock_seconds: null }),
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "NA", unlock_seconds: null }),
      block({ policy: "COURSE_WIDE", review_state: "AUTO_APPROVED", lint_status: "PASSED", unlock_seconds: null }),
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "PASSED", ingest_status: "PENDING", unlock_seconds: null }),
    ];

    for (const row of rows) {
      expect(summarize([row], 0).eligibleNow).toBe(0);
    }
  });

  it("agrees with the canonical predicate for every review, lint and ingest combination", () => {
    const policies: Policy[] = ["TIMELINE_BOUND", "COURSE_WIDE"];
    const reviews: ReviewState[] = ["PENDING", "AUTO_APPROVED", "HUMAN_APPROVED", "REJECTED"];
    const lints: LintStatus[] = ["NA", "PASSED", "FLAGGED", "ACKNOWLEDGED"];
    const ingests: IngestStatus[] = ["PENDING", "PROCESSING", "INDEXED", "FAILED"];
    const unlocks: Array<number | null> = [null, 0, 300, 900];

    const rows: ResourceBlockRow[] = [];
    for (const policy of policies) {
      for (const review_state of reviews) {
        for (const lint_status of lints) {
          for (const ingest_status of ingests) {
            for (const unlock_seconds of unlocks) {
              rows.push(
                block({ policy, review_state, lint_status, ingest_status, unlock_seconds }),
              );
            }
          }
        }
      }
    }

    for (const boundary of [0, 299, 300, 899, 900]) {
      expect(summarize(rows, boundary).eligibleNow).toBe(eligibleCount(rows, boundary));
    }
  });

  it("reports review state and totals without letting them change availability", () => {
    const rows = [
      block({ review_state: "PENDING" }),
      block({ review_state: "REJECTED" }),
      block({ review_state: "AUTO_APPROVED", unlock_seconds: 0 }),
    ];
    const summary = summarize(rows, 0);

    expect(summary.blocks).toBe(3);
    expect(summary.pendingReview).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.eligibleNow).toBe(1);
  });

  it("ignores a row that belongs to another course and keeps the resource's own policy label", () => {
    const rows = [
      block({ course_id: "other-course", unlock_seconds: 0 }),
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "PASSED", unlock_seconds: null }),
    ];
    const summary = summarize(rows, 0);

    expect(summary.blocks).toBe(1);
    expect(summary.eligibleNow).toBe(1);
    expect(summary.policy).toBe("COURSE_WIDE");
  });

  it("labels a mixed source as mixed even when its default policy says otherwise", () => {
    const rows = [
      block({ policy: "TIMELINE_BOUND" }),
      block({ policy: "COURSE_WIDE", review_state: "HUMAN_APPROVED", lint_status: "PASSED" }),
    ];
    const summary = summarizeResources({
      courseId: COURSE_ID,
      boundarySeconds: 0,
      resources: [resource({ default_policy: "COURSE_WIDE" })],
      blocks: rows,
    })[0];

    expect(summary.policy).toBe("MIXED");
  });

  it("parses numeric coverage and tolerates a source with no blocks", () => {
    const [summary] = summarizeResources({
      courseId: COURSE_ID,
      boundarySeconds: 0,
      resources: [resource({ extraction_coverage: "0.42", kind: "ppt" })],
      blocks: [],
    });

    expect(summary.coverage).toBe(0.42);
    expect(summary.kind).toBe("ppt");
    expect(summary.blocks).toBe(0);
    expect(summary.eligibleNow).toBe(0);
  });
});
