import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type { ErrorCode, ErrorEnvelope } from "@/lib/contracts/http";

/** Stable HTTP status for each safe error code. */
const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_REQUEST: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  FILE_TOO_LARGE: 413,
  UNSUPPORTED_TYPE: 415,
  RATE_LIMITED: 429,
  RATE_LIMIT_UNAVAILABLE: 503,
  PROVIDER_UNAVAILABLE: 503,
  BUDGET_EXHAUSTED: 429,
  LEARNER_DATA_UNAVAILABLE: 503,
  INTERNAL_ERROR: 500,
};

export function newRequestId(): string {
  return randomUUID();
}

export class ApiError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/**
 * Build a stable, safe error response. Callers must not pass messages that
 * reveal future-resource details, IDs, counts or database internals.
 */
export function errorResponse(
  code: ErrorCode,
  message: string,
  requestId: string,
  headers: Record<string, string> = {},
): NextResponse<ErrorEnvelope> {
  const body: ErrorEnvelope = { error: { code, message, requestId } };
  return NextResponse.json(body, {
    status: STATUS_BY_CODE[code],
    // Every error is a per-request fact; none of them may be cached.
    headers: { "cache-control": "no-store", ...headers },
  });
}
