/**
 * Seed the labelled synthetic demo corpus into Supabase through the real data
 * path, using real embeddings from the configured provider.
 *
 *   pnpm seed:demo
 *
 * This is an OPERATOR command, not a test. It refuses to run rather than
 * pretending: with no database credential, no migration, or only the offline
 * lexical embedder, it stops with an explicit reason and writes nothing.
 *
 * Secrets never reach stdout. Only names, counts and the embedding model name
 * are printed.
 */
import { loadEnvFile, presentNames } from "./env-file";

// The anon key is listed even though this command writes with the service role:
// `isDatabaseConfigured` (and therefore the app's whole database path) requires
// the URL, the anon key and the service-role key together. Checking only two of
// the three let this pre-flight report "2/2 set" and then refuse further down
// with a vaguer message, which is exactly the kind of partial truth the refusal
// messages exist to avoid.
const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const EMBEDDING_NAMES = ["HORIZON_EMBEDDING_MODEL", "HORIZON_EMBEDDING_DIMENSIONS"];
/**
 * Names this command's early check accepts as "a credential that can embed".
 *
 * This command only ever embeds, so the embedding credential is the one it
 * needs. HORIZON_LLM_API_KEY is listed because it is still a valid legacy
 * fallback when the generation provider is Google — NOT because it is an
 * embedding key in general, which under a non-Google provider it is not.
 *
 * Presence here is a pre-flight hint only. The authoritative check is
 * `providers.embeddingConfigured` below, which applies the real resolution rule
 * and refuses when the embedder would be the offline lexical stand-in.
 */
const EMBEDDING_KEY_NAMES = [
  "HORIZON_EMBEDDING_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "HORIZON_LLM_API_KEY",
];

function fail(lines: string[]): never {
  console.error("\nSEED REFUSED — nothing was written.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exitCode = 1;
  throw new Error("seed refused");
}

async function main(): Promise<void> {
  const loaded = loadEnvFile();
  console.log(`Environment file .env.local: ${loaded ? "loaded" : "not present"}`);

  const db = presentNames(REQUIRED_DB_NAMES);
  const embedding = presentNames(EMBEDDING_NAMES);
  const embeddingKey = presentNames(EMBEDDING_KEY_NAMES);
  const hasAnyEmbeddingKey = embeddingKey.set.length > 0;

  console.log(`Database names set: ${db.set.length}/${REQUIRED_DB_NAMES.length}`);
  console.log(
    `Embedding credential set: ${hasAnyEmbeddingKey ? "yes" : "no"} (names checked, no value read)`,
  );

  const missing: string[] = [];
  if (db.missing.length > 0) missing.push(`not set: ${db.missing.join(", ")}`);
  if (!hasAnyEmbeddingKey) {
    missing.push(
      `no embedding credential — set HORIZON_EMBEDDING_API_KEY (one of ${EMBEDDING_KEY_NAMES.join(" / ")} is accepted), ` +
        "because the offline lexical embedder may not be persisted as a semantic embedding",
    );
  }
  if (embedding.missing.length > 0) {
    missing.push(`not set: ${embedding.missing.join(", ")} (defaults will be used)`);
  }
  if (db.missing.length > 0 || !hasAnyEmbeddingKey) {
    fail([
      ...missing,
      "",
      "Manual steps required before this command can run:",
      // Phrased as a confirmation, not an instruction: this command cannot see
      // the schema from here, so asserting that the migrations are missing would
      // be a guess. It says what must be true, and how to check.
      "  1. Confirm supabase/migrations/0001_init.sql, 0002_search_functions.sql",
      "     and 0003_atomic_budget.sql are applied (verify in the Supabase Dashboard",
      "     SQL Editor; see docs/apply-migration.md). All three are needed here:",
      "     this command claims the same durable embedding cap the serving path",
      "     uses, and that cap is served by 0003.",
      "  2. Put NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and the",
      "     service-role key in .env.local. All three are required: the anon key is",
      "     what the app's configuration check tests for.",
      "  3. Put HORIZON_EMBEDDING_API_KEY in .env.local (server-side only). This is",
      "     the Google key, and it is used ONLY for embeddings: the stored vectors",
      "     must come from the same model as the question vectors.",
      "  4. Optionally set the generation variables (HORIZON_LLM_PROVIDER,",
      "     HORIZON_LLM_BASE_URL, HORIZON_LLM_MODEL, HORIZON_LLM_API_KEY). This",
      "     command does not generate anything, so it does not need them.",
    ]);
  }

  if (missing.length > 0) {
    console.log(`Notes:\n  ${missing.join("\n  ")}`);
  }

  const { buildSeedPlan, applySeedPlan, createSupabaseSeedGateway, SeedRefused } =
    await import("@/lib/ingest/seed");
  const { createServerContext } = await import("@/lib/server/context");
  const { isDatabaseConfigured, createServiceRoleClient } = await import(
    "@/lib/db/server"
  );
  const { readServerEnv } = await import("@/lib/env");

  const env = readServerEnv();
  if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
    fail(["The database is not fully configured, so no client could be created."]);
  }

  const client = createServiceRoleClient(env);
  if (!client) fail(["A Supabase service-role client could not be created."]);

  // The provider bundle decides which embedder is active, so it is the single
  // source of truth for whether real embeddings are possible.
  const { providers, config, usageResolution } = createServerContext();
  console.log(`Active embedder: ${providers.embeddingProviderId}`);
  // Being explicit matters: an operator could otherwise assume the daily token
  // budget bounds this command, and it does not.
  console.log(
    `Spend guard: budget ${config.dailyTokenBudget} tokens; embedding calls are NOT metered by it.`,
  );

  if (!providers.embeddingConfigured) {
    fail([
      "No real embedding model is available, so this corpus cannot be seeded.",
      providers.embedderDetail,
      "Set HORIZON_EMBEDDING_API_KEY to the Google key used for embeddings, then run",
      "this command again. The corpus will not be seeded with placeholder vectors.",
    ]);
  }

  // This command makes a REAL embedding request, so it claims the same durable
  // request cap the serving path uses instead of quietly sitting outside it.
  // Refusing here is the correct outcome when the day's cap is already spent.
  const embeddingAdmission = await usageResolution.ledger.admitEmbedding({
    maxCalls: config.maxEmbeddingCalls,
    provider: providers.embeddingProviderId,
    modelId: config.embeddingModel,
  });
  console.log(
    `Embedding request admission (${usageResolution.ledger.mode} cap): ${embeddingAdmission.admitted ? "granted" : "refused"} — ${embeddingAdmission.detail}`,
  );
  if (!embeddingAdmission.admitted) {
    fail([
      embeddingAdmission.detail,
      `Ledger mode: ${usageResolution.ledger.mode}.`,
      "No embedding request was sent, so nothing was written and no capacity was consumed beyond this refusal.",
    ]);
  }

  try {
    const plan = await buildSeedPlan({
      embedder: providers.embedder,
      embeddingModel: config.embeddingModel,
    });

    console.log(
      `Embedding with ${plan.provenance.embeddingModel} at ${plan.provenance.embeddingDimensions} dimensions: ` +
        `${plan.provenance.blockCount} blocks, ${plan.provenance.resourceCount} resources.`,
    );

    const result = await applySeedPlan(createSupabaseSeedGateway(client), plan);

    console.log("\nSeed complete:");
    console.log(`  courses   ${result.courses}`);
    console.log(`  resources ${result.resources}`);
    console.log(`  blocks    ${result.blocks}`);
    console.log(`  course id ${String(plan.course.id)}`);
    console.log(
      "\nThis run has asserted nothing about retrieval quality. Verify the database path" +
        "\nby re-requesting /api/v1/health and confirming evidenceSource is \"supabase\".",
    );
  } catch (error) {
    if (error instanceof SeedRefused) {
      fail([error.message]);
    }
    fail([
      `Unexpected failure: ${error instanceof Error ? error.name : "unknown error"}.`,
      "No partial-success claim is made; re-run after fixing the cause.",
      "Note: the embedding request was already admitted, so it still counts against the day's embedding cap.",
    ]);
  }
}

main().catch(() => {
  // `fail` already printed the reason and set the exit code.
  if (!process.exitCode) process.exitCode = 1;
});
