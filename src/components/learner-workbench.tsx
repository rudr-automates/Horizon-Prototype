"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CourseSummary,
  QuestionResponse,
  ScopeSummary,
} from "@/lib/contracts/question";
import type { HealthResponse } from "@/lib/contracts/http";
import {
  ANSWER_STATE_LABEL,
  ANSWER_STATE_TONE,
  TONE_CLASSES,
  reasonLabel,
} from "@/lib/presentation/answer-state";
import LessonVideo, { type LessonVideoClockReport, type SeekRequest } from "@/components/lesson-video";
import {
  LESSON_VIDEO,
  LESSON_VIDEO_EVIDENCE,
  LESSON_VIDEO_SUGGESTED_QUESTIONS,
  type LessonVideoSource,
} from "@/lib/lesson/video";
import { LESSON_TRANSCRIPT_SOURCE } from "@/lib/lesson/transcript";
import { describeEligibilityRule, resolveLessonPosition } from "@/lib/lesson/playhead";

/**
 * The learner interface.
 *
 * TWO LESSONS, NEVER BLURRED
 *   The primary lesson is the recording's own transcript: 56 timestamped blocks
 *   parsed from YouTube's automatic English captions for the selected video. The
 *   synthetic sample (an invented retry-and-backoff lesson) is selectable on its
 *   own, and every panel that could confuse the two states which one it is.
 *
 * ONE POSITION
 *   The position a question is asked at is the player's own playback clock
 *   whenever the player has reported one, and the interface says so beside the
 *   number. When no clock exists — the embed cannot load, or playback has not
 *   started — the position is set by hand and labelled as manual. It is never
 *   presented as playback time.
 *
 * COLOUR: every text element states its own colour. Nothing inherits a colour and
 * nothing is dimmed with `opacity-*`, because the previous build relied on both
 * and rendered white-on-white in a browser whose colour-scheme the app had never
 * pinned. See the contract at the top of `src/app/globals.css`.
 *
 * HONESTY: nothing on this page fabricates a result. Refusals, unavailability,
 * an absent credential and a silent scope refresh are each rendered as what they
 * are, and the status panel reports the same figures the health endpoint does.
 */
export interface LearnerWorkbenchProps {
  /** The recording's transcript course, when the evidence store has it. */
  videoCourse: CourseSummary | null;
  /** The labelled synthetic sample, when the evidence store has one. */
  sampleCourse: CourseSummary | null;
  /**
   * The lesson recording and where it can be played from. Resolved on the server
   * from what is really on disk, so the panel never claims a source this
   * deployment cannot produce.
   */
  lessonVideo: LessonVideoSource;
  suggestedQuestions: string[];
  runtimeAiConfigured: boolean;
  provider: string;
  textModel: string;
  embeddingProvider: string;
  embeddingCredentialPresent: boolean;
  configurationProblems: string[];
  evidenceSource: "supabase" | "fixture";
  evidenceReason: string;
  storeError: string | null;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

/**
 * Seek targets, chosen inside the recording's measured 56:39 and named for what
 * the transcript shows starting there — read off the ingested blocks, not
 * guessed. Each label is the section the timestamp actually begins.
 */
const VIDEO_SEEK_PRESETS = [0, 600, 1500, 2400, 3300] as const;
const VIDEO_PRESET_LABELS: Record<number, string> = {
  0: "Start",
  600: "Labs start",
  1500: "Vector DBs",
  2400: "RAG + graph",
  3300: "MCP",
};

/** The sample fixture's own timeline, unchanged: a different lesson. */
const SAMPLE_SEEK_PRESETS = [0, 360, 720] as const;
const SAMPLE_PRESET_LABELS: Record<number, string> = {
  0: "Start",
  360: "Mid",
  720: "End",
};

type LessonView = "video" | "fixture";

/**
 * Embedding-request usage, with the figure's scope stated rather than implied.
 *
 * The number must come from the store the cap is enforced in. When the cap is
 * durable, this process's counter is NOT the day's usage — it resets on every
 * restart — so showing it beside a durable cap would understate consumption and
 * make the remaining allowance look larger than it is.
 */
function describeEmbeddingRequests(runtime: HealthResponse["runtime"]): string {
  const cap =
    runtime.maxEmbeddingCalls === 0
      ? "no cap configured"
      : `cap ${runtime.maxEmbeddingCalls}`;

  if (runtime.embeddingCapMode !== "supabase") {
    return `${runtime.embeddingCalls} made in this process · ${cap}`;
  }
  if (runtime.embeddingRequestsToday === null) {
    return `unknown (the ledger could not be read) · ${cap}`;
  }
  return `${runtime.embeddingRequestsToday} made today · ${cap}`;
}

export default function LearnerWorkbench(props: LearnerWorkbenchProps) {
  const {
    videoCourse,
    sampleCourse,
    lessonVideo,
    suggestedQuestions,
    runtimeAiConfigured,
    provider,
    textModel,
    embeddingProvider,
    embeddingCredentialPresent,
    configurationProblems,
    evidenceSource,
    evidenceReason,
    storeError,
  } = props;

  const videoAvailable = videoCourse !== null;
  const [view, setView] = useState<LessonView>(videoAvailable ? "video" : "fixture");
  const activeCourse = view === "video" ? videoCourse : sampleCourse;
  const courseId = activeCourse?.courseId ?? "";
  const duration = activeCourse?.durationSeconds ?? 0;

  /** The player's own report. `null` means it reported nothing — not zero. */
  const [clock, setClock] = useState<LessonVideoClockReport | null>(null);
  const [manualSeconds, setManualSeconds] = useState(0);
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  /**
   * The slider's thumb while a seek is in flight. It is a REQUEST, not a
   * position, so the big clock never shows it: a scrub would otherwise print a
   * time the player has not reached as though playback had produced it.
   */
  const [seekPreview, setSeekPreview] = useState<number | null>(null);

  const [scope, setScope] = useState<ScopeSummary | null>(null);
  /**
   * Which scope request has SETTLED.
   *
   * "Refreshing…" is derived from this rather than set with a synchronous
   * setState at the top of an effect: that pattern cascades a render and is
   * rejected by the react-hooks lint rules. Comparing keys is exact — the key
   * changes the instant the playhead moves — so the indicator cannot get stuck.
   */
  const [settledScopeKey, setSettledScopeKey] = useState<string | null>(null);
  const [question, setQuestion] = useState(
    videoAvailable ? (LESSON_VIDEO_SUGGESTED_QUESTIONS[0] ?? "") : (suggestedQuestions[0] ?? ""),
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<QuestionResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [openCitation, setOpenCitation] = useState<number | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const resultRef = useRef<HTMLDivElement | null>(null);

  const position = resolveLessonPosition({
    courseKind: view,
    clockSeconds: view === "video" ? (clock?.positionSeconds ?? null) : null,
    manualSeconds,
    durationSeconds: duration,
  });
  const playhead = position.seconds;
  const playerClockLive = position.fromPlayer;

  const scopeRequestKey = `${courseId}|${playhead}|${refreshToken}`;
  const scopePending = Boolean(courseId) && settledScopeKey !== scopeRequestKey;

  // A seek request is dropped after a few seconds so a player that never moved
  // cannot leave the slider thumb stranded somewhere the clock disagrees with.
  // The other way a preview clears — the player arriving — is handled in the
  // clock callback itself, because that is an event rather than a reaction to
  // freshly rendered state.
  useEffect(() => {
    if (seekPreview === null) return;
    const timer = window.setTimeout(() => setSeekPreview(null), 4000);
    return () => window.clearTimeout(timer);
  }, [seekPreview]);

  /**
   * The player's report, and the moment a seek has visibly landed.
   *
   * `report === null` means the player has reported nothing, which is passed on
   * as null rather than as zero so no position can be invented from it.
   */
  function handleClock(report: LessonVideoClockReport | null): void {
    setClock(report);
    if (
      report !== null &&
      seekPreview !== null &&
      Math.abs(report.positionSeconds - seekPreview) < 2
    ) {
      setSeekPreview(null);
    }
  }

  // The scope indicator is informational: it is refreshed whenever the position
  // moves and after each answered turn. State is only touched after the request
  // settles, and a stale response is discarded on cleanup.
  useEffect(() => {
    if (!courseId) return;

    const controller = new AbortController();
    const url = `/api/v1/courses/${encodeURIComponent(courseId)}/scope?playheadSeconds=${playhead}`;

    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const next = (await response.json()) as ScopeSummary;
        if (controller.signal.aborted) return;
        setScope(next);
      })
      .catch(() => {
        /* a failed scope chip must never break the learning flow */
      })
      .finally(() => {
        if (!controller.signal.aborted) setSettledScopeKey(scopeRequestKey);
      });

    return () => controller.abort();
  }, [courseId, playhead, refreshToken, scopeRequestKey]);

  // The status panel reads the SAME endpoint an operator would, so it cannot
  // disagree with it.
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/v1/health", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as HealthResponse;
        if (controller.signal.aborted) return;
        setHealth(payload);
        setHealthFailed(false);
      })
      .catch(() => {
        if (!controller.signal.aborted) setHealthFailed(true);
      });
    return () => controller.abort();
  }, [refreshToken]);

  function seek(seconds: number, options?: { play?: boolean }): void {
    setSeekPreview(seconds);
    setSeekRequest((previous) => ({
      seconds,
      nonce: (previous?.nonce ?? 0) + 1,
      ...(options?.play ? { play: true } : {}),
    }));
  }

  function switchView(next: LessonView): void {
    if (next === view) return;
    setView(next);
    setResult(null);
    setRequestError(null);
    setOpenCitation(null);
    setScope(null);
    setManualSeconds(0);
    setSeekPreview(null);
    setQuestion(
      next === "video"
        ? (LESSON_VIDEO_SUGGESTED_QUESTIONS[0] ?? "")
        : (suggestedQuestions[0] ?? ""),
    );
  }

  async function ask() {
    if (!courseId || question.trim().length < 3) return;
    setPending(true);
    setRequestError(null);
    setOpenCitation(null);
    setAskedAt(playhead);
    try {
      const response = await fetch(
        `/api/v1/courses/${encodeURIComponent(courseId)}/questions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: question.trim(),
            playheadSeconds: playhead,
          }),
        },
      );
      const payload = (await response.json()) as unknown;
      if (!response.ok) {
        const envelope = payload as { error?: { message?: string } };
        setResult(null);
        setRequestError(envelope.error?.message ?? "The request failed.");
        return;
      }
      setResult(payload as QuestionResponse);
      setRefreshToken((token) => token + 1);
      requestAnimationFrame(() => {
        resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    } catch {
      setResult(null);
      setRequestError("The request could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  const generationReady = runtimeAiConfigured;
  const canAsk = Boolean(courseId) && question.trim().length >= 3 && !pending;
  const suggestions =
    view === "video" ? [...LESSON_VIDEO_SUGGESTED_QUESTIONS] : suggestedQuestions;
  const presets = view === "video" ? VIDEO_SEEK_PRESETS : SAMPLE_SEEK_PRESETS;
  const presetLabels = view === "video" ? VIDEO_PRESET_LABELS : SAMPLE_PRESET_LABELS;
  const sliderValue = seekPreview ?? playhead;

  return (
    <div className="min-h-screen">
      <a
        href="#ask"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-blue-700 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to the question box
      </a>

      {/* ---------------- Header ---------------- */}
      <header className="border-b border-slate-300 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-700 text-lg font-bold text-white"
            >
              H
            </span>
            <div>
              <p className="text-lg font-semibold leading-tight text-slate-900">
                Horizon
              </p>
              <p className="text-sm text-slate-600">
                Timestamp-aware, evidence-grounded learning assistant
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={evidenceSource === "supabase" ? "live" : "demo"}>
              Evidence: {evidenceSource === "supabase" ? "Supabase (live)" : "sample fixture"}
            </Pill>
            <Pill tone={generationReady ? "live" : "warn"}>
              {generationReady
                ? `Model: ${provider} · ${textModel}`
                : "Model: not configured"}
            </Pill>
            <Pill tone={embeddingCredentialPresent ? "live" : "warn"}>
              Embeddings: {embeddingProvider}
            </Pill>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6 lg:py-8">
        {/* ---------------- What this is ---------------- */}
        <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-6">
          <h1 className="text-2xl font-bold leading-tight text-slate-900 sm:text-3xl">
            Ask the lesson as far as you have watched.
          </h1>
          <p className="mt-2 max-w-3xl text-base text-slate-700">
            Horizon answers from the recording&rsquo;s own transcript and only up to
            your playback position. A passage the recording has not reached yet is
            not merely hidden from the reply — it never reaches the model.
          </p>

          <ol className="mt-4 grid gap-3 sm:grid-cols-3">
            <Step number="1" title="Retrieve">
              Both a keyword and a vector search run over the transcript, each
              filtered by the same eligibility predicate.
            </Step>
            <Step number="2" title="Generate claims">
              The model returns structured claims that must quote the evidence
              they cite, or nothing at all.
            </Step>
            <Step number="3" title="Verify support">
              Every citation id and quotation is checked, then each claim is
              re-read against its own evidence before it is shown.
            </Step>
          </ol>
        </section>

        {/* ---------------- Honest state notices ---------------- */}
        {storeError && (
          <Notice tone="error" title="Database path unavailable">
            <p>{storeError}</p>
            <p className="mt-1">
              Retrieval cannot run, so no answer can be produced. Nothing is being
              approximated.
            </p>
          </Notice>
        )}

        {!videoAvailable && (
          <Notice tone="warn" title="The recording's transcript is not in this evidence store">
            <p>
              {evidenceSource === "fixture"
                ? "This deployment is running on the labelled sample fixture, so the recording's transcript is not available to retrieve from."
                : "This evidence store has no course for the lesson recording yet. Run the transcript ingest command against this database to add it."}{" "}
              The recording still plays, but nothing in it can be cited until its
              transcript is ingested — and no answer below claims to come from it.
            </p>
            {videoCourse === null && evidenceSource === "supabase" && (
              <p className="mt-1 font-mono text-xs">
                pnpm ingest:lesson
              </p>
            )}
          </Notice>
        )}

        {evidenceSource === "fixture" && (
          <Notice tone="warn" title="Sample evidence — synthetic content, not the recording">
            <p>
              The only evidence store available is the labelled sample transcript,
              PDF, slide and code fixture, so the eligibility and citation flow can
              be demonstrated without a database. It is a different lesson from the
              recording above, and it is not an evaluated outcome.
            </p>
            <p className="mt-1">{evidenceReason}</p>
          </Notice>
        )}

        {!generationReady && (
          <Notice tone="warn" title="No model is configured, so no answer can be generated">
            <p>
              Retrieval, eligibility filtering and refusals still run for real. A
              question with eligible evidence returns a clearly-labelled
              unavailable state rather than an invented answer. Set{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[13px] text-slate-900">
                HORIZON_LLM_PROVIDER
              </code>{" "}
              and{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[13px] text-slate-900">
                HORIZON_LLM_API_KEY
              </code>{" "}
              server-side to enable generation.
            </p>
          </Notice>
        )}

        {!embeddingCredentialPresent && (
          <Notice tone="warn" title="No embedding credential is configured">
            <p>
              The stored transcript was embedded with a real model, so a question
              cannot be embedded into the same vector space. Turn will be refused
              rather than searched with a stand-in vector, which would return noise
              that still looks like a ranked list. Set{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[13px] text-slate-900">
                HORIZON_EMBEDDING_API_KEY
              </code>
              .
            </p>
          </Notice>
        )}

        {/* ---------------- The lesson recording ---------------- */}
        <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Lesson recording</h2>
            {LESSON_VIDEO_EVIDENCE === "indexed" ? (
              <span className="rounded border border-emerald-400 bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-900">
                Transcribed and indexed from its own captions
              </span>
            ) : (
              <span className="rounded border border-amber-400 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900">
                Not transcribed or indexed
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-700">
            <span className="font-medium text-slate-900">{LESSON_VIDEO.title}</span>{" "}
            · {LESSON_VIDEO.author} ·{" "}
            <a
              href={LESSON_VIDEO.watchUrl}
              className="font-medium text-blue-800 underline"
              target="_blank"
              rel="noreferrer"
            >
              original source
            </a>
          </p>

          <LessonVideo
            source={lessonVideo}
            onClock={view === "video" ? handleClock : undefined}
            seekRequest={view === "video" ? seekRequest : null}
          />

          {/* Where the evidence for this recording came from, and what it is not. */}
          <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3">
            <p className="text-sm font-semibold text-slate-900">
              Evidence source: {LESSON_TRANSCRIPT_SOURCE.label}
            </p>
            {LESSON_VIDEO_EVIDENCE === "indexed" ? (
              <>
                <p className="mt-1 text-sm text-slate-700">
                  The transcript above was downloaded from this recording&rsquo;s
                  own caption track and ingested verbatim, with the timestamps
                  YouTube reported for each caption line. No wording was cleaned
                  up, corrected or summarised.
                </p>
                <p className="mt-1 text-sm text-slate-700">
                  <strong>It is machine transcription.</strong>{" "}
                  {LESSON_TRANSCRIPT_SOURCE.caveat} Where the captions mis-hear a
                  word, that is what a quotation will show, because that is what
                  the recording&rsquo;s captions say.
                </p>
              </>
            ) : (
              <p className="mt-1 text-sm text-slate-700">
                Nothing from this recording can be cited, and no answer claims to
                come from it.
              </p>
            )}
          </div>
        </section>

        {/* ---------------- Lesson + Ask ---------------- */}
        <div className="grid gap-6 lg:grid-cols-2">
          <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-slate-900">Lesson position</h2>
              <span
                className={`rounded border px-2 py-0.5 text-xs font-semibold ${
                  view === "video"
                    ? "border-blue-300 bg-blue-50 text-blue-900"
                    : "border-amber-400 bg-amber-50 text-amber-900"
                }`}
              >
                {view === "video"
                  ? "the recording — transcript evidence"
                  : "sample fixture — synthetic, not the recording"}
              </span>
            </div>

            {/* Which lesson the question is about. Never implicit. */}
            <fieldset className="mt-3">
              <legend className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Lesson being asked about
              </legend>
              <div className="mt-1 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => switchView("video")}
                  disabled={!videoAvailable}
                  aria-pressed={view === "video"}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm font-semibold transition disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-500 ${
                    view === "video"
                      ? "border-blue-700 bg-blue-700 text-white"
                      : "border-slate-400 bg-white text-slate-900 hover:bg-slate-100"
                  }`}
                >
                  Lesson recording (real captions)
                </button>
                <button
                  type="button"
                  onClick={() => switchView("fixture")}
                  disabled={!sampleCourse}
                  aria-pressed={view === "fixture"}
                  className={`rounded-lg border px-3 py-1.5 text-left text-sm font-semibold transition disabled:cursor-not-allowed disabled:border-slate-300 disabled:bg-slate-100 disabled:text-slate-500 ${
                    view === "fixture"
                      ? "border-amber-600 bg-amber-600 text-white"
                      : "border-slate-400 bg-white text-slate-900 hover:bg-slate-100"
                  }`}
                >
                  Sample fixture (synthetic)
                </button>
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {activeCourse?.title ??
                  "No lesson is available from the configured evidence source."}
              </p>
            </fieldset>

            <div className="mt-4 rounded-lg border border-slate-300 bg-slate-50 p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <label
                  htmlFor="playhead"
                  className="text-xs font-semibold uppercase tracking-wide text-slate-600"
                >
                  {view === "video" ? "Playback position" : "Sample-fixture position"}
                </label>
                <output
                  htmlFor="playhead"
                  className="font-mono text-2xl font-semibold tabular-nums text-slate-900"
                >
                  {formatClock(playhead)}
                  <span className="ml-1 text-sm font-normal text-slate-500">
                    / {formatClock(duration)}
                  </span>
                </output>
              </div>

              <p className="mt-1 text-sm text-slate-700" data-testid="position-source">
                Source: {position.note}.
              </p>

              <input
                id="playhead"
                type="range"
                min={0}
                max={duration}
                step={1}
                value={Math.min(sliderValue, duration)}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  if (view === "video") seek(next);
                  else setManualSeconds(next);
                }}
                aria-describedby="playhead-help"
                className="mt-2 w-full cursor-pointer"
              />

              {view === "video" && !playerClockLive && (
                <p className="mt-2 rounded-lg border border-amber-400 bg-amber-50 p-2 text-xs font-medium text-amber-900">
                  The player has not reported a playback clock, so the position
                  above is the one set by this control and is labelled as manual.
                  Press play in the recording above to ask from its real position.
                </p>
              )}

              {view === "video" && seekPreview !== null && (
                <p className="mt-2 text-xs text-slate-600" role="status">
                  Seeking the player to {formatClock(seekPreview)} — the clock above
                  still shows real playback time.
                </p>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Jump to
                </span>
                {presets.map((preset) => {
                  const active = Math.floor(playhead) === preset;
                  return (
                    <button
                      key={preset}
                      type="button"
                      onClick={() => {
                        if (view === "video") seek(preset);
                        else setManualSeconds(preset);
                      }}
                      aria-pressed={active}
                      aria-label={`Jump to ${formatClock(preset)}`}
                      className={`rounded-lg border px-3 py-1.5 text-sm font-semibold transition ${
                        active
                          ? "border-blue-700 bg-blue-700 text-white"
                          : "border-slate-400 bg-white text-slate-900 hover:bg-slate-100"
                      }`}
                    >
                      <span className="font-mono tabular-nums">{formatClock(preset)}</span>
                      <span className="ml-1.5 font-normal">{presetLabels[preset]}</span>
                    </button>
                  );
                })}
              </div>

              <p id="playhead-help" className="mt-2 text-xs text-slate-600">
                {view === "video"
                  ? "Moving this control seeks the recording, and the position reported back is the player's own clock. "
                  : "Scrub the sample fixture's timeline; it belongs to the fixture, not to the recording. "}
                {describeEligibilityRule(position)}
              </p>
            </div>

            <div className="mt-4 rounded-lg border border-slate-300 bg-white p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                  Evidence in scope
                </span>
                <span className="font-mono text-2xl font-semibold tabular-nums text-slate-900">
                  {scope ? scope.eligibleBlockCount : "—"}
                </span>
              </div>
              <p className="mt-0.5 text-sm text-slate-700">
                eligible transcript block{scope?.eligibleBlockCount === 1 ? "" : "s"} at{" "}
                <span className="font-mono">{formatClock(playhead)}</span>
              </p>
              {scopePending && (
                <p className="mt-1 text-xs text-slate-600" role="status">
                  Refreshing the count…
                </p>
              )}
              <p className="mt-2 border-t border-slate-200 pt-2 font-mono text-xs text-slate-600">
                {scope?.policySummary ??
                  `Lesson through ${formatClock(playhead)} · approved course-wide references enabled`}
              </p>
            </div>
          </section>

          <section
            id="ask"
            className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5"
          >
            <h2 className="text-lg font-semibold text-slate-900">
              Ask about this moment
            </h2>
            <p className="mt-1 text-sm text-slate-700">
              {view === "video" ? (
                <>
                  Answers may only use the recording&rsquo;s transcript up to{" "}
                  <span className="font-mono">{formatClock(playhead)}</span>
                  {position.fromPlayer ? ", taken from the player's own clock" : ", set by hand"}.
                  Each block unlocks when the recording has reached its end.
                </>
              ) : (
                <>
                  Answers may only use the <strong>labelled sample fixture</strong>{" "}
                  up to <span className="font-mono">{formatClock(playhead)}</span> —
                  not the recording, whose evidence is in the other lesson.
                </>
              )}
            </p>

            <label
              htmlFor="question"
              className="mt-4 block text-xs font-semibold uppercase tracking-wide text-slate-600"
            >
              Your question
            </label>
            <textarea
              id="question"
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              maxLength={500}
              placeholder={
                view === "video"
                  ? "e.g. What does the instructor say about the compliance score threshold?"
                  : "e.g. What backoff constant does the instructor choose?"
              }
              className="mt-1 w-full resize-y rounded-lg border border-slate-400 bg-white p-3 text-sm text-slate-900 placeholder:text-slate-500 focus:border-blue-700"
            />

            <div className="mt-2 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                Examples
              </span>
              {suggestions.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => setQuestion(suggestion)}
                  className="rounded-lg border border-slate-400 bg-white px-2.5 py-1.5 text-left text-xs text-slate-800 hover:bg-slate-100"
                >
                  {suggestion.length > 52 ? `${suggestion.slice(0, 52)}…` : suggestion}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => void ask()}
              disabled={!canAsk}
              className="mt-4 w-full rounded-lg bg-blue-700 px-4 py-3 text-base font-semibold text-white shadow-sm transition hover:bg-blue-800 disabled:cursor-not-allowed disabled:bg-slate-400"
            >
              {pending ? "Working — retrieving and verifying…" : `Ask at ${formatClock(playhead)}`}
            </button>

            {question.trim().length < 3 && (
              <p className="mt-2 text-xs text-slate-600">
                Enter at least 3 characters to enable the button.
              </p>
            )}

            {requestError && (
              <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm font-medium text-rose-900">
                {requestError}
              </p>
            )}
          </section>
        </div>

        {/* ---------------- Answer ---------------- */}
        <section ref={resultRef} aria-live="polite" aria-busy={pending}>
          {pending && (
            <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
              <p className="text-sm font-semibold text-slate-900">
                Resolving scope, filtering evidence, generating claims and
                verifying support…
              </p>
              <p className="mt-1 text-sm text-slate-700">
                This makes two model calls (generation, then verification) and both
                are metered against the daily budget before they are sent.
              </p>
            </div>
          )}

          {!pending && result && (
            <div className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded border px-2.5 py-1 text-sm font-semibold ${
                    TONE_CLASSES[ANSWER_STATE_TONE[result.answerState]]
                  }`}
                >
                  {ANSWER_STATE_LABEL[result.answerState]}
                </span>
                <span className="text-sm text-slate-700">
                  asked at{" "}
                  <span className="font-mono">
                    {formatClock(askedAt ?? result.scope.boundarySeconds)}
                  </span>
                </span>
                <span className="text-sm text-slate-700">
                  {result.evidence.payloadCount} eligible block
                  {result.evidence.payloadCount === 1 ? "" : "s"} in the payload
                  {result.evidence.generator === null ? " (no model call was made)" : ""}
                </span>
                <span className="text-sm text-slate-700">
                  server time <span className="font-mono">{result.latencyMs} ms</span>
                </span>
              </div>

              {result.message && (
                <p className="mt-3 rounded-lg border border-slate-300 bg-slate-50 p-3 text-sm text-slate-900">
                  {result.message}
                </p>
              )}

              {result.answerState === "TEMPORARILY_UNAVAILABLE" && (
                <p className="mt-2 text-sm text-slate-700">
                  Reason: <strong>{reasonLabel(result.reason)}</strong>{" "}
                  <span className="font-mono text-xs text-slate-600">
                    ({result.reason})
                  </span>
                  . Nothing was invented to fill the gap — see the status panel below
                  for the exact provider and budget state.
                </p>
              )}

              {result.answerState === "INSUFFICIENT_EVIDENCE" && (
                <p className="mt-2 text-sm text-slate-700">
                  No eligible passage supports this question. That can mean the
                  recording has not reached the part that covers it yet, or that the
                  transcript does not cover it at all — and this interface cannot
                  tell you which without disclosing material you have not watched.
                </p>
              )}

              {result.claims.length > 0 && (
                <ol className="mt-4 space-y-4">
                  {result.claims.map((claim, claimIndex) => (
                    <li
                      key={claimIndex}
                      className="rounded-lg border border-slate-200 bg-slate-50 p-3"
                    >
                      <p className="text-base text-slate-900">{claim.text}</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-wide text-slate-600">
                          Sources
                        </span>
                        {claim.citations.map((citation) => {
                          const flatIndex = result.citations.findIndex(
                            (item) =>
                              item.evidenceId === citation.evidenceId &&
                              item.quote === citation.quote,
                          );
                          const open = openCitation === flatIndex;
                          return (
                            <button
                              key={`${citation.evidenceId}-${flatIndex}`}
                              type="button"
                              aria-expanded={open}
                              onClick={() => setOpenCitation(open ? null : flatIndex)}
                              className={`rounded-lg border px-2.5 py-1 font-mono text-xs font-semibold transition ${
                                open
                                  ? "border-blue-700 bg-blue-700 text-white"
                                  : "border-blue-300 bg-blue-50 text-blue-900 hover:bg-blue-100"
                              }`}
                            >
                              {citation.sourceLabel}
                            </button>
                          );
                        })}
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              {/* Inspectable source: the exact text and where it came from. */}
              {openCitation !== null && result.citations[openCitation] && (
                <div
                  className="mt-4 rounded-lg border-2 border-blue-700 bg-blue-50 p-4"
                  data-testid="citation-panel"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-mono text-sm font-semibold text-blue-900">
                      {result.citations[openCitation].sourceLabel}
                      {result.citations[openCitation].policy === "COURSE_WIDE"
                        ? " · course-wide"
                        : " · timeline-bound"}
                    </span>
                    <div className="flex flex-wrap items-center gap-2">
                      {view === "video" &&
                        lessonVideo.kind === "file" &&
                        result.citations[openCitation].startSeconds !== null && (
                          <button
                            type="button"
                            onClick={() =>
                              seek(
                                Math.max(
                                  0,
                                  Number(result.citations[openCitation].startSeconds) - 3,
                                ),
                                { play: true },
                              )
                            }
                            className="rounded border border-blue-700 bg-white px-2 py-0.5 text-xs font-semibold text-blue-900 hover:bg-blue-100"
                          >
                            Play this passage
                          </button>
                        )}
                      <button
                        type="button"
                        onClick={() => setOpenCitation(null)}
                        className="rounded border border-blue-700 px-2 py-0.5 text-xs font-semibold text-blue-900 hover:bg-blue-100"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  <p className="mt-2 font-mono text-xs text-slate-800">
                    evidence id: {result.citations[openCitation].evidenceId}
                    {result.citations[openCitation].startSeconds !== null
                      ? ` · ${formatClock(Number(result.citations[openCitation].startSeconds))}–${formatClock(
                          Number(result.citations[openCitation].endSeconds),
                        )}`
                      : ""}
                    {result.citations[openCitation].pageNumber !== null
                      ? ` · page ${result.citations[openCitation].pageNumber}`
                      : ""}
                    {result.citations[openCitation].slideNumber !== null
                      ? ` · slide ${result.citations[openCitation].slideNumber}`
                      : ""}
                    {result.citations[openCitation].lineStart !== null
                      ? ` · caption lines ${result.citations[openCitation].lineStart}–${result.citations[openCitation].lineEnd}`
                      : ""}
                    {` · type ${result.citations[openCitation].blockType}`}
                  </p>
                  <blockquote className="mt-2 border-l-4 border-blue-700 bg-white p-3 text-sm italic text-slate-900">
                    “{result.citations[openCitation].quote}”
                  </blockquote>
                  <p className="mt-2 text-xs text-slate-700">
                    This quotation was matched verbatim against the stored{" "}
                    {result.citations[openCitation].blockType === "transcript"
                      ? "caption block"
                      : result.citations[openCitation].blockType === "pdf"
                        ? "page text"
                        : result.citations[openCitation].blockType === "ppt"
                          ? "slide text"
                          : "block"}{" "}
                    before the claim was renderable.{" "}
                    {result.citations[openCitation].blockType === "transcript"
                      ? "The timestamps are the caption source’s own."
                      : result.citations[openCitation].policy === "COURSE_WIDE"
                        ? "This is approved reference material, so it is available at every playhead; it carries no clock to play from."
                        : "This block unlocks when the recording reaches the passage it belongs to."}
                  </p>
                </div>
              )}

              <details className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <summary className="cursor-pointer text-sm font-semibold text-slate-900">
                  Turn details
                </summary>
                <dl className="mt-3 grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[minmax(0,11rem)_1fr]">
                  <Field label="Lesson asked about">
                    {activeCourse?.title ?? "(none)"}
                  </Field>
                  <Field label="Position source">{position.note}</Field>
                  <Field label="Answer state">{result.answerState}</Field>
                  <Field label="Reason code">{result.reason}</Field>
                  <Field label="Meaning">{reasonLabel(result.reason)}</Field>
                  <Field label="Evidence source">{result.evidence.source}</Field>
                  <Field label="Embedding in use">
                    {result.evidence.embeddingProvider} ({result.provenance.embeddingDimensions}d)
                  </Field>
                  <Field label="Generator">
                    {result.evidence.generator ?? "none (not configured)"}
                  </Field>
                  <Field label="Verifier">
                    {result.evidence.verifier ?? "none (not configured)"} (
                    {result.provenance.verification})
                  </Field>
                  <Field label="Turn stored">
                    {result.persistence.persisted ? "yes" : "no"} —{" "}
                    {result.persistence.detail}
                  </Field>
                  <Field label="Spend guard">{result.guard.detail}</Field>
                  <Field label="Request id">
                    <span className="font-mono text-xs">{result.requestId}</span>
                  </Field>
                </dl>
              </details>
            </div>
          )}
        </section>

        {/* ---------------- Status and diagnostics ---------------- */}
        <section className="rounded-xl border border-slate-300 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold text-slate-900">
              Runtime and data status
            </h2>
            <span className="rounded border border-slate-300 bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700">
              Names and counts only — no secrets
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-700">
            Read live from <span className="font-mono text-xs">/api/v1/health</span>,
            the same source an operator would consult.
          </p>

          {healthFailed && (
            <p className="mt-3 rounded-lg border border-amber-400 bg-amber-50 p-3 text-sm font-medium text-amber-900">
              The status endpoint could not be read, so the figures below are
              unavailable rather than zero.
            </p>
          )}

          {!healthFailed && !health && (
            <p className="mt-3 text-sm text-slate-700" role="status">
              Loading status…
            </p>
          )}

          {health && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <StatusCard title="Generation provider">
                <Field label="Provider">{health.runtime.provider}</Field>
                <Field label="Text model">{health.runtime.textModel}</Field>
                <Field label="Configured">
                  {health.checks.runtimeAi.configured ? "yes" : "no"}
                </Field>
                {/*
                  Not "reachable", and not a hardcoded yes: this is what the
                  ledger can still prove about a completed call, including when
                  that record was made. A deployment whose credential stopped
                  working reads `none_recorded` however healthy the names look.
                */}
                <Field label="Completed provider call">
                  {health.runtime.providerCallEvidence.state === "observed"
                    ? `yes — ${health.runtime.providerCallEvidence.detail}`
                    : health.runtime.providerCallEvidence.detail}
                </Field>
              </StatusCard>

              <StatusCard title="Embeddings">
                <Field label="Model">{health.runtime.embeddingModel}</Field>
                <Field label="In use">{health.runtime.embeddingProvider}</Field>
                <Field label="Dimensions">{health.runtime.embeddingDimensions}</Field>
                <Field label="Credential present">
                  {health.runtime.embeddingCredentialPresent ? "yes" : "no"}
                </Field>
              </StatusCard>

              <StatusCard title="Evidence source">
                <Field label="Source">{health.runtime.evidenceSource}</Field>
                <Field label="Synthetic content">
                  {health.runtime.demoContent ? "yes" : "no"}
                </Field>
                <Field label="Detail">{health.runtime.evidenceReason}</Field>
              </StatusCard>

              <StatusCard title="Database">
                <Field label="Configured">
                  {health.checks.database.configured ? "yes" : "no"}
                </Field>
                <Field label="Authenticated read">
                  {health.checks.database.querySucceeded === null
                    ? "not attempted"
                    : health.checks.database.querySucceeded
                      ? "succeeded"
                      : "failed"}
                </Field>
                <Field label="Schema objects">{health.checks.database.schemaObjects}</Field>
                <Field label="Budget ledger">{health.checks.database.durableLedger}</Field>
                <Field label="Detail">{health.checks.database.detail}</Field>
              </StatusCard>

              <StatusCard title="Spend guard">
                <Field label="Next call">
                  {health.runtime.spendGuard === "blocked"
                    ? "would be refused"
                    : "would be permitted"}
                </Field>
                <Field label="Tokens today">
                  {health.runtime.spentTokensToday === null
                    ? "unknown (the ledger could not be read)"
                    : `${health.runtime.spentTokensToday} of a daily ceiling`}
                </Field>
                <Field label="Ledger mode">{health.runtime.usageMode}</Field>
                <Field label="Embedding requests">
                  {describeEmbeddingRequests(health.runtime)}
                </Field>
              </StatusCard>

              <StatusCard title="Service">
                <Field label="Overall">{health.status}</Field>
                <Field label="Version">{health.version}</Field>
                <Field label="Checked at">
                  <span className="font-mono text-xs">{health.timestamp}</span>
                </Field>
                <Field label="Request id">
                  <span className="font-mono text-xs">{health.requestId}</span>
                </Field>
              </StatusCard>
            </div>
          )}

          {configurationProblems.length > 0 && (
            <div className="mt-4 rounded-lg border border-amber-400 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-900">
                Configuration problems to fix
              </p>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-amber-900">
                {configurationProblems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <footer className="border-t border-slate-300 pt-4 text-sm text-slate-700">
          <p>
            Retrieval, eligibility filtering, citation checking and refusal
            behaviour run for real. Answers require a configured model provider; no
            fallback fabricates them, and a provider failure is reported as
            unavailable rather than dressed up as an answer.
          </p>
        </footer>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Small presentation pieces. Explicit colours only.
 * ------------------------------------------------------------------ */

function Pill({
  tone,
  children,
}: {
  tone: "live" | "demo" | "warn";
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    live: "border-emerald-400 bg-emerald-50 text-emerald-900",
    demo: "border-sky-400 bg-sky-50 text-sky-900",
    warn: "border-amber-400 bg-amber-50 text-amber-900",
  };
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${styles[tone]}`}
    >
      {children}
    </span>
  );
}

function Step({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="flex items-center gap-2 text-sm font-semibold text-slate-900">
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-900 text-xs font-bold text-white"
        >
          {number}
        </span>
        {title}
      </p>
      <p className="mt-1 text-sm text-slate-700">{children}</p>
    </li>
  );
}

function Notice({
  tone,
  title,
  children,
}: {
  tone: "warn" | "error";
  title: string;
  children: React.ReactNode;
}) {
  const tones = {
    warn: "border-amber-400 bg-amber-50 text-amber-900",
    error: "border-rose-400 bg-rose-50 text-rose-900",
  } as const;
  return (
    <div className={`rounded-xl border p-4 text-sm ${tones[tone]}`} role="status">
      <p className="text-base font-semibold">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function StatusCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      <dl className="mt-2 space-y-1">{children}</dl>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[minmax(0,10rem)_1fr]">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-600">
        {label}
      </dt>
      <dd className="text-sm text-slate-900">{children}</dd>
    </div>
  );
}
