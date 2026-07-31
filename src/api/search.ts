import { Router, Request, Response } from "express";
import { db, schema } from "../db/index.js";
import { embedQuery } from "../ingestion/embeddings.js";
import { patternComplete } from "../hippocampus/index.js";
import { markLabile } from "../reconsolidation/index.js";
import { eq, sql, and, ilike, or } from "drizzle-orm";

const router = Router();

interface SearchResult {
  id: number;
  content: string;
  source: string | null;
  sourceType: string | null;
  priority: number | null;
  resonanceScore: number | null;
  entities: string[] | null;
  semanticTags: string[] | null;
  score: number;
  scoreBreakdown: {
    cosine: number;
    textMatch: number;
    recency: number;
    resonance: number;
    priorityBoost: number;
    emotionalBoost: number;
    ca3Activation: number;
  };
}

/**
 * Hybrid search scoring:
 *   score = 0.5 * cosine_similarity
 *         + 0.2 * text_match
 *         + 0.15 * recency
 *         + 0.1 * resonance
 *         + 0.05 * priority_boost
 */
async function hybridSearch(
  agentId: number,
  query: string,
  limit = 10
): Promise<SearchResult[]> {
  // Get query embedding
  const queryEmbedding = await embedQuery(query);
  const embeddingStr = `[${queryEmbedding.join(",")}]`;
  const candidateLimit = Math.max(200, Math.min(1000, limit * 10));

  // Pull a bounded nearest-neighbor candidate set first. Scoring every active
  // memory forced a full scan and made Stormy's 70k+ corpus exceed interactive
  // timeouts despite the HNSW index.
  const results = await db.execute(sql`
    WITH candidates AS MATERIALIZED (
      SELECT id, content, source, source_type, priority, resonance_score,
             entities, semantic_tags, created_at, embedding
      FROM memory_nodes
      WHERE agent_id = ${agentId}
        AND status = 'active'
        AND embedding IS NOT NULL
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${candidateLimit}
    ), vector_scores AS (
      SELECT
        id,
        content,
        source,
        source_type,
        priority,
        resonance_score,
        entities,
        semantic_tags,
        created_at,
        1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
        CASE
          WHEN content ILIKE ${"%" + query + "%"} THEN 1.0
          ELSE 0.0
        END AS text_match,
        -- Recency: exponential decay, 30-day half-life
        EXP(-0.008 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS recency,
        -- Normalized resonance (0-1 scale, assuming max ~10)
        LEAST(resonance_score / 10.0, 1.0) AS norm_resonance,
        -- Priority boost: P0=1.0, P1=0.8, P2=0.5, P3=0.3, P4=0.1
        CASE priority
          WHEN 0 THEN 1.0
          WHEN 1 THEN 0.8
          WHEN 2 THEN 0.5
          WHEN 3 THEN 0.3
          WHEN 4 THEN 0.1
          ELSE 0.5
        END AS priority_boost
      FROM candidates
    )
    SELECT vs.*,
      COALESCE(ev.recall_boost, 0) AS emotional_boost,
      (0.45 * vs.cosine_sim
     + 0.18 * vs.text_match
     + 0.12 * vs.recency
     + 0.10 * vs.norm_resonance
     + 0.05 * vs.priority_boost
     + 0.10 * COALESCE(ev.recall_boost, 0)) AS hybrid_score
    FROM vector_scores vs
    LEFT JOIN emotional_valence ev ON ev.memory_id = vs.id
    ORDER BY hybrid_score DESC
    LIMIT ${limit}
  `);

  // ── CA3 Pattern Completion ──
  // Run autoassociative recall in parallel with hybrid results
  let ca3Results: Map<number, number> = new Map();
  if (process.env.CORTEX_CA3_RECALL_ENABLED !== "false") {
    try {
      const completions = await patternComplete(agentId, queryEmbedding, limit);
      for (const c of completions) {
        ca3Results.set(c.memoryId, c.activationScore);
      }
    } catch {
      // CA3 is additive — if it fails (e.g., no hippocampal codes yet), hybrid still works
    }
  }

  // NOTE (2026-04-10): Access-count telemetry and markLabile are now split
  // into two concerns with different failure semantics:
  //
  //   1. Access-count UPDATE — telemetry, best-effort, wrapped in try/catch
  //      so a failure is logged as non-fatal and the search response still
  //      succeeds (the user still gets their results).
  //
  //   2. markLabile() — CORE LEARNING MECHANISM. Opens the reconsolidation
  //      window so retrieved memories can be updated with new information.
  //      NOT wrapped in try/catch: if this ever starts failing, we want it
  //      LOUD, not silent. Silent markLabile failure is what caused the
  //      7+ day procedural memory stall in April 2026. Never again.
  //
  // Both paths use sql.raw with an explicit ARRAY literal because drizzle-orm
  // serializes JS number arrays as PostgreSQL composite ROW(...) types which
  // Postgres refuses to cast to int[]. allAccessIds are typed as number[]
  // from upstream SELECT rows, so no injection risk.
  const resultIds = (results.rows as Array<{ id: number }>).map((r) => r.id);
  const allAccessIds = [...new Set([...resultIds, ...ca3Results.keys()])];
  if (allAccessIds.length > 0) {
    // Access-count telemetry (best-effort, non-fatal)
    try {
      const idsLiteral = `ARRAY[${allAccessIds.join(",")}]::int[]`;
      await db.execute(sql`
        UPDATE memory_nodes
        SET access_count = access_count + 1,
            last_accessed_at = NOW()
        WHERE id = ANY(${sql.raw(idsLiteral)})
      `);
    } catch (err) {
      console.error("[search] access count update failed (non-fatal):", err);
    }

    // Mark recalled memories as labile for reconsolidation (CRITICAL — not wrapped)
    await markLabile(allAccessIds);
  }

  return (
    results.rows as Array<{
      id: number;
      content: string;
      source: string | null;
      source_type: string | null;
      priority: number | null;
      resonance_score: number | null;
      entities: string[] | null;
      semantic_tags: string[] | null;
      cosine_sim: number;
      text_match: number;
      recency: number;
      norm_resonance: number;
      priority_boost: number;
      emotional_boost: number;
      hybrid_score: number;
    }>
  ).map((row) => {
    // Blend CA3 activation into the score, BOUNDED. ca3Score (autoassociative
    // activation) is UNBOUNDED (~10-35); the old `ca3Score * 0.3` added +3..+10
    // onto a hybrid_score that maxes at 1.0, so a few high-activation memories
    // (often re-ingested stale chatter) dwarfed cosine/recency/resonance and
    // outranked the truly relevant hits. Saturate to [0,1) then weight modestly so
    // CA3 is an associative nudge/tiebreaker, not the dominant term.
    const ca3Score = ca3Results.get(row.id) || 0;
    const ca3Norm = ca3Score > 0 ? ca3Score / (ca3Score + 25) : 0; // saturating → [0,1)
    const ca3Boost = 0.15 * ca3Norm; // max +0.15, on the documented hybrid-weight scale
    // Authority override: a deliberate `system-update:` memory (an explicit RESOLVED/
    // correction note) gets a small bounded boost so the CURRENT truth outranks
    // superseded chatter on the topic it addresses — without deleting any history.
    // Bounded + only meaningful when the query is already topically relevant (the note's
    // cosine is high), so it cannot intrude on unrelated queries or dominate the ranker.
    const authorityBoost = (row.source || "").startsWith("system-update:") ? 0.15 : 0;
    const blendedScore = row.hybrid_score + ca3Boost + authorityBoost;

    return {
      id: row.id,
      content: row.content,
      source: row.source,
      sourceType: row.source_type,
      priority: row.priority,
      resonanceScore: row.resonance_score,
      entities: row.entities,
      semanticTags: row.semantic_tags,
      score: blendedScore,
      scoreBreakdown: {
        cosine: row.cosine_sim,
        textMatch: row.text_match,
        recency: row.recency,
        resonance: row.norm_resonance,
        priorityBoost: row.priority_boost,
        emotionalBoost: row.emotional_boost,
        ca3Activation: ca3Score || 0,
      },
    };
  })
  // Re-sort by blended score since CA3 may have changed rankings
  .sort((a, b) => b.score - a.score)
  .slice(0, limit);
}

/**
 * POST /api/v1/search
 * Body: { query, agentId, limit? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const { query, agentId, limit = 10 } = req.body;

    if (!query || !agentId) {
      res.status(400).json({ error: "query and agentId required" });
      return;
    }

    // Resolve agent
    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.externalId, agentId));

    if (!agent) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const results = await hybridSearch(agent.id, query, limit);

    res.json({
      query,
      agentId,
      resultCount: results.length,
      results,
    });
  } catch (err) {
    console.error("[search] Error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

export { router as searchRouter, hybridSearch };
