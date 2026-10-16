import { describe, expect, it } from "vitest";
import { DEMO_COURSE } from "@/lib/demo/lesson";
import { SeedRefused, stableUuid } from "@/lib/ingest/seed";
import {
  LESSON_TRANSCRIPT_COURSE_KEY,
  buildLessonTranscriptPlan,
  lessonTranscriptBlockId,
  lessonTranscriptCourseId,
  lessonTranscriptResourceId,
  type LessonTranscriptPlanInput,
} from "@/lib/ingest/lesson-transcript";
import type { SegmentOptions } from "@/lib/lesson/transcript";
import { segmentTranscript } from "@/lib/lesson/transcript";
import { LESSON_VIDEO } from "@/lib/lesson/video";

/**
 * The video transcript's database shape.
 *
 * These tests exist for two claims the submission rests on and that nothing else
 * checks: the video's evidence is a SEPARATE course from the synthetic fixture,
 * and every timestamp written is one the caption source actually reported.
 */

const DURATION = 600;

/** Three contiguous 60s blocks, built by the real segmenter from real-shaped input. */
function plan(overrides: Partial<LessonTranscriptPlanInput> = {}) {
  const lines = Array.from({ length: 90 }, (_, index) => ({
    startSeconds: index * 2,
    endSeconds: (index + 1) * 2,
    text: `caption line ${index}`,
  }));
  const options: SegmentOptions = {
    targetSeconds: 60,
    maxSeconds: 90,
    gapSeconds: 12,
    minSeconds: 20,
  };
  const blocks = segmentTranscript(lines, options);
  const vectors = blocks.map(() => Array.from({ length: 768 }, () => 0.01));

  return buildLessonTranscriptPlan({
    blocks,
    stats: {
      lineCount: lines.length,
      blockCount: blocks.length,
      firstSeconds: 0,
      lastSeconds: 180,
      coverage: 0.3,
      skippedEvents: 0,
    },
    vectors,
    embeddingDimensions: 768,
    embeddingModel: "gemini-embedding-001",
    videoDurationSeconds: DURATION,
    captionSourceId: "sha256-of-caption-file",
    embedderProviderId: "google-genai",
    ...overrides,
  });
}

describe("the video transcript's course", () => {
  it("is derived from the video id, so it is the same on every run", () => {
    expect(lessonTranscriptCourseId()).toBe(lessonTranscriptCourseId());
    expect(lessonTranscriptCourseId()).toBe(stableUuid(LESSON_TRANSCRIPT_COURSE_KEY));
    expect(lessonTranscriptCourseId()).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("can never collide with the synthetic fixture's course", () => {
    // The fixture maps its own id through the same helper, so this is a real
    // separation check rather than a string comparison of two constants.
    expect(lessonTranscriptCourseId()).not.toBe(stableUuid(`course:${DEMO_COURSE.courseId}`));
  });

  it("names the recording rather than the sample lesson", () => {
    const built = plan();
    expect(String(built.course.title)).toContain(LESSON_VIDEO.title);
    expect(String(built.course.title)).not.toContain("synthetic");
    expect(String(built.course.description)).toContain(LESSON_VIDEO.youtubeId);
  });

  it("records the caption track as its resource, at the coverage that was parsed", () => {
    const built = plan();
    expect(built.resources).toHaveLength(1);
    const resource = built.resources[0];
    expect(resource.kind).toBe("transcript");
    expect(resource.id).toBe(lessonTranscriptResourceId());
    expect(resource.course_id).toBe(lessonTranscriptCourseId());
    expect(resource.extraction_coverage).toBe(0.3);
    expect(resource.parser_version).toBe("youtube-json3-v1");
  });
});

describe("the written blocks", () => {
  it("carry the transcript's own timestamps and unlock when watched to the end", () => {
    const built = plan();
    expect(built.blocks.length).toBeGreaterThan(1);

    for (const block of built.blocks) {
      expect(Number(block.start_seconds)).toBeLessThan(Number(block.end_seconds));
      // Eligibility is keyed on the END, so no citation can reach past the
      // learner's playhead. Changing this silently would leak future material.
      expect(block.unlock_seconds).toBe(block.end_seconds);
      expect(block.policy).toBe("TIMELINE_BOUND");
      expect(block.review_state).toBe("AUTO_APPROVED");
      expect(block.alignment_method).toBe("asr_caption_timestamps");
    }
  });

  it("keeps the caption lines in text_original and a single-spaced copy for matching", () => {
    const built = plan();
    const text = String(built.blocks[0].text_original);
    expect(text).toContain("\n");
    expect(String(built.blocks[0].text_normalized)).not.toContain("\n");
  });

  it("gives every block a deterministic id, so a re-run updates instead of duplicating", () => {
    const built = plan();
    expect(built.blocks[0].id).toBe(lessonTranscriptBlockId(0));
    expect(built.blocks[1].id).toBe(lessonTranscriptBlockId(1));
    expect(new Set(built.blocks.map((block) => String(block.id))).size).toBe(
      built.blocks.length,
    );
  });

  it("writes the vector, its model and its dimension together", () => {
    const built = plan();
    const block = built.blocks[0];
    expect(block.embedding_model).toBe("gemini-embedding-001");
    expect(block.embedding_dim).toBe(768);
    expect(String(block.embedding).split(",").length).toBe(768);
  });
});

describe("what the ingest refuses", () => {
  it("refuses a lexical stand-in labelled as an embedding model", () => {
    expect(() => plan({ embedderProviderId: "synthetic-lexical-v1" })).toThrow(SeedRefused);
  });

  it("refuses a vector count that does not match the blocks", () => {
    expect(() => plan({ vectors: [] })).toThrow(/12|Got 0 vectors/);
  });

  it("refuses a vector of the wrong dimension", () => {
    const built = plan();
    const wrong = built.blocks.map(() => Array.from({ length: 512 }, () => 0.01));
    expect(() => plan({ vectors: wrong })).toThrow(/512 values/);
  });

  it("refuses blocks that overlap, so no timestamp could be double-counted", () => {
    expect(() =>
      plan({
        blocks: [
          { startSeconds: 0, endSeconds: 60, text: "one", lineTexts: ["one"], firstLineIndex: 0 },
          { startSeconds: 30, endSeconds: 90, text: "two", lineTexts: ["two"], firstLineIndex: 3 },
        ],
        vectors: [
          Array.from({ length: 768 }, () => 0.01),
          Array.from({ length: 768 }, () => 0.01),
        ],
      }),
    ).toThrow(/before the previous block ended/);
  });

  it("refuses a block that runs past the recording's measured duration", () => {
    expect(() =>
      plan({
        blocks: [
          { startSeconds: 0, endSeconds: DURATION + 60, text: "one", lineTexts: ["one"], firstLineIndex: 0 },
        ],
        vectors: [Array.from({ length: 768 }, () => 0.01)],
      }),
    ).toThrow(/past the recording/);
  });

  it("refuses when the video's duration was never measured", () => {
    expect(() => plan({ videoDurationSeconds: 0 })).toThrow(/duration was not measured/);
  });
});
