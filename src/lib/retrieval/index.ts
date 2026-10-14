import type { Embedder } from "@/lib/answer/provider";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import type { ServerEnv } from "@/lib/env";
import { FixtureEvidenceStore } from "@/lib/retrieval/fixture-store";
import {
  createSupabaseGateway,
  SupabaseEvidenceStore,
} from "@/lib/retrieval/supabase-store";
import type { EvidenceStore } from "@/lib/retrieval/types";

export interface EvidenceStoreResolution {
  store: EvidenceStore;
  /** Plain-language reason for the choice; surfaced so demo mode is obvious. */
  reason: string;
}

/**
 * Choose the evidence store.
 *
 * The Supabase store is used only when the URL, anon key AND service-role key
 * are all present. Otherwise the labelled sample fixture corpus is used. The
 * reason string is shown in the UI so nobody mistakes fixture data for a
 * populated database.
 */
export function resolveEvidenceStore(
  env: ServerEnv,
  embedder: Embedder,
): EvidenceStoreResolution {
  const fullyConfigured =
    isDatabaseConfigured(env) && env.supabaseServiceRoleKey.trim() !== "";

  if (!fullyConfigured) {
    return {
      store: new FixtureEvidenceStore(embedder),
      reason:
        "Supabase is not fully configured (URL, anon key and service-role key are required), so the labelled sample fixture corpus is used.",
    };
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    return {
      store: new FixtureEvidenceStore(embedder),
      reason:
        "A Supabase client could not be created from the configured values, so the labelled sample fixture corpus is used.",
    };
  }

  return {
    store: new SupabaseEvidenceStore(createSupabaseGateway(client)),
    reason: "Supabase is configured; using the database-backed evidence store.",
  };
}
