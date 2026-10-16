import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  EMBED_HOST,
  LESSON_VIDEO,
  PUBLIC_VIDEO_ROUTE,
  formatPlaybackClock,
  parseByteRange,
  resolveLessonVideoSource,
  type LocalVideoFile,
} from "@/lib/lesson/video";
import {
  findLocalLessonVideoFile,
  resolveServerLessonVideoSource,
} from "@/lib/lesson/video-file";

/**
 * The lesson-video integration.
 *
 * These tests exist because two claims on screen depend on this code being
 * right, and both would be easy to get wrong in a way nothing else notices:
 *
 *  1. Which player the learner sees. A deployed host has no local recording, so
 *     rendering the local route there would produce a permanently broken player.
 *  2. Where the player can seek. Without byte-range parsing the server answers
 *     200 with the whole file and the seek bar stops corresponding to anything.
 */

const LOCAL: LocalVideoFile = {
  fileName: LESSON_VIDEO.localFileName,
  bytes: LESSON_VIDEO.localFileBytes,
  absolutePath: "C:\\somewhere\\private\\lesson.mp4",
};

describe("lesson video source", () => {
  it("uses the local copy when the operator has one, behind a same-origin route", () => {
    const source = resolveLessonVideoSource(LOCAL);
    expect(source.kind).toBe("file");
    if (source.kind !== "file") throw new Error("unreachable");
    expect(source.url).toBe(PUBLIC_VIDEO_ROUTE);
    expect(source.bytes).toBe(LESSON_VIDEO.localFileBytes);
  });

  it("falls back to the original embed when there is no local copy", () => {
    const source = resolveLessonVideoSource(null);
    expect(source.kind).toBe("embed");
    if (source.kind !== "embed") throw new Error("unreachable");
    expect(source.youtubeId).toBe(LESSON_VIDEO.youtubeId);
    expect(source.host).toBe(EMBED_HOST);
  });

  it("never puts a filesystem path in anything the browser receives", () => {
    const serialized = JSON.stringify([
      resolveLessonVideoSource(LOCAL),
      resolveLessonVideoSource(null),
    ]);
    expect(serialized).not.toContain("somewhere");
    expect(serialized).not.toContain("private");
    // No drive-letter path, and no absolute POSIX path rooted at a real
    // filesystem location. The one path-shaped value that IS allowed is the
    // same-origin route listed above, which is asserted exactly.
    expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
    expect(serialized).not.toMatch(/\/(home|Users|tmp|private|var|mnt|opt|root)\//);
  });
});

describe("local lesson file lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "horizon-lesson-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("reports nothing to stream when the file is absent, rather than a wrong path", () => {
    expect(findLocalLessonVideoFile(root)).toBeNull();
    expect(resolveServerLessonVideoSource(root).kind).toBe("embed");
  });

  it("finds the file by its known name and reports its real size", () => {
    writeFileSync(join(root, LESSON_VIDEO.localFileName), Buffer.alloc(2048, 1));
    const found = findLocalLessonVideoFile(root);
    expect(found).not.toBeNull();
    expect(found?.bytes).toBe(2048);
    const source = resolveServerLessonVideoSource(root);
    expect(source.kind).toBe("file");
    if (source.kind !== "file") throw new Error("unreachable");
    expect(source.bytes).toBe(2048);
  });

  it("does not treat an empty file as a playable recording", () => {
    const emptyRoot = mkdtempSync(join(tmpdir(), "horizon-lesson-empty-"));
    writeFileSync(join(emptyRoot, LESSON_VIDEO.localFileName), Buffer.alloc(0));
    expect(findLocalLessonVideoFile(emptyRoot)).toBeNull();
    rmSync(emptyRoot, { recursive: true, force: true });
  });
});

describe("byte range parsing", () => {
  const SIZE = 1000;

  it("treats an absent header as a full-file request", () => {
    expect(parseByteRange(null, SIZE)).toBeNull();
  });

  it("parses the ranges a video element actually sends", () => {
    expect(parseByteRange("bytes=0-", SIZE)).toEqual({ start: 0, end: 999 });
    expect(parseByteRange("bytes=500-999", SIZE)).toEqual({ start: 500, end: 999 });
    expect(parseByteRange("bytes=0-1", SIZE)).toEqual({ start: 0, end: 1 });
  });

  it("resolves a suffix range to the last n bytes", () => {
    expect(parseByteRange("bytes=-250", SIZE)).toEqual({ start: 750, end: 999 });
    expect(parseByteRange("bytes=-5000", SIZE)).toEqual({ start: 0, end: 999 });
  });

  it("clamps an over-long range instead of promising bytes that do not exist", () => {
    expect(parseByteRange("bytes=900-100000", SIZE)).toEqual({ start: 900, end: 999 });
  });

  it("reports a range that starts past the end as unsatisfiable, not as a 200", () => {
    expect(parseByteRange("bytes=1000-", SIZE)).toEqual("unsatisfiable");
    expect(parseByteRange("bytes=5000-6000", SIZE)).toEqual("unsatisfiable");
    expect(parseByteRange("bytes=500-100", SIZE)).toEqual("unsatisfiable");
    expect(parseByteRange("bytes=-0", SIZE)).toEqual("unsatisfiable");
  });

  it("ignores a malformed header rather than inventing a position", () => {
    expect(parseByteRange("bytes=", SIZE)).toBeNull();
    expect(parseByteRange("items=0-10", SIZE)).toBeNull();
    expect(parseByteRange("bytes=abc-def", SIZE)).toBeNull();
  });

  it("never returns a negative-length or empty range", () => {
    for (const header of ["bytes=0-", "bytes=999-", "bytes=-1", "bytes=10-20"]) {
      const parsed = parseByteRange(header, SIZE);
      if (parsed === null || parsed === "unsatisfiable") continue;
      expect(parsed.end).toBeGreaterThanOrEqual(parsed.start);
      expect(parsed.start).toBeGreaterThanOrEqual(0);
      expect(parsed.end).toBeLessThan(SIZE);
    }
  });
});

describe("playback clock", () => {
  it("formats real playback time, including past an hour", () => {
    expect(formatPlaybackClock(0)).toBe("00:00");
    expect(formatPlaybackClock(59.9)).toBe("00:59");
    expect(formatPlaybackClock(3599)).toBe("59:59");
    expect(formatPlaybackClock(3600)).toBe("1:00:00");
    // The measured duration of the selected recording.
    expect(formatPlaybackClock(LESSON_VIDEO.durationSeconds)).toBe("56:39");
  });

  it("refuses to print a number for a value no player reported", () => {
    expect(formatPlaybackClock(Number.NaN)).toBe("--:--");
    expect(formatPlaybackClock(-1)).toBe("--:--");
  });
});
