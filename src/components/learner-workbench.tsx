"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CourseSummary,
  QuestionResponse,
  ScopeSummary,
} from "@/lib/contracts/question";
import {
  ANSWER_STATE_LABEL,
  ANSWER_STATE_TONE,
  TONE_CLASSES,
} from "@/lib/presentation/answer-state";

export interface LearnerWorkbenchProps {
  course: CourseSummary | null;
  suggestedQuestions: string[];
  runtimeAiConfigured: boolean;
  textModel: string;
  embeddingProvider: string;
  embeddingDimensions: number;
  evidenceSource: "supabase" | "fixture";
  evidenceReason: string;
  storeError: string | null;
}

function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}



export default function LearnerWorkbench(props: LearnerWorkbenchProps) {
  const {
    course,
    suggestedQuestions,
    runtimeAiConfigured,
    textModel,
    embeddingProvider,
    embeddingDimensions,
    evidenceSource,
    evidenceReason,
    storeError,
  } = props;

  const duration = course?.durationSeconds ?? 900;
  const courseId = course?.courseId ?? "";

  const [playhead, setPlayhead] = useState(0);
  const [scope, setScope] = useState<ScopeSummary | null>(null);
  const [question, setQuestion] = useState(suggestedQuestions[0] ?? "");
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<QuestionResponse | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [openCitation, setOpenCitation] = useState<number | null>(null);
  const [askedAt, setAskedAt] = useState<number | null>(null);
  const [scopeRefreshToken, setScopeRefreshToken] = useState(0);
  const resultRef = useRef<HTMLDivElement | null>(null);

  // The scope chip is informational: it is refreshed whenever the playhead
  // moves and after each answered turn. State is only touched after the
  // request settles, and a stale response is discarded on cleanup.
  useEffect(() => {
    if (!courseId) return;

    const controller = new AbortController();
    const url = `/api/v1/courses/${encodeURIComponent(courseId)}/scope?playheadSeconds=${Math.floor(playhead)}`;

    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const next = (await response.json()) as ScopeSummary;
        if (controller.signal.aborted) return;
        setScope(next);
      })
      .catch(() => {
        /* a failed scope chip must never break the learning flow */
      });

    return () => controller.abort();
  }, [courseId, playhead, scopeRefreshToken]);

  async function ask() {
    if (!courseId || question.trim().length < 3) return;
    setPending(true);
    setRequestError(null);
    setOpenCitation(null);
    setAskedAt(Math.floor(playhead));
    try {
      const response = await fetch(
        `/api/v1/courses/${encodeURIComponent(courseId)}/questions`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question: question.trim(),
            playheadSeconds: Math.floor(playhead),
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
      setScopeRefreshToken((token) => token + 1);
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

  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Horizon</h1>
          <p className="text-sm opacity-75">
            Timestamp-aware, evidence-grounded learning assistant
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Badge tone={evidenceSource === "supabase" ? "live" : "demo"}>
            Evidence: {evidenceSource === "supabase" ? "Supabase (live)" : "sample fixture corpus"}
          </Badge>
          <Badge tone={runtimeAiConfigured ? "live" : "warn"}>
            {runtimeAiConfigured
              ? `Runtime AI: ${textModel} (not smoke-tested)`
              : "Runtime AI: not configured"}
          </Badge>
          <Badge tone={embeddingProvider === "synthetic-lexical-v1" ? "demo" : "live"}>
            Embeddings in use: {embeddingProvider} ({embeddingDimensions}d)
          </Badge>
        </div>
      </header>

      {evidenceSource === "fixture" && (
        <Notice title="Sample timeline simulation — synthetic demo content">
          <p>
            There is no lesson video. This view uses a labelled 15-minute sample
            transcript, PDF, slide and code fixture so the eligibility and
            citation flow can be demonstrated. It is not real learner content and
            not an evaluated outcome.
          </p>
          <p className="mt-1 opacity-80">{evidenceReason}</p>
        </Notice>
      )}

      {storeError && (
        <Notice title="Database path unavailable">
          <p className="text-rose-800">{storeError}</p>
        </Notice>
      )}

      {!runtimeAiConfigured && (
        <Notice title="Runtime AI is not configured">
          <p>
            No credential is set, so no answer can be generated. Retrieval,
            eligibility filtering and refusals still run for real; any question
            that has eligible evidence will return a
            temporarily-unavailable state rather than an invented answer. Set{" "}
            <code className="rounded bg-black/10 px-1">HORIZON_LLM_API_KEY</code>{" "}
            server-side to enable generation.
          </p>
        </Notice>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ---------------- Lesson column ---------------- */}
        <section className="rounded-xl border border-black/10 p-4">
          <h2 className="text-base font-medium">Lesson</h2>
          <p className="mt-1 text-sm opacity-80">
            {course?.title ?? "No course is available."}
          </p>

          <div className="mt-4">
            <label htmlFor="playhead" className="text-xs font-medium uppercase opacity-70">
              Playback position
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                id="playhead"
                type="range"
                min={0}
                max={duration}
                step={1}
                value={playhead}
                onChange={(event) => setPlayhead(Number(event.target.value))}
                className="w-full accent-sky-600"
              />
              <span className="w-16 text-right font-mono text-sm">
                {formatClock(playhead)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {[0, 360, 720].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setPlayhead(preset)}
                  className="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
                >
                  {formatClock(preset)}
                </button>
              ))}
              <span className="self-center text-xs opacity-60">
                Try the same question at 06:00 and again at 12:00
              </span>
            </div>
          </div>

          <div className="mt-4 rounded-lg bg-black/5 p-3 text-sm">
            <div className="text-xs font-medium uppercase opacity-70">Scope</div>
            <p className="mt-1 font-mono text-xs">
              {scope?.policySummary ??
                `Lesson through ${formatClock(playhead)} · approved course-wide references enabled`}
            </p>
            {scope && (
              <p className="mt-1 text-xs opacity-70">
                {scope.eligibleBlockCount} evidence block
                {scope.eligibleBlockCount === 1 ? "" : "s"} currently eligible
              </p>
            )}
          </div>
        </section>

        {/* ---------------- Ask column ---------------- */}
        <section className="rounded-xl border border-black/10 p-4">
          <h2 className="text-base font-medium">Ask about this moment</h2>

          <label htmlFor="question" className="mt-2 block text-xs font-medium uppercase opacity-70">
            Question
          </label>
          <textarea
            id="question"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={2}
            maxLength={500}
            className="mt-1 w-full resize-y rounded-lg border border-black/15 bg-transparent p-2 text-sm"
          />

          <div className="mt-2 flex flex-wrap gap-2">
            {suggestedQuestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => setQuestion(suggestion)}
                className="rounded border border-black/15 px-2 py-1 text-xs hover:bg-black/5"
              >
                {suggestion.length > 44 ? `${suggestion.slice(0, 44)}…` : suggestion}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void ask()}
            disabled={pending || !courseId || question.trim().length < 3}
            className="mt-3 w-full rounded-lg bg-sky-700 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {pending ? "Retrieving eligible evidence…" : `Ask at ${formatClock(playhead)}`}
          </button>

          {requestError && (
            <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-2 text-sm text-rose-900">
              {requestError}
            </p>
          )}
        </section>
      </div>

      {/* ---------------- Answer ---------------- */}
      <section ref={resultRef} className="mt-6" aria-live="polite">
        {pending && (
          <div className="rounded-xl border border-black/10 p-4 text-sm opacity-70">
            Resolving scope, filtering evidence, generating claims and verifying
            support…
          </div>
        )}

        {!pending && result && (
          <div className="rounded-xl border border-black/10 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`rounded border px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[ANSWER_STATE_TONE[result.answerState]]}`}
              >
                {ANSWER_STATE_LABEL[result.answerState]}
              </span>
              <span className="text-xs opacity-70">
                asked at {formatClock(askedAt ?? result.scope.boundarySeconds)}
              </span>
              <span className="text-xs opacity-70">
                {result.evidence.payloadCount} eligible block
                {result.evidence.payloadCount === 1 ? "" : "s"} in the evidence payload
                {result.evidence.generator === null ? " (no model call was made)" : ""}
              </span>
              <span className="text-xs opacity-70">
                server time {result.latencyMs} ms (measured, not a benchmark)
              </span>
            </div>

            {result.message && (
              <p className="mt-3 rounded-lg bg-black/5 p-3 text-sm">{result.message}</p>
            )}

            {result.claims.length > 0 && (
              <ul className="mt-4 space-y-4">
                {result.claims.map((claim, claimIndex) => (
                  <li key={claimIndex} className="text-sm">
                    <p>{claim.text}</p>
                    <div className="mt-1 flex flex-wrap gap-2">
                      {claim.citations.map((citation) => {
                        const flatIndex = result.citations.findIndex(
                          (item) =>
                            item.evidenceId === citation.evidenceId &&
                            item.quote === citation.quote,
                        );
                        return (
                          <button
                            key={`${citation.evidenceId}-${flatIndex}`}
                            type="button"
                            onClick={() =>
                              setOpenCitation(openCitation === flatIndex ? null : flatIndex)
                            }
                            className={`rounded border px-2 py-0.5 font-mono text-xs ${
                              openCitation === flatIndex
                                ? "border-sky-500 bg-sky-50 text-sky-900"
                                : "border-black/15 hover:bg-black/5"
                            }`}
                          >
                            {citation.sourceLabel}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}

            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 rounded-lg bg-black/5 p-3 font-mono text-[11px] opacity-80">
              <dt>answer state</dt>
              <dd>{result.answerState}</dd>
              <dt>reason</dt>
              <dd>{result.reason}</dd>
              <dt>evidence source</dt>
              <dd>{result.evidence.source}</dd>
              <dt>embedding provider</dt>
              <dd>
                in use: {result.evidence.embeddingProvider} ({result.provenance.embeddingDimensions}d)
                {" · "}
                configured: {result.provenance.embeddingModel}
              </dd>
              <dt>generator</dt>
              <dd>{result.evidence.generator ?? "none (not configured)"}</dd>
              <dt>verifier</dt>
              <dd>{result.evidence.verifier ?? "none (not configured)"} ({result.provenance.verification})</dd>
              <dt>turn stored</dt>
              <dd>
                {result.persistence.persisted ? "yes" : "no"} — {result.persistence.detail}
              </dd>
            </dl>
          </div>
        )}

        {openCitation !== null && result && result.citations[openCitation] && (
          <div className="mt-4 rounded-xl border border-sky-300 bg-sky-50 p-4 text-sm text-sky-950">
            <div className="flex items-center justify-between gap-3">
              <span className="font-mono text-xs">
                {result.citations[openCitation].sourceLabel}
                {result.citations[openCitation].policy === "COURSE_WIDE"
                  ? " · course-wide"
                  : ""}
              </span>
              <button
                type="button"
                onClick={() => setOpenCitation(null)}
                className="text-xs underline"
              >
                close
              </button>
            </div>
            <p className="mt-2 font-mono text-xs opacity-80">
              evidence id: {result.citations[openCitation].evidenceId}
              {result.citations[openCitation].pageNumber !== null
                ? ` · page ${result.citations[openCitation].pageNumber}`
                : ""}
              {result.citations[openCitation].slideNumber !== null
                ? ` · slide ${result.citations[openCitation].slideNumber}`
                : ""}
              {result.citations[openCitation].lineStart !== null
                ? ` · lines ${result.citations[openCitation].lineStart}–${result.citations[openCitation].lineEnd}`
                : ""}
            </p>
            <p className="mt-2 border-l-2 border-sky-400 pl-3 italic">
              “{result.citations[openCitation].quote}”
            </p>
          </div>
        )}
      </section>

      <footer className="mt-10 border-t border-black/10 pt-4 text-xs opacity-70">
        Retrieval, eligibility filtering and refusal behaviour run for real.
        Answers require a configured runtime model; no fallback fabricates them.
      </footer>
    </main>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "live" | "demo" | "warn";
  children: React.ReactNode;
}) {
  const styles: Record<string, string> = {
    live: "border-emerald-300 bg-emerald-50 text-emerald-900",
    demo: "border-sky-300 bg-sky-50 text-sky-900",
    warn: "border-amber-300 bg-amber-50 text-amber-900",
  };
  return (
    <span className={`rounded border px-2 py-0.5 font-medium ${styles[tone]}`}>
      {children}
    </span>
  );
}

function Notice({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-4 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
      <p className="font-medium">{title}</p>
      <div className="mt-1">{children}</div>
    </div>
  );
}
