/**
 * Minimal LIVE provider smoke test: exactly one embedding request and exactly
 * one generation request. Nothing else.
 *
 *   pnpm smoke
 *
 * SAFEGUARDS ARE PRECONDITIONS, NOT DECORATION. This script refuses to make any
 * call unless it can verify that:
 *   1. SDK retries are disabled (attempts === 1), so one logical call cannot
 *      silently become five billable requests;
 *   2. the daily token budget is positive, and the cumulative accounting that
 *      enforces it is wired in;
 *   3. an explicit embedding-request cap is configured, because the token
 *      budget does not meter embeddings.
 *
 * It prints no credential values and no raw provider payloads. Live calls.
 */
import { buildHttpOptions } from "@/lib/answer/gemini";
import { embeddingCallCount } from "@/lib/answer/capped-embedder";
import { loadEnvFile } from "./env-file";

const SMOKE_TEXT =
  "Exponential backoff multiplies each successive delay by a base factor.";

function refuse(lines: string[]): never {
  console.error("\nSMOKE REFUSED — no provider call was made.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exitCode = 1;
  throw new Error("smoke refused");
}

async function main(): Promise<void> {
  loadEnvFile();

  const { readServerEnv } = await import("@/lib/env");
  const { readRuntimeConfig, isRuntimeAiConfigured } = await import("@/lib/config");
  const { createRuntimeProviders } = await import("@/lib/answer/providers");

  const env = readServerEnv();
  const config = readRuntimeConfig(env);

  // ---- Safeguard 1: retries are off ---------------------------------------
  const attempts = buildHttpOptions(config).retryOptions.attempts;
  console.log(`Safeguard 1 — SDK retry attempts: ${attempts}`);

  // ---- Configuration summary (names and numbers only) ---------------------
  console.log(`Provider      : ${config.provider}`);
  console.log(`Text model    : ${config.model}`);
  console.log(`Embedding     : ${config.embeddingModel} (${config.embeddingDimensions}d)`);
  console.log(`Daily token budget    : ${config.dailyTokenBudget}`);
  console.log(`Embedding call cap    : ${config.maxEmbeddingCalls}`);

  if (!isRuntimeAiConfigured(config)) {
    refuse([
      "The runtime provider is not configured, so no live call is possible.",
      "Set HORIZON_LLM_PROVIDER=google-genai, HORIZON_LLM_MODEL and the credential.",
    ]);
  }

  const blockers: string[] = [];
  if (attempts !== 1) {
    blockers.push(
      `SDK retries are not disabled (attempts=${attempts}); one call could become ${attempts}.`,
    );
  }
  if (config.dailyTokenBudget <= 0) {
    blockers.push(
      "HORIZON_DAILY_TOKEN_BUDGET is 0, so the spend guard permits no provider call.",
    );
  }
  if (config.maxEmbeddingCalls <= 0) {
    blockers.push(
      "HORIZON_MAX_EMBEDDING_CALLS is 0, so embedding requests are unbounded. " +
        "The token budget does not meter embeddings, so this run would incur uncapped embedding usage.",
    );
  }
  if (blockers.length > 0) {
    refuse([...blockers, "", "No call was sent. Fix the above and re-run."]);
  }

  const providers = createRuntimeProviders(config);

  // ---- Safeguard 2: the cumulative ledger is wired in ---------------------
  const { resolveUsageLedger } = await import("@/lib/usage");
  const usage = resolveUsageLedger(env);
  const before = await usage.ledger.spentToday();
  console.log(`Safeguard 2 — usage ledger: ${usage.ledger.mode}, spent today: ${before}`);
  if (!Number.isFinite(before)) {
    refuse(["The usage ledger did not return a number, so spend cannot be accounted."]);
  }

  const budgetRemaining = config.dailyTokenBudget - before;
  if (budgetRemaining <= 0) {
    refuse([
      `The daily token budget is already exhausted (${before} of ${config.dailyTokenBudget}).`,
    ]);
  }

  // ---- Call 1 of 2: one real embedding request ---------------------------
  console.log(`\nEmbedding request 1/1 (cap ${config.maxEmbeddingCalls}) ...`);
  const embedStarted = Date.now();
  let vector: number[];
  try {
    const vectors = await providers.embedder.embed([SMOKE_TEXT], "query");
    vector = vectors[0] ?? [];
  } catch (error) {
    refuse([
      `The embedding request failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      "No further live call will be made.",
    ]);
  }
  const embedMs = Date.now() - embedStarted;

  if (vector.length !== config.embeddingDimensions) {
    refuse([
      `The embedding returned ${vector.length} values, not the configured ${config.embeddingDimensions}.`,
      "A dimension mismatch would break similarity search, so no further call was made.",
    ]);
  }
  const allFinite = vector.every((value) => Number.isFinite(value));
  if (!allFinite) {
    refuse(["The embedding contained non-finite values, so no further call was made."]);
  }

  console.log(
    `  OK  ${vector.length} dimensions, all finite, ${embedMs} ms, first value ${vector[0].toFixed(6)}`,
  );

  // ---- Call 2 of 2: one real structured generation request ---------------
  if (!providers.generator) {
    refuse(["No generator is available, so the generation smoke test cannot run."]);
  }

  console.log("\nGeneration request 1/1 (JSON structured output, temperature 0) ...");
  const generateStarted = Date.now();
  let claimCount: number;
  let unanswered: boolean;
  let usageReported: string;
  try {
    const outcome = await providers.generator.generate({
      question: "What happens to each successive delay in exponential backoff?",
      evidence: [{ id: "smoke_1", text: SMOKE_TEXT }],
    });
    claimCount = outcome.result.claims.length;
    unanswered = outcome.result.unansweredParts;
    usageReported = outcome.usage
      ? `prompt ${outcome.usage.promptTokens ?? "unknown"}, completion ${outcome.usage.completionTokens ?? "unknown"}`
      : "the provider reported no usage metadata";
  } catch (error) {
    refuse([
      `The generation request failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      "No further live call will be made.",
    ]);
  }
  const generateMs = Date.now() - generateStarted;

  console.log(`  OK  parsed ${claimCount} structured claim(s), unansweredParts=${unanswered}, ${generateMs} ms`);
  console.log(`  usage: ${usageReported}`);

  console.log("\nLive smoke test complete: 1 embedding request, 1 generation request.");
  console.log(`Embedding requests attempted by this process: ${embeddingCallCount()}`);
  console.log(
    "\nEmbedding requests are NOT covered by the token budget. The embedding cap bounds\n" +
      "call COUNT only — it is not a spending cap, and it resets when the process restarts.",
  );
}

main().catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
