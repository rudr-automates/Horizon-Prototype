import { z } from "zod";

/**
 * Contracts for the two read-only endpoints that feed the reading panes.
 *
 * Both answer with ONLY the blocks that are eligible at the requested position.
 * That is the same predicate the question path uses, applied by the same store,
 * so a pane cannot show a passage the answer path would refuse to cite. Neither
 * response carries an unlock time or any text from a passage still ahead of the
 * learner.
 */

export const transcriptSegmentSchema = z.object({
  id: z.string(),
  startSeconds: z.number(),
  endSeconds: z.number(),
  text: z.string(),
  sourceLabel: z.string(),
  /**
   * The block's text re-flowed for reading: the same words, in the same order,
   * grouped into paragraphs. Not a model summary and not a re-timestamping.
   */
  paragraphs: z.array(z.string()).default([]),
});
export type TranscriptSegmentPayload = z.infer<typeof transcriptSegmentSchema>;

export const transcriptResponseSchema = z.object({
  requestId: z.string(),
  courseId: z.string(),
  boundarySeconds: z.number(),
  segments: z.array(transcriptSegmentSchema),
  /** Caption provenance, so the pane can label machine transcription. */
  sourceLabel: z.string(),
  note: z.string(),
});
export type TranscriptResponse = z.infer<typeof transcriptResponseSchema>;

export const resourceBlockSchema = z.object({
  id: z.string(),
  text: z.string(),
  pageNumber: z.number().int().nullable(),
  slideNumber: z.number().int().nullable(),
  lineStart: z.number().int().nullable(),
  lineEnd: z.number().int().nullable(),
  startSeconds: z.number().nullable(),
  endSeconds: z.number().nullable(),
});
export type ResourceBlockPayload = z.infer<typeof resourceBlockSchema>;

export const resourceDetailResponseSchema = z.object({
  requestId: z.string(),
  courseId: z.string(),
  boundarySeconds: z.number(),
  resource: z.object({
    id: z.string(),
    kind: z.enum(["video", "transcript", "pdf", "ppt", "notes", "code"]),
    title: z.string(),
    policy: z.enum(["COURSE_WIDE", "TIMELINE_BOUND", "MIXED"]),
    parser: z.string().nullable(),
    coverage: z.number().nullable(),
  }),
  /** Blocks permitted at this position. Never a future page or slide. */
  blocks: z.array(resourceBlockSchema),
  /** How many blocks the resource has in total. A count, never text. */
  totalBlocks: z.number().int(),
  note: z.string(),
});
export type ResourceDetailResponse = z.infer<typeof resourceDetailResponseSchema>;
