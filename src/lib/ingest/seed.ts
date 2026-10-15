import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Embedder } from "@/lib/answer/provider";
import { DEMO_BLOCKS, DEMO_COURSE, type DemoBlockSpec } from "@/lib/demo/lesson";

/**
 * Seed/ingestion operation for the synthetic demo corpus.
 *
 * WHY THIS EXISTS
 *   The fixture corpus in `@/lib/demo/lesson` is only reachable in fixture mode.
 *   To exercise the real data path (policy decided in SQL, eligibility enforced
 *   by `horizon_is_eligible`) the same corpus has to be loaded into Supabase via
 *   the service-role client. This module builds those rows and this file is the
 *   only place that decides their shape.
 *
 * STATUS: EXECUTED AGAINST THE LIVE DATABASE (2026-10-15).
 *   `pnpm seed:demo` wrote 1 course, 6 resources and 18 blocks using one real
 *   `gemini-embedding-001` request, and re-reading the rows confirmed every
 *   vector is 768 values, all finite, none all-zero, labelled with the model
 *   that produced it. The row mapping and the guards below are ALSO covered by
 *   unit tests against a fake gateway.
 *
 *   This asserts nothing about answer quality: the answer path is still blocked
 *   by the provider's free-tier generation quota, so no claim here covers it.
 *
 * INTEGRITY GUARD
 *   Vectors are only ever written with the model and dimension that actually
 *   produced them. The offline lexical embedder is refused outright, because
 *   writing its output into `blocks.embedding` would label a lexical hash as a
 *   semantic embedding — exactly the misrepresentation the submission forbids.
 */

export const SEED_EMBEDDING_TASK = "RETRIEVAL_DOCUMENT" as const;

/** Provider ids that are NOT real embedding models and may never be persisted. */
const NON_SEMANTIC_EMBEDDER_PREFIXES = ["synthetic"];

export type SeedTable = "courses" | "resources" | "blocks";

export interface SeedPlan {
  course: Record<string, unknown>;
  resources: Record<string, unknown>[];
  blocks: Record<string, unknown>[];
  provenance: {
    embeddingModel: string;
    embeddingDimensions: number;
    blockCount: number;
    resourceCount: number;
    /** Technical string ids from the fixture, mapped to database uuids. */
    idMap: Record<string, string>;
  };
}

/** Raised when seeding is refused. Carries an operator-facing reason. */
export class SeedRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedRefused";
  }
}

export interface SeedGateway {
  upsert(table: SeedTable, rows: Record<string, unknown>[]): Promise<number>;
}

export interface SeedEmbeddingConfig {
  embedder: Embedder;
  /** The configured model name, recorded in `blocks.embedding_model`. */
  embeddingModel: string;
}

/**
 * Deterministic name-based uuid so re-running the seed is idempotent.
 *
 * The fixture uses human-readable ids (`b_0001`) but `blocks.id` is a uuid, so
 * each fixture id is hashed into a stable uuid. Re-running therefore upserts the
 * same rows instead of duplicating the corpus.
 */
export function stableUuid(name: string): string {
  const hex = createHash("sha256")
    .update(`horizon-seed-v1:${name}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20, 32),
  ].join("-");
}

export function contentHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** PostgREST cannot serialize pgvector, so vectors travel as `[a,b,c]`. */
export function toVectorLiteral(vector: number[]): string {
  return `[${vector.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;
}

function resourceIdFor(spec: DemoBlockSpec): string {
  return `resource:${spec.resourceId}`;
}

function blockIdFor(spec: DemoBlockSpec): string {
  return `block:${spec.id}`;
}

/**
 * Build every row the demo corpus needs, embedding the block text with the
 * configured model. Pure apart from the embedding call, so it is unit-testable
 * with a fake embedder.
 */
export async function buildSeedPlan(
  config: SeedEmbeddingConfig,
  specs: DemoBlockSpec[] = DEMO_BLOCKS,
): Promise<SeedPlan> {
  const { embedder, embeddingModel } = config;

  if (specs.length === 0) {
    throw new SeedRefused("The demo corpus is empty, so there is nothing to seed.");
  }

  const providerId = embedder.providerId.toLowerCase();
  if (NON_SEMANTIC_EMBEDDER_PREFIXES.some((prefix) => providerId.startsWith(prefix))) {
    throw new SeedRefused(
      `Refusing to seed: the active embedder is "${embedder.providerId}", which is a lexical placeholder, not a semantic model. ` +
        "Writing its vectors into blocks.embedding would label them as real semantic embeddings. " +
        "Configure the embedding credential (HORIZON_EMBEDDING_MODEL plus a provider key) and seed again.",
    );
  }

  const expectedDimensions = embedder.dimensions;
  const vectors = await embedder.embed(
    specs.map((spec) => spec.text),
    "document",
  );

  if (vectors.length !== specs.length) {
    throw new SeedRefused(
      `The embedder returned ${vectors.length} vectors for ${specs.length} blocks.`,
    );
  }

  const courseId = stableUuid(`course:${DEMO_COURSE.courseId}`);

  // Group blocks by their source resource so each resource is inserted once.
  const resourceGroups = new Map<string, DemoBlockSpec[]>();
  for (const spec of specs) {
    const group = resourceGroups.get(spec.resourceId);
    if (group) group.push(spec);
    else resourceGroups.set(spec.resourceId, [spec]);
  }

  const resourceRows: Record<string, unknown>[] = [];
  const resourceIdMap = new Map<string, string>();
  for (const [fixtureResourceId, group] of resourceGroups) {
    const id = stableUuid(resourceIdFor(group[0]));
    resourceIdMap.set(fixtureResourceId, id);

    const joined = group
      .map((spec) => spec.text)
      .sort()
      .join("\n");
    const hasCourseWide = group.some((spec) => spec.policy === "COURSE_WIDE");

    resourceRows.push({
      id,
      course_id: courseId,
      kind: group[0].resourceKind,
      title: `Sample demo resource — ${fixtureResourceId} (synthetic)`,
      storage_key: null,
      // `resources` has a unique (course_id, source_hash) constraint, so this
      // must differ per resource or the second upsert would collide.
      source_hash: contentHash(`${fixtureResourceId}:${joined}`),
      parser_version: "demo-fixture-v1",
      // The fixture is fully parsed by construction; nothing is visual-only.
      ingest_status: "INDEXED",
      extraction_coverage: 1,
      default_policy: hasCourseWide ? "COURSE_WIDE" : "TIMELINE_BOUND",
    });
  }

  const blockRows: Record<string, unknown>[] = specs.map((spec, index) => {
    const vector = vectors[index];
    if (!vector || vector.length !== expectedDimensions) {
      throw new SeedRefused(
        `Block ${spec.id} produced a vector of ${
          vector ? vector.length : 0
        } values, not the configured ${expectedDimensions}.`,
      );
    }

    return {
      id: stableUuid(blockIdFor(spec)),
      course_id: courseId,
      resource_id: resourceIdMap.get(spec.resourceId),
      block_type: spec.blockType,
      ordinal: index,
      text_original: spec.text,
      text_normalized: spec.text,
      start_seconds: spec.startSeconds,
      end_seconds: spec.endSeconds,
      page_number: spec.pageNumber,
      slide_number: spec.slideNumber,
      line_start: spec.lineStart,
      line_end: spec.lineEnd,
      frame_seconds: null,
      policy: spec.policy,
      review_state: spec.reviewState,
      lint_status: spec.lintStatus,
      ingest_status: spec.ingestStatus,
      unlock_seconds: spec.unlockSeconds,
      // The fixture is authored directly against the canonical timeline, so no
      // alignment estimate was made and no confidence is claimed.
      alignment_method: "authored_fixture",
      alignment_confidence: null,
      alignment_margin: null,
      policy_version: "v1",
      content_version: "v1",
      source_hash: contentHash(spec.text),
      embedding: toVectorLiteral(vector),
      embedding_model: embeddingModel,
      embedding_dim: vector.length,
      // `fts` is a generated column and must never be sent.
    };
  });

  const idMap: Record<string, string> = {
    [`course:${DEMO_COURSE.courseId}`]: courseId,
  };
  for (const [fixtureResourceId, id] of resourceIdMap) {
    idMap[`resource:${fixtureResourceId}`] = id;
  }
  for (const spec of specs) {
    idMap[`block:${spec.id}`] = stableUuid(blockIdFor(spec));
  }

  return {
    course: {
      id: courseId,
      owner_id: null,
      title: DEMO_COURSE.title,
      description:
        "Synthetic sample lesson used to demonstrate timestamp-scoped retrieval. Not real learner content.",
      duration_seconds: DEMO_COURSE.durationSeconds,
      content_version: "v1",
      policy_version: "v1",
      // The demo course is meant to be shown; it stays unreachable through the
      // anon key because RLS has no permissive policy.
      visibility: "public",
    },
    resources: resourceRows,
    blocks: blockRows,
    provenance: {
      embeddingModel,
      embeddingDimensions: expectedDimensions,
      blockCount: blockRows.length,
      resourceCount: resourceRows.length,
      idMap,
    },
  };
}

export interface SeedResult {
  courses: number;
  resources: number;
  blocks: number;
  provenance: SeedPlan["provenance"];
}

/**
 * Apply a plan through the supplied gateway. Upserts on primary key so a repeat
 * run converges rather than creating a second copy of the corpus.
 */
export async function applySeedPlan(
  gateway: SeedGateway,
  plan: SeedPlan,
): Promise<SeedResult> {
  const courses = await gateway.upsert("courses", [plan.course]);
  const resources = await gateway.upsert("resources", plan.resources);
  const blocks = await gateway.upsert("blocks", plan.blocks);

  return {
    courses,
    resources,
    blocks,
    provenance: plan.provenance,
  };
}

/** Build a SeedGateway from a Supabase service-role client. */
export function createSupabaseSeedGateway(client: SupabaseClient): SeedGateway {
  return {
    async upsert(table: SeedTable, rows: Record<string, unknown>[]): Promise<number> {
      if (rows.length === 0) return 0;
      const { data, error } = await client
        .from(table)
        .upsert(rows, { onConflict: "id" })
        .select("id");
      if (error) {
        throw new SeedRefused(
          `Seeding table "${table}" failed: ${error.message}. ` +
            "Confirm both migrations are applied and that the credential is the service-role key.",
        );
      }
      return Array.isArray(data) ? data.length : rows.length;
    },
  };
}
