import type { SupabaseClient } from "@supabase/supabase-js";
import { isBlockEligible } from "@/lib/eligibility/predicate";
import { describeSource } from "@/lib/retrieval/source-label";
import type {
  CourseSummaryRecord,
  EvidenceBlock,
  EvidenceBoundary,
  EvidenceStore,
  RankedHit,
  ResourceKind,
} from "@/lib/retrieval/types";
import type {
  BlockType,
  IngestStatus,
  LintStatus,
  Policy,
  ReviewState,
} from "@/lib/contracts/domain";

/**
 * Database-backed evidence store.
 *
 * STATUS: the READ path has been EXECUTED against the live database
 * (2026-10-15). Against the seeded corpus, `listCourses`, `getCourse`,
 * `listEligible` at several boundaries, `searchFullText`, `searchVector` and
 * `hasMatchingIneligible` all ran for real, including a stored vector matching
 * itself at distance 0 and eligibility enforced twice (in SQL and again in
 * `isBlockEligible`).
 *
 * The WRITE paths this store feeds (turn persistence) are still UNEXERCISED,
 * because a turn is only written after a successful generation and every
 * generation is currently refused by the provider's free-tier quota. Unit tests
 * still use a fake SqlGateway for the mapping. Do not describe the answer path
 * as verified end to end.
 */

export class StoreFailure extends Error {
  readonly operation: string;

  constructor(operation: string, message: string) {
    super(message);
    this.name = "StoreFailure";
    this.operation = operation;
  }
}

export interface BlockRow {
  id: string;
  course_id: string;
  resource_id: string;
  block_type: string;
  text_normalized: string | null;
  /**
   * The source's own line breaks, preserved at ingest for transcript blocks.
   * Reading only: retrieval, prompts and quotations use `text_normalized`, whose
   * whitespace is collapsed. Optional because not every query selects it.
   */
  text_original?: string | null;
  start_seconds: number | string | null;
  end_seconds: number | string | null;
  page_number: number | null;
  slide_number: number | null;
  line_start: number | null;
  line_end: number | null;
  policy: string;
  review_state: string;
  lint_status: string;
  ingest_status: string;
  unlock_seconds: number | string | null;
  embedding?: string | number[] | null;
  resources?: { kind: string } | null;
}

export interface SqlGateway {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  selectBlocksByIds(ids: string[]): Promise<BlockRow[]>;
  selectCourse(
    courseId: string,
  ): Promise<{ id: string; title: string; duration_seconds: number | string } | null>;
  selectCourses(): Promise<
    Array<{ id: string; title: string; duration_seconds: number | string }>
  >;
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseEmbedding(value: BlockRow["embedding"]): number[] | null {
  if (value == null) return null;
  if (Array.isArray(value)) return value;
  const trimmed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (trimmed === "") return null;
  const parts = trimmed.split(",").map((part) => Number.parseFloat(part));
  return parts.every((part) => Number.isFinite(part)) ? parts : null;
}

export function mapBlockRow(row: BlockRow): EvidenceBlock {
  const block: EvidenceBlock = {
    id: row.id,
    courseId: row.course_id,
    resourceId: row.resource_id,
    resourceKind: (row.resources?.kind ?? "transcript") as ResourceKind,
    blockType: row.block_type as BlockType,
    text: row.text_normalized ?? "",
    textOriginal: row.text_original ?? null,
    startSeconds: toNumber(row.start_seconds),
    endSeconds: toNumber(row.end_seconds),
    pageNumber: row.page_number,
    slideNumber: row.slide_number,
    lineStart: row.line_start,
    lineEnd: row.line_end,
    policy: row.policy as Policy,
    reviewState: row.review_state as ReviewState,
    lintStatus: row.lint_status as LintStatus,
    ingestStatus: row.ingest_status as IngestStatus,
    unlockSeconds: toNumber(row.unlock_seconds),
    embedding: parseEmbedding(row.embedding),
    sourceLabel: "",
  };
  block.sourceLabel = describeSource(block);
  return block;
}

export class SupabaseEvidenceStore implements EvidenceStore {
  readonly mode = "supabase" as const;
  readonly demoContent = false;

  constructor(private readonly gateway: SqlGateway) {}

  private isEligible(block: EvidenceBlock, boundary: EvidenceBoundary): boolean {
    return isBlockEligible(
      {
        courseId: block.courseId,
        ingestStatus: block.ingestStatus,
        policy: block.policy,
        reviewState: block.reviewState,
        lintStatus: block.lintStatus,
        unlockSeconds: block.unlockSeconds,
      },
      { courseId: boundary.courseId, boundarySeconds: boundary.boundarySeconds },
    );
  }

  async getCourse(courseId: string): Promise<CourseSummaryRecord | null> {
    const row = await this.gateway.selectCourse(courseId);
    if (!row) return null;
    return {
      courseId: row.id,
      title: row.title,
      durationSeconds: toNumber(row.duration_seconds) ?? 0,
      demoContent: false,
    };
  }

  async listCourses(): Promise<CourseSummaryRecord[]> {
    const rows = await this.gateway.selectCourses();
    return rows.map((row) => ({
      courseId: row.id,
      title: row.title,
      durationSeconds: toNumber(row.duration_seconds) ?? 0,
      demoContent: false,
    }));
  }

  async listEligible(boundary: EvidenceBoundary, limit: number): Promise<EvidenceBlock[]> {
    const rows = await this.gateway.rpc<BlockRow[]>("horizon_list_eligible", {
      p_course_id: boundary.courseId,
      p_boundary: boundary.boundarySeconds,
      p_limit: limit,
    });
    return rows
      .map(mapBlockRow)
      .filter((block) => this.isEligible(block, boundary))
      .slice(0, Math.max(0, limit));
  }

  async searchFullText(
    boundary: EvidenceBoundary,
    query: string,
    limit: number,
  ): Promise<RankedHit[]> {
    const rows = await this.gateway.rpc<Array<{ block_id: string; score: number | string }>>(
      "horizon_search_fts",
      {
        p_course_id: boundary.courseId,
        p_boundary: boundary.boundarySeconds,
        p_query: query,
        p_limit: limit,
      },
    );
    return this.hydrate(
      rows.map((row) => ({ id: row.block_id, score: toNumber(row.score) ?? 0 })),
      boundary,
    );
  }

  async searchVector(
    boundary: EvidenceBoundary,
    embedding: number[],
    limit: number,
  ): Promise<RankedHit[]> {
    const rows = await this.gateway.rpc<Array<{ block_id: string; distance: number | string }>>(
      "horizon_search_vector",
      {
        p_course_id: boundary.courseId,
        p_boundary: boundary.boundarySeconds,
        p_embedding: JSON.stringify(embedding),
        p_limit: limit,
      },
    );
    // Distance is ascending; the store returns best-first, so negate it and
    // keep the SQL order rather than re-sorting here.
    return this.hydrate(
      rows.map((row) => ({ id: row.block_id, score: -(toNumber(row.distance) ?? 0) })),
      boundary,
    );
  }

  async getBlocksByIds(
    boundary: EvidenceBoundary,
    ids: string[],
  ): Promise<EvidenceBlock[]> {
    if (ids.length === 0) return [];
    const rows = await this.gateway.selectBlocksByIds(ids);
    return rows
      .map(mapBlockRow)
      .filter((block) => block.courseId === boundary.courseId)
      .filter((block) => this.isEligible(block, boundary));
  }

  async hasMatchingIneligible(
    boundary: EvidenceBoundary,
    query: string,
  ): Promise<boolean> {
    return this.gateway.rpc<boolean>("horizon_has_matching_ineligible", {
      p_course_id: boundary.courseId,
      p_boundary: boundary.boundarySeconds,
      p_query: query,
    });
  }

  /** Fetch full blocks for ordered hits, preserving the branch order. */
  private async hydrate(
    hits: Array<{ id: string; score: number }>,
    boundary: EvidenceBoundary,
  ): Promise<RankedHit[]> {
    if (hits.length === 0) return [];
    const rows = await this.gateway.selectBlocksByIds(hits.map((hit) => hit.id));
    const byId = new Map(rows.map((row) => [row.id, mapBlockRow(row)]));

    const result: RankedHit[] = [];
    for (const hit of hits) {
      const block = byId.get(hit.id);
      if (!block) continue;
      if (block.courseId !== boundary.courseId) continue;
      if (!this.isEligible(block, boundary)) continue;
      result.push({ block, score: hit.score });
    }
    return result;
  }
}

/**
 * Does this error mean "the key cannot identify a row" rather than "something
 * went wrong"?
 *
 * A `uuid` primary key rejects a value that is not a uuid with PostgreSQL's
 * 22P02 (`invalid_text_representation`). That id cannot possibly match a row, so
 * the honest answer is "no such record". Previously it surfaced as a StoreFailure
 * and every route that calls `getCourse` first turned it into HTTP 500, which
 * mislabels a client mistake as a server fault.
 *
 * ONLY this exact code is translated. A connection failure, a permissions error
 * or a missing table must still surface as a failure — mapping those to "not
 * found" would hide a broken deployment behind a 404.
 *
 * Verified against the live database: a malformed id returns 22P02 and a real id
 * returns no error at all.
 */
function isUnmatchedKeyError(error: { code?: string } | null): boolean {
  return error?.code === "22P02";
}

/** Build a SqlGateway from a Supabase service-role client. */
export function createSupabaseGateway(client: SupabaseClient): SqlGateway {
  const BLOCK_COLUMNS = [
    "id",
    "course_id",
    "resource_id",
    "block_type",
    "text_normalized",
    "text_original",
    "start_seconds",
    "end_seconds",
    "page_number",
    "slide_number",
    "line_start",
    "line_end",
    "policy",
    "review_state",
    "lint_status",
    "ingest_status",
    "unlock_seconds",
    "resources(kind)",
  ].join(", ");

  return {
    async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
      const { data, error } = await client.rpc(fn, args);
      if (error) {
        throw new StoreFailure(fn, `Database function ${fn} failed.`);
      }
      return data as T;
    },
    async selectBlocksByIds(ids: string[]): Promise<BlockRow[]> {
      const { data, error } = await client
        .from("blocks")
        .select(BLOCK_COLUMNS)
        .in("id", ids);
      if (error) {
        throw new StoreFailure("select_blocks", "Could not load evidence blocks.");
      }
      return (data ?? []) as unknown as BlockRow[];
    },
    async selectCourses() {
      const { data, error } = await client
        .from("courses")
        .select("id, title, duration_seconds")
        .order("created_at", { ascending: true });
      if (error) {
        throw new StoreFailure("select_courses", "Could not load courses.");
      }
      return (data ?? []) as Array<{
        id: string;
        title: string;
        duration_seconds: number | string;
      }>;
    },
    async selectCourse(courseId: string) {
      const { data, error } = await client
        .from("courses")
        .select("id, title, duration_seconds")
        .eq("id", courseId)
        .maybeSingle();
      // An id that cannot be a uuid is a client mistake, so it is reported as
      // "no such course" and the route answers 404. Every route checks the
      // course BEFORE any other call, so handling it here is enough: no other
      // query can be reached with a malformed id.
      if (isUnmatchedKeyError(error)) return null;
      if (error) {
        throw new StoreFailure("select_course", "Could not load the course.");
      }
      return (data ?? null) as { id: string; title: string; duration_seconds: number | string } | null;
    },
  };
}
