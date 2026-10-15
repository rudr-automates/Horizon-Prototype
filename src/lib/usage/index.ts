import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import type { ServerEnv } from "@/lib/env";
import { InMemoryUsageLedger } from "@/lib/usage/memory-ledger";
import {
  createSupabaseUsageGateway,
  SupabaseUsageLedger,
} from "@/lib/usage/supabase-ledger";
import type { UsageLedger } from "@/lib/usage/types";

/**
 * Process-wide in-memory ledger.
 *
 * It MUST be shared across requests: building a fresh one per request would
 * reset the running total to zero every time and the cap would never bind.
 * It is intentionally module-scoped for the lifetime of the process.
 */
let sharedMemoryLedger: InMemoryUsageLedger | null = null;

export function getInMemoryUsageLedger(): InMemoryUsageLedger {
  if (!sharedMemoryLedger) sharedMemoryLedger = new InMemoryUsageLedger();
  return sharedMemoryLedger;
}

/** Test seam: drop the shared total so cases cannot leak into each other. */
export function resetInMemoryUsageLedger(): void {
  sharedMemoryLedger = null;
}

export interface UsageLedgerResolution {
  ledger: UsageLedger;
  /** Plain-language reason, surfaced so the weaker mode is never hidden. */
  reason: string;
}

/**
 * Choose the usage ledger.
 *
 * The durable ledger needs the database. Without it the in-memory ledger still
 * accumulates and still enforces a cap, but only for this process — the reason
 * string says so, and the response reports the mode.
 */
export function resolveUsageLedger(env: ServerEnv): UsageLedgerResolution {
  const configured = isDatabaseConfigured(env) && env.supabaseServiceRoleKey.trim() !== "";

  if (!configured) {
    return {
      ledger: getInMemoryUsageLedger(),
      reason:
        "No database is configured, so usage is counted in memory: the daily total is real for this process but resets on restart and is not shared between instances.",
    };
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    return {
      ledger: getInMemoryUsageLedger(),
      reason:
        "A Supabase client could not be created, so usage is counted in memory for this process only.",
    };
  }

  return {
    ledger: new SupabaseUsageLedger(createSupabaseUsageGateway(client)),
    reason: "Usage is recorded in the database, so the daily total is durable and shared.",
  };
}
