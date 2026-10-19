"use client";

/**
 * The assistant.
 *
 * Every answer on this panel is a real pipeline result and every citation is a
 * stored block. The panel therefore has three jobs beyond showing text:
 *
 *   1. Say what the answer was allowed to use (the scope line, from the server).
 *   2. Make the evidence inspectable — the quotation, its source type, and where
 *      it sits — without turning the page into a debug console.
 *   3. Report a refusal as a refusal. A provider outage, an exhausted guard and a
 *      genuine "not enough evidence" are three different facts, and the labels
 *      say which one happened.
 */
import { useId, useState } from "react";
import { Icon, type IconName } from "@/components/ui/icons";
import { Button, Panel, Pill } from "@/components/ui/primitives";
import type { Citation, QuestionResponse } from "@/lib/contracts/question";
import { formatPlaybackClock } from "@/lib/lesson/video";
import { LEARNING_ACTION_PROMPTS } from "@/lib/learning/actions";
import {
  ANSWER_STATE_LABEL,
  ANSWER_STATE_TONE,
  TONE_CLASSES,
  reasonLabel,
} from "@/lib/presentation/answer-state";

const BLOCK_TYPE_LABEL: Record<string, string> = {
  transcript: "Transcript",
  pdf: "PDF page",
  ppt: "Slide",
  notes: "Reference note",
  code: "Code",
  video: "Recording",
};

const BLOCK_TYPE_ICON: Record<string, IconName> = {
  transcript: "video",
  pdf: "file",
  ppt: "presentation",
  notes: "layers",
  code: "code",
  video: "play",
};

function citationLocation(citation: Citation): string {
  if (citation.startSeconds !== null) {
    const end = citation.endSeconds ?? citation.startSeconds;
    return `${formatPlaybackClock(Number(citation.startSeconds))}–${formatPlaybackClock(Number(end))}`;
  }
  if (citation.pageNumber !== null) return `Page ${citation.pageNumber}`;
  if (citation.slideNumber !== null) return `Slide ${citation.slideNumber}`;
  if (citation.lineStart !== null) {
    const end = citation.lineEnd ?? citation.lineStart;
    return end === citation.lineStart ? `Line ${citation.lineStart}` : `Lines ${citation.lineStart}–${end}`;
  }
  return "Reference";
}

export function AssistantPanel({
  question,
  onQuestionChange,
  onAsk,
  pending,
  result,
  requestError,
  suggestions,
  playhead,
  askedAt,
  canSeekCitation,
  onPlayCitation,
  onShowInTranscript,
  aiConfigured,
  embeddingConfigured,
}: {
  question: string;
  onQuestionChange: (next: string) => void;
  onAsk: (question?: string) => void;
  pending: boolean;
  result: QuestionResponse | null;
  requestError: string | null;
  suggestions: readonly string[];
  playhead: number;
  /** The position the learner was at when they asked. Null before the first ask. */
  askedAt: number | null;
  canSeekCitation: boolean;
  onPlayCitation: (seconds: number) => void;
  onShowInTranscript: (evidenceId: string) => void;
  aiConfigured: boolean;
  embeddingConfigured: boolean;
}) {
  const [openCitation, setOpenCitation] = useState<number | null>(null);
  const inputId = useId();
  const canAsk = question.trim().length >= 3 && !pending;

  return (
    <Panel as="aside" className="flex min-h-0 flex-col xl:sticky xl:top-[4.25rem] xl:max-h-[calc(100vh-5.5rem)]">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Assistant
          </p>
          <h2 className="text-[15px] font-semibold leading-6 text-ink">Ask this lesson</h2>
        </div>
        <Pill id="question-evidence-scope" tone="brand" className="shrink-0">
          <Icon name="clock" size={11} />
          through {formatPlaybackClock(playhead)}
        </Pill>
      </div>

      <div className="scroll-pane min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {!aiConfigured && (
          <InlineNotice tone="warn" icon="warning" title="No model is configured">
            Retrieval, eligibility and refusals still run for real, but no answer can
            be generated. Set the server-side generation key to enable it.
          </InlineNotice>
        )}
        {aiConfigured && !embeddingConfigured && (
          <InlineNotice tone="warn" icon="warning" title="No embedding credential">
            A question cannot be placed in the same vector space as the stored
            evidence, so the turn will be refused rather than searched with a stand-in
            vector.
          </InlineNotice>
        )}

        <form
          id="ask"
          onSubmit={(event) => {
            event.preventDefault();
            if (canAsk) void onAsk();
          }}
          className="mt-3"
        >
          <label htmlFor={inputId} className="sr-only">
            Your question about this lesson
          </label>
          <textarea
            id={inputId}
            aria-describedby="question-evidence-scope"
            value={question}
            onChange={(event) => onQuestionChange(event.target.value)}
            onKeyDown={(event) => {
              // Enter starts a new line; the shortcut submits. A plain Enter
              // submitting would make a two-line question impossible to type.
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                if (canAsk) void onAsk();
              }
            }}
            rows={2}
            maxLength={500}
            placeholder="Ask about what you have watched…"
            className="w-full resize-y rounded-control border border-line-strong bg-surface p-2.5 text-sm leading-6 text-ink placeholder:text-ink-faint focus:border-brand"
          />

          <div className="mt-2 flex flex-wrap gap-1.5">
            <button
              type="button"
              disabled={pending}
              onClick={() => void onAsk(LEARNING_ACTION_PROMPTS.summary)}
              className="rounded-full border border-brand-line bg-brand-soft px-2.5 py-1 text-[11px] font-semibold text-brand-strong transition-colors hover:bg-surface-muted disabled:opacity-50"
            >
              Summarize so far
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => void onAsk(LEARNING_ACTION_PROMPTS.explainSimply)}
              className="rounded-full border border-line bg-surface-muted px-2.5 py-1 text-[11px] font-semibold text-ink-soft transition-colors hover:border-brand-line hover:text-brand-strong disabled:opacity-50"
            >
              Explain simply
            </button>
            {suggestions.slice(0, 3).map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => onQuestionChange(suggestion)}
                className="max-w-full truncate rounded-full border border-line bg-surface-muted px-2.5 py-1 text-left text-[11px] font-medium text-ink-soft transition-colors hover:border-brand-line hover:bg-brand-soft hover:text-brand-strong"
                title={suggestion}
              >
                {suggestion.length > 46 ? `${suggestion.slice(0, 46)}…` : suggestion}
              </button>
            ))}
          </div>

          <Button
            type="submit"
            tone="primary"
            size="lg"
            icon="arrow"
            className="mt-2.5 w-full flex-row-reverse"
            disabled={!canAsk}
          >
            {pending ? "Retrieving and verifying…" : `Ask at ${formatPlaybackClock(playhead)}`}
          </Button>
          <p className="mt-1 text-center text-[11px] text-ink-faint">
            {question.trim().length < 3
              ? "Enter at least 3 characters."
              : "⌘/Ctrl + Enter sends"}
          </p>
        </form>

        {requestError && (
          <InlineNotice tone="danger" icon="warning" title="The request failed">
            {requestError}
          </InlineNotice>
        )}

        {pending && (
          <div className="mt-4 rounded-control border border-line bg-surface-muted p-3" role="status">
            <p className="flex items-center gap-2 text-xs font-semibold text-ink">
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-brand-line border-t-brand"
                aria-hidden="true"
              />
              Retrieving, generating, verifying
            </p>
            <p className="mt-1 text-[11px] leading-4 text-ink-faint">
              Two metered model calls. Each claim must quote evidence before it can be
              shown; unsupported claims are dropped.
            </p>
          </div>
        )}

        {!pending && !result && !requestError && (
          <div className="mt-4 rounded-control border border-dashed border-line px-3 py-6 text-center">
            <span className="mx-auto flex h-8 w-8 items-center justify-center rounded-full bg-brand-soft text-brand">
              <Icon name="search" size={15} />
            </span>
            <p className="mt-1.5 text-xs font-semibold text-ink">Answers cite the passage</p>
            <p className="mx-auto mt-0.5 max-w-[16rem] text-[11px] leading-4 text-ink-faint">
              Only material the lesson has reached is searched. A part you have not
              watched never reaches the model.
            </p>
          </div>
        )}

        {!pending && result && (
          <div className="mt-4" aria-live="polite">
            <div className="flex flex-wrap items-center gap-1.5">
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[ANSWER_STATE_TONE[result.answerState]]}`}
              >
                {ANSWER_STATE_LABEL[result.answerState]}
              </span>
              <span className="text-[11px] text-ink-faint">
                {askedAt !== null ? `asked at ${formatPlaybackClock(askedAt)} · ` : ""}
                {result.evidence.payloadCount} block
                {result.evidence.payloadCount === 1 ? "" : "s"} in payload ·{" "}
                {result.latencyMs} ms
              </span>
            </div>

            <p className="mt-2 text-sm leading-6 text-ink">{result.message}</p>

            {result.answerState === "INSUFFICIENT_EVIDENCE" && (
              <p className="mt-2 rounded-control bg-surface-muted px-2.5 py-2 text-[11px] leading-4 text-ink-soft">
                That can mean the lesson has not reached this part yet, or that it is
                not covered at all. This panel will not distinguish the two by
                disclosing something you have not watched.
              </p>
            )}

            {result.answerState === "TEMPORARILY_UNAVAILABLE" && (
              <p className="mt-2 rounded-control bg-surface-muted px-2.5 py-2 text-[11px] leading-4 text-ink-soft">
                {reasonLabel(result.reason)}. Nothing was invented to fill the gap.
              </p>
            )}

            {result.claims.length > 0 && (
              <ol className="mt-3 space-y-3">
                {result.claims.map((claim, claimIndex) => (
                  <li key={claimIndex} className="rounded-control border border-line p-3">
                    <p className="text-[13px] leading-6 text-ink">{claim.text}</p>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {claim.citations.map((citation) => {
                        const flatIndex = result.citations.findIndex(
                          (item) =>
                            item.evidenceId === citation.evidenceId && item.quote === citation.quote,
                        );
                        const open = openCitation === flatIndex;
                        return (
                          <button
                            key={`${citation.evidenceId}-${flatIndex}`}
                            type="button"
                            aria-expanded={open}
                            onClick={() => setOpenCitation(open ? null : flatIndex)}
                            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold transition-[background-color,border-color,color] duration-150 ${
                              open
                                ? "border-brand bg-brand text-ink-inverse"
                                : "border-brand-line bg-brand-soft text-brand-strong hover:border-brand hover:bg-surface-muted"
                            }`}
                          >
                            <Icon
                              name={BLOCK_TYPE_ICON[citation.blockType] ?? "file"}
                              size={11}
                            />
                            {citation.sourceLabel}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ol>
            )}

            {openCitation !== null && result.citations[openCitation] && (
              <CitationCard
                citation={result.citations[openCitation]}
                canSeek={canSeekCitation}
                onPlay={onPlayCitation}
                onShowInTranscript={onShowInTranscript}
                onClose={() => setOpenCitation(null)}
              />
            )}

            <details className="mt-3 rounded-control border border-line bg-surface-muted px-3 py-2">
              <summary className="cursor-pointer text-[11px] font-semibold text-ink-soft">
                Turn details
              </summary>
              <dl className="mt-2 space-y-1 text-[11px]">
                <DetailRow label="Answer state">{result.answerState}</DetailRow>
                <DetailRow label="Reason">{`${result.reason} · ${reasonLabel(result.reason)}`}</DetailRow>
                <DetailRow label="Evidence">{result.evidence.source}</DetailRow>
                <DetailRow label="Generator">
                  {result.evidence.generator ?? "none (no call made)"}
                </DetailRow>
                <DetailRow label="Verifier">
                  {result.evidence.verifier
                    ? `${result.evidence.verifier} (${result.provenance.verification})`
                    : "none"}
                </DetailRow>
                <DetailRow label="Turn stored">
                  {result.persistence.persisted ? "yes" : "no"} · {result.persistence.detail}
                </DetailRow>
                <DetailRow label="Guard">{result.guard.detail}</DetailRow>
                <DetailRow label="Request">
                  <span className="font-mono">{result.requestId}</span>
                </DetailRow>
              </dl>
            </details>
          </div>
        )}
      </div>
    </Panel>
  );
}

function CitationCard({
  citation,
  canSeek,
  onPlay,
  onShowInTranscript,
  onClose,
}: {
  citation: Citation;
  canSeek: boolean;
  onPlay: (seconds: number) => void;
  onShowInTranscript: (evidenceId: string) => void;
  onClose: () => void;
}) {
  const isTranscript = citation.blockType === "transcript";
  return (
    <div className="mt-3 rounded-control border border-brand-line bg-brand-soft p-3" data-testid="citation-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="flex h-6 w-6 items-center justify-center rounded-control bg-surface text-brand">
            <Icon name={BLOCK_TYPE_ICON[citation.blockType] ?? "file"} size={13} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-brand-strong">
              {BLOCK_TYPE_LABEL[citation.blockType] ?? citation.blockType}
            </p>
            <p className="font-mono text-[10px] text-ink-faint">
              {citationLocation(citation)} · {citation.evidenceId.slice(0, 8)}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close the citation"
          className="rounded-control p-1 text-ink-soft hover:bg-surface hover:text-ink"
        >
          <Icon name="close" size={13} />
        </button>
      </div>

      <blockquote className="mt-2 rounded-control border border-line bg-surface px-2.5 py-2 text-[12px] leading-5 text-ink">
        “{citation.quote}”
      </blockquote>

      <p className="mt-1.5 text-[10px] leading-4 text-ink-soft">
        Matched verbatim against the stored {BLOCK_TYPE_LABEL[citation.blockType]?.toLowerCase() ?? "block"}{" "}
        before the claim was renderable.{" "}
        {citation.policy === "COURSE_WIDE"
          ? "Approved reference: available at every position, so it carries no playback clock of its own."
          : isTranscript
            ? "The timestamps are the caption source's own."
            : "Time-gated: it unlocks when the recording reaches the passage it belongs to."}
      </p>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {canSeek && citation.startSeconds !== null && (
          <Button
            size="sm"
            tone="secondary"
            icon="play"
            onClick={() => onPlay(Math.max(0, Number(citation.startSeconds) - 3))}
          >
            Play from {formatPlaybackClock(Math.max(0, Number(citation.startSeconds) - 3))}
          </Button>
        )}
        {isTranscript && (
          <Button size="sm" icon="search" onClick={() => onShowInTranscript(citation.evidenceId)}>
            Show in transcript
          </Button>
        )}
      </div>
    </div>
  );
}

function InlineNotice({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warn" | "danger";
  icon: IconName;
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "border-warn-line bg-warn-soft text-warn"
      : "border-danger-line bg-danger-soft text-danger";
  return (
    <div className={`mt-3 rounded-control border px-2.5 py-2 text-[11px] leading-4 ${styles}`} role="status">
      <p className="flex items-center gap-1.5 font-semibold">
        <Icon name={icon} size={12} />
        {title}
      </p>
      <div className="mt-0.5 text-ink-soft">{children}</div>
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-2">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-ink-soft">{children}</dd>
    </div>
  );
}
