/**
 * Server-side environment access.
 *
 * This module reports only PRESENCE of configuration where it is asked to.
 * It never logs or returns secret values. Anything named here must stay
 * server-side unless it carries the NEXT_PUBLIC_ prefix.
 */
import { DEFAULT_MAX_OUTPUT_TOKENS } from "@/lib/config";
export interface ServerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;

  /** Runtime text model provider kind, e.g. "google-genai". */
  llmProvider: string;
  /** Optional endpoint override. The Google Gen AI SDK resolves its own
   *  endpoint by default, so this is only used when explicitly set. */
  llmBaseUrl: string;
  /** Provider credential. Never exposed to the browser. */
  llmApiKey: string;
  llmModel: string;

  /** Embedding configuration. */
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
  /** Reasoning-token budget. null = not configured, so nothing is sent. */
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

/**
 * Resolve the provider credential.
 *
 * HORIZON_LLM_API_KEY is preferred. GOOGLE_API_KEY / GEMINI_API_KEY are
 * accepted as fallbacks because the Google Gen AI SDK reads those names.
 * This preference order is a deliberate decision, documented in DECISIONS.md.
 */
function readProviderKey(): string {
  return (
    read("HORIZON_LLM_API_KEY") || read("GOOGLE_API_KEY") || read("GEMINI_API_KEY")
  );
}

export function readServerEnv(): ServerEnv {
  return {
    supabaseUrl: read("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),

    llmProvider: read("HORIZON_LLM_PROVIDER"),
    llmBaseUrl: read("HORIZON_LLM_BASE_URL"),
    llmApiKey: readProviderKey(),
    llmModel: read("HORIZON_LLM_MODEL"),

    embeddingModel: read("HORIZON_EMBEDDING_MODEL"),
    embeddingDimensions: readInt("HORIZON_EMBEDDING_DIMENSIONS", 768),

    llmMaxOutputTokens: readInt("HORIZON_LLM_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS),
    dailyTokenBudget: readInt("HORIZON_DAILY_TOKEN_BUDGET", 0),
    maxEmbeddingCalls: readInt("HORIZON_MAX_EMBEDDING_CALLS", 0),
    llmThinkingBudget: readOptionalInt("HORIZON_LLM_THINKING_BUDGET"),
    requestTimeoutMs: readInt("HORIZON_LLM_TIMEOUT_MS", 30000),
  };
}
