import { describe, expect, it } from "vitest";
import {
  canonicalEligibilitySql,
  isBlockEligible,
  type BlockEligibility,
} from "@/lib/eligibility/predicate";

const COURSE = "course_1";
const ctx = { courseId: COURSE, boundarySeconds: 360 };

function block(overrides: Partial<BlockEligibility> = {}): BlockEligibility {
  return {
    courseId: COURSE,
    ingestStatus: "INDEXED",
    policy: "TIMELINE_BOUND",
    reviewState: "AUTO_APPROVED",
    lintStatus: "NA",
    unlockSeconds: 300,
    ...overrides,
  };
}

describe("isBlockEligible", () => {
  it("accepts an approved timeline-bound block at or before the boundary", () => {
    expect(isBlockEligible(block({ unlockSeconds: 360 }), ctx)).toBe(true);
    expect(isBlockEligible(block({ unlockSeconds: 10 }), ctx)).toBe(true);
  });

  it("rejects a timeline-bound block that unlocks after the boundary", () => {
    expect(isBlockEligible(block({ unlockSeconds: 361 }), ctx)).toBe(false);
  });

  it("rejects timeline-bound blocks with no unlock time", () => {
    expect(isBlockEligible(block({ unlockSeconds: null }), ctx)).toBe(false);
  });

  it("rejects pending or rejected timeline-bound blocks", () => {
    expect(isBlockEligible(block({ reviewState: "PENDING" }), ctx)).toBe(false);
    expect(isBlockEligible(block({ reviewState: "REJECTED" }), ctx)).toBe(false);
  });

  it("accepts only human-approved, lint-passed course-wide blocks", () => {
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "HUMAN_APPROVED",
          lintStatus: "PASSED",
          unlockSeconds: null,
        }),
        ctx,
      ),
    ).toBe(true);
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "HUMAN_APPROVED",
          lintStatus: "ACKNOWLEDGED",
          unlockSeconds: null,
        }),
        ctx,
      ),
    ).toBe(true);
  });

  it("rejects course-wide blocks that are flagged, lint-NA, or not human-approved", () => {
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "HUMAN_APPROVED",
          lintStatus: "FLAGGED",
          unlockSeconds: null,
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "HUMAN_APPROVED",
          lintStatus: "NA",
          unlockSeconds: null,
        }),
        ctx,
      ),
    ).toBe(false);
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "AUTO_APPROVED",
          lintStatus: "PASSED",
          unlockSeconds: null,
        }),
        ctx,
      ),
    ).toBe(false);
  });

  it("ignores course-wide unlock times entirely (policy is what matters)", () => {
    expect(
      isBlockEligible(
        block({
          policy: "COURSE_WIDE",
          reviewState: "HUMAN_APPROVED",
          lintStatus: "PASSED",
          unlockSeconds: 9999,
        }),
        ctx,
      ),
    ).toBe(true);
  });

  it("rejects blocks that are not indexed", () => {
    expect(
      isBlockEligible(block({ ingestStatus: "PROCESSING" }), ctx),
    ).toBe(false);
    expect(isBlockEligible(block({ ingestStatus: "FAILED" }), ctx)).toBe(false);
  });

  it("rejects blocks from another course", () => {
    expect(
      isBlockEligible(block({ courseId: "course_other" }), ctx),
    ).toBe(false);
  });
});

describe("canonicalEligibilitySql", () => {
  it("expresses both policy branches with the expected placeholders", () => {
    const sql = canonicalEligibilitySql("b");
    expect(sql).toContain("b.course_id = $1");
    expect(sql).toContain("b.ingest_status = 'INDEXED'");
    expect(sql).toContain("b.unlock_seconds <= $2");
    expect(sql).toContain("b.lint_status IN ('PASSED','ACKNOWLEDGED')");
  });

  it("honours a custom block alias", () => {
    expect(canonicalEligibilitySql("blocks")).toContain("blocks.course_id = $1");
  });
});
