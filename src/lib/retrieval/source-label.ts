import type { EvidenceBlock } from "@/lib/retrieval/types";

export function formatSeconds(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safe / 60);
  const seconds = safe % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Build the learner-visible citation label from the block's real source
 * location. Labels are always derived here, never taken from a model.
 */
export function describeSource(
  block: Pick<
    EvidenceBlock,
    | "blockType"
    | "resourceKind"
    | "startSeconds"
    | "endSeconds"
    | "pageNumber"
    | "slideNumber"
    | "lineStart"
    | "lineEnd"
    | "policy"
  >,
): string {
  if (block.policy === "COURSE_WIDE" && block.blockType === "notes") {
    return "Course-wide reference (approved)";
  }
  if (block.startSeconds !== null) {
    const end = block.endSeconds ?? block.startSeconds;
    return `Transcript ${formatSeconds(block.startSeconds)}–${formatSeconds(end)}`;
  }
  if (block.pageNumber !== null) {
    return `PDF page ${block.pageNumber}`;
  }
  if (block.slideNumber !== null) {
    return `Slide ${block.slideNumber}`;
  }
  if (block.lineStart !== null) {
    const end = block.lineEnd ?? block.lineStart;
    return `Code lines ${block.lineStart}–${end}`;
  }
  return block.resourceKind;
}
