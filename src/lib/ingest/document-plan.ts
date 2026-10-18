/**
 * Turning parsed document chunks into `resources` + `blocks` rows.
 *
 * THE TWO MODES, AND WHY THEY ARE DIFFERENT
 *   `reference`  The operator is explicitly permitting a block at any playhead
 *                (COURSE_WIDE). The eligibility predicate only accepts that when
 *                a HUMAN approved it AND its lint status is PASSED or
 *                ACKNOWLEDGED, so this module refuses to write an approved
 *                reference that its own lint flags, unless the operator records
 *                that they accept the risk.
 *   `aligned`    Each chunk is tied to the moment in the recording where the
 *                instructor covers it (TIMELINE_BOUND). An uncertain alignment is
 *                written as PENDING with null `unlock_seconds`, which the
 *                predicate makes INELIGIBLE — a pending block is never evidence,
 *                and the review command is what makes it one.
 *
 * NOTHING HERE GUESSES. Alignment is lexical overlap against the stored
 * transcript, its score and runner-up margin are recorded on every row, and a
 * block below the confidence floor stays PENDING rather than getting a
 * plausible-looking unlock time.
 */
import {
  DocumentRefused,
  type DocumentChunk,
  type ParsedDocument,
} from "@/lib/ingest/document";
import { contentHash, stableUuid, toVectorLiteral } from "@/lib/ingest/seed";
import { LESSON_LATE_MARKERS } from "@/lib/lesson/canaries";

/** Alignment floor: below this the block is PENDING, never auto-approved. */
export const ALIGNMENT_MIN_SCORE = 0.35;
/** And it must beat the best non-adjacent window by this margin. */
export const ALIGNMENT_MIN_MARGIN = 0.12;
/**
 * A course-wide block whose strongest alignment lands in this last fraction of
 * the recording is suspicious: it is material the lesson only reaches at the end,
 * being offered at the start. It is flagged rather than silently approved.
 */
export const LATE_ALIGNMENT_FRACTION = 0.8;

export type DocumentMode = "reference" | "aligned";

export interface TranscriptWindow {
  text: string;
  endSeconds: number;
}

export interface ChunkAlignment {
  /** Index into the transcript windows, or -1 when the document has no match. */
  bestIndex: number;
  /** Share of the chunk's content words that the matched window contains. */
  score: number;
  /** Best score minus the best score from a non-adjacent window. */
  margin: number;
  /** Null when nothing matched at all. */
  unlockSeconds: number | null;
}

const STOPWORDS = new Set([
  "about", "after", "again", "also", "because", "been", "before", "being", "between",
  "both", "can", "could", "does", "doing", "each", "from", "have", "having", "here",
  "into", "just", "like", "more", "most", "much", "must", "only", "other", "over",
  "same", "should", "some", "such", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "those", "through", "under", "very", "want", "well",
  "were", "what", "when", "where", "which", "while", "will", "with", "would", "your",
  "you", "the", "and", "for", "are", "but", "not", "all", "any", "how", "its", "our",
  "out", "who", "why", "yes", "now", "one", "two", "get", "got", "let", "say",
]);

/** Content words: lowercase, at least four characters, stopwords removed. */
export function contentTokens(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z][a-z0-9]{3,}/g) ?? [];
  return new Set(words.filter((word) => !STOPWORDS.has(word)));
}

/** How many transcript blocks one aligned run may span. */
export const MAX_ALIGNMENT_RUN = 10;

/**
 * Where in the recording does this chunk's text appear?
 *
 * WHY A CONTIGUOUS RUN AND NOT ONE WINDOW
 *   A slide that summarises seven minutes of a lesson contains sentences from
 *   seven different blocks. Scored against a single 60-second block it can never
 *   exceed about a seventh coverage, so every real slide would look like a weak
 *   match and be sent to a human for review that had nothing to review. The
 *   question is "which stretch of the recording does this cover", so the answer is
 *   the shortest contiguous run of blocks that contains most of the chunk.
 *
 *   The run is grown greedily from the best-matching block, one block at a time,
 *   taking whichever side adds coverage, and it stops when extending stops
 *   helping. `unlockSeconds` is the END of the run: the block becomes available
 *   only once the learner has watched everything it summarises.
 *
 * Containment rather than Jaccard, because a slide is a summary: "how much of the
 * slide does this stretch of the recording contain" is the useful direction.
 */
export function alignChunk(
  chunkText: string,
  windows: ReadonlyArray<TranscriptWindow>,
): ChunkAlignment {
  const chunkTokens = contentTokens(chunkText);
  if (chunkTokens.size === 0 || windows.length === 0) {
    return { bestIndex: -1, score: 0, margin: 0, unlockSeconds: null };
  }

  const tokenSets = windows.map((window) => contentTokens(window.text));
  const perWindow = tokenSets.map((tokens) => {
    let shared = 0;
    for (const token of chunkTokens) if (tokens.has(token)) shared += 1;
    return shared;
  });

  let seed = 0;
  for (let index = 1; index < perWindow.length; index += 1) {
    if (perWindow[index] > perWindow[seed]) seed = index;
  }

  // No shared content word at all is not a weak match, it is no match. Returning
  // window 0 here would hand the caller a real timestamp for text the recording
  // never covers.
  if ((perWindow[seed] ?? 0) === 0) {
    return { bestIndex: -1, score: 0, margin: 0, unlockSeconds: null };
  }

  const runAt = (startIndex: number): { start: number; end: number; covered: number } => {
    let start = startIndex;
    let end = startIndex;
    const seen = new Set<string>();
    const addWindow = (index: number) => {
      for (const token of tokenSets[index]) {
        if (chunkTokens.has(token)) seen.add(token);
      }
    };
    addWindow(startIndex);

    while (end - start + 1 < MAX_ALIGNMENT_RUN) {
      const left = start > 0 ? tokenSets[start - 1] : null;
      const right = end + 1 < tokenSets.length ? tokenSets[end + 1] : null;
      const gain = (tokens: Set<string> | null) => {
        if (!tokens) return -1;
        let added = 0;
        for (const token of tokens) if (chunkTokens.has(token) && !seen.has(token)) added += 1;
        return added;
      };
      const leftGain = gain(left);
      const rightGain = gain(right);
      // A single incidental shared word must not stretch the run: every extra
      // block moves the unlock time later, and an over-long run would delay
      // material the learner has already reached. Ten percent of the chunk (and
      // never less than two words) is the floor for calling it the same topic.
      const meaningful = Math.max(2, Math.ceil(chunkTokens.size * 0.1));
      if (leftGain < meaningful && rightGain < meaningful) break;
      if (rightGain >= leftGain) {
        end += 1;
        addWindow(end);
      } else {
        start -= 1;
        addWindow(start);
      }
    }

    return { start, end, covered: seen.size };
  };

  // Every seed is considered, not only the best single block: a chunk that
  // summarises a whole section covers little of any one block, and its best RUN
  // can start somewhere other than its best block. Taking only the top block
  // produced negative margins — a "winner" that another stretch of the recording
  // demonstrably covered better.
  const runs = tokenSets.map((_, index) => runAt(index));
  let best = runs[seed] ?? { start: seed, end: seed, covered: 0 };
  let bestSeed = seed;
  for (const [index, run] of runs.entries()) {
    if (run.covered > best.covered) {
      best = run;
      bestSeed = index;
    }
  }
  const score = best.covered / chunkTokens.size;

  // The competing run must lie outside the winning stretch: neighbouring
  // transcript blocks talk about the same thing by construction, so beating only
  // adjacent material proves nothing about ambiguity. A chunk that scores well in
  // two separate stretches of the lesson is exactly the agenda/recap/glossary case
  // the blueprint says to send to a human.
  let competitor = 0;
  for (const [index, run] of runs.entries()) {
    if (index >= best.start - 1 && index <= best.end + 1) continue;
    const candidate = run.covered / chunkTokens.size;
    if (candidate > competitor) competitor = candidate;
  }

  return {
    bestIndex: bestSeed,
    score: Number(score.toFixed(4)),
    margin: Number((score - competitor).toFixed(4)),
    unlockSeconds: windows[best.end]?.endSeconds ?? null,
  };
}

export interface BuildDocumentPlanInput {
  courseId: string;
  /** Relative path of the original file. Kept private; never a download URL. */
  storageKey: string;
  title: string;
  parsed: ParsedDocument;
  chunks: DocumentChunk[];
  vectors: number[][];
  embeddingModel: string;
  embeddingDimensions: number;
  fileHash: string;
  mode: DocumentMode;
  /** Required in `aligned` mode; empty in `reference` mode. */
  transcript: ReadonlyArray<TranscriptWindow>;
  /** The recording's duration, used only for the late-alignment lint. */
  recordingDurationSeconds: number;
  /**
   * Facts so distinctive that their presence in course-wide material is a
   * leakage risk. Defaults to the registry this project already uses.
   */
  lateMarkers?: ReadonlyArray<string>;
  /**
   * Recorded operator acceptance of a flagged course-wide block. Without it a
   * flagged reference is refused, because `HUMAN_APPROVED` + `FLAGGED` would be
   * written as a legitimate approval of material the lint just objected to.
   */
  acknowledgeLint?: string | null;
}

export interface DocumentPlanResult {
  /**
   * Rows only. A document is added to an existing course, so this plan carries no
   * course row and cannot overwrite the recording's own metadata.
   */
  resources: Record<string, unknown>[];
  blocks: Record<string, unknown>[];
  summary: {
    mode: DocumentMode;
    blocks: number;
    pages: number;
    coverage: number;
    visualOnlyPages: number[];
    referenceBlocks: number;
    autoApproved: number;
    pending: number;
    flagged: number;
    acknowledged: number;
    markerHits: string[];
    lateAlignments: number;
  };
}

export function buildDocumentPlan(input: BuildDocumentPlanInput): DocumentPlanResult {
  const {
    courseId,
    storageKey,
    title,
    parsed,
    chunks,
    vectors,
    embeddingModel,
    embeddingDimensions,
    fileHash,
    mode,
    transcript,
    recordingDurationSeconds,
    lateMarkers = LESSON_LATE_MARKERS,
    acknowledgeLint = null,
  } = input;

  if (chunks.length === 0) {
    throw new DocumentRefused(
      "The document produced no text blocks. A scanned or image-only file cannot be indexed without OCR, which this build does not have.",
    );
  }
  if (vectors.length !== chunks.length) {
    throw new DocumentRefused(`Got ${vectors.length} vectors for ${chunks.length} chunks.`);
  }
  if (mode === "aligned" && transcript.length === 0) {
    throw new DocumentRefused(
      "Aligned mode needs the recording's transcript to align against, and none was loaded.",
    );
  }

  const resourceId = stableUuid(`horizon-document-resource:${courseId}:${fileHash}`);
  const blockIdFor = (ordinal: number) =>
    stableUuid(`horizon-document-block:${courseId}:${fileHash}:${ordinal}`);

  const rows: Record<string, unknown>[] = [];
  const flaggedOrdinals: number[] = [];
  const markerHits = new Set<string>();
  let autoApproved = 0;
  let pending = 0;
  let acknowledged = 0;
  let lateAlignments = 0;

  for (const [index, chunk] of chunks.entries()) {
    const vector = vectors[index];
    if (!vector || vector.length !== embeddingDimensions) {
      throw new DocumentRefused(
        `Chunk ${index} produced a vector of ${vector ? vector.length : 0} values, not the configured ${embeddingDimensions}.`,
      );
    }

    const alignment = mode === "aligned" ? alignChunk(chunk.text, transcript) : null;

    // ---- Lint, applied to both modes -------------------------------
    const hits = lateMarkers.filter((marker) =>
      chunk.text.toLowerCase().includes(marker.toLowerCase()),
    );
    for (const hit of hits) markerHits.add(hit);

    const landsLate =
      alignment !== null &&
      alignment.unlockSeconds !== null &&
      recordingDurationSeconds > 0 &&
      alignment.unlockSeconds >= recordingDurationSeconds * LATE_ALIGNMENT_FRACTION &&
      alignment.score >= ALIGNMENT_MIN_SCORE;
    if (landsLate) lateAlignments += 1;

    let policy: "COURSE_WIDE" | "TIMELINE_BOUND";
    let reviewState: "AUTO_APPROVED" | "HUMAN_APPROVED" | "PENDING";
    let lintStatus: "NA" | "PASSED" | "FLAGGED" | "ACKNOWLEDGED";
    let unlockSeconds: number | null;
    let alignmentMethod: string | null;
    let alignmentConfidence: number | null;
    let alignmentMargin: number | null;

    if (mode === "reference") {
      policy = "COURSE_WIDE";
      unlockSeconds = null;
      alignmentMethod = alignment ? "lexical-overlap-v1" : null;
      alignmentConfidence = alignment ? alignment.score : null;
      alignmentMargin = alignment ? alignment.margin : null;

      const suspicious = hits.length > 0 || landsLate;
      if (suspicious) {
        flaggedOrdinals.push(chunk.ordinal);
        if (!acknowledgeLint) {
          continue; // Reported by the refusal below; never written as approved.
        }
        lintStatus = "ACKNOWLEDGED";
        acknowledged += 1;
      } else {
        lintStatus = "PASSED";
      }
      // HUMAN_APPROVED is the operator's `--mode reference` decision, which is
      // exactly what the predicate requires for a course-wide block.
      reviewState = "HUMAN_APPROVED";
    } else {
      policy = "TIMELINE_BOUND";
      const confident =
        alignment !== null &&
        alignment.bestIndex >= 0 &&
        alignment.score >= ALIGNMENT_MIN_SCORE &&
        alignment.margin >= ALIGNMENT_MIN_MARGIN;
      if (confident) {
        reviewState = "AUTO_APPROVED";
        unlockSeconds = alignment.unlockSeconds;
        autoApproved += 1;
      } else {
        // PENDING with a null unlock: the predicate makes it ineligible, so an
        // uncertain alignment can never become evidence on its own.
        reviewState = "PENDING";
        unlockSeconds = null;
        pending += 1;
      }
      lintStatus = hits.length > 0 ? "FLAGGED" : "NA";
      if (hits.length > 0) flaggedOrdinals.push(chunk.ordinal);
      alignmentMethod = "lexical-overlap-v1";
      alignmentConfidence = alignment ? alignment.score : 0;
      alignmentMargin = alignment ? alignment.margin : 0;
    }

    rows.push({
      id: blockIdFor(chunk.ordinal),
      course_id: courseId,
      resource_id: resourceId,
      block_type: parsed.kind === "pdf" ? "pdf" : "ppt",
      ordinal: chunk.ordinal,
      text_original: chunk.text,
      text_normalized: chunk.text.replace(/\s+/g, " ").trim(),
      start_seconds: null,
      end_seconds: null,
      // A PDF chunk is addressed by page; a deck chunk by slide. Both keep the
      // part index, because one long page can legitimately be several chunks.
      page_number: parsed.kind === "pdf" ? chunk.pageNumber : null,
      slide_number: parsed.kind === "ppt" ? chunk.pageNumber : null,
      line_start: chunk.partCount > 1 ? chunk.partIndex : null,
      line_end: chunk.partCount > 1 ? chunk.partCount : null,
      frame_seconds: null,
      policy,
      review_state: reviewState,
      lint_status: lintStatus,
      ingest_status: "INDEXED",
      unlock_seconds: unlockSeconds,
      alignment_method: alignmentMethod,
      alignment_confidence: alignmentConfidence,
      alignment_margin: alignmentMargin,
      policy_version: "v1",
      content_version: "v1",
      source_hash: contentHash(`${fileHash}:${chunk.ordinal}:${chunk.text}`),
      embedding: toVectorLiteral(vector),
      embedding_model: embeddingModel,
      embedding_dim: vector.length,
    });
  }

  if (mode === "reference" && flaggedOrdinals.length > 0 && !acknowledgeLint) {
    const reasons: string[] = [];
    if (markerHits.size > 0) {
      reasons.push(
        `contains registered late-only fact(s): ${[...markerHits].join(", ")}`,
      );
    }
    if (lateAlignments > 0) {
      reasons.push(
        `${lateAlignments} chunk(s) align to the last ${Math.round((1 - LATE_ALIGNMENT_FRACTION) * 100)}% of the recording`,
      );
    }
    throw new DocumentRefused(
      `Refusing to approve this document course-wide: ${flaggedOrdinals.length} block(s) were flagged (${reasons.join("; ")}). ` +
        "Either ingest with --mode aligned, so those blocks stay time-gated, or re-run with --acknowledge-recording the reason you accept the risk.",
    );
  }

  const resource: Record<string, unknown> = {
    id: resourceId,
    course_id: courseId,
    kind: parsed.kind === "pdf" ? "pdf" : "ppt",
    title,
    storage_key: storageKey,
    source_hash: fileHash,
    parser_version: parsed.parser,
    ingest_status: "INDEXED",
    extraction_coverage: parsed.coverage,
    default_policy: mode === "reference" ? "COURSE_WIDE" : "TIMELINE_BOUND",
  };

  return {
    resources: [resource],
    blocks: rows,
    summary: {
      mode,
      blocks: rows.length,
      pages: parsed.pages.length,
      coverage: parsed.coverage,
      visualOnlyPages: parsed.visualOnlyPages,
      referenceBlocks: rows.filter((row) => row.policy === "COURSE_WIDE").length,
      autoApproved,
      pending,
      flagged: flaggedOrdinals.length,
      acknowledged,
      markerHits: [...markerHits],
      lateAlignments,
    },
  };
}

/** Provenance recorded on the resource row, so a citation can name its source. */
export function documentSourceLabel(kind: "pdf" | "ppt", pageOrSlide: number | null): string {
  if (pageOrSlide === null) return kind === "pdf" ? "PDF" : "Slides";
  return kind === "pdf" ? `PDF page ${pageOrSlide}` : `Slide ${pageOrSlide}`;
}
