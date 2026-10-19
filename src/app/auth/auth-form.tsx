import Link from "next/link";
import type { ReactNode } from "react";

export function AuthForm({
  title,
  action,
  submitLabel,
  message,
  footer,
}: {
  title: string;
  action: (formData: FormData) => void | Promise<void>;
  submitLabel: string;
  message?: string;
  footer: ReactNode;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl items-center px-5 py-12">
      <section className="w-full rounded-2xl border border-line bg-surface p-7 shadow-xl sm:p-10">
        <Link href="/" className="text-sm text-ink-soft">Horizon</Link>
        <h1 className="mt-6 text-3xl font-semibold text-ink">{title}</h1>
        {message ? <p role="status" className="mt-4 rounded-lg border border-warn-line bg-warn-soft p-3 text-sm text-ink">{message}</p> : null}
        <form action={action} className="mt-7 grid gap-5">
          <label className="grid gap-2 text-sm text-ink-soft" htmlFor="email">
            Email
            <input id="email" name="email" type="email" autoComplete="email" required maxLength={254} className="rounded-lg border border-line-strong bg-canvas px-3 py-3 text-ink" />
          </label>
          <label className="grid gap-2 text-sm text-ink-soft" htmlFor="password">
            Password
            <input id="password" name="password" type="password" autoComplete={title === "Create your account" ? "new-password" : "current-password"} required minLength={title === "Create your account" ? 12 : 1} maxLength={1024} className="rounded-lg border border-line-strong bg-canvas px-3 py-3 text-ink" />
          </label>
          <button type="submit" className="rounded-lg bg-brand px-4 py-3 font-medium text-canvas">{submitLabel}</button>
        </form>
        <p className="mt-6 text-sm text-ink-soft">{footer}</p>
      </section>
    </main>
  );
}
