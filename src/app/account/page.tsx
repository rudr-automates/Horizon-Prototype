import Link from "next/link";
import { redirect } from "next/navigation";
import { signOut } from "@/app/auth/actions";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { ProfileForm } from "@/app/account/profile-form";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  let user = null;
  let displayName = "";
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.auth.getUser();
    if (!error) user = data.user;
    if (user) {
      const profile = await supabase.from("learner_profiles").select("display_name").eq("user_id", user.id).maybeSingle();
      if (!profile.error) displayName = profile.data?.display_name ?? "";
    }
  } catch {
    redirect("/auth/signin?message=Sign-in%20is%20temporarily%20unavailable.");
  }
  if (!user) redirect("/auth/signin");

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-5 py-12">
      <section className="w-full rounded-2xl border border-line bg-surface p-8">
        <Link href="/" className="text-sm text-ink-soft">Horizon</Link>
        <h1 className="mt-6 text-3xl font-semibold text-ink">Your account</h1>
        <p className="mt-4 text-ink-soft">Signed in as <span className="text-ink">{user.email}</span>.</p>
        <p className="mt-4 text-sm text-ink-soft">Your learning notes, bookmarks, and watched progress sync to your account when the connection is available.</p>
        <ProfileForm initialName={displayName} />
        <form action={signOut} className="mt-7"><button className="rounded-lg border border-line-strong px-4 py-2 text-ink" type="submit">Sign out</button></form>
      </section>
    </main>
  );
}
