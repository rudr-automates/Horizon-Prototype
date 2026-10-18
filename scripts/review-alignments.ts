/**
 * Instructor review for document blocks whose alignment was not confident.
 *
 *   pnpm review:alignments --list
 *   pnpm review:alignments --list --course <id>
 *   pnpm review:alignments --approve <blockId> --unlock 12:30
 *   pnpm review:alignments --reject <blockId> --reason "this slide is reference material, not lesson content"
 *
 * WHY THIS EXISTS
 *   A TIMELINE_BOUND block is evidence only when its review state is
 *   AUTO_APPROVED or HUMAN_APPROVED. The ingest writes PENDING and a null unlock
 *   when the lexical alignment is weak or ambiguous, so an uncertain guess can
 *   never become evidence by itself. This command is the human step: it names the
 *   block's text, its page or slide, and the score it failed on, then requires an
 *   explicit unlock time before approval.
 *
 * AUDIT TRAIL, HONESTLY SCOPED
 *   This schema has no alignment_events table (see 0001_init.sql: it is listed as
 *   deferred), so there is nowhere durable to store a reviewer name, a rejection
 *   reason or a timestamp beyond the row itself. What IS recorded: the new review
 *   state, the unlock time, and — for a rejection — the reason appended to
 *   `blocks.alignment_method` with a `rejected:` prefix. `updated_at` moves on the
 *   row's own trigger. Nothing here claims an approval history it cannot keep.
 */
import { loadEnvFile, presentNames } from "./env-file";

const REQUIRED_DB_NAMES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
];

function argValue(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

/** Accepts `1234`, `1234.5`, `20:34` or `1:02:03`. */
export function parseUnlockSeconds(raw: string): number | null {
  const value = raw.trim();
  if (/^\d+(\.\d+)?$/.test(value)) {
    const seconds = Number(value);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
  }
  const parts = value.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => /^\d+$/.test(part))) return null;
  const numbers = parts.map(Number);
  const seconds =
    numbers.length === 3
      ? numbers[0] * 3600 + numbers[1] * 60 + numbers[2]
      : numbers[0] * 60 + numbers[1];
  return Number.isFinite(seconds) ? seconds : null;
}

function clock(totalSeconds: number | null): string {
  if (totalSeconds === null) return "—";
  const safe = Math.max(0, Math.floor(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

async function main(): Promise<void> {
  loadEnvFile();
  const db = presentNames(REQUIRED_DB_NAMES);
  if (db.missing.length > 0) {
    console.error(`Not set: ${db.missing.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const { readServerEnv } = await import("@/lib/env");
  const { createServiceRoleClient } = await import("@/lib/db/server");
  const client = createServiceRoleClient(readServerEnv());
  if (!client) {
    console.error("A Supabase service-role client could not be created.");
    process.exitCode = 1;
    return;
  }

  const approveId = argValue("approve");
  const rejectId = argValue("reject");
  const reason = argValue("reason");

  if (approveId || rejectId) {
    const blockId = (approveId ?? rejectId) as string;
    const { data, error } = await client
      .from("blocks")
      .select("id, course_id, block_type, review_state, unlock_seconds, alignment_method, page_number, slide_number, text_normalized")
      .eq("id", blockId)
      .maybeSingle();

    if (error) {
      console.error(`The block could not be read: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    if (!data) {
      console.error(`No block with id ${blockId}.`);
      process.exitCode = 1;
      return;
    }
    const row = data as Record<string, unknown>;

    if (rejectId) {
      if (!reason) {
        console.error(
          "A rejection needs --reason, which is appended to the block's alignment_method (this schema has no audit table).",
        );
        process.exitCode = 1;
        return;
      }
      const note = `rejected: ${reason.slice(0, 200)}`;
      const method = row.alignment_method ? `${row.alignment_method}; ${note}` : note;
      const { error: updateError } = await client
        .from("blocks")
        .update({ review_state: "REJECTED", unlock_seconds: null, alignment_method: method })
        .eq("id", blockId);
      if (updateError) {
        console.error(`The rejection could not be written: ${updateError.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`Rejected ${blockId}. It is no longer eligible and cannot be cited.`);
      return;
    }

    const rawUnlock = argValue("unlock");
    if (!rawUnlock) {
      console.error(
        "An approval needs --unlock <mm:ss|seconds>: without it the block would be approved and still ineligible, which is a no-op dressed as a decision.",
      );
      process.exitCode = 1;
      return;
    }
    const unlockSeconds = parseUnlockSeconds(rawUnlock);
    if (unlockSeconds === null) {
      console.error(`--unlock "${rawUnlock}" is not a time or a number of seconds.`);
      process.exitCode = 1;
      return;
    }

    const { error: updateError } = await client
      .from("blocks")
      .update({ review_state: "HUMAN_APPROVED", unlock_seconds: unlockSeconds })
      .eq("id", blockId);
    if (updateError) {
      console.error(`The approval could not be written: ${updateError.message}`);
      process.exitCode = 1;
      return;
    }

    const { data: after } = await client
      .from("blocks")
      .select("review_state, unlock_seconds")
      .eq("id", blockId)
      .maybeSingle();
    console.log(
      `Approved ${blockId}: review_state=${(after as Record<string, unknown> | null)?.review_state}, ` +
        `unlock=${clock(Number((after as Record<string, unknown> | null)?.unlock_seconds ?? unlockSeconds))}.`,
    );
    console.log(
      `It becomes evidence at or after ${clock(unlockSeconds)} only. Below that playhead it is still filtered out.`,
    );
    return;
  }

  // ---- List ----------------------------------------------------------
  const courseId = argValue("course");
  let query = client
    .from("blocks")
    .select(
      "id, course_id, resource_id, block_type, ordinal, page_number, slide_number, review_state, unlock_seconds, alignment_confidence, alignment_margin, text_normalized, resources(title)",
    )
    .order("course_id", { ascending: true })
    .order("ordinal", { ascending: true })
    .limit(200);
  if (courseId) query = query.eq("course_id", courseId);

  const { data, error } = await query;
  if (error) {
    console.error(`The blocks could not be read: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const rows = (data ?? []) as Array<Record<string, unknown>>;
  const pending = rows.filter((row) => row.review_state === "PENDING");
  const approved = rows.filter(
    (row) => row.review_state === "AUTO_APPROVED" || row.review_state === "HUMAN_APPROVED",
  );
  const rejected = rows.filter((row) => row.review_state === "REJECTED");

  console.log(
    `Blocks read: ${rows.length} · PENDING ${pending.length} · approved ${approved.length} · rejected ${rejected.length}` +
      (courseId ? ` (course ${courseId})` : ""),
  );

  if (pending.length === 0) {
    console.log(
      "\nNo pending alignments. Document blocks are either approved or rejected; nothing is waiting for a human.",
    );
    return;
  }

  console.log("\nPENDING — ineligible until reviewed:\n");
  for (const row of pending) {
    const resource = row.resources as { title?: string } | null;
    const location = row.page_number
      ? `page ${row.page_number}`
      : row.slide_number
        ? `slide ${row.slide_number}`
        : `ordinal ${row.ordinal}`;
    const confidence = Number(row.alignment_confidence ?? 0);
    const margin = Number(row.alignment_margin ?? 0);
    console.log(`  ${row.id}`);
    console.log(
      `    ${String(resource?.title ?? row.block_type)} · ${location} · score ${confidence.toFixed(2)} · margin ${margin.toFixed(2)}`,
    );
    console.log(`    ${String(row.text_normalized ?? "").slice(0, 120)}…`);
    console.log(
      `    approve: pnpm review:alignments --approve ${row.id} --unlock <mm:ss>   |   reject: --reject ${row.id} --reason "…"\n`,
    );
  }
}

main().catch((error) => {
  console.error(`Failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
