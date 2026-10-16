import { describe, expect, it } from "vitest";
import {
  CaptionFormatError,
  buildTranscript,
  parseJson3Captions,
  segmentTranscript,
  DEFAULT_SEGMENT_OPTIONS,
  type CaptionLine,
} from "@/lib/lesson/transcript";

/**
 * The caption parser and segmenter, tested against fixtures written here.
 *
 * The real caption file is NOT a fixture: it is a third-party artefact that is
 * gitignored, so a test that read it would either fail on a fresh clone or
 * quietly pass by being skipped. The real file's parse is evidenced by
 * `pnpm ingest:lesson --dry-run`, which prints its line count, coverage and block
 * count from the actual bytes.
 */

/** One `json3` event carrying `text` at `startMs`. */
function event(startMs: number, text: string, durationMs = 4000) {
  return {
    tStartMs: startMs,
    dDurationMs: durationMs,
    segs: text === "" ? [{ utf8: "\n" }] : [{ utf8: text }],
  };
}

function document(...events: ReturnType<typeof event>[]) {
  return { wireMagic: "pb3", events };
}

describe("parseJson3Captions", () => {
  it("refuses a document that is not a json3 caption file", () => {
    expect(() => parseJson3Captions({})).toThrow(CaptionFormatError);
    expect(() => parseJson3Captions("no")).toThrow(CaptionFormatError);
  });

  it("keeps the source's own words and does not repair them", () => {
    const { lines } = parseJson3Captions(
      document(event(1000, "Chachib was released"), event(3000, "MCPS and langraph")),
    );
    // ASR errors are the source's text, so they are preserved exactly. Editing
    // them would make the stored block a different text from the recording.
    expect(lines.map((line) => line.text)).toEqual([
      "Chachib was released",
      "MCPS and langraph",
    ]);
  });

  it("skips display-only events and reports how many", () => {
    const { lines, skippedEvents } = parseJson3Captions(
      document(event(0, "real text"), event(2500, ""), event(5000, "more text")),
    );
    expect(lines).toHaveLength(2);
    expect(skippedEvents).toBe(1);
  });

  it("collapses whitespace without dropping characters", () => {
    const { lines } = parseJson3Captions(document(event(0, "  a   b \n c  ")));
    expect(lines[0].text).toBe("a b c");
  });

  it("rejects timestamps that go backwards instead of re-sorting them", () => {
    expect(() =>
      parseJson3Captions(document(event(5000, "second"), event(2000, "first"))),
    ).toThrow(/not in order/);
  });

  it("ends a line at the next line's start when the rolling window overruns it", () => {
    const { lines } = parseJson3Captions(
      document(event(0, "one", 4000), event(2000, "two", 4000)),
    );
    // The first line's 4s window reaches past the second line's start, so the
    // window is not usable as a spoken end.
    expect(lines[0].endSeconds).toBe(2);
  });

  it("keeps a real silence out of the preceding line", () => {
    const { lines } = parseJson3Captions(
      document(event(0, "one", 2000), event(20000, "two", 4000)),
    );
    expect(lines[0].endSeconds).toBe(2);
    expect(lines[1].startSeconds).toBe(20);
  });

  it("refuses text with no usable time", () => {
    expect(() =>
      parseJson3Captions({ events: [{ segs: [{ utf8: "floating text" }] }] }),
    ).toThrow(/no usable start time/);
  });
});

describe("segmentTranscript", () => {
  /** 1500 lines, 2s apart, each filling the gap to the next. */
  function continuousLines(count: number): CaptionLine[] {
    return Array.from({ length: count }, (_, index) => ({
      startSeconds: index * 2,
      endSeconds: (index + 1) * 2,
      text: `line ${index}`,
    }));
  }

  it("tiles the transcript: every line appears exactly once, in order", () => {
    const lines = continuousLines(150);
    const blocks = segmentTranscript(lines);
    const flattened = blocks.flatMap((block) => block.lineTexts);
    expect(flattened).toEqual(lines.map((line) => line.text));
  });

  it("produces contiguous blocks with no gap and no overlap", () => {
    const blocks = segmentTranscript(continuousLines(150));
    for (let index = 1; index < blocks.length; index += 1) {
      expect(blocks[index].startSeconds).toBe(blocks[index - 1].endSeconds);
    }
  });

  it("respects the target length and never exceeds the ceiling", () => {
    const blocks = segmentTranscript(continuousLines(150));
    expect(blocks.length).toBeGreaterThan(1);
    for (const block of blocks.slice(0, -1)) {
      expect(block.endSeconds - block.startSeconds).toBeLessThanOrEqual(
        DEFAULT_SEGMENT_OPTIONS.maxSeconds,
      );
    }
    // All but the last block are at least the target length by construction.
    for (const block of blocks.slice(0, -1)) {
      expect(block.endSeconds - block.startSeconds).toBeGreaterThanOrEqual(
        DEFAULT_SEGMENT_OPTIONS.targetSeconds,
      );
    }
  });

  it("starts a new block at a silence", () => {
    const lines: CaptionLine[] = [
      { startSeconds: 0, endSeconds: 3, text: "before the silence" },
      { startSeconds: 60, endSeconds: 62, text: "after the silence" },
    ];
    const blocks = segmentTranscript(lines);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe("before the silence");
    expect(blocks[1].startSeconds).toBe(60);
  });

  it("merges a short trailing block into the one before it", () => {
    const lines: CaptionLine[] = [
      ...continuousLines(31),
      { startSeconds: 62, endSeconds: 65, text: "tail" },
    ];
    const blocks = segmentTranscript(lines);
    const last = blocks[blocks.length - 1];
    expect(last.text.endsWith("tail")).toBe(true);
    expect(last.endSeconds - last.startSeconds).toBeGreaterThan(
      DEFAULT_SEGMENT_OPTIONS.minSeconds,
    );
  });

  it("returns nothing for no lines rather than a fabricated block", () => {
    expect(segmentTranscript([])).toEqual([]);
  });
});

describe("buildTranscript", () => {
  it("reports the coverage of the recording the captions actually reach", () => {
    const transcript = buildTranscript(
      document(event(0, "start", 2000), event(100_000, "end", 2000)),
      200,
    );
    // 0.1s–102s of a 200s recording: a coverage figure below 1 is the point.
    expect(transcript.stats.lineCount).toBe(2);
    expect(transcript.stats.firstSeconds).toBe(0);
    expect(transcript.stats.lastSeconds).toBe(102);
    expect(transcript.stats.coverage).toBeCloseTo(0.51, 2);
  });

  it("never reports more than full coverage", () => {
    const transcript = buildTranscript(document(event(0, "a", 1000)), 1);
    expect(transcript.stats.coverage).toBeLessThanOrEqual(1);
  });
});
