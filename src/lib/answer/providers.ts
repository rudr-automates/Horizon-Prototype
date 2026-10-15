import {
  GeminiClaimGenerator,
  GeminiEmbedder,
  GeminiSemanticVerifier,
  createGeminiClient,
  type GeminiClientLike,
} from "@/lib/answer/gemini";
import { GroqClaimGenerator, GroqSemanticVerifier } from "@/lib/answer/groq";
import type {
  ClaimGenerator,
  Embedder,
  SemanticVerifier,
} from "@/lib/answer/provider";
import { CappedEmbedder } from "@/lib/answer/capped-embedder";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import {
  GOOGLE_PROVIDER_ID,
  GROQ_PROVIDER_ID,
  isEmbeddingConfigured,
  isRuntimeAiConfigured,
  type RuntimeConfig,
} from "@/lib/config";

export interface RuntimeProviders {
  /** True only when the required GENERATION names are present. Not a connectivity claim. */
  configured: boolean;
  /** null when unconfigured, so no inference can be attempted at all. */
  generator: ClaimGenerator | null;
  verifier: SemanticVerifier | null;
  /**
   * Whether `embedder` is a real embedding model rather than the offline
   * lexical stand-in. Reported separately from `configured` because the two
   * credentials are independent: a deployment can have generation and no
   * embeddings, and that difference decides whether stored vectors are usable.
   */
  embeddingConfigured: boolean;
  embedder: Embedder;
  /** Reported in every response so the UI can label what produced the vectors. */
  embeddingProviderId: string;
  modelId: string | null;
  /** Plain-language reason for the embedder in use. Never a credential value. */
  embedderDetail: string;
}

/**
 * Test seam. Both clients are the same Google SDK shape; they are separated here
 * because they now carry different credentials.
 */
export interface InjectedClients {
  generation?: GeminiClientLike;
  embedding?: GeminiClientLike;
}

/**
 * Build the runtime provider bundle.
 *
 * GENERATION and EMBEDDING are decided independently, because they are different
 * vendors with different credentials:
 *   - generation comes from the configured provider (Groq or Google);
 *   - embeddings always come from the Google embedding model, because the
 *     persisted corpus was embedded with it and cosine/L2 comparison across two
 *     models is meaningless.
 *
 * Nothing fabricates output. When the generation credential is absent this
 * returns `generator: null` and `verifier: null`. When the EMBEDDING credential
 * is absent it returns the clearly labelled offline lexical embedder, and reports
 * `embeddingConfigured: false` so a database-backed corpus is refused rather than
 * silently compared against a stand-in vector — see the guard in the pipeline.
 */
export function createRuntimeProviders(
  config: RuntimeConfig,
  injected: InjectedClients = {},
): RuntimeProviders {
  const embeddingConfigured = isEmbeddingConfigured(config);

  // The embedding client is built from the EMBEDDING credential only. Using the
  // generation key here is what would send a Groq key to Google's endpoint.
  const embeddingClient =
    injected.embedding ??
    (embeddingConfigured ? createGeminiClient(config, "embedding") : null);

  const embedder: Embedder =
    embeddingClient === null
      ? new SyntheticLexicalEmbedder(config.embeddingDimensions)
      : // Wrapped so embedding REQUESTS are bounded even though the token budget
        // cannot meter them.
        new CappedEmbedder(new GeminiEmbedder(embeddingClient, config), config.maxEmbeddingCalls);

  const embedderDetail = embeddingClient === null
    ? "No embedding credential is configured, so the offline lexical embedder is in use. It is not a semantic model."
    : `Real embeddings from ${config.embeddingModel} at ${config.embeddingDimensions} dimensions.`;

  const base = {
    embeddingConfigured,
    embedder,
    embeddingProviderId: embeddingClient === null
      ? "synthetic-lexical-v1"
      : config.embeddingModel,
    embedderDetail,
  };

  if (!isRuntimeAiConfigured(config)) {
    return {
      ...base,
      configured: false,
      generator: null,
      verifier: null,
      modelId: null,
    };
  }

  const generationClient =
    injected.generation ??
    (config.provider === GOOGLE_PROVIDER_ID ? createGeminiClient(config, "generation") : null);

  if (config.provider === GROQ_PROVIDER_ID) {
    return {
      ...base,
      configured: true,
      generator: new GroqClaimGenerator(config),
      verifier: new GroqSemanticVerifier(config),
      modelId: config.model,
    };
  }

  if (generationClient === null) {
    return {
      ...base,
      configured: false,
      generator: null,
      verifier: null,
      modelId: null,
    };
  }

  return {
    ...base,
    configured: true,
    generator: new GeminiClaimGenerator(generationClient, config),
    verifier: new GeminiSemanticVerifier(generationClient, config),
    modelId: config.model,
  };
}
