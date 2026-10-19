import { describe, expect, it } from "vitest";
import { emptyPersonalState } from "@/lib/personal/local-store";
import { learnerMutationSchema, mergePersonalStates, personalStateFromRemote, stateDelta } from "@/lib/personal/remote-contract";

describe("learner remote contract", () => {
  it("rejects malformed writes and limits progress range batches", () => {
    expect(learnerMutationSchema.safeParse({ type: "progress.merge", courseId: "not-a-uuid", furthestSeconds: 2, watched: [] }).success).toBe(false);
    expect(learnerMutationSchema.safeParse({ type: "profile.save", displayName: "x".repeat(81) }).success).toBe(false);
  });

  it("validates and normalizes server rows before merging local data", () => {
    const remote = personalStateFromRemote({
      bookmarks: [{ id: "bm_1", course_id: "00000000-0000-4000-8000-000000000001", position_seconds: 20, title: "Start", created_at: "2026-01-01T00:00:00.000Z" }],
      notes: [],
      progress: [{ course_id: "00000000-0000-4000-8000-000000000001", furthest_seconds: 30, watched_ranges: [{ start: 2, end: 8 }, { start: -1, end: 9 }], updated_at: "2026-01-01T00:00:00.000Z" }],
    });
    expect(remote.bookmarks).toHaveLength(1);
    expect(remote.progress["00000000-0000-4000-8000-000000000001"]?.watched).toEqual([{ start: 2, end: 8 }]);
    expect(mergePersonalStates(emptyPersonalState(), remote)).toEqual(remote);
    expect(stateDelta(remote, emptyPersonalState()).bookmarks).toHaveLength(1);
    expect(stateDelta(emptyPersonalState(), remote).deletedBookmarkIds).toEqual(["bm_1"]);
  });
});
