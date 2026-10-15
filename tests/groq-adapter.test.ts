import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_JSON_SCHEMA,
  GROQ_REQUEST_ATTEMPTS,
  GroqClaimGenerator,
  GroqSemanticVerifier,
  VERIFIER_JSON_SCHEMA,
  buildGroqChatRequest,
  chatCompletionsUrl,
  describeRateLimit,
  toProviderFailure,
  toTokenUsage,
} from "@/lib/answer/groq";
import { meteredTokens, ProviderFailure } from "@/lib/answer/provider";
import { readRuntimeConfig } from "@/lib/config";
import { makeEnv } from "./helpers/fakes";

/**
 * MOCKED PROVIDER TESTS — NOT EVIDENCE OF A LIVE CALL.
 *
 * `fetch` is stubbed, so nothing here touches the network. What these cases DO
 * establish is that the adapter sends the request this API documents (endpoint,
 * model id, bearer header, strict JSON Schema body), that it reads the response
 * fields it claims to read, and that every failure path fails closed. What they
 * CANNOT establish is that a real account accepts the request — that requires a
 * live smoke test, which is reported separately and was not run here.
 */

const config = readRuntimeConfig(
  makeEnv({
    llmProvider: "groq",
    llmApiKey: "groq-test-key",
    llmModel: "openai/gpt-oss-20b",
    llmBaseUrl: "https://api.groq.com/openai/v1",
    embeddingApiKey: "embedding-key-not-used-here",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 768,
    llmMaxOutputTokens: 4096,
  }),
);

interface RecordedCall {
  url: string;
  init: RequestInit;
}

let calls: RecordedCall[];
let script: Array<() => Response>;

beforeEach(() => {
  calls = [];
  script = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = script.shift();
    if (!next) throw new Error("no scripted response left");
    return next();
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const validClaims = {
  claims: [
    {
      text: "The instructor chooses a sub-unit coefficient.",
      evidenceIds: ["b_0013"],
      quote: "Marlin backoff constant",
    },
  ],
  unansweredParts: false,
};

const validVerdicts = {
  verdicts: [{ index: 0, verdict: "SUPPORTED", reason: "entailed by the cited block" }],
};

function parsedBody(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(String(call.init.body)) as Record<string, unknown>;
}

/**
 * Await a call that must fail, and return the failure.
 *
 * Also asserts that it DID fail: a case that silently resolved would otherwise
 * be recorded as a pass with undefined fields read off a success value.
 */
async function expectFailure(promise: Promise<unknown>): Promise<ProviderFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ProviderFailure) return error;
    throw error;
  }
  throw new Error("the adapter resolved, but this case requires a failure");
}

/** Recursively assert the two rules Groq strict mode imposes on every object. */
function assertStrictShape(node: unknown, path: string): void {
  if (node === null || typeof node !== "object") return;
  const object = node as Record<string, unknown>;

  if (object.type === "object") {
    const properties = object.properties as Record<string, unknown>;
    expect(object.additionalProperties, `${path}.additionalProperties`).toBe(false);
    expect(new Set(object.required as string[]), `${path}.required`).toEqual(
      new Set(Object.keys(properties)),
    );
    for (const [key, child] of Object.entries(properties)) {
      assertStrictShape(child, `${path}.${key}`);
    }
  }

  if (object.type === "array") {
    assertStrictShape(object.items, `${path}[]`);
  }
}

describe("the request Groq actually receives", () => {
  it("posts to the chat-completions path with the model id and bearer credential", async () => {
    script.push(() => jsonResponse({ choices: [{ message: { content: JSON.stringify(validClaims) } }] }));

    await new GroqClaimGenerator(config).generate({
      question: "What constant is chosen?",
      evidence: [{ id: "b_0013", text: "Marlin backoff constant, 0.37" }],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(calls[0].init.method).toBe("POST");

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer groq-test-key");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = parsedBody(calls[0]);
    expect(body.model).toBe("openai/gpt-oss-20b");
    expect(body.temperature).toBe(0);
    expect(body.max_completion_tokens).toBe(4096);
    // `max_tokens` is deprecated on this API. Sending both would be ambiguous.
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.include_reasoning).toBe(false);

    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("ONLY the eligible evidence");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("b_0013");
    expect(messages[1].content).toContain("What constant is chosen?");
  });

  it("requests a strict JSON Schema by name", () => {
    const parts = buildGroqChatRequest(config, {
      schemaName: "horizon_claims",
      schema: CLAIM_JSON_SCHEMA,
      systemInstruction: "system",
      userContent: "user",
    });

    expect(parts.body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "horizon_claims",
        strict: true,
        schema: CLAIM_JSON_SCHEMA,
      },
    });
  });

  it("keeps every schema object strict: all properties required, no extras", () => {
    // Strict mode rejects a schema that omits either rule, and a rejected schema
    // is a hard request failure — so this is checked structurally rather than by
    // reading the literal.
    assertStrictShape(CLAIM_JSON_SCHEMA, "claims");
    assertStrictShape(VERIFIER_JSON_SCHEMA, "verdicts");
  });

  it("omits the reasoning hint unless a valid one is configured", () => {
    const options = {
      schemaName: "s",
      schema: {},
      systemInstruction: "s",
      userContent: "u",
    };

    expect(buildGroqChatRequest(config, options).body).not.toHaveProperty(
      "reasoning_effort",
    );
    expect(
      buildGroqChatRequest(readRuntimeConfig(makeEnv({ llmReasoningEffort: "low" })), options)
        .body.reasoning_effort,
    ).toBe("low");
    // An unrecognised value is dropped rather than forwarded: an invalid enum
    // member is a request the provider rejects.
    expect(
      buildGroqChatRequest(
        readRuntimeConfig(makeEnv({ llmReasoningEffort: "maximum" })),
        options,
      ).body,
    ).not.toHaveProperty("reasoning_effort");
  });

  it("attaches an abort signal so a call cannot hang forever", async () => {
    script.push(() => jsonResponse({ choices: [{ message: { content: JSON.stringify(validClaims) } }] }));
    await new GroqClaimGenerator(config).generate({ question: "q", evidence: [] });
    expect(calls[0].init.signal).toBeInstanceOf(AbortSignal);
  });

  it("joins the base URL without doubling or dropping a slash", () => {
    expect(chatCompletionsUrl("https://api.groq.com/openai/v1")).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
    expect(chatCompletionsUrl("https://api.groq.com/openai/v1/")).toBe(
      "https://api.groq.com/openai/v1/chat/completions",
    );
  });
});

describe("successful generation", () => {
  it("returns the parsed claims and the reported usage", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(validClaims) }, finish_reason: "stop" }],
        usage: { prompt_tokens: 417, completion_tokens: 556, total_tokens: 973 },
      }),
    );

    const outcome = await new GroqClaimGenerator(config).generate({
      question: "q",
      evidence: [{ id: "b_0013", text: "Marlin backoff constant" }],
    });

    expect(outcome.result).toEqual(validClaims);
    expect(outcome.usage).toEqual({
      promptTokens: 417,
      completionTokens: 556,
      thoughtsTokens: null,
    });
  });

  it("accepts a fenced JSON payload, which a strict schema does not guarantee away", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: `\`\`\`json\n${JSON.stringify(validClaims)}\n\`\`\`` } }],
      }),
    );

    const outcome = await new GroqClaimGenerator(config).generate({ question: "q", evidence: [] });
    expect(outcome.result.claims).toHaveLength(1);
  });
});

describe("usage accounting", () => {
  it("does not double-count reasoning, which this API already includes in completion_tokens", () => {
    // Groq's Chat Completions usage object has no separate reasoning counter:
    // reasoning is part of the completion. Deriving a reasoning figure from
    // completion_tokens would charge every reasoning token twice.
    const usage = toTokenUsage({ prompt_tokens: 18, completion_tokens: 556, total_tokens: 574 });

    expect(usage).toEqual({ promptTokens: 18, completionTokens: 556, thoughtsTokens: null });
    expect(meteredTokens(usage)).toBe(574);
    expect(meteredTokens(usage)).toBe(18 + 556);
  });

  it("reports \"not reported\" as null rather than as zero", () => {
    expect(toTokenUsage(undefined)).toBeNull();
    expect(toTokenUsage({})).toBeNull();
    // A reported zero is a measurement and is kept as zero.
    expect(toTokenUsage({ prompt_tokens: 0 })).toEqual({
      promptTokens: 0,
      completionTokens: null,
      thoughtsTokens: null,
    });
  });

  it("discards a non-finite count instead of letting it poison the total", () => {
    const usage = toTokenUsage({ prompt_tokens: Number.NaN, completion_tokens: 10 });
    expect(usage).toEqual({ promptTokens: null, completionTokens: 10, thoughtsTokens: null });
    expect(meteredTokens(usage)).toBe(10);
  });

  it("carries usage out of a FAILED call, because a failed call may still be billed", async () => {
    script.push(() =>
      jsonResponse(
        {
          error: { message: "upstream exploded", type: "server_error" },
          usage: { prompt_tokens: 30, completion_tokens: 7 },
        },
        { status: 500 },
      ),
    );

    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );

    expect(failure.kind).toBe("unavailable");
    expect(failure.usage).toEqual({
      promptTokens: 30,
      completionTokens: 7,
      thoughtsTokens: null,
    });
  });
});

describe("fail-closed behaviour", () => {
  it("rejects invalid JSON", async () => {
    script.push(() => jsonResponse({ choices: [{ message: { content: "not json at all" } }] }));
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("rejects a payload that does not match the claim schema", async () => {
    script.push(() =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ claims: "nope" }) } }] }),
    );
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("names a refusal as a refusal, without echoing any model text", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: "", refusal: "I cannot help with that." } }],
      }),
    );

    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );

    expect(failure.kind).toBe("malformed_response");
    expect(failure.message).toContain("declined");
    expect(failure.message).not.toContain("I cannot help with that");
  });

  it("reports a truncated response without disclosing its content", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: '{"claims":[{"text":"half a th' }, finish_reason: "length" }],
        usage: { prompt_tokens: 100, completion_tokens: 4096 },
      }),
    );

    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );

    expect(failure.kind).toBe("malformed_response");
    expect(failure.message).toContain("finishReason=length");
    expect(failure.message).not.toContain("half a th");
  });

  it("treats an empty response as malformed", async () => {
    script.push(() => jsonResponse({ choices: [{ message: { content: "" } }] }));
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("fails closed when the response has no choices at all", async () => {
    script.push(() => jsonResponse({}));
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });
});

describe("HTTP failures", () => {
  it("reads the rate-limit guidance out of a 429 and does NOT retry", async () => {
    script.push(() =>
      jsonResponse(
        { error: { message: "Rate limit reached", type: "rate_limit_exceeded" } },
        {
          status: 429,
          headers: {
            "retry-after": "12.5",
            "x-ratelimit-remaining-requests": "0",
            "x-ratelimit-limit-requests": "1000",
            "x-ratelimit-remaining-tokens": "37",
          },
        },
      ),
    );

    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );

    expect(failure.kind).toBe("rate_limited");
    expect(failure.status).toBe(429);
    // The actual guidance, so "wait a moment" can be told from "the day is gone".
    expect(failure.message).toContain("retry after 12.5");
    expect(failure.message).toContain("requests remaining today 0");
    expect(failure.message).toContain("requests per day 1000");
    // One attempt: a retry wrapper would multiply billable calls and hide the limit.
    expect(calls).toHaveLength(1);
    expect(GROQ_REQUEST_ATTEMPTS).toBe(1);
  });

  it("adds nothing to the reason when a 429 carries no guidance", () => {
    // The diagnostic may only add a real fact; it must never invent one.
    expect(describeRateLimit(null)).toBe("");
    expect(describeRateLimit(new Headers())).toBe("");
    expect(toProviderFailure(new Error("x"), 429, new Headers()).message).toBe(
      "The provider rate limit was reached.",
    );
  });

  it.each([
    [401, "unavailable"],
    [403, "unavailable"],
    [400, "unavailable"],
    [422, "unavailable"],
    [500, "unavailable"],
    [502, "unavailable"],
    [503, "unavailable"],
    [408, "timeout"],
    [504, "timeout"],
  ])("maps HTTP %i to %s", async (status, kind) => {
    script.push(() => jsonResponse({ error: { message: "x", type: "y" } }, { status }));
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind });
  });

  it("names a rejected request distinctly, since it is not a credential problem", async () => {
    script.push(() => jsonResponse({ error: { message: "x", type: "invalid_request_error" } }, { status: 400 }));
    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );
    expect(failure.message).toContain("HTTP 400");
  });

  it("maps a transport failure to unavailable", async () => {
    script.push(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });

  it("maps the timeout abort to timeout, not to rate_limited", async () => {
    // A timeout must NOT be treated as un-billable: an unanswered request may
    // have been processed, so its budget reservation has to stand.
    script.push(() => {
      const abort = new Error("The operation was aborted due to timeout");
      abort.name = "TimeoutError";
      throw abort;
    });
    const failure = await expectFailure(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    );
    expect(failure.kind).toBe("timeout");
  });

  it("survives a non-JSON error body", async () => {
    script.push(() => new Response("<html>gateway</html>", { status: 502 }));
    await expect(
      new GroqClaimGenerator(config).generate({ question: "q", evidence: [] }),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});

describe("GroqSemanticVerifier", () => {
  it("requests the verdict schema and returns a verdict per index", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify(validVerdicts) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      }),
    );

    const outcome = await new GroqSemanticVerifier(config).verify([
      { index: 0, claimText: "a", evidence: [{ id: "b_0013", text: "Marlin" }] },
    ]);

    expect(outcome.verdicts).toEqual(validVerdicts.verdicts);
    const body = parsedBody(calls[0]);
    const format = body.response_format as {
      json_schema: { name: string; strict: boolean; schema: { properties: { verdicts: unknown } } };
    };
    expect(format.json_schema.name).toBe("horizon_verdicts");
    expect(format.json_schema.strict).toBe(true);
    expect(JSON.stringify(format.json_schema.schema)).toContain("NOT_SUPPORTED");
  });

  it("fails closed by treating a MISSING verdict as NOT_SUPPORTED", async () => {
    script.push(() =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ verdicts: [] }) } }],
      }),
    );

    const outcome = await new GroqSemanticVerifier(config).verify([
      { index: 0, claimText: "a", evidence: [] },
      { index: 3, claimText: "b", evidence: [] },
    ]);

    expect(outcome.verdicts.map((verdict) => verdict.verdict)).toEqual([
      "NOT_SUPPORTED",
      "NOT_SUPPORTED",
    ]);
  });

  it("does not call the provider when there is nothing to verify", async () => {
    await expect(new GroqSemanticVerifier(config).verify([])).resolves.toEqual({
      verdicts: [],
      usage: null,
    });
    expect(calls).toHaveLength(0);
  });

  it("fails closed on a malformed verdict payload", async () => {
    script.push(() =>
      jsonResponse({ choices: [{ message: { content: JSON.stringify({ verdicts: [{ index: "0" }] }) } }] }),
    );
    await expect(
      new GroqSemanticVerifier(config).verify([{ index: 0, claimText: "a", evidence: [] }]),
    ).rejects.toMatchObject({ kind: "malformed_response" });
  });

  it("fails closed when the call itself fails", async () => {
    script.push(() => jsonResponse({ error: {} }, { status: 503 }));
    await expect(
      new GroqSemanticVerifier(config).verify([{ index: 0, claimText: "a", evidence: [] }]),
    ).rejects.toMatchObject({ kind: "unavailable" });
  });
});
