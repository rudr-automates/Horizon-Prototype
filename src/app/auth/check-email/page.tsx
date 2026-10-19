import Link from "next/link";

export default function CheckEmailPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-5 py-12">
      <section className="w-full rounded-2xl border border-line bg-surface p-8">
        <h1 className="text-3xl font-semibold text-ink">Check your email</h1>
        <p className="mt-4 text-ink-soft">If account confirmation is enabled, follow the link in your email to finish creating your account.</p>
        <Link href="/auth/signin" className="mt-6 inline-block text-brand-strong underline">Return to sign in</Link>
      </section>
    </main>
  );
}
