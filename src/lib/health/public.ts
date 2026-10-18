import {
  publicHealthResponseSchema,
  type HealthResponse,
  type PublicHealthResponse,
} from "@/lib/contracts/http";

/**
 * The one place the operator report is reduced to the public payload.
 *
 * WHY THIS EXISTS
 *   The public Status surface used to receive the FULL report as a prop, which
 *   meant the day's spend, the budget, the model ids, the schema counts and the
 *   configuration problems were serialized into the page for any visitor — the
 *   public JSON endpoint had been minimized while the page had not. A page prop
 *   is as public as an endpoint: it is in the HTML.
 *
 *   Both the JSON endpoint and the Status surface now go through this function,
 *   so they cannot disagree, and neither can carry a field that the public
 *   contract does not declare. `publicHealthResponseSchema.parse` strips unknown
 *   keys, so adding a field to the operator report cannot leak it here by
 *   accident.
 *
 * The detailed report stays available to an operator only, through
 * `GET /api/v1/health/diagnostics` with a bearer token. Nothing in this
 * projection is a credential, a spend figure, a model id or a schema count.
 */
export function toPublicHealth(report: HealthResponse): PublicHealthResponse {
  return publicHealthResponseSchema.parse({
    ok: report.ok,
    status: report.status,
    service: report.service,
    version: report.version,
    requestId: report.requestId,
    timestamp: report.timestamp,
    checks: {
      app: report.checks.app,
      database: {
        configured: report.checks.database.configured,
        reachable: report.checks.database.reachable,
        detail: describeDatabaseRead(report),
      },
      runtimeAi: {
        configured: report.checks.runtimeAi.configured,
        reachable: null,
        detail: report.checks.runtimeAi.configured
          ? "A generation credential is configured. That is not a claim that a call will succeed."
          : "No generation credential is configured, so no model call is possible.",
      },
      // Already public-safe by construction: a boolean and one sentence about
      // whether a question can be admitted. No object name, count or error text.
      admission: report.checks.admission,
    },
    runtime: {
      evidenceSource: report.runtime.evidenceSource,
      demoContent: report.runtime.demoContent,
    },
  });
}

/**
 * One public sentence about the database. The operator report's own detail
 * contains schema-object counts and ledger state, which are deliberately not
 * public, so the sentence is rebuilt from the booleans.
 */
function describeDatabaseRead(report: HealthResponse): string {
  if (!report.checks.database.configured) {
    return "No database is configured; the labelled sample corpus is in use.";
  }
  return report.checks.database.querySucceeded
    ? "An authenticated read of the database succeeded."
    : "The database is configured but an authenticated read did not succeed.";
}
