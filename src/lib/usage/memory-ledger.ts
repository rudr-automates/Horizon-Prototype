import {
  count,
  decideAdmission,
  entryTotalTokens,
  reportedTotal,
  utcDayStart,
  utcDayKey,
  type EmbeddingAdmissionDecision,
  type EmbeddingAdmissionRequest,
  type GenerationAdmissionRequest,
  type GenerationReservation,
  type ReportedUsage,
  type ReservationDecision,
  type SettlementResult,
  type UsageEntry,
  type UsageLedger,
} from "@/lib/usage/types";

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
 * ATOMICITY, HONESTLY DESCRIBED
 *   `admitGeneration` checks the remaining budget and records the reservation
 *   with NO `await` between them. JavaScript runs that run-to-completion, so two
 *   callers in the same process cannot interleave inside it and capacity cannot
 *   be over-committed here. That is a real property of this implementation — but
 *   it is process-local, so it says NOTHING about two instances, which is
 *   exactly why the durable ledger does the same job inside a database
 *   transaction instead.
 *
 * The mode string is surfaced in responses and on /api/v1/health so neither of
 * those limits can be mistaken for a durable daily cap.
 */
export class InMemoryUsageLedger implements UsageLedger {
  readonly mode = "memory" as const;

  /** Bounded so a long-lived process cannot grow this without limit. */
  private static readonly MAX_ENTRIES = 500;

  private day: string;
  /**
   * One accumulator for the day's billable total. It is a single number on
   * purpose: keeping prompt/completion/reasoning in separate running sums invites
   * exactly the bug this module exists to prevent, where one component is
   * recorded but not counted.
   */
  private totalTokens = 0;
  /** Embedding requests counted for the day, by the durable-cap equivalent. */
  private embeddingRequests = 0;
  /** Outstanding reservations, so capacity in flight is not double-spent. */
  private readonly outstanding = new Map<string, { reservedTokens: number; settled: boolean }>();
  private nextReservationId = 1;
  /** Kept so tests and diagnostics can see the turn-level trail. */
  readonly entries: Array<UsageEntry & { occurredAt: string }> = [];

  constructor(now: Date = new Date()) {
    this.day = utcDayKey(now);
  }

  /** Reset the running total when the UTC day rolls over. */
  private rollIfNeeded(now: Date): void {
    const current = utcDayKey(now);
    if (current !== this.day) {
      this.day = current;
      this.totalTokens = 0;
      this.embeddingRequests = 0;
      this.outstanding.clear();
    }
  }

  /** Tokens held by reservations that have not been settled yet. */
  private reservedTokens(): number {
    let total = 0;
    for (const reservation of this.outstanding.values()) {
      if (!reservation.settled) total += reservation.reservedTokens;
    }
    return total;
  }

  async spentToday(): Promise<number> {
    this.rollIfNeeded(new Date());
    // Settled spend PLUS capacity currently held, so an in-flight call is never
    // treated as free while it is still running.
    return this.totalTokens + this.reservedTokens();
  }

  async admitGeneration(request: GenerationAdmissionRequest): Promise<ReservationDecision> {
    this.rollIfNeeded(new Date());

    const reserved = Math.max(0, count(request.reserveTokens));
    const decision = decideAdmission(
      this.totalTokens + this.reservedTokens(),
      request.budgetTokens,
      reserved,
    );

    if (!decision.admitted) {
      return {
        admitted: false,
        reservation: null,
        spentTokens: this.totalTokens,
        reservedTokens: this.reservedTokens(),
        detail: decision.detail,
      };
    }

    // No `await` above this line and none below it: the check and the hold are
    // one run-to-completion step, so no other caller can slip between them.
    const id = `mem-${this.nextReservationId}`;
    this.nextReservationId += 1;
    this.outstanding.set(id, { reservedTokens: reserved, settled: false });

    return {
      admitted: true,
      reservation: { id, kind: "generation_tokens", reservedTokens: reserved },
      spentTokens: this.totalTokens,
      reservedTokens: this.reservedTokens(),
      detail: decision.detail,
    };
  }

  async admitEmbedding(request: EmbeddingAdmissionRequest): Promise<EmbeddingAdmissionDecision> {
    this.rollIfNeeded(new Date());

    const maxCalls = Math.floor(count(request.maxCalls));
    if (maxCalls <= 0) {
      return {
        admitted: false,
        usedToday: this.embeddingRequests,
        detail:
          "No embedding-request cap is configured, so no embedding request is admitted against a durable cap.",
      };
    }

    if (this.embeddingRequests >= maxCalls) {
      return {
        admitted: false,
        usedToday: this.embeddingRequests,
        detail: `The embedding-request cap of ${maxCalls} for the day has been reached (${this.embeddingRequests} used).`,
      };
    }

    this.embeddingRequests += 1;
    return {
      admitted: true,
      usedToday: this.embeddingRequests,
      detail: `${this.embeddingRequests} of ${maxCalls} embedding requests recorded today. Cost is NOT bounded by this cap.`,
    };
  }

  async settle(
    reservation: GenerationReservation,
    reported: ReportedUsage | null,
    options: { failed?: boolean; detail?: string; notBillable?: boolean } = {},
  ): Promise<SettlementResult> {
    this.rollIfNeeded(new Date());

    const held = this.outstanding.get(reservation.id);
    if (!held || held.settled) {
      return {
        chargedTokens: 0,
        reportedTokens: 0,
        outcome: "already_settled",
        detail: "This reservation was already settled; it is not charged twice.",
      };
    }

    const reportedTokens = reportedTotal(reported);
    // The policy: a call that was sent is charged its reservation when the
    // provider reports nothing, EXCEPT when the provider rejected it before
    // processing — then nothing could have been consumed and the hold is
    // released. Charging a full reservation for a rate-limited attempt would
    // drain the day's budget during an outage.
    const charged =
      reportedTokens > 0
        ? reportedTokens
        : options.notBillable
          ? 0
          : held.reservedTokens;

    held.settled = true;
    this.totalTokens += charged;

    const outcome: SettlementResult["outcome"] =
      reportedTokens > 0
        ? "reported"
        : options.notBillable
          ? "failed_not_billable"
          : options.failed
            ? "failed_no_report_charged_reservation"
            : "no_report_charged_reservation";

    // The reservation trail deliberately does not append to `entries`: a
    // reservation does not carry a provider or model id, and inventing one to
    // make the trail look uniform would make the trail less trustworthy, not
    // more. `entries` records settled calls that were recorded directly.
    return {
      chargedTokens: charged,
      reportedTokens,
      outcome,
      detail:
        reportedTokens > 0
          ? `Settled at the ${reportedTokens} tokens the provider reported.`
          : options.notBillable
            ? "The provider rejected the request before processing it, so the reservation was released without charge."
            : `The provider reported no usage for a sent call, so the ${charged}-token reservation stands rather than collapsing to zero.`,
    };
  }

  async record(entry: UsageEntry): Promise<void> {
    const now = new Date();
    this.rollIfNeeded(now);

    this.totalTokens += entryTotalTokens(entry);
    this.entries.push({ ...entry, occurredAt: now.toISOString() });
    if (this.entries.length > InMemoryUsageLedger.MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - InMemoryUsageLedger.MAX_ENTRIES);
    }
  }

  /** Test/diagnostic view of the UTC day this ledger is accounting for. */
  dayStart(): string {
    return utcDayStart();
  }
}
