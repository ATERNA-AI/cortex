import { Router, Request, Response } from "express";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";

const router = Router();

// ─── Category Classification ────────────────────────────
// Maps semantic tags + content keywords to one of 8 visualizer categories
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  strategic: ['strategy', 'strategic', 'business', 'plan', 'goal', 'roadmap', 'revenue', 'growth', 'decision', 'market', 'pricing', 'competitor', 'initiative', 'kpi', 'okr', 'pipeline', 'forecast', 'pitch', 'investor', 'funding', 'acquisition', 'partnership'],
  technical: ['code', 'api', 'database', 'server', 'deploy', 'infrastructure', 'bug', 'architecture', 'system', 'engineering', 'typescript', 'javascript', 'python', 'react', 'next', 'vercel', 'github', 'git', 'npm', 'node', 'function', 'module', 'endpoint', 'schema', 'migration', 'docker', 'vapi', 'webhook', 'prompt', 'mcp', 'embedding', 'vector', 'drizzle', 'postgres'],
  creative: ['design', 'brand', 'content', 'voice', 'copy', 'creative', 'visual', 'aesthetic', 'story', 'narrative', 'tone', 'style', 'logo', 'color', 'font', 'ui', 'ux', 'tagline', 'headline', 'website', 'landing'],
  operational: ['process', 'workflow', 'sop', 'procedure', 'pipeline', 'automation', 'schedule', 'task', 'checklist', 'onboard', 'template', 'handoff', 'sprint', 'release', 'monitoring', 'cron', 'backup'],
  research: ['research', 'analysis', 'data', 'study', 'finding', 'report', 'insight', 'trend', 'survey', 'benchmark', 'competitive', 'landscape', 'investigate', 'market research', 'prospect'],
  communication: ['call', 'message', 'email', 'meeting', 'conversation', 'feedback', 'telegram', 'slack', 'chat', 'transcript', 'discussion', 'phone', 'zoom', 'outreach', 'follow-up', 'client', 'said', 'talked', 'mentioned'],
  identity: ['identity', 'persona', 'behavior', 'principle', 'value', 'mission', 'vision', 'who i am', 'agent', 'self', 'core', 'belief', 'trait', 'personality', 'instruction', 'guardrail', 'rules', 'never'],
  environmental: ['context', 'location', 'time', 'environment', 'weather', 'timezone', 'setting', 'date', 'calendar', 'status', 'health', 'diagnostic', 'observation', 'screen', 'window', 'tab'],
};

function classifyCategory(semanticTags: string[], content: string, sourceType: string): string {
  const text = [...semanticTags, content.slice(0, 500)].join(' ').toLowerCase();

  let bestCategory = 'technical';
  let bestScore = 0;

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (text.includes(kw)) score++;
    }
    if (score > bestScore) {
      bestScore = score;
      bestCategory = category;
    }
  }

  if (bestScore === 0) {
    if (sourceType === 'telegram' || sourceType === 'vapi' || sourceType === 'limitless') return 'communication';
    if (sourceType === 'observation') return 'environmental';
    return 'technical';
  }

  return bestCategory;
}

function mapSourceType(sourceType: string): string {
  const mapping: Record<string, string> = {
    markdown: 'markdown',
    telegram: 'telegram',
    limitless: 'limitless',
    api: 'api',
    observation: 'session',
    vapi: 'vapi_calls',
    session: 'session',
    compound_feedback: 'compound_feedback',
    'compound-feedback': 'compound_feedback',
  };
  return mapping[sourceType] || 'session';
}

/**
 * GET /api/v1/graph?agentId=my-agent&limit=15000
 *
 * Returns the full memory graph for 3D visualization.
 */
router.get("/", async (req: Request, res: Response) => {
  try {
    const agentId = req.query.agentId as string;
    const limit = Math.min(parseInt(req.query.limit as string || "15000"), 50000);

    if (!agentId) {
      res.status(400).json({ error: "agentId query parameter is required" });
      return;
    }

    const agentResult = await db.execute(sql`
      SELECT id, external_id, name, config FROM agents WHERE external_id = ${agentId}
    `);

    if (agentResult.rows.length === 0) {
      res.status(404).json({ error: `Agent '${agentId}' not found` });
      return;
    }

    const agent = agentResult.rows[0] as { id: number; external_id: string; name: string; config: any };

    // Fetch active nodes — priority-ordered so important ones survive any limit
    const nodesResult = await db.execute(sql`
      SELECT id, content, summary, source, source_type, entities, semantic_tags,
             priority, resonance_score, access_count, last_accessed_at, status,
             created_at, novelty_score
      FROM memory_nodes
      WHERE agent_id = ${agent.id} AND status = 'active'
      ORDER BY priority ASC, resonance_score DESC
      LIMIT ${limit}
    `);

    const nodeRows = nodesResult.rows as any[];

    // Full counts (not limited by the graph query)
    const activeCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_nodes
      WHERE agent_id = ${agent.id} AND status = 'active'
    `);
    const archivedResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_nodes
      WHERE agent_id = ${agent.id} AND status != 'active'
    `);
    const totalSynapsesResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_synapses ms
      WHERE ms.memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agent.id})
    `);

    // Synapses between the RETURNED nodes only (using CTE to scope to limited set)
    const synapseLimit = Math.min(limit * 6, 120000); // ~6 synapses per node avg
    const synapsesResult = await db.execute(sql`
      WITH graph_nodes AS (
        SELECT id FROM memory_nodes
        WHERE agent_id = ${agent.id} AND status = 'active'
        ORDER BY priority ASC, resonance_score DESC
        LIMIT ${limit}
      )
      SELECT ms.id, ms.memory_a, ms.memory_b, ms.connection_type, ms.connection_strength
      FROM memory_synapses ms
      WHERE ms.memory_a IN (SELECT id FROM graph_nodes)
        AND ms.memory_b IN (SELECT id FROM graph_nodes)
      ORDER BY ms.connection_strength DESC
      LIMIT ${synapseLimit}
    `);
    const synapseRows = synapsesResult.rows as any[];

    // Last dream cycle
    const dreamResult = await db.execute(sql`
      SELECT cycle_type, stats, started_at, completed_at
      FROM dream_cycle_logs
      WHERE agent_id = ${agent.id}
      ORDER BY started_at DESC
      LIMIT 1
    `);

    // Top entities (most mentioned across all nodes)
    const entitiesResult = await db.execute(sql`
      SELECT unnest(entities) as entity, COUNT(*) as cnt
      FROM memory_nodes
      WHERE agent_id = ${agent.id} AND status = 'active'
      GROUP BY entity
      ORDER BY cnt DESC
      LIMIT 15
    `);

    // Source breakdown
    const sourceResult = await db.execute(sql`
      SELECT source_type, COUNT(*) as count
      FROM memory_nodes
      WHERE agent_id = ${agent.id} AND status = 'active'
      GROUP BY source_type
    `);

    // Average resonance
    const avgRes = nodeRows.length > 0
      ? nodeRows.reduce((sum: number, n: any) => sum + (n.resonance_score || 5), 0) / nodeRows.length
      : 5.0;

    // Map source breakdown to visualizer types
    const sourceBreakdown: Record<string, number> = {};
    for (const row of sourceResult.rows as any[]) {
      const mapped = mapSourceType(row.source_type || 'markdown');
      sourceBreakdown[mapped] = (sourceBreakdown[mapped] || 0) + parseInt(row.count);
    }

    // Dream stats
    const lastDream = dreamResult.rows[0] as any | undefined;
    const dreamStats = lastDream?.stats || {};

    // Self diagnostics (drift score, health)
    const diagResult = await db.execute(sql`
      SELECT drift_score, overall_health
      FROM self_diagnostics
      WHERE agent_id = ${agent.id}
      ORDER BY timestamp DESC
      LIMIT 1
    `);
    const lastDiag = diagResult.rows[0] as any | undefined;

    // Process nodes — classify category + compute derived fields
    // Truncate content for bandwidth (full text available via /recall endpoint)
    const now = Date.now();
    const nodes = nodeRows.map((n: any) => {
      const tags = n.semantic_tags || [];
      const content = n.content || '';
      const category = classifyCategory(tags, content, n.source_type || 'markdown');
      const ageDays = Math.floor((now - new Date(n.created_at).getTime()) / 86400000);

      return {
        id: n.id,
        content: content.slice(0, 200),
        summary: n.summary?.slice(0, 100) || null,
        source: n.source,
        sourceType: mapSourceType(n.source_type || 'markdown'),
        entities: (n.entities || []).slice(0, 5),
        semanticTags: tags.slice(0, 5),
        category,
        priority: n.priority ?? 2,
        resonanceScore: Math.min(10, Math.max(0, n.resonance_score ?? 5.0)),
        accessCount: n.access_count ?? 0,
        lastAccessedAt: n.last_accessed_at,
        createdAt: n.created_at,
        ageDays,
        noveltyScore: n.novelty_score,
      };
    });

    const synapses = synapseRows.map((s: any) => ({
      id: s.id,
      memoryA: s.memory_a,
      memoryB: s.memory_b,
      connectionType: s.connection_type,
      connectionStrength: s.connection_strength,
    }));

    res.json({
      agent: {
        id: agent.external_id,
        name: agent.name,
        internalId: agent.id,
      },
      nodes,
      synapses,
      stats: {
        totalActive: parseInt((activeCountResult.rows[0] as any)?.count || '0'),
        totalArchived: parseInt((archivedResult.rows[0] as any)?.count || '0'),
        totalNodes: parseInt((activeCountResult.rows[0] as any)?.count || '0') + parseInt((archivedResult.rows[0] as any)?.count || '0'),
        totalSynapses: parseInt((totalSynapsesResult.rows[0] as any)?.count || '0'),
        avgResonance: parseFloat(avgRes.toFixed(2)),
        sourceBreakdown,
        topEntities: (entitiesResult.rows as any[]).map((e: any) => e.entity),
        driftScore: lastDiag?.drift_score ?? 0,
        health: lastDiag?.overall_health ?? 'healthy',
        lastDreamCycle: lastDream ? {
          cycleType: lastDream.cycle_type,
          startedAt: lastDream.started_at,
          completedAt: lastDream.completed_at,
          resonanceUpdated: dreamStats.phase1_resonanceUpdated || 0,
          synapsesStrengthened: dreamStats.phase3_synapsesStrengthened || 0,
          memoriesArchived: dreamStats.phase2_memoriesArchived || 0,
          memoriesDeleted: dreamStats.phase2_memoriesDeleted || 0,
          synapsesPruned: dreamStats.phase2_synapsesPruned || 0,
          novelSynapses: dreamStats.phase4_novelSynapses || 0,
          synthesesCreated: dreamStats.phase5_synthesesCreated || 0,
          durationMs: dreamStats.totalDurationMs || 0,
        } : null,
      },
    });
  } catch (err) {
    console.error("[graph] Error:", err);
    res.status(500).json({ error: "Graph query failed" });
  }
});

export { router as graphRouter };
