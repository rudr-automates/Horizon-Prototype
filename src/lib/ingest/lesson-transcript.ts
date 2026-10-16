/**
 * Ingestion of the selected lesson video's real captions.
 *
 * WHY A SEPARATE COURSE
 *   The synthetic sample corpus (`@/lib/demo/lesson`) exists to demonstrate the
 *   eligibility and citation flow with a deliberately invented fact. The
 *   transcript of the real recording is evidence of a different kind, and mixing
 *   the two into one course would make every citation ambiguous about which
 *   lesson it came from. They are therefore two courses, and the interface shows
 *   the video's own course as the lesson.
 *
 * WHAT IS WRITTEN, AND WHAT IS NOT
 *   Written: one `courses` row, one `resources` row naming the caption track, and
 *   one `blocks` row per transcript block — each with the timestamp YouTube
 *   reported, the words YouTube emitted, and a vector from the configured
 *   embedding model.
 *   Not written: any cleaned-up, summarised or "improved" wording. The ASR's own
 *   errors are kept and labelled, because an edited transcript would be a
 *   different text from the recording and would make every quotation unattributable.
 *
 * STATUS: EXECUTED AGAINST THE LIVE DATABASE (see docs/EVALUATION.md Part 09).
 */

import { createHash } from "node:crypto";
import type { TranscriptBlock, TranscriptStats } from "@/lib/lesson/transcript";
import { LESSON_VIDEO } from "@/lib/lesson/video";
import {
  SeedRefused,
  contentHash,
  stableUuid,
  toVectorLiteral,
  type SeedPlan,
  type SeedTable,
} from "@/lib/ingest/seed";

/**
 * Stable identity of the video's course.
 *
 * Derived from the video id rather than generated, so the page, the ingest
 * command and any re-run all agree on one id without a lookup table and without
 * a second course ever being created by a repeated ingest.
 */
export const LESSON_TRANSCRIPT_COURSE_KEY = `lesson:${LESSON_VIDEO.youtubeId}`;
export const LESSON_TRANSCRIPT_RESOURCE_KEY = `lesson:${LESSON_VIDEO.youtubeId}:captions`;

export function lessonTranscriptCourseId(): string {
  return stableUuid(LESSON_TRANSCRIPT_COURSE_KEY);
}

export function lessonTranscriptResourceId(): string {
  return stableUuid(LESSON_TRANSCRIPT_RESOURCE_KEY);
}

export function lessonTranscriptBlockId(index: number): string {
  return stableUuid(`lesson-block:${LESSON_VIDEO.youtubeId}:${index}`);
}

/** Parser identity recorded on the resource, so a re-parse is traceable. */
export const LESSON_TRANSCRIPT_PARSER_VERSION = "youtube-json3-v1";

/** Provider ids that are not real embedding models and may never be persisted. */
const NON_SEMANTIC_EMBEDDER_PREFIXES = ["synthetic"];

export interface LessonTranscriptPlanInput {
  blocks: TranscriptBlock[];
  stats: TranscriptStats;
  /** One vector per block, in block order. */
  vectors: number[][];
  /** Dimension the vectors were produced at. */
  embeddingDimensions: number;
  embeddingModel: string;
  /** Measured with ffprobe on the local file; never taken from a listing. */
  videoDurationSeconds: number;
  /** Names the caption artefact the blocks were parsed from. */
  captionSourceId: string;
  /** Reported by the active embedder so a placeholder cannot be persisted. */
  embedderProviderId: string;
}

/**
 * Build every row the video's transcript needs. Pure: it embeds nothing, so the
 * database shape can be tested without a provider call.
 */
export function buildLessonTranscriptPlan(
  input: LessonTranscriptPlanInput,
): SeedPlan {
  const {
    blocks,
    stats,
    vectors,
    embeddingDimensions,
    embeddingModel,
    videoDurationSeconds,
    captionSourceId,
    embedderProviderId,
  } = input;

  if (blocks.length === 0) {
    throw new SeedRefused("The transcript produced no blocks, so there is nothing to ingest.");
  }

  const providerId = embedderProviderId.toLowerCase();
  if (NON_SEMANTIC_EMBEDDER_PREFIXES.some((prefix) => providerId.startsWith(prefix))) {
    throw new SeedRefused(
      `Refusing to ingest: the active embedder is "${embedderProviderId}", which is a lexical placeholder, not a semantic model. ` +
        "Writing its vectors into blocks.embedding would label them as real semantic embeddings.",
    );
  }

  if (vectors.length !== blocks.length) {
    throw new SeedRefused(
      `Got ${vectors.length} vectors for ${blocks.length} transcript blocks.`,
    );
  }

  if (videoDurationSeconds <= 0) {
    throw new SeedRefused(
      "The video's duration was not measured, so a playhead could not be validated against it.",
    );
  }

  // Ordering and coverage are what make a timestamped citation meaningful, so
  // they are asserted here rather than trusted from the caller.
  let previousEnd = 0;
  for (const [index, block] of blocks.entries()) {
    if (block.endSeconds <= block.startSeconds) {
      throw new SeedRefused(
        `Transcript block ${index} spans ${block.startSeconds}–${block.endSeconds}s, which is not a positive interval.`,
      );
    }
    if (block.startSeconds < previousEnd - 0.001) {
      throw new SeedRefused(
        `Transcript block ${index} starts at ${block.startSeconds}s, before the previous block ended at ${previousEnd}s.`,
      );
    }
    if (block.endSeconds > videoDurationSeconds + 1) {
      throw new SeedRefused(
        `Transcript block ${index} ends at ${block.endSeconds}s, past the recording's ${videoDurationSeconds}s.`,
      );
    }
    previousEnd = block.endSeconds;
  }

  const courseId = lessonTranscriptCourseId();
  const resourceId = lessonTranscriptResourceId();

  // One hash over every line, so two caption files that differ anywhere produce
  // different resources instead of silently colliding on `(course_id, source_hash)`.
  const transcriptHash = contentHash(
    `${captionSourceId}:${blocks.map((block) => `${block.startSeconds}|${block.text}`).join("\n")}`,
  );

  const course: Record<string, unknown> = {
    id: courseId,
    owner_id: null,
    title: `${LESSON_VIDEO.title} — ${LESSON_VIDEO.author} (lesson recording)`,
    description:
      `Timestamped evidence from ${LESSON_VIDEO.author}'s recording (https://youtu.be/${LESSON_VIDEO.youtubeId}). ` +
      "The text is YouTube's automatically generated English caption track, ingested verbatim: " +
      "machine transcription, so wording can be wrong even though it is unedited.",
    duration_seconds: videoDurationSeconds,
    content_version: "v1",
    policy_version: "v1",
    visibility: "public",
  };

  const resource: Record<string, unknown> = {
    id: resourceId,
    course_id: courseId,
    kind: "transcript",
    title: `Auto-generated English captions (ASR) — ${LESSON_VIDEO.youtubeId}`,
    storage_key: null,
    source_hash: transcriptHash,
    parser_version: LESSON_TRANSCRIPT_PARSER_VERSION,
    ingest_status: "INDEXED",
    // The fraction of the recording a caption line covers. Computed from the
    // caption track itself, so a partly captioned video cannot be reported as
    // fully indexed.
    extraction_coverage: Number(stats.coverage.toFixed(4)),
    default_policy: "TIMELINE_BOUND",
  };

  const blockRows: Record<string, unknown>[] = blocks.map((block, index) => {
    const vector = vectors[index];
    if (!vector || vector.length !== embeddingDimensions) {
      throw new SeedRefused(
        `Transcript block ${index} produced a vector of ${vector ? vector.length : 0} values, not the configured ${embeddingDimensions}.`,
      );
    }
    if (block.text.trim() === "") {
      throw new SeedRefused(`Transcript block ${index} has no text to cite.`);
    }

    return {
      id: lessonTranscriptBlockId(index),
      course_id: courseId,
      resource_id: resourceId,
      block_type: "transcript",
      ordinal: index,
      // The caption lines, kept as lines: this is the version that shows the
      // breaks the source produced.
      text_original: block.lineTexts.join("\n"),
      // What retrieval and quotation matching use. Whitespace collapsed only.
      text_normalized: block.text,
      start_seconds: Number(block.startSeconds.toFixed(3)),
      end_seconds: Number(block.endSeconds.toFixed(3)),
      page_number: null,
      slide_number: null,
      line_start: block.firstLineIndex,
      line_end: block.firstLineIndex + block.lineTexts.length - 1,
      frame_seconds: null,
      policy: "TIMELINE_BOUND",
      // AUTO_APPROVED is the honest state for machine-produced text: no human has
      // reviewed it, and it is indexed on that basis.
      review_state: "AUTO_APPROVED",
      lint_status: "NA",
      ingest_status: "INDEXED",
      /**
       * A block becomes eligible only once the learner has watched ALL of it.
       * Using the end rather than the start is the conservative choice: a block
       * that unlocks at its start time would hand a learner material from a part
       * of the recording their playhead has not yet reached, which is precisely
       * the leak this project exists to prevent.
       */
      unlock_seconds: Number(block.endSeconds.toFixed(3)),
      // These ARE the source's own timings, so this is a fact, not an estimate.
      alignment_method: "asr_caption_timestamps",
      alignment_confidence: null,
      alignment_margin: null,
      policy_version: "v1",
      content_version: "v1",
      source_hash: contentHash(block.text),
      embedding: toVectorLiteral(vector),
      embedding_model: embeddingModel,
      embedding_dim: vector.length,
      // `fts` is a generated column and must never be sent.
    };
  });

  return {
    course,
    resources: [resource],
    blocks: blockRows,
    provenance: {
      embeddingModel,
      embeddingDimensions,
      blockCount: blockRows.length,
      resourceCount: 1,
      idMap: {
        "course:lesson": courseId,
        "resource:captions": resourceId,
        ...Object.fromEntries(
          blocks.map((_, index) => [`block:${index}`, lessonTranscriptBlockId(index)]),
        ),
      },
    },
  };
}

/**
 * Idempotent apply through the existing seed gateway.
 *
 * The gateway type is re-declared rather than imported so this module keeps
 * working if the seed gateway gains a method it does not use.
 */
export interface TranscriptSeedGateway {
  upsert(table: SeedTable, rows: Record<string, unknown>[]): Promise<number>;
}

export async function applyLessonTranscriptPlan(
  gateway: TranscriptSeedGateway,
  plan: SeedPlan,
): Promise<{ courses: number; resources: number; blocks: number }> {
  const courses = await gateway.upsert("courses", [plan.course]);
  const resources = await gateway.upsert("resources", plan.resources);
  const blocks = await gateway.upsert("blocks", plan.blocks);
  return { courses, resources, blocks };
}

/** How the ingest command proves the caption file is the one it thinks it is. */
export function captionFileHash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
