import { db, schema } from "../db/index.js";
import { eq, sql } from "drizzle-orm";
import { sparseOverlap } from "../hippocampus/index.js";
import type { SparseCode } from "../hippocampus/types.js";
import "dotenv/config";

interface DreamStats {
  phase1_resonanceUpdated: number;
  phase2_memoriesDeleted: number;
  phase2_memoriesArchived: number;
  phase2_synapsesPruned: number;
  phase2_observationsPruned?: number;
  phase3_clustersFound: number;
  phase3_consolidations: number;
  phase3_synapsesStrengthened: number;
  phase4_nodesActivated: number;
  phase4_novelSynapses: number;
  phase5_synthesesCreated?: number;
  totalDurationMs: number;
}

/**
 * CORTEX Dream Cycle — Two-phase synthetic sleep.
 *
 * SWS (Slow-Wave Sleep): Memory maintenance and consolidation
 *   Phase 1: Resonance Analysis — Score all active memories (Ebbinghaus stability-adjusted)
 *   Phase 2: Pruning — Delete/archive low-resonance memories
 *   Phase 3: Consolidation — Cluster + summarize high-resonance groups
 *
 * REM (Rapid Eye Movement): Creative association and synthesis
 *   Phase 4: Free Association — Random activation for novel connections
 *   Phase 5: Synthesis — Generate insights from novel synapses
 *
 * Cycle types: "full" (SWS + REM), "sws_only", "rem_only",
 *              "resonance_only", "pruning_only", "consolidation_only"
 *
 * Source: Two-phase sleep consolidation (Computational Account of Dreaming, 2009)
 */
export async function runDreamCycle(
  agentId: number,
  cycleType: string = "full"
): Promise<DreamStats> {
  const startTime = Date.now();

  console.log(`[dream] Starting ${cycleType} dream cycle for agent ${agentId}`);

  // Create log entry
  const [logEntry] = await db
    .insert(schema.dreamCycleLogs)
    .values({
      agentId,
      cycleType,
      stats: {},
      insightsDiscovered: [],
    })
    .returning();

  const stats: DreamStats = {
    phase1_resonanceUpdated: 0,
    phase2_memoriesDeleted: 0,
    phase2_memoriesArchived: 0,
    phase2_synapsesPruned: 0,
    phase3_clustersFound: 0,
    phase3_consolidations: 0,
    phase3_synapsesStrengthened: 0,
    phase4_nodesActivated: 0,
    phase4_novelSynapses: 0,
    phase5_synthesesCreated: 0,
    totalDurationMs: 0,
  };

  const insights: Array<{ type: string; description: string }> = [];

  const runSws = cycleType === "full" || cycleType === "sws_only";
  const runRem = cycleType === "full" || cycleType === "rem_only";

  try {
    // ═══ SWS (Slow-Wave Sleep): Memory maintenance & consolidation ═══
    if (runSws || cycleType === "resonance_only" || cycleType === "pruning_only" || cycleType === "consolidation_only") {
      if (runSws) console.log("[dream] ═══ SWS Phase (Slow-Wave Sleep) ═══");

      // ─── Phase 1: Resonance Analysis ──────────────────────
      if (runSws || cycleType === "resonance_only") {
        console.log("[dream] Phase 1 [SWS]: Resonance Analysis");
        stats.phase1_resonanceUpdated = await phaseResonanceAnalysis(agentId);
      }

      // ─── Phase 2: Pruning ─────────────────────────────────
      if (runSws || cycleType === "pruning_only") {
        console.log("[dream] Phase 2 [SWS]: Pruning");
        const pruneResult = await phasePruning(agentId);
        stats.phase2_memoriesDeleted = pruneResult.deleted;
        stats.phase2_memoriesArchived = pruneResult.archived;
        stats.phase2_synapsesPruned = pruneResult.synapsesPruned;
        stats.phase2_observationsPruned = pruneResult.observationsPruned;
      }

      // ─── Phase 3: Consolidation ───────────────────────────
      if (runSws || cycleType === "consolidation_only") {
        console.log("[dream] Phase 3 [SWS]: Consolidation");
        const consolidateResult = await phaseConsolidation(agentId);
        stats.phase3_clustersFound = consolidateResult.clustersFound;
        stats.phase3_consolidations = consolidateResult.consolidations;
        stats.phase3_synapsesStrengthened = consolidateResult.synapsesStrengthened;
        insights.push(...consolidateResult.insights);
      }
    }

    // ═══ REM (Rapid Eye Movement): Creative association & synthesis ═══
    if (runRem) {
      console.log("[dream] ═══ REM Phase (Rapid Eye Movement) ═══");

      // ─── Phase 4: Free Association ────────────────────────
      console.log("[dream] Phase 4 [REM]: Free Association");
      const freeAssocResult = await phaseFreeAssociation(agentId);
      stats.phase4_nodesActivated = freeAssocResult.nodesActivated;
      stats.phase4_novelSynapses = freeAssocResult.novelSynapses;
      insights.push(...freeAssocResult.insights);

      // ─── Phase 5: Synthesis ────────────────────────────
      console.log("[dream] Phase 5 [REM]: Synthesis");
      const synthesisResult = await phaseSynthesis(agentId, 72);
      stats.phase5_synthesesCreated = synthesisResult.synthesesCreated;
      insights.push(...synthesisResult.insights);
    }

    stats.totalDurationMs = Date.now() - startTime;

    // Update log entry
    await db
      .update(schema.dreamCycleLogs)
      .set({
        stats,
        insightsDiscovered: insights,
        completedAt: new Date(),
      })
      .where(eq(schema.dreamCycleLogs.id, logEntry.id));

    console.log(
      `[dream] Dream cycle complete in ${(stats.totalDurationMs / 1000).toFixed(1)}s`,
      stats
    );
  } catch (err) {
    console.error("[dream] Dream cycle error:", err);
    await db
      .update(schema.dreamCycleLogs)
      .set({
        stats: { ...stats, error: String(err) },
        completedAt: new Date(),
      })
      .where(eq(schema.dreamCycleLogs.id, logEntry.id));
  }

  return stats;
}

/**
 * Phase 1: Resonance Analysis — Ebbinghaus Stability-Adjusted Decay
 *
 * Uses stability-adjusted forgetting curve instead of simple exponential decay.
 * The more a memory has been accessed and connected, the slower it decays.
 *
 * stability = 1 + (0.3 * ln(access_count + 1)) + (0.2 * connectivity_score)
 * decay = exp(-0.023 * days_old / stability)
 *
 * Resonance = 0.2 * decay (Ebbinghaus stability-adjusted)
 *           + 0.2 * frequency (log scale)
 *           + 0.3 * connectivity (sum synapse strengths)
 *           + 0.2 * priority_weight
 *           + 0.1 * feedback (access frequency as proxy)
 *
 * Source: Ebbinghaus forgetting curve with stability (Memory-Augmented Transformers, Huawei 2025)
 */
async function phaseResonanceAnalysis(agentId: number): Promise<number> {
  const result = await db.execute(sql`
    WITH synapse_strength AS (
      SELECT
        mn.id,
        COALESCE(SUM(ms.connection_strength), 0) AS total_strength,
        LEAST(COALESCE(SUM(ms.connection_strength), 0) / 5.0, 1.0) AS connectivity_score
      FROM memory_nodes mn
      LEFT JOIN memory_synapses ms
        ON (ms.memory_a = mn.id OR ms.memory_b = mn.id)
      WHERE mn.agent_id = ${agentId} AND mn.status = 'active'
      GROUP BY mn.id
    )
    UPDATE memory_nodes mn
    SET resonance_score = (
      0.15 * EXP(
        -0.023 * EXTRACT(EPOCH FROM (NOW() - mn.created_at)) / 86400
        / (1.0 + 0.3 * LN(mn.access_count + 1) + 0.2 * ss.connectivity_score)
      )
      + 0.2 * LN(mn.access_count + 1)
      + 0.25 * ss.connectivity_score
      + 0.2 * CASE mn.priority
          WHEN 0 THEN 1.0
          WHEN 1 THEN 0.8
          WHEN 2 THEN 0.5
          WHEN 3 THEN 0.3
          WHEN 4 THEN 0.1
          ELSE 0.5
        END
      + 0.1 * LEAST(mn.access_count / 10.0, 1.0)
      + 0.1 * COALESCE(mn.novelty_score, 0.5)
    ) * 10.0,
    updated_at = NOW()
    FROM synapse_strength ss
    WHERE mn.id = ss.id
      AND mn.agent_id = ${agentId}
      AND mn.status = 'active'
  `);

  const count = Number((result as { rowCount?: number }).rowCount || 0);
  console.log(`[dream] Phase 1: Updated resonance for ${count} memories (Ebbinghaus stability-adjusted decay)`);
  return count;
}

/**
 * Phase 2: Pruning — Adaptive percentile-based strategy
 *
 * Instead of hardcoded thresholds, compute pruning boundaries from the agent's
 * actual resonance distribution. This prevents over-pruning in sparse corpora
 * and under-pruning in dense ones.
 *
 * Tier 1: resonance < P5 (bottom 5%) AND age > 30 days → DELETE
 * Tier 2: resonance < P15 (bottom 15%) AND age > 14 days → ARCHIVE
 * Tier 3: synapse strength < 0.1 → DELETE synapse
 * Tier 4: ephemeral observations > 7 days → DELETE
 *
 * Floors: delete threshold never above 2.0, archive threshold never above 4.0
 * (prevents catastrophic pruning if distribution skews high)
 *
 * P0/P1 memories are NEVER pruned.
 */
async function phasePruning(agentId: number): Promise<{
  deleted: number;
  archived: number;
  synapsesPruned: number;
  observationsPruned: number;
}> {
  // Compute adaptive thresholds from resonance distribution
  const percentilesResult = await db.execute(sql`
    SELECT
      PERCENTILE_CONT(0.05) WITHIN GROUP (ORDER BY resonance_score) AS p5,
      PERCENTILE_CONT(0.15) WITHIN GROUP (ORDER BY resonance_score) AS p15,
      COUNT(*) AS total
    FROM memory_nodes
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND priority > 1
  `);

  const pRow = percentilesResult.rows[0] as { p5: number; p15: number; total: string } | undefined;
  // Adaptive thresholds with safety floors
  const deleteThreshold = Math.min(Number(pRow?.p5 ?? 1.0), 2.0);
  const archiveThreshold = Math.min(Number(pRow?.p15 ?? 3.0), 4.0);

  console.log(
    `[dream] Phase 2: Adaptive thresholds — delete < ${deleteThreshold.toFixed(2)} (P5), archive < ${archiveThreshold.toFixed(2)} (P15), corpus: ${pRow?.total ?? 0} eligible memories`
  );

  // Tier 1: Delete bottom 5% resonance, old memories (exclude P0/P1 AND emotionally salient)
  const deleteResult = await db.execute(sql`
    UPDATE memory_nodes mn
    SET status = 'deleted', updated_at = NOW()
    WHERE mn.agent_id = ${agentId}
      AND mn.status = 'active'
      AND mn.priority > 1
      AND mn.resonance_score < ${deleteThreshold}
      AND mn.created_at < NOW() - INTERVAL '30 days'
      AND NOT EXISTS (
        SELECT 1 FROM emotional_valence ev
        WHERE ev.memory_id = mn.id AND ev.decay_resistance > 0.5
      )
  `);
  const deleted = Number((deleteResult as { rowCount?: number }).rowCount || 0);

  // Tier 2: Archive bottom 15% resonance, moderately old memories (exclude P0/P1 AND emotionally salient)
  const archiveResult = await db.execute(sql`
    UPDATE memory_nodes mn
    SET status = 'archived', updated_at = NOW()
    WHERE mn.agent_id = ${agentId}
      AND mn.status = 'active'
      AND mn.priority > 1
      AND mn.resonance_score < ${archiveThreshold}
      AND mn.created_at < NOW() - INTERVAL '14 days'
      AND NOT EXISTS (
        SELECT 1 FROM emotional_valence ev
        WHERE ev.memory_id = mn.id AND ev.decay_resistance > 0.4
      )
  `);
  const archived = Number(
    (archiveResult as { rowCount?: number }).rowCount || 0
  );

  // Tier 3: Prune weak synapses
  //   First apply decay to all synapses
  await db.execute(sql`
    UPDATE memory_synapses
    SET connection_strength = connection_strength * (1.0 - decay_rate)
    WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
       OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
  `);

  //   Then delete synapses below threshold
  const synapseResult = await db.execute(sql`
    DELETE FROM memory_synapses
    WHERE connection_strength < 0.1
      AND (memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
        OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId}))
  `);
  const synapsesPruned = Number(
    (synapseResult as { rowCount?: number }).rowCount || 0
  );

  // Tier 4: Aggressively prune screen observations older than 7 days (ephemeral context)
  const observationResult = await db.execute(sql`
    UPDATE memory_nodes
    SET status = 'deleted', updated_at = NOW()
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND source_type = 'observation'
      AND created_at < NOW() - INTERVAL '7 days'
  `);
  const observationsPruned = Number((observationResult as { rowCount?: number }).rowCount || 0);

  console.log(
    `[dream] Phase 2: Deleted ${deleted}, archived ${archived}, pruned ${synapsesPruned} synapses, ${observationsPruned} observations`
  );

  return { deleted, archived, synapsesPruned, observationsPruned };
}

/**
 * Phase 3: Consolidation
 *
 * Find high-resonance clusters (>7.0) via connected components on synapse graph.
 * Generate abstract summary per cluster.
 * Strengthen intra-cluster synapses by +0.2.
 */
async function phaseConsolidation(agentId: number): Promise<{
  clustersFound: number;
  consolidations: number;
  synapsesStrengthened: number;
  insights: Array<{ type: string; description: string }>;
}> {
  const insights: Array<{ type: string; description: string }> = [];

  // Find high-resonance nodes (top tier — adaptive threshold)
  // Use top 3% or resonance >= 5.0, whichever captures more
  const highResonanceNodes = await db.execute(sql`
    SELECT id, content, resonance_score, entities, semantic_tags
    FROM memory_nodes
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND resonance_score >= 5.0
    ORDER BY resonance_score DESC
    LIMIT 300
  `);

  const nodes = highResonanceNodes.rows as Array<{
    id: number;
    content: string;
    resonance_score: number;
    entities: string[];
    semantic_tags: string[];
  }>;

  if (nodes.length < 2) {
    console.log("[dream] Phase 3: Not enough high-resonance nodes for consolidation");
    return { clustersFound: 0, consolidations: 0, synapsesStrengthened: 0, insights };
  }

  // Build adjacency list from synapses between these nodes
  const nodeIds = nodes.map((n) => n.id);
  const nodeIdSet = new Set(nodeIds);

  // Fetch synapses in batches to avoid array cast issues
  const allSynapseRows: Array<{ memory_a: number; memory_b: number; connection_strength: number }> = [];
  const CHUNK = 50;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);
    const result = await db.execute(sql`
      SELECT memory_a, memory_b, connection_strength
      FROM memory_synapses
      WHERE memory_a IN (${sql.join(chunk.map(id => sql`${id}`), sql`,`)})
        AND connection_strength > 0.3
    `);
    for (const row of result.rows as Array<{ memory_a: number; memory_b: number; connection_strength: number }>) {
      if (nodeIdSet.has(row.memory_b)) {
        allSynapseRows.push(row);
      }
    }
  }
  const synapses = { rows: allSynapseRows };

  // Union-Find for connected components
  const parent = new Map<number, number>();
  const rank = new Map<number, number>();

  function find(x: number): number {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  }

  function union(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    const rankA = rank.get(ra) || 0;
    const rankB = rank.get(rb) || 0;
    if (rankA < rankB) {
      parent.set(ra, rb);
    } else if (rankA > rankB) {
      parent.set(rb, ra);
    } else {
      parent.set(rb, ra);
      rank.set(ra, rankA + 1);
    }
  }

  // Initialize all nodes
  for (const node of nodes) find(node.id);

  // Union connected nodes
  for (const syn of synapses.rows as Array<{
    memory_a: number;
    memory_b: number;
    connection_strength: number;
  }>) {
    union(syn.memory_a, syn.memory_b);
  }

  // Group into clusters
  const clusters = new Map<number, number[]>();
  for (const node of nodes) {
    const root = find(node.id);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(node.id);
  }

  // Filter to clusters with 3+ members, cap at 50 per cluster for performance
  const significantClusters = Array.from(clusters.values())
    .filter((c) => c.length >= 3)
    .map((c) => c.slice(0, 50)); // Cap cluster size

  let consolidations = 0;
  let synapsesStrengthened = 0;

  for (const cluster of significantClusters) {
    const clusterSet = new Set(cluster);
    const clusterNodes = nodes.filter((n) => clusterSet.has(n.id));

    const allEntities = [
      ...new Set(clusterNodes.flatMap((n) => n.entities || [])),
    ];
    const allTags = [
      ...new Set(clusterNodes.flatMap((n) => n.semantic_tags || [])),
    ];
    const avgResonance =
      clusterNodes.reduce((s, n) => s + n.resonance_score, 0) /
      clusterNodes.length;

    // Generate abstractive summary via LLM (falls back to extractive if LLM unavailable)
    let summary: string;
    try {
      const { llmComplete } = await import("../lib/llm.js");
      const contentSnippets = clusterNodes
        .slice(0, 8)
        .map((n, i) => `[${i + 1}] ${n.content.slice(0, 300)}`)
        .join("\n");

      const llmResult = await llmComplete(
        [
          {
            role: "user",
            content: `These ${clusterNodes.length} memories form a connected cluster in an AI agent's long-term memory. Synthesize them into 1-2 sentences of actual insight. What pattern or conclusion emerges? Do not list entities or tags. Write the insight directly.\n\n${contentSnippets}`,
          },
        ],
        { maxTokens: 150, temperature: 0.3 }
      );
      summary = llmResult.content.trim();
      console.log(`[dream] Phase 3: LLM summary for cluster of ${clusterNodes.length}: "${summary.slice(0, 100)}..."`);
    } catch {
      // Fallback to extractive summary if LLM unavailable
      summary = `[Consolidated cluster of ${clusterNodes.length} memories] Entities: ${allEntities.slice(0, 20).join(", ")}. Tags: ${allTags.slice(0, 10).join(", ")}. Avg resonance: ${avgResonance.toFixed(1)}.`;
      console.log(`[dream] Phase 3: LLM unavailable, using extractive summary`);
    }

    // Store consolidation as cognitive artifact
    await db.insert(schema.cognitiveArtifacts).values({
      agentId,
      artifactType: "insight",
      content: {
        type: "consolidation",
        summary,
        memberCount: clusterNodes.length,
        memberIds: cluster,
        entities: allEntities.slice(0, 30),
        tags: allTags.slice(0, 15),
        avgResonance,
      },
      resonanceScore: avgResonance,
    });
    consolidations++;

    // Strengthen intra-cluster synapses in batch (one query per cluster member)
    for (const nodeId of cluster) {
      const result = await db.execute(sql`
        UPDATE memory_synapses
        SET connection_strength = LEAST(connection_strength + 0.2, 1.0),
            activation_count = activation_count + 1,
            last_activated_at = NOW()
        WHERE (memory_a = ${nodeId} OR memory_b = ${nodeId})
          AND (memory_a IN (${sql.join(cluster.map(id => sql`${id}`), sql`,`)})
            OR memory_b IN (${sql.join(cluster.map(id => sql`${id}`), sql`,`)}))
      `);
      synapsesStrengthened += Number((result as { rowCount?: number }).rowCount || 0);
    }

    insights.push({
      type: "consolidation",
      description: `Cluster of ${clusterNodes.length} memories around: ${allEntities.slice(0, 5).join(", ")}`,
    });
  }

  console.log(
    `[dream] Phase 3: ${significantClusters.length} clusters, ${consolidations} consolidations, ${synapsesStrengthened} synapses strengthened`
  );

  return {
    clustersFound: significantClusters.length,
    consolidations,
    synapsesStrengthened,
    insights,
  };
}

/**
 * Phase 4: Free Association (Hallucination Dump)
 *
 * Random activation of 50 memory nodes.
 * Check pairwise similarity for novel connections (0.6-0.85 range).
 * Create new weak synapses for discoveries.
 */
async function phaseFreeAssociation(agentId: number): Promise<{
  nodesActivated: number;
  novelSynapses: number;
  insights: Array<{ type: string; description: string }>;
}> {
  const insights: Array<{ type: string; description: string }> = [];

  // Randomly select 50 active nodes
  const randomNodes = await db.execute(sql`
    SELECT id, content, embedding, entities
    FROM memory_nodes
    WHERE agent_id = ${agentId}
      AND status = 'active'
      AND embedding IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 50
  `);

  const nodes = randomNodes.rows as Array<{
    id: number;
    content: string;
    embedding: string;
    entities: string[];
  }>;

  if (nodes.length < 2) {
    return { nodesActivated: 0, novelSynapses: 0, insights };
  }

  let novelSynapses = 0;

  // Check pairwise similarity for a sample of pairs
  // (full pairwise on 50 nodes = 1225 pairs — sample ~100)
  const pairs: [number, number][] = [];
  for (let i = 0; i < Math.min(nodes.length, 50); i++) {
    for (let j = i + 1; j < Math.min(nodes.length, 50); j++) {
      pairs.push([i, j]);
    }
  }

  // Shuffle and take first 200
  for (let i = pairs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
  }
  const sampledPairs = pairs.slice(0, 400);

  for (const [i, j] of sampledPairs) {
    const nodeA = nodes[i];
    const nodeB = nodes[j];

    // Compute cosine similarity via pgvector
    const [simResult] = (
      await db.execute(sql`
      SELECT 1 - (a.embedding <=> b.embedding) AS similarity
      FROM memory_nodes a, memory_nodes b
      WHERE a.id = ${nodeA.id} AND b.id = ${nodeB.id}
    `)
    ).rows as Array<{ similarity: number }>;

    const similarity = simResult?.similarity || 0;

    // Novel connection range: 0.45-0.9
    // Widened 2026-06-23: corpus grew broad/diverse (avg pair sim ~0.32), so the
    // old 0.6-0.85 band qualified only ~0.3% of pairs and starved synthesis.
    if (similarity >= 0.45 && similarity <= 0.9) {
      // Check if a semantic synapse already exists (other types don't block novel discovery)
      const existing = await db.execute(sql`
        SELECT id FROM memory_synapses
        WHERE memory_a = ${Math.min(nodeA.id, nodeB.id)}
          AND memory_b = ${Math.max(nodeA.id, nodeB.id)}
          AND connection_type = 'semantic'
        LIMIT 1
      `);

      if (existing.rows.length === 0) {
        // Create weak synapse
        const [memA, memB] = [
          Math.min(nodeA.id, nodeB.id),
          Math.max(nodeA.id, nodeB.id),
        ];

        await db
          .insert(schema.memorySynapses)
          .values({
            memoryA: memA,
            memoryB: memB,
            connectionType: "semantic",
            connectionStrength: 0.2 + (similarity - 0.45) * 0.3, // 0.20-0.34, recalibrated for the widened 0.45-0.9 band (stays in Phase 5's 0.2-0.4 window)
            decayRate: 0.02,
          })
          .onConflictDoNothing();

        novelSynapses++;

        if (novelSynapses <= 3) {
          insights.push({
            type: "free_association",
            description: `Novel connection discovered: "${nodeA.content.slice(0, 80)}..." ↔ "${nodeB.content.slice(0, 80)}..." (similarity: ${similarity.toFixed(3)})`,
          });
        }
      }
    }
  }

  // ── Sparse-space novel connections ──
  // Find connections that are distant in dense space but overlapping in sparse DG space.
  // These are the most interesting discoveries: structurally similar but semantically divergent.
  try {
    const sparseNodes = await db.execute(sql`
      SELECT hc.memory_id, hc.sparse_indices, hc.sparse_values,
             mn.content
      FROM hippocampal_codes hc
      JOIN memory_nodes mn ON mn.id = hc.memory_id
      WHERE hc.agent_id = ${agentId}
        AND mn.status = 'active'
      ORDER BY RANDOM()
      LIMIT 30
    `);

    const sNodes = sparseNodes.rows as Array<{
      memory_id: number;
      sparse_indices: number[];
      sparse_values: number[];
      content: string;
    }>;

    for (let i = 0; i < sNodes.length; i++) {
      for (let j = i + 1; j < Math.min(i + 5, sNodes.length); j++) {
        const a: SparseCode = { indices: sNodes[i].sparse_indices, values: sNodes[i].sparse_values, dim: 4096 };
        const b: SparseCode = { indices: sNodes[j].sparse_indices, values: sNodes[j].sparse_values, dim: 4096 };
        const overlap = sparseOverlap(a, b);

        // Interesting range: moderate sparse overlap (0.15-0.45) suggests structural similarity
        if (overlap >= 0.15 && overlap <= 0.45) {
          const memA = Math.min(sNodes[i].memory_id, sNodes[j].memory_id);
          const memB = Math.max(sNodes[i].memory_id, sNodes[j].memory_id);

          const existing = await db.execute(sql`
            SELECT id FROM memory_synapses
            WHERE memory_a = ${memA} AND memory_b = ${memB} AND connection_type = 'semantic'
            LIMIT 1
          `);

          if (existing.rows.length === 0) {
            await db
              .insert(schema.memorySynapses)
              .values({
                memoryA: memA,
                memoryB: memB,
                connectionType: "semantic",
                connectionStrength: 0.15 + overlap * 0.3,
                decayRate: 0.02,
              })
              .onConflictDoNothing();
            novelSynapses++;
          }
        }
      }
    }
  } catch (err) {
    // Sparse association is additive — don't fail the dream cycle
    console.warn("[dream] Phase 4: Sparse association error (non-fatal):", err);
  }

  console.log(
    `[dream] Phase 4: Activated ${nodes.length} nodes, created ${novelSynapses} novel synapses (dense + sparse)`
  );

  return { nodesActivated: nodes.length, novelSynapses, insights };
}

/**
 * Phase 5: Synthesis — Novel Synapse Insight Generation
 *
 * Examines recently formed weak synapses (from free association),
 * loads both connected memory nodes, extracts the unexpected connection,
 * and stores as a "synthesis" cognitive artifact.
 */
export async function phaseSynthesis(
  agentId: number,
  hours = 24
): Promise<{
  synthesesCreated: number;
  insights: Array<{ type: string; description: string }>;
}> {
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const insights: Array<{ type: string; description: string }> = [];

  // Find novel synapses: weak (0.2-0.4 strength), recently created
  const novelSynapses = await db.execute(sql`
    SELECT ms.id, ms.memory_a, ms.memory_b, ms.connection_strength,
           ma.content AS content_a, ma.entities AS entities_a, ma.source AS source_a,
           mb.content AS content_b, mb.entities AS entities_b, mb.source AS source_b
    FROM memory_synapses ms
    JOIN memory_nodes ma ON ma.id = ms.memory_a
    JOIN memory_nodes mb ON mb.id = ms.memory_b
    WHERE ms.connection_strength BETWEEN 0.2 AND 0.4
      AND ms.created_at > ${since.toISOString()}::timestamp
      AND ma.agent_id = ${agentId}
      AND ma.status = 'active'
      AND mb.status = 'active'
      AND (ma.source IS NULL OR mb.source IS NULL OR ma.source != mb.source)
    ORDER BY ms.created_at DESC
    LIMIT 30
  `);

  let synthesesCreated = 0;

  for (const row of novelSynapses.rows as Array<{
    id: number; memory_a: number; memory_b: number; connection_strength: number;
    content_a: string; entities_a: string[]; source_a: string | null;
    content_b: string; entities_b: string[]; source_b: string | null;
  }>) {
    const summaryA = row.content_a.slice(0, 200);
    const summaryB = row.content_b.slice(0, 200);

    // Find shared entities as the "common thread"
    const entitiesA = new Set(row.entities_a || []);
    const entitiesB = new Set(row.entities_b || []);
    const shared = [...entitiesA].filter(e => entitiesB.has(e));

    const connection = shared.length > 0
      ? `Shared entities: ${shared.join(", ")}`
      : `Semantic similarity (strength: ${row.connection_strength.toFixed(2)})`;

    const srcA = row.source_a?.split("/").pop() || "unknown";
    const srcB = row.source_b?.split("/").pop() || "unknown";
    const implication = `Memory from [${srcA}] connects to [${srcB}] via ${connection}`;

    // Store as cognitive artifact
    await db.insert(schema.cognitiveArtifacts).values({
      agentId,
      artifactType: "synthesis",
      content: {
        nodeA: { id: row.memory_a, summary: summaryA },
        nodeB: { id: row.memory_b, summary: summaryB },
        connection,
        implication,
        actionable: shared.length > 0,
      },
      resonanceScore: 5.0,
    });

    synthesesCreated++;
    if (synthesesCreated <= 5) {
      insights.push({
        type: "synthesis",
        description: implication,
      });
    }
  }

  console.log(`[dream] Phase 5: Created ${synthesesCreated} synthesis insights`);
  return { synthesesCreated, insights };
}

// ─── CLI / Cron Entry Point ─────────────────────────────
if (
  process.argv[1]?.endsWith("dream-cycle.ts") ||
  process.argv[1]?.endsWith("dream-cycle.js")
) {
  const agentExternalId = process.argv[2] || "arlo";
  const cycleType = process.argv[3] || "full";

  (async () => {
    const { initDatabase } = await import("../db/index.js");
    await initDatabase();

    const [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.externalId, agentExternalId));

    if (!agent) {
      console.error(`Agent '${agentExternalId}' not found`);
      process.exit(1);
    }

    const stats = await runDreamCycle(agent.id, cycleType);
    console.log("[dream] Final stats:", JSON.stringify(stats, null, 2));
    process.exit(0);
  })();
}

export type { DreamStats };
