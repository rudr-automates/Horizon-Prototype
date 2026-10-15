import type { ServerEnv } from "@/lib/env";

/**
 * Runtime provider configuration.
 *
 * The Google Gen AI SDK resolves its own endpoint, so there is no meaningful
 * generic base URL. `HORIZON_LLM_BASE_URL` is therefore treated as an OPTIONAL
 * override rather than a required setting. This is a deliberate departure from
 * the OpenAI-compatible shape and is recorded in docs/DECISIONS.md.
 */
export type LlmProvider = "google-genai" | "unconfigured";

export const DEFAULT_TEXT_MODEL = "gemini-3.6-flash";
/**
 * Raised from 1024 after a live failure.
 *
 * gemini-3.6-flash spends REASONING tokens, and reasoning counts against
 * maxOutputTokens. Observed live: 984 thinking tokens against a 1024 cap, which
 * left only 21 visible tokens and truncated the JSON mid-object. A cap that does
 * not leave room for thinking above the answer is not a safe default for
 * structured output.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

export interface RuntimeConfig {
  provider: LlmProvider;
  /** Provider credential. Never serialized into a response. */
  apiKey: string;
  model: string;
  embeddingModel: string;
  embeddingDimensions: number;
  /** Optional endpoint override; empty means "use the SDK default". */
  baseUrlOverride: string;
  maxOutputTokens: number;
  dailyTokenBudget: number;
  /**
   * Explicit ceiling on embedding REQUESTS per process. Kept separate from the
   * token budget because the embeddings API reports no token usage. 0 = no cap.
   */
  maxEmbeddingCalls: number;
  /**
   * Explicit reasoning-token budget. null means "do not send thinkingConfig",
   * leaving the model's own default in place. 0 disables thinking; -1 is the
   * provider's "automatic". Bounding this keeps reasoning from consuming the
   * whole output allowance and keeps per-call cost predictable.
   */
  thinkingBudget: number | null;
  requestTimeoutMs: number;
}

function parseProvider(raw: string): LlmProvider {
  const value = raw.trim().toLowerCase();
  if (value === "google-genai" || value === "gemini" || value === "google") {
    return "google-genai";
  }
  return "unconfigured";
}

export function readRuntimeConfig(env: ServerEnv): RuntimeConfig {
  return {
    provider: parseProvider(env.llmProvider),
    apiKey: env.llmApiKey,
    model: env.llmModel || DEFAULT_TEXT_MODEL,
    embeddingModel: env.embeddingModel || DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: env.embeddingDimensions || DEFAULT_EMBEDDING_DIMENSIONS,
    baseUrlOverride: env.llmBaseUrl,
    maxOutputTokens: env.llmMaxOutputTokens,
    dailyTokenBudget: env.dailyTokenBudget,
    maxEmbeddingCalls: env.maxEmbeddingCalls,
    thinkingBudget: env.llmThinkingBudget,
    requestTimeoutMs: env.requestTimeoutMs,
  };
}

/**
 * "Configured" means the required names are present. It does NOT mean the
 * provider works — that requires a real smoke test, which is still unperformed.
 */
export function isRuntimeAiConfigured(config: RuntimeConfig): boolean {
  return (
    config.provider === "google-genai" &&
    config.apiKey.trim() !== "" &&
    config.model.trim() !== ""
  );
}
