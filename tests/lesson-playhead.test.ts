import { describe, expect, it } from "vitest";
import { describeEligibilityRule, resolveLessonPosition } from "@/lib/lesson/playhead";

/**
 * The playhead policy: which number a question is asked at.
 *
 * This is the value that decides which evidence exists, so the rule is asserted
 * rather than left to the component. The cases below are exactly the ones that
 * would otherwise put a number on screen that no player reported.
 */

const VIDEO = { courseKind: "video", durationSeconds: 3399, manualSeconds: 0 } as const;

describe("resolveLessonPosition", () => {
  it("uses the player's clock when the player has reported one", () => {
    const position = resolveLessonPosition({ ...VIDEO, clockSeconds: 613.4 });
    expect(position.seconds).toBe(613);
    expect(position.source).toBe("player");
    expect(position.fromPlayer).toBe(true);
  });

  it("never reports a clock it does not have as a player position", () => {
    const position = resolveLessonPosition({ ...VIDEO, clockSeconds: null, manualSeconds: 1200 });
    expect(position.seconds).toBe(1200);
    expect(position.fromPlayer).toBe(false);
    expect(position.source).toBe("manual");
    // The wording is part of the contract: the number must not read as playback.
    expect(position.note).toMatch(/hand/);
  });

  it("does not treat zero as 'no clock' when a player really is at the start", () => {
    const position = resolveLessonPosition({ ...VIDEO, clockSeconds: 0, manualSeconds: 900 });
    expect(position.source).toBe("player");
    expect(position.seconds).toBe(0);
  });

  it("ignores a non-finite clock rather than answering from NaN", () => {
    const position = resolveLessonPosition({ ...VIDEO, clockSeconds: Number.NaN, manualSeconds: 300 });
    expect(position.seconds).toBe(300);
    expect(position.source).toBe("manual");
  });

  it("clamps to the lesson, so a question can never address material past its end", () => {
    expect(resolveLessonPosition({ ...VIDEO, clockSeconds: 999_999 }).seconds).toBe(3399);
    expect(
      resolveLessonPosition({ ...VIDEO, clockSeconds: null, manualSeconds: -50 }).seconds,
    ).toBe(0);
    // A stale or drifting player must not push the boundary past the recording.
    expect(resolveLessonPosition({ ...VIDEO, clockSeconds: 3400.9 }).seconds).toBe(3399);
  });

  it("never presents the synthetic sample's timeline as the recording's position", () => {
    const position = resolveLessonPosition({
      courseKind: "fixture",
      clockSeconds: 1200,
      manualSeconds: 360,
      durationSeconds: 900,
    });
    expect(position.source).toBe("fixture");
    expect(position.fromPlayer).toBe(false);
    expect(position.seconds).toBe(360);
    expect(position.note).toMatch(/not the recording/);
  });

  it("says which rule decides what an answer may use", () => {
    expect(
      describeEligibilityRule(resolveLessonPosition({ ...VIDEO, clockSeconds: 60 })),
    ).toMatch(/watched it to its end/);
    expect(
      describeEligibilityRule(resolveLessonPosition({ ...VIDEO, clockSeconds: null })),
    ).toMatch(/before this position/);
  });
});
