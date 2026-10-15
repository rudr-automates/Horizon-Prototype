/**
 * Server-side environment access.
 *
 * This module reports only PRESENCE of configuration where it is asked to.
 * It never logs or returns secret values. Anything named here must stay
 * server-side unless it carries the NEXT_PUBLIC_ prefix.
 *
 * WHY THERE ARE NOW TWO CREDENTIALS
 *   Generation and embedding were previously both served by one key. That was
 *   only ever safe because both calls happened to go to the same vendor. With
 *   generation on Groq and embeddings still on Google, a single shared name
 *   would mean one of two things: a Groq key sent to Google's embedding
 *   endpoint (a guaranteed 401 that looks like an outage), or a Google key sent
 *   to Groq. So the names are separated and the fallback between them is
 *   restricted — see readEmbeddingKey below.
 */
import { DEFAULT_MAX_OUTPUT_TOKENS, parseLlmProvider } from "@/lib/config";

export interface ServerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;

  /** Runtime text model provider kind: "groq", "google-genai", or unrecognised. */
  llmProvider: string;
  /** Optional endpoint override for the GENERATION provider. */
  llmBaseUrl: string;
  /** Generation credential. Never exposed to the browser. */
  llmApiKey: string;
  llmModel: string;
  /** Reasoning-effort hint for a provider that supports it. "" = send nothing. */
  llmReasoningEffort: string;

  /**
   * Embedding credential. SEPARATE from the generation credential on purpose:
   * the two calls may go to different vendors, so one key must never stand in
   * for the other.
   */
  embeddingApiKey: string;
  embeddingModel: string;
  embeddingDimensions: number;

  llmMaxOutputTokens: number;
  dailyTokenBudget: number;
  /**
   * Ceiling on embedding requests per process. 0 means "no cap configured".
   * Exists because the embeddings API reports no token usage, so the token
   * budget cannot bound it.
   */
  maxEmbeddingCalls: number;
  /** Reasoning-token budget (Google-genai only). null = not configured. */
  llmThinkingBudget: number | null;
  requestTimeoutMs: number;
}

function read(name: string): string {
  return (process.env[name] ?? "").trim();
}

function readInt(name: string, fallback: number): number {
  const raw = read(name);
  if (raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Like readInt, but distinguishes "absent" from a value. Used where sending a
 * zero would mean something different from sending nothing at all.
 */
function readOptionalInt(name: string): number | null {
  const raw = read(name);
  if (raw === "") return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A generation-only credential. `HORIZON_LLM_API_KEY` is the only name. */
function readGenerationKey(): string {
  return read("HORIZON_LLM_API_KEY");
}

/**
 * Resolve the EMBEDDING credential.
 *
 * Order, and the reason for each step:
 *   1. HORIZON_EMBEDDING_API_KEY — the explicit, correct setting.
 *   2. GOOGLE_API_KEY / GEMINI_API_KEY — the names the Google SDK itself reads,
 *      so an operator who already exports them for other tools needs no change.
 *   3. HORIZON_LLM_API_KEY — LEGACY ONLY, and only when the generation provider
 *      IS Google. Under that configuration the generation key is known to be a
 *      Google credential, which is the situation this fallback preserves. Under
 *      any other provider it is NOT a Google key, and sending it to Google would
 *      fail as an authentication error while looking like a broken app.
 */
function readEmbeddingKey(provider: string): string {
  const explicit = read("HORIZON_EMBEDDING_API_KEY");
  if (explicit !== "") return explicit;

  const googleNamed = read("GOOGLE_API_KEY") || read("GEMINI_API_KEY");
  if (googleNamed !== "") return googleNamed;

  if (parseLlmProvider(provider) === "google-genai") return readGenerationKey();
  return "";
}

export function readServerEnv(): ServerEnv {
  const llmProvider = read("HORIZON_LLM_PROVIDER");

  return {
    supabaseUrl: read("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),

    llmProvider,
    llmBaseUrl: read("HORIZON_LLM_BASE_URL"),
    llmApiKey: readGenerationKey(),
    llmModel: read("HORIZON_LLM_MODEL"),
    llmReasoningEffort: read("HORIZON_LLM_REASONING_EFFORT"),

    embeddingApiKey: readEmbeddingKey(llmProvider),
    embeddingModel: read("HORIZON_EMBEDDING_MODEL"),
    embeddingDimensions: readInt("HORIZON_EMBEDDING_DIMENSIONS", 768),

    llmMaxOutputTokens: readInt("HORIZON_LLM_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    dailyTokenBudget: readInt("HORIZON_DAILY_TOKEN_BUDGET", 0),
    maxEmbeddingCalls: readInt("HORIZON_MAX_EMBEDDING_CALLS", 0),
    llmThinkingBudget: readOptionalInt("HORIZON_LLM_THINKING_BUDGET"),
    requestTimeoutMs: readInt("HORIZON_LLM_TIMEOUT_MS", 30000),
  };
}
