/**
 * Server-side environment access.
 *
 * This module reports only PRESENCE of configuration. It never returns or logs
 * secret values. Anything named here must stay server-side unless it carries
 * the NEXT_PUBLIC_ prefix.
 */
export interface ServerEnv {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceRoleKey: string;
  llmProvider: string;
  llmBaseUrl: string;
  llmApiKey: string;
  llmModel: string;
  llmMaxOutputTokens: number;
  dailyTokenBudget: number;
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

export function readServerEnv(): ServerEnv {
  return {
    supabaseUrl: read("NEXT_PUBLIC_SUPABASE_URL"),
    supabaseAnonKey: read("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    supabaseServiceRoleKey: read("SUPABASE_SERVICE_ROLE_KEY"),
    llmProvider: read("HORIZON_LLM_PROVIDER"),
    llmBaseUrl: read("HORIZON_LLM_BASE_URL"),
    llmApiKey: read("HORIZON_LLM_API_KEY"),
    llmModel: read("HORIZON_LLM_MODEL"),
    llmMaxOutputTokens: readInt("HORIZON_LLM_MAX_OUTPUT_TOKENS", 1024),
    dailyTokenBudget: readInt("HORIZON_DAILY_TOKEN_BUDGET", 0),
  };
}
