import type { ServerEnv } from "@/lib/env";

/**
 * Runtime provider configuration.
 *
 * TWO CREDENTIALS, TWO VENDORS
 *   Generation runs on Groq's OpenAI-compatible Chat Completions API; embeddings
 *   still run on Google's Gemini embedding model, because the persisted corpus
 *   in Supabase was embedded with it and stored vectors are only comparable
 *   within one model. `apiKey` is therefore the GENERATION credential and
 *   `embeddingApiKey` is the EMBEDDING credential. Nothing here falls back from
 *   one to the other except the one legacy case documented in `src/lib/env.ts`.
 *
 * WHY THE BASE URL IS NO LONGER MERELY OPTIONAL
 *   The Google Gen AI SDK resolves its own endpoint, so for `google-genai` an
 *   absent base URL is the normal case. An OpenAI-compatible provider is the
 *   opposite: the endpoint IS configuration, and a request to the wrong host
 *   fails in a way that looks like an authentication problem. `generationBaseUrl`
 *   below is therefore resolved to a concrete value for a provider that needs
 *   one, and `baseUrlOverride` keeps the raw setting for the Google SDK.
 */
export type LlmProvider = "groq" | "google-genai" | "unconfigured";

/** Google Gemini provider id, and the only embedding implementation configured. */
export const GOOGLE_PROVIDER_ID = "google-genai";
export const GROQ_PROVIDER_ID = "groq";

/** Documented default endpoint for Groq's OpenAI-compatible API. */
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
/** Relative path appended to a base URL for a Chat Completions request. */
export const CHAT_COMPLETIONS_PATH = "/chat/completions";

export const DEFAULT_TEXT_MODEL = "gemini-3.6-flash";
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
/**
 * Raised from 1024 after a live failure on a reasoning model.
 *
 * A reasoning model spends tokens on thinking before it emits anything, and on
 * both providers those tokens count against the output allowance. Observed live:
 * 984 thinking tokens against a 1024 cap, which left only 21 visible tokens and
 * truncated the JSON mid-object. A cap that does not leave room for reasoning
 * above the answer is not a safe default for structured output.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;
export const DEFAULT_EMBEDDING_MODEL = "gemini-embedding-001";
export const DEFAULT_EMBEDDING_DIMENSIONS = 768;

/** Reasoning-effort values Groq accepts for its reasoning models. */
export const REASONING_EFFORTS = ["low", "medium", "high"] as const;

export interface RuntimeConfig {
  provider: LlmProvider;
  /** Generation credential. Never serialized into a response. */
  apiKey: string;
  model: string;
  /**
   * Raw endpoint override from the environment. Empty means "the provider's own
   * default". It is applied to the Google SDK ONLY when the provider is Google:
   * it names the GENERATION endpoint, and pointing the embedding client at it
   * would send a Google request to a non-Google host.
   */
  baseUrlOverride: string;
  /**
   * The generation endpoint actually in use. Resolved to a concrete value for a
   * provider whose API requires one, and empty when the provider resolves its
   * own endpoint.
   */
  generationBaseUrl: string;
  /** low | medium | high, or null to send no reasoning hint at all. */
  reasoningEffort: string | null;
  /** EMBEDDING credential. Separate from `apiKey`; never serialized. */
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;
  maxOutputTokens: number;
  dailyTokenBudget: number;
  /**
   * Explicit ceiling on embedding REQUESTS per process. Kept separate from the
   * token budget because the embeddings API reports no token usage. 0 = no cap.
   */
  maxEmbeddingCalls: number;
  /**
   * Explicit reasoning-token budget. Google-genai only: it is sent as
   * `thinkingConfig`. null means "do not send it", leaving the model's own
   * default in place. 0 disables thinking; -1 is the provider's "automatic".
   * It has no equivalent on Groq and is reported as ignored there rather than
   * silently dropped.
   */
  thinkingBudget: number | null;
  requestTimeoutMs: number;
}

export function parseLlmProvider(raw: string): LlmProvider {
  const value = raw.trim().toLowerCase();
  if (value === "groq") return GROQ_PROVIDER_ID;
  if (value === "google-genai" || value === "gemini" || value === "google") {
    return GOOGLE_PROVIDER_ID;
  }
  return "unconfigured";
}

function parseReasoningEffort(raw: string): string | null {
  const value = raw.trim().toLowerCase();
  return (REASONING_EFFORTS as readonly string[]).includes(value) ? value : null;
}

function defaultModelFor(provider: LlmProvider): string {
  return provider === GROQ_PROVIDER_ID ? DEFAULT_GROQ_MODEL : DEFAULT_TEXT_MODEL;
}

/**
 * The endpoint a generation request is actually sent to.
 *
 * An OpenAI-compatible provider needs a host, so its documented default is
 * applied rather than leaving the request to fail. Google's SDK resolves its own
 * endpoint, so there an absent value stays absent.
 */
export function resolveGenerationBaseUrl(
  provider: LlmProvider,
  override: string,
): string {
  const trimmed = override.trim();
  if (trimmed !== "") return trimmed;
  return provider === GROQ_PROVIDER_ID ? GROQ_BASE_URL : "";
}

export function readRuntimeConfig(env: ServerEnv): RuntimeConfig {
  const provider = parseLlmProvider(env.llmProvider);
  return {
    provider,
    apiKey: env.llmApiKey,
    model: env.llmModel || defaultModelFor(provider),
    baseUrlOverride: env.llmBaseUrl,
    generationBaseUrl: resolveGenerationBaseUrl(provider, env.llmBaseUrl),
    reasoningEffort: parseReasoningEffort(env.llmReasoningEffort),
    embeddingApiKey: env.embeddingApiKey,
    embeddingModel: env.embeddingModel || DEFAULT_EMBEDDING_MODEL,
    embeddingDimensions: env.embeddingDimensions || DEFAULT_EMBEDDING_DIMENSIONS,
    maxOutputTokens: env.llmMaxOutputTokens,
    dailyTokenBudget: env.dailyTokenBudget,
    maxEmbeddingCalls: env.maxEmbeddingCalls,
    thinkingBudget: env.llmThinkingBudget,
    requestTimeoutMs: env.requestTimeoutMs,
  };
}

/**
 * "Configured" means the required names are present for the GENERATION call.
 * It does NOT mean the provider works — that requires a real smoke test — and it
 * says nothing about embeddings, which have their own credential.
 */
export function isRuntimeAiConfigured(config: RuntimeConfig): boolean {
  return (
    config.provider !== "unconfigured" &&
    config.apiKey.trim() !== "" &&
    config.model.trim() !== ""
  );
}

/**
 * Whether a real embedding model can be called.
 *
 * Distinct from `isRuntimeAiConfigured` because the two have different
 * credentials and different failure modes. Without this, a Groq key alone would
 * report the runtime as fully configured while the vector branch had nothing but
 * the offline lexical stand-in.
 */
export function isEmbeddingConfigured(config: RuntimeConfig): boolean {
  return config.embeddingApiKey.trim() !== "" && config.embeddingModel.trim() !== "";
}

/**
 * Configuration problems an operator must fix, in plain language.
 *
 * Reported instead of inferred: a wrong provider name, a misplaced credential
 * and a meaningless leftover setting all produce the same class of confusing
 * symptom (a refusal that looks like an outage), and each has a different fix.
 * Never contains a credential VALUE.
 */
export function describeConfigurationProblems(config: RuntimeConfig): string[] {
  const problems: string[] = [];

  if (config.provider === "unconfigured") {
    problems.push(
      "HORIZON_LLM_PROVIDER is empty or not recognised. Set it to \"groq\" (or \"google-genai\"); until then no generation call is possible.",
    );
  } else if (config.apiKey.trim() === "") {
    problems.push(
      "HORIZON_LLM_API_KEY is not set, so no generation call is possible.",
    );
  }

  if (!isEmbeddingConfigured(config)) {
    problems.push(
      "HORIZON_EMBEDDING_API_KEY is not set, so the question cannot be embedded with the model that embedded the stored corpus.",
    );
  }

  if (config.provider === GROQ_PROVIDER_ID && config.baseUrlOverride !== "") {
    const url = config.baseUrlOverride;
    if (!/^https:\/\//i.test(url) || /\s/.test(url)) {
      problems.push(
        "HORIZON_LLM_BASE_URL is not a plain https URL, so the generation endpoint may be unusable.",
      );
    }
  }

  if (config.provider === GROQ_PROVIDER_ID && config.thinkingBudget !== null) {
    problems.push(
      "HORIZON_LLM_THINKING_BUDGET is set but has no meaning for the groq provider, so it is ignored. Use HORIZON_LLM_REASONING_EFFORT (low, medium, high) instead.",
    );
  }

  return problems;
}
