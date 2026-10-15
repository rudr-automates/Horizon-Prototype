/**
 * Live proof that budget admission is ATOMIC in the database.
 *
 *   pnpm verify:budget
 *
 * WHY THIS IS A SEPARATE COMMAND
 *   Unit tests can prove the application side maps a refusal correctly, but they
 *   cannot prove that PostgreSQL serializes two simultaneous admissions — only a
 *   real database can. This fires N concurrent reservations at the real
 *   `horizon_admit_generation_tokens` function against a budget that only K of
 *   them can fit, and checks that exactly K are granted.
 *
 * IT WRITES REAL ROWS, THEN REMOVES THEM.
 *   Admission is a write, so there is no read-only way to test it. Every row this
 *   command creates is tagged with `provider = 'concurrency-probe'` and deleted
 *   in a `finally` block; the day's total is re-read afterwards and compared with
 *   the value from before. If cleanup fails, the command says so loudly rather
 *   than leaving phantom spend behind unmentioned.
 *
 * IT IS CALIBRATED TO THE DAY'S REAL USAGE, NOT TO AN EMPTY LEDGER.
 *   The embedding cap counts embedding rows for the UTC day across all providers,
 *   so a genuine turn taken earlier today legitimately consumes part of it. Both
 *   halves therefore derive their expectation from the current day: the token
 *   budget from the recorded total, and the embedding cap from the remaining
 *   allowance. A hardcoded "expect K grants" would report a FAIL exactly on the
 *   days the application was actually used — the least useful time to be wrong.
 *
 * It makes NO provider call and therefore cannot spend Gemini quota.
 */
import { loadEnvFile } from "./env-file";

const PROBE_PROVIDER = "concurrency-probe";
const GENERATION_RESERVE = 1200;
const GENERATION_ADMITS = 4;
/**
 * How many embedding requests the remaining allowance should be able to absorb.
 * This is the number of GRANTS expected, so the cap is derived from the day's
 * existing usage rather than being this figure directly.
 */
const EMBEDDING_ADMITS = 3;
const CONCURRENCY = 12;

interface ProbeTotals {
  spent: number;
  rows: number;
}

async function main(): Promise<void> {
  const loaded = loadEnvFile();
  console.log(`Environment file .env.local: ${loaded ? "loaded" : "not present"}`);

  const { readServerEnv } = await import("@/lib/env");
  const { createServiceRoleClient, isDatabaseConfigured } = await import("@/lib/db/server");
  const { resolveUsageLedger } = await import("@/lib/usage");
  const { utcDayKey } = await import("@/lib/usage/types");

  const env = readServerEnv();
  if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
    console.error("\nREFUSED — a configured Supabase database is required, and nothing was written.\n");
    process.exitCode = 1;
    return;
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    console.error("\nREFUSED — no service-role client could be created.\n");
    process.exitCode = 1;
    return;
  }

  const ledger = resolveUsageLedger(env).ledger;
  console.log(`Ledger mode: ${ledger.mode}`);
  if (ledger.mode !== "supabase") {
    console.error("\nREFUSED — the durable ledger is not in use, so there is nothing to verify.\n");
    process.exitCode = 1;
    return;
  }

  const probeTotals = async (): Promise<ProbeTotals> => {
    const { data, error } = await client
      .from("usage_ledger")
      .select("charged_tokens, reserved_tokens, state")
      .eq("provider", PROBE_PROVIDER);
    if (error) throw new Error(`probe read failed: ${error.message}`);
    const rows = data ?? [];
    const spent = rows.reduce(
      (total, row) =>
        total +
        (row.state === "reserved"
          ? Number(row.reserved_tokens ?? 0)
          : Number(row.charged_tokens ?? 0)),
      0,
    );
    return { spent, rows: rows.length };
  };

  const before = await ledger.spentToday();
  console.log(`\nDay total before: ${before} tokens`);
  let cleaned = false;

  try {
    // ---- 1. Generation reservations: a budget only GENERATION_ADMITS can fit ----
    const budget = before + GENERATION_RESERVE * GENERATION_ADMITS;
    console.log(
      `\nGeneration: budget ${budget} tokens (current ${before} + ${GENERATION_ADMITS} x ${GENERATION_RESERVE}), ` +
        `firing ${CONCURRENCY} simultaneous reservations ...`,
    );

    const started = Date.now();
    const decisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        ledger.admitGeneration({
          reserveTokens: GENERATION_RESERVE,
          budgetTokens: budget,
          provider: PROBE_PROVIDER,
          modelId: null,
          operation: "generate",
        }),
      ),
    );
    const elapsedMs = Date.now() - started;

    const granted = decisions.filter((decision) => decision.admitted);
    const refused = decisions.filter((decision) => !decision.admitted);
    const grantedTokens = granted.reduce(
      (total, decision) => total + decision.reservation!.reservedTokens,
      0,
    );

    console.log(`  ${CONCURRENCY} concurrent admissions in ${elapsedMs} ms`);
    console.log(`  granted ${granted.length}, refused ${refused.length}`);
    console.log(`  granted capacity ${grantedTokens} / budget ${budget}`);

    const generationOk =
      granted.length === GENERATION_ADMITS &&
      grantedTokens <= GENERATION_ADMITS * GENERATION_RESERVE;

    console.log(
      generationOk
        ? `  PASS — exactly ${GENERATION_ADMITS} reservations granted; the budget was never over-committed`
        : `  FAIL — expected ${GENERATION_ADMITS} grants, saw ${granted.length}`,
    );
    if (refused[0]) console.log(`  refusal example: ${refused[0].detail}`);

    // ---- 2. Embedding request cap under the same concurrency ----
    //
    // The cap counts embedding rows for the UTC day across ALL providers, so the
    // existing usage is read from the ledger with that same predicate. It is
    // deliberately NOT read from `admitEmbedding`'s `usedToday`: the SQL function
    // returns a hardcoded 0 from its `p_max_calls <= 0` early return, so the one
    // call that writes nothing is also the one that cannot report the count.
    // The row arithmetic below is what makes a mis-calibration loud rather than
    // silent — if this predicate ever drifted from the function it describes,
    // either the grant count or the rows-added count would stop adding up.
    const embeddingRowsToday = async (): Promise<number> => {
      const { count, error } = await client
        .from("usage_ledger")
        .select("id", { count: "exact", head: true })
        .eq("day", utcDayKey())
        .eq("kind", "embedding_request");
      if (error) throw new Error(`embedding-request count failed: ${error.message}`);
      return count ?? 0;
    };

    const rowsBeforeEmbedding = await embeddingRowsToday();
    const embeddingCap = rowsBeforeEmbedding + EMBEDDING_ADMITS;

    console.log(
      `\nEmbedding: ${rowsBeforeEmbedding} request(s) already recorded today, so cap is set to ` +
        `${embeddingCap} (existing + ${EMBEDDING_ADMITS}); firing ${CONCURRENCY} simultaneously ...`,
    );

    const embeddingDecisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        ledger.admitEmbedding({
          maxCalls: embeddingCap,
          provider: PROBE_PROVIDER,
          modelId: null,
        }),
      ),
    );
    const rowsAfterEmbedding = await embeddingRowsToday();

    const embeddingGranted = embeddingDecisions.filter((decision) => decision.admitted).length;
    const embeddingRefused = embeddingDecisions.length - embeddingGranted;
    const rowsAdded = rowsAfterEmbedding - rowsBeforeEmbedding;
    const grantOk = embeddingGranted === EMBEDDING_ADMITS;
    const refusalOk = embeddingRefused === CONCURRENCY - EMBEDDING_ADMITS;
    // Every granted admission writes exactly one row and no refusal writes any:
    // this is what makes the calibration probe's read-only-ness a checked fact.
    const rowsOk = rowsAdded === embeddingGranted;
    const embeddingOk = grantOk && refusalOk && rowsOk;

    console.log(`  granted ${embeddingGranted}, refused ${embeddingRefused} of ${CONCURRENCY}`);
    console.log(
      `  embedding rows for ${utcDayKey()}: ${rowsBeforeEmbedding} -> ${rowsAfterEmbedding} (${rowsAdded} added)`,
    );
    console.log(
      embeddingOk
        ? `  PASS — the cap bound at exactly the remaining allowance of ${EMBEDDING_ADMITS} across concurrent callers, and no refused admission wrote a row`
        : `  FAIL — expected ${EMBEDDING_ADMITS} grants, ${CONCURRENCY - EMBEDDING_ADMITS} refusals and ${EMBEDDING_ADMITS} rows added; saw ${embeddingGranted} grants, ${embeddingRefused} refusals and ${rowsAdded} rows added`,
    );

    const dayTotalNow = await ledger.spentToday();
    console.log(
      `\nDay total with probe rows present: ${dayTotalNow} (expected ${before + grantedTokens}: ${before} before + ${grantedTokens} reserved; the ${embeddingGranted} embedding rows count as requests and hold no tokens)`,
    );

    console.log(
      generationOk && embeddingOk
        ? "\nRESULT: PASS — concurrent admission cannot over-reserve this budget."
        : "\nRESULT: FAIL — see the lines above; do not treat this as proven.",
    );
    if (!generationOk || !embeddingOk) process.exitCode = 1;
  } finally {
    const { error } = await client.from("usage_ledger").delete().eq("provider", PROBE_PROVIDER);
    if (error) {
      console.error(`\nCLEANUP FAILED (${error.message}) — probe rows may remain in usage_ledger.`);
      process.exitCode = 1;
    } else {
      cleaned = true;
    }
  }

  const after = await probeTotals();
  const dayTotalAfter = await ledger.spentToday();
  console.log(`\nProbe rows remaining: ${after.rows}; probe spend remaining: ${after.spent}`);
  console.log(`Day total after cleanup: ${dayTotalAfter}`);
  console.log(
    cleaned && after.rows === 0
      ? "CLEANUP: complete — the ledger is back to the state it was found in."
      : "CLEANUP: incomplete — inspect usage_ledger for provider 'concurrency-probe'.",
  );
  if (dayTotalAfter !== before) {
    console.log(`NOTE: the day total moved from ${before} to ${dayTotalAfter}; another process may be recording usage.`);
  }
}

main().catch((error) => {
  console.error(`\nVerification failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
