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

const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const EMBEDDING_NAMES = ["HORIZON_EMBEDDING_MODEL", "HORIZON_EMBEDDING_DIMENSIONS"];
const PROVIDER_KEY_NAMES = [
  "HORIZON_LLM_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
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
  const providerKey = presentNames(PROVIDER_KEY_NAMES);
  const hasAnyProviderKey = providerKey.set.length > 0;

  console.log(`Database names set: ${db.set.length}/${REQUIRED_DB_NAMES.length}`);
  console.log(
    `Provider credential set: ${hasAnyProviderKey ? "yes" : "no"} (names checked, no value read)`,
  );

  const missing: string[] = [];
  if (db.missing.length > 0) missing.push(`not set: ${db.missing.join(", ")}`);
  if (!hasAnyProviderKey) {
    missing.push(
      `no runtime credential — one of ${PROVIDER_KEY_NAMES.join(" / ")} must be set, ` +
        "because the offline lexical embedder may not be persisted as a semantic embedding",
    );
  }
  if (embedding.missing.length > 0) {
    missing.push(`not set: ${embedding.missing.join(", ")} (defaults will be used)`);
  }
  if (db.missing.length > 0 || !hasAnyProviderKey) {
    fail([
      ...missing,
      "",
      "Manual steps required before this command can run:",
      "  1. Apply supabase/migrations/0001_init.sql then 0002_search_functions.sql",
      "     in the Supabase Dashboard SQL Editor (see docs/apply-migration.md).",
      "  2. Put NEXT_PUBLIC_SUPABASE_URL and the service-role key in .env.local.",
      "  3. Put the runtime provider credential in .env.local (server-side only).",
      "  4. Put HORIZON_LLM_PROVIDER=google-genai and HORIZON_LLM_MODEL in .env.local.",
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
  const { providers, config } = createServerContext();
  console.log(`Active embedder: ${providers.embeddingProviderId}`);

  if (!providers.configured) {
    fail([
      "The runtime provider is not configured, so no real embeddings can be produced.",
      "Set HORIZON_LLM_PROVIDER=google-genai, HORIZON_LLM_MODEL and the credential,",
      "then run this command again. The demo corpus will not be seeded with placeholder vectors.",
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
    ]);
  }
}

main().catch(() => {
  // `fail` already printed the reason and set the exit code.
  if (!process.exitCode) process.exitCode = 1;
});
