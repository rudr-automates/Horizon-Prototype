import { describe, expect, it } from "vitest";
import { emptyPersonalState } from "@/lib/personal/local-store";
import { learnerMutationSchema, mergePersonalStates, personalStateFromRemote, stateDelta, syncPayloadsForDelta } from "@/lib/personal/remote-contract";

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

  it("creates one remote sync payload per newly changed bookmark and note", () => {
    const now = "2026-10-19T12:00:00.000Z";
    const local = {
      ...emptyPersonalState(),
      bookmarks: [{ id: "bm_1", courseId: "00000000-0000-4000-8000-000000000001", seconds: 10, title: "A moment", createdAt: now }],
      notes: [{ id: "note_1", courseId: "00000000-0000-4000-8000-000000000001", seconds: 10, body: "A note", updatedAt: now }],
    };
    const payloads = syncPayloadsForDelta(stateDelta(local, emptyPersonalState()));

    expect(payloads).toHaveLength(2);
    expect(payloads.filter((payload) => (payload.bookmarks as unknown[])?.length === 1)).toHaveLength(1);
    expect(payloads.filter((payload) => (payload.notes as unknown[])?.length === 1)).toHaveLength(1);
  });
});
