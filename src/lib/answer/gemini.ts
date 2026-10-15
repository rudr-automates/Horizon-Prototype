import {
  ApiError,
  GoogleGenAI,
  Type,
  type EmbedContentParameters,
  type GenerateContentParameters,
  type Schema,
} from "@google/genai";
import {
  claimGenerationResultSchema,
  ProviderFailure,
  verifierResultSchema,
  type ClaimGenerationRequest,
  type ClaimGenerator,
  type EmbedPurpose,
  type Embedder,
  type GenerationOutcome,
  type SemanticVerifier,
  type TokenUsage,
  type VerificationOutcome,
  type VerificationTarget,
  type VerifierVerdict,
} from "@/lib/answer/provider";
import {
  formatEvidence,
  GENERATOR_INSTRUCTION,
  VERIFIER_INSTRUCTION,
} from "@/lib/answer/instructions";
import {
  describeIssues,
  describeJsonShape,
  stripCodeFence,
} from "@/lib/answer/json-envelope";
import { GOOGLE_PROVIDER_ID, type RuntimeConfig } from "@/lib/config";

/** Re-exported so an existing importer of this module keeps working. */
export { stripCodeFence };

/**
 * Google Gen AI (Gemini API) adapter.
 *
 * Verified against the installed SDK's own type definitions (@google/genai
 * 2.29.1): `models.generateContent({ model, contents, config })` with
 * `config.responseMimeType` + `config.responseSchema` (a `Type`-based Schema),
 * and `models.embedContent({ model, contents, config.outputDimensionality })`
 * returning `embeddings[].values`.
 *
 * NO live smoke test has been run: no credential is configured. These classes
 * are covered by unit tests against an injected fake client.
 */

/**
 * Token accounting as the provider reports it. Optional on purpose: the field is
 * absent on some responses, and an absent count must record as unknown rather
 * than as zero, so the spend guard never overstates its own knowledge.
 */
export interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  totalTokenCount?: number;
  /**
   * Reasoning tokens, which are billed and which count against maxOutputTokens.
   * Recorded because they are the most likely cause of a JSON response being
   * cut off with a large maxOutputTokens value.
   */
  thoughtsTokenCount?: number;
}

export interface GeminiGenerationResult {
  text?: string;
  usageMetadata?: GeminiUsageMetadata;
  /** "STOP", "MAX_TOKENS", … — the decisive signal for a truncated response. */
  finishReason?: string;
}

/** Structural subset of the SDK client, so tests can inject a fake. */
export interface GeminiClientLike {
  models: {
    generateContent(params: GenerateContentParameters): Promise<GeminiGenerationResult>;
    embedContent(
      params: EmbedContentParameters,
    ): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
  };
}

/**
 * HTTP options for the SDK.
 *
 * `attempts: 1` is DELIBERATE and load-bearing. The SDK documents `attempts` as
 * defaulting to 5 and retries 408/429/5xx, so one logical request could become
 * five billable requests — silently, and precisely when the account is closest
 * to a limit. Disabling retries keeps "one call" meaning one call, which is a
 * precondition for any honest usage accounting.
 */
export function buildHttpOptions(config: RuntimeConfig): {
  timeout: number;
  retryOptions: { attempts: number };
  baseUrl?: string;
} {
  return {
    timeout: config.requestTimeoutMs,
    retryOptions: { attempts: 1 },
    // The override names the GENERATION endpoint, so it is passed to this SDK
    // only when Google IS the generation provider. Under an OpenAI-compatible
    // provider the same variable holds that vendor's host, and forwarding it
    // here would point the EMBEDDING client at a non-Google endpoint — which
    // fails as an authentication error and reads like an outage.
    ...(config.provider === GOOGLE_PROVIDER_ID && config.baseUrlOverride
      ? { baseUrl: config.baseUrlOverride }
      : {}),
  };
}

/**
 * Build the Google Gen AI client.
 *
 * `role` selects the credential, and it is required in spirit even though it has
 * a default: generation and embedding are separate credentials now, and a client
 * built from the wrong one fails as an authentication error at call time rather
 * than here.
 */
export function createGeminiClient(
  config: RuntimeConfig,
  role: "generation" | "embedding" = "generation",
): GoogleGenAI {
  const apiKey = role === "generation" ? config.apiKey : config.embeddingApiKey;

  if (apiKey.trim() === "") {
    throw new ProviderFailure(
      "not_configured",
      role === "generation"
        ? "No generation credential is configured. Set HORIZON_LLM_API_KEY server-side."
        : "No embedding credential is configured. Set HORIZON_EMBEDDING_API_KEY server-side (the Google key for the embedding model).",
    );
  }

  return new GoogleGenAI({
    apiKey,
    httpOptions: buildHttpOptions(config),
  });
}

/**
 * Extract the API's own explanation of a rate limit, without any content.
 *
 * Reads only `retryDelay` and the quota identifier from the error metadata. An
 * unrecognised shape yields an empty string, so this can never mask the reason
 * or invent a detail: it either adds a real fact or adds nothing.
 */
export function describeRateLimit(error: unknown): string {
  if (!(error instanceof Error) || typeof error.message !== "string") return "";
  const message = error.message;

  const delay = /"retryDelay"\s*:\s*"([^"]+)"/.exec(message)?.[1];
  const quota = /"quota(?:Id|Metric)"\s*:\s*"([^"]+)"/.exec(message)?.[1];

  const parts: string[] = [];
  if (delay) parts.push(`retry after ${delay}`);
  if (quota) parts.push(`quota ${quota}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

/** Map an SDK/network error onto the fail-closed ProviderFailure taxonomy. */
export function toProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;

  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 429) {
      // The coarse reason alone cannot distinguish "slow down for a moment" from
      // "this project's daily quota for the model is exhausted", and those need
      // opposite responses: wait, or switch account/tier. The API's own
      // retryDelay and quota identifier are extracted here and logged
      // server-side. Both are metadata about the limit — never user or model
      // content — so they are safe to record and are the only way to act on it.
      return new ProviderFailure(
        "rate_limited",
        `The provider rate limit was reached${describeRateLimit(error)}.`,
        status,
      );
    }
    if (status === 504) {
      return new ProviderFailure("timeout", "The provider request timed out.", status);
    }
    if (status === 400 || status === 401 || status === 403) {
      return new ProviderFailure(
        "unavailable",
        "The provider rejected the request (credentials or permissions).",
        status,
      );
    }
    return new ProviderFailure("unavailable", "The provider request failed.", status);
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new ProviderFailure("timeout", "The provider request timed out.");
  }

  return new ProviderFailure("unavailable", "The provider request failed.");
}

/* ------------------------------------------------------------------ *
 * Claim generation
 * ------------------------------------------------------------------ */

const claimSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING },
    evidenceIds: { type: Type.ARRAY, items: { type: Type.STRING } },
    quote: { type: Type.STRING },
  },
  required: ["text", "evidenceIds", "quote"],
};

const claimResponseSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    claims: { type: Type.ARRAY, items: claimSchema },
    unansweredParts: { type: Type.BOOLEAN },
  },
  required: ["claims", "unansweredParts"],
};

/**
 * Content-free description of what came back, so a malformed response can be
 * told apart from a truncated one without logging the model's text.
 */
export function describeResponseShape(
  text: string,
  finishReason?: string,
  usage?: GeminiUsageMetadata,
): string {
  const tokens = usage
    ? `p${usage.promptTokenCount ?? "?"}/c${usage.candidatesTokenCount ?? "?"}/thoughts${usage.thoughtsTokenCount ?? "?"}`
    : "unreported";
  return describeJsonShape(text, finishReason, tokens);
}

/** Normalise the provider's usage report, preserving "unknown" as null. */
export function toTokenUsage(metadata: GeminiUsageMetadata | undefined): TokenUsage | null {
  if (!metadata) return null;

  const read = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

  const prompt = read(metadata.promptTokenCount);
  const completion = read(metadata.candidatesTokenCount);
  // Reasoning tokens are billed and are reported separately; dropping them
  // under-counts usage badly on a thinking model.
  const thoughts = read(metadata.thoughtsTokenCount);

  if (prompt === null && completion === null && thoughts === null) return null;
  return { promptTokens: prompt, completionTokens: completion, thoughtsTokens: thoughts };
}

export class GeminiClaimGenerator implements ClaimGenerator {
  readonly providerId = "google-genai";

  constructor(
    private readonly client: GeminiClientLike,
    private readonly config: RuntimeConfig,
  ) {}

  async generate(request: ClaimGenerationRequest): Promise<GenerationOutcome> {
    const contents = [
      `QUESTION:\n${request.question}`,
      `ELIGIBLE EVIDENCE (cite only these ids):\n${formatEvidence(request.evidence)}`,
    ].join("\n\n");

    let text: string | undefined;
    let usage: TokenUsage | null = null;
    let finishReason: string | undefined;
    let rawUsage: GeminiUsageMetadata | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents,
        config: {
          systemInstruction: GENERATOR_INSTRUCTION,
          temperature: 0,
          maxOutputTokens: this.config.maxOutputTokens,
          // Bounded when configured, so reasoning cannot consume the whole
          // output allowance and truncate the JSON.
          ...(this.config.thinkingBudget === null
            ? {}
            : { thinkingConfig: { thinkingBudget: this.config.thinkingBudget } }),
          responseMimeType: "application/json",
          responseSchema: claimResponseSchema,
        },
      });
      text = response.text;
      finishReason = response.finishReason;
      rawUsage = response.usageMetadata;
      usage = toTokenUsage(response.usageMetadata);
    } catch (error) {
      throw toProviderFailure(error);
    }

    if (typeof text !== "string" || text.trim() === "") {
      throw new ProviderFailure("malformed_response", "The model returned no structured content.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(text));
    } catch {
      throw new ProviderFailure(
        "malformed_response",
        `The model returned invalid JSON (${describeResponseShape(text, finishReason, rawUsage)}).`,
        null,
        // The call was made and billed, so its usage must still be accounted.
        toTokenUsage(rawUsage),
      );
    }

    const parsed = claimGenerationResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ProviderFailure(
        "malformed_response",
        `The model response did not match the claim schema (${describeIssues(parsed.error)}).`,
        null,
        toTokenUsage(rawUsage),
      );
    }
    return { result: parsed.data, usage };
  }
}

/* ------------------------------------------------------------------ *
 * Semantic support verification (model-assisted, not independent)
 * ------------------------------------------------------------------ */

const verifierSchema: Schema = {
  type: Type.OBJECT,
  properties: {
    verdicts: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          index: { type: Type.INTEGER },
          verdict: {
            type: Type.STRING,
            enum: ["SUPPORTED", "PARTIAL", "NOT_SUPPORTED"],
          },
          reason: { type: Type.STRING },
        },
        required: ["index", "verdict", "reason"],
      },
    },
  },
  required: ["verdicts"],
};

export class GeminiSemanticVerifier implements SemanticVerifier {
  readonly providerId = "google-genai";

  constructor(
    private readonly client: GeminiClientLike,
    private readonly config: RuntimeConfig,
  ) {}

  async verify(targets: VerificationTarget[]): Promise<VerificationOutcome> {
    if (targets.length === 0) return { verdicts: [], usage: null };

    const contents = targets
      .map((target) => {
        const evidence = target.evidence
          .map((item) => `  [${item.id}] ${item.text}`)
          .join("\n");
        return `INDEX ${target.index}\nCLAIM: ${target.claimText}\nCITED EVIDENCE:\n${evidence}`;
      })
      .join("\n\n");

    let text: string | undefined;
    let usage: TokenUsage | null = null;
    let finishReason: string | undefined;
    let rawUsage: GeminiUsageMetadata | undefined;
    try {
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents,
        config: {
          systemInstruction: VERIFIER_INSTRUCTION,
          temperature: 0,
          maxOutputTokens: this.config.maxOutputTokens,
          ...(this.config.thinkingBudget === null
            ? {}
            : { thinkingConfig: { thinkingBudget: this.config.thinkingBudget } }),
          responseMimeType: "application/json",
          responseSchema: verifierSchema,
        },
      });
      text = response.text;
      finishReason = response.finishReason;
      rawUsage = response.usageMetadata;
      usage = toTokenUsage(response.usageMetadata);
    } catch (error) {
      throw toProviderFailure(error);
    }

    if (typeof text !== "string" || text.trim() === "") {
      throw new ProviderFailure("malformed_response", "The verifier returned no structured content.");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripCodeFence(text));
    } catch {
      throw new ProviderFailure(
        "malformed_response",
        `The verifier returned invalid JSON (${describeResponseShape(text, finishReason, rawUsage)}).`,
        null,
        toTokenUsage(rawUsage),
      );
    }

    const parsed = verifierResultSchema.safeParse(parsedJson);
    if (!parsed.success) {
      throw new ProviderFailure(
        "malformed_response",
        `The verifier response did not match the verdict schema (${describeIssues(parsed.error)}).`,
        null,
        toTokenUsage(rawUsage),
      );
    }

    const known = new Set(targets.map((target) => target.index));
    // Fail closed: any requested index with no returned verdict is NOT_SUPPORTED.
    const verdicts: VerifierVerdict[] = targets.map((target) => {
      const found = parsed.data.verdicts.find((verdict) => verdict.index === target.index);
      if (!found || !known.has(found.index)) {
        return {
          index: target.index,
          verdict: "NOT_SUPPORTED" as const,
          reason: "No verdict was returned for this claim.",
        };
      }
      return found;
    });

    return { verdicts, usage };
  }
}

/* ------------------------------------------------------------------ *
 * Embeddings
 * ------------------------------------------------------------------ */

export class GeminiEmbedder implements Embedder {
  readonly providerId = "google-genai";
  readonly dimensions: number;

  constructor(
    private readonly client: GeminiClientLike,
    private readonly config: RuntimeConfig,
  ) {
    this.dimensions = config.embeddingDimensions;
  }

  async embed(texts: string[], purpose: EmbedPurpose = "document"): Promise<number[][]> {
    if (texts.length === 0) return [];

    let embeddings: Array<{ values?: number[] }> | undefined;
    try {
      const response = await this.client.models.embedContent({
        model: this.config.embeddingModel,
        contents: texts,
        config: {
          outputDimensionality: this.config.embeddingDimensions,
          taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
        },
      });
      embeddings = response.embeddings;
    } catch (error) {
      throw toProviderFailure(error);
    }

    if (!embeddings || embeddings.length !== texts.length) {
      throw new ProviderFailure(
        "malformed_response",
        "The embedding response did not match the number of inputs.",
      );
    }

    return embeddings.map((embedding) => {
      const values = embedding.values ?? [];
      if (values.length !== this.config.embeddingDimensions) {
        throw new ProviderFailure(
          "malformed_response",
          `Embedding dimension ${values.length} did not match the configured ${this.config.embeddingDimensions}.`,
        );
      }
      return values;
    });
  }
}
