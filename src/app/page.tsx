import { HomeExperience } from "@/components/home/home-experience";
import { createServerContext } from "@/lib/server/context";
import { resolveServerLessonVideoSource } from "@/lib/lesson/video-file";
import { lessonTranscriptCourseId } from "@/lib/ingest/lesson-transcript";
import { buildLessonEntries } from "@/lib/presentation/continue-lesson";
import type { CourseSummary } from "@/lib/contracts/question";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// The page reads server configuration and the evidence store on every request.
export const dynamic = "force-dynamic";

/**
 * Home.
 *
 * ONE READ, NO MODEL CALL
 *   Everything on this page comes from a single `listCourses()` read of the
 *   evidence store plus whatever this browser has already saved locally. It does
 *   not ask a provider anything, and it does not open a lesson, so landing here
 *   costs nothing against the daily token budget.
 *
 * THE RECORDING IS CHOSEN BY FACT
 *   The video's transcript course is found by the id its own ingest command
 *   derives from the video id, not by "whichever row came back first" — which is
 *   what once selected the synthetic sample on a database-backed deployment. The
 *   id also decides which catalogue entry is labelled the lesson recording and
 *   which is marked synthetic.
 */
export default async function HomePage() {
  const { providers, storeResolution } = createServerContext();
  const store = storeResolution.store;
  let signedIn = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    signedIn = !error && Boolean(data.user);
  } catch {
    // The public landing page remains available if Auth is temporarily unavailable.
  }

  const lessonCourseId = lessonTranscriptCourseId();
  let courses: CourseSummary[] = [];
  let storeError: string | null = null;

  try {
    courses = await store.listCourses();
  } catch {
    storeError =
      "The database-backed evidence store is configured but the query failed. The schema migration has probably not been applied yet.";
  }

  const videoCourseId =
    courses.find((course) => course.courseId === lessonCourseId)?.courseId ?? null;

  // The recording leads the catalogue; the rest keep the store's own order.
  const entries = buildLessonEntries(courses, videoCourseId).sort((a, b) =>
    a.kind === b.kind ? 0 : a.kind === "recording" ? -1 : 1,
  );

  return (
    <HomeExperience
      entries={entries}
      evidenceSource={store.mode}
      evidenceReason={storeResolution.reason}
      storeError={storeError}
      runtimeAiConfigured={providers.configured}
      embeddingCredentialPresent={providers.embeddingConfigured}
      // Resolved from the filesystem on every request, so the hero states the
      // source this deployment can really play rather than the one we hoped for.
      lessonVideoKind={resolveServerLessonVideoSource().kind}
      signedIn={signedIn}
    />
  );
}
