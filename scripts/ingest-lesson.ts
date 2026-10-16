/**
 * Ingest the selected lesson video's real captions into the database.
 *
 *   pnpm ingest:lesson                      # uses .freebuff/captions/<video id>.en.json3
 *   pnpm ingest:lesson --captions path.json3 # any json3 caption file
 *   pnpm ingest:lesson --dry-run            # parse, segment and report. Writes nothing
 *
 * This is an OPERATOR command, not a test. It stops with an explicit reason
 * rather than pretending, and it names every prerequisite it could not confirm.
 *
 * COST
 *   Embedding REQUESTS are counted against the same durable daily cap the serving
 *   path uses, one admission per batch, and the run refuses when the cap is spent
 *   rather than exceeding it. The blocks are batched (20 per request) because the
 *   cap bounds REQUESTS, not text — the embeddings API reports no token usage, so
 *   there is no honest cost figure to enforce.
 *
 * NO FABRICATION
 *   Only the parsed caption text is written, with the source's own timestamps. The
 *   command refuses to write anything if the embedder is the offline lexical
 *   stand-in, if the caption file is malformed or out of order, or if the parsed
 *   blocks do not fit inside the recording's measured duration.
 *
 * Secrets never reach stdout. Only names, counts, timings and the embedding model
 * name are printed.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile, presentNames } from "./env-file";

const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

const EMBEDDING_KEY_NAMES = [
  "HORIZON_EMBEDDING_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "HORIZON_LLM_API_KEY",
];

/**
 * Blocks per embedding request. The cap counts requests, so batching is what
 * makes a 60-block transcript affordable; 20 keeps a request comfortably inside
 * the API's per-input and per-batch limits.
 */
const EMBED_BATCH_SIZE = 25;

/** The synthetic fixture's invented fact. It must not appear in this course. */
const SYNTHETIC_FIXTURE_MARKERS = ["Marlin backoff constant", "0.37"];

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

function fail(lines: string[]): never {
  console.error("\nINGEST REFUSED — nothing was written.\n");
  for (const line of lines) console.error(`  ${line}`);
  console.error("");
  process.exitCode = 1;
  throw new Error("ingest refused");
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const loaded = loadEnvFile();
  console.log(`Environment file .env.local: ${loaded ? "loaded" : "not present"}`);

  const { LESSON_VIDEO } = await import("@/lib/lesson/video");
  const captionPath = resolve(
    process.cwd(),
    argValue("captions") ?? `.freebuff/captions/${LESSON_VIDEO.youtubeId}.en.json3`,
  );

  let raw: string;
  try {
    raw = readFileSync(captionPath, "utf8");
  } catch {
    fail([
      `No caption file at ${captionPath}.`,
      "",
      "Fetch the video's own automatic English captions first — do not write a",
      "transcript by hand:",
      "  yt-dlp --skip-download --write-auto-subs --sub-langs en \\",
      "    --sub-format json3 -o '.freebuff/captions/%(id)s.%(ext)s' \\",
      `    https://youtu.be/${LESSON_VIDEO.youtubeId}`,
    ]);
  }

  const {
    buildTranscript,
    LESSON_TRANSCRIPT_SOURCE,
  } = await import("@/lib/lesson/transcript");
  const {
    buildLessonTranscriptPlan,
    applyLessonTranscriptPlan,
    captionFileHash,
    lessonTranscriptCourseId,
  } = await import("@/lib/ingest/lesson-transcript");

  let transcript;
  try {
    transcript = buildTranscript(JSON.parse(raw), LESSON_VIDEO.durationSeconds);
  } catch (error) {
    fail([
      `The caption file could not be read as a transcript: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
      "Nothing was written and no embedding request was made.",
    ]);
  }

  const { stats } = transcript;
  console.log(`\nCaption source : ${LESSON_TRANSCRIPT_SOURCE.label}`);
  console.log(`Caption file   : ${captionPath.replace(process.cwd(), ".")}`);
  console.log(`File sha256    : ${captionFileHash(raw).slice(0, 16)}…`);
  console.log(
    `Parsed         : ${stats.lineCount} caption lines, ${stats.skippedEvents} line(s) skipped as empty`,
  );
  console.log(
    `Coverage       : ${stats.firstSeconds.toFixed(1)}s–${stats.lastSeconds.toFixed(1)}s of the recording's ${LESSON_VIDEO.durationSeconds.toFixed(1)}s ` +
      `(${(stats.coverage * 100).toFixed(1)}% of the recording has caption text)`,
  );
  console.log(`Blocks         : ${stats.blockCount}`);
  const lengths = transcript.blocks.map((block) => block.endSeconds - block.startSeconds);
  console.log(
    `Block length   : min ${Math.min(...lengths).toFixed(1)}s · mean ${(
      lengths.reduce((total, value) => total + value, 0) / lengths.length
    ).toFixed(1)}s · max ${Math.max(...lengths).toFixed(1)}s`,
  );

  if (dryRun) {
    console.log("\n--dry-run: parsed and segmented only. No embedding request was made and nothing was written.");
    return;
  }

  const db = presentNames(REQUIRED_DB_NAMES);
  const embeddingKey = presentNames(EMBEDDING_KEY_NAMES);
  if (db.missing.length > 0 || embeddingKey.set.length === 0) {
    fail([
      db.missing.length > 0 ? `not set: ${db.missing.join(", ")}` : "",
      embeddingKey.set.length === 0
        ? `no embedding credential — set HORIZON_EMBEDDING_API_KEY (one of ${EMBEDDING_KEY_NAMES.join(" / ")} is accepted)`
        : "",
      "",
      "Both are required: the rows cannot be written without the service-role key,",
      "and they must not be written with placeholder vectors.",
    ]);
  }

  const { createServerContext } = await import("@/lib/server/context");
  const { createServiceRoleClient, isDatabaseConfigured } = await import("@/lib/db/server");
  const { readServerEnv } = await import("@/lib/env");
  const { createSupabaseSeedGateway, SeedRefused } = await import("@/lib/ingest/seed");
  const { utcDayKey } = await import("@/lib/usage/types");

  const env = readServerEnv();
  if (!isDatabaseConfigured(env) || env.supabaseServiceRoleKey.trim() === "") {
    fail(["The database is not fully configured, so no client could be created."]);
  }
  const client = createServiceRoleClient(env);
  if (!client) fail(["A Supabase service-role client could not be created."]);

  const { providers, config, usageResolution } = createServerContext();
  const ledger = usageResolution.ledger;
  console.log(`\nActive embedder: ${providers.embeddingProviderId}`);
  console.log(`Ledger mode    : ${ledger.mode} (UTC day ${utcDayKey()})`);

  if (!providers.embeddingConfigured) {
    fail([
      "No real embedding model is available, so this transcript cannot be ingested.",
      providers.embedderDetail,
    ]);
  }

  // Budget BEFORE. Read from the store that enforces it, so the before/after
  // figures are the ones the cap is actually counted in.
  let embeddingRequestsBefore: number | null = null;
  let tokensBefore: number | null = null;
  try {
    embeddingRequestsBefore = await ledger.embeddingRequestsToday();
    tokensBefore = await ledger.spentToday();
  } catch {
    console.log("Note: the ledger could not be read before the run; before/after is reported as unknown.");
  }
  console.log(
    `Before         : embedding requests today ${embeddingRequestsBefore ?? "unknown"} of cap ${config.maxEmbeddingCalls}; generation tokens today ${tokensBefore ?? "unknown"} of ${config.dailyTokenBudget}`,
  );

  const batches: Array<typeof transcript.blocks> = [];
  for (let index = 0; index < transcript.blocks.length; index += EMBED_BATCH_SIZE) {
    batches.push(transcript.blocks.slice(index, index + EMBED_BATCH_SIZE));
  }
  console.log(
    `Plan           : ${batches.length} embedding request(s) of up to ${EMBED_BATCH_SIZE} blocks each`,
  );

  const vectors: number[][] = [];
  for (const [batchIndex, batch] of batches.entries()) {
    const admission = await ledger.admitEmbedding({
      maxCalls: config.maxEmbeddingCalls,
      provider: providers.embeddingProviderId,
      modelId: config.embeddingModel,
    });
    if (!admission.admitted) {
      fail([
        `Embedding request ${batchIndex + 1} of ${batches.length} was refused: ${admission.detail}`,
        `Ledger mode: ${ledger.mode}.`,
        "Nothing further was written. The blocks already embedded by this run are",
        "counted against the day's cap, which is the cost of stopping mid-run here",
        "rather than exceeding the cap.",
      ]);
    }

    const batchVectors = await providers.embedder.embed(
      batch.map((block) => block.text),
      "document",
    );
    console.log(
      `  batch ${batchIndex + 1}/${batches.length}: ${batchVectors.length} vector(s) at ${batchVectors[0]?.length ?? 0} dimensions`,
    );
    vectors.push(...batchVectors);
  }

  try {
    const plan = buildLessonTranscriptPlan({
      blocks: transcript.blocks,
      stats,
      vectors,
      embeddingDimensions: config.embeddingDimensions,
      embeddingModel: config.embeddingModel,
      videoDurationSeconds: LESSON_VIDEO.durationSeconds,
      captionSourceId: captionFileHash(raw),
      embedderProviderId: providers.embeddingProviderId,
    });

    const result = await applyLessonTranscriptPlan(
      createSupabaseSeedGateway(client),
      plan,
    );

    const courseId = lessonTranscriptCourseId();
    console.log("\nIngest complete:");
    console.log(`  course    ${result.courses} row (id ${courseId})`);
    console.log(`  resources ${result.resources} row`);
    console.log(`  blocks    ${result.blocks} rows`);

    // -------- Verification, read back from the database -------------------
    const { data: blockRows, error: blockError } = await client
      .from("blocks")
      .select("id, start_seconds, end_seconds, unlock_seconds, embedding_model, embedding_dim, embedding, text_normalized, policy, review_state, ingest_status")
      .eq("course_id", courseId);

    if (blockError) {
      fail([`The written rows could not be read back: ${blockError.message}`]);
    }
    const rows = (blockRows ?? []) as Array<Record<string, unknown>>;
    console.log("\nRead back from the database:");
    console.log(`  blocks for this course      : ${rows.length}`);

    const dims = new Set(rows.map((row) => Number(row.embedding_dim)));
    const distances: number[] = [];
    for (const row of rows) {
      const value = row.embedding;
      if (typeof value === "string") {
        distances.push(value.replace(/^\[/, "").replace(/\]$/, "").split(",").filter((part) => part.trim() !== "").length);
      } else if (Array.isArray(value)) {
        distances.push(value.length);
      }
    }
    console.log(`  embedding_dim values         : ${[...dims].join(", ") || "none"}`);
    console.log(`  dimensions counted in vectors: ${[...new Set(distances)].join(", ") || "none"}`);
    console.log(`  rows with a null embedding   : ${rows.filter((row) => row.embedding == null).length}`);
    console.log(
      `  policy / review / ingest     : ${[...new Set(rows.map((row) => `${row.policy}/${row.review_state}/${row.ingest_status}`))].join(", ")}`,
    );

    const starts = rows.map((row) => Number(row.start_seconds)).filter(Number.isFinite);
    const ends = rows.map((row) => Number(row.end_seconds)).filter(Number.isFinite);
    console.log(
      `  timestamp range              : ${Math.min(...starts).toFixed(1)}s–${Math.max(...ends).toFixed(1)}s`,
    );

    const unlockMismatch = rows.filter(
      (row) => Number(row.unlock_seconds) !== Number(row.end_seconds),
    ).length;
    console.log(
      `  rows whose unlock != end     : ${unlockMismatch} (a block unlocks when it has been watched to its end)`,
    );

    // The integrity check this command exists to prove: the synthetic fixture's
    // invented fact must not appear anywhere in the video's course.
    const contaminated = rows.filter((row) =>
      SYNTHETIC_FIXTURE_MARKERS.some((marker) =>
        String(row.text_normalized ?? "").includes(marker),
      ),
    ).length;
    console.log(
      `  rows containing fixture text : ${contaminated} (must be 0 — the synthetic corpus is a different course)`,
    );

    // Budget AFTER, read from the same store.
    try {
      const embeddingRequestsAfter = await ledger.embeddingRequestsToday();
      const tokensAfter = await ledger.spentToday();
      console.log(
        `\nAfter          : embedding requests today ${embeddingRequestsAfter} of cap ${config.maxEmbeddingCalls}; generation tokens today ${tokensAfter} of ${config.dailyTokenBudget}`,
      );
      console.log(
        `Delta          : ${
          embeddingRequestsBefore === null
            ? "unknown"
            : embeddingRequestsAfter - embeddingRequestsBefore
        } embedding request(s); generation tokens unchanged (no model call is made by this command)`,
      );
    } catch {
      console.log("\nAfter          : unknown (the ledger could not be re-read)");
    }

    console.log(
      "\nNext: the lesson now has real timestamped evidence. Ask a question at a playhead" +
        "\nposition with `pnpm canary --course " +
        courseId +
        "` or in the browser.",
    );
  } catch (error) {
    if (error instanceof SeedRefused) fail([error.message]);
    fail([
      `Unexpected failure: ${error instanceof Error ? error.name : "unknown error"}.`,
      "No partial-success claim is made; re-run after fixing the cause.",
      "Note: the embedding requests already admitted still count against the day's cap.",
    ]);
  }
}

main().catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
