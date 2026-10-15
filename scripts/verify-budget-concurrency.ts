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
 * It makes NO provider call and therefore cannot spend Gemini quota.
 */
import { loadEnvFile } from "./env-file";

const PROBE_PROVIDER = "concurrency-probe";
const GENERATION_RESERVE = 1200;
const GENERATION_ADMITS = 4;
const EMBEDDING_CAP = 3;
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
    console.log(`\nEmbedding: cap ${EMBEDDING_CAP} requests, firing ${CONCURRENCY} simultaneously ...`);
    const embeddingDecisions = await Promise.all(
      Array.from({ length: CONCURRENCY }, () =>
        ledger.admitEmbedding({
          maxCalls: EMBEDDING_CAP,
          provider: PROBE_PROVIDER,
          modelId: null,
        }),
      ),
    );
    const embeddingGranted = embeddingDecisions.filter((decision) => decision.admitted).length;
    const embeddingOk = embeddingGranted === EMBEDDING_CAP;
    console.log(`  granted ${embeddingGranted} of ${CONCURRENCY}`);
    console.log(
      embeddingOk
        ? `  PASS — the cap bound at exactly ${EMBEDDING_CAP} across concurrent callers`
        : `  FAIL — expected ${EMBEDDING_CAP} grants, saw ${embeddingGranted}`,
    );

    const dayTotalNow = await ledger.spentToday();
    console.log(
      `\nDay total with probe rows present: ${dayTotalNow} (expected ${before + grantedTokens} plus the reserved headroom of the ${embeddingGranted} embedding rows, which hold no tokens)`,
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
