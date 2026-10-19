import { describe, expect, it } from "vitest";
import { learnerDashboardModel } from "@/lib/personal/dashboard";

const recordingId = "00000000-0000-4000-8000-000000000001";
const sampleId = "00000000-0000-4000-8000-000000000002";

describe("learner dashboard model", () => {
  it("uses the real catalogue and owner progress to resume without counting seeks as watched", () => {
    const model = learnerDashboardModel([
      { courseId: recordingId, title: "Recorded lesson", durationSeconds: 3600, demoContent: false },
      { courseId: sampleId, title: "Synthetic sample", durationSeconds: 900, demoContent: true },
    ], recordingId, [{
      course_id: recordingId,
      furthest_seconds: 1500,
      watched_ranges: [{ start: 0, end: 120 }],
      updated_at: "2026-10-19T12:00:00.000Z",
    }]);

    expect(model.entries).toHaveLength(2);
    expect(model.entries[1]?.synthetic).toBe(true);
    expect(model.coursesWithProgress).toBe(1);
    expect(model.continueChoice?.entry.courseId).toBe(recordingId);
    expect(model.continueChoice?.seconds).toBe(1500);
    expect(model.continueChoice?.watched).toBe(120);
  });

  it("keeps an empty catalogue empty instead of inventing a resume course", () => {
    const model = learnerDashboardModel([], recordingId, []);
    expect(model.entries).toEqual([]);
    expect(model.continueChoice).toBeNull();
    expect(model.coursesWithProgress).toBe(0);
  });
});
