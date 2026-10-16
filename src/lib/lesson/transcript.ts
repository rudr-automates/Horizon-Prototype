/**
 * The lesson recording's transcript: parsing and segmentation.
 *
 * WHERE THE TEXT COMES FROM
 *   YouTube's own automatically generated English captions for the selected
 *   video, saved as `json3` (yt-dlp: `--write-auto-subs --sub-langs en
 *   --sub-format json3`). Nothing here invents or repairs wording. Every
 *   timestamp is the one YouTube reported for that caption line, and every word
 *   is what the ASR emitted — including its mistakes, which is exactly why the
 *   interface labels this source as machine transcription rather than a script.
 *
 * WHAT THIS MODULE IS DELIBERATELY NOT
 *   It has no filesystem, no network and no model call. It is a pure
 *   transform: bytes in, timestamped blocks out, with the numbers used to judge
 *   whether the result is trustworthy returned alongside. That makes the one
 *   thing the evidence rests on — that the times are real and the words are the
 *   source's — testable without a 235 MiB video or a database.
 *
 * TIMING RULE
 *   A `json3` event's `dDurationMs` is the ROLLING WINDOW the line stayed on
 *   screen (measured at ~4.5 s in this file, longer than the ~2.2 s between
 *   lines), so it is not the spoken duration and must not be used as one. A
 *   line therefore ends at whichever comes first: the start of the next line, or
 *   its own window end. The first of those keeps blocks contiguous across
 *   continuous speech; the second keeps a silence from being swallowed into the
 *   line before it. Every edge is thus a time the source actually reported.
 */

export interface CaptionLine {
  /** Start of the line, in seconds, exactly as the source reported it. */
  startSeconds: number;
  /** End of the line, in seconds. See TIMING RULE above. */
  endSeconds: number;
  text: string;
}

export interface TranscriptBlock {
  /** First line's start. Never earlier than the source reports. */
  startSeconds: number;
  /** Last line's end. */
  endSeconds: number;
  /** Lines joined for reading; whitespace collapsed, nothing else changed. */
  text: string;
  /** Lines as they were, so `text_original` can keep the caption breaks. */
  lineTexts: string[];
  /** Index of the first line in the parsed transcript, for traceability. */
  firstLineIndex: number;
}

export interface TranscriptStats {
  lineCount: number;
  blockCount: number;
  /** First captioned second and last captioned second. */
  firstSeconds: number;
  lastSeconds: number;
  /**
   * Fraction of the recording's duration that a captioned line covers. Below 1
   * means parts of the recording have no text at all, and the interface must not
   * imply otherwise.
   */
  coverage: number;
  /** Caption events that carried no usable text and were skipped. */
  skippedEvents: number;
}

export interface Transcript {
  lines: CaptionLine[];
  blocks: TranscriptBlock[];
  stats: TranscriptStats;
}

/** Raised when a caption file cannot be read as a timestamped transcript. */
export class CaptionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CaptionFormatError";
  }
}

export interface SegmentOptions {
  /**
   * Close a block at the first caption-line boundary at or after this many
   * seconds. Punctuation is deliberately NOT used to refine this: only 5% of
   * this ASR's caption lines end with a full stop, so a "sentence" in this text
   * routinely spans a dozen lines and punctuation marks nothing usable.
   */
  targetSeconds: number;
  /** Hard ceiling, for a stretch of unusually long lines. */
  maxSeconds: number;
  /**
   * A quiet stretch this long starts a new block: the speaker has stopped, and a
   * passage separated by silence is a poor thing to cite as one span.
   */
  gapSeconds: number;
  /** A trailing block shorter than this is merged into the previous one. */
  minSeconds: number;
}

export const DEFAULT_SEGMENT_OPTIONS: SegmentOptions = {
  targetSeconds: 60,
  maxSeconds: 90,
  gapSeconds: 12,
  minSeconds: 20,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Collapse whitespace only. No word is added, removed or corrected. */
function normalizeLineText(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Parse a `json3` caption document into ordered, timestamped lines.
 *
 * Strict about the facts it depends on and lenient only about decoration:
 *   - a missing `events` array or an event with no numeric `tStartMs` is a
 *     malformed file, because without a time the text cannot be cited at all;
 *   - an event whose text is blank after whitespace collapsing is a display
 *     artefact (the ASR emits bare newline events), so it is skipped and counted;
 *   - timestamps that go BACKWARDS are rejected outright. Ordering is what makes
 *     the text a transcript rather than a bag of sentences, and a silently
 *     re-sorted file would produce blocks whose spans are wrong.
 */
export function parseJson3Captions(raw: unknown): {
  lines: CaptionLine[];
  skippedEvents: number;
} {
  if (!isRecord(raw) || !Array.isArray(raw.events)) {
    throw new CaptionFormatError(
      "This is not a json3 caption document: it has no `events` array.",
    );
  }

  const events = raw.events;
  const lines: CaptionLine[] = [];
  let skippedEvents = 0;

  for (const event of events) {
    if (!isRecord(event)) {
      skippedEvents += 1;
      continue;
    }

    const segments = event.segs;
    if (!Array.isArray(segments)) {
      skippedEvents += 1;
      continue;
    }

    const text = normalizeLineText(
      segments
        .map((segment) =>
          isRecord(segment) && typeof segment.utf8 === "string" ? segment.utf8 : "",
        )
        .join(""),
    );
    if (text === "") {
      // A newline-only event: real, but it carries no words to cite.
      skippedEvents += 1;
      continue;
    }

    const startMs = toFiniteNumber(event.tStartMs);
    if (startMs === null || startMs < 0) {
      throw new CaptionFormatError(
        `A caption line carrying text ("${text.slice(0, 40)}…") has no usable start time.`,
      );
    }

    const previous = lines[lines.length - 1];
    if (previous && startMs / 1000 < previous.startSeconds) {
      throw new CaptionFormatError(
        `Caption timestamps are not in order: a line at ${(startMs / 1000).toFixed(1)}s follows one at ${previous.startSeconds.toFixed(1)}s.`,
      );
    }

    const windowMs = toFiniteNumber(event.dDurationMs);
    lines.push({
      startSeconds: startMs / 1000,
      // Provisional: `resolveLineEnds` replaces this with the next line's start
      // for every line but the last.
      endSeconds:
        windowMs !== null && windowMs > 0 ? (startMs + windowMs) / 1000 : startMs / 1000,
      text,
    });
  }

  if (lines.length === 0) {
    throw new CaptionFormatError("The caption document contains no timestamped text.");
  }

  return { lines: resolveLineEnds(lines), skippedEvents };
}

/**
 * Give every line an end that the source itself supports, so blocks tile the
 * recording instead of overlapping by a rolling-window duration.
 *
 * `min(window end, next line's start)` is the honest bound: the window end
 * cannot be trusted past the moment the next line begins, and the next line's
 * start cannot be pulled back over a real silence.
 */
function resolveLineEnds(lines: CaptionLine[]): CaptionLine[] {
  return lines.map((line, index) => {
    const next = lines[index + 1];
    if (!next) return line;
    return {
      ...line,
      endSeconds: Math.min(line.endSeconds, next.startSeconds),
    };
  });
}

/**
 * Group lines into citable blocks.
 *
 * A block closes at the first caption-line boundary at or after `targetSeconds`
 * (or at `maxSeconds` when lines are long), and a silence of `gapSeconds` or more
 * closes one early. Nothing is dropped: the blocks tile the whole transcript, so
 * a question about a passage either has a block covering it or the passage
 * genuinely has no captions.
 */
export function segmentTranscript(
  lines: CaptionLine[],
  options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): TranscriptBlock[] {
  if (lines.length === 0) return [];

  const blocks: TranscriptBlock[] = [];
  let current: { lines: CaptionLine[]; firstLineIndex: number } | null = null;

  const flush = (): void => {
    if (!current) return;
    const first = current.lines[0];
    const last = current.lines[current.lines.length - 1];
    blocks.push({
      startSeconds: first.startSeconds,
      endSeconds: last.endSeconds,
      text: current.lines.map((line) => line.text).join(" "),
      lineTexts: current.lines.map((line) => line.text),
      firstLineIndex: current.firstLineIndex,
    });
    current = null;
  };

  for (const [index, line] of lines.entries()) {
    if (!current) {
      current = { lines: [line], firstLineIndex: index };
      continue;
    }

    const previous = current.lines[current.lines.length - 1];
    const elapsed = line.startSeconds - current.lines[0].startSeconds;
    const quiet = line.startSeconds - previous.endSeconds;

    // Close BEFORE taking this line, so a block never ends later than the
    // boundary that closed it (plus nothing: the closing line was already in).
    if (quiet >= options.gapSeconds || elapsed >= options.targetSeconds || elapsed >= options.maxSeconds) {
      flush();
      current = { lines: [line], firstLineIndex: index };
      continue;
    }

    current.lines.push(line);
  }

  flush();

  // A very short trailing block is a worse citation than the passage it
  // continues, but only merge when the two are CONTIGUOUS and the result stays
  // inside the ceiling. A block separated from the one before it by a silence is
  // a distinct passage, however short, and merging it would attribute speech
  // across a pause the learner can hear.
  if (blocks.length >= 2) {
    const last = blocks[blocks.length - 1];
    const previous = blocks[blocks.length - 2];
    const lastLength = last.endSeconds - last.startSeconds;
    const mergedLength = last.endSeconds - previous.startSeconds;
    const contiguous = Math.abs(last.startSeconds - previous.endSeconds) < 0.001;
    if (contiguous && lastLength < options.minSeconds && mergedLength <= options.maxSeconds) {
      blocks.splice(blocks.length - 2, 2, {
        startSeconds: previous.startSeconds,
        endSeconds: last.endSeconds,
        text: `${previous.text} ${last.text}`,
        lineTexts: [...previous.lineTexts, ...last.lineTexts],
        firstLineIndex: previous.firstLineIndex,
      });
    }
  }

  return blocks;
}

/**
 * Numbers that say how much of the recording the transcript actually covers.
 * Reported rather than assumed: "indexed" is only honest with a coverage figure
 * beside it.
 */
export function describeTranscript(
  lines: CaptionLine[],
  blocks: TranscriptBlock[],
  videoDurationSeconds: number,
  skippedEvents: number,
): TranscriptStats {
  const firstSeconds = lines[0]?.startSeconds ?? 0;
  const lastSeconds = lines[lines.length - 1]?.endSeconds ?? 0;
  const covered = Math.max(0, lastSeconds - firstSeconds);
  const coverage =
    videoDurationSeconds > 0 ? Math.min(1, covered / videoDurationSeconds) : 0;

  return {
    lineCount: lines.length,
    blockCount: blocks.length,
    firstSeconds,
    lastSeconds,
    coverage,
    skippedEvents,
  };
}

/** Parse, segment and describe in one step. The ingest path's front door. */
export function buildTranscript(
  raw: unknown,
  videoDurationSeconds: number,
  options: SegmentOptions = DEFAULT_SEGMENT_OPTIONS,
): Transcript {
  const { lines, skippedEvents } = parseJson3Captions(raw);
  const blocks = segmentTranscript(lines, options);
  return {
    lines,
    blocks,
    stats: describeTranscript(lines, blocks, videoDurationSeconds, skippedEvents),
  };
}

/**
 * The selected lesson video's caption provenance, as one labelled constant.
 *
 * `machineGenerated: true` is the fact the interface must state: these are
 * YouTube's automatic captions, so wording can be wrong even though the text is
 * verbatim. Marking it here rather than in prose alone means the caveat cannot
 * be dropped from one screen while another keeps it.
 */
export const LESSON_TRANSCRIPT_SOURCE = {
  provider: "youtube_auto_captions",
  language: "en",
  label: "YouTube auto-generated English captions (ASR)",
  machineGenerated: true,
  caveat:
    "Machine transcription, not a human-verified script. The wording is verbatim from the source, but the source itself mis-hears words.",
  fetchedWith:
    "yt-dlp --write-auto-subs --sub-langs en --sub-format json3 --skip-download",
} as const;
