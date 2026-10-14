import {
  GeminiClaimGenerator,
  GeminiEmbedder,
  GeminiSemanticVerifier,
  createGeminiClient,
  type GeminiClientLike,
} from "@/lib/answer/gemini";
import type {
  ClaimGenerator,
  Embedder,
  SemanticVerifier,
} from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { isRuntimeAiConfigured, type RuntimeConfig } from "@/lib/config";

export interface RuntimeProviders {
  /** True only when the required names are present. Not a connectivity claim. */
  configured: boolean;
  /** null when unconfigured, so no inference can be attempted at all. */
  generator: ClaimGenerator | null;
  verifier: SemanticVerifier | null;
  embedder: Embedder;
  /** Reported in every response so the UI can label what produced the vectors. */
  embeddingProviderId: string;
  modelId: string | null;
}

/**
 * Build the runtime provider bundle.
 *
 * When no credential is configured this deliberately returns `generator: null`
 * and `verifier: null`. There is no fallback that fabricates claims. The
 * embedder falls back to a clearly labelled offline lexical embedder so the
 * retrieval pipeline stays demonstrable and testable without a credential.
 */
export function createRuntimeProviders(
  config: RuntimeConfig,
  injectedClient?: GeminiClientLike,
): RuntimeProviders {
  if (isRuntimeAiConfigured(config)) {
    const client = injectedClient ?? createGeminiClient(config);
    return {
      configured: true,
      generator: new GeminiClaimGenerator(client, config),
      verifier: new GeminiSemanticVerifier(client, config),
      embedder: new GeminiEmbedder(client, config),
      embeddingProviderId: config.embeddingModel,
      modelId: config.model,
    };
  }

  return {
    configured: false,
    generator: null,
    verifier: null,
    embedder: new SyntheticLexicalEmbedder(config.embeddingDimensions),
    embeddingProviderId: "synthetic-lexical-v1",
    modelId: null,
  };
}
