import { describe, expect, it } from "vitest";
import { describeSource, formatSeconds } from "@/lib/retrieval/source-label";

const base = {
  resourceKind: "transcript" as const,
  startSeconds: null,
  endSeconds: null,
  pageNumber: null,
  slideNumber: null,
  lineStart: null,
  lineEnd: null,
  policy: "TIMELINE_BOUND" as const,
};

describe("citation labels", () => {
  it("labels a transcript block with its own clock", () => {
    expect(
      describeSource({
        ...base,
        blockType: "transcript",
        startSeconds: 2692.8,
        endSeconds: 2753.8,
      }),
    ).toBe("Transcript 44:52–45:53");
  });

  it("labels a PDF block by page and a slide block by slide number", () => {
    expect(
      describeSource({ ...base, blockType: "pdf", resourceKind: "pdf", pageNumber: 4 }),
    ).toBe("PDF page 4");
    expect(
      describeSource({ ...base, blockType: "ppt", resourceKind: "ppt", slideNumber: 7 }),
    ).toBe("Slide 7");
  });

  it("does not invent a clock for a document block", () => {
    // A page has no start time. Rendering one would put a seek target on a
    // citation that the player cannot seek to.
    const label = describeSource({ ...base, blockType: "pdf", pageNumber: 2 });
    expect(label).not.toContain(":");
  });

  it("formats clock values past an hour without losing seconds", () => {
    expect(formatSeconds(0)).toBe("00:00");
    expect(formatSeconds(3386.5)).toBe("56:26");
  });
});
