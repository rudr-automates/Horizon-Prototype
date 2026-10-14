import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ServerEnv } from "@/lib/env";

/**
 * Server-only Supabase access.
 *
 * Never import this module from a client component. Never place the
 * service-role key in a NEXT_PUBLIC_ variable.
 */

export function isDatabaseConfigured(env: ServerEnv): boolean {
  return Boolean(env.supabaseUrl && env.supabaseAnonKey);
}

/**
 * Probe whether the Supabase REST endpoint answers at all.
 *
 * Returns:
 *  - null  → not configured, so nothing was probed.
 *  - true  → the endpoint returned an HTTP response.
 *  - false → the request failed (network error, DNS, timeout).
 *
 * IMPORTANT: this does NOT verify that migrations are applied or that any
 * table exists. It only proves the host responds. Health reporting must keep
 * those two claims separate.
 */
export async function probeDatabaseReachable(
  env: ServerEnv,
  timeoutMs = 4000,
): Promise<boolean | null> {
  if (!isDatabaseConfigured(env)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = env.supabaseUrl.replace(/\/+$/, "");
    await fetch(`${base}/rest/v1/`, {
      method: "GET",
      headers: {
        apikey: env.supabaseAnonKey,
        authorization: `Bearer ${env.supabaseAnonKey}`,
      },
      signal: controller.signal,
      cache: "no-store",
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
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
