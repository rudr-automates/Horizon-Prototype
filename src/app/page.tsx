/**
 * Placeholder landing page for the MVP foundation.
 *
 * The learner UI (video player, ask flow, evidence viewer) is intentionally NOT
 * built in Part 01. This page exists only so the app has a real route, and it
 * reports the same "not configured" truth as the health endpoint.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">Horizon</h1>
        <p className="text-base opacity-80">
          Timestamp-aware, evidence-grounded learning assistant.
        </p>
      </header>

      <section className="rounded-lg border border-current/15 p-4 text-sm">
        <h2 className="mb-2 font-medium">Foundation status</h2>
        <p className="opacity-80">
          Part 01 scaffold only. The lesson player, ask flow and evidence viewer
          are deferred. Runtime AI is not configured, so no answer path is
          active. See{" "}
          <code className="rounded bg-current/10 px-1">/api/v1/health</code> for
          the live, honest dependency status.
        </p>
      </section>
    </main>
  );
}
