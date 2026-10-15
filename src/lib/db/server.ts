import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env";

/**
 * Server-only Supabase access.
 *
 * Never import this module from a client component. Never place the
 * service-role key in a NEXT_PUBLIC_ variable.
 */

/** The database URL exists. Says nothing about credentials. */
export function hasDatabaseUrl(env: ServerEnv): boolean {
  return env.supabaseUrl.trim() !== "";
}

/**
 * The key the DATA PATH actually uses is present.
 *
 * Reported separately from the URL because "the URL is set but no credential
 * is" is a different problem from "nothing is configured", and collapsing the
 * two made the health output less actionable than it looked.
 */
export function hasServiceRoleKey(env: ServerEnv): boolean {
  return env.supabaseServiceRoleKey.trim() !== "";
}

/**
 * The app's configuration gate, unchanged in meaning: the URL and the anon key
 * are both present.
 *
 * The anon key is required here because it is what the app historically tested
 * for; it is NOT the key the data path authenticates with.
 */
export function isDatabaseConfigured(env: ServerEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

export interface DatabaseReadProbe {
  /** True only when an AUTHENTICATED, minimal read actually succeeded. */
  ok: boolean;
  /** Generic, safe to return to a public client. Never a raw database error. */
  detail: string;
}

/**
 * Prove the database is readable, not merely reachable.
 *
 * WHY THIS REPLACED A REACHABILITY PROBE
 *   The previous probe fetched `/rest/v1/` and returned true for ANY HTTP
 *   response — including 401 and 403. A deployment with a wrong, revoked or
 *   wrongly-scoped key therefore reported a healthy database while being unable
 *   to read a single row, which is worse than reporting nothing.
 *
 * This performs a real HEAD count against a required table with the service-role
 * key. It returns a boolean and a generic sentence: the underlying error is
 * logged server-side (never the key, never a raw payload) because database error
 * text can describe schema internals that a public endpoint must not disclose.
 */
export async function probeDatabaseReadable(
  env: ServerEnv,
  timeoutMs = 5000,
): Promise<DatabaseReadProbe> {
  if (!isDatabaseConfigured(env)) {
    return { ok: false, detail: "The database URL or anon key is not set." };
  }
  if (!hasServiceRoleKey(env)) {
    return {
      ok: false,
      detail: "The service-role key is not set, so no authenticated read was attempted.",
    };
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    return { ok: false, detail: "A database client could not be created from the configured values." };
  }

  try {
    const { error } = await withTimeout(
      client.from("courses").select("id", { count: "exact", head: true }),
      timeoutMs,
    );

    if (error) {
      console.error(`[horizon] database read probe failed: ${error.message}`);
      return {
        ok: false,
        detail: "An authenticated read of the database failed. See server logs.",
      };
    }
    return { ok: true, detail: "An authenticated read of the database succeeded." };
  } catch (error) {
    console.error(
      `[horizon] database read probe threw: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { ok: false, detail: "The database read probe did not complete." };
  }
}

export interface SchemaStatus {
  tablesPresent: number;
  tablesExpected: number;
  coreFunctionsPresent: number;
  coreFunctionsExpected: number;
  /** Migration 0003's reservation columns and functions are all present. */
  atomicBudgetObjects: boolean;
  /** The ledger table could actually be read by the database itself. */
  ledgerReadable: boolean;
}

/**
 * Ask the database what exists, in aggregate.
 *
 * Returns COUNTS and BOOLEANS only, so a public caller cannot enumerate the
 * schema from it. `null` means the probe could not run at all — which is itself
 * the signal that migration 0003 (or any migration) is missing.
 */
export async function probeSchemaStatus(
  env: ServerEnv,
  timeoutMs = 5000,
): Promise<SchemaStatus | null> {
  if (!isDatabaseConfigured(env) || !hasServiceRoleKey(env)) return null;

  const client = createServiceRoleClient(env);
  if (!client) return null;

  try {
    const { data, error } = await withTimeout(client.rpc("horizon_schema_status"), timeoutMs);
    if (error) {
      console.error(`[horizon] schema status probe failed: ${error.message}`);
      return null;
    }

    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
    if (!row) return null;

    const num = (value: unknown): number => {
      const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    return {
      tablesPresent: num(row.tables_present),
      tablesExpected: num(row.tables_expected),
      coreFunctionsPresent: num(row.core_functions_present),
      coreFunctionsExpected: num(row.core_functions_expected),
      atomicBudgetObjects: row.atomic_budget_objects === true,
      ledgerReadable: row.ledger_readable === true,
    };
  } catch (error) {
    console.error(
      `[horizon] schema status probe threw: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

/**
 * A hung database must not hang the health endpoint. The timeout rejects rather
 * than returning a partially-typed value, so every caller treats it as a
 * failure — which is the correct reading of "no answer in time".
 */
async function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("database probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Service-role client for server tasks. Returns null when unconfigured rather
 * than throwing, so callers can report "not configured" honestly.
 */
export function createServiceRoleClient(env: ServerEnv): SupabaseClient | null {
  if (!env.supabaseUrl || !env.supabaseServiceRoleKey) return null;
  return createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
