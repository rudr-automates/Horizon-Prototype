/**
 * Read a JSON request body with a hard byte ceiling.
 *
 * WHY NOT `request.json()`
 *   `request.json()` consumes whatever arrives. There is no body-size limit on a
 *   Next.js route handler, so an anonymous caller can stream a very large body at
 *   a public endpoint and pay only their own bandwidth. The endpoint parses JSON
 *   before it can know the question is 500 characters at most.
 *
 * WHY `Content-Length` IS NOT ENOUGH
 *   It is a claim, and a chunked request does not have one at all. The limit here
 *   is enforced on the BYTES ACTUALLY RECEIVED: the stream is read chunk by chunk,
 *   the running total is checked after each chunk, and the stream is cancelled as
 *   soon as the ceiling is crossed. `Content-Length` is still checked first as a
 *   cheap rejection, because it lets an honest oversized request fail without
 *   transferring anything.
 */

/** Generous for a 500-character question plus a playhead and a scope mode. */
export const MAX_JSON_BODY_BYTES = 16 * 1024;

export type JsonBodyResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: "too_large" }
  | { ok: false; reason: "invalid" };

/** True when a declared length alone proves the body is over the ceiling. */
export function declaredLengthExceeds(
  contentLength: string | null,
  maxBytes: number,
): boolean {
  if (contentLength === null) return false;
  const parsed = Number.parseInt(contentLength, 10);
  return Number.isFinite(parsed) && parsed > maxBytes;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<JsonBodyResult> {
  if (declaredLengthExceeds(request.headers.get("content-length"), maxBytes)) {
    return { ok: false, reason: "too_large" };
  }

  const body = request.body;
  if (body === null) return { ok: false, reason: "invalid" };

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        // Stop the transfer rather than buffering the rest and rejecting later.
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: "invalid" };
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  const text = new TextDecoder().decode(bytes).trim();
  if (text === "") return { ok: false, reason: "invalid" };

  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false, reason: "invalid" };
  }
}
