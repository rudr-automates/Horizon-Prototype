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
import { estimatePromptTokens } from "@/lib/usage/types";
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
  //
  // Claimed against the SAME durable cap the serving path uses. Letting a
  // diagnostic command sit outside the limit would make the limit a convention
  // rather than a control.
  const embeddingAdmission = await usage.ledger.admitEmbedding({
    maxCalls: config.maxEmbeddingCalls,
    provider: providers.embeddingProviderId,
    modelId: config.model,
  });
  console.log(
    `Embedding admission (${usage.ledger.mode} cap): ${embeddingAdmission.admitted ? "granted" : "refused"} — ${embeddingAdmission.detail}`,
  );
  if (!embeddingAdmission.admitted) {
    refuse([embeddingAdmission.detail, "No provider call was made."]);
  }

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
  const generator = providers.generator;
  if (!generator) {
    refuse(["No generator is available, so the generation smoke test cannot run."]);
  }

  console.log("\nGeneration request 1/1 (JSON structured output, temperature 0) ...");

  // Capacity is reserved ATOMICALLY before the request is sent, so this run
  // cannot overshoot a budget another instance is also spending.
  const question = "What happens to each successive delay in exponential backoff?";
  const admission = await usage.ledger.admitGeneration({
    reserveTokens:
      estimatePromptTokens(`${question}\n${SMOKE_TEXT}`) + config.maxOutputTokens,
    budgetTokens: config.dailyTokenBudget,
    provider: generator.providerId,
    modelId: config.model,
    operation: "generate",
  });
  console.log(`  admission: ${admission.admitted ? "granted" : "refused"} — ${admission.detail}`);
  if (!admission.admitted) {
    refuse([admission.detail, "No generation request was sent."]);
  }

  const generateStarted = Date.now();
  let claimCount: number;
  let unanswered: boolean;
  let usageReported: string;
  let settlement: string;
  try {
    const outcome = await generator.generate({
      question,
      evidence: [{ id: "smoke_1", text: SMOKE_TEXT }],
    });
    claimCount = outcome.result.claims.length;
    unanswered = outcome.result.unansweredParts;
    usageReported = outcome.usage
      ? `prompt ${outcome.usage.promptTokens ?? "unknown"}, completion ${outcome.usage.completionTokens ?? "unknown"}`
      : "the provider reported no usage metadata";

    const settled = await usage.ledger.settle(admission.reservation, {
      promptTokens: outcome.usage?.promptTokens ?? null,
      completionTokens: outcome.usage?.completionTokens ?? null,
      reasoningTokens: outcome.usage?.thoughtsTokens ?? null,
    });
    settlement = `${settled.outcome} — charged ${settled.chargedTokens}, reported ${settled.reportedTokens}`;
  } catch (error) {
    const { ProviderFailure } = await import("@/lib/answer/provider");
    const reported = error instanceof ProviderFailure ? error.usage : null;
    // A failed call may still have been billed: settle it rather than letting
    // the reservation be treated as unspent. A 429 is the exception — the
    // provider refused the request before processing it, so nothing was billed.
    const settled = await usage.ledger
      .settle(
        admission.reservation,
        {
          promptTokens: reported?.promptTokens ?? null,
          completionTokens: reported?.completionTokens ?? null,
          reasoningTokens: reported?.thoughtsTokens ?? null,
        },
        { failed: true, notBillable: error instanceof ProviderFailure && error.kind === "rate_limited" },
      )
      .catch(() => null);

    refuse([
      `The generation request failed: ${error instanceof Error ? error.message : "unknown error"}.`,
      settled
        ? `The reservation was settled as ${settled.outcome}, charged ${settled.chargedTokens} token(s).`
        : "The reservation could not be settled and remains charged against today.",
      "No further live call will be made.",
    ]);
  }
  const generateMs = Date.now() - generateStarted;

  console.log(`  OK  parsed ${claimCount} structured claim(s), unansweredParts=${unanswered}, ${generateMs} ms`);
  console.log(`  usage: ${usageReported}`);
  console.log(`  settlement: ${settlement}`);

  console.log("\nLive smoke test complete: 1 embedding request, 1 generation request.");
  console.log(`Embedding requests attempted by this process: ${embeddingCallCount()}`);
  console.log(`Spent today after settlement: ${await usage.ledger.spentToday()} tokens`);
  console.log(
    "\nEmbedding requests are NOT covered by the token budget. The embedding cap bounds\n" +
      "call COUNT only — it is not a spending cap, and in memory mode it is per process.",
  );
}

main().catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
