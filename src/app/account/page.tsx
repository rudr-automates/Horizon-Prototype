import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/app/account/profile-form";
import { createServerContext } from "@/lib/server/context";
import { lessonTranscriptCourseId } from "@/lib/ingest/lesson-transcript";
import { learnerDashboardModel } from "@/lib/personal/dashboard";
import { lessonHref } from "@/lib/presentation/continue-lesson";
import { formatPlaybackClock } from "@/lib/lesson/video";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  let user = null;
  let displayName = "";
  let learningSummary: { courses: number; bookmarks: number; notes: number } | null = null;
  let lessonEntries: ReturnType<typeof learnerDashboardModel>["entries"] = [];
  let continueChoice: ReturnType<typeof learnerDashboardModel>["continueChoice"] = null;
  let catalogueError = false;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
    if (user) {
      const profile = await supabase.from("learner_profiles").select("display_name").eq("user_id", user.id).maybeSingle();
      if (!profile.error) displayName = profile.data?.display_name ?? "";
      const [progress, bookmarks, notes] = await Promise.all([
        supabase.from("learner_progress").select("course_id,furthest_seconds,watched_ranges,updated_at").eq("user_id", user.id).limit(500),
        supabase.from("learner_bookmarks").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("learner_notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      ]);
      const progressRows = progress.error ? [] : progress.data;
      const bookmarkCount = bookmarks.error ? null : bookmarks.count ?? 0;
      const noteCount = notes.error ? null : notes.count ?? 0;
      try {
        const { storeResolution } = createServerContext();
        const courses = await storeResolution.store.listCourses();
        const model = learnerDashboardModel(
          courses,
          courses.some((course) => course.courseId === lessonTranscriptCourseId())
            ? lessonTranscriptCourseId()
            : null,
          progressRows,
        );
        lessonEntries = model.entries;
        continueChoice = model.continueChoice;
        if (bookmarkCount !== null && noteCount !== null) {
          learningSummary = { courses: model.coursesWithProgress, bookmarks: bookmarkCount, notes: noteCount };
        }
      } catch {
        catalogueError = true;
        if (bookmarkCount !== null && noteCount !== null) {
          const model = learnerDashboardModel([], null, progressRows);
          learningSummary = { courses: model.coursesWithProgress, bookmarks: bookmarkCount, notes: noteCount };
        }
      }
    }
  } catch {
    redirect("/auth/signin?message=Sign-in%20is%20temporarily%20unavailable.");
  }
  if (!user) redirect("/auth/signin");

  return (
    <main className="mx-auto min-h-screen max-w-5xl px-5 py-12">
      <section className="rounded-2xl border border-line bg-surface p-6 sm:p-8">
        <Link href="/" className="text-sm text-ink-soft">Horizon</Link>
        <h1 className="mt-6 text-3xl font-semibold text-ink">Your learning dashboard</h1>
        <p className="mt-4 text-ink-soft">Signed in as <span className="text-ink">{user.email}</span>.</p>
        <p className="mt-3 text-sm text-ink-soft">Your notes, bookmarks and watched progress are scoped to your account.</p>
        <section aria-labelledby="continue-learning" className="mt-7 rounded-xl border border-brand-line bg-surface-muted p-5">
          <h2 id="continue-learning" className="text-sm font-semibold text-brand-strong">Continue learning</h2>
          {continueChoice ? (
            <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
              <div>
                <p className="text-lg font-semibold text-ink">{continueChoice.entry.title}</p>
                <p className="mt-1 text-sm text-ink-soft">
                  {continueChoice.started
                    ? `Reached ${formatPlaybackClock(continueChoice.seconds)} · watched ${formatPlaybackClock(continueChoice.watched)} of ${formatPlaybackClock(continueChoice.entry.durationSeconds)}`
                    : `Not started · ${formatPlaybackClock(continueChoice.entry.durationSeconds)}`}
                  {continueChoice.entry.synthetic ? " · synthetic sample" : ""}
                </p>
              </div>
              <Link href={lessonHref(continueChoice.entry, continueChoice.seconds)} className="rounded-lg bg-brand px-4 py-2 font-medium text-canvas">
                {continueChoice.started ? "Resume lesson" : "Start lesson"}
              </Link>
            </div>
          ) : catalogueError ? (
            <p className="mt-2 text-sm text-ink-soft">Courses are temporarily unavailable. Your saved account data is unchanged.</p>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">No course is available in the evidence catalogue yet.</p>
          )}
        </section>
        <section aria-labelledby="course-catalogue" className="mt-8">
          <h2 id="course-catalogue" className="text-lg font-semibold text-ink">Your courses</h2>
          {catalogueError ? (
            <p className="mt-3 text-sm text-ink-soft">The course catalogue could not be loaded. Try again later.</p>
          ) : lessonEntries.length ? (
            <ul className="mt-3 grid gap-3 sm:grid-cols-2">
              {lessonEntries.map((entry) => (
                <li key={entry.courseId} className="rounded-xl border border-line bg-canvas p-4">
                  <p className="font-medium text-ink">{entry.title}</p>
                  <p className="mt-1 text-xs text-ink-faint">
                    {entry.kind === "recording" ? "Lesson recording" : entry.synthetic ? "Synthetic sample" : "Course"}
                    {" · "}{formatPlaybackClock(entry.durationSeconds)}
                  </p>
                  <Link href={lessonHref(entry)} className="mt-3 inline-block text-sm font-semibold text-brand-strong underline">
                    Open course
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-ink-soft">No courses are available right now.</p>
          )}
        </section>
        <nav aria-label="Your learning" className="mt-7 flex flex-wrap gap-3">
          <Link href="/learn?lesson=recording" className="rounded-lg bg-brand px-4 py-2 font-medium text-canvas">Open lesson</Link>
          <Link href="/learn?section=notes" className="rounded-lg border border-line-strong px-4 py-2 text-ink">Notes and bookmarks</Link>
          <Link href="/learn?section=progress" className="rounded-lg border border-line-strong px-4 py-2 text-ink">Progress</Link>
          <Link href="/learn?section=materials" className="rounded-lg border border-line-strong px-4 py-2 text-ink">Materials</Link>
        </nav>
        <section aria-labelledby="learning-summary" className="mt-8 border-y border-line py-5">
          <h2 id="learning-summary" className="text-sm font-semibold text-ink">Saved learning</h2>
          {learningSummary ? (
            <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
              <div><dt className="text-ink-faint">Courses with progress</dt><dd className="mt-1 font-medium text-ink">{learningSummary.courses}</dd></div>
              <div><dt className="text-ink-faint">Bookmarks</dt><dd className="mt-1 font-medium text-ink">{learningSummary.bookmarks}</dd></div>
              <div><dt className="text-ink-faint">Notes</dt><dd className="mt-1 font-medium text-ink">{learningSummary.notes}</dd></div>
            </dl>
          ) : (
            <p className="mt-2 text-sm text-ink-soft">Saved learning data is temporarily unavailable.</p>
          )}
        </section>
        <ProfileForm initialName={displayName} />
        <form action={signOut} className="mt-7"><button className="rounded-lg border border-line-strong px-4 py-2 text-ink" type="submit">Sign out</button></form>
      </section>
    </main>
  );
}
