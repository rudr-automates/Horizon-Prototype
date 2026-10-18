import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusPanel } from "@/components/status/status-panel";
import { publicHealthResponseSchema, type HealthResponse } from "@/lib/contracts/http";
import { toPublicHealth } from "@/lib/health/public";
import { OPERATIONAL_DETAIL, fullHealthReport } from "./helpers/health-report";

/**
 * The Status surface used to be handed the FULL operator report as a prop, so
 * the day's spend, the budget, the model ids, the schema counts and the
 * configuration problems were serialized into the page for any visitor. The
 * public JSON endpoint had been minimized; the page had not.
 *
 * These cases pin the two halves of the fix:
 *   1. `toPublicHealth` is an allowlist. Nothing outside the public contract can
 *      survive it, however much the operator report grows.
 *   2. The rendered page contains none of the operational detail, because it is
 *      rendered from that projection only.
 */

function renderPanel(report: HealthResponse): string {
  return renderToStaticMarkup(
    createElement(StatusPanel, {
      health: toPublicHealth(report),
      healthFailed: false,
      storeError: null,
      onRefresh: () => undefined,
    }),
  );
}

describe("public health projection", () => {
  it("keeps only the fields the public contract declares", () => {
    const publicHealth = toPublicHealth(fullHealthReport());

    expect(publicHealthResponseSchema.safeParse(publicHealth).success).toBe(true);
    expect(Object.keys(publicHealth).sort()).toEqual([
      "checks",
      "ok",
      "requestId",
      "runtime",
      "service",
      "status",
      "timestamp",
      "version",
    ]);
    expect(Object.keys(publicHealth.runtime).sort()).toEqual(["demoContent", "evidenceSource"]);
    expect(Object.keys(publicHealth.checks.database).sort()).toEqual([
      "configured",
      "detail",
      "reachable",
    ]);
    expect(Object.keys(publicHealth.checks.admission).sort()).toEqual([
      "configured",
      "detail",
      "reachable",
    ]);

    const serialized = JSON.stringify(publicHealth);
    for (const detail of OPERATIONAL_DETAIL) {
      expect(serialized).not.toContain(detail);
    }
  });

  it("rebuilds the database sentence instead of copying the operator detail", () => {
    const publicHealth = toPublicHealth(fullHealthReport());

    expect(publicHealth.checks.database.detail).toBe(
      "An authenticated read of the database succeeded.",
    );
    expect(publicHealth.checks.runtimeAi.detail).not.toContain("daily tokens");
  });
});

describe("Status surface", () => {
  it("renders service, database and evidence facts without operational detail", () => {
    const markup = renderPanel(fullHealthReport());

    expect(markup).toContain("Operational");
    expect(markup).toContain("Succeeded");
    expect(markup).toContain("An authenticated read of the database succeeded.");
    expect(markup).toContain("Database");

    for (const detail of OPERATIONAL_DETAIL) {
      expect(markup).not.toContain(detail);
    }
    expect(markup).not.toContain("Tokens today");
    expect(markup).not.toContain("Budget ledger");
    expect(markup).not.toContain("Spend guard");
  });

  it("says degraded rather than healthy when the authenticated read failed", () => {
    const markup = renderPanel(fullHealthReport({ degrade: true }));

    expect(markup).toContain("Degraded");
    expect(markup).toContain("Failed");
    expect(markup).toContain(
      "The database is configured but an authenticated read did not succeed.",
    );
  });

  it("says degraded when the limiter cannot admit, even with a healthy database", () => {
    // The regression this closes: production had 0001-0003 applied and 0004
    // missing, so every question was refused with 503 while health said
    // "Operational".
    const markup = renderPanel(fullHealthReport({ admissionUnready: true }));

    expect(markup).toContain("Degraded");
    expect(markup).toContain("Unavailable");
    expect(markup).toContain("refused before any provider call");
    expect(markup).not.toContain("horizon_admit_request");
  });

  it("never renders a diagnostics token or an operator link", () => {
    const markup = renderPanel(fullHealthReport());

    expect(markup).not.toContain("HORIZON_DIAGNOSTICS_TOKEN");
    expect(markup).not.toContain("/api/v1/health/diagnostics");
  });
});
