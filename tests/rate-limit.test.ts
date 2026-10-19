import { describe, expect, it } from "vitest";
import {
  QUESTION_LIMITS,
  bucketKey,
  classifyAdmissionProbeError,
  clientAddress,
  durableRateLimiter,
  memoryRateLimiter,
  requestBucketKey,
  type RateLimitGateway,
} from "@/lib/rate-limit";
import type { ServerEnv } from "@/lib/env";

const BURST = QUESTION_LIMITS.find((window) => window.name === "burst")!;
const DAY = QUESTION_LIMITS.find((window) => window.name === "daily")!;

/** A counter per (bucket, window, start), which is what the SQL function keeps. */
function fakeGateway(options: { fail?: boolean } = {}): RateLimitGateway {
  const counters = new Map<string, number>();

  return {
    async admit({ bucketKey, windowSeconds, limit, now }) {
      if (options.fail) throw new Error("horizon_admit_request does not exist");

      const start =
        Math.floor(now.getTime() / 1000 / windowSeconds) * windowSeconds;
      const key = `${bucketKey}:${windowSeconds}:${start}`;
      const used = (counters.get(key) ?? 0) + 1;
      counters.set(key, used);

      return {
        admitted: used <= limit,
        used,
        remaining: Math.max(0, limit - used),
        retry_after_seconds:
          used <= limit
            ? 0
            : start + windowSeconds - Math.floor(now.getTime() / 1000),
      };
    },
  };
}

const T0 = new Date("2026-10-19T09:00:00.000Z");

describe("question rate limiting", () => {
  it("admits the burst allowance and refuses the next request with a retry window", async () => {
    const limiter = durableRateLimiter(fakeGateway());
    const key = "bucket-a";

    for (let index = 0; index < BURST.limit; index += 1) {
      expect((await limiter.admit(key, T0)).admitted).toBe(true);
    }

    const refused = await limiter.admit(key, T0);
    expect(refused.admitted).toBe(false);
    expect(refused.unavailable).toBeUndefined();
    expect(refused.window).toBe("burst");
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("admits again once the burst window has rolled over, without resetting the daily count", async () => {
    const limiter = durableRateLimiter(fakeGateway());
    const key = "bucket-b";

    for (let index = 0; index < BURST.limit; index += 1) {
      await limiter.admit(key, T0);
    }
    expect((await limiter.admit(key, T0)).admitted).toBe(false);

    const later = new Date(T0.getTime() + BURST.windowSeconds * 1000);
    expect((await limiter.admit(key, later)).admitted).toBe(true);
  });

  it("refuses at the daily ceiling even when the burst window is fresh", async () => {
    let clock = T0.getTime();
    let dayCount = 0;
    const gateway: RateLimitGateway = {
      async admit({ windowSeconds, limit }) {
        return {
          // Model only the daily ceiling: burst always has room.
          admitted: windowSeconds !== DAY.windowSeconds ? true : ++dayCount <= limit,
          used: dayCount,
          remaining: 0,
          retry_after_seconds: 1,
        };
      },
    };
    const limiter = durableRateLimiter(gateway);

    for (let index = 0; index < DAY.limit; index += 1) {
      clock += 1000;
      expect((await limiter.admit("bucket-c", new Date(clock))).admitted).toBe(true);
    }

    const refused = await limiter.admit("bucket-c", new Date(clock));
    expect(refused.admitted).toBe(false);
    expect(refused.window).toBe("daily");
  });

  it("admits exactly one of two concurrent requests for the last slot", async () => {
    // The counter itself is the database's job, under a single atomic statement.
    // What this pins is the limiter contract above it: two callers asking at the
    // same moment must not both be told yes.
    const limiter = durableRateLimiter(fakeGateway());
    const key = "bucket-concurrent";

    for (let index = 0; index < BURST.limit - 1; index += 1) {
      expect((await limiter.admit(key, T0)).admitted).toBe(true);
    }

    const [first, second] = await Promise.all([
      limiter.admit(key, T0),
      limiter.admit(key, T0),
    ]);

    expect([first.admitted, second.admitted].filter(Boolean)).toHaveLength(1);
    expect([first.admitted, second.admitted].filter((admitted) => !admitted)).toHaveLength(1);
  });

  it("fails closed when the limiter cannot be consulted", async () => {
    const limiter = durableRateLimiter(fakeGateway({ fail: true }));

    const decision = await limiter.admit("bucket-d", T0);

    expect(decision.admitted).toBe(false);
    expect(decision.unavailable).toBe(true);
    expect(limiter.mode).toBe("durable");
  });

  it("bounds the no-database fallback per bucket and per burst window", async () => {
    const limiter = memoryRateLimiter();

    for (let index = 0; index < BURST.limit; index += 1) {
      expect((await limiter.admit("bucket-e", T0)).admitted).toBe(true);
    }

    expect((await limiter.admit("bucket-e", T0)).admitted).toBe(false);
    // A different bucket is unaffected, and the window rolls over.
    expect((await limiter.admit("bucket-f", T0)).admitted).toBe(true);
    expect(
      (await limiter.admit("bucket-e", new Date(T0.getTime() + BURST.windowSeconds * 1000)))
        .admitted,
    ).toBe(true);
    expect(limiter.mode).toBe("memory");
  });
});

describe("rate-limit readiness", () => {
  it("accepts only the sentinel the invalid-key probe provokes", () => {
    // The probe calls the function with a five-character key, so the function
    // raises `invalid bucket key` (22023) before touching the table.
    expect(classifyAdmissionProbeError({ code: "22023", message: "invalid bucket key" })).toBe(
      true,
    );
    // Some PostgREST versions wrap the raised error under a generic code.
    expect(classifyAdmissionProbeError({ code: "P0001", message: "invalid bucket key" })).toBe(
      true,
    );
  });

  it("treats every other failure as not ready, including a missing migration", () => {
    expect(
      classifyAdmissionProbeError({
        code: "PGRST202",
        message: "Could not find the function public.horizon_admit_request",
      }),
    ).toBe(false);
    expect(classifyAdmissionProbeError({ code: "42501", message: "permission denied" })).toBe(
      false,
    );
    expect(classifyAdmissionProbeError({ code: "42P01", message: "relation does not exist" })).toBe(
      false,
    );
    expect(classifyAdmissionProbeError({ code: "57014", message: "canceling statement" })).toBe(
      false,
    );
    expect(classifyAdmissionProbeError(null)).toBe(false);
    expect(classifyAdmissionProbeError(undefined)).toBe(false);
  });
});

describe("rate-limit bucket keys", () => {
  it("hashes the address into a stable, day-scoped key that contains no address", () => {
    const key = bucketKey("203.0.113.9", "pepper", T0);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("203.0.113.9");
    expect(bucketKey("203.0.113.9", "pepper", T0)).toBe(key);
    expect(bucketKey("203.0.113.9", "pepper", new Date("2026-10-20T09:00:00.000Z"))).not.toBe(key);
    expect(bucketKey("198.51.100.4", "pepper", T0)).not.toBe(key);
  });

  it("gives every address-less request one shared conservative bucket", () => {
    expect(bucketKey(null, "pepper", T0)).toBe(bucketKey(null, "pepper", T0));
    expect(bucketKey(null, "pepper", T0)).not.toBe(bucketKey("203.0.113.9", "pepper", T0));
  });

  it("reads the platform-overwritten header first, not the one a client can set", () => {
    // Vercel documents that it overwrites x-forwarded-for from the TCP
    // connection; the x-real-ip guarantee is only "identical to" it. Reading
    // x-real-ip first would let a caller choose a bucket per request.
    const both = new Request("http://localhost/x", {
      headers: { "x-real-ip": "203.0.113.9", "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
    });
    expect(clientAddress(both)).toBe("198.51.100.4");

    // The same request with an attacker-chosen x-real-ip lands in the same
    // bucket, so the spoof does not buy a fresh allowance.
    const spoofed = new Request("http://localhost/x", {
      headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
    });
    expect(clientAddress(spoofed)).toBe(clientAddress(both));

    const forwarded = new Request("http://localhost/x", {
      headers: { "x-forwarded-for": "198.51.100.4, 10.0.0.1" },
    });
    expect(clientAddress(forwarded)).toBe("198.51.100.4");

    const realOnly = new Request("http://localhost/x", {
      headers: { "x-real-ip": "203.0.113.9" },
    });
    expect(clientAddress(realOnly)).toBe("203.0.113.9");

    expect(clientAddress(new Request("http://localhost/x"))).toBeNull();
  });

  it("normalizes a port or IPv6 brackets so one client keeps one bucket", () => {
    const expectAddress = (headers: Record<string, string>, expected: string | null) =>
      expect(clientAddress(new Request("http://localhost/x", { headers }))).toBe(expected);

    expectAddress({ "x-forwarded-for": " 203.0.113.9 " }, "203.0.113.9");
    expectAddress({ "x-forwarded-for": "203.0.113.9:51234" }, "203.0.113.9");
    expectAddress({ "x-forwarded-for": "[2001:db8::1]:443" }, "2001:db8::1");
    expectAddress({ "x-forwarded-for": "2001:db8::1" }, "2001:db8::1");
    // Not address-shaped: bucketed as unidentified rather than hashed as garbage.
    expectAddress({ "x-forwarded-for": "   " }, null);
    expectAddress({ "x-forwarded-for": "x".repeat(65) }, null);
  });

  it("derives a key from the environment without exposing the salt", () => {
    const env = {
      rateLimitSalt: "explicit-pepper",
      supabaseServiceRoleKey: "service-role-value",
      supabaseUrl: "https://example.supabase.co",
    } as ServerEnv;
    const request = new Request("http://localhost/x", {
      headers: { "x-real-ip": "203.0.113.9" },
    });

    const key = requestBucketKey(request, env, T0);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain("explicit-pepper");
    expect(key).not.toContain("203.0.113.9");
  });
});
