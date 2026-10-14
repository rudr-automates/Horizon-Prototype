import { describe, expect, it } from "vitest";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { DEMO_COURSE } from "@/lib/demo/lesson";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import {
  SupabaseEvidenceStore,
  type BlockRow,
  type SqlGateway,
} from "@/lib/retrieval/supabase-store";
import type { EvidenceBlock, RankedHit } from "@/lib/retrieval/types";

const COURSE = DEMO_COURSE.courseId;
const QUERY = "backoff constant jitter retry budget distribution";

const embedder = new SyntheticLexicalEmbedder(768);

function assertEligible(hits: RankedHit[], boundarySeconds: number): void {
  for (const hit of hits) {
    expect(
      isBlockEligible(
        {
          courseId: hit.block.courseId,
          ingestStatus: hit.block.ingestStatus,
          policy: hit.block.policy,
          reviewState: hit.block.reviewState,
          lintStatus: hit.block.lintStatus,
          unlockSeconds: hit.block.unlockSeconds,
        },
        { courseId: COURSE, boundarySeconds },
      ),
      `block ${hit.block.id} was returned but is not eligible at ${boundarySeconds}s`,
    ).toBe(true);

    if (hit.block.policy === "TIMELINE_BOUND") {
      expect(hit.block.unlockSeconds).not.toBeNull();
      expect(hit.block.unlockSeconds as number).toBeLessThanOrEqual(boundarySeconds);
    }
  }
}

describe("fixture store: both branches apply the same predicate", () => {
  const store = new FixtureEvidenceStore(embedder);

  it("returns only eligible blocks from both branches at every tested boundary", async () => {
    const [queryVector] = await embedder.embed([QUERY]);

    for (const boundarySeconds of [0, 60, 360, 578, 720, 900]) {
      const fts = await store.searchFullText(
        { courseId: COURSE, boundarySeconds },
        QUERY,
        20,
      );
      const vector = await store.searchVector(
        { courseId: COURSE, boundarySeconds },
        queryVector,
        20,
      );
      assertEligible(fts, boundarySeconds);
      assertEligible(vector, boundarySeconds);
    }
  });

  it("excludes the future-only canary blocks before their unlock time", async () => {
    const [queryVector] = await embedder.embed(["Marlin backoff constant"]);

    const earlyFts = await store.searchFullText(
      { courseId: COURSE, boundarySeconds: 360 },
      "Marlin backoff constant",
      20,
    );
    const earlyVector = await store.searchVector(
      { courseId: COURSE, boundarySeconds: 360 },
      queryVector,
      20,
    );
    const earlyIds = [...earlyFts, ...earlyVector].map((hit) => hit.block.id);
    expect(earlyIds).not.toContain("b_0013");
    expect(earlyIds).not.toContain("b_0014");
    expect(earlyIds).not.toContain("b_0016");
  });

  it("returns the canary transcript block once it is eligible", async () => {
    const laterFts = await store.searchFullText(
      { courseId: COURSE, boundarySeconds: 720 },
      "Marlin backoff constant",
      20,
    );
    expect(laterFts.map((hit) => hit.block.id)).toContain("b_0013");
  });

  it("never lists a PENDING or lint-FLAGGED block as eligible", async () => {
    const eligible = await store.listEligible({ courseId: COURSE, boundarySeconds: 900 }, 1000);
    const ids = eligible.map((block) => block.id);
    expect(ids).not.toContain("b_0010"); // review_state PENDING
    expect(ids).not.toContain("b_0011"); // COURSE_WIDE, lint FLAGGED
  });

  it("reports the ineligible diagnostic only as a boolean", async () => {
    const early = await store.hasMatchingIneligible({ courseId: COURSE, boundarySeconds: 360 }, "Marlin constant");
    const late = await store.hasMatchingIneligible({ courseId: COURSE, boundarySeconds: 900 }, "Marlin constant");
    expect(typeof early).toBe("boolean");
    expect(early).toBe(true);
    expect(late).toBe(false);
  });
});

describe("supabase store: filters ineligible rows returned by the database", () => {
  function row(overrides: Partial<BlockRow> & { id: string }): BlockRow {
    return {
      course_id: COURSE,
      resource_id: "res_transcript",
      block_type: "transcript",
      text_normalized: "text",
      start_seconds: 0,
      end_seconds: 30,
      page_number: null,
      slide_number: null,
      line_start: null,
      line_end: null,
      policy: "TIMELINE_BOUND",
      review_state: "AUTO_APPROVED",
      lint_status: "NA",
      ingest_status: "INDEXED",
      unlock_seconds: 0,
      resources: { kind: "transcript" },
      ...overrides,
    };
  }

  const rows: BlockRow[] = [
    row({ id: "good", unlock_seconds: 10 }),
    row({ id: "other", unlock_seconds: 10 }),
    row({ id: "still_future", unlock_seconds: 500 }),
    row({ id: "pending", unlock_seconds: 10, review_state: "PENDING" }),
    row({ id: "not_indexed", unlock_seconds: 10, ingest_status: "PROCESSING" }),
  ];

  const gateway: SqlGateway = {
    async rpc<T>(fn: string): Promise<T> {
      if (fn === "horizon_search_fts") {
        return [
          { block_id: "good", score: 0.2 },
          { block_id: "other", score: 0.9 },
          { block_id: "still_future", score: 0.95 },
          { block_id: "pending", score: 0.8 },
        ] as T;
      }
      if (fn === "horizon_search_vector") {
        return [
          { block_id: "good", distance: 0.1 },
          { block_id: "not_indexed", distance: 0.2 },
        ] as T;
      }
      if (fn === "horizon_has_matching_ineligible") return true as T;
      if (fn === "horizon_list_eligible") return [] as T;
      throw new Error(`unexpected rpc ${fn}`);
    },
    async selectBlocksByIds(ids: string[]): Promise<BlockRow[]> {
      return rows.filter((entry) => ids.includes(entry.id));
    },
    async selectCourse() {
      return null;
    },
    async selectCourses() {
      return [];
    },
  };

  const store = new SupabaseEvidenceStore(gateway);
  const boundary = { courseId: COURSE, boundarySeconds: 100 };

  it("drops ineligible rows from the full-text branch and keeps the SQL order", async () => {
    // The RPC deliberately returns a LOWER score (0.2) before a HIGHER one
    // (0.9), so a passing assertion proves the store preserves the database
    // order rather than re-sorting survivors by score.
    const hits = await store.searchFullText(boundary, "backoff", 10);
    expect(hits.map((hit) => hit.block.id)).toEqual(["good", "other"]);
  });

  it("drops ineligible rows from the vector branch", async () => {
    const hits = await store.searchVector(boundary, [0.1, 0.2], 10);
    expect(hits.map((hit) => hit.block.id)).toEqual(["good"]);
  });

  it("applies the eligibility predicate again in getBlocksByIds", async () => {
    const blocks: EvidenceBlock[] = await store.getBlocksByIds(boundary, [
      "good",
      "still_future",
    ]);
    expect(blocks.map((block) => block.id)).toEqual(["good"]);
  });

  it("reports the diagnostic from the database as-is", async () => {
    await expect(store.hasMatchingIneligible(boundary, "x")).resolves.toBe(true);
  });
});
