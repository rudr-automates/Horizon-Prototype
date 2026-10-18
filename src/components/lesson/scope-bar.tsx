"use client";

/**
 * The scope strip.
 *
 * Three facts, side by side, because they answer the product's central question:
 * where am I, how much evidence is available here, and why exactly that much.
 * The count comes from the server's own eligibility query — never a client-side
 * estimate — and the policy sentence is built from the same response.
 */
import { Icon } from "@/components/ui/icons";
import type { ScopeSummary } from "@/lib/contracts/question";
import { formatPlaybackClock } from "@/lib/lesson/video";

export function ScopeBar({
  scope,
  pending,
  playhead,
  positionNote,
  materialCount,
  onOpenMaterials,
}: {
  scope: ScopeSummary | null;
  pending: boolean;
  playhead: number;
  positionNote: string;
  materialCount: number;
  onOpenMaterials: () => void;
}) {
  const count = scope?.eligibleBlockCount ?? null;

  return (
    <section
      aria-label="Evidence in scope"
      className="grid gap-px overflow-hidden rounded-panel border border-line bg-line sm:grid-cols-[1.1fr_1fr_1.3fr]"
    >
      <div className="bg-surface px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          Lesson position
        </p>
        <p className="mt-1 font-mono text-xl font-semibold leading-6 tabular-nums text-ink">
          {formatPlaybackClock(playhead)}
        </p>
        <p className="mt-0.5 line-clamp-2 text-[11px] leading-4 text-ink-faint">
          {positionNote}
        </p>
      </div>

      <div className="bg-surface px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          Evidence in scope
        </p>
        <p className="mt-1 flex items-baseline gap-1.5">
          <span className="font-mono text-xl font-semibold leading-6 tabular-nums text-ink">
            {count === null ? "—" : count}
          </span>
          <span className="text-[11px] text-ink-faint">
            block{count === 1 ? "" : "s"}
          </span>
        </p>
        <p className="mt-0.5 text-[11px] leading-4 text-ink-faint" role="status">
          {pending
            ? "Refreshing for this position…"
            : scope
              ? `Eligible at ${formatPlaybackClock(scope.boundarySeconds)}`
              : "Eligible at this position"}
        </p>
      </div>

      <div className="bg-surface px-4 py-3">
        <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
          Access policy
        </p>
        <p className="mt-1 flex items-center gap-1.5 text-[13px] font-medium leading-5 text-ink">
          <Icon name="clock" size={13} className="text-brand" />
          Time-gated to your position
        </p>
        <p className="text-[10px] leading-4 text-ink-faint">
          A block unlocks once the lesson reaches its end.
        </p>
        <button
          type="button"
          onClick={onOpenMaterials}
          className="mt-0.5 inline-flex items-center gap-1 text-[11px] font-medium text-brand hover:underline"
        >
          {materialCount > 0
            ? `${materialCount} source${materialCount === 1 ? "" : "s"} · see policy`
            : "See how policy works"}
          <Icon name="arrow" size={11} />
        </button>
      </div>
    </section>
  );
}
