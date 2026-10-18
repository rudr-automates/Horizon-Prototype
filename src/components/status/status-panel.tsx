"use client";

/**
 * System status.
 *
 * The learning surface should not read like an operator console, but the facts an
 * operator needs must still be reachable. They live here, laid out in full and
 * read from the same `/api/v1/health` endpoint an operator would call, so this
 * page cannot disagree with it. Names and counts only: no credential value is
 * ever part of the response or this view.
 */
import { Icon } from "@/components/ui/icons";
import { Button, Panel, PanelHeader } from "@/components/ui/primitives";
import type { HealthResponse } from "@/lib/contracts/http";

export function StatusPanel({
  health,
  healthFailed,
  configurationProblems,
  storeError,
  onRefresh,
}: {
  health: HealthResponse | null;
  healthFailed: boolean;
  configurationProblems: string[];
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
            Evidence, provider and budget state
          </h1>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-ink-soft">
            Read live from the health endpoint. Configuration, availability and verified
            behaviour are reported separately, because a configured key is not proof a
            call works.
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
          <p className="font-semibold">The status endpoint could not be read</p>
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
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <SummaryTile
              label="Overall"
              value={health.status === "ok" ? "Operational" : "Degraded"}
              tone={health.status === "ok" ? "ok" : "warn"}
              detail={`checked ${new Date(health.timestamp).toLocaleTimeString()}`}
            />
            <SummaryTile
              label="Evidence"
              value={health.runtime.evidenceSource === "supabase" ? "Supabase" : "Sample fixture"}
              tone={health.runtime.evidenceSource === "supabase" ? "ok" : "warn"}
              detail={health.runtime.evidenceSource === "supabase" ? "database-backed" : "synthetic corpus"}
            />
            <SummaryTile
              label="Next provider call"
              value={health.runtime.spendGuard === "permitted" ? "Permitted" : "Refused"}
              tone={health.runtime.spendGuard === "permitted" ? "ok" : "warn"}
              detail="spend guard decision"
            />
            <SummaryTile
              label="Tokens today"
              value={
                health.runtime.spentTokensToday === null
                  ? "Unknown"
                  : String(health.runtime.spentTokensToday)
              }
              tone={health.runtime.spentTokensToday === null ? "warn" : "neutral"}
              detail={`ledger: ${health.runtime.usageMode}`}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card title="Generation provider" icon="layers">
              <Field label="Provider">{health.runtime.provider}</Field>
              <Field label="Text model">{health.runtime.textModel}</Field>
              <Field label="Configured">{health.checks.runtimeAi.configured ? "yes" : "no"}</Field>
              <Field label="Completed provider call">
                {health.runtime.providerCallEvidence.state === "observed"
                  ? `yes · ${health.runtime.providerCallEvidence.detail}`
                  : health.runtime.providerCallEvidence.detail}
              </Field>
            </Card>

            <Card title="Embeddings" icon="search">
              <Field label="Model">{health.runtime.embeddingModel}</Field>
              <Field label="In use">{health.runtime.embeddingProvider}</Field>
              <Field label="Dimensions">{health.runtime.embeddingDimensions}</Field>
              <Field label="Credential present">
                {health.runtime.embeddingCredentialPresent ? "yes" : "no"}
              </Field>
            </Card>

            <Card title="Evidence source" icon="materials">
              <Field label="Source">{health.runtime.evidenceSource}</Field>
              <Field label="Synthetic content">{health.runtime.demoContent ? "yes" : "no"}</Field>
              <Field label="Detail">{health.runtime.evidenceReason}</Field>
            </Card>

            <Card title="Database" icon="progress">
              <Field label="Configured">{health.checks.database.configured ? "yes" : "no"}</Field>
              <Field label="Authenticated read">
                {health.checks.database.querySucceeded === null
                  ? "not attempted"
                  : health.checks.database.querySucceeded
                    ? "succeeded"
                    : "failed"}
              </Field>
              <Field label="Schema objects">{health.checks.database.schemaObjects}</Field>
              <Field label="Budget ledger">{health.checks.database.durableLedger}</Field>
              <Field label="Detail">{health.checks.database.detail}</Field>
            </Card>

            <Card title="Spend guard" icon="warning">
              <Field label="Next call">
                {health.runtime.spendGuard === "blocked" ? "would be refused" : "would be permitted"}
              </Field>
              <Field label="Tokens today">
                {health.runtime.spentTokensToday === null
                  ? "unknown · the ledger could not be read"
                  : `${health.runtime.spentTokensToday} of the daily ceiling`}
              </Field>
              <Field label="Ledger mode">{health.runtime.usageMode}</Field>
              <Field label="Embedding requests">{describeEmbeddingRequests(health.runtime)}</Field>
              <Field label="Coverage">{health.runtime.usageCoverage}</Field>
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

          {configurationProblems.length > 0 && (
            <Panel className="border-warn-line">
              <PanelHeader
                eyebrow="Action needed"
                title="Configuration problems to fix"
                description="Settings names only. No value is read into this response."
              />
              <ul className="space-y-1.5 px-4 py-3 text-sm text-ink sm:px-5">
                {configurationProblems.map((problem) => (
                  <li key={problem} className="flex gap-2">
                    <Icon name="warning" size={14} className="mt-1 text-warn" />
                    <span className="leading-6">{problem}</span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel>
            <PanelHeader
              eyebrow="About these figures"
              title="What this page does and does not claim"
            />
            <div className="grid gap-3 px-4 py-3 text-xs leading-5 text-ink-soft sm:grid-cols-2 sm:px-5">
              <p>
                <strong className="text-ink">Observed:</strong> an authenticated database
                read, the schema objects that exist, the durable ledger, and the newest
                recorded provider success.
              </p>
              <p>
                <strong className="text-ink">Not claimed:</strong> that a provider is
                reachable now, that a credential is still valid, or that any particular
                answer is correct. The first two are only known once a call is made.
              </p>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}

/**
 * Embedding-request usage, with the figure's scope stated rather than implied.
 *
 * The number must come from the store the cap is enforced in. When the cap is
 * durable, this process's counter is NOT the day's usage — it resets on restart —
 * so showing it beside a durable cap would understate consumption.
 */
function describeEmbeddingRequests(runtime: HealthResponse["runtime"]): string {
  const cap =
    runtime.maxEmbeddingCalls === 0 ? "no cap configured" : `cap ${runtime.maxEmbeddingCalls}`;

  if (runtime.embeddingCapMode !== "supabase") {
    return `${runtime.embeddingCalls} made in this process · ${cap}`;
  }
  if (runtime.embeddingRequestsToday === null) {
    return `unknown (the ledger could not be read) · ${cap}`;
  }
  return `${runtime.embeddingRequestsToday} made today · ${cap}`;
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

