/**
 * Remove rate-limit counters whose windows have closed.
 *
 * NOT AUTOMATIC. Nothing schedules this in the repository, and the table does not
 * prune itself. Run it from an operator machine or a scheduler:
 *
 *   pnpm prune:rate-limits                  # dry run: report what is eligible
 *   pnpm prune:rate-limits --apply          # delete eligible rows
 *   pnpm prune:rate-limits --apply --retention-days=7
 *
 * SAFETY
 *   Eligibility is `window_start < now − retention − widest window`. For every
 *   configured window that means the window had already ended at least
 *   `retention` seconds ago, so an ACTIVE window can never be selected and a live
 *   counter can never be reset. The arithmetic lives in
 *   `src/lib/rate-limit/retention.ts` and is proven for every window in
 *   `tests/rate-limit-retention.test.ts`; every removed row is re-checked too.
 *
 *   Dry run is the default because the one thing this command must never do by
 *   accident is hand a client its allowance back.
 *
 * WHAT IT PRINTS
 *   The cutoff, the retention, and how many rows were eligible or deleted. No
 *   key, no address, no credential and no row content.
 */
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import { readServerEnv } from "@/lib/env";
import {
  DEFAULT_RETENTION_SECONDS,
  MAX_RATE_LIMIT_WINDOW_SECONDS,
  createSupabaseRetentionGateway,
  pruneExpiredRateLimits,
} from "@/lib/rate-limit/retention";
import { loadEnvFile } from "./env-file";

const DAY = 86_400;

function readRetentionSeconds(argv: string[]): number {
  const flag = argv.find((argument) => argument.startsWith("--retention-days="));
  if (!flag) return DEFAULT_RETENTION_SECONDS;

  const raw = flag.slice("--retention-days=".length);
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 0) {
    throw new Error("--retention-days must be a non-negative number");
  }
  return Math.round(days * DAY);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const retentionSeconds = readRetentionSeconds(argv);

  loadEnvFile();
  const env = readServerEnv();

  if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
    console.error(
      "The database is not configured (NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY), so there is nothing to prune.",
    );
    process.exitCode = 1;
    return;
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    console.error("A Supabase client could not be created from the configured values.");
    process.exitCode = 1;
    return;
  }

  const result = await pruneExpiredRateLimits(createSupabaseRetentionGateway(client), {
    retentionSeconds,
    apply,
  });

  console.log("Rate-limit retention");
  console.log(
    `  retention: ${(result.retentionSeconds / DAY).toFixed(2)} days after a window closes`,
  );
  console.log(`  widest window: ${MAX_RATE_LIMIT_WINDOW_SECONDS}s`);
  console.log(`  cutoff: ${result.cutoff}`);
  console.log(`  eligible rows: ${result.eligible}`);

  if (!result.applied) {
    console.log("DRY RUN — nothing was deleted. Re-run with --apply to delete these rows.");
    return;
  }
  console.log(`  deleted rows: ${result.deleted}`);
  console.log("Only rows whose windows had already closed were removed; active counters are untouched.");
}

main().catch((error: unknown) => {
  console.error(
    `Rate-limit prune failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
