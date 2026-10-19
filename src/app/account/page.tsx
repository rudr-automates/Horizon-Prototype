import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/app/account/profile-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  let user = null;
  let displayName = "";
  let learningSummary: { courses: number; bookmarks: number; notes: number } | null = null;
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
    if (user) {
      const profile = await supabase.from("learner_profiles").select("display_name").eq("user_id", user.id).maybeSingle();
      if (!profile.error) displayName = profile.data?.display_name ?? "";
      const [progress, bookmarks, notes] = await Promise.all([
        supabase.from("learner_progress").select("course_id").eq("user_id", user.id).limit(500),
        supabase.from("learner_bookmarks").select("id", { count: "exact", head: true }).eq("user_id", user.id),
        supabase.from("learner_notes").select("id", { count: "exact", head: true }).eq("user_id", user.id),
      ]);
      if (!progress.error && !bookmarks.error && !notes.error) {
        learningSummary = {
          courses: progress.data.length,
          bookmarks: bookmarks.count ?? 0,
          notes: notes.count ?? 0,
        };
      }
    }
  } catch {
    redirect("/auth/signin?message=Sign-in%20is%20temporarily%20unavailable.");
  }
  if (!user) redirect("/auth/signin");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-5 py-12">
      <section className="w-full rounded-2xl border border-line bg-surface p-8">
        <Link href="/" className="text-sm text-ink-soft">Horizon</Link>
        <h1 className="mt-6 text-3xl font-semibold text-ink">Your learning dashboard</h1>
        <p className="mt-4 text-ink-soft">Signed in as <span className="text-ink">{user.email}</span>.</p>
        <p className="mt-3 text-sm text-ink-soft">Your notes, bookmarks and watched progress are scoped to your account.</p>
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
