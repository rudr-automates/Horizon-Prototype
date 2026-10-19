import { createHash, createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createServiceRoleClient,
  isDatabaseConfigured,
  withTimeout,
} from "@/lib/db/server";
import type { ServerEnv } from "@/lib/env";

/**
 * Per-client admission control for the one endpoint that spends money.
 *
 * THE PROBLEM
 *   `POST /api/v1/courses/:courseId/questions` was reachable by anyone, with no
 *   per-client limit. The daily token budget bounds the total, but a single
 *   visitor could consume the whole day's allowance in a minute and leave the
 *   deployment refusing every later question — a denial of service that costs
 *   real quota.
 *
 * WHY THE LIMIT IS NOT IN MEMORY WHEN A DATABASE EXISTS
 *   A serverless function has many instances and no shared memory. An in-process
 *   counter would give each instance its own allowance, which is the same as
 *   having none. The authoritative limiter is therefore a single SQL statement
 *   executed by the database: an upsert whose increment is conditional on the
 *   count being below the limit, so two concurrent requests cannot both take the
 *   last slot.
 *
 * FAIL CLOSED
 *   If the limiter cannot be consulted — missing migration, unreadable database,
 *   revoked grant — the answer is "not admitted", never "no limit". The caller
 *   turns that into a 503. A limiter that silently opens when broken is worse
 *   than no limiter, because it looks protected.
 *
 * WHAT IS STORED
 *   Never an IP address. The bucket key is `HMAC-SHA256(salt, day + address)`:
 *   it is stable within one UTC day, cannot be reversed without the salt, and
 *   rotates daily, so the table cannot accumulate a long-lived identifier. The
 *   salt comes from `HORIZON_RATE_LIMIT_SALT`, or is derived from the service-role
 *   key when that is not set.
 */

export interface RateLimitWindow {
  readonly name: string;
  readonly windowSeconds: number;
  readonly limit: number;
}

/**
 * Two windows, because they answer different questions: a burst limit stops a
 * loop, and a daily limit stops a slow drain. Both are per bucket key.
 */
export const QUESTION_LIMITS: ReadonlyArray<RateLimitWindow> = [
  { name: "burst", windowSeconds: 600, limit: 8 },
  { name: "daily", windowSeconds: 86_400, limit: 40 },
];

export interface AdmissionRow {
  admitted: boolean;
  used: number;
  remaining: number;
  retry_after_seconds: number;
}

export interface RateLimitGateway {
  admit(input: {
    bucketKey: string;
    windowSeconds: number;
    limit: number;
    now: Date;
  }): Promise<AdmissionRow>;
}

export interface RateLimitDecision {
  admitted: boolean;
  /** Seconds until the window that refused this request rolls over. */
  retryAfterSeconds: number;
  /** Durable = database-backed; memory = this process only. Never a claim of durability. */
  mode: "durable" | "memory";
  /**
   * True only when no decision could be obtained. The caller must treat this as
   * "refused", and may say the service is temporarily unavailable.
   */
  unavailable?: boolean;
  window?: string;
}

export interface RateLimiter {
  readonly mode: "durable" | "memory";
  readonly detail: string;
  admit(bucketKey: string, now?: Date): Promise<RateLimitDecision>;
}

/* ------------------------------------------------------------------ *
 * Client identity
 * ------------------------------------------------------------------ */

/** Longest plausible textual address (IPv6 is 45); anything longer is not one. */
const MAX_ADDRESS_LENGTH = 64;

/**
 * The client address as the hosting platform reports it.
 *
 * ORDER MATTERS, AND IT IS `x-forwarded-for` FIRST.
 *   Vercel documents that it OVERWRITES an incoming `x-forwarded-for` from the
 *   TCP connection, so a caller cannot choose its left-most entry. Vercel calls
 *   `x-real-ip` "identical to the x-forwarded-for header", but the explicit
 *   overwrite guarantee names only `x-forwarded-for`. Reading `x-real-ip` first
 *   therefore assumes something the platform does not promise: a client that sets
 *   that header itself would get a fresh bucket on every request, which is the
 *   same as having no limit. The trusted header is read first and the second one
 *   is only a fallback for deployments that send it alone.
 *
 * The value is never an identity and never stored: it is HMAC'd into a daily
 * bucket key. No request body field is read, so editing JSON cannot pick a bucket.
 * When no address is present — or the value is not shaped like one — every such
 * request shares one bucket, which is deliberately conservative.
 */
export function clientAddress(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    // Left-most entry is the original client when the platform sits directly in
    // front of the deployment. Later entries are proxies we do not trust.
    const hop = normalizeAddress(forwarded.split(",")[0] ?? "");
    if (hop) return hop;
  }

  const real = request.headers.get("x-real-ip");
  if (real) return normalizeAddress(real);

  return null;
}

/**
 * Strip a port or IPv6 brackets so one client cannot mint several buckets.
 *
 * `203.0.113.7:51234` and `[2001:db8::1]:443` are the same client as their bare
 * forms. A bare IPv6 address keeps its own colons. Anything empty or longer than
 * any real address is not an address, so it is bucketed as unidentified rather
 * than hashed as garbage.
 */
function normalizeAddress(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > MAX_ADDRESS_LENGTH) return null;

  const bracketed = /^\[([0-9a-fA-F:.]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed?.[1]) return bracketed[1];

  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (withPort?.[1]) return withPort[1];

  return value;
}

/** Fallback pepper, so a missing setting still never stores a raw address. */
function resolveSalt(env: ServerEnv): string {
  if (env.rateLimitSalt.trim() !== "") return env.rateLimitSalt.trim();
  const material =
    env.supabaseServiceRoleKey.trim() ||
    env.supabaseUrl.trim() ||
    "horizon-development-only-salt";
  return createHash("sha256").update(`horizon-rate-limit-salt:v1:${material}`).digest("hex");
}

/** One bucket per client per UTC day. 64 hex characters; never an address. */
export function bucketKey(address: string | null, salt: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return createHmac("sha256", salt)
    .update(`horizon-rate-limit:v1:${day}:${address ?? "unidentified"}`)
    .digest("hex");
}

/* ------------------------------------------------------------------ *
 * Durable limiter
 * ------------------------------------------------------------------ */

export function createSupabaseRateLimitGateway(client: SupabaseClient): RateLimitGateway {
  return {
    async admit({ bucketKey: key, windowSeconds, limit, now }) {
      const { data, error } = await client.rpc("horizon_admit_request", {
        p_bucket_key: key,
        p_window_seconds: windowSeconds,
        p_limit: limit,
        p_now: now.toISOString(),
      });
      if (error) {
        throw new Error(`rate limit function failed: ${error.code ?? "unknown"}`);
      }
      // The function returns a single composite row; PostgREST may hand it back
      // as an object or a one-element array depending on the declared shape.
      const row = (Array.isArray(data) ? data[0] : data) as
        | Record<string, unknown>
        | null
        | undefined;
      if (!row) {
        throw new Error("rate limit function returned no row");
      }
      return {
        admitted: row.admitted === true,
        used: Number(row.used ?? 0),
        remaining: Number(row.remaining ?? 0),
        retry_after_seconds: Math.max(0, Math.ceil(Number(row.retry_after_seconds ?? 0))),
      };
    },
  };
}

class DurableRateLimiter implements RateLimiter {
  readonly mode = "durable" as const;
  readonly detail =
    "Requests are counted atomically in the database, per hashed client bucket.";

  constructor(private readonly gateway: RateLimitGateway) {}

  async admit(key: string, now: Date = new Date()): Promise<RateLimitDecision> {
    for (const window of QUESTION_LIMITS) {
      try {
        const row = await this.gateway.admit({
          bucketKey: key,
          windowSeconds: window.windowSeconds,
          limit: window.limit,
          now,
        });
        if (!row.admitted) {
          return {
            admitted: false,
            retryAfterSeconds: Math.max(1, row.retry_after_seconds || window.windowSeconds),
            mode: this.mode,
            window: window.name,
          };
        }
      } catch {
        // Fail closed: an unavailable limiter is a refusal, not an exemption.
        return {
          admitted: false,
          retryAfterSeconds: 60,
          mode: this.mode,
          unavailable: true,
          window: window.name,
        };
      }
    }

    return { admitted: true, retryAfterSeconds: 0, mode: this.mode };
  }
}

/* ------------------------------------------------------------------ *
 * Process-local fallback
 * ------------------------------------------------------------------ */

/**
 * Used ONLY when no database is configured at all. In that mode the spend ledger
 * is already process-local (`resolveUsageLedger` returns the memory ledger), so a
 * process-local limit is not weaker than the metering it sits beside — and the
 * deployment reports itself as degraded. It is never used when a database exists.
 */
class MemoryRateLimiter implements RateLimiter {
  readonly mode = "memory" as const;
  readonly detail =
    "Requests are counted per process only. No database is configured, so this is not a shared limit.";

  private readonly buckets = new Map<string, Map<number, number>>();

  async admit(key: string, now: Date = new Date()): Promise<RateLimitDecision> {
    for (const window of QUESTION_LIMITS) {
      const start = Math.floor(now.getTime() / 1000 / window.windowSeconds) * window.windowSeconds;
      // One counter per window AND per bucket: keying on the window alone would
      // make every client share one allowance.
      const mapKey = `${window.name}:${key}`;
      const counts = this.buckets.get(mapKey) ?? new Map<number, number>();

      // Drop windows that have already rolled over, so the map cannot grow
      // without bound in a long-lived process.
      for (const existing of counts.keys()) {
        if (existing !== start) counts.delete(existing);
      }

      const used = counts.get(start) ?? 0;
      if (used >= window.limit) {
        this.buckets.set(mapKey, counts);
        return {
          admitted: false,
          retryAfterSeconds: Math.max(1, start + window.windowSeconds - Math.floor(now.getTime() / 1000)),
          mode: this.mode,
          window: window.name,
        };
      }
      counts.set(start, used + 1);
      this.buckets.set(mapKey, counts);
    }

    return { admitted: true, retryAfterSeconds: 0, mode: this.mode };
  }
}

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

/** Explicit construction point for tests and for the fail-closed client path. */
export function durableRateLimiter(gateway: RateLimitGateway): RateLimiter {
  return new DurableRateLimiter(gateway);
}

/** The no-database fallback, exposed so its bounds can be tested. */
export function memoryRateLimiter(): RateLimiter {
  return new MemoryRateLimiter();
}

export function createQuestionRateLimiter(env: ServerEnv): RateLimiter {
  if (!isDatabaseConfigured(env)) {
    return new MemoryRateLimiter();
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    // A configured database whose client cannot be built must not fall back to an
    // unlimited limiter. A gateway that always throws produces the fail-closed
    // 503 path on the first admission attempt.
    return new DurableRateLimiter({
      admit: async () => {
        throw new Error("rate limit client unavailable");
      },
    });
  }

  return new DurableRateLimiter(createSupabaseRateLimitGateway(client));
}

/** The bucket key for this request, or a shared bucket when no address exists. */
export function requestBucketKey(request: Request, env: ServerEnv, now: Date = new Date()): string {
  return bucketKey(clientAddress(request), resolveSalt(env), now);
}

/* ------------------------------------------------------------------ *
 * Readiness
 * ------------------------------------------------------------------ */

/**
 * Whether a question could be admitted RIGHT NOW.
 *
 * WHY THIS IS SEPARATE FROM `mode`
 *   `createQuestionRateLimiter` always returns an object; it does not prove the
 *   object can obtain a decision. On a project where migration 0004 has not been
 *   applied, the limiter exists and every admission throws. Without a readiness
 *   probe the health report said "Operational" while every question returned
 *   503 — a deployment claiming health it did not have.
 */
export interface AdmissionProbe {
  ready: boolean;
  mode: "durable" | "memory";
  /** Public-safe sentence: no object names, no error text, no counts. */
  detail: string;
}

/**
 * Classify the answer to a deliberately invalid admission call.
 *
 * The probe passes a key that is too short, so `horizon_admit_request` raises
 * `invalid bucket key` (SQLSTATE 22023) BEFORE it touches the table. Reaching
 * that raise proves the function exists, is executable by this role and entered
 * its body — without claiming a slot, writing a row or consuming a counter.
 *
 * A missing function (PGRST202), a revoked grant (42501), a missing table inside
 * the function (42P01) or any other error is NOT that sentinel, so it is reported
 * as unavailable. Erring towards "not ready" is the safe direction: a readiness
 * probe that claims readiness on an unknown error is worse than none.
 */
export function classifyAdmissionProbeError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  if (!error) return false;
  if (error.code === "22023") return true;
  // Some PostgREST versions surface a raised exception under a generic code, so
  // the sentinel message is accepted as well. It is specific enough to be safe:
  // no other path in this schema produces it.
  return /invalid bucket key/i.test(error.message ?? "");
}

export const ADMISSION_DETAIL = {
  ready: "The request limiter answered, so a question can be admitted.",
  memory:
    "No database is configured, so requests are limited per process only. The limit is real for this instance but is not shared.",
  unavailable:
    "The request limiter is unavailable, so every question is refused before any provider call.",
} as const;

/**
 * Ask the limiter whether it can answer, without consuming anything.
 *
 * Two checks, both read-only:
 *   1. a HEAD count on the counter table (exists, and this role may read it);
 *   2. the invalid-key call above (the function exists and is executable).
 * They run together so the health endpoint gains one round trip, not two.
 */
export async function probeAdmission(
  env: ServerEnv,
  timeoutMs = 5000,
): Promise<AdmissionProbe> {
  if (!isDatabaseConfigured(env)) {
    return { ready: true, mode: "memory", detail: ADMISSION_DETAIL.memory };
  }

  const client = createServiceRoleClient(env);
  if (!client) {
    return { ready: false, mode: "durable", detail: ADMISSION_DETAIL.unavailable };
  }

  try {
    const [table, call] = await Promise.all([
      withTimeout(
        client
          .from("request_rate_limits")
          .select("bucket_key", { count: "exact", head: true }),
        timeoutMs,
      ),
      withTimeout(
        client.rpc("horizon_admit_request", {
          // Deliberately five characters: the function rejects it before any write.
          p_bucket_key: "probe",
          p_window_seconds: 60,
          p_limit: 1,
          p_now: new Date().toISOString(),
        }),
        timeoutMs,
      ),
    ]);

    if (table.error) {
      console.error(`[horizon] rate-limit table probe failed: ${table.error.message}`);
      return { ready: false, mode: "durable", detail: ADMISSION_DETAIL.unavailable };
    }
    if (!classifyAdmissionProbeError(call.error)) {
      console.error(
        `[horizon] rate-limit function probe failed: ${call.error?.code ?? "unknown"} ${call.error?.message ?? ""}`.trim(),
      );
      return { ready: false, mode: "durable", detail: ADMISSION_DETAIL.unavailable };
    }

    return { ready: true, mode: "durable", detail: ADMISSION_DETAIL.ready };
  } catch (error) {
    console.error(
      `[horizon] rate-limit readiness probe threw: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return { ready: false, mode: "durable", detail: ADMISSION_DETAIL.unavailable };
  }
}
