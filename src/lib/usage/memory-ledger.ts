import { utcDayStart, type UsageEntry, type UsageLedger } from "@/lib/usage/types";

/**
 * Process-local usage ledger.
 *
 * Used when no database is configured. It is a REAL accumulator for the life of
 * the process and it does enforce a cumulative cap, but it is deliberately
 * labelled as weaker than the database-backed one:
 *
 *   - it resets when the process restarts,
 *   - each server instance keeps its own total, so N instances get N budgets.
 *
 * The mode string is surfaced in responses and on /api/v1/health so neither of
 * those limits can be mistaken for a durable daily cap.
 */
export class InMemoryUsageLedger implements UsageLedger {
  readonly mode = "memory" as const;

  /** Bounded so a long-lived process cannot grow this without limit. */
  private static readonly MAX_ENTRIES = 500;

  private day: string;
  private promptTokens = 0;
  private completionTokens = 0;
  /** Kept so tests and diagnostics can see the turn-level trail. */
  readonly entries: Array<UsageEntry & { occurredAt: string }> = [];

  constructor(now: Date = new Date()) {
    this.day = utcDayStart(now);
  }

  /** Reset the running total when the UTC day rolls over. */
  private rollIfNeeded(now: Date): void {
    const current = utcDayStart(now);
    if (current !== this.day) {
      this.day = current;
      this.promptTokens = 0;
      this.completionTokens = 0;
    }
  }

  async spentToday(): Promise<number> {
    this.rollIfNeeded(new Date());
    return this.promptTokens + this.completionTokens;
  }

  async record(entry: UsageEntry): Promise<void> {
    const now = new Date();
    this.rollIfNeeded(now);

    const prompt = Number.isFinite(entry.promptTokens) ? Math.max(0, entry.promptTokens) : 0;
    const completion = Number.isFinite(entry.completionTokens)
      ? Math.max(0, entry.completionTokens)
      : 0;

    this.promptTokens += prompt;
    this.completionTokens += completion;
    this.entries.push({ ...entry, occurredAt: now.toISOString() });
    if (this.entries.length > InMemoryUsageLedger.MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - InMemoryUsageLedger.MAX_ENTRIES);
    }
  }
}
