import { describe, expect, it } from "vitest";
import type { Embedder } from "@/lib/answer/provider";
import { SyntheticLexicalEmbedder } from "@/lib/answer/synthetic-embedder";
import { DEMO_BLOCKS, DEMO_COURSE } from "@/lib/demo/lesson";
import {
  applySeedPlan,
  buildSeedPlan,
  contentHash,
  createSupabaseSeedGateway,
  SeedRefused,
  stableUuid,
  toVectorLiteral,
  type SeedGateway,
  type SeedTable,
} from "@/lib/ingest/seed";

/** A real, semantic-looking embedder: only the provider id matters here. */
function semanticEmbedder(dimensions = 768): Embedder {
  return {
    providerId: "gemini-embedding-001",
    dimensions,
    embed: async (texts) =>
      texts.map((text, index) => {
        const vector = new Array<number>(dimensions).fill(0);
        vector[(index + text.length) % dimensions] = 1;
        return vector;
      }),
  };
}

function recordingGateway(): SeedGateway & { calls: Array<{ table: SeedTable; rows: unknown[] }> } {
  const calls: Array<{ table: SeedTable; rows: unknown[] }> = [];
  return {
    calls,
    upsert: async (table, rows) => {
      calls.push({ table, rows });
      return rows.length;
    },
  };
}

const CONFIG = { embedder: semanticEmbedder(), embeddingModel: "gemini-embedding-001" };

describe("seed plan integrity guards", () => {
  it("refuses to persist vectors from the offline lexical placeholder", async () => {
    // This is the guard that stops a lexical hash being labelled a semantic
    // embedding in blocks.embedding.
    await expect(
      buildSeedPlan({ embedder: new SyntheticLexicalEmbedder(768), embeddingModel: "synthetic-lexical-v1" }),
    ).rejects.toBeInstanceOf(SeedRefused);

    await expect(
      buildSeedPlan({ embedder: new SyntheticLexicalEmbedder(768), embeddingModel: "synthetic-lexical-v1" }),
    ).rejects.toThrow(/lexical placeholder, not a semantic model/);
  });

  it("refuses an empty corpus", async () => {
    await expect(buildSeedPlan(CONFIG, [])).rejects.toThrow(/nothing to seed/);
  });

  it("refuses when a returned vector does not match the configured dimension", async () => {
    const wrongDimension: Embedder = {
      providerId: "gemini-embedding-001",
      dimensions: 768,
      embed: async (texts) => texts.map(() => [1, 2, 3]),
    };
    await expect(
      buildSeedPlan({ embedder: wrongDimension, embeddingModel: "gemini-embedding-001" }),
    ).rejects.toThrow(/not the configured 768/);
  });
});

describe("seed row mapping", () => {
  it("produces one row per demo block and one per distinct resource", async () => {
    const plan = await buildSeedPlan(CONFIG);
    expect(plan.blocks).toHaveLength(DEMO_BLOCKS.length);

    const distinctResources = new Set(DEMO_BLOCKS.map((spec) => spec.resourceId));
    expect(plan.resources).toHaveLength(distinctResources.size);
    expect(plan.provenance.blockCount).toBe(DEMO_BLOCKS.length);
    expect(plan.provenance.resourceCount).toBe(distinctResources.size);
  });

  it("carries the fixture's policy, review state and unlock time through unchanged", async () => {
    const plan = await buildSeedPlan(CONFIG);

    for (const [index, spec] of DEMO_BLOCKS.entries()) {
      const row = plan.blocks[index];
      expect(row.policy).toBe(spec.policy);
      expect(row.review_state).toBe(spec.reviewState);
      expect(row.lint_status).toBe(spec.lintStatus);
      expect(row.ingest_status).toBe(spec.ingestStatus);
      expect(row.unlock_seconds).toBe(spec.unlockSeconds);
      expect(row.block_type).toBe(spec.blockType);
      expect(row.text_normalized).toBe(spec.text);
    }
  });

  it("keeps the future-only fact on timeline-bound blocks that unlock late", async () => {
    const plan = await buildSeedPlan(CONFIG);
    const carrying = plan.blocks.filter((row) => String(row.text_normalized).includes("0.37"));

    expect(carrying.length).toBeGreaterThan(0);
    for (const row of carrying) {
      expect(row.policy).toBe("TIMELINE_BOUND");
      expect(Number(row.unlock_seconds)).toBeGreaterThan(0);
    }
  });

  it("records the embedding model and dimension that actually produced the vector", async () => {
    const plan = await buildSeedPlan(CONFIG);
    for (const row of plan.blocks) {
      expect(row.embedding_model).toBe("gemini-embedding-001");
      expect(row.embedding_dim).toBe(768);
      expect(String(row.embedding)).toMatch(/^\[/);
      expect(String(row.embedding).split(",")).toHaveLength(768);
    }
  });

  it("never sends the generated fts column", async () => {
    const plan = await buildSeedPlan(CONFIG);
    for (const row of plan.blocks) {
      expect(row).not.toHaveProperty("fts");
    }
  });

  it("gives each resource a distinct source_hash so the unique constraint holds", async () => {
    const plan = await buildSeedPlan(CONFIG);
    const hashes = plan.resources.map((row) => String(row.source_hash));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("assigns course-wide resources the course-wide default policy", async () => {
    const plan = await buildSeedPlan(CONFIG);
    const courseWideResources = new Set(
      DEMO_BLOCKS.filter((spec) => spec.policy === "COURSE_WIDE").map((spec) => spec.resourceId),
    );

    for (const row of plan.resources) {
      const fixtureResourceId = String(
        Object.keys(plan.provenance.idMap).find(
          (key) => key.startsWith("resource:") && plan.provenance.idMap[key] === row.id,
        ) ?? "",
      ).replace("resource:", "");
      expect(row.default_policy).toBe(
        courseWideResources.has(fixtureResourceId) ? "COURSE_WIDE" : "TIMELINE_BOUND",
      );
    }
  });
});

describe("seed id stability", () => {
  it("derives a deterministic uuid, so re-running converges instead of duplicating", async () => {
    const first = await buildSeedPlan(CONFIG);
    const second = await buildSeedPlan(CONFIG);

    expect(first.course.id).toBe(second.course.id);
    expect(first.blocks.map((row) => row.id)).toEqual(second.blocks.map((row) => row.id));
  });

  it("mints a well-formed v5-shaped uuid", () => {
    const id = stableUuid("block:b_0001");
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("separates ids for a block, its resource and its course", () => {
    const ids = [
      stableUuid("block:b_0001"),
      stableUuid("resource:res_transcript"),
      stableUuid(`course:${DEMO_COURSE.courseId}`),
    ];
    expect(new Set(ids).size).toBe(3);
  });

  it("maps every fixture id onto its database uuid", async () => {
    const plan = await buildSeedPlan(CONFIG);
    for (const spec of DEMO_BLOCKS) {
      expect(plan.provenance.idMap[`block:${spec.id}`]).toBe(stableUuid(`block:${spec.id}`));
    }
    // One entry per block, one per distinct resource, plus the course itself.
    const distinctResources = new Set(DEMO_BLOCKS.map((spec) => spec.resourceId));
    expect(Object.keys(plan.provenance.idMap)).toHaveLength(
      DEMO_BLOCKS.length + distinctResources.size + 1,
    );
  });
});

describe("applying a seed plan", () => {
  it("upserts each table once, in dependency order, and reports real counts", async () => {
    const plan = await buildSeedPlan(CONFIG);
    const gateway = recordingGateway();

    const result = await applySeedPlan(gateway, plan);

    expect(gateway.calls.map((call) => call.table)).toEqual(["courses", "resources", "blocks"]);
    expect(result.courses).toBe(1);
    expect(result.resources).toBe(plan.resources.length);
    expect(result.blocks).toBe(DEMO_BLOCKS.length);
  });

  it("surfaces a database failure as a refusal rather than a silent partial success", async () => {
    const client = {
      from: () => ({
        upsert: () => ({
          select: async () => ({ data: null, error: { message: "relation does not exist" } }),
        }),
      }),
    };

    await expect(
      createSupabaseSeedGateway(client as never).upsert("blocks", [{ id: "x" }]),
    ).rejects.toThrow(/relation does not exist/);
  });

  it("sends no empty upsert at all", async () => {
    const calls: string[] = [];
    const gateway: SeedGateway = {
      upsert: async (table) => {
        calls.push(table);
        return 0;
      },
    };
    await createSupabaseSeedGateway({} as never); // constructor is pure
    await gateway.upsert("blocks", []);
    expect(calls).toEqual(["blocks"]);
  });
});

describe("helper formatting", () => {
  it("serialises a vector the way PostgREST requires", () => {
    expect(toVectorLiteral([0.1, -0.5, 1])).toBe("[0.1,-0.5,1]");
    expect(toVectorLiteral([Number.NaN])).toBe("[0]");
  });

  it("hashes deterministically and differs per input", () => {
    expect(contentHash("abc")).toBe(contentHash("abc"));
    expect(contentHash("abc")).not.toBe(contentHash("abd"));
  });
});
