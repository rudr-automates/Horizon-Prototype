"use client";

/**
 * Course materials.
 *
 * The library is an information architecture, not a file list: every row says
 * what the source is, whether it is time-gated or approved at every position, how
 * much of it is permitted right now, and whether any of it is still waiting for a
 * human. The viewer then shows only permitted blocks — the same predicate the
 * answer path uses — so a page cannot be read here before the lesson reaches it.
 *
 * Derived documents are labelled as such. The PDF and the deck in this workspace
 * were compiled from the lesson's own caption track; presenting them as an
 * independent second source would be a false corroboration, so the panel says the
 * opposite in plain words.
 */
import { useEffect, useRef, useState } from "react";
import { Icon, type IconName } from "@/components/ui/icons";
import {
  Button,
  EmptyState,
  Panel,
  PanelHeader,
  Pill,
  Skeleton,
} from "@/components/ui/primitives";
import type { ResourceDetailResponse } from "@/lib/contracts/lesson-view";
import { formatPlaybackClock } from "@/lib/lesson/video";
import { groupResourceBlocks } from "@/lib/presentation/resources";

export interface CourseResource {
  id: string;
  kind: "video" | "transcript" | "pdf" | "ppt" | "notes" | "code";
  title: string;
  coverage: number | null;
  parser: string | null;
  policy: "COURSE_WIDE" | "TIMELINE_BOUND" | "MIXED";
  blocks: number;
  eligibleNow: number;
  pendingReview: number;
  rejected: number;
}

const KIND_ICON: Record<CourseResource["kind"], IconName> = {
  video: "video",
  transcript: "notes",
  pdf: "file",
  ppt: "presentation",
  notes: "layers",
  code: "code",
};

const KIND_LABEL: Record<CourseResource["kind"], string> = {
  video: "Recording",
  transcript: "Transcript",
  pdf: "PDF",
  ppt: "Slides",
  notes: "Reference",
  code: "Code",
};

export function MaterialsPanel({
  courseId,
  playhead,
  boundarySeconds,
  resources,
  loading,
  error,
  isFixture,
  onOpenLearn,
}: {
  courseId: string;
  playhead: number;
  boundarySeconds: number;
  resources: CourseResource[] | null;
  loading: boolean;
  error: string | null;
  isFixture: boolean;
  onOpenLearn: () => void;
}) {
  const [pickedId, setPickedId] = useState<string | null>(null);
  const viewerRef = useRef<HTMLDivElement | null>(null);
  /** Text zoom for the document viewer. 1 is the base size. */
  const [zoom, setZoom] = useState(1);
  /**
   * One settled read, tagged with the id it belongs to. A separate loading flag
   * would have to be set synchronously at the top of the fetch effect, which
   * cascades a render; tagging instead derives loading from what has arrived.
   */
  const [detailState, setDetailState] = useState<{
    id: string;
    data?: ResourceDetailResponse;
    error?: string;
  } | null>(null);

  // Derived selection, so a refresh cannot leave the viewer pointing at a source
  // that is no longer in the list.
  // Default to a document rather than the transcript: the transcript has its own
  // reading pane in Learn, and the library's job is to explain the other sources.
  const defaultResource =
    resources?.find((resource) => resource.kind !== "transcript") ?? resources?.[0] ?? null;
  const selected =
    resources?.find((resource) => resource.id === pickedId) ?? defaultResource;
  // Depend on the id, not the object: a refetch of the list must not re-open the
  // same source and discard the reader's scroll position.
  const selectedId = selected?.id ?? null;

  useEffect(() => {
    if (selectedId === null) return;
    const controller = new AbortController();
    fetch(
      `/api/v1/courses/${encodeURIComponent(courseId)}/resources/${encodeURIComponent(selectedId)}?playheadSeconds=${boundarySeconds}`,
      { cache: "no-store", signal: controller.signal },
    )
      .then(async (response) => {
        if (!response.ok) {
          const envelope = (await response.json()) as { error?: { message?: string } };
          throw new Error(envelope.error?.message ?? "The resource could not be read.");
        }
        return (await response.json()) as ResourceDetailResponse;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setDetailState({ id: selectedId, data: payload });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setDetailState({
          id: selectedId,
          error: cause instanceof Error ? cause.message : "The resource could not be read.",
        });
      });
    return () => controller.abort();
  }, [courseId, selectedId, boundarySeconds]);

  const settled = detailState?.id === selectedId ? detailState : null;
  const detail = settled?.data ?? null;
  const detailError = settled?.error ?? null;
  const detailLoading = selectedId !== null && settled === null;

  const alwaysAvailable = resources?.filter((resource) => resource.policy === "COURSE_WIDE").length ?? 0;
  const pendingReview =
    resources?.reduce((total, resource) => total + resource.pendingReview, 0) ?? 0;

  // Page and slide chips, so a document with three pages is navigable rather than
  // just scrollable. The destinations are the same groups the viewer renders.
  const groups = detail ? groupResourceBlocks(detail.blocks) : [];
  const locationChips = groups.filter((group) => {
    const first = group.blocks[0];
    return first !== undefined && (first.pageNumber !== null || first.slideNumber !== null);
  });

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Course materials
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Every source, and what it is allowed to do
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-soft">
            A source being visible here does not make it searchable. Time-gated material
            unlocks as the recording reaches it; approved references are available at
            every position.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone="outline">{resources?.length ?? 0} sources</Pill>
          <Pill tone="ok">{alwaysAvailable} approved reference</Pill>
          {pendingReview > 0 && <Pill tone="warn">{pendingReview} awaiting review</Pill>}
          <Pill tone="neutral">position {formatPlaybackClock(playhead)}</Pill>
        </div>
      </header>

      {isFixture && (
        <div className="rounded-panel border border-warn-line bg-warn-soft px-4 py-3 text-sm text-warn">
          <p className="font-semibold">No resource records in fixture mode</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-soft">
            The sample fixture is an in-memory corpus; its resources have no database
            rows to describe. The recording&rsquo;s lesson has real PDF, slide and
            transcript records.
          </p>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[21rem_minmax(0,1fr)]">
        {/* ---------------- Library ---------------- */}
        <Panel className="overflow-hidden">
          <PanelHeader
            eyebrow="Library"
            title="Sources"
            description="Select a source to read what is permitted now."
          />
          <div className="scroll-pane max-h-[34rem] overflow-y-auto">
            {loading && (
              <div className="space-y-3 p-4">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            )}

            {!loading && error && (
              <EmptyState icon="warning" title="The library could not be read">
                {error}
              </EmptyState>
            )}

            {!loading && !error && (resources?.length ?? 0) === 0 && (
              <EmptyState icon="materials" title="No sources to show">
                This course has no resource records yet.
              </EmptyState>
            )}

            <ul className="divide-y divide-line">
              {resources?.map((resource) => {
                const isSelected = selected?.id === resource.id;
                return (
                  <li key={resource.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setPickedId(resource.id);
                        // On a phone the viewer is below the library, so a row tap
                        // that changed something off-screen would look like nothing
                        // happened.
                        if (window.matchMedia("(max-width: 1023px)").matches) {
                          window.requestAnimationFrame(() =>
                            viewerRef.current?.scrollIntoView({
                              behavior: "smooth",
                              block: "start",
                            }),
                          );
                        }
                      }}
                      aria-pressed={isSelected}
                      className={`flex w-full gap-2.5 px-4 py-3 text-left transition-colors ${
                        isSelected ? "bg-brand-soft" : "hover:bg-surface-muted"
                      }`}
                    >
                      <span
                        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-control border ${
                          isSelected
                            ? "border-brand-line bg-surface text-brand"
                            : "border-line bg-surface-muted text-ink-faint"
                        }`}
                      >
                        <Icon name={KIND_ICON[resource.kind]} size={14} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="line-clamp-2 text-[13px] font-semibold leading-5 text-ink">
                            {resource.title}
                          </span>
                          <Icon
                            name="chevron"
                            size={12}
                            className={isSelected ? "mt-1 text-brand" : "mt-1 text-line-strong"}
                          />
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1">
                          <Pill tone="outline">{KIND_LABEL[resource.kind]}</Pill>
                          <Pill tone={resource.policy === "COURSE_WIDE" ? "ok" : "neutral"}>
                            {resource.policy === "COURSE_WIDE"
                              ? "every position"
                              : resource.policy === "MIXED"
                                ? "mixed policy"
                                : "time-gated"}
                          </Pill>
                          {resource.pendingReview > 0 && (
                            <Pill tone="warn">{resource.pendingReview} pending</Pill>
                          )}
                        </span>
                        <span className="mt-1 block text-[11px] tabular-nums text-ink-faint">
                          {resource.eligibleNow} of {resource.blocks} block
                          {resource.blocks === 1 ? "" : "s"} available
                          {resource.coverage !== null
                            ? ` · text on ${Math.round(resource.coverage * 100)}% of pages`
                            : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        </Panel>

        {/* ---------------- Viewer ---------------- */}
        <div ref={viewerRef} className="min-w-0 scroll-mt-28">
        <Panel className="flex min-h-[26rem] flex-col">
          {selected === null ? (
            <EmptyState icon="materials" title="Nothing selected">
              Choose a source to inspect its permitted content.
            </EmptyState>
          ) : (
            <>
              <PanelHeader
                eyebrow={KIND_LABEL[selected.kind]}
                title={selected.title}
                description={
                  <span className="flex flex-wrap items-center gap-1.5">
                    <Pill tone={selected.policy === "COURSE_WIDE" ? "ok" : "neutral"}>
                      {selected.policy === "COURSE_WIDE"
                        ? "approved reference · every position"
                        : selected.policy === "MIXED"
                          ? "mixed policy"
                          : "time-gated with the lesson"}
                    </Pill>
                    {selected.parser && <span className="font-mono text-[10px]">{selected.parser}</span>}
                  </span>
                }
                actions={
                  <>
                    {selected.kind !== "transcript" && (
                      <div
                        className="flex items-center gap-0.5 rounded-control border border-line bg-surface p-0.5"
                        role="group"
                        aria-label="Text size"
                      >
                        <button
                          type="button"
                          onClick={() => setZoom((value) => Math.max(0.85, Number((value - 0.15).toFixed(2))))}
                          disabled={zoom <= 0.85}
                          aria-label="Smaller text"
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft hover:bg-surface-sunken disabled:text-ink-faint"
                        >
                          A−
                        </button>
                        <span className="px-1 font-mono text-[10px] text-ink-faint">
                          {Math.round(zoom * 100)}%
                        </span>
                        <button
                          type="button"
                          onClick={() => setZoom((value) => Math.min(1.45, Number((value + 0.15).toFixed(2))))}
                          disabled={zoom >= 1.45}
                          aria-label="Larger text"
                          className="rounded px-1.5 py-0.5 text-[11px] font-semibold text-ink-soft hover:bg-surface-sunken disabled:text-ink-faint"
                        >
                          A+
                        </button>
                      </div>
                    )}
                    {selected.kind === "transcript" && (
                      <Button size="sm" icon="arrow" onClick={onOpenLearn}>
                        Open transcript
                      </Button>
                    )}
                  </>
                }
              />

              {locationChips.length > 1 && (
                <div className="flex flex-wrap gap-1 border-b border-line bg-surface-muted px-4 py-2 sm:px-5">
                  {locationChips.map((group) => (
                    <button
                      key={group.key}
                      type="button"
                      onClick={() =>
                        document
                          .getElementById(`resource-${group.key}`)
                          ?.scrollIntoView({ behavior: "smooth", block: "start" })
                      }
                      className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-[11px] font-medium text-ink-soft hover:border-brand-line hover:bg-brand-soft hover:text-brand-strong"
                    >
                      {group.heading}
                    </button>
                  ))}
                </div>
              )}

              <div className="scroll-pane min-h-0 flex-1 overflow-y-auto px-4 py-3 sm:px-5">
                {detailLoading && (
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-3 w-full" />
                    <Skeleton className="h-3 w-11/12" />
                    <Skeleton className="h-3 w-4/5" />
                  </div>
                )}

                {!detailLoading && detailError && (
                  <EmptyState icon="warning" title="This source could not be opened">
                    {detailError}
                  </EmptyState>
                )}

                {!detailLoading && !detailError && detail && detail.blocks.length === 0 && (
                  <EmptyState
                    icon="clock"
                    title={`Nothing from this source is permitted at ${formatPlaybackClock(detail.boundarySeconds)}`}
                  >
                    {selected.pendingReview > 0
                      ? `${selected.pendingReview} block${selected.pendingReview === 1 ? " is" : "s are"} still waiting for review, and unreviewed material is never searchable.`
                      : "Its passages unlock as the recording reaches them. The library will not preview them early."}
                  </EmptyState>
                )}

                {!detailLoading && !detailError && detail && detail.blocks.length > 0 && (
                  <div className="space-y-4">
                    {groups.map((group) => (
                      <article key={group.key} id={`resource-${group.key}`} className="scroll-mt-2">
                        <h3 className="border-b border-line pb-1 text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
                          {group.heading}
                        </h3>
                        <div className="mt-2 space-y-2">
                          {group.blocks.map((block) => (
                            <p
                              key={block.id}
                              className="leading-6 text-ink-soft"
                              style={{ fontSize: `${13 * zoom}px` }}
                            >
                              {block.text}
                            </p>
                          ))}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>

              <div className="border-t border-line bg-surface-muted px-4 py-2.5 text-[10px] leading-4 text-ink-faint sm:px-5">
                {detail
                  ? `${detail.blocks.length} of ${detail.totalBlocks} block${detail.totalBlocks === 1 ? "" : "s"} permitted at ${formatPlaybackClock(detail.boundarySeconds)}. Counts and permitted text only: a future page, its heading and its unlock time are not sent.`
                  : "Only permitted blocks are requested."}
                {selected.kind === "pdf" || selected.kind === "ppt" ? (
                  <span className="mt-1 block">
                    This document was compiled from the lesson&rsquo;s own caption track when
                    the workspace was set up. It is a reading aid for the same evidence, not
                    an independent second source.
                  </span>
                ) : null}
                {selected.kind === "transcript" ? (
                  <span className="mt-1 block">
                    This is the lesson&rsquo;s own caption track, the same evidence the transcript
                    pane in Learn reads. It is shown here because it is a course source, not
                    because it is a second opinion.
                  </span>
                ) : null}
              </div>
            </>
          )}
        </Panel>
        </div>
      </div>
    </div>
  );
}
