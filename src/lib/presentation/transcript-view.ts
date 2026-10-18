/**
 * Reading a transcript pane: ordering, searching and stating what is missing.
 *
 * The server sends only the segments eligible at the learner's position, so this
 * module cannot show future text even if it tried. What it adds is the part a
 * list alone gets wrong: where the captions have no text at all. The recording's
 * captions cover 99.6% of its duration, and a short silent stretch would
 * otherwise look like a bug in the pane rather than a fact about the source.
 */

export interface TranscriptSegment {
  id: string;
  startSeconds: number;
  endSeconds: number;
  text: string;
  sourceLabel: string;
  /**
   * The block's text re-flowed into readable paragraphs.
   *
   * WHY NOT THE SOURCE'S LINE BREAKS
   *   An ASR caption line is about five words. One line per row turns a minute of
   *   speech into twenty fragments and makes the pane unskimmable. Grouping
   *   consecutive lines changes no word and no timestamp: it only chooses where a
   *   display line ends, which is exactly what wrapping does. The citation
   *   quotation still comes from the collapsed text the verifier checked.
   */
  paragraphs?: string[];
}

export interface TranscriptGap {
  startSeconds: number;
  endSeconds: number;
}

/**
 * Turn eligible blocks into reading segments.
 *
 * The input is already the eligible set — the store applied the predicate — so
 * this only decides what belongs in a transcript pane: transcript blocks with
 * both of their source timestamps. A PDF page and a code listing are evidence,
 * but they are not lines of the recording's speech, and putting them in this pane
 * would misdescribe them.
 */
export function selectTranscriptSegments(
  blocks: Array<{
    id: string;
    blockType: string;
    startSeconds: number | null;
    endSeconds: number | null;
    text: string;
    sourceLabel: string;
    textOriginal?: string | null;
  }>,
): TranscriptSegment[] {
  return blocks
    .filter(
      (block) =>
        block.blockType === "transcript" &&
        block.startSeconds !== null &&
        block.endSeconds !== null,
    )
    .map((block) => {
      const lines = (block.textOriginal ?? "")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
      return {
        id: block.id,
        startSeconds: Number(block.startSeconds),
        endSeconds: Number(block.endSeconds),
        text: block.text,
        sourceLabel: block.sourceLabel,
        paragraphs: flowIntoParagraphs(lines.length > 0 ? lines : [block.text]),
      };
    })
    .sort((a, b) => a.startSeconds - b.startSeconds);
}

/**
 * Group source caption lines into paragraphs of roughly `target` characters.
 *
 * A line is never split, so no word moves and no wording changes. The only
 * decision made here is where a paragraph break is more readable than a hard
 * wrap, which is a layout choice rather than an edit.
 */
export function flowIntoParagraphs(lines: string[], target = 380): string[] {
  const paragraphs: string[] = [];
  let current = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (current === "") {
      current = trimmed;
    } else if (current.length + 1 + trimmed.length > target) {
      paragraphs.push(current);
      current = trimmed;
    } else {
      current = `${current} ${trimmed}`;
    }
  }
  if (current !== "") paragraphs.push(current);
  return paragraphs;
}

/**
 * Gaps between consecutive segments, plus a leading gap when the first caption
 * starts after the recording began. No trailing gap: what has not been reached
 * yet is unknown, and drawing it as "missing" would be a guess.
 */
export function transcriptGaps(
  segments: TranscriptSegment[],
  options: { minGapSeconds?: number; leadingSeconds?: number } = {},
): TranscriptGap[] {
  const minGapSeconds = options.minGapSeconds ?? 8;
  const leadingSeconds = options.leadingSeconds ?? 3;
  const ordered = [...segments].sort((a, b) => a.startSeconds - b.startSeconds);
  if (ordered.length === 0) return [];

  const gaps: TranscriptGap[] = [];
  const first = ordered[0];
  if (first.startSeconds >= leadingSeconds) {
    gaps.push({ startSeconds: 0, endSeconds: first.startSeconds });
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    const quiet = current.startSeconds - previous.endSeconds;
    if (quiet >= minGapSeconds) {
      gaps.push({ startSeconds: previous.endSeconds, endSeconds: current.startSeconds });
    }
  }
  return gaps;
}

export function filterSegments(
  segments: TranscriptSegment[],
  query: string,
): TranscriptSegment[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return segments;
  return segments.filter((segment) => segment.text.toLowerCase().includes(needle));
}

/** The segment playing at `seconds`, by its own reported span. */
export function segmentAt(
  segments: TranscriptSegment[],
  seconds: number,
): TranscriptSegment | null {
  let found: TranscriptSegment | null = null;
  for (const segment of segments) {
    if (segment.startSeconds <= seconds && seconds < segment.endSeconds) {
      found = segment;
    }
  }
  return found;
}

/** Count of caption blocks that contain a search term, for the pane header. */
export function matchCount(segments: TranscriptSegment[], query: string): number {
  return filterSegments(segments, query).length;
}
