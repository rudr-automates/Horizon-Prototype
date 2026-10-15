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
import type { RuntimeConfig } from "@/lib/config";

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
    ...(config.baseUrlOverride ? { baseUrl: config.baseUrlOverride } : {}),
  };
}

export function createGeminiClient(config: RuntimeConfig): GoogleGenAI {
  if (config.apiKey.trim() === "") {
    throw new ProviderFailure(
      "not_configured",
      "No Gemini API credential is configured. Set HORIZON_LLM_API_KEY (or GOOGLE_API_KEY / GEMINI_API_KEY) server-side.",
    );
  }
  return new GoogleGenAI({
    apiKey: config.apiKey,
    httpOptions: buildHttpOptions(config),
  });
}

/** Map an SDK/network error onto the fail-closed ProviderFailure taxonomy. */
export function toProviderFailure(error: unknown): ProviderFailure {
  if (error instanceof ProviderFailure) return error;

  if (error instanceof ApiError) {
    const status = error.status;
    if (status === 429) {
      return new ProviderFailure("rate_limited", "The provider rate limit was reached.", status);
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

const GENERATOR_INSTRUCTION = [
  "You answer a learner's question about a recorded lesson.",
  "You must use ONLY the eligible evidence provided. Never use outside knowledge.",
  "Return structured claims. Do not write a narrative answer.",
  "Every claim must cite at least one evidence id from the provided list.",
  "Every claim must include a short verbatim quote copied exactly from the cited evidence text.",
  "If the provided evidence cannot support an answer, return an empty claims array and set unansweredParts to true.",
].join(" ");

/**
 * Strip a markdown code fence if the model wrapped its JSON in one.
 *
 * `responseMimeType: "application/json"` does not guarantee a bare object, so a
 * fenced payload is unwrapped before parsing. This weakens NOTHING: the parsed
 * value still has to satisfy the full Zod schema and every downstream check.
 * Without it, fencing would be reported as malformed output and a valid answer
 * would be lost.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Content-free description of what came back, so a malformed response can be
 * told apart from a truncated one without logging the model's text.
 */
export function describeResponseShape(
  text: string,
  finishReason?: string,
  usage?: GeminiUsageMetadata,
): string {
  const body = text.trim();
  return [
    `length=${text.length}`,
    `startsBrace=${body.startsWith("{")}`,
    `endsBrace=${body.endsWith("}")}`,
    `fenced=${text.includes("```")}`,
    `finishReason=${finishReason ?? "unknown"}`,
    usage
      ? `tokens=p${usage.promptTokenCount ?? "?"}/c${usage.candidatesTokenCount ?? "?"}/thoughts${usage.thoughtsTokenCount ?? "?"}`
      : "tokens=unreported",
  ].join(" ");
}

/**
 * Describe WHICH field failed validation, without echoing the model's content.
 * Field paths and issue codes only: enough to act on, nothing that could leak
 * generated text or user material into a log.
 */
function describeIssues(error: { issues: Array<{ path: PropertyKey[]; code: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}:${issue.code}`)
    .join(", ");
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

function formatEvidence(request: ClaimGenerationRequest): string {
  return request.evidence
    .map((item) => `[${item.id}]\n${item.text}`)
    .join("\n\n");
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
      `ELIGIBLE EVIDENCE (cite only these ids):\n${formatEvidence(request)}`,
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

const VERIFIER_INSTRUCTION = [
  "You check whether a claim is supported by the evidence cited for it.",
  "You see ONLY the claim and its cited evidence. You never see other lesson material.",
  "SUPPORTED means the cited evidence entails the claim.",
  "PARTIAL means the evidence supports only part of the claim.",
  "NOT_SUPPORTED means the evidence does not support the claim, even if it is topically related.",
  "Return one verdict per input index, exactly as given.",
].join(" ");

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
