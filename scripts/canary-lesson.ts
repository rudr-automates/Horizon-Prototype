/**
 * Live canary against the REAL lesson transcript.
 *
 *   pnpm canary:lesson --base http://127.0.0.1:4321
 *   pnpm canary:lesson --positions 300,1200,3000 --label lesson
 *   pnpm canary:lesson --max-turns 2     # spend less of the day's budget
 *
 * WHAT MAKES THIS DIFFERENT FROM `pnpm canary`
 *   That harness interrogates the synthetic fixture and marks anything it cannot
 *   form an oracle for as NOT RUN, because it only holds the fixture's text. This
 *   one reads the ACTUAL stored transcript from the database and builds its own
 *   expected-eligible set from those rows, so every claim below is checked against
 *   the evidence a real turn would have used:
 *
 *     - the scope endpoint's count equals an independently written oracle;
 *     - a fact that only exists late in the recording is absent from the eligible
 *       set — and from the entire response body — before its unlock time, and
 *       present after it;
 *     - every returned citation id names a block that was eligible at that
 *       position, read back from the database;
 *     - every returned quotation appears verbatim in that stored block;
 *     - every citation label carries its block's real clock;
 *     - an unsupported question is refused with no fabricated claims.
 *
 * COST
 *   Each turn is one embedding request plus two generation calls, all metered by
 *   the same guards the app uses. `--max-turns` caps the number of turns, the
 *   ledger is read before and after, and the run stops early rather than pushing
 *   the day's budget to its edge.
 *
 * NOTHING HERE IS SIMULATED. The script only reads HTTP responses and rows, and
 * writes them to docs/evidence/. A provider or budget failure is reported as NOT
 * RUN, never as a pass.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LESSON_VIDEO, LESSON_VIDEO_SUGGESTED_QUESTIONS } from "@/lib/lesson/video";
import { lessonTranscriptCourseId } from "@/lib/ingest/lesson-transcript";
import { loadEnvFile, presentNames } from "./env-file";

const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

/**
 * The fact this canary uses to prove temporal scoping: a phrase that occurs in
 * exactly one place in the recording, late in it. Both spellings are checked
 * because the ASR writes the number and the phrase in the same sentence.
 */
const CANARY = {
  label: "the compliance-score threshold stated late in the lesson",
  terms: ["compliance score", "75%"],
  /** Where the transcript states it, for the report. */
  appearsAtSeconds: 2699,
} as const;

const UNSUPPORTED_QUESTION =
  "How do I configure a Kubernetes ingress controller to serve gRPC over HTTP/2?";

/** Phrases that must not appear anywhere in the transcript. */
const UNSUPPORTED_MARKERS = ["kubernetes", "ingress", "grpc"];

interface Position {
  label: string;
  seconds: number;
}

interface StoredBlock {
  id: string;
  text: string;
  startSeconds: number;
  endSeconds: number;
  unlockSeconds: number;
  policy: string;
  reviewState: string;
  ingestStatus: string;
}

interface Check {
  id: string;
  description: string;
  outcome: "PASS" | "FAIL" | "NOT RUN";
  detail: string;
}

interface AnswerBody {
  answerState?: string;
  reason?: string;
  message?: string;
  claims?: Array<{ text?: string }>;
  citations?: Array<{
    evidenceId?: string;
    sourceLabel?: string;
    quote?: string;
    startSeconds?: number | null;
    endSeconds?: number | null;
  }>;
  evidence?: { source?: string; payloadCount?: number; embeddingProvider?: string };
  scope?: { boundarySeconds?: number };
  guard?: { spentTokensToday?: number | null; budgetTokens?: number };
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function clock(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function parsePositions(raw: string | null): Position[] {
  const source = raw ?? "300,1200,3000";
  const seconds = source
    .split(",")
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0);
  if (seconds.length === 0) throw new Error(`--positions "${source}" named no usable seconds.`);
  return seconds.map((value) => ({ seconds: value, label: clock(value) }));
}

/**
 * The expected-eligible set, written out HERE rather than imported.
 *
 * A test oracle that reuses the code under test cannot disagree with it, which is
 * the whole reason this expression exists independently. It reads only the rows
 * this run fetched from the database.
 */
function expectedEligibleIds(blocks: StoredBlock[], boundarySeconds: number): string[] {
  return blocks
    .filter((block) => {
      if (block.ingestStatus !== "INDEXED") return false;
      if (block.policy === "TIMELINE_BOUND") {
        const approved = block.reviewState === "AUTO_APPROVED" || block.reviewState === "HUMAN_APPROVED";
        if (!approved) return false;
        if (!Number.isFinite(block.unlockSeconds)) return false;
        return block.unlockSeconds <= boundarySeconds;
      }
      return false;
    })
    .map((block) => block.id);
}

async function loadBlocks(
  client: SupabaseClient,
  courseId: string,
): Promise<StoredBlock[]> {
  const { data, error } = await client
    .from("blocks")
    .select("id, text_normalized, start_seconds, end_seconds, unlock_seconds, policy, review_state, ingest_status")
    .eq("course_id", courseId)
    .limit(5000);
  if (error) throw new Error(`Could not read the lesson's blocks: ${error.message}`);

  return ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    text: String(row.text_normalized ?? ""),
    startSeconds: Number(row.start_seconds),
    endSeconds: Number(row.end_seconds),
    unlockSeconds: Number(row.unlock_seconds),
    policy: String(row.policy ?? ""),
    reviewState: String(row.review_state ?? ""),
    ingestStatus: String(row.ingest_status ?? ""),
  }));
}

async function main(): Promise<void> {
  loadEnvFile();

  const base = (argValue("base") ?? process.env.HORIZON_BASE_URL ?? "http://127.0.0.1:4321").replace(
    /\/+$/,
    "",
  );
  const label = argValue("label") ?? "lesson-live";
  const positions = parsePositions(argValue("positions"));
  const maxTurnsRaw = argValue("max-turns");
  const maxTurns = maxTurnsRaw === null ? 4 : Number.parseInt(maxTurnsRaw, 10);

  const db = presentNames(REQUIRED_DB_NAMES);
  if (db.missing.length > 0) {
    console.error(
      `CANARY CANNOT RUN: not set: ${db.missing.join(", ")}. Without the service-role key this\n` +
        "harness cannot read the stored transcript, and an oracle invented offline would prove nothing.",
    );
    process.exitCode = 1;
    return;
  }

  const { createServiceRoleClient } = await import("@/lib/db/server");
  const { readServerEnv } = await import("@/lib/env");
  const { resolveUsageLedger } = await import("@/lib/usage");
  const { utcDayKey } = await import("@/lib/usage/types");

  const env = readServerEnv();
  const client = createServiceRoleClient(env);
  if (!client) {
    console.error("CANARY CANNOT RUN: no service-role client could be created.");
    process.exitCode = 1;
    return;
  }
  const ledger = resolveUsageLedger(env).ledger;

  const coursesResponse = await fetch(`${base}/api/v1/courses`, { cache: "no-store" });
  const courseList = (await coursesResponse.json()) as { courses?: Array<{ courseId?: string }> };
  const courseId = argValue("course") ?? lessonTranscriptCourseId();
  const served = (courseList.courses ?? []).map((course) => String(course.courseId));
  const courseServed = served.includes(courseId);

  console.log(`Canary target : ${base}`);
  console.log(`Lesson course : ${courseId} (${courseServed ? "served by the app" : "NOT in the app's course list"})`);
  console.log(`Recording     : ${LESSON_VIDEO.title} · https://youtu.be/${LESSON_VIDEO.youtubeId}`);

  const blocks = await loadBlocks(client, courseId);
  if (blocks.length === 0) {
    console.error(
      "CANARY CANNOT RUN: this course has no stored blocks, so there is no transcript to check.\n" +
        "Run pnpm ingest:lesson first.",
    );
    process.exitCode = 1;
    return;
  }

  const canaryBlocks = blocks.filter((block) =>
    CANARY.terms.some((term) => normalize(block.text).includes(normalize(term))),
  );
  const unlockingBlock = canaryBlocks.length
    ? canaryBlocks.reduce((earliest, block) =>
        block.unlockSeconds < earliest.unlockSeconds ? block : earliest,
      )
    : null;

  console.log(
    `Stored blocks : ${blocks.length} spanning ${clock(Math.min(...blocks.map((b) => b.startSeconds)))}–${clock(
      Math.max(...blocks.map((b) => b.endSeconds)),
    )}`,
  );
  console.log(
    `Canary fact   : "${CANARY.terms[0]}" appears in ${canaryBlocks.length} stored block(s); earliest unlock ${
      unlockingBlock ? clock(unlockingBlock.unlockSeconds) : "n/a"
    }`,
  );

  const unsupportedInCorpus = blocks.some((block) =>
    UNSUPPORTED_MARKERS.some((marker) => normalize(block.text).includes(marker)),
  );
  console.log(
    `Unsupported Q : ${unsupportedInCorpus ? "WARNING — a marker phrase occurs in the corpus, so a refusal would not be forced by absence" : "no marker phrase occurs anywhere in the corpus"}\n`,
  );

  // Budget BEFORE, from the store the guards enforce in.
  let tokensBefore: number | null = null;
  let embeddingBefore: number | null = null;
  try {
    tokensBefore = await ledger.spentToday();
    embeddingBefore = await ledger.embeddingRequestsToday();
  } catch {
    console.log("Note: the ledger could not be read before the run; before/after will be unknown.");
  }
  console.log(
    `Budget before : ${tokensBefore ?? "unknown"} generation tokens spent today (UTC ${utcDayKey()}); ${embeddingBefore ?? "unknown"} embedding request(s)\n`,
  );

  const turns: Array<{
    position: Position;
    question: string;
    intent: string;
    answer: AnswerBody;
    checks: Check[];
  }> = [];

  /** The four turns: a supported early question, the leak probe, the late answer, a refusal. */
  const plan: Array<{ position: Position; question: string; intent: string }> = [
    {
      position: positions[0],
      question: LESSON_VIDEO_SUGGESTED_QUESTIONS[0],
      intent: "supported-early",
    },
    {
      position: positions[1] ?? positions[0],
      question: LESSON_VIDEO_SUGGESTED_QUESTIONS[2],
      intent: "future-fact-before-unlock",
    },
    {
      position: positions[positions.length - 1],
      question: LESSON_VIDEO_SUGGESTED_QUESTIONS[2],
      intent: "late-supported",
    },
    {
      position: positions[positions.length - 1],
      question: UNSUPPORTED_QUESTION,
      intent: "unsupported",
    },
  ].slice(0, maxTurns);

  for (const [index, turn] of plan.entries()) {
    const { position, question, intent } = turn;

    // Stop before spending the last of the day's budget rather than discovering
    // the refusal mid-turn.
    if (index > 0) {
      try {
        const spent = await ledger.spentToday();
        const budget = Number(process.env.HORIZON_DAILY_TOKEN_BUDGET ?? "0");
        if (budget > 0 && budget - spent < 5000) {
          console.log(
            `Stopping before turn ${index + 1}: ${budget - spent} tokens remain of the daily budget, which is not enough for two more metered calls.`,
          );
          break;
        }
      } catch {
        /* the guard refuses on its own if the ledger is unreadable */
      }
    }

    const scopeResponse = await fetch(
      `${base}/api/v1/courses/${courseId}/scope?playheadSeconds=${position.seconds}`,
      { cache: "no-store" },
    );
    const scope = (await scopeResponse.json()) as { eligibleBlockCount?: number };

    const answerResponse = await fetch(`${base}/api/v1/courses/${courseId}/questions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ question, playheadSeconds: position.seconds }),
      cache: "no-store",
    });
    const answer = (await answerResponse.json()) as AnswerBody;
    const rawBody = JSON.stringify(answer);

    const checks: Check[] = [];
    const boundary = Math.min(position.seconds, LESSON_VIDEO.durationSeconds);
    const oracleIds = expectedEligibleIds(blocks, boundary);
    const eligible = new Set(oracleIds);
    const state = String(answer.answerState ?? "");
    const citations = Array.isArray(answer.citations) ? answer.citations : [];
    const factEligibleNow = oracleIds.some((id) => {
      const block = blocks.find((candidate) => candidate.id === id);
      return (
        block !== undefined &&
        CANARY.terms.some((term) => normalize(block.text).includes(normalize(term)))
      );
    });
    const factUnlocked = unlockingBlock !== null && unlockingBlock.unlockSeconds <= boundary;

    // ---- the eligible set, against an oracle written separately ----------
    checks.push({
      id: "eligible-set",
      description: "the app's eligible count matches an independently written oracle",
      outcome: Number(scope.eligibleBlockCount) === oracleIds.length ? "PASS" : "FAIL",
      detail: `app reported ${scope.eligibleBlockCount ?? "(missing)"}; oracle computed ${oracleIds.length} from ${blocks.length} stored blocks`,
    });

    // ---- the temporal invariant -----------------------------------------
    checks.push({
      id: "future-fact-availability",
      description: factUnlocked
        ? "the late fact is available once the recording has reached it"
        : "the late fact is NOT available before the recording reaches it",
      outcome: factUnlocked
        ? factEligibleNow
          ? "PASS"
          : "FAIL"
        : factEligibleNow
          ? "FAIL"
          : "PASS",
      detail: factUnlocked
        ? `${canaryBlocks.length} stored block(s) contain the fact and unlock at or before ${clock(boundary)}`
        : `the fact's earliest unlock is ${unlockingBlock ? clock(unlockingBlock.unlockSeconds) : "unknown"}; 0 of ${oracleIds.length} eligible blocks contain it`,
    });

    checks.push({
      id: "no-fact-in-response",
      description: factUnlocked
        ? "the fact may be disclosed now that the recording has reached it"
        : "nothing in the response discloses the late fact",
      outcome: factUnlocked
        ? "PASS"
        : CANARY.terms.some((term) => normalize(rawBody).includes(normalize(term)))
          ? "FAIL"
          : "PASS",
      detail: factUnlocked
        ? "not applicable: the fact is eligible at this position"
        : `searched the whole response body for ${CANARY.terms.map((term) => `"${term}"`).join(" and ")}`,
    });

    // ---- citation provenance, against the stored transcript --------------
    const unknownCitations = citations.filter(
      (citation) => !eligible.has(String(citation.evidenceId)),
    );
    checks.push({
      id: "citations-eligible",
      description: "every citation id names a block that was eligible at this position",
      outcome: unknownCitations.length === 0 ? "PASS" : "FAIL",
      detail: `${citations.length} citation(s); ${unknownCitations.length} outside the ${oracleIds.length}-block eligible set`,
    });

    const quoteFaults = citations.filter((citation) => {
      const block = blocks.find((candidate) => candidate.id === String(citation.evidenceId));
      if (!block) return true;
      const quote = normalize(String(citation.quote ?? ""));
      if (quote === "") return true;
      return !normalize(block.text).includes(quote);
    });
    checks.push({
      id: "quotes-verbatim",
      description: "every quotation appears verbatim in its cited stored block",
      outcome: quoteFaults.length === 0 ? "PASS" : "FAIL",
      detail: `${citations.length} quotation(s); ${quoteFaults.length} did not match the stored text`,
    });

    const labelFaults = citations.filter((citation) => {
      const block = blocks.find((candidate) => candidate.id === String(citation.evidenceId));
      if (!block) return true;
      return !String(citation.sourceLabel ?? "").includes(clock(block.startSeconds));
    });
    checks.push({
      id: "citation-clock",
      description: "every citation label carries its source block's real clock",
      outcome: labelFaults.length === 0 ? "PASS" : "FAIL",
      detail: `${citations.length} label(s); ${labelFaults.length} disagreed with the stored start time`,
    });

    const internalLeaks = ["NOT_AVAILABLE_YET", "NOT_IN_MATERIALS", "internalState"].filter(
      (token) => rawBody.includes(token),
    );
    checks.push({
      id: "no-internal-leak",
      description: "the response exposes no collapsed internal state",
      outcome: internalLeaks.length === 0 ? "PASS" : "FAIL",
      detail: internalLeaks.length === 0 ? "none of the internal tokens appeared" : `found ${internalLeaks.join(", ")}`,
    });

    // ---- the intent of THIS turn ----------------------------------------
    const providerFailure = state === "TEMPORARILY_UNAVAILABLE";
    const rendered = [
      ...(answer.claims ?? []).map((claim) => String(claim.text ?? "")),
      ...citations.map((citation) => String(citation.quote ?? "")),
      String(answer.message ?? ""),
    ].join("\n");
    const renderedDisclosesFact = CANARY.terms.some((term) =>
      normalize(rendered).includes(normalize(term)),
    );

    if (intent === "supported-early") {
      checks.push({
        id: "expected-outcome",
        description: "an early question about material the recording has reached is answered from it",
        outcome: providerFailure
          ? "NOT RUN"
          : state === "ANSWERED" || state === "ANSWERED_PARTIAL"
            ? citations.length > 0
              ? "PASS"
              : "FAIL"
            : state === "INSUFFICIENT_EVIDENCE"
              ? "FAIL"
              : "FAIL",
        detail: providerFailure
          ? `blocked: the provider or the spend guard refused the turn (reason=${String(answer.reason)})`
          : `answerState=${state}; ${answer.claims?.length ?? 0} claim(s); ${citations.length} citation(s)`,
      });
    } else if (intent === "future-fact-before-unlock") {
      checks.push({
        id: "expected-outcome",
        description: "a question about a passage the recording has not reached discloses nothing from it",
        outcome: providerFailure ? "NOT RUN" : renderedDisclosesFact ? "FAIL" : "PASS",
        detail: providerFailure
          ? `inconclusive: the turn failed for provider/budget reasons (reason=${String(answer.reason)}), so nothing was rendered and temporal scoping was NOT demonstrated`
          : `answerState=${state}; inspected ${answer.claims?.length ?? 0} claim(s) and ${citations.length} quotation(s) for the withheld fact`,
      });
    } else if (intent === "late-supported") {
      const citesTheFact = citations.some((citation) => {
        const block = blocks.find((candidate) => candidate.id === String(citation.evidenceId));
        return (
          block !== undefined &&
          CANARY.terms.some((term) => normalize(block.text).includes(normalize(term)))
        );
      });
      checks.push({
        id: "expected-outcome",
        description: "after the recording reaches it, the late fact is answerable and cited",
        outcome: providerFailure
          ? "NOT RUN"
          : state === "ANSWERED" || state === "ANSWERED_PARTIAL"
            ? citesTheFact
              ? "PASS"
              : "FAIL"
            : "FAIL",
        detail: providerFailure
          ? `blocked: the provider or the spend guard refused the turn (reason=${String(answer.reason)})`
          : `answerState=${state}; ${citations.length} citation(s); the late fact is cited: ${citesTheFact}`,
      });
    } else {
      checks.push({
        id: "expected-outcome",
        description: "a question the transcript does not cover is refused, not answered",
        outcome: providerFailure
          ? "NOT RUN"
          : (answer.claims?.length ?? 0) > 0
            ? "FAIL"
            : state === "INSUFFICIENT_EVIDENCE"
              ? "PASS"
              : "FAIL",
        detail: providerFailure
          ? `blocked: the provider or the spend guard refused the turn (reason=${String(answer.reason)})`
          : `answerState=${state}; ${answer.claims?.length ?? 0} claim(s) rendered; message "${String(answer.message ?? "").slice(0, 120)}"`,
      });
    }

    turns.push({ position, question, intent, answer, checks });

    console.log(`── turn ${index + 1}: ${intent} at ${position.label} ─────────────`);
    console.log(`   question      ${question}`);
    console.log(
      `   eligible ${scope.eligibleBlockCount ?? "-"} · answerState=${state} · reason=${String(answer.reason)} · payload ${answer.evidence?.payloadCount ?? "-"} · citations ${citations.length}`,
    );
    for (const check of checks) {
      const mark = check.outcome === "PASS" ? "PASS " : check.outcome === "FAIL" ? "FAIL " : "N/RUN";
      console.log(`   [${mark}] ${check.id} — ${check.detail}`);
    }
    console.log("");
  }

  const allChecks = turns.flatMap((turn) => turn.checks);
  const failed = allChecks.filter((check) => check.outcome === "FAIL");
  const notRun = allChecks.filter((check) => check.outcome === "NOT RUN");

  let tokensAfter: number | null = null;
  let embeddingAfter: number | null = null;
  try {
    tokensAfter = await ledger.spentToday();
    embeddingAfter = await ledger.embeddingRequestsToday();
  } catch {
    /* reported as unknown */
  }

  const artifact = {
    recordedAt: new Date().toISOString(),
    label,
    base,
    courseId,
    courseServedByApp: courseServed,
    recording: {
      title: LESSON_VIDEO.title,
      youtubeId: LESSON_VIDEO.youtubeId,
      durationSeconds: LESSON_VIDEO.durationSeconds,
    },
    canary: {
      label: CANARY.label,
      terms: CANARY.terms,
      storedBlocksContainingIt: canaryBlocks.length,
      earliestUnlockSeconds: unlockingBlock?.unlockSeconds ?? null,
      earliestUnlockClock: unlockingBlock ? clock(unlockingBlock.unlockSeconds) : null,
    },
    unsupportedQuestion: {
      question: UNSUPPORTED_QUESTION,
      markerPhrasePresentInCorpus: unsupportedInCorpus,
    },
    storedBlockCount: blocks.length,
    budget: {
      utcDay: utcDayKey(),
      generationTokensBefore: tokensBefore,
      generationTokensAfter: tokensAfter,
      embeddingRequestsBefore: embeddingBefore,
      embeddingRequestsAfter: embeddingAfter,
    },
    summary: {
      turns: turns.length,
      checks: allChecks.length,
      passed: allChecks.filter((check) => check.outcome === "PASS").length,
      failed: failed.length,
      notRun: notRun.length,
    },
    turns,
  };

  const serialized = JSON.stringify(artifact, null, 2);
  const directory = resolve(process.cwd(), "docs", "evidence");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = resolve(directory, `canary-lesson-${label}-${stamp}.json`);
  writeFileSync(target, `${serialized}\n`, "utf8");

  console.log(
    `Summary: ${artifact.summary.passed} passed, ${failed.length} failed, ${notRun.length} not run (${turns.length} turn(s)).`,
  );
  for (const check of failed) console.log(`  FAIL ${check.id}: ${check.detail}`);
  for (const check of notRun) console.log(`  NOT RUN ${check.id}: ${check.detail}`);
  console.log(
    `Budget after  : ${tokensAfter ?? "unknown"} generation tokens (before ${tokensBefore ?? "unknown"}); ${embeddingAfter ?? "unknown"} embedding request(s) (before ${embeddingBefore ?? "unknown"})`,
  );
  console.log(`\nRaw responses written to docs/evidence/${target.split(/[\\/]/).pop()}`);

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`The lesson canary could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
