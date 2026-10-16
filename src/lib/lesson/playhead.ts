/**
 * Which lesson position a question is asked at, and what that position is.
 *
 * WHY THIS IS ITS OWN MODULE
 *   The playhead is the value that decides which evidence exists, so it must not
 *   be assembled inline in a component where nobody can test it. The rule is
 *   small enough to state completely:
 *
 *     1. When the recording's own player has reported a clock, that clock IS the
 *        position. Nothing else is consulted, so the number on screen, the number
 *        sent with the question and the number the eligibility boundary is
 *        computed from cannot disagree.
 *     2. When it has not (the embed's API failed to load, or the learner has not
 *        pressed play yet), the position is set by hand and LABELLED as manual.
 *        It is never quietly presented as playback time.
 *     3. The labelled synthetic sample keeps its own timeline and is never
 *        described as the recording's position.
 *
 * The position is clamped to the lesson's duration, so a stale device clock or a
 * player reporting past its own end can never ask for material the lesson does
 * not have.
 */

export type LessonCourseKind = "video" | "fixture";

export type PositionSource = "player" | "manual" | "fixture";

export interface LessonPosition {
  /** Seconds to send as `playheadSeconds`. Always within the lesson. */
  seconds: number;
  /** Where the number came from. Rendered verbatim, so it cannot be misread. */
  source: PositionSource;
  /** True only when the player itself reported this position. */
  fromPlayer: boolean;
  /** One sentence for the interface, stating what the number beside it is. */
  note: string;
}

export interface LessonPositionInput {
  courseKind: LessonCourseKind;
  /** The player's reported position, or null when it has reported nothing. */
  clockSeconds: number | null;
  /** The position set by hand when no clock is available. */
  manualSeconds: number;
  /** Lesson length in seconds, used to clamp. */
  durationSeconds: number;
}

function clamp(seconds: number, durationSeconds: number): number {
  if (!Number.isFinite(seconds)) return 0;
  const floor = Math.max(0, Math.floor(seconds));
  const ceiling = Number.isFinite(durationSeconds) && durationSeconds > 0
    ? Math.floor(durationSeconds)
    : floor;
  return Math.min(floor, ceiling);
}

export function resolveLessonPosition(input: LessonPositionInput): LessonPosition {
  const { courseKind, clockSeconds, manualSeconds, durationSeconds } = input;

  if (courseKind === "fixture") {
    return {
      seconds: clamp(manualSeconds, durationSeconds),
      source: "fixture",
      fromPlayer: false,
      note: "the labelled sample fixture's own timeline — not the recording's position",
    };
  }

  if (clockSeconds !== null && Number.isFinite(clockSeconds)) {
    return {
      seconds: clamp(clockSeconds, durationSeconds),
      source: "player",
      fromPlayer: true,
      note: "the player's own playback clock",
    };
  }

  return {
    seconds: clamp(manualSeconds, durationSeconds),
    source: "manual",
    fromPlayer: false,
    note: "set by hand, because no player has reported a clock in this session",
  };
}

/**
 * How much of the lesson is citable at a position, in one sentence.
 *
 * Stated because the rule is not the obvious one: a block unlocks at its END, so
 * a learner is never handed a passage they have not finished watching. Without
 * this sentence a citation that stops just short of the playhead looks like a
 * retrieval miss.
 */
export function describeEligibilityRule(position: LessonPosition): string {
  if (position.source === "player") {
    return "Answers may only use passages the recording has already reached — each block unlocks when you have watched it to its end.";
  }
  return "Answers may only use passages before this position — each block unlocks when the lesson has reached its end.";
}
