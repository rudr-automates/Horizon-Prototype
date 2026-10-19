import { NextResponse } from "next/server";
import { z } from "zod";
import { errorResponse, newRequestId } from "@/lib/http/api";
import { MAX_JSON_BODY_BYTES, readJsonBody } from "@/lib/http/body";
import { MAX_BOOKMARKS, MAX_NOTES, MAX_RANGES, mergeRanges } from "@/lib/personal/local-store";
import { learnerMutationSchema, personalStateFromRemote } from "@/lib/personal/remote-contract";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const withNoStore = { "cache-control": "no-store" };

async function session() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return { supabase, user: data.user };
}

function unavailable() {
  return errorResponse(
    "LEARNER_DATA_UNAVAILABLE",
    "Your account data is temporarily unavailable. Your browser copy is still available.",
    newRequestId(),
  );
}

function rowError(error: { code?: string } | null) {
  return error?.code === "23503" || error?.code === "23514" || error?.code === "22P02";
}

export async function GET() {
  let current;
  try {
    current = await session();
  } catch {
    return unavailable();
  }
  if (!current) {
    return errorResponse("UNAUTHENTICATED", "Sign in to access your account data.", newRequestId());
  }

  const { supabase, user } = current;
  try {
    const [profile, progress, bookmarks, notes] = await Promise.all([
      supabase.from("learner_profiles").select("display_name").eq("user_id", user.id).maybeSingle(),
      supabase.from("learner_progress").select("course_id,furthest_seconds,watched_ranges,updated_at").eq("user_id", user.id).limit(500),
      supabase.from("learner_bookmarks").select("id,course_id,position_seconds,title,created_at").eq("user_id", user.id).order("created_at", { ascending: true }).limit(MAX_BOOKMARKS),
      supabase.from("learner_notes").select("id,course_id,position_seconds,body,updated_at").eq("user_id", user.id).order("updated_at", { ascending: true }).limit(MAX_NOTES),
    ]);

    if (profile.error || progress.error || bookmarks.error || notes.error) return unavailable();

    return NextResponse.json({
      ownerId: user.id,
      profile: { displayName: profile.data?.display_name ?? "" },
      state: personalStateFromRemote({
        progress: progress.data,
        bookmarks: bookmarks.data,
        notes: notes.data,
      }),
    }, { headers: withNoStore });
  } catch {
    return unavailable();
  }
}

function bookmarkRow(item: {
  id: string; courseId: string; seconds: number; title: string; createdAt: string;
}, userId: string) {
  return {
    id: item.id,
    user_id: userId,
    course_id: item.courseId,
    position_seconds: item.seconds,
    title: item.title,
    created_at: item.createdAt,
  };
}

function noteRow(item: { id: string; courseId: string; seconds: number; body: string }, userId: string) {
  return {
    id: item.id,
    user_id: userId,
    course_id: item.courseId,
    position_seconds: item.seconds,
    body: item.body,
  };
}

export async function POST(request: Request) {
  const parsedBody = await readJsonBody(request, MAX_JSON_BODY_BYTES);
  if (!parsedBody.ok) {
    return errorResponse(
      parsedBody.reason === "too_large" ? "FILE_TOO_LARGE" : "INVALID_REQUEST",
      parsedBody.reason === "too_large"
        ? `The request body must be at most ${MAX_JSON_BODY_BYTES} bytes.`
        : "The request body must be valid JSON.",
      newRequestId(),
    );
  }

  const parsed = learnerMutationSchema.safeParse(parsedBody.value);
  if (!parsed.success) {
    return errorResponse("INVALID_REQUEST", "The account-data update is invalid.", newRequestId());
  }

  let current;
  try {
    current = await session();
  } catch {
    return unavailable();
  }
  if (!current) {
    return errorResponse("UNAUTHENTICATED", "Sign in to save account data.", newRequestId());
  }

  const { supabase, user } = current;
  let error: { code?: string } | null = null;

  try {
    switch (parsed.data.type) {
      case "profile.save": {
        const result = await supabase.from("learner_profiles").upsert({
          user_id: user.id,
          display_name: parsed.data.displayName,
        }, { onConflict: "user_id" });
        error = result.error;
        break;
      }
      case "bookmark.save": {
        const result = await supabase.from("learner_bookmarks").upsert(
          bookmarkRow(parsed.data.item, user.id), { onConflict: "id" },
        );
        error = result.error;
        break;
      }
      case "bookmark.delete": {
        const result = await supabase.from("learner_bookmarks").delete()
          .eq("id", parsed.data.id).eq("user_id", user.id);
        error = result.error;
        break;
      }
      case "note.save": {
        const result = await supabase.from("learner_notes").upsert(
          noteRow(parsed.data.item, user.id), { onConflict: "id" },
        );
        error = result.error;
        break;
      }
      case "note.delete": {
        const result = await supabase.from("learner_notes").delete()
          .eq("id", parsed.data.id).eq("user_id", user.id);
        error = result.error;
        break;
      }
      case "progress.merge": {
        const currentProgress = await supabase.from("learner_progress")
          .select("furthest_seconds,watched_ranges")
          .eq("user_id", user.id)
          .eq("course_id", parsed.data.courseId)
          .maybeSingle();
        if (currentProgress.error) {
          error = currentProgress.error;
          break;
        }
        const existingRanges = Array.isArray(currentProgress.data?.watched_ranges)
          ? currentProgress.data.watched_ranges.flatMap((range: unknown) => {
              const parsedRange = z.object({ start: z.number(), end: z.number() }).safeParse(range);
              return parsedRange.success ? [parsedRange.data] : [];
            })
          : [];
        const result = await supabase.from("learner_progress").upsert({
          user_id: user.id,
          course_id: parsed.data.courseId,
          furthest_seconds: Math.max(Number(currentProgress.data?.furthest_seconds ?? 0), parsed.data.furthestSeconds),
          watched_ranges: mergeRanges([...existingRanges, ...parsed.data.watched]).slice(-MAX_RANGES),
        }, { onConflict: "user_id,course_id" });
        error = result.error;
        break;
      }
      case "sync": {
        const [bookmarkResult, noteResult] = await Promise.all([
          parsed.data.bookmarks.length
            ? supabase.from("learner_bookmarks").upsert(parsed.data.bookmarks.map((item) => bookmarkRow(item, user.id)), { onConflict: "id" })
            : Promise.resolve({ error: null }),
          parsed.data.notes.length
            ? supabase.from("learner_notes").upsert(parsed.data.notes.map((item) => noteRow(item, user.id)), { onConflict: "id" })
            : Promise.resolve({ error: null }),
        ]);
        error = bookmarkResult.error ?? noteResult.error;
        if (!error && parsed.data.deletedBookmarkIds.length) {
          const result = await supabase.from("learner_bookmarks").delete()
            .in("id", parsed.data.deletedBookmarkIds).eq("user_id", user.id);
          error = result.error;
        }
        if (!error && parsed.data.deletedNoteIds.length) {
          const result = await supabase.from("learner_notes").delete()
            .in("id", parsed.data.deletedNoteIds).eq("user_id", user.id);
          error = result.error;
        }
        break;
      }
    }
  } catch {
    return unavailable();
  }

  if (error) {
    return rowError(error)
      ? errorResponse("INVALID_REQUEST", "The course or account-data entry is invalid.", newRequestId())
      : unavailable();
  }
  return NextResponse.json({ saved: true }, { headers: withNoStore });
}
