import { ApiError } from "@google/genai";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GeminiClaimGenerator,
  GeminiEmbedder,
  GeminiSemanticVerifier,
  toProviderFailure,
} from "@/lib/answer/gemini";
import { ProviderFailure } from "@/lib/answer/provider";
import { readRuntimeConfig } from "@/lib/config";
import { FakeGeminiClient, fakeVector, makeEnv } from "./helpers/fakes";

const config = readRuntimeConfig(
  makeEnv({
    llmProvider: "google-genai",
    llmApiKey: "placeholder",
    llmModel: "gemini-3.6-flash",
    embeddingModel: "gemini-embedding-001",
    embeddingDimensions: 768,
  }),
);

let client: FakeGeminiClient;

beforeEach(() => {
  client = new FakeGeminiClient();
});

const validClaimsJson = JSON.stringify({
  claims: [
    {
      text: "The instructor chooses a sub-unit coefficient.",
      evidenceIds: ["b_0013"],
      quote: "Marlin backoff constant",
    },
  ],
  unansweredParts: false,
});

describe("GeminiClaimGenerator", () => {
  it("requests the configured model with JSON structured output at temperature 0", async () => {
    client.generateResponses.push({ text: validClaimsJson });
    const generator = new GeminiClaimGenerator(client, config);

    const { result } = await generator.generate({
      question: "q",
      evidence: [{ id: "b_0013", text: "Marlin backoff constant, 0.37" }],
    });

    expect(result.claims).toHaveLength(1);
    expect(client.generateCalls).toHaveLength(1);
    const call = client.generateCalls[0];
    expect(call.model).toBe("gemini-3.6-flash");
    expect(call.config.responseMimeType).toBe("application/json");
    expect(call.config.responseSchema).toBeTypeOf("object");
    expect(call.config.temperature).toBe(0);
    expect(call.contents).toContain("b_0013");
  });

  it("fails closed on invalid JSON", async () => {
    client.generateResponses.push({ text: "not json at all" });
    const generator = new GeminiClaimGenerator(client, config);

    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("fails closed on an empty response", async () => {
    client.generateResponses.push({ text: "" });
    const generator = new GeminiClaimGenerator(client, config);
    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("fails closed when the payload does not match the claim schema", async () => {
    client.generateResponses.push({ text: JSON.stringify({ claims: "nope" }) });
    const generator = new GeminiClaimGenerator(client, config);
    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("maps a 429 to rate_limited", async () => {
    client.generateResponses.push(new ApiError({ message: "quota", status: 429 }));
    const generator = new GeminiClaimGenerator(client, config);
    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "rate_limited",
    });
  });

  it("maps an invalid-key 400 to unavailable", async () => {
    client.generateResponses.push(new ApiError({ message: "API_KEY_INVALID", status: 400 }));
    const generator = new GeminiClaimGenerator(client, config);
    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "unavailable",
    });
  });

  it("maps a 504 to timeout", async () => {
    client.generateResponses.push(new ApiError({ message: "DEADLINE_EXCEEDED", status: 504 }));
    const generator = new GeminiClaimGenerator(client, config);
    await expect(generator.generate({ question: "q", evidence: [] })).rejects.toMatchObject({
      kind: "timeout",
    });
  });
});

describe("toProviderFailure", () => {
  it("treats a client abort as a timeout", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(toProviderFailure(abort).kind).toBe("timeout");
  });

  it("passes an existing ProviderFailure through unchanged", () => {
    const original = new ProviderFailure("rate_limited", "x");
    expect(toProviderFailure(original)).toBe(original);
  });
});

describe("GeminiEmbedder", () => {
  it("uses the configured embedding model, dimension and query task type", async () => {
    client.embedResponses.push({ embeddings: [{ values: fakeVector(768) }] });
    const embedder = new GeminiEmbedder(client, config);

    const vectors = await embedder.embed(["hello"], "query");

    expect(vectors[0]).toHaveLength(768);
    expect(embedder.dimensions).toBe(768);
    const call = client.embedCalls[0];
    expect(call.model).toBe("gemini-embedding-001");
    expect(call.config.outputDimensionality).toBe(768);
    expect(call.config.taskType).toBe("RETRIEVAL_QUERY");
  });

  it("uses the document task type for document embeddings", async () => {
    client.embedResponses.push({ embeddings: [{ values: fakeVector(768) }] });
    const embedder = new GeminiEmbedder(client, config);
    await embedder.embed(["doc"], "document");
    expect(client.embedCalls[0].config.taskType).toBe("RETRIEVAL_DOCUMENT");
  });

  it("fails closed when the returned dimension does not match", async () => {
    client.embedResponses.push({ embeddings: [{ values: fakeVector(256) }] });
    const embedder = new GeminiEmbedder(client, config);
    await expect(embedder.embed(["x"], "query")).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });

  it("fails closed when fewer embeddings are returned than inputs", async () => {
    client.embedResponses.push({ embeddings: [] });
    const embedder = new GeminiEmbedder(client, config);
    await expect(embedder.embed(["a", "b"], "query")).rejects.toMatchObject({
      kind: "malformed_response",
    });
  });
});

describe("GeminiSemanticVerifier", () => {
  it("returns verdicts for every requested index", async () => {
    client.generateResponses.push({
      text: JSON.stringify({
        verdicts: [
          { index: 0, verdict: "SUPPORTED", reason: "ok" },
          { index: 1, verdict: "NOT_SUPPORTED", reason: "topical only" },
        ],
      }),
    });
    const verifier = new GeminiSemanticVerifier(client, config);
    const { verdicts } = await verifier.verify([
      { index: 0, claimText: "a", evidence: [] },
      { index: 1, claimText: "b", evidence: [] },
    ]);
    expect(verdicts.map((verdict) => verdict.verdict)).toEqual([
      "SUPPORTED",
      "NOT_SUPPORTED",
    ]);
  });

  it("fails closed by treating a missing verdict as NOT_SUPPORTED", async () => {
    client.generateResponses.push({
      text: JSON.stringify({ verdicts: [{ index: 0, verdict: "SUPPORTED", reason: "ok" }] }),
    });
    const verifier = new GeminiSemanticVerifier(client, config);
    const { verdicts } = await verifier.verify([
      { index: 0, claimText: "a", evidence: [] },
      { index: 7, claimText: "b", evidence: [] },
    ]);
    expect(verdicts.find((verdict) => verdict.index === 7)?.verdict).toBe("NOT_SUPPORTED");
  });

  it("returns an empty list without calling the model when there is nothing to verify", async () => {
    const verifier = new GeminiSemanticVerifier(client, config);
    await expect(verifier.verify([])).resolves.toEqual({ verdicts: [], usage: null });
    expect(client.generateCalls).toHaveLength(0);
  });
});
