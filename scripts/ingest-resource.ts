/**
 * Ingest a PDF or PPTX as a course resource.
 *
 *   pnpm ingest:resource --file .freebuff/materials/lesson-notes.pdf --mode reference
 *   pnpm ingest:resource --file deck.pptx --mode aligned --dry-run
 *   pnpm ingest:resource --file deck.pptx --mode reference --acknowledge "why this is safe"
 *
 * TWO MODES
 *   reference  COURSE_WIDE, human-approved: the material is permitted at every
 *              playhead. The lint refuses anything containing a registered
 *              late-only fact, or aligning to the last fifth of the recording,
 *              unless the operator records why they accept the risk.
 *   aligned    TIMELINE_BOUND: each chunk unlocks when the instructor covers it.
 *              An uncertain alignment is written PENDING and is therefore
 *              ineligible until a human approves it (see scripts/review-alignments.ts).
 *
 * COST
 *   One embedding admission per batch against the same durable daily cap the
 *   serving path uses. No generation call is made, so no generation tokens are
 *   spent and the token budget is untouched.
 *
 * Secrets never reach stdout. Only names, counts and model names are printed.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
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

const EMBED_BATCH_SIZE = 25;

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
  loadEnvFile();

  const fileArg = argValue("file");
  if (!fileArg) {
    fail([
      "Missing --file <path to a .pdf or .pptx>.",
      "",
      "  pnpm ingest:resource --file .freebuff/materials/lesson-notes.pdf --mode reference",
      "  pnpm ingest:resource --file .freebuff/materials/lesson-slides.pptx --mode aligned",
    ]);
  }
  const filePath = resolve(process.cwd(), fileArg);
  if (!existsSync(filePath)) {
    fail([`No file at ${filePath}.`]);
  }

  const mode = (argValue("mode") ?? "aligned").toLowerCase();
  if (mode !== "reference" && mode !== "aligned") {
    fail([`--mode must be "reference" or "aligned" (got "${mode}").`]);
  }
  const acknowledge = argValue("acknowledge");

  const bytes = readFileSync(filePath);
  const fileHash = createHash("sha256").update(bytes).digest("hex");

  const {
    parseDocument,
    chunkPages,
    DocumentRefused,
    DOCUMENT_MAX_BYTES,
  } = await import("@/lib/ingest/document");
  const {
    buildDocumentPlan,
    ALIGNMENT_MIN_SCORE,
    ALIGNMENT_MIN_MARGIN,
    LATE_ALIGNMENT_FRACTION,
  } = await import("@/lib/ingest/document-plan");
  const { LESSON_VIDEO } = await import("@/lib/lesson/video");
  const { lessonTranscriptCourseId } = await import("@/lib/ingest/lesson-transcript");

  if (bytes.length > DOCUMENT_MAX_BYTES) {
    fail([
      `The file is ${(bytes.length / (1024 * 1024)).toFixed(1)} MiB; the limit is ${DOCUMENT_MAX_BYTES / (1024 * 1024)} MiB.`,
    ]);
  }

  console.log(`File       : ${filePath.replace(process.cwd(), ".")}`);
  console.log(`Bytes      : ${bytes.length}`);
  console.log(`Sha256     : ${fileHash.slice(0, 16)}…`);
  console.log(`Mode       : ${mode}`);

  let parsed;
  try {
    parsed = await parseDocument(new Uint8Array(bytes), filePath);
  } catch (error) {
    fail([
      error instanceof DocumentRefused
        ? error.message
        : `The document could not be parsed (${error instanceof Error ? error.name : "unknown error"}).`,
      "Nothing was written and no embedding request was made.",
    ]);
  }

  const chunks = chunkPages(parsed.pages);
  const textPages = parsed.pages.length - parsed.visualOnlyPages.length;
  console.log(
    `Parsed     : ${parsed.kind.toUpperCase()}, ${parsed.pages.length} page/slide(s), ${textPages} with text`,
  );
  console.log(`Coverage   : ${(parsed.coverage * 100).toFixed(1)}% of pages produced text`);
  if (parsed.visualOnlyPages.length > 0) {
    console.log(
      `Visual-only: ${parsed.visualOnlyPages.length} page/slide(s) with too little text to index ` +
        `(${parsed.visualOnlyPages.slice(0, 12).join(", ")}${parsed.visualOnlyPages.length > 12 ? ", …" : ""}) — NOT indexed, and NOT counted as extracted`,
    );
  }
  console.log(`Chunks     : ${chunks.length} (max 900 chars each, one page per chunk)`);

  if (chunks.length === 0) {
    fail([
      "The document produced no text. A scanned or image-only file needs OCR, which this build does not have.",
    ]);
  }

  // The transcript is needed in aligned mode, and useful as a lint signal in
  // reference mode, so it is loaded in both — read-only.
  const env = await import("@/lib/env").then((module) => module.readServerEnv());
  const db = presentNames(REQUIRED_DB_NAMES);
  if (db.missing.length > 0) {
    fail([`not set: ${db.missing.join(", ")}`]);
  }
  const { createServiceRoleClient, isDatabaseConfigured } = await import("@/lib/db/server");
  if (!isDatabaseConfigured(env)) fail(["The database is not configured."]);
  const client = createServiceRoleClient(env);
  if (!client) fail(["A Supabase service-role client could not be created."]);

  const courseId = argValue("course") ?? lessonTranscriptCourseId();
  const { data: transcriptRows, error: transcriptError } = await client
    .from("blocks")
    .select("id, text_normalized, end_seconds, ordinal")
    .eq("course_id", courseId)
    .eq("block_type", "transcript")
    .order("ordinal", { ascending: true });

  if (transcriptError) {
    fail([`The course's transcript could not be read: ${transcriptError.message}`]);
  }
  const transcript = ((transcriptRows ?? []) as Array<Record<string, unknown>>).map((row) => ({
    text: String(row.text_normalized ?? ""),
    endSeconds: Number(row.end_seconds ?? 0),
  }));
  console.log(`Transcript : ${transcript.length} stored block(s) for course ${courseId}`);

  if (mode === "aligned" && transcript.length === 0) {
    fail([
      `Course ${courseId} has no transcript blocks to align against.`,
      "Ingest the recording first (pnpm ingest:lesson), or pass --course for a course that has one.",
    ]);
  }

  if (dryRun) {
    const { alignChunk } = await import("@/lib/ingest/document-plan");
    let confident = 0;
    let pending = 0;
    for (const chunk of chunks) {
      const alignment = mode === "aligned" ? alignChunk(chunk.text, transcript) : null;
      if (mode === "aligned") {
        if (
          alignment &&
          alignment.score >= ALIGNMENT_MIN_SCORE &&
          alignment.margin >= ALIGNMENT_MIN_MARGIN
        ) {
          confident += 1;
        } else {
          pending += 1;
        }
      }
    }
    console.log(
      mode === "aligned"
        ? `\n--dry-run: ${confident} chunk(s) would auto-approve, ${pending} would be PENDING review.`
        : "\n--dry-run: reference mode, so every chunk would be COURSE_WIDE and human-approved.",
    );
    console.log("No embedding request was made and nothing was written.");
    return;
  }

  const embeddingKey = presentNames(EMBEDDING_KEY_NAMES);
  if (embeddingKey.set.length === 0) {
    fail([
      `no embedding credential — set HORIZON_EMBEDDING_API_KEY (one of ${EMBEDDING_KEY_NAMES.join(" / ")} is accepted)`,
      "Rows must not be written with placeholder vectors.",
    ]);
  }

  const { createServerContext } = await import("@/lib/server/context");
  const { createSupabaseSeedGateway, SeedRefused } = await import("@/lib/ingest/seed");
  const { utcDayKey } = await import("@/lib/usage/types");

  const { config, providers, usageResolution } = createServerContext();
  const ledger = usageResolution.ledger;
  console.log(`\nEmbedder   : ${providers.embeddingProviderId} at ${config.embeddingDimensions} dimensions`);
  console.log(`Ledger     : ${ledger.mode} (UTC day ${utcDayKey()})`);

  if (!providers.embeddingConfigured) {
    fail(["No real embedding model is available.", providers.embedderDetail]);
  }

  let requestsBefore: number | null = null;
  try {
    requestsBefore = await ledger.embeddingRequestsToday();
  } catch {
    requestsBefore = null;
  }
  console.log(
    `Before     : ${requestsBefore ?? "unknown"} embedding request(s) today of cap ${config.maxEmbeddingCalls}`,
  );

  const batches: Array<typeof chunks> = [];
  for (let index = 0; index < chunks.length; index += EMBED_BATCH_SIZE) {
    batches.push(chunks.slice(index, index + EMBED_BATCH_SIZE));
  }
  console.log(`Plan       : ${batches.length} embedding request(s) of up to ${EMBED_BATCH_SIZE} chunks`);

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
        "Nothing further was written. Requests already admitted are counted against the day's cap.",
      ]);
    }
    const batchVectors = await providers.embedder.embed(
      batch.map((chunk) => chunk.text),
      "document",
    );
    console.log(
      `  batch ${batchIndex + 1}/${batches.length}: ${batchVectors.length} vector(s) at ${batchVectors[0]?.length ?? 0} dimensions`,
    );
    vectors.push(...batchVectors);
  }

  const title =
    argValue("title") ??
    filePath
      .split(/[\\/]/)
      .pop()!
      .replace(/\.(pdf|pptx)$/i, "");

  let built;
  try {
    built = buildDocumentPlan({
      courseId,
      storageKey: argValue("storage-key") ?? filePath.replace(process.cwd(), ".").replace(/\\/g, "/"),
      title,
      parsed,
      chunks,
      vectors,
      embeddingModel: config.embeddingModel,
      embeddingDimensions: config.embeddingDimensions,
      fileHash,
      mode,
      transcript,
      recordingDurationSeconds:
        transcript.length > 0 ? Math.max(...transcript.map((item) => item.endSeconds)) : 0,
      acknowledgeLint: acknowledge,
    });
  } catch (error) {
    fail([
      error instanceof DocumentRefused ? error.message : "The plan could not be built.",
    ]);
  }

  const gateway = createSupabaseSeedGateway(client);
  try {
    const resourceRows = await gateway.upsert("resources", built.resources);
    const blockRows = await gateway.upsert("blocks", built.blocks);
    console.log(`\nIngested   : ${resourceRows} resource row, ${blockRows} block row(s)`);
  } catch (error) {
    if (error instanceof SeedRefused) fail([error.message]);
    fail(["The rows could not be written."]);
  }

  // ---- Read back from the database --------------------------------------
  const { data: readRows, error: readError } = await client
    .from("blocks")
    .select(
      "id, policy, review_state, lint_status, ingest_status, page_number, slide_number, unlock_seconds, embedding_dim, embedding, alignment_confidence, alignment_margin",
    )
    .eq("course_id", courseId)
    .eq("resource_id", built.resources[0].id as string);

  if (readError) fail([`The written rows could not be read back: ${readError.message}`]);
  const rows = (readRows ?? []) as Array<Record<string, unknown>>;
  const dims = new Set(rows.map((row) => Number(row.embedding_dim)));
  const unlocks = rows
    .map((row) => Number(row.unlock_seconds))
    .filter((value) => Number.isFinite(value));

  console.log("\nRead back from the database:");
  console.log(`  blocks                : ${rows.length}`);
  console.log(`  policy / review       : ${[...new Set(rows.map((row) => `${row.policy}/${row.review_state}`))].join(", ")}`);
  console.log(`  lint status           : ${[...new Set(rows.map((row) => String(row.lint_status)))].join(", ")}`);
  console.log(`  embedding dimensions  : ${[...dims].join(", ")}`);
  console.log(`  rows with null vector : ${rows.filter((row) => row.embedding == null).length}`);
  console.log(
    `  unlock range          : ${unlocks.length === 0 ? "none (course-wide)" : `${Math.min(...unlocks).toFixed(0)}s–${Math.max(...unlocks).toFixed(0)}s`}`,
  );
  console.log(
    `  pages / slides        : ${[...new Set(rows.map((row) => row.page_number ?? row.slide_number))].filter((value) => value !== null).length} distinct`,
  );

  try {
    const requestsAfter = await ledger.embeddingRequestsToday();
    console.log(
      `\nAfter      : ${requestsAfter} embedding request(s) today of cap ${config.maxEmbeddingCalls} ` +
        `(delta ${requestsBefore === null ? "unknown" : requestsAfter - requestsBefore})`,
    );
  } catch {
    console.log("\nAfter      : unknown (the ledger could not be re-read)");
  }

  console.log(
    `\nSummary    : ${built.summary.blocks} block(s); ${built.summary.referenceBlocks} COURSE_WIDE; ` +
      `${built.summary.autoApproved} auto-approved; ${built.summary.pending} PENDING review; ` +
      `${built.summary.flagged} flagged; ${built.summary.acknowledged} acknowledged`,
  );
  if (built.summary.pending > 0) {
    console.log(
      "             PENDING blocks are ineligible and cannot be cited until reviewed:\n" +
        "             pnpm review:alignments --list",
    );
  }
  if (built.summary.markerHits.length > 0) {
    console.log(`             Lint markers present: ${built.summary.markerHits.join(", ")}`);
  }
  console.log(
    `             Late-alignment threshold: last ${Math.round((1 - LATE_ALIGNMENT_FRACTION) * 100)}% of the recording`,
  );
  console.log(`             Recording duration used: ${LESSON_VIDEO.durationSeconds.toFixed(1)}s`);
}

main().catch(() => {
  if (!process.exitCode) process.exitCode = 1;
});
