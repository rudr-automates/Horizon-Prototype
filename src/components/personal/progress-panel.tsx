"use client";

/**
 * Progress, told honestly.
 *
 * Two different numbers are shown because they are two different facts: the
 * furthest point reached is a resume position, while watched coverage is what
 * playback actually reported. Scrubbing to the end moves the first and not the
 * second, and neither is presented as "completion" — Horizon has no completion
 * model. Signed-in progress is persisted per account; anonymous progress stays
 * in this browser.
 */
import { Icon } from "@/components/ui/icons";
import { Button, EmptyState, Panel, PanelHeader, Pill } from "@/components/ui/primitives";
import { formatPlaybackClock } from "@/lib/lesson/video";
import {
  progressBuckets,
  watchedFraction,
  watchedSeconds,
  type CourseProgress,
} from "@/lib/personal/local-store";

export function ProgressPanel({
  courseTitle,
  durationSeconds,
  playhead,
  progress,
  noteCount,
  bookmarkCount,
  onSeek,
}: {
  courseTitle: string;
  durationSeconds: number;
  playhead: number;
  progress: CourseProgress | null;
  noteCount: number;
  bookmarkCount: number;
  onSeek: (seconds: number) => void;
}) {
  const ranges = progress?.watched ?? [];
  const watched = watchedSeconds(ranges);
  const fraction = watchedFraction(ranges, durationSeconds);
  const percent = Math.round(fraction * 100);
  const buckets = progressBuckets(ranges, durationSeconds, 56);
  const furthest = progress?.furthestSeconds ?? 0;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            Progress
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            What you have actually watched
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-soft">
            {courseTitle} · measured from playback reports and synced to your account when signed in.
          </p>
        </div>
        <Pill tone="neutral">
          <Icon name="clock" size={11} />
          now {formatPlaybackClock(playhead)}
        </Pill>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat
          label="Watched"
          value={formatPlaybackClock(watched)}
          detail={`${percent}% of ${formatPlaybackClock(durationSeconds)}`}
        />
        <Stat
          label="Furthest position"
          value={formatPlaybackClock(furthest)}
          detail="A resume point, not coverage"
        />
        <Stat
          label="Study items"
          value={`${noteCount} note${noteCount === 1 ? "" : "s"}`}
          detail={`${bookmarkCount} bookmark${bookmarkCount === 1 ? "" : "s"} in this browser`}
        />
      </div>

      <Panel>
        <PanelHeader
          eyebrow="Coverage"
          title="Lesson map"
          description="Each segment is filled only by time the player reported as playing."
          actions={
            furthest > 0 ? (
              <Button size="sm" icon="play" onClick={() => onSeek(furthest)}>
                Resume at {formatPlaybackClock(furthest)}
              </Button>
            ) : undefined
          }
        />

        <div className="px-4 py-5 sm:px-5">
          {watched === 0 ? (
            <EmptyState icon="progress" title="No playback recorded yet">
              Press play in the lesson and coverage will build here. Seeking alone does
              not count, because a seek is not watching.
            </EmptyState>
          ) : (
            <>
              <div
                className="flex h-14 items-stretch gap-[2px] overflow-hidden rounded-control"
                role="img"
                aria-label={`Watched coverage map, ${percent}% filled`}
              >
                {buckets.map((coverage, index) => (
                  <span
                    key={index}
                    className="min-w-0 flex-1"
                    title={`${formatPlaybackClock((index * durationSeconds) / buckets.length)} · ${
                      coverage > 0.5 ? "watched" : coverage > 0 ? "partly watched" : "not watched"
                    }`}
                    style={{
                      backgroundColor:
                        coverage > 0.5
                          ? "var(--color-brand)"
                          : coverage > 0
                            ? "var(--color-brand-line)"
                            : "var(--color-surface-sunken)",
                    }}
                  />
                ))}
              </div>
              <div className="mt-1.5 flex justify-between font-mono text-[10px] tabular-nums text-ink-faint">
                <span>00:00</span>
                <span>{formatPlaybackClock(durationSeconds / 2)}</span>
                <span>{formatPlaybackClock(durationSeconds)}</span>
              </div>
            </>
          )}
        </div>

        <p className="border-t border-line bg-surface-muted px-4 py-2.5 text-[10px] leading-4 text-ink-faint sm:px-5">
          A playback step longer than five seconds is treated as a seek and is not counted
          as watching. Rewinding over the same passage never counts twice. Clearing this
          browser&rsquo;s site data removes the record, because that is where it lives.
        </p>
      </Panel>
    </div>
  );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-panel border border-line bg-surface px-4 py-3.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 font-mono text-xl font-semibold tabular-nums text-ink">{value}</p>
      <p className="mt-0.5 text-[11px] leading-4 text-ink-faint">{detail}</p>
    </div>
  );
}
