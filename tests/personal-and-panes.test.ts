import { describe, expect, it } from "vitest";
import {
  MAX_BOOKMARKS,
  MAX_WATCH_STEP,
  addBookmark,
  addNote,
  emptyPersonalState,
  mergeRanges,
  parsePersonalState,
  personalStateSchema,
  progressBuckets,
  recordWatched,
  removeBookmark,
  removeNote,
  renameBookmark,
  updateNote,
  watchedFraction,
  watchedSeconds,
} from "@/lib/personal/local-store";
import {
  filterSegments,
  flowIntoParagraphs,
  segmentAt,
  selectTranscriptSegments,
  transcriptGaps,
} from "@/lib/presentation/transcript-view";
import { groupResourceBlocks } from "@/lib/presentation/resources";
import {
  buildLessonEntries,
  chooseContinueLesson,
  lessonHref,
} from "@/lib/presentation/continue-lesson";
import type { CourseSummary } from "@/lib/contracts/question";

const NOW = "2026-10-18T12:00:00.000Z";
const COURSE = "course_1";

function withBookmark(title = "Intro") {
  return addBookmark(emptyPersonalState(), {
    id: "bm_1",
    courseId: COURSE,
    seconds: 42,
    title,
    now: NOW,
  });
}

describe("personal storage", () => {
  it("reads back a document it wrote, unchanged", () => {
    const state = withBookmark();
    const parsed = parsePersonalState(JSON.stringify(state));
    expect(parsed).toEqual(state);
    expect(personalStateSchema.safeParse(parsed).success).toBe(true);
  });

  it("returns an empty state for malformed JSON, a wrong version or a non-object", () => {
    expect(parsePersonalState(null)).toEqual(emptyPersonalState());
    expect(parsePersonalState("{not json")).toEqual(emptyPersonalState());
    expect(parsePersonalState('{"version":99,"bookmarks":[],"notes":[],"progress":{}}')).toEqual(
      emptyPersonalState(),
    );
    expect(parsePersonalState("[]")).toEqual(emptyPersonalState());
  });

  it("keeps valid entries when one stored entry is corrupt", () => {
    const raw = JSON.stringify({
      version: 1,
      bookmarks: [
        { id: "ok", courseId: COURSE, seconds: 10, title: "Keeper", createdAt: NOW },
        { id: "", courseId: COURSE, seconds: -4, title: "", createdAt: NOW },
      ],
      notes: [],
      progress: {},
    });
    const parsed = parsePersonalState(raw);
    expect(parsed.bookmarks).toHaveLength(1);
    expect(parsed.bookmarks[0]?.title).toBe("Keeper");
  });

  it("trims a title and refuses an empty one", () => {
    const trimmed = addBookmark(emptyPersonalState(), {
      id: "bm_2",
      courseId: COURSE,
      seconds: 10.7,
      title: "   A place   ",
      now: NOW,
    });
    expect(trimmed.bookmarks[0]).toMatchObject({ title: "A place", seconds: 10 });

    const rejected = addBookmark(emptyPersonalState(), {
      id: "bm_3",
      courseId: COURSE,
      seconds: 10,
      title: "   ",
      now: NOW,
    });
    expect(rejected.bookmarks).toHaveLength(0);
  });

  it("caps stored bookmarks instead of growing without bound", () => {
    let state = emptyPersonalState();
    for (let index = 0; index < MAX_BOOKMARKS + 5; index += 1) {
      state = addBookmark(state, {
        id: `bm_${index}`,
        courseId: COURSE,
        seconds: index,
        title: `Bookmark ${index}`,
        now: NOW,
      });
    }
    expect(state.bookmarks).toHaveLength(MAX_BOOKMARKS);
    expect(state.bookmarks[0]?.title).toBe("Bookmark 5");
  });

  it("renames, edits and removes without touching sibling entries", () => {
    let state = addNote(withBookmark(), {
      id: "note_1",
      courseId: COURSE,
      seconds: 30,
      body: "  First thought  ",
      now: NOW,
    });
    state = addNote(state, {
      id: "note_2",
      courseId: COURSE,
      seconds: 60,
      body: "Second",
      now: NOW,
    });

    state = renameBookmark(state, "bm_1", "Renamed");
    expect(state.bookmarks[0]?.title).toBe("Renamed");

    state = updateNote(state, "note_1", "Revised", NOW);
    expect(state.notes.find((note) => note.id === "note_1")?.body).toBe("Revised");
    expect(state.notes.find((note) => note.id === "note_2")?.body).toBe("Second");

    state = removeNote(state, "note_1");
    expect(state.notes.map((note) => note.id)).toEqual(["note_2"]);

    state = removeBookmark(state, "bm_1");
    expect(state.bookmarks).toHaveLength(0);
  });
});

describe("watched progress", () => {
  function watchedOnce() {
    return recordWatched(emptyPersonalState(), {
      courseId: COURSE,
      fromSeconds: 10,
      toSeconds: 10.5,
      now: NOW,
    });
  }

  it("counts a continuous playback step", () => {
    const state = watchedOnce();
    expect(state.progress[COURSE]?.watched).toEqual([{ start: 10, end: 10.5 }]);
    expect(watchedSeconds(state.progress[COURSE]?.watched ?? [])).toBe(1);
  });

  it("does not count a seek as watching, but does move the resume point", () => {
    const state = recordWatched(emptyPersonalState(), {
      courseId: COURSE,
      fromSeconds: 5,
      toSeconds: 5 + MAX_WATCH_STEP + 0.1,
      now: NOW,
    });
    expect(state.progress[COURSE]?.watched).toEqual([]);
    expect(state.progress[COURSE]?.furthestSeconds).toBe(10);
  });

  it("ignores a backwards step", () => {
    const state = recordWatched(watchedOnce(), {
      courseId: COURSE,
      fromSeconds: 10.5,
      toSeconds: 4,
      now: NOW,
    });
    expect(state.progress[COURSE]?.watched).toEqual([{ start: 10, end: 10.5 }]);
  });

  it("merges a replay so the same passage never counts twice", () => {
    let state = recordWatched(emptyPersonalState(), {
      courseId: COURSE,
      fromSeconds: 0,
      toSeconds: 2,
      now: NOW,
    });
    state = recordWatched(state, {
      courseId: COURSE,
      fromSeconds: 2,
      toSeconds: 4,
      now: NOW,
    });
    state = recordWatched(state, {
      courseId: COURSE,
      fromSeconds: 1,
      toSeconds: 3,
      now: NOW,
    });
    expect(state.progress[COURSE]?.watched).toEqual([{ start: 0, end: 4 }]);
    expect(watchedSeconds(state.progress[COURSE]?.watched ?? [])).toBe(4);
  });

  it("returns the identical state when a report adds nothing", () => {
    const state = watchedOnce();
    const again = recordWatched(state, {
      courseId: COURSE,
      fromSeconds: 10.5,
      toSeconds: 10.5,
      now: NOW,
    });
    expect(again).toBe(state);
  });

  it("merges touching ranges and keeps them ordered", () => {
    expect(
      mergeRanges([
        { start: 30, end: 40 },
        { start: 0, end: 10 },
        { start: 9.9, end: 20 },
      ]),
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 40 },
    ]);
  });

  it("reports coverage from ranges, not from the furthest position", () => {
    const ranges = [{ start: 0, end: 30 }];
    expect(watchedFraction(ranges, 300)).toBeCloseTo(0.1, 5);
    expect(watchedFraction(ranges, 0)).toBe(0);
    // Ten buckets over 300s are 30s wide, so the first 30s fills exactly one.
    expect(progressBuckets(ranges, 300, 10)).toEqual([1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe("transcript pane", () => {
  const segments = [
    { id: "a", startSeconds: 10, endSeconds: 20, text: "Retries need jitter", sourceLabel: "Transcript 00:10–00:20" },
    { id: "b", startSeconds: 20, endSeconds: 40, text: "Backoff doubles", sourceLabel: "Transcript 00:20–00:40" },
    { id: "c", startSeconds: 60, endSeconds: 70, text: "The retry budget", sourceLabel: "Transcript 01:00–01:10" },
  ];

  it("marks a leading gap and a silence, and never a trailing one", () => {
    expect(transcriptGaps(segments, { minGapSeconds: 8 })).toEqual([
      { startSeconds: 0, endSeconds: 10 },
      { startSeconds: 40, endSeconds: 60 },
    ]);
  });

  it("finds a segment by the player's own clock, with a half-open end", () => {
    expect(segmentAt(segments, 10)?.id).toBe("a");
    expect(segmentAt(segments, 19.9)?.id).toBe("a");
    expect(segmentAt(segments, 20)?.id).toBe("b");
    expect(segmentAt(segments, 59)).toBeNull();
  });

  it("searches case-insensitively and returns everything for a blank query", () => {
    expect(filterSegments(segments, "RETRY").map((segment) => segment.id)).toEqual(["c"]);
    expect(filterSegments(segments, "retr").map((segment) => segment.id)).toEqual(["a", "c"]);
    expect(filterSegments(segments, "  ")).toHaveLength(3);
  });

  it("keeps only timestamped transcript blocks, in source order", () => {
    const picked = selectTranscriptSegments([
      { id: "late", blockType: "transcript", startSeconds: 40, endSeconds: 50, text: "Later", sourceLabel: "" },
      { id: "pdf", blockType: "pdf", startSeconds: null, endSeconds: null, text: "Page", sourceLabel: "" },
      { id: "early", blockType: "transcript", startSeconds: 0, endSeconds: 10, text: "Earlier", sourceLabel: "" },
      { id: "undated", blockType: "transcript", startSeconds: null, endSeconds: null, text: "No clock", sourceLabel: "" },
    ]);
    expect(picked.map((segment) => segment.id)).toEqual(["early", "late"]);
  });

  it("re-flows caption lines into paragraphs without changing a word", () => {
    const lines = ["one two three", "four five six", "seven eight nine"];
    const paragraphs = flowIntoParagraphs(lines, 40);
    expect(paragraphs).toEqual(["one two three four five six", "seven eight nine"]);
    expect(paragraphs.join(" ")).toBe(lines.join(" "));
  });

  it("uses the stored line breaks for a transcript block, and one paragraph otherwise", () => {
    const [withBreaks] = selectTranscriptSegments([
      {
        id: "t",
        blockType: "transcript",
        startSeconds: 0,
        endSeconds: 60,
        text: "First line second line",
        sourceLabel: "Transcript 00:00–01:00",
        textOriginal: "First line\nsecond line",
      },
    ]);
    expect(withBreaks?.paragraphs).toEqual(["First line second line"]);

    const [withoutBreaks] = selectTranscriptSegments([
      {
        id: "t2",
        blockType: "transcript",
        startSeconds: 0,
        endSeconds: 60,
        text: "Only collapsed text",
        sourceLabel: "Transcript 00:00–01:00",
      },
    ]);
    expect(withoutBreaks?.paragraphs).toEqual(["Only collapsed text"]);
  });
});

describe("resource viewer grouping", () => {
  it("groups blocks by page, slide and line range, then orders them", () => {
    const groups = groupResourceBlocks([
      { id: "p2", text: "second page", pageNumber: 2, slideNumber: null, lineStart: null, lineEnd: null, startSeconds: null, endSeconds: null },
      { id: "p1a", text: "first page, part one", pageNumber: 1, slideNumber: null, lineStart: null, lineEnd: null, startSeconds: null, endSeconds: null },
      { id: "p1b", text: "first page, part two", pageNumber: 1, slideNumber: null, lineStart: null, lineEnd: null, startSeconds: null, endSeconds: null },
      { id: "l", text: "code", pageNumber: null, slideNumber: null, lineStart: 12, lineEnd: 14, startSeconds: null, endSeconds: null },
    ]);

    expect(groups.map((group) => group.heading)).toEqual([
      "Page 1",
      "Page 2",
      "Lines 12–14",
    ]);
    expect(groups[0]?.blocks.map((block) => block.id)).toEqual(["p1a", "p1b"]);
  });
});

describe("home continue-lesson selection", () => {
  const recording: CourseSummary = {
    courseId: "083d7195-9371-5202-93dc-a724ad7982cc",
    title: "Don't learn AI Agents without Learning these Fundamentals — KodeKloud (lesson recording)",
    durationSeconds: 3399.2959,
    demoContent: false,
  };
  const sample: CourseSummary = {
    courseId: "83eafd47-15d8-50e0-9edc-ee6fb580cb83",
    title: "Sample Lesson — Retry and Backoff Strategies (synthetic demo)",
    durationSeconds: 900,
    demoContent: false,
  };

  it("names the recording by id and marks anything else as a synthetic sample", () => {
    const entries = buildLessonEntries([sample, recording], recording.courseId);
    expect(entries.map((entry) => entry.kind)).toEqual(["sample", "recording"]);
    expect(entries[0]?.synthetic).toBe(true);
    expect(entries[1]?.synthetic).toBe(false);
  });

  it("treats an unflagged course as real material, not as the fixture", () => {
    const real = { ...sample, title: "Week 4 — recursion", demoContent: false };
    const [entry] = buildLessonEntries([real], recording.courseId);
    expect(entry?.kind).toBe("sample");
    expect(entry?.synthetic).toBe(false);
  });

  it("offers the recording as a not-started choice when nothing has been watched", () => {
    const entries = buildLessonEntries([sample, recording], recording.courseId);
    const choice = chooseContinueLesson(entries, {});
    expect(choice?.entry.kind).toBe("recording");
    expect(choice?.started).toBe(false);
    expect(choice?.seconds).toBe(0);
    expect(lessonHref(choice!.entry)).toBe("/learn?lesson=recording");
  });

  it("follows the lesson with the most recent progress, not the first row", () => {
    const entries = buildLessonEntries([recording, sample], recording.courseId);
    const progress = {
      [sample.courseId]: {
        courseId: sample.courseId,
        furthestSeconds: 300,
        watched: [{ start: 240, end: 300 }],
        updatedAt: "2026-10-18T12:00:00.000Z",
      },
      [recording.courseId]: {
        courseId: recording.courseId,
        furthestSeconds: 1500,
        watched: [{ start: 1200, end: 1260 }],
        updatedAt: "2026-10-18T11:00:00.000Z",
      },
    };
    const choice = chooseContinueLesson(entries, progress);
    expect(choice?.entry.courseId).toBe(sample.courseId);
    expect(choice?.watched).toBe(60);
    expect(choice?.fraction).toBeCloseTo(60 / 900, 5);
    expect(lessonHref(choice!.entry, choice!.seconds)).toBe(
      `/learn?lesson=sample&start=300`,
    );
  });

  it("keeps a reached position separate from watched time", () => {
    const entries = buildLessonEntries([recording], recording.courseId);
    const choice = chooseContinueLesson(entries, {
      [recording.courseId]: {
        courseId: recording.courseId,
        furthestSeconds: 120,
        watched: [],
        updatedAt: "2026-10-18T12:00:00.000Z",
      },
    });
    // A seek is enough to offer the position again, and it is enough to call the
    // lesson started, but it must never become watched coverage: the two figures
    // are reported separately precisely so this case cannot inflate one with the
    // other.
    expect(choice?.started).toBe(true);
    expect(choice?.seconds).toBe(120);
    expect(choice?.watched).toBe(0);
    expect(choice?.fraction).toBe(0);
    expect(lessonHref(choice!.entry, choice!.seconds)).toBe(
      "/learn?lesson=recording&start=120",
    );
  });

  it("returns null rather than inventing a lesson for an empty catalogue", () => {
    expect(chooseContinueLesson([], {})).toBeNull();
  });
});
