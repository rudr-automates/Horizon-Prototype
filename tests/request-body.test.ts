import { describe, expect, it } from "vitest";
import {
  MAX_JSON_BODY_BYTES,
  declaredLengthExceeds,
  readJsonBody,
} from "@/lib/http/body";

function jsonRequest(body: string): Request {
  return new Request("http://localhost/api/v1/test", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
  });
}

/** A chunked body: no content-length, so only the streamed byte count can stop it. */
function chunkedRequest(chunks: string[]): Request {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

  const init: RequestInit & { duplex?: string } = { method: "POST", body: stream };
  init.duplex = "half";
  return new Request("http://localhost/api/v1/test", init);
}

describe("bounded JSON body", () => {
  it("parses a body inside the ceiling", async () => {
    const result = await readJsonBody(jsonRequest(JSON.stringify({ question: "why?" })));

    expect(result).toEqual({ ok: true, value: { question: "why?" } });
  });

  it("rejects a declared length over the ceiling without reading", async () => {
    const request = jsonRequest("{}");
    const withLength = new Request(request.url, {
      method: "POST",
      body: "{}",
      headers: { "content-length": String(MAX_JSON_BODY_BYTES + 1) },
    });

    expect(declaredLengthExceeds(withLength.headers.get("content-length"), MAX_JSON_BODY_BYTES)).toBe(true);
    expect(await readJsonBody(withLength)).toEqual({ ok: false, reason: "too_large" });
  });

  it("stops a chunked body that crosses the ceiling without a content-length header", async () => {
    const chunk = "x".repeat(4 * 1024);
    const request = chunkedRequest([chunk, chunk, chunk, chunk, chunk]);

    expect(request.headers.get("content-length")).toBeNull();
    expect(await readJsonBody(request)).toEqual({ ok: false, reason: "too_large" });
  });

  it("accepts a chunked body that stays inside the ceiling", async () => {
    const request = chunkedRequest(['{"question":', '"why?"}']);

    expect(await readJsonBody(request)).toEqual({ ok: true, value: { question: "why?" } });
  });

  it("rejects an empty, malformed or non-JSON body", async () => {
    expect(await readJsonBody(jsonRequest(""))).toEqual({ ok: false, reason: "invalid" });
    expect(await readJsonBody(jsonRequest("{"))).toEqual({ ok: false, reason: "invalid" });
    expect(await readJsonBody(jsonRequest("not json"))).toEqual({ ok: false, reason: "invalid" });
  });

  it("treats a body with no stream as invalid rather than an empty object", async () => {
    const request = new Request("http://localhost/api/v1/test", { method: "POST" });

    expect(await readJsonBody(request)).toEqual({ ok: false, reason: "invalid" });
  });
});
