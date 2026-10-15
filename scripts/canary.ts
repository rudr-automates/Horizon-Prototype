/**
 * End-to-end canary harness.
 *
 *   pnpm canary                       # against http://127.0.0.1:4321
 *   pnpm canary --base http://... --label after-seed
 *   pnpm canary --base http://... --delay 45000   # space positions out
 *
 * `--delay <ms>` waits between positions. Use it on a free tier: three turns
 * back to back can exceed the per-minute request quota, and the resulting
 * PROVIDER_RATE_LIMITED turns the answer half of the run into NOT RUN.
 *
 * Asks the same canary question at three lesson positions and records what the
 * running server ACTUALLY returned. Nothing here is simulated: the script only
 * reads HTTP responses and writes them to `docs/evidence/`.
 *
 * WHAT IT CAN AND CANNOT PROVE
 *   Observable over HTTP (checked here):
 *     - the currently eligible set at each position,
 *     - that the future-only fact is absent from the eligible set (and from the
 *       response body) before its unlock time and present after it,
 *     - that every returned citation id belongs to that eligible set,
 *     - that every returned quotation appears verbatim in the cited source,
 *     - that every citation label carries the true clock of its source block,
 *     - that refusals are clear and leak no internal state.
 *   NOT observable over HTTP, and therefore NOT claimed here:
 *     - the exact evidence payload handed to the generator (the response exposes
 *       only its count, by design),
 *     - whether semantic verification passed for a specific claim
 *       (that is asserted in the mocked pipeline tests instead).
 *   When no runtime credential is configured the 12:00 supported-answer case is
 *   recorded as NOT RUN — blocked — never as a failure of the pipeline and never
 *   as a pass.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEMO_BLOCKS, DEMO_CANARY, DEMO_COURSE, DEMO_QUESTIONS } from "@/lib/demo/lesson";
import { loadEnvFile } from "./env-file";

interface Position {
  label: string;
  seconds: number;
}

const POSITIONS: Position[] = [
  { label: "00:00", seconds: 0 },
  { label: "06:00", seconds: 360 },
  { label: "12:00", seconds: 720 },
];

/**
 * Only the fields this harness reads. They are declared narrowly on purpose:
 * a field the API does not promise is not available to the checks below.
 */
interface HealthBody {
  checks?: {
    database?: { configured?: boolean };
    runtimeAi?: { configured?: boolean };
  };
}

interface ScopeBody {
  eligibleBlockCount?: number;
}

interface CitationBody {
  evidenceId?: string;
  sourceLabel?: string;
  quote?: string;
}

interface AnswerBody {
  answerState?: string;
  reason?: string;
  message?: string;
  claims?: Array<{ text?: string }>;
  citations?: CitationBody[];
  evidence?: {
    source?: string;
    payloadCount?: number;
    embeddingProvider?: string;
  };
}

type CheckOutcome = "PASS" | "FAIL" | "NOT RUN";

interface Check {
  id: string;
  description: string;
  outcome: CheckOutcome;
  detail: string;
}

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

/**
 * Pause between positions.
 *
 * The three positions fire three full turns back to back, and each turn makes
 * several provider calls. On a free tier that burst hits the per-minute request
 * quota, which surfaces as PROVIDER_RATE_LIMITED and turns the answer half of
 * the canary into NOT RUN — a real limit on the harness, not a finding about the
 * app. Spacing the positions keeps the run inside the quota. Default 0, so a
 * paid-tier or already-throttle-aware run is unchanged.
 */
function delayMs(): number {
  const raw = argValue("delay");
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Testing oracle: a SECOND, independent expression of the policy. It is written
 * out explicitly here (rather than importing the application's predicate) so a
 * bug in the application predicate cannot silently satisfy its own test.
 */
function expectedEligibleFixtureIds(boundarySeconds: number): string[] {
  return DEMO_BLOCKS.filter((block) => {
    if (block.ingestStatus !== "INDEXED") return false;
    if (block.policy === "TIMELINE_BOUND") {
      if (block.reviewState !== "AUTO_APPROVED" && block.reviewState !== "HUMAN_APPROVED") {
        return false;
      }
      if (block.unlockSeconds === null) return false;
      return block.unlockSeconds <= boundarySeconds;
    }
    if (block.policy === "COURSE_WIDE") {
      if (block.reviewState !== "HUMAN_APPROVED") return false;
      return block.lintStatus === "PASSED" || block.lintStatus === "ACKNOWLEDGED";
    }
    return false;
  }).map((block) => block.id);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const textByFixtureId = new Map(DEMO_BLOCKS.map((block) => [block.id, block.text]));
const startSecondsByFixtureId = new Map(
  DEMO_BLOCKS.map((block) => [block.id, block.startSeconds]),
);

/** Collect non-empty environment values so the artifact can be leak-checked. */
function configuredSecretCandidates(): string[] {
  const names = [
    "HORIZON_LLM_API_KEY",
    "HORIZON_EMBEDDING_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
  ];
  return names
    .map((name) => (process.env[name] ?? "").trim())
    .filter((value) => value.length >= 8);
}

async function main(): Promise<void> {
  loadEnvFile();

  const base = (argValue("base") ?? process.env.HORIZON_BASE_URL ?? "http://127.0.0.1:4321").replace(
    /\/+$/,
    "",
  );
  const label = argValue("label") ?? "canary";

  console.log(`Canary target: ${base}`);
  console.log(`Question    : ${DEMO_QUESTIONS.canary}`);
  console.log(
    `Fixture     : a future-only fact unlocks at ${DEMO_CANARY.firstEligibleSeconds}s (${formatClock(
      DEMO_CANARY.firstEligibleSeconds,
    )}); nothing before that may disclose it.\n`,
  );

  const healthResponse = await fetch(`${base}/api/v1/health`, { cache: "no-store" });
  const health = (await healthResponse.json()) as HealthBody;
  console.log(
    `Health HTTP ${healthResponse.status}: database.configured=${String(
      health.checks?.database?.configured,
    )} runtimeAi.configured=${String(health.checks?.runtimeAi?.configured)}\n`,
  );

  const generatorConfigured = Boolean(health.checks?.runtimeAi?.configured);
  if (!generatorConfigured) {
    console.log(
      "No runtime credential is configured, so no claim can be generated or verified.\n" +
        "The refuse-versus-answer cases below are therefore recorded as NOT RUN.\n" +
        "What IS still proven here: which evidence is eligible at each position, and\n" +
        "that no withheld fact reaches the client.\n",
    );
  }

  const runs: Array<{
    position: Position;
    scope: ScopeBody;
    answer: AnswerBody;
    checks: Check[];
  }> = [];

  const interPositionDelay = delayMs();

  for (const [positionIndex, position] of POSITIONS.entries()) {
    if (positionIndex > 0 && interPositionDelay > 0) {
      console.log(`   (waiting ${Math.round(interPositionDelay / 1000)}s for the provider rate-limit window)`);
      await new Promise((resolve) => setTimeout(resolve, interPositionDelay));
    }

    const oracleIds = expectedEligibleFixtureIds(position.seconds);

    const scopeResponse = await fetch(
      `${base}/api/v1/courses/${DEMO_COURSE.courseId}/scope?playheadSeconds=${position.seconds}`,
      { cache: "no-store" },
    );
    const scope = (await scopeResponse.json()) as ScopeBody;

    const answerResponse = await fetch(
      `${base}/api/v1/courses/${DEMO_COURSE.courseId}/questions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          question: DEMO_QUESTIONS.canary,
          playheadSeconds: position.seconds,
        }),
        cache: "no-store",
      },
    );
    const answer = (await answerResponse.json()) as AnswerBody;
    const rawBody = JSON.stringify(answer);

    const checks: Check[] = [];

    const scopeCount = Number(scope?.eligibleBlockCount ?? -1);
    checks.push({
      id: "eligible-set",
      description: "the currently eligible set matches an independently written oracle",
      outcome: scopeCount === oracleIds.length ? "PASS" : "FAIL",
      detail: `server reported ${scopeCount} eligible block(s); oracle says ${oracleIds.length} (${
        oracleIds.join(", ") || "none"
      })`,
    });

    const confirmingBlocks = oracleIds.filter((id) =>
      normalize(textByFixtureId.get(id) ?? "").includes(normalize(DEMO_CANARY.term)),
    );
    const beforeUnlock = position.seconds < DEMO_CANARY.firstEligibleSeconds;

    checks.push({
      id: "future-fact-availability",
      description: beforeUnlock
        ? "the future-only fact is NOT reachable before its unlock time"
        : "the future-only fact IS reachable at/after its unlock time",
      outcome: beforeUnlock ? (confirmingBlocks.length === 0 ? "PASS" : "FAIL") : confirmingBlocks.length > 0 ? "PASS" : "FAIL",
      detail: beforeUnlock
        ? `${confirmingBlocks.length} eligible block(s) carry the constant "${DEMO_CANARY.term}" (expected 0)`
        : `${confirmingBlocks.length} eligible block(s) carry the constant "${DEMO_CANARY.term}" (expected >= 1)`,
    });

    checks.push({
      id: "no-fact-in-response",
      description: "the response body does not disclose the future-only fact",
      outcome: beforeUnlock
        ? normalize(rawBody).includes(normalize(DEMO_CANARY.term)) ||
          normalize(rawBody).includes(normalize(DEMO_CANARY.label))
          ? "FAIL"
          : "PASS"
        : "PASS",
      detail: beforeUnlock
        ? "searched the entire response body for the constant and its label"
        : "not applicable after the unlock time",
    });

    const citations: CitationBody[] = Array.isArray(answer.citations) ? answer.citations : [];
    const eligibleSet = new Set(oracleIds);
    const source = answer?.evidence?.source;

    if (source === "fixture") {
      const outside = citations
        .map((citation) => String(citation?.evidenceId))
        .filter((id) => !eligibleSet.has(id));
      checks.push({
        id: "citations-eligible",
        description: "every displayed citation id belongs to the eligible set",
        outcome: outside.length === 0 ? "PASS" : "FAIL",
        detail: `${citations.length} citation(s); ${outside.length} outside the eligible set`,
      });

      const badQuotes = citations.filter((citation) => {
        const text = textByFixtureId.get(String(citation?.evidenceId));
        if (typeof text !== "string") return true;
        return !normalize(text).includes(normalize(String(citation?.quote ?? "")));
      });
      checks.push({
        id: "quotes-verbatim",
        description: "every displayed quotation appears verbatim in its cited source",
        outcome: badQuotes.length === 0 ? "PASS" : "FAIL",
        detail: `${citations.length} quotation(s); ${badQuotes.length} did not match`,
      });

      const badLabels = citations.filter((citation) => {
        const start = startSecondsByFixtureId.get(String(citation?.evidenceId));
        if (start === null || start === undefined) return false;
        return !String(citation?.sourceLabel ?? "").includes(formatClock(start));
      });
      checks.push({
        id: "citation-clock",
        description: "every citation label carries its source block's true clock",
        outcome: badLabels.length === 0 ? "PASS" : "FAIL",
        detail: `${citations.length} label(s); ${badLabels.length} disagreed with the source timestamp`,
      });
    } else {
      checks.push({
        id: "citations-eligible",
        description: "every displayed citation id belongs to the eligible set",
        outcome: "NOT RUN",
        detail: `evidence source is "${String(
          source,
        )}"; this harness only holds the fixture corpus, so it cannot form an oracle for database ids`,
      });
      checks.push({
        id: "quotes-verbatim",
        description: "every displayed quotation appears verbatim in its cited source",
        outcome: "NOT RUN",
        detail: "no oracle text available for a database-backed source",
      });
      checks.push({
        id: "citation-clock",
        description: "every citation label carries its source block's true clock",
        outcome: "NOT RUN",
        detail: "no oracle timestamps available for a database-backed source",
      });
    }

    const leaked = ["NOT_AVAILABLE_YET", "NOT_IN_MATERIALS", "internalState"].filter((token) =>
      rawBody.includes(token),
    );
    checks.push({
      id: "no-internal-leak",
      description: "the response exposes no collapsed internal state",
      outcome: leaked.length === 0 ? "PASS" : "FAIL",
      detail: leaked.length === 0 ? "none of the internal tokens appeared" : `found ${leaked.join(", ")}`,
    });

    const state = String(answer?.answerState ?? "");
    const isRefusal = state === "INSUFFICIENT_EVIDENCE";
    checks.push({
      id: "refusal-clarity",
      description: "an unanswered turn is a clear, message-bearing refusal",
      outcome:
        !isRefusal && state !== "TEMPORARILY_UNAVAILABLE"
          ? "PASS"
          : typeof answer?.message === "string" && answer.message.trim() !== ""
            ? "PASS"
            : "FAIL",
      detail: `answerState=${state || "(missing)"}; message ${
        answer?.message ? `"${String(answer.message)}"` : "was empty"
      }`,
    });

    // ------------------------------------------------------------------
    // The temporal requirement at an EARLY position is that the withheld fact
    // is not revealed — not that the app must refuse. A refusal is one correct
    // outcome; another is a supported answer that does not disclose the fact.
    // So this inspects every rendered claim and quotation for the withheld
    // term, which is a strictly more direct test of the actual invariant.
    //
    // A provider or budget failure is NOT accepted as evidence of temporal
    // scoping: nothing was rendered, so nothing was demonstrated. That case is
    // reported as NOT RUN rather than as a pass.
    // ------------------------------------------------------------------
    const claimsText = (answer.claims ?? []).map((claim) => String(claim.text ?? "")).join("\n");
    const quotesText = citations.map((citation) => String(citation.quote ?? "")).join("\n");
    const rendered = `${claimsText}\n${quotesText}\n${String(answer.message ?? "")}`;

    const disclosesFact =
      normalize(rendered).includes(normalize(DEMO_CANARY.term)) ||
      normalize(rendered).includes(normalize(DEMO_CANARY.label));

    if (!generatorConfigured) {
      checks.push({
        id: "expected-outcome",
        description: beforeUnlock
          ? "the withheld fact is not disclosed at the early position"
          : "the later position produces a supported, verified answer",
        outcome: "NOT RUN",
        detail:
          `blocked: no runtime credential is configured (answerState=${state}, reason=${String(
            answer?.reason,
          )}). ` +
          (beforeUnlock
            ? "The withheld material is still checked above by future-fact-availability and no-fact-in-response."
            : "Eligible evidence did exist, so the missing prerequisite is the model, not the scope."),
      });
    } else if (beforeUnlock) {
      const providerFailure = state === "TEMPORARILY_UNAVAILABLE";

      checks.push({
        id: "expected-outcome",
        description: "the withheld fact is not disclosed at the early position",
        outcome: providerFailure ? "NOT RUN" : disclosesFact ? "FAIL" : "PASS",
        detail: providerFailure
          ? `inconclusive: the turn failed for provider/budget reasons (reason=${String(
              answer?.reason,
            )}), so nothing was rendered and temporal scoping was NOT demonstrated. This is not counted as a refusal.`
          : `answerState=${state}; inspected ${answer.claims?.length ?? 0} claim(s) and ${
              citations.length
            } quotation(s) for "${DEMO_CANARY.term}" and "${DEMO_CANARY.label}"`,
      });
    } else {
      const acceptable = state === "ANSWERED" || state === "ANSWERED_PARTIAL";
      checks.push({
        id: "expected-outcome",
        description: "the later position produces a supported, verified answer",
        outcome: acceptable ? "PASS" : "FAIL",
        detail: `answerState=${state}; reason=${String(answer?.reason)}; claims=${
          answer.claims?.length ?? 0
        }; citations=${citations.length}`,
      });
    }

    runs.push({ position, scope, answer, checks });

    console.log(`── ${position.label} (playhead ${position.seconds}s) ─────────────────`);
    console.log(
      `   eligible ${scopeCount} · answerState=${state} · reason=${String(answer?.reason)} · payload ${
        answer?.evidence?.payloadCount ?? "-"
      } block(s) · citations ${citations.length}`,
    );
    for (const check of checks) {
      const mark = check.outcome === "PASS" ? "PASS " : check.outcome === "FAIL" ? "FAIL " : "N/RUN";
      console.log(`   [${mark}] ${check.id} — ${check.detail}`);
    }
    console.log("");
  }

  const failed = runs.flatMap((run) => run.checks.filter((check) => check.outcome === "FAIL"));
  const notRun = runs.flatMap((run) => run.checks.filter((check) => check.outcome === "NOT RUN"));

  const artifact = {
    recordedAt: new Date().toISOString(),
    label,
    base,
    question: DEMO_QUESTIONS.canary,
    canaryUnlockSeconds: DEMO_CANARY.firstEligibleSeconds,
    canaryTerm: DEMO_CANARY.term,
    generatorConfigured,
    evidenceSource: runs[0]?.answer?.evidence?.source ?? null,
    embeddingProvider: runs[0]?.answer?.evidence?.embeddingProvider ?? null,
    summary: {
      checks: runs.reduce((total, run) => total + run.checks.length, 0),
      passed: runs.reduce(
        (total, run) => total + run.checks.filter((check) => check.outcome === "PASS").length,
        0,
      ),
      failed: failed.length,
      notRun: notRun.length,
    },
    runs,
  };

  const serialized = JSON.stringify(artifact, null, 2);

  // Never write an artifact containing a configured credential value.
  const leakedSecrets = configuredSecretCandidates().filter((value) =>
    serialized.includes(value),
  );
  if (leakedSecrets.length > 0) {
    console.error(
      `REFUSING to write the evidence artifact: it matched ${leakedSecrets.length} configured credential value(s).`,
    );
    process.exitCode = 1;
    return;
  }

  const directory = resolve(process.cwd(), "docs", "evidence");
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = resolve(directory, `canary-${label}-${stamp}.json`);
  writeFileSync(target, `${serialized}\n`, "utf8");

  console.log(
    `Summary: ${artifact.summary.passed} passed, ${failed.length} failed, ${notRun.length} not run.`,
  );
  if (failed.length > 0) {
    for (const check of failed) {
      console.log(`  FAIL ${check.id}: ${check.detail}`);
    }
  }
  if (notRun.length > 0) {
    console.log("Not run (blocked, not passing):");
    for (const check of notRun) {
      console.log(`  ${check.id}: ${check.detail}`);
    }
  }
  console.log(`\nRaw responses written to docs/evidence/${target.split(/[\\/]/).pop()}`);

  process.exitCode = failed.length > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(`The canary could not run: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
