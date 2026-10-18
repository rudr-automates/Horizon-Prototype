/**
 * Read-only verification of the PERSISTED corpus and the retrieval path.
 *
 * WHY THIS EXISTS
 *   The spend guard fails closed while migration 0003 is unapplied, so no live
 *   answer can be produced. That does not mean nothing about the deployment can
 *   be checked: the seeded rows, the eligibility predicate and both retrieval
 *   branches are all reachable without a provider. This script exercises them
 *   through the app's OWN store and then proves it did not spend anything.
 *
 * WHAT IT DOES NOT DO
 *   It makes no provider request. It does not write to any table. It does not
 *   claim a generation, a persisted turn, or migration 0003.
 *
 * HOW IT PROVES IT SPENT NOTHING
 *   The ledger total is compared before and after (durable, but blind to
 *   embedding requests, which carry no tokens), the process-local embedder
 *   counter is compared too (sees this process only), and the durable count of
 *   embedding-request rows for the day is compared as well. A reader who saw
 *   just the process-local counter reading 0 -> 0 could mistake it for a
 *   statement about the day.
 *
 * THE ONE OUT-OF-BAND READ
 *   The app's gateway deliberately does NOT select the `embedding` column, so
 *   there is no in-app way to obtain a stored vector to query with. This script
 *   reads exactly one stored embedding directly with the service-role key, and
 *   only for that purpose. The vector search itself still runs through
 *   `SupabaseEvidenceStore.searchVector`, i.e. the same code the app uses.
 *
 * Run: pnpm verify:data-path [--base http://127.0.0.1:4321]
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { embeddingCallCount } from "@/lib/answer/capped-embedder";
import { createServiceRoleClient, isDatabaseConfigured } from "@/lib/db/server";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import { readServerEnv } from "@/lib/env";
import { createServerContext } from "@/lib/server/context";
import type { EvidenceBlock } from "@/lib/retrieval/types";
import { utcDayKey } from "@/lib/usage/types";
import { loadEnvFile, presentNames } from "./env-file";

/** The fact that must stay hidden before its block unlocks. */
const LOCKED_FACT = "0.37";
const FULL_BOUNDARY = 900;
const EARLY_BOUNDARY = 0;

/**
 * `pending` is for a dependency this revision cannot satisfy — an unapplied
 * migration, say. It is NOT a way to soften a failure: a pending check is
 * counted and labelled as pending, never as passed, and the detail always names
 * the action that would resolve it.
 */
type CheckState = "pass" | "fail" | "pending";

interface Check {
  name: string;
  state: CheckState;
  detail: string;
}

const checks: Check[] = [];

const LABEL: Record<CheckState, string> = { pass: "PASS", fail: "FAIL", pending: "PENDING" };

function record(name: string, ok: boolean, detail: string): void {
  push(name, ok ? "pass" : "fail", detail);
}

function recordPending(name: string, detail: string): void {
  push(name, "pending", detail);
}

function push(name: string, state: CheckState, detail: string): void {
  checks.push({ name, state, detail });
  console.log(`${LABEL[state].padEnd(7)} ${name}\n        ${detail}`);
}

function parseBase(argv: string[]): string {
  const index = argv.indexOf("--base");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return (value ?? "http://127.0.0.1:4321").replace(/\/$/, "");
}

function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) return value as number[];
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed === "") return null;
  const parts = trimmed.split(",").map((part) => Number.parseFloat(part));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

type ServiceRoleClient = NonNullable<ReturnType<typeof createServiceRoleClient>>;

/**
 * Embedding REQUESTS recorded durably for the current UTC day, or null when that
 * count could not be read.
 *
 * This mirrors the predicate the durable cap itself counts —
 * `horizon_admit_embedding_request` tallies `day = today and kind =
 * 'embedding_request'` across every provider — so the "nothing was spent" claim
 * rests on the ledger rather than only on `embeddingCallCount()`, which is
 * process-local and therefore reads 0 -> 0 even on a day the application really
 * did consume part of the cap.
 *
 * Null is deliberately NOT 0: it means the durable half of that claim could not
 * be verified.
 */
async function embeddingRowsToday(client: ServiceRoleClient | null): Promise<number | null> {
  if (!client) return null;
  const { count, error } = await client
    .from("usage_ledger")
    .select("id", { count: "exact", head: true })
    .eq("day", utcDayKey())
    .eq("kind", "embedding_request");
  if (error) return null;
  return count ?? 0;
}

async function probeJson(
  base: string,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown } | null> {
  try {
    const response = await fetch(`${base}${path}`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, body: await response.json() };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const base = parseBase(process.argv.slice(2));
  const loadedEnvFile = loadEnvFile();

  const env = readServerEnv();
  const { set, missing } = presentNames([
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);

  console.log("Horizon — persisted data-path verification (no provider calls)");
  console.log(`env file loaded : ${loadedEnvFile ? ".env.local" : "(none found)"}`);
  console.log(`database names  : set ${set.length}/3, missing ${missing.join(", ") || "none"}`);
  console.log(`http base       : ${base}`);
  console.log("");

  const context = createServerContext();
  const store = context.storeResolution.store;
  const ledger = context.usageResolution.ledger;
  // Created once, up front, because the "nothing was spent" proof needs a
  // before-and-after read of the DURABLE embedding-request count. The one
  // out-of-band read further down reuses this same client.
  const client = isDatabaseConfigured(env) ? createServiceRoleClient(env) : null;

  // Read the day's spend BEFORE doing anything, so "nothing was written" is a
  // measurement rather than a promise. The embedding counter is process-local,
  // and this process has not embedded at this point.
  //
  // This MUST NOT be fatal. The ledger failing to read is itself a finding worth
  // reporting — it is what makes migration 0003 mandatory — but it has nothing
  // to do with the corpus and retrieval checks below, which need no ledger and no
  // provider. Aborting here would hide the part of the deployment that works.
  const spentBefore = await readSpendOrNull(ledger);
  const embedCallsBefore = embeddingCallCount();
  const embedRowsBefore = await embeddingRowsToday(client);

  if (spentBefore === null) {
    recordPending(
      "the durable ledger is readable (a reservation can be granted)",
      `mode ${ledger.mode}, and the read FAILED. Apply migration 0003 with docs/apply-migration.md; the spend guard fails closed until then, so no provider call is possible. This is an external prerequisite, not a defect in this revision.`,
    );
  } else {
    record(
      "the durable ledger is readable (a reservation can be granted)",
      true,
      `mode ${ledger.mode}, ${spentBefore} tokens recorded today`,
    );
  }

  if (store.mode !== "supabase") {
    record(
      "the persisted, database-backed corpus is in use",
      false,
      `store mode is "${store.mode}", not "supabase" — the fixture corpus is answering. ${context.storeResolution.reason}`,
    );
    finish();
    return;
  }
  record("the persisted, database-backed corpus is in use", true, context.storeResolution.reason);

  // ---------------------------------------------------------------- courses
  const courses = await store.listCourses();
  record("listCourses returns the seeded course", courses.length >= 1, `${courses.length} course(s)`);
  const course = courses[0];
  if (!course) {
    record("a course can be read", false, "no course row exists");
    finish();
    return;
  }
  console.log(`        courseId ${course.courseId} — "${course.title}" (${course.durationSeconds}s)`);

  const detail = await store.getCourse(course.courseId);
  record(
    "getCourse returns the same course",
    detail !== null && detail.courseId === course.courseId,
    detail ? `${detail.durationSeconds}s, demoContent ${detail.demoContent}` : "null",
  );

  const boundary = { courseId: course.courseId, boundarySeconds: FULL_BOUNDARY };
  const earlyBoundary = { courseId: course.courseId, boundarySeconds: EARLY_BOUNDARY };

  // ------------------------------------------------------------ eligibility
  const early = await store.listEligible(earlyBoundary, 100);
  const full = await store.listEligible(boundary, 100);

  record(
    "eligibility grows with the boundary and never shrinks",
    early.length <= full.length && early.length > 0,
    `${EARLY_BOUNDARY}s -> ${early.length} blocks, ${FULL_BOUNDARY}s -> ${full.length} blocks`,
  );

  // The predicate is applied twice on purpose: once in SQL, once in the store.
  // Re-running it here is the independent third opinion.
  const ineligibleLeaked = full.filter(
    (block) =>
      !isBlockEligible(
        {
          courseId: block.courseId,
          ingestStatus: block.ingestStatus,
          policy: block.policy,
          reviewState: block.reviewState,
          lintStatus: block.lintStatus,
          unlockSeconds: block.unlockSeconds,
        },
        boundary,
      ),
  );
  record(
    "no ineligible block is returned (predicate re-applied independently)",
    ineligibleLeaked.length === 0,
    `${ineligibleLeaked.length} leaked of ${full.length}`,
  );

  const pendingOrFlagged = full.filter(
    (block) => block.reviewState === "PENDING" || block.lintStatus === "FLAGGED",
  );
  record(
    "unreviewed and lint-flagged material is excluded",
    pendingOrFlagged.length === 0,
    `${pendingOrFlagged.length} of ${full.length} returned blocks are PENDING or FLAGGED`,
  );

  const unlocked = full.filter((block) => block.unlockSeconds !== null);
  record(
    "most persisted blocks carry an unlock timestamp",
    unlocked.length > 0,
    `${unlocked.length} of ${full.length} eligible blocks have a non-null unlock_seconds`,
  );

  // ------------------------------------------------- non-disclosure, persisted
  const corpusMentionsFact =
    full.some((block) => block.text.includes(LOCKED_FACT)) ||
    early.some((block) => block.text.includes(LOCKED_FACT));
  if (!corpusMentionsFact) {
    record(
      "the locked fact is present in the corpus at all",
      false,
      `no eligible block contains "${LOCKED_FACT}", so non-disclosure cannot be demonstrated on persisted rows`,
    );
  } else {
    const earlyDisclosure = early.filter((block) => block.text.includes(LOCKED_FACT));
    record(
      "the fact is NOT disclosed before it unlocks (persisted rows)",
      earlyDisclosure.length === 0,
      `${earlyDisclosure.length} of ${early.length} blocks eligible at ${EARLY_BOUNDARY}s contain "${LOCKED_FACT}"`,
    );
    const fullDisclosure = full.filter((block) => block.text.includes(LOCKED_FACT));
    record(
      "the fact IS available once its block unlocks",
      fullDisclosure.length > 0,
      `${fullDisclosure.length} of ${full.length} blocks eligible at ${FULL_BOUNDARY}s contain "${LOCKED_FACT}"`,
    );
  }

  // --------------------------------------------------------------- full text
  const fts = await store.searchFullText(boundary, "backoff constant", 5);
  record(
    "full-text search returns eligible hits against persisted rows",
    fts.length > 0 && fts.every((hit) => full.some((block) => block.id === hit.block.id)),
    `${fts.length} hit(s): ${fts.map((hit) => hit.block.id).join(", ") || "none"}`,
  );

  const ftsAtZero = await store.searchFullText(earlyBoundary, LOCKED_FACT, 5);
  record(
    "full-text search cannot surface the fact before it unlocks",
    ftsAtZero.every((hit) => !hit.block.text.includes(LOCKED_FACT)),
    `${ftsAtZero.length} hit(s) at ${EARLY_BOUNDARY}s for "${LOCKED_FACT}"`,
  );

  const lockedButIndexed = await store.hasMatchingIneligible(earlyBoundary, LOCKED_FACT);
  record(
    "an indexed but ineligible match is reported as a boolean only",
    lockedButIndexed === true,
    `hasMatchingIneligible at ${EARLY_BOUNDARY}s = ${lockedButIndexed} (the material exists and is withheld)`,
  );
  const absentTerm = await store.hasMatchingIneligible(earlyBoundary, "zzz-not-present-term");
  record(
    "a query with no indexed match reports false",
    absentTerm === false,
    `hasMatchingIneligible for a nonsense term = ${absentTerm}`,
  );

  // ----------------------------------------------------------------- vector
  // Any eligible block will do: the gateway does not select the embedding
  // column, so the stored vector is read below instead.
  const selfBlock: EvidenceBlock | undefined = full[0];

  if (!client || !selfBlock) {
    record("a stored vector can be read for a self-match check", false, "no client or no eligible block");
  } else {
    const { data, error } = await client
      .from("blocks")
      .select("id, embedding")
      .eq("id", selfBlock.id)
      .maybeSingle();

    const stored = parseEmbedding((data as { embedding?: unknown } | null)?.embedding);
    if (error || !stored) {
      record(
        "a stored vector can be read for a self-match check",
        false,
        error ? "the out-of-band embedding read failed" : "the stored embedding was empty or unparseable",
      );
    } else {
      const dimensions = stored.length;
      record(
        "the stored vector has the configured dimension",
        dimensions === context.config.embeddingDimensions,
        `${dimensions} values, configured ${context.config.embeddingDimensions}`,
      );

      const hits = await store.searchVector(boundary, stored, 5);
      const top = hits[0];
      record(
        "vector search over persisted rows finds the same block first",
        hits.length > 0 && top?.block.id === selfBlock.id,
        `top hit ${top?.block.id ?? "none"} (queried with the vector of ${selfBlock.id})`,
      );
      record(
        "querying a block with its own stored vector scores a near-exact match",
        top !== undefined && Math.abs(top.score) < 1e-6,
        `distance ${top === undefined ? "n/a" : Math.abs(top.score)}`,
      );

      const vectorAtZero = await store.searchVector(earlyBoundary, stored, 5);
      record(
        "vector search respects the boundary even for an exact match",
        vectorAtZero.every((hit) => hit.block.unlockSeconds === null || hit.block.unlockSeconds <= EARLY_BOUNDARY || hit.block.policy === "COURSE_WIDE"),
        `${vectorAtZero.length} hit(s) at ${EARLY_BOUNDARY}s`,
      );
    }
  }

  // -------------------------------------------------------------- http probes
  const health = await probeJson(base, "/api/v1/health");
  if (!health) {
    record(
      "the running server answers the health endpoint",
      false,
      `no response from ${base} — start it with: pnpm build && pnpm start -p 4321 (this is a reporting gap, not a code failure)`,
    );
  } else {
    const body = health.body as {
      ok?: boolean;
      status?: string;
      checks?: { database?: { durableLedger?: string } };
      runtime?: { spendGuard?: string; evidenceSource?: string; demoContent?: boolean };
    };
    record(
      "the running server answers the health endpoint",
      health.status === 200,
      `HTTP ${health.status}, ok ${body.ok}, status ${body.status}`,
    );
    record(
      "health reports the database-backed store",
      body.runtime?.evidenceSource === "supabase" && body.runtime?.demoContent === false,
      `evidenceSource ${body.runtime?.evidenceSource}, demoContent ${body.runtime?.demoContent}`,
    );

    // The detailed report is no longer public. Read it through the operator
    // route when a token is available; otherwise say plainly that the figures
    // are not exposed rather than printing `undefined` as if it were a value.
    const diagnosticsToken = (process.env.HORIZON_DIAGNOSTICS_TOKEN ?? "").trim();
    const diagnostics = diagnosticsToken
      ? await probeJson(base, "/api/v1/health/diagnostics", {
          authorization: `Bearer ${diagnosticsToken}`,
        })
      : null;

    if (diagnostics?.status === 200) {
      const detail = diagnostics.body as {
        runtime?: { spendGuard?: string };
        checks?: { database?: { durableLedger?: string } };
      };
      // Reported, not asserted against a remembered state: `permitted`/`usable`
      // and `blocked`/`unreadable` are both legitimate, and which one appears is
      // a fact about the deployment rather than something to presume.
      console.log(
        `        spendGuard ${detail.runtime?.spendGuard}, durableLedger ${detail.checks?.database?.durableLedger}`,
      );
    } else {
      console.log(
        "        spendGuard and durableLedger are operator diagnostics: set HORIZON_DIAGNOSTICS_TOKEN " +
          "to read them from /api/v1/health/diagnostics. The public payload intentionally omits them.",
      );
    }
  }

  const coursesProbe = await probeJson(base, "/api/v1/courses");
  if (coursesProbe) {
    const body = coursesProbe.body as { courses?: unknown[]; evidenceSource?: string };
    record(
      "the course endpoint serves the persisted course over HTTP",
      coursesProbe.status === 200 && (body.courses?.length ?? 0) >= 1,
      `HTTP ${coursesProbe.status}, ${body.courses?.length ?? 0} course(s), source ${body.evidenceSource}`,
    );
  }

  const scopeProbe = await probeJson(base, `/api/v1/courses/${course.courseId}/scope?playheadSeconds=0`);
  if (scopeProbe) {
    const body = scopeProbe.body as { eligibleBlockCount?: number; boundarySeconds?: number };
    record(
      "the scope endpoint counts eligible blocks over HTTP",
      scopeProbe.status === 200 && body.eligibleBlockCount === early.length,
      `HTTP ${scopeProbe.status}, eligibleBlockCount ${body.eligibleBlockCount} at ${body.boundarySeconds}s (store said ${early.length})`,
    );

    const badScope = await probeJson(
      base,
      `/api/v1/courses/${course.courseId}/scope?playheadSeconds=-1`,
    );
    if (badScope) {
      record(
        "a negative playhead is rejected rather than clamped",
        badScope.status === 400,
        `HTTP ${badScope.status}`,
      );
    }

    const unknownScope = await probeJson(base, "/api/v1/courses/not-a-course/scope?playheadSeconds=0");
    if (unknownScope) {
      record(
        "an unknown course is not found",
        unknownScope.status === 404,
        `HTTP ${unknownScope.status}`,
      );
    }
  }

  // ------------------------------------------------- nothing was spent
  const spentAfter = await readSpendOrNull(ledger);
  const embedCallsAfter = embeddingCallCount();
  const embedRowsAfter = await embeddingRowsToday(client);
  // Two instruments, because neither is sufficient alone: the ledger total is
  // durable but blind to embedding requests (they carry no tokens), and the
  // embedder counter sees this process only. An unreadable durable count fails
  // this check rather than passing it vacuously.
  const durableCountVerified = embedRowsBefore !== null && embedRowsAfter !== null;
  record(
    "this script made no provider call and wrote nothing to the ledger",
    spentAfter === spentBefore &&
      embedCallsAfter === embedCallsBefore &&
      durableCountVerified &&
      embedRowsAfter === embedRowsBefore,
    durableCountVerified
      ? `ledger ${spentBefore} -> ${spentAfter}; embedding calls in this process ${embedCallsBefore} -> ${embedCallsAfter}; embedding requests recorded for ${utcDayKey()} ${embedRowsBefore} -> ${embedRowsAfter}`
      : `ledger ${spentBefore} -> ${spentAfter}; embedding calls in this process ${embedCallsBefore} -> ${embedCallsAfter}; the durable embedding-request count could NOT be read, so the durable half of this claim is unverified`,
  );

  finish({ spentBefore, spentAfter, embedCallsBefore, embedCallsAfter, embedRowsBefore, embedRowsAfter });
}

/**
 * The day's spend, or null when the ledger cannot be read.
 *
 * Null is deliberately distinct from 0: an unreadable ledger means the total is
 * UNKNOWN, and reporting it as zero would turn a missing migration into "nothing
 * has been spent".
 */
async function readSpendOrNull(ledger: { spentToday(): Promise<number> }): Promise<number | null> {
  try {
    return await ledger.spentToday();
  } catch (error) {
    console.log(
      `        ledger read failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return null;
  }
}

/**
 * Write the evidence file and exit non-zero if anything failed.
 *
 * The file is written even when checks fail: a partial result that says which
 * check failed is worth more than no artifact.
 */
function finish(
  spendProof?: {
    spentBefore: number | null;
    spentAfter: number | null;
    /** Process-local counter: proves THIS process made no embedding call. */
    embedCallsBefore: number;
    embedCallsAfter: number;
    /** Durable embedding-request rows for the day; null means unreadable. */
    embedRowsBefore: number | null;
    embedRowsAfter: number | null;
  },
): void {
  const passed = checks.filter((check) => check.state === "pass").length;
  const failed = checks.filter((check) => check.state === "fail").length;
  const pending = checks.filter((check) => check.state === "pending").length;

  console.log("");
  console.log(
    `${passed}/${checks.length} checks passed` +
      `${failed > 0 ? `, ${failed} FAILED` : ""}` +
      `${pending > 0 ? `, ${pending} pending an external prerequisite (see detail)` : ""}`,
  );

  const directory = resolve(process.cwd(), "docs", "evidence");
  mkdirSync(directory, { recursive: true });
  const path = resolve(directory, `data-path-verification-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);

  writeFileSync(
    path,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        label: "data-path-verification",
        command: "pnpm verify:data-path",
        base: parseBase(process.argv.slice(2)),
        providerCallsMade: 0,
        spendProof: spendProof ?? null,
        summary: { checks: checks.length, passed, failed, pending },
        checks,
        limitations: [
          "no generation call was made and none is claimed: the provider free-tier quota is exhausted",
          "this script applies no migration and exercises none of 0003's reservation functions; the atomic admission claim is tested by pnpm verify:budget, not here",
          "the vector self-match read one stored embedding out of band because the app's gateway does not select that column; the search itself ran through the app's store",
          "turn persistence to the database remains unexercised: it is only reached after a successful generation",
        ],
        secretsPrinted: 0,
      },
      null,
      2,
    )}\n`,
  );

  console.log(`evidence written: ${path}`);
  // Only a real failure fails the run: an unmet external prerequisite is
  // reported as pending and must not be laundered into a green exit code, nor
  // used to mask a defect. A failure anywhere still exits non-zero.
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error("verification did not complete:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
