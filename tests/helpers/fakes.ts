import type { GeminiClientLike } from "@/lib/answer/gemini";
import type { RuntimeProviders } from "@/lib/answer/providers";
import type {
  ClaimGenerator,
  Embedder,
  SemanticVerifier,
} from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import type { ServerEnv } from "@/lib/env";

export function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    supabaseUrl: "",
    supabaseAnonKey: "",
    supabaseServiceRoleKey: "",
    llmProvider: "",
    llmBaseUrl: "",
    llmApiKey: "",
    llmModel: "",
    embeddingModel: "",
    embeddingDimensions: 768,
    llmMaxOutputTokens: 1024,
    dailyTokenBudget: 0,
    requestTimeoutMs: 30_000,
    ...overrides,
  };
}

/**
 * A positive spend budget. Pipeline deps must state this explicitly, because
 * `HORIZON_DAILY_TOKEN_BUDGET = 0` is a real hard stop that permits no provider
 * call at all — tests that expect inference must opt in to a permitted budget.
 */
export const PERMITTED_BUDGET = 1_000_000;

export interface RecordedGenerateCall {
  model: string;
  contents: string;
  config: Record<string, unknown>;
}

export interface RecordedEmbedCall {
  model: string;
  contents: string[];
  config: Record<string, unknown>;
}

/**
 * A fake Google Gen AI client. Every response is scripted by the test; this
 * exists so the real adapter code can be exercised without a credential.
 */
export class FakeGeminiClient implements GeminiClientLike {
  generateResponses: Array<{ text?: string } | Error> = [];
  embedResponses: Array<{ embeddings?: Array<{ values?: number[] }> } | Error> = [];
  generateCalls: RecordedGenerateCall[] = [];
  embedCalls: RecordedEmbedCall[] = [];

  models = {
    generateContent: async (params: unknown): Promise<{ text?: string }> => {
      const call = params as RecordedGenerateCall;
      this.generateCalls.push(call);
      const next = this.generateResponses.shift();
      if (next instanceof Error) throw next;
      return next ?? { text: undefined };
    },
    embedContent: async (
      params: unknown,
    ): Promise<{ embeddings?: Array<{ values?: number[] }> }> => {
      const call = params as RecordedEmbedCall;
      this.embedCalls.push(call);
      const next = this.embedResponses.shift();
      if (next instanceof Error) throw next;
      return next ?? { embeddings: [] };
    },
  };
}

/** Deterministic unit vectors, so dimension behaviour is easy to assert. */
export function fakeVector(dimensions: number, seed = 1): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[seed % dimensions] = 1;
  return vector;
}

export interface FakeProvidersOptions {
  generator?: ClaimGenerator | null;
  verifier?: SemanticVerifier | null;
  embedder?: Embedder;
}

/**
 * Build a RuntimeProviders bundle for pipeline tests. Defaults to a recording
 * generator that returns no claims, and a verifier that supports everything it
 * is given — tests override the parts they care about.
 */
export function makeProviders(options: FakeProvidersOptions = {}): RuntimeProviders {
  const embedder = options.embedder ?? new SyntheticLexicalEmbedder(768);
  const generator =
    options.generator === undefined
      ? {
          providerId: "fake-generator",
          generate: async () => ({ claims: [], unansweredParts: true }),
        }
      : options.generator;
  return {
    configured: generator !== null,
    generator,
    verifier: options.verifier ?? null,
    embedder,
    embeddingProviderId: embedder.providerId,
    modelId: generator ? "fake-model" : null,
  };
}
