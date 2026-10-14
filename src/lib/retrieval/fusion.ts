import type { EvidenceBlock, FusedEvidence, RankedHit } from "@/lib/retrieval/types";

/** Reciprocal rank fusion constant. */
export const RRF_K = 60;

/**
 * Fuse two already-ordered candidate lists.
 *
 * Both inputs must be ordered by their own branch score with a deterministic
 * tie-breaker, because ranks are assigned from list position here. The output
 * is ordered by fused score descending and then by block id ascending, so the
 * final top-k selection is deterministic.
 */
export function fuseRanked(
  fullTextHits: RankedHit[],
  vectorHits: RankedHit[],
  topK: number,
): FusedEvidence[] {
  const byId = new Map<
    string,
    { block: EvidenceBlock; ftsRank: number | null; vectorRank: number | null; fusedScore: number }
  >();

  const accumulate = (
    hits: RankedHit[],
    branch: "fts" | "vector",
  ): void => {
    hits.forEach((hit, index) => {
      const rank = index + 1;
      const contribution = 1 / (RRF_K + rank);
      const existing = byId.get(hit.block.id);
      if (existing) {
        existing.fusedScore += contribution;
        if (branch === "fts") existing.ftsRank = rank;
        else existing.vectorRank = rank;
        return;
      }
      byId.set(hit.block.id, {
        block: hit.block,
        ftsRank: branch === "fts" ? rank : null,
        vectorRank: branch === "vector" ? rank : null,
        fusedScore: contribution,
      });
    });
  };

  accumulate(fullTextHits, "fts");
  accumulate(vectorHits, "vector");

  return [...byId.values()]
    .sort((a, b) => {
      if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
      return a.block.id < b.block.id ? -1 : a.block.id > b.block.id ? 1 : 0;
    })
    .slice(0, Math.max(0, topK));
}
