import {
  CHAT_COMPLETIONS_PATH,
  type RuntimeConfig,
} from "@/lib/config";
import {
  GENERATOR_INSTRUCTION,
  VERIFIER_INSTRUCTION,
  formatEvidence,
} from "@/lib/answer/instructions";
import {
  describeIssues,
  describeJsonShape,
  stripCodeFence,
} from "@/lib/answer/json-envelope";
import {
  claimGenerationResultSchema,
  ProviderFailure,
  verifierResultSchema,
  type ClaimGenerationRequest,
  type ClaimGenerator,
  type GenerationOutcome,
  type SemanticVerifier,
  type TokenUsage,
  type VerificationOutcome,
  type VerificationTarget,
  type VerifierVerdict,
} from "@/lib/answer/provider";

/**
 * Groq adapter — OpenAI-compatible Chat Completions.
 *
 * Written against Groq's documented API surface:
 *   - POST {base}/chat/completions with `Authorization: Bearer <key>`.
 *   - Structured output via `response_format: { type: "json_schema",
 *     json_schema: { name, strict: true, schema } }`. Strict mode REQUIRES every
 *     property to be listed in `required` and every object to set
 *     `additionalProperties: false`, which is why the schemas below are written
 *     that way rather than derived mechanically from Zod.
 *   - `max_completion_tokens` rather than the deprecated `max_tokens`.
 *   - A 429 carries `retry-after` (seconds) and always carries the
 *     `x-ratelimit-*` headers.
 *
 * WHY THIS IS PLAIN `fetch` AND NOT AN SDK
 *   The endpoint is OpenAI-compatible, so the request is a JSON body; an extra
 *   dependency would add a retry layer and a response type we would then have to
 *   audit anyway. `fetch` is used directly so that "one call" is visible in the
 *   code and in the tests.
 *
 * WHAT A STRICT SCHEMA DOES AND DOES NOT PROVE
 *   Strict JSON Schema guarantees the SHAPE. It does not make the content true,
 *   and it is not evidence that a claim is supported by its cited evidence. The
 *   Tier-1 deterministic checks and the Tier-2 verifier run afterwards and are
 *   unchanged by this adapter.
 *
 * NOT SMOKE-TESTED: no live call has been made with this adapter. Every
 * behaviour below is covered by unit tests against a stubbed `fetch`.
 */

/**
 * Attempts per logical request. ONE, deliberately.
 *
 * A retry wrapper turns one logical call into several billable calls, silently,
 * and exactly when the account is closest to a limit. Counting tokens honestly
 * is impossible if one call can be five. The pipeline treats a failure as
 * fail-closed, so a 429 stops here and is reported rather than retried.
 */
export const GROQ_REQUEST_ATTEMPTS = 1;

/* ------------------------------------------------------------------ *
 * JSON Schema for strict structured output
 * ------------------------------------------------------------------ */

/**
 * Deliberately minimal: types, arrays, enums and `required` only.
 *
 * Groq documents the supported subset as primitives, objects, arrays, enums,
 * `anyOf` and `$defs`/`$ref`. Constraints such as `maxLength`/`maxItems` are not
 * documented as supported, and an unsupported keyword in strict mode is a hard
 * request failure — so the bounds the claims actually need are enforced by the
 * Zod schema AFTER parsing, where a violation is a clean refusal instead of a
 * broken request shape.
 */
export const CLAIM_JSON_SCHEMA = {
  type: "object",
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          evidenceIds: { type: "array", items: { type: "string" } },
          quote: { type: "string" },
        },
        required: ["text", "evidenceIds", "quote"],
        additionalProperties: false,
      },
    },
    unansweredParts: { type: "boolean" },
  },
  required: ["claims", "unansweredParts"],
  additionalProperties: false,
} as const;

export const VERIFIER_JSON_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          index: { type: "integer" },
          verdict: {
            type: "string",
            enum: ["SUPPORTED", "PARTIAL", "NOT_SUPPORTED"],
          },
          reason: { type: "string" },
        },
        required: ["index", "verdict", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["verdicts"],
  additionalProperties: false,
} as const;

/** Join a base URL and the chat-completions path without doubling slashes. */
export function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, "")}${CHAT_COMPLETIONS_PATH}`;
}

/* ------------------------------------------------------------------ *
 * Request construction
 * ------------------------------------------------------------------ */

export interface GroqRequestOptions {
  schemaName: string;
  schema: object;
  systemInstruction: string;
  userContent: string;
}

export interface GroqRequestParts {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Build the exact request. Pure and exported so a test can assert the endpoint,
 * the model id, the authorization header and the JSON Schema body without any
 * network or stubbing.
 */
export function buildGroqChatRequest(
  config: RuntimeConfig,
  options: GroqRequestOptions,
): GroqRequestParts {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: [
      { role: "system", content: options.systemInstruction },
      { role: "user", content: options.userContent },
    ],
    // Groq documents the range as 0–2 and states that a submitted zero is
    // converted to 1e-8, so this is greedy decoding rather than a rejection. The
    // conversion is Groq's, not ours, and is the reason the value stays 0 here
    // instead of being written as 1e-8: the intent is portability.
    temperature: 0,
    // `max_tokens` is deprecated on this API; the replacement is what bounds the
    // answer (on a reasoning model, reasoning is drawn from the same allowance).
    max_completion_tokens: config.maxOutputTokens,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: options.schemaName,
        strict: true,
        schema: options.schema,
      },
    },
    // A documented optional boolean, default true. Nothing here reads the
    // reasoning field, and on a reasoning model it is the largest part of the
    // response body, so asking for it to be omitted costs nothing and keeps the
    // payload we parse proportional to the answer.
    include_reasoning: false,
  };

  // Sent only when configured: an unknown value is worse than no hint, and the
  // model's own default is the right behaviour when nothing is chosen.
  if (config.reasoningEffort !== null) {
    body.reasoning_effort = config.reasoningEffort;
  }

  return {
    url: chatCompletionsUrl(config.generationBaseUrl),
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body,
  };
}

/* ------------------------------------------------------------------ *
 * Response shapes and usage
 * ------------------------------------------------------------------ */

export interface GroqUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface GroqChatResponse {
  choices?: Array<{
    message?: { role?: string; content?: string | null; refusal?: string | null };
    finish_reason?: string;
  }>;
  usage?: GroqUsage;
}

/**
 * Token accounting, exactly once.
 *
 * Groq's Chat Completions usage object reports `prompt_tokens`,
 * `completion_tokens` and `total_tokens`. It does NOT report a separate
 * reasoning-token count: reasoning is produced as part of the completion and is
 * already included in `completion_tokens`. So `thoughtsTokens` is null — never
 * derived from `completion_tokens`, which would double-count every reasoning
 * token and could double the recorded spend of a reasoning-heavy call.
 *
 * `null` also means "not reported", which is different from zero; the spend
 * guard is written to treat those differently.
 */
export function toTokenUsage(usage: GroqUsage | undefined): TokenUsage | null {
  if (!usage) return null;

  const read = (value: number | undefined): number | null =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

  const prompt = read(usage.prompt_tokens);
  const completion = read(usage.completion_tokens);
  if (prompt === null && completion === null) return null;

  return { promptTokens: prompt, completionTokens: completion, thoughtsTokens: null };
}

/** Content-free token summary for a diagnostic message. */
function describeTokens(usage: TokenUsage | null): string {
  if (!usage) return "unreported";
  return `p=${usage.promptTokens ?? "?"}/c=${usage.completionTokens ?? "?"}`;
}

/* ------------------------------------------------------------------ *
 * Failure mapping
 * ------------------------------------------------------------------ */

/** Rate-limit headers worth recording, and the words used for each. */
const RATE_LIMIT_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["retry-after", "retry after"],
  ["x-ratelimit-remaining-requests", "requests remaining today"],
  ["x-ratelimit-limit-requests", "requests per day"],
  ["x-ratelimit-reset-requests", "request limit resets in"],
  ["x-ratelimit-remaining-tokens", "tokens remaining this minute"],
  ["x-ratelimit-limit-tokens", "tokens per minute"],
  ["x-ratelimit-reset-tokens", "token limit resets in"],
];

/**
 * The provider's OWN retry guidance, recorded without any content.
 *
 * A 429 alone cannot distinguish "wait a moment" from "this account's daily
 * allowance is gone", and those need opposite responses. Only the documented
 * rate-limit headers are read, each value is stripped to digits/punctuation and
 * truncated, and an unreadable value contributes nothing — so this can only add
 * a real fact, never mask the reason or echo arbitrary bytes.
 */
export function describeRateLimit(headers: Headers | null): string {
  if (!headers) return "";
  const parts: string[] = [];
  for (const [header, label] of RATE_LIMIT_HEADERS) {
    const raw = headers.get(header);
    if (raw === null) continue;
    const safe = raw.replace(/[^0-9a-zA-Z.\-: ]/g, "").trim().slice(0, 40);
    if (safe === "") continue;
    parts.push(`${label} ${safe}`);
  }
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

/**
 * Map a transport failure or a non-2xx status onto the fail-closed taxonomy.
 *
 * A 429 is `rate_limited` and nothing else: the pipeline releases the budget
 * reservation for that kind, because the provider refused the request before
 * processing it. Charging it would let a burst of refusals drain the day's
 * budget and turn a provider problem into a self-inflicted BUDGET_EXHAUSTED.
 * A timeout is deliberately NOT `rate_limited`: an unanswered request may have
 * been billed, so its reservation has to stand.
 */
export function toProviderFailure(
  error: unknown,
  status?: number,
  headers?: Headers | null,
): ProviderFailure {
  if (error instanceof ProviderFailure) return error;

  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    return new ProviderFailure("timeout", "The provider request timed out.");
  }

  if (status === undefined) {
    return new ProviderFailure("unavailable", "The provider request failed.");
  }

  if (status === 429) {
    return new ProviderFailure(
      "rate_limited",
      `The provider rate limit was reached${describeRateLimit(headers ?? null)}.`,
      status,
    );
  }
  if (status === 408 || status === 504) {
    return new ProviderFailure("timeout", "The provider request timed out.", status);
  }
  if (status === 401 || status === 403) {
    return new ProviderFailure(
      "unavailable",
      `The provider rejected the credential (HTTP ${status}).`,
      status,
    );
  }
  if (status === 400 || status === 422) {
    // Most often an unsupported parameter or schema keyword, so the status is
    // named: it is the difference between a credential problem and a request
    // shape the provider will never accept.
    return new ProviderFailure(
      "unavailable",
      `The provider rejected the request as invalid (HTTP ${status}).`,
      status,
    );
  }
  return new ProviderFailure("unavailable", "The provider request failed.", status);
}

/* ------------------------------------------------------------------ *
 * The call
 * ------------------------------------------------------------------ */

interface ChatOutcome {
  content: string;
  finishReason: string | undefined;
  usage: TokenUsage | null;
}

/**
 * One request, one attempt.
 *
 * The response body is read even on failure, because a provider that returns a
 * partial response may still report usage, and a call that was billed must be
 * metered even when it ultimately failed.
 */
async function postChat(
  config: RuntimeConfig,
  request: GroqRequestParts,
): Promise<ChatOutcome> {
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    throw toProviderFailure(error);
  }

  let payload: GroqChatResponse | null = null;
  try {
    payload = (await response.json()) as GroqChatResponse;
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const failure = toProviderFailure(
      new Error(`HTTP ${response.status}`),
      response.status,
      response.headers,
    );
    const reported = toTokenUsage(payload?.usage);
    throw reported
      ? new ProviderFailure(failure.kind, failure.message, failure.status, reported)
      : failure;
  }

  const choice = payload?.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const refusal =
    typeof choice?.message?.refusal === "string" ? choice.message.refusal.trim() : "";

  if (content.trim() === "") {
    // A refusal is a real, reportable outcome and must not be confused with a
    // truncated one. No model text is included: which of the two happened is
    // carried by the message, never the content.
    const detail = refusal !== ""
      ? "The model declined to return structured content."
      : `The model returned no structured content (${describeJsonShape(content, choice?.finish_reason, describeTokens(toTokenUsage(payload?.usage)))}).`;
    throw new ProviderFailure(
      "malformed_response",
      detail,
      null,
      toTokenUsage(payload?.usage),
    );
  }

  return {
    content,
    finishReason: choice?.finish_reason,
    usage: toTokenUsage(payload?.usage),
  };
}

/** Parse and validate one JSON payload against a Zod schema, failing closed. */
function parseStructured<T>(
  content: string,
  finishReason: string | undefined,
  usage: TokenUsage | null,
  schema: { safeParse: (value: unknown) => { success: boolean; data?: T; error?: unknown } },
  describeFailure: (issues: string) => string,
): T {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(stripCodeFence(content));
  } catch {
    throw new ProviderFailure(
      "malformed_response",
      `The model returned invalid JSON (${describeJsonShape(content, finishReason, describeTokens(usage))}).`,
      null,
      // The call was made and billed, so its usage must still be accounted.
      usage,
    );
  }

  const parsed = schema.safeParse(parsedJson);
  if (!parsed.success || parsed.data === undefined) {
    const issues = parsed.error
      ? describeIssues(parsed.error as { issues: Array<{ path: PropertyKey[]; code: string }> })
      : "unknown";
    throw new ProviderFailure("malformed_response", describeFailure(issues), null, usage);
  }
  return parsed.data;
}

/* ------------------------------------------------------------------ *
 * Claim generation
 * ------------------------------------------------------------------ */

export class GroqClaimGenerator implements ClaimGenerator {
  readonly providerId = "groq";

  constructor(private readonly config: RuntimeConfig) {}

  async generate(request: ClaimGenerationRequest): Promise<GenerationOutcome> {
    const userContent = [
      `QUESTION:\n${request.question}`,
      `ELIGIBLE EVIDENCE (cite only these ids):\n${formatEvidence(request.evidence)}`,
    ].join("\n\n");

    const parts = buildGroqChatRequest(this.config, {
      schemaName: "horizon_claims",
      schema: CLAIM_JSON_SCHEMA,
      systemInstruction: GENERATOR_INSTRUCTION,
      userContent,
    });

    const chat = await postChat(this.config, parts);

    const result = parseStructured(
      chat.content,
      chat.finishReason,
      chat.usage,
      claimGenerationResultSchema,
      (issues) => `The model response did not match the claim schema (${issues}).`,
    );

    return { result, usage: chat.usage };
  }
}

/* ------------------------------------------------------------------ *
 * Semantic support verification (model-assisted, not independent)
 * ------------------------------------------------------------------ */

export class GroqSemanticVerifier implements SemanticVerifier {
  readonly providerId = "groq";

  constructor(private readonly config: RuntimeConfig) {}

  async verify(targets: VerificationTarget[]): Promise<VerificationOutcome> {
    if (targets.length === 0) return { verdicts: [], usage: null };

    const userContent = targets
      .map((target) => {
        const evidence = target.evidence
          .map((item) => `  [${item.id}] ${item.text}`)
          .join("\n");
        return `INDEX ${target.index}\nCLAIM: ${target.claimText}\nCITED EVIDENCE:\n${evidence}`;
      })
      .join("\n\n");

    const parts = buildGroqChatRequest(this.config, {
      schemaName: "horizon_verdicts",
      schema: VERIFIER_JSON_SCHEMA,
      systemInstruction: VERIFIER_INSTRUCTION,
      userContent,
    });

    const chat = await postChat(this.config, parts);

    const parsed = parseStructured(
      chat.content,
      chat.finishReason,
      chat.usage,
      verifierResultSchema,
      (issues) => `The verifier response did not match the verdict schema (${issues}).`,
    );

    const known = new Set(targets.map((target) => target.index));
    // Fail closed: any requested index with no returned verdict is NOT_SUPPORTED.
    const verdicts: VerifierVerdict[] = targets.map((target) => {
      const found = parsed.verdicts.find((verdict) => verdict.index === target.index);
      if (!found || !known.has(found.index)) {
        return {
          index: target.index,
          verdict: "NOT_SUPPORTED" as const,
          reason: "No verdict was returned for this claim.",
        };
      }
      return found;
    });

    return { verdicts, usage: chat.usage };
  }
}
