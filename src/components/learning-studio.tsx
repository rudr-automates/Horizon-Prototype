"use client";

/**
 * The learning studio.
 *
 * WHAT THIS REPLACES
 *   A single long page that put the recording, the evidence count, the assistant,
 *   the diagnostics and the runtime budget in one column, all of it looking like
 *   a status report. The capability was real; the product was not legible. This
 *   component keeps every honest behaviour and gives each one a surface:
 *
 *     Learn      the recording, its scope, the transcript and the assistant
 *     Materials  every source, its policy and its permitted text
 *     Notes      bookmarks and notes, stored in this browser
 *     Progress   watched coverage versus furthest position
 *     Status     provider, database, ledger and configuration facts
 *
 * WHAT IT DOES NOT DO
 *   No new answer path, no sampling change, no fabricated result, and no
 *   "Summarize so far" or "Quiz me" button: those actions are not implemented, so
 *   they are not on screen pretending to be. Diagnostics moved rather than
 *   multiplied — the status view renders the same public health projection the
 *   health endpoint returns, and the detailed operator report is not part of
 *   this page at all.
 *
 * ONE POSITION
 *   The position a question is asked at is the player's own clock whenever the
 *   player reported one, and the interface says so beside the number. The scope,
 *   transcript and materials panes refresh on a five-second boundary that is
 *   always at or BEFORE that clock, so a pane can lag a caption by a few seconds
 *   but can never reveal one the learner has not reached.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppShell, type SectionId, type ShellStatusTone } from "@/components/shell/app-shell";
import { AssistantPanel } from "@/components/lesson/assistant-panel";
import { LessonStage, type JumpPreset } from "@/components/lesson/lesson-stage";
import { ScopeBar } from "@/components/lesson/scope-bar";
import { TranscriptPanel } from "@/components/lesson/transcript-panel";
import { usePersonalData } from "@/components/lesson/use-personal-data";
import { MaterialsPanel, type CourseResource } from "@/components/materials/materials-panel";
import { NotesPanel } from "@/components/personal/notes-panel";
import { ProgressPanel } from "@/components/personal/progress-panel";
import { StatusPanel } from "@/components/status/status-panel";
import { Icon } from "@/components/ui/icons";
import { Alert } from "@/components/ui/alert";
import type { PublicHealthResponse } from "@/lib/contracts/http";
import type { TranscriptSegmentPayload } from "@/lib/contracts/lesson-view";
import type { CourseSummary, QuestionResponse, ScopeSummary } from "@/lib/contracts/question";
import {
  LESSON_VIDEO,
  LESSON_VIDEO_EVIDENCE,
  LESSON_VIDEO_SUGGESTED_QUESTIONS,
  formatPlaybackClock,
  type LessonVideoSource,
} from "@/lib/lesson/video";
import { resolveLessonPosition } from "@/lib/lesson/playhead";
import { watchedFraction, watchedSeconds } from "@/lib/personal/local-store";
import { segmentAt, type TranscriptSegment } from "@/lib/presentation/transcript-view";
import type { LessonVideoClockReport, SeekRequest } from "@/components/lesson-video";

/** How far the reading panes may trail the player, in seconds. */
const VIEW_BUCKET_SECONDS = 5;

const VIDEO_PRESETS: JumpPreset[] = [
  { seconds: 0, label: "Start" },
  { seconds: 600, label: "Labs" },
  { seconds: 1500, label: "Vector DBs" },
  { seconds: 2400, label: "RAG + graph" },
  { seconds: 3300, label: "MCP" },
];

const SAMPLE_PRESETS: JumpPreset[] = [
  { seconds: 0, label: "Start" },
  { seconds: 360, label: "Mid" },
  { seconds: 720, label: "End" },
];

export interface LearningStudioProps {
  videoCourse: CourseSummary | null;
  sampleCourse: CourseSummary | null;
  /** Which lesson a deep link asked for. Falls back to what is available. */
  initialLesson?: LessonView;
  /** Which surface a deep link asked for. */
  initialSection?: SectionId;
  /** A saved position to resume, from a real progress record. 0 means none. */
  initialSeconds?: number;
  /**
   * The PUBLIC health projection, built on the server. Null means it could not be
   * built. The detailed operator report is deliberately not passed here: a prop
   * to a client component is serialized into the page, which makes it public.
   */
  health: PublicHealthResponse | null;
  lessonVideo: LessonVideoSource;
  suggestedQuestions: string[];
  runtimeAiConfigured: boolean;
  embeddingCredentialPresent: boolean;
  /**
   * How many configuration problems exist, never which ones. The count is a
   * truthful warning a learner can act on; the names stay in the operator report
   * so they are not serialized into this page.
   */
  configurationProblemCount: number;
  evidenceSource: "supabase" | "fixture";
  evidenceReason: string;
  storeError: string | null;
}

type LessonView = "video" | "fixture";

export default function LearningStudio(props: LearningStudioProps) {
  const {
    videoCourse,
    sampleCourse,
    initialLesson,
    initialSection = "learn",
    initialSeconds = 0,
    health,
    lessonVideo,
    suggestedQuestions,
    runtimeAiConfigured,
    embeddingCredentialPresent,
    configurationProblemCount,
    evidenceSource,
    evidenceReason,
    storeError,
  } = props;

  // The Status refresh re-runs the server component, which rebuilds the report.
  const router = useRouter();
  const videoAvailable = videoCourse !== null;
  const [section, setSection] = useState<SectionId>(initialSection);
  const [view, setView] = useState<LessonView>(
    initialLesson ?? (videoAvailable ? "video" : "fixture"),
  );

  const activeCourse = view === "video" ? videoCourse : sampleCourse;
  const courseId = activeCourse?.courseId ?? "";
  const duration = activeCourse?.durationSeconds ?? 0;

  const [clock, setClock] = useState<LessonVideoClockReport | null>(null);
  // A carried position on the labelled sample is the sample's own timeline, so it
  // can be the initial value rather than an effect that writes state after mount.
  const [manualSeconds, setManualSeconds] = useState(
    initialLesson === "fixture" ? initialSeconds : 0,
  );
  const [seekRequest, setSeekRequest] = useState<SeekRequest | null>(null);
  /** Ticks on every seek so the transcript can follow a jump, and only a jump. */
  const [seekNonce, setSeekNonce] = useState(0);

  const [scope, setScope] = useState<ScopeSummary | null>(null);
  const [settledScopeKey, setSettledScopeKey] = useState<string | null>(null);

  const [materials, setMaterials] = useState<CourseResource[] | null>(null);
  const [materialsError, setMaterialsError] = useState<string | null>(null);

  const [transcript, setTranscript] = useState<TranscriptSegment[] | null>(null);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);
  const [highlightSegmentId, setHighlightSegmentId] = useState<string | null>(null);

  const [question, setQuestion] = useState(
    videoAvailable
      ? (LESSON_VIDEO_SUGGESTED_QUESTIONS[0] ?? "")
      : (suggestedQuestions[0] ?? ""),
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<QuestionResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);

  const [refreshToken, setRefreshToken] = useState(0);
  const healthFailed = health === null;
  const [bookmarkedAt, setBookmarkedAt] = useState<number | null>(null);

  const personal = usePersonalData();
  const { reportPlayback, resetPlaybackBaseline } = personal;

  const position = resolveLessonPosition({
    courseKind: view,
    clockSeconds: view === "video" ? (clock?.positionSeconds ?? null) : null,
    manualSeconds,
    durationSeconds: duration,
  });
  const playhead = position.seconds;
  const boundarySeconds = Math.floor(playhead / VIEW_BUCKET_SECONDS) * VIEW_BUCKET_SECONDS;

  const scopeKey = `${courseId}|${boundarySeconds}|${refreshToken}`;
  const scopePending = Boolean(courseId) && settledScopeKey !== scopeKey;

  const progress = courseId ? (personal.state.progress[courseId] ?? null) : null;
  const watched = watchedSeconds(progress?.watched ?? []);
  const progressFraction = watchedFraction(progress?.watched ?? [], duration);
  const courseBookmarks = useMemo(
    () => personal.state.bookmarks.filter((bookmark) => bookmark.courseId === courseId),
    [personal.state.bookmarks, courseId],
  );
  const courseNotes = useMemo(
    () => personal.state.notes.filter((note) => note.courseId === courseId),
    [personal.state.notes, courseId],
  );

  /* ---------------- Playback reporting ---------------- */

  // A playback report is only worth recording while the recording is the lesson
  // on screen: a report that arrives after a lesson switch belongs to the other
  // course and would credit it with time it never had.
  useEffect(() => {
    if (view !== "video" || clock === null || courseId === "") return;
    reportPlayback(courseId, clock.positionSeconds);
  }, [clock, view, courseId, reportPlayback]);

  useEffect(() => {
    if (bookmarkedAt === null) return;
    const timer = window.setTimeout(() => setBookmarkedAt(null), 5000);
    return () => window.clearTimeout(timer);
  }, [bookmarkedAt]);

  /* ---------------- Scope ---------------- */

  useEffect(() => {
    if (courseId === "") return;
    const controller = new AbortController();
    fetch(
      `/api/v1/courses/${encodeURIComponent(courseId)}/scope?playheadSeconds=${boundarySeconds}`,
      { cache: "no-store", signal: controller.signal },
    )
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
        if (!controller.signal.aborted) setSettledScopeKey(scopeKey);
      });
    return () => controller.abort();
  }, [courseId, boundarySeconds, refreshToken, scopeKey]);

  /* ---------------- Transcript ---------------- */

  useEffect(() => {
    if (courseId === "") return;
    const controller = new AbortController();
    fetch(
      `/api/v1/courses/${encodeURIComponent(courseId)}/transcript?playheadSeconds=${boundarySeconds}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const envelope = (await response.json()) as { error?: { message?: string } };
          throw new Error(envelope.error?.message ?? "The transcript could not be read.");
        }
        return (await response.json()) as { segments: TranscriptSegmentPayload[] };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setTranscript(payload.segments);
        setTranscriptError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setTranscriptError(
          cause instanceof Error ? cause.message : "The transcript could not be read.",
        );
      });
    return () => controller.abort();
  }, [courseId, boundarySeconds, refreshToken]);

  /* ---------------- Materials ---------------- */

  useEffect(() => {
    if (courseId === "") return;
    const controller = new AbortController();
    fetch(
      `/api/v1/courses/${encodeURIComponent(courseId)}/resources?playheadSeconds=${boundarySeconds}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const envelope = (await response.json()) as { error?: { message?: string } };
          throw new Error(envelope.error?.message ?? "The materials could not be read.");
        }
        return (await response.json()) as { resources: CourseResource[] };
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setMaterials(payload.resources);
        setMaterialsError(null);
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setMaterialsError(
          cause instanceof Error ? cause.message : "The materials could not be read.",
        );
      });
    return () => controller.abort();
  }, [courseId, boundarySeconds, refreshToken]);

  /* ---------------- Actions ---------------- */

  /**
   * A carried resume position is applied on the player's FIRST clock report.
   *
   * Not in an effect on mount: the recording has not necessarily loaded its
   * metadata by then, and a seek written before that is silently discarded by the
   * browser, which would leave a "resume" link that resumes nothing. Waiting for
   * the player to report a position means the seek lands on a player that can
   * accept it, and it happens exactly once.
   */
  const resumeApplied = useRef(false);
  function handleClock(report: LessonVideoClockReport | null): void {
    if (report !== null && !resumeApplied.current && initialSeconds > 0) {
      resumeApplied.current = true;
      seek(initialSeconds);
      // The carried position is consumed, so it is removed from the address bar.
      // Leaving it there would re-apply an old resume point on every refresh,
      // even after the learner has moved somewhere else.
      syncUrl({ start: null });
    }
    setClock(report);
  }

  function seek(seconds: number, options?: { play?: boolean; pause?: boolean }): void {
    const ceiling = Math.max(1, Math.floor(duration));
    const target = Math.max(0, Math.min(Math.round(seconds), ceiling));
    setSeekNonce((nonce) => nonce + 1);

    if (view === "fixture") {
      setManualSeconds(target);
      return;
    }
    setSeekRequest((previous) => ({
      seconds: target,
      nonce: (previous?.nonce ?? 0) + 1,
      ...(options?.play ? { play: true } : {}),
      ...(options?.pause ? { pause: true } : {}),
    }));
  }

  function switchView(next: LessonView): void {
    if (next === view) return;
    if (next === "video" && !videoAvailable) return;
    if (next === "fixture" && !sampleCourse) return;

    setView(next);
    setClock(null);
    setManualSeconds(0);
    setSeekRequest(null);
    setScope(null);
    setSettledScopeKey(null);
    setMaterials(null);
    setMaterialsError(null);
    setTranscript(null);
    setTranscriptError(null);
    setHighlightSegmentId(null);
    setResult(null);
    setRequestError(null);
    setAskedAt(null);
    setBookmarkedAt(null);
    setQuestion(
      next === "video"
        ? (LESSON_VIDEO_SUGGESTED_QUESTIONS[0] ?? "")
        : (suggestedQuestions[0] ?? ""),
    );
    resetPlaybackBaseline();

    // The lesson is part of the address, so the link on screen and the link a
    // learner copies agree. `replaceState` rather than a navigation: switching
    // lesson is not a new page in the history, and the back button should still
    // return to the page that led here.
    syncUrl({ lesson: next === "video" ? "recording" : "sample", start: null });
  }

  function navigate(next: SectionId): void {
    setSection(next);
    window.scrollTo({ top: 0, behavior: "auto" });
    // Same reasoning as the lesson switch: the surface is shareable and survives
    // a refresh, without adding a history entry per tab click.
    syncUrl({ section: next });
  }

  /** Write studio state into the address bar without navigating. */
  function syncUrl(changes: { lesson?: string; section?: string; start?: string | null }): void {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (changes.lesson !== undefined) url.searchParams.set("lesson", changes.lesson);
    if (changes.section !== undefined) url.searchParams.set("section", changes.section);
    if (changes.start !== undefined) {
      if (changes.start === null) url.searchParams.delete("start");
      else url.searchParams.set("start", changes.start);
    }
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
  }

  async function ask(): Promise<void> {
    if (courseId === "" || question.trim().length < 3) return;
    setPending(true);
    setRequestError(null);
    setAskedAt(playhead);
    setHighlightSegmentId(null);
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
    } catch {
      setResult(null);
      setRequestError("The request could not reach the server.");
    } finally {
      setPending(false);
    }
  }

  function bookmarkCurrent(): void {
    if (courseId === "" || view !== "video") return;
    personal.actions.addBookmarkAt(
      courseId,
      playhead,
      `Bookmark at ${formatPlaybackClock(playhead)}`, 
    );
    setBookmarkedAt(playhead);
  }

  function showInTranscript(evidenceId: string): void {
    setHighlightSegmentId(evidenceId);
    setSection("learn");
    window.setTimeout(() => {
      document
        .getElementById("transcript-panel")
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 30);
  }

  /* ---------------- Presentation facts ---------------- */

  const statusTone: ShellStatusTone = healthFailed
    ? "warn"
    : health === null
      ? "unknown"
      : health.status === "ok"
        ? "ok"
        : "warn";
  const statusLabel =
    health === null
      ? healthFailed
        ? "Status unavailable"
        : "Checking status"
      : health.status === "ok"
        ? "Service normal"
        : "Degraded";
  const statusShortLabel =
    health === null ? (healthFailed ? "Unknown" : "Checking") : statusTone === "ok" ? "Live" : "Attention";

  const suggestions =
    view === "video" ? [...LESSON_VIDEO_SUGGESTED_QUESTIONS] : suggestedQuestions;
  const presets = view === "video" ? VIDEO_PRESETS : SAMPLE_PRESETS;
  const canSeekCitation = view === "video" && (lessonVideo.kind === "file" || clock !== null);
  const currentSegment = transcript ? segmentAt(transcript, playhead) : null;

  if (!videoAvailable && !sampleCourse) {
    return (
      <AppShell
        active={section}
        onNavigate={navigate}
        courseTitle="No lesson available"
        courseDetail="The evidence store returned no course."
        lessonOptions={[]}
        activeLessonId=""
        onSelectLesson={() => undefined}
        statusTone={statusTone}
        statusLabel={statusLabel}
        statusShortLabel={statusShortLabel}
        statusDetail={evidenceReason}
      >
        <div className="mx-auto max-w-xl py-16">
          <Alert tone="danger" title="No lesson could be loaded">
            {storeError ??
              "The configured evidence source returned no course. Nothing is being approximated in its place."}
          </Alert>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell
      active={section}
      onNavigate={navigate}
      courseTitle={activeCourse?.title ?? "No lesson"}
      courseDetail={`${formatPlaybackClock(duration)} · ${
        evidenceSource === "supabase" ? "database evidence" : "sample fixture"
      }`}
      lessonOptions={[
        {
          id: videoCourse?.courseId ?? "recording",
          label: videoAvailable ? "Lesson recording" : "Lesson recording (not ingested)",
          disabled: !videoAvailable,
        },
        {
          id: sampleCourse?.courseId ?? "fixture",
          label: sampleCourse ? "Sample fixture (synthetic)" : "Sample fixture (unavailable)",
          disabled: !sampleCourse,
        },
      ]}
      activeLessonId={courseId}
      onSelectLesson={(id) => {
        if (id === videoCourse?.courseId) switchView("video");
        else if (id === sampleCourse?.courseId) switchView("fixture");
      }}
      statusTone={statusTone}
      statusLabel={statusLabel}
      statusShortLabel={statusShortLabel}
      statusDetail={
        health
          ? health.runtime.evidenceSource === "supabase"
            ? "Database-backed evidence"
            : "Sample fixture evidence"
          : healthFailed
            ? "The status report could not be built."
            : "The status report has not been built yet."
      }
    >
      {section === "learn" && (
        <div className="space-y-4">
          {storeError && (
            <Alert tone="danger" title="Database path unavailable">
              {storeError} Retrieval cannot run, so no answer can be produced. Nothing is
              being approximated.
            </Alert>
          )}

          {/* One notice, not three. A fixture deployment has no recording course,
              so its two conditions are the same fact and are stated once; the
              configuration detail lives on the status surface rather than
              pushing the lesson below three full-width warnings. */}
          {!videoAvailable && evidenceSource === "fixture" && (
            <Alert tone="warn" title="Sample evidence — the recording is not available here">
              This deployment runs on the labelled synthetic fixture, so nothing from
              the recording can be cited. The eligibility, citation and refusal path is
              running for real against that corpus; the lesson stage says which one.
            </Alert>
          )}

          {!videoAvailable && evidenceSource !== "fixture" && (
            <Alert tone="warn" title="The recording's transcript is not in this evidence store">
              This evidence store has no course for the lesson recording yet. Run the
              transcript ingest command against this database to add it. The recording
              still plays, but nothing in it can be cited.
            </Alert>
          )}

          {/* A configuration fault is stated without naming the setting: the names
              and any detail belong to the operator, and the detailed report is behind
              the token-protected endpoint rather than in this page. */}
          {configurationProblemCount > 0 && (
            <Alert tone="warn" title="This deployment is not fully configured">
              The assistant may refuse a question it could otherwise answer. The operator
              can read the specifics from the restricted diagnostics report.
            </Alert>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_23rem] xl:items-start 2xl:grid-cols-[minmax(0,1fr)_25rem]">
            <div className="order-1 min-w-0 xl:col-start-1 xl:row-start-1">
              <LessonStage
                view={view}
                source={lessonVideo}
                title={activeCourse?.title ?? ""}
                author={view === "video" ? LESSON_VIDEO.author : "Synthetic fixture"}
                watchUrl={view === "video" ? LESSON_VIDEO.watchUrl : null}
                durationSeconds={duration}
                playhead={playhead}
                clock={clock}
                positionNote={position.note}
                captionsIndexed={LESSON_VIDEO_EVIDENCE === "indexed"}
                seekRequest={view === "video" ? seekRequest : null}
                onClock={view === "video" ? handleClock : () => undefined}
                onSeek={seek}
                onBookmark={bookmarkCurrent}
                bookmarkedAt={bookmarkedAt}
                watchedSeconds={watched}
                progressFraction={progressFraction}
                presets={presets}
              />
            </div>

            <div className="order-2 min-w-0 xl:col-start-1 xl:row-start-2">
              <ScopeBar
                scope={scope}
                pending={scopePending}
                playhead={playhead}
                positionNote={position.note}
                materialCount={materials?.length ?? 0}
                onOpenMaterials={() => navigate("materials")}
              />
            </div>

            <div className="order-3 min-w-0 xl:col-start-2 xl:row-span-3 xl:row-start-1">
              <AssistantPanel
                question={question}
                onQuestionChange={setQuestion}
                onAsk={ask}
                pending={pending}
                result={result}
                requestError={requestError}
                suggestions={suggestions}
                playhead={playhead}
                askedAt={askedAt}
                canSeekCitation={canSeekCitation}
                onPlayCitation={(seconds) => seek(seconds, { play: true })}
                onShowInTranscript={showInTranscript}
                aiConfigured={runtimeAiConfigured}
                embeddingConfigured={embeddingCredentialPresent}
              />
            </div>

            <div className="order-4 min-w-0 xl:col-start-1 xl:row-start-3" id="transcript-panel">
              <TranscriptPanel
                segments={transcript ?? []}
                loading={transcript === null && transcriptError === null}
                error={transcriptError}
                playhead={playhead}
                highlightId={highlightSegmentId}
                seekNonce={seekNonce}
                onSeek={seek}
              />
              {currentSegment && (
                <p className="mt-1.5 px-1 text-[10px] text-ink-faint">
                  The player is inside the passage at{" "}
                  {formatPlaybackClock(currentSegment.startSeconds)}. The transcript shows
                  only captions the lesson has already reached.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {section === "materials" && (
        <MaterialsPanel
          courseId={courseId}
          playhead={playhead}
          boundarySeconds={boundarySeconds}
          resources={materials}
          loading={materials === null && materialsError === null}
          error={materialsError}
          isFixture={evidenceSource === "fixture"}
          onOpenLearn={() => navigate("learn")}
        />
      )}

      {section === "notes" && (
        <NotesPanel
          courseTitle={activeCourse?.title ?? ""}
          playhead={playhead}
          bookmarks={courseBookmarks}
          notes={courseNotes}
          ready={personal.ready}
          storageError={personal.storageError}
          onAddBookmark={(seconds, title) => {
            personal.actions.addBookmarkAt(courseId, seconds, title);
            seek(seconds);
          }}
          onRenameBookmark={personal.actions.renameBookmark}
          onRemoveBookmark={personal.actions.removeBookmark}
          onAddNote={(seconds, body) => personal.actions.addNoteAt(courseId, seconds, body)}
          onUpdateNote={personal.actions.updateNote}
          onRemoveNote={personal.actions.removeNote}
          onSeek={seek}
        />
      )}

      {section === "progress" && (
        <ProgressPanel
          courseTitle={activeCourse?.title ?? ""}
          durationSeconds={duration}
          playhead={playhead}
          progress={progress}
          noteCount={courseNotes.length}
          bookmarkCount={courseBookmarks.length}
          onSeek={seek}
        />
      )}

      {section === "status" && (
        <StatusPanel
          health={health}
          healthFailed={healthFailed}
          storeError={storeError}
          onRefresh={() => {
            setRefreshToken((token) => token + 1);
            // The operator report is server-rendered, so refreshing it means
            // re-running the page rather than re-fetching a public endpoint.
            router.refresh();
          }}
        />
      )}

      <footer className="mt-8 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4 text-[11px] text-ink-faint">
        <p className="flex items-center gap-1.5">
          <Icon name="info" size={12} />
          Evidence is filtered before it reaches the model. Refusals are reported as
          refusals.
        </p>
        <p>
          {evidenceSource === "supabase" ? "Supabase evidence" : "Sample fixture"} ·{" "}
          {formatPlaybackClock(duration)} lesson
        </p>
      </footer>
    </AppShell>
  );
}

