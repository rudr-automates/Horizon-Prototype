import { createRuntimeProviders, type RuntimeProviders } from "@/lib/answer/providers";
import { readRuntimeConfig, type RuntimeConfig } from "@/lib/config";
import { readServerEnv } from "@/lib/env";
import { resolveEvidenceStore, type EvidenceStoreResolution } from "@/lib/retrieval";
import { resolveUsageLedger, type UsageLedgerResolution } from "@/lib/usage";

export interface ServerContext {
  config: RuntimeConfig;
  providers: RuntimeProviders;
  storeResolution: EvidenceStoreResolution;
  usageResolution: UsageLedgerResolution;
}

/**
 * Assemble server dependencies from the environment. Called per request; all
 * work here is cheap and no secret value is ever returned to a caller.
 */
export function createServerContext(): ServerContext {
  const env = readServerEnv();
  const config = readRuntimeConfig(env);
  const providers = createRuntimeProviders(config);
  const storeResolution = resolveEvidenceStore(env, providers.embedder);
  const usageResolution = resolveUsageLedger(env);

  return { config, providers, storeResolution, usageResolution };
}
