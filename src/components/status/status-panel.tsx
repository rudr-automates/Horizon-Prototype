"use client";

/**
 * System status.
 *
 * PUBLIC BY CONSTRUCTION
 *   Everything rendered here comes from `toPublicHealth` — the same projection
 *   the public `/api/v1/health` endpoint returns. That is deliberate. This page
 *   used to receive the full operator report as a prop, so the day's token spend,
 *   the budget, the model ids, the schema counts and the configuration problems
 *   were serialized into the HTML for any visitor. A prop is as public as an
 *   endpoint; there is no such thing as a private value rendered into a page.
 *
 *   Detailed operational information is NOT here. It is available only to an
 *   operator through `GET /api/v1/health/diagnostics`, which requires a bearer
 *   token held server-side. No token is ever placed in browser-visible code.
 *
 * WHAT IT STILL ANSWERS
 *   Is the service up, can it read its database, is a generation credential
 *   configured, and which corpus is it serving. Those are the facts a learner
 *   needs to interpret a refusal.
 */
import { Icon } from "@/components/ui/icons";
import { Button, Panel, PanelHeader } from "@/components/ui/primitives";
import type { PublicHealthResponse } from "@/lib/contracts/http";

export function StatusPanel({
  health,
  healthFailed,
  storeError,
  onRefresh,
}: {
  health: PublicHealthResponse | null;
  healthFailed: boolean;
  storeError: string | null;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
            System status
          </p>
          <h1 className="mt-0.5 text-xl font-semibold tracking-tight text-ink sm:text-2xl">
            Service, database and evidence state
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-soft">
            The same public facts the health endpoint reports. Configuration and
            availability are reported separately, because a configured key is not
            proof a call works.
          </p>
        </div>
        <Button size="sm" icon="status" onClick={onRefresh}>
          Refresh
        </Button>
      </header>

      {storeError && (
        <div className="rounded-panel border border-danger-line bg-danger-soft px-4 py-3 text-sm text-danger">
          <p className="font-semibold">Database path unavailable</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-soft">{storeError}</p>
        </div>
      )}

      {healthFailed && (
        <div className="rounded-panel border border-warn-line bg-warn-soft px-4 py-3 text-sm text-warn">
          <p className="font-semibold">The status report could not be built</p>
          <p className="mt-0.5 text-xs leading-5 text-ink-soft">
            The figures below are unavailable rather than zero.
          </p>
        </div>
      )}

      {!health && !healthFailed && (
        <div className="rounded-panel border border-line bg-surface px-4 py-6 text-sm text-ink-soft">
          Loading status…
        </div>
      )}

      {health && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <SummaryTile
              label="Overall"
              value={health.status === "ok" ? "Operational" : "Degraded"}
              tone={health.status === "ok" ? "ok" : "warn"}
              detail={`checked ${new Date(health.timestamp).toLocaleTimeString()}`}
            />
            <SummaryTile
              label="Evidence"
              value={health.runtime.evidenceSource === "supabase" ? "Database" : "Sample fixture"}
              tone={health.runtime.evidenceSource === "supabase" ? "ok" : "warn"}
              detail={
                health.runtime.evidenceSource === "supabase"
                  ? "database-backed corpus"
                  : "synthetic corpus"
              }
            />
            <SummaryTile
              label="Database read"
              value={
                health.checks.database.reachable === null
                  ? "Not attempted"
                  : health.checks.database.reachable
                    ? "Succeeded"
                    : "Failed"
              }
              tone={
                health.checks.database.reachable === null
                  ? "neutral"
                  : health.checks.database.reachable
                    ? "ok"
                    : "warn"
              }
              detail={health.checks.database.detail}
            />
            <SummaryTile
              label="Assistant"
              value={health.checks.runtimeAi.configured ? "Configured" : "Not configured"}
              tone={health.checks.runtimeAi.configured ? "ok" : "warn"}
              detail="a credential exists; no call is made here"
            />
            {/* Overall is Degraded when this is unavailable, because every
                question is refused before any provider call. */}
            <SummaryTile
              label="Admission"
              value={
                health.checks.admission.reachable === null
                  ? "Unknown"
                  : health.checks.admission.reachable
                    ? "Ready"
                    : "Unavailable"
              }
              tone={
                health.checks.admission.reachable === null
                  ? "neutral"
                  : health.checks.admission.reachable
                    ? "ok"
                    : "warn"
              }
              detail="can a question be admitted"
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Evidence source" icon="materials">
              <Field label="Source">
                {health.runtime.evidenceSource === "supabase" ? "Supabase" : "Sample fixture"}
              </Field>
              <Field label="Synthetic content">{health.runtime.demoContent ? "yes" : "no"}</Field>
            </Card>

            <Card title="Answer path" icon="layers">
              <Field label="Generation credential">
                {health.checks.runtimeAi.configured ? "present" : "absent"}
              </Field>
              <Field label="Claimed reachable">
                {/* Never inferred: only a real call establishes this, and this page makes none. */}
                not verified
              </Field>
              <Field label="Detail">{health.checks.runtimeAi.detail}</Field>
            </Card>

            <Card title="Database" icon="progress">
              <Field label="Configured">{health.checks.database.configured ? "yes" : "no"}</Field>
              <Field label="Authenticated read">
                {health.checks.database.reachable === null
                  ? "not attempted"
                  : health.checks.database.reachable
                    ? "succeeded"
                    : "failed"}
              </Field>
              <Field label="Detail">{health.checks.database.detail}</Field>
            </Card>

            <Card title="Request admission" icon="warning">
              <Field label="Durable">{health.checks.admission.configured ? "yes" : "no"}</Field>
              <Field label="Ready">
                {health.checks.admission.reachable === null
                  ? "unknown"
                  : health.checks.admission.reachable
                    ? "yes"
                    : "no"}
              </Field>
              <Field label="Detail">{health.checks.admission.detail}</Field>
            </Card>

            <Card title="Service" icon="status">
              <Field label="Overall">{health.status}</Field>
              <Field label="Version">{health.version}</Field>
              <Field label="Checked at">
                <span className="font-mono text-xs">{health.timestamp}</span>
              </Field>
              <Field label="Request id">
                <span className="font-mono text-xs">{health.requestId}</span>
              </Field>
            </Card>
          </div>

          <Panel>
            <PanelHeader
              eyebrow="About these figures"
              title="What this page does and does not claim"
            />
            <div className="grid gap-3 px-4 py-3 text-xs leading-5 text-ink-soft sm:grid-cols-2 sm:px-5">
              <p>
                <strong className="text-ink">Observed:</strong> the route handler answered,
                whether an authenticated database read succeeded, and which corpus is being
                served.
              </p>
              <p>
                <strong className="text-ink">Not claimed:</strong> that a provider is
                reachable now, that a credential is still valid, or that any particular
                answer is correct. The first two are only known once a call is made.
              </p>
              <p className="sm:col-span-2">
                <strong className="text-ink">Not published:</strong> spend figures, model
                ids, schema counts and configuration detail are operational, so they are
                available only through the token-protected diagnostics endpoint and are
                never rendered into this page.
              </p>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

function SummaryTile({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "ok" | "warn" | "neutral";
}) {
  return (
    <div className="rounded-panel border border-line bg-surface px-4 py-3">
      <p className="text-[10px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </p>
      <p className="mt-1 flex items-center gap-1.5 text-[15px] font-semibold text-ink">
        <span
          className={`h-2 w-2 rounded-full ${
            tone === "ok" ? "bg-ok" : tone === "warn" ? "bg-warn" : "bg-ink-faint"
          }`}
          aria-hidden="true"
        />
        {value}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-faint">{detail}</p>
    </div>
  );
}

function Card({
  title,
  icon,
  children,
}: {
  title: string;
  icon: "layers" | "search" | "materials" | "progress" | "warning" | "status";
  children: React.ReactNode;
}) {
  return (
    <Panel>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
        <Icon name={icon} size={14} className="text-ink-faint" />
        <h2 className="text-[13px] font-semibold text-ink">{title}</h2>
      </div>
      <dl className="space-y-1.5 px-4 py-3">{children}</dl>
    </Panel>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-x-3 sm:grid-cols-[minmax(0,10rem)_1fr]">
      <dt className="text-[11px] text-ink-faint">{label}</dt>
      <dd className="min-w-0 break-words text-xs text-ink">{children}</dd>
    </div>
  );
}
