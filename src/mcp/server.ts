#!/usr/bin/env node
/**
 * CORTEX V2 MCP Server
 *
 * Exposes CORTEX memory operations as native tools for Claude Code.
 * Any agent gets: cortex_search, cortex_recall, cortex_init,
 * cortex_ingest, cortex_dream, cortex_status as tool calls.
 *
 * Run via: npx tsx src/mcp/server.ts
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { db, schema, initDatabase } from "../db/index.js";
import { embedQuery } from "../ingestion/embeddings.js";
import { chunkText, countTokens } from "../ingestion/chunker.js";
import { embedTexts } from "../ingestion/embeddings.js";
import { extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import { ingestFile, ingestCorpus } from "../ingestion/ingest-markdown.js";
import { runDreamCycle, phaseSynthesis } from "../dream/dream-cycle.js";
import { runSelfCheck, formatDiagnostic } from "../proprioception/self-check.js";
import { writeJournalEntry, getRecentJournal, formatJournalEntries } from "../proprioception/journal.js";
import { assessPrincipalState, getStateHistory, formatStateAssessment, formatStateHistory } from "../empathy/state-model.js";
import { runStrategicThread, runOperationalThread, runRelationalThread, formatThreadResult } from "../cognition/background-threads.js";
import { captureAndAnalyze, ingestObservation, formatObservation } from "../perception/screen-observer.js";
import { getRelationship, listRelationships, updateRelationship, addOpenItem, formatRelationship, formatRelationshipList } from "../social/relationships.js";
import { storeReasoningTrace } from "../metacognition/reasoning.js";
import { runWeeklyAudit, formatAuditResult } from "../metacognition/audit.js";
import { writeInnerMonologue, getRecentMonologue, formatMonologue } from "../metacognition/inner-monologue.js";
import { reconsolidate, getLabileMemories } from "../reconsolidation/index.js";
import { storeProcedural, retrieveProcedural, recordExecution, refineProcedural } from "../procedural/index.js";
import { eq, sql, desc, and } from "drizzle-orm";
import "dotenv/config";

const server = new McpServer({
  name: "cortex-v2",
  version: "0.1.0",
});

// MCP is a local compatibility surface, not a multi-tenant identity authority.
// Bind every tool to the configured agent and never auto-create identities.
async function resolveAgent(externalId: string): Promise<number> {
  const configured = process.env.CORTEX_DEFAULT_AGENT;
  if (!configured) throw new Error("CORTEX_DEFAULT_AGENT is required");
  // Older tool schemas default to "arlo"; treat only that legacy default as
  // omitted. Any other explicit cross-agent request fails closed.
  if (externalId && externalId !== "arlo" && externalId !== configured) {
    throw new Error("agent_scope_violation");
  }
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.externalId, configured));

  if (!agent) {
    throw new Error(`Configured agent '${configured}' not found`);
  }

  return agent.id;
}

// ─── Tool: cortex_search ────────────────────────────────
server.tool(
  "cortex_search",
  "Search CORTEX memory using hybrid scoring (semantic + text + recency + resonance + priority). Use this whenever you need to recall information from past conversations, files, transcripts, or any stored memory.",
  {
    query: z.string().describe("The search query"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    limit: z
      .number()
      .default(10)
      .describe("Max results to return (default: 10)"),
    verbose: z
      .boolean()
      .default(false)
      .describe("Include temporal validity, priority, resonance details (default: false)"),
  },
  async ({ query, agent_id, limit, verbose }) => {
    const agentId = await resolveAgent(agent_id);
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    const results = await db.execute(sql`
      WITH vector_scores AS (
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
          valid_from,
          valid_until,
          superseded_by,
          1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
          CASE
            WHEN content ILIKE ${"%" + query + "%"} THEN 1.0
            ELSE 0.0
          END AS text_match,
          EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS recency,
          LEAST(resonance_score / 10.0, 1.0) AS norm_resonance,
          CASE priority
            WHEN 0 THEN 1.0
            WHEN 1 THEN 0.8
            WHEN 2 THEN 0.5
            WHEN 3 THEN 0.3
            WHEN 4 THEN 0.1
            ELSE 0.5
          END AS priority_boost
        FROM memory_nodes
        WHERE agent_id = ${agentId}
          AND status = 'active'
          AND embedding IS NOT NULL
      )
      SELECT *,
        (0.50 * cosine_sim
       + 0.20 * text_match
       + 0.15 * recency
       + 0.10 * norm_resonance
       + 0.05 * priority_boost) AS hybrid_score
      FROM vector_scores
      ORDER BY hybrid_score DESC
      LIMIT ${limit}
    `);

    // Update access counts (telemetry — best-effort, non-fatal).
    // NOTE (2026-04-10): Uses sql.raw with an explicit ARRAY literal because
    // drizzle-orm serializes JS number arrays as PostgreSQL composite ROW(...)
    // types which Postgres refuses to cast to int[] ("cannot cast type record
    // to integer[]"). The wrapping try/catch ensures that a telemetry failure
    // never kills a successful search response. resultIds are typed as number[]
    // from the caller's SELECT rows, so there is no injection risk.
    const resultIds = (results.rows as Array<{ id: number }>).map((r) => r.id);
    if (resultIds.length > 0) {
      try {
        const idsLiteral = `ARRAY[${resultIds.join(",")}]::int[]`;
        await db.execute(sql`
          UPDATE memory_nodes
          SET access_count = access_count + 1,
              last_accessed_at = NOW()
          WHERE id = ANY(${sql.raw(idsLiteral)})
        `);
      } catch (err) {
        console.error("[cortex_search] access count update failed (non-fatal):", err);
      }
    }

    const formatted = (
      results.rows as Array<{
        id: number;
        content: string;
        source: string | null;
        source_type: string | null;
        priority: number;
        resonance_score: number;
        entities: string[] | null;
        semantic_tags: string[] | null;
        created_at: string;
        valid_from: string | null;
        valid_until: string | null;
        superseded_by: number | null;
        hybrid_score: number;
        cosine_sim: number;
        text_match: number;
        recency: number;
      }>
    )
      .map((r) => {
        const src = r.source?.split("/").pop() || "unknown";
        const entities =
          r.entities?.length ? `\nEntities: ${r.entities.join(", ")}` : "";
        const tags =
          r.semantic_tags?.length
            ? `\nTags: ${r.semantic_tags.join(", ")}`
            : "";

        let verboseInfo = "";
        if (verbose) {
          const validFrom = r.valid_from ? new Date(r.valid_from).toLocaleDateString() : "since creation";
          const validUntil = r.valid_until ? new Date(r.valid_until).toLocaleDateString() : "current";
          const superseded = r.superseded_by ? `→ #${r.superseded_by}` : "";
          verboseInfo = `\nPriority: P${r.priority} | Resonance: ${Number(r.resonance_score).toFixed(1)} | Valid: ${validFrom} — ${validUntil} ${superseded}`;
        }

        return `## Memory #${r.id} [${src}] (score: ${Number(r.hybrid_score).toFixed(4)})\nCosine: ${Number(r.cosine_sim).toFixed(3)} | Text: ${Number(r.text_match).toFixed(0)} | Recency: ${Number(r.recency).toFixed(3)}${verboseInfo}${entities}${tags}\n\n${r.content}`;
      })
      .join("\n\n---\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `# CORTEX Search: "${query}"\nResults: ${results.rows.length}\n\n${formatted || "No results found."}`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_recall ────────────────────────────────
server.tool(
  "cortex_recall",
  "Token-budget-aware context retrieval. Fetches the most relevant memories that fit within a token budget. Use this when you need to load context for a topic without exceeding token limits.",
  {
    query: z.string().describe("What to recall context about"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    token_budget: z
      .number()
      .default(4000)
      .describe("Max tokens to return (default: 4000)"),
  },
  async ({ query, agent_id, token_budget }) => {
    const agentId = await resolveAgent(agent_id);
    const queryEmbedding = await embedQuery(query);
    const embeddingStr = `[${queryEmbedding.join(",")}]`;

    // Fetch candidates
    const results = await db.execute(sql`
      WITH vector_scores AS (
        SELECT
          id, content, source,
          1 - (embedding <=> ${embeddingStr}::vector) AS cosine_sim,
          CASE WHEN content ILIKE ${"%" + query + "%"} THEN 1.0 ELSE 0.0 END AS text_match,
          EXP(-0.023 * EXTRACT(EPOCH FROM (NOW() - created_at)) / 86400) AS recency,
          LEAST(resonance_score / 10.0, 1.0) AS norm_resonance,
          CASE priority WHEN 0 THEN 1.0 WHEN 1 THEN 0.8 WHEN 2 THEN 0.5 WHEN 3 THEN 0.3 ELSE 0.1 END AS priority_boost
        FROM memory_nodes
        WHERE agent_id = ${agentId} AND status = 'active' AND embedding IS NOT NULL
      )
      SELECT *,
        (0.50 * cosine_sim + 0.20 * text_match + 0.15 * recency + 0.10 * norm_resonance + 0.05 * priority_boost) AS hybrid_score
      FROM vector_scores
      ORDER BY hybrid_score DESC
      LIMIT 50
    `);

    // Also get recent cognitive artifacts
    const artifacts = await db
      .select()
      .from(schema.cognitiveArtifacts)
      .where(eq(schema.cognitiveArtifacts.agentId, agentId))
      .orderBy(desc(schema.cognitiveArtifacts.createdAt))
      .limit(5);

    // Fill context within budget
    const parts: string[] = [];
    let usedTokens = 0;
    const memoryBudget = Math.floor(token_budget * 0.8);

    parts.push("## Relevant Memories\n");
    usedTokens += countTokens("## Relevant Memories\n");

    for (const row of results.rows as Array<{
      id: number;
      content: string;
      source: string | null;
      hybrid_score: number;
    }>) {
      const src = row.source?.split("/").pop() || "unknown";
      const block = `### Memory #${row.id} [${src}] (score: ${Number(row.hybrid_score).toFixed(3)})\n${row.content}\n`;
      const blockTokens = countTokens(block);

      if (usedTokens + blockTokens > memoryBudget) {
        if (Number(row.hybrid_score) > 0.6 && usedTokens + 150 < memoryBudget) {
          const truncated = `### Memory #${row.id} [${src}] (score: ${Number(row.hybrid_score).toFixed(3)})\n${row.content.slice(0, 400)}...\n`;
          const truncTokens = countTokens(truncated);
          if (usedTokens + truncTokens <= memoryBudget) {
            parts.push(truncated);
            usedTokens += truncTokens;
          }
        }
        continue;
      }
      parts.push(block);
      usedTokens += blockTokens;
    }

    if (artifacts.length > 0) {
      parts.push("\n## Recent Cognitive Artifacts\n");
      for (const art of artifacts) {
        const block = `### ${art.artifactType} #${art.id}\n${JSON.stringify(art.content, null, 2)}\n`;
        const blockTokens = countTokens(block);
        if (usedTokens + blockTokens > token_budget) break;
        parts.push(block);
        usedTokens += blockTokens;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: `# CORTEX Recall: "${query}"\nTokens used: ${usedTokens} / ${token_budget}\n\n${parts.join("\n")}`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_init ──────────────────────────────────
server.tool(
  "cortex_init",
  "Initialize a CORTEX session. Loads the top memories by hybrid score plus system stats. Use this at the start of every session as part of the boot sequence.",
  {
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);

    // Get system stats
    const memoryCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
    `);
    const synapseCountResult = await db.execute(sql`
      SELECT COUNT(*) as count FROM memory_synapses
      WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
         OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
    `);
    const avgResonanceResult = await db.execute(sql`
      SELECT COALESCE(AVG(resonance_score), 0) as avg FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
    `);
    const lastDreamResult = await db.execute(sql`
      SELECT cycle_type, stats, started_at, completed_at
      FROM dream_cycle_logs WHERE agent_id = ${agentId}
      ORDER BY started_at DESC LIMIT 1
    `);

    // Top-20 most relevant active context
    const topMemories = await db.execute(sql`
      SELECT id, content, source, resonance_score, priority, entities
      FROM memory_nodes
      WHERE agent_id = ${agentId} AND status = 'active'
      ORDER BY
        CASE priority WHEN 0 THEN 100 WHEN 1 THEN 50 ELSE 0 END
        + resonance_score
        + (CASE WHEN created_at > NOW() - INTERVAL '3 days' THEN 5 ELSE 0 END)
        DESC
      LIMIT 20
    `);

    // Recent artifacts
    const recentArtifacts = await db
      .select()
      .from(schema.cognitiveArtifacts)
      .where(eq(schema.cognitiveArtifacts.agentId, agentId))
      .orderBy(desc(schema.cognitiveArtifacts.createdAt))
      .limit(5);

    // Active entities (most mentioned across active memories)
    const activeEntities = await db.execute(sql`
      SELECT unnest(entities) as entity, COUNT(*) as mentions
      FROM memory_nodes
      WHERE agent_id = ${agentId} AND status = 'active' AND entities != '{}'
      GROUP BY entity ORDER BY mentions DESC LIMIT 15
    `);

    const memCount = (memoryCountResult.rows[0] as { count: string })?.count || "0";
    const synCount = (synapseCountResult.rows[0] as { count: string })?.count || "0";
    const avgRes = Number(
      (avgResonanceResult.rows[0] as { avg: string })?.avg || 0
    ).toFixed(2);

    const now = new Date();
    let output = `# CORTEX V2 Session Context\n`;
    output += `*Loaded: ${now.toISOString().split("T")[0]} ${now.toTimeString().slice(0, 5)} MST*\n\n`;

    output += `## System Status\n`;
    output += `- Active Memories: ${memCount}\n`;
    output += `- Synapses: ${synCount}\n`;
    output += `- Avg Resonance: ${avgRes}\n`;

    if (lastDreamResult.rows.length > 0) {
      const dream = lastDreamResult.rows[0] as {
        cycle_type: string;
        completed_at: string;
      };
      output += `- Last Dream Cycle: ${dream.cycle_type} (${dream.completed_at || "in progress"})\n`;
    }
    output += "\n";

    if ((activeEntities.rows as Array<{ entity: string; mentions: string }>).length > 0) {
      output += `## Active Entities\n`;
      for (const e of activeEntities.rows as Array<{
        entity: string;
        mentions: string;
      }>) {
        output += `- ${e.entity} (${e.mentions} mentions)\n`;
      }
      output += "\n";
    }

    output += `## Top Context\n\n`;
    for (const mem of topMemories.rows as Array<{
      id: number;
      content: string;
      source: string | null;
      resonance_score: number;
      priority: number;
      entities: string[] | null;
    }>) {
      const src = mem.source?.split("/").pop() || "unknown";
      const pLabel = ["P0-CRITICAL", "P1-HIGH", "P2-NORMAL", "P3-LOW", "P4-EPHEMERAL"][mem.priority] || "P2";
      output += `### [${src}] ${pLabel} | resonance: ${Number(mem.resonance_score).toFixed(1)}\n`;
      output += mem.content.slice(0, 500) + (mem.content.length > 500 ? "..." : "") + "\n\n";
    }

    if (recentArtifacts.length > 0) {
      output += `## Recent Cognitive Artifacts\n\n`;
      for (const art of recentArtifacts) {
        output += `### ${art.artifactType} #${art.id}\n`;
        output += JSON.stringify(art.content, null, 2).slice(0, 300) + "\n\n";
      }
    }

    output += `---\n*CORTEX V2 ready. Use cortex_search for recall, cortex_recall for budget-aware context.*`;

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// ─── Tool: cortex_ingest ────────────────────────────────
server.tool(
  "cortex_ingest",
  "Store new content into CORTEX memory. Automatically chunks, embeds, extracts entities, and forms synapses. Use this to save important information, decisions, learnings, or any content that should persist across sessions.",
  {
    content: z.string().describe("The content to store in memory"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    source: z
      .string()
      .optional()
      .describe("Source label (e.g. 'session', 'telegram', file path)"),
    priority: z
      .number()
      .min(0)
      .max(4)
      .default(2)
      .describe("Priority: 0=critical, 1=high, 2=normal, 3=low, 4=ephemeral"),
    source_type: z
      .string()
      .default("api")
      .describe("Source type (markdown, telegram, limitless, api)"),
  },
  async ({ content, agent_id, source, priority, source_type }) => {
    const agentId = await resolveAgent(agent_id);

    const chunks = chunkText(content);
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    const insertedIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const entities = await extractEntities(chunks[i].text);
      const tags = extractSemanticTags(chunks[i].text);

      const [inserted] = await db
        .insert(schema.memoryNodes)
        .values({
          agentId,
          content: chunks[i].text,
          source: source || null,
          sourceType: source_type,
          chunkIndex: chunks[i].index,
          embedding: embeddings[i],
          entities,
          semanticTags: tags,
          priority,
          resonanceScore: 5.0,
          status: "active",
        })
        .returning({ id: schema.memoryNodes.id });
      insertedIds.push(inserted.id);
    }

    const synapsesFormed = await formSynapses(agentId, insertedIds);

    return {
      content: [
        {
          type: "text" as const,
          text: `Stored ${insertedIds.length} memory chunks (IDs: ${insertedIds.join(", ")}). Formed ${synapsesFormed} synapses.`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_ingest_file ───────────────────────────
server.tool(
  "cortex_ingest_file",
  "Ingest a file from disk into CORTEX memory. Reads, chunks, embeds, and stores the file. Use this for ingesting markdown files, logs, transcripts, etc.",
  {
    file_path: z.string().describe("Absolute path to the file to ingest"),
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    source_type: z
      .string()
      .default("markdown")
      .describe("Source type (markdown, telegram, limitless)"),
  },
  async ({ file_path, agent_id, source_type }) => {
    const agentId = await resolveAgent(agent_id);

    const count = await ingestFile({
      agentId,
      sourcePath: file_path,
      sourceType: source_type,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: `Ingested ${file_path}: ${count} chunks stored and indexed.`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_ingest_corpus ─────────────────────────
server.tool(
  "cortex_ingest_corpus",
  "Ingest the entire V1 corpus (all memory files, telegram, limitless, logs, core files) into CORTEX V2. This is a one-time bulk operation for initial setup. Takes several minutes.",
  {
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);
    await ingestCorpus(agentId);

    // Get final counts
    const [memCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ count: string }>;

    const [synCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_synapses
        WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
      `)
    ).rows as Array<{ count: string }>;

    return {
      content: [
        {
          type: "text" as const,
          text: `Corpus ingestion complete. ${memCount.count} memory nodes, ${synCount.count} synapses formed.`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_dream ─────────────────────────────────
server.tool(
  "cortex_dream",
  "Trigger a dream cycle for memory maintenance. Runs resonance analysis, pruning, consolidation, and free association. Use 'full' for complete cycle or individual phases.",
  {
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    cycle_type: z
      .enum(["full", "resonance_only", "pruning_only", "consolidation_only"])
      .default("full")
      .describe("Type of dream cycle to run"),
  },
  async ({ agent_id, cycle_type }) => {
    const agentId = await resolveAgent(agent_id);
    const stats = await runDreamCycle(agentId, cycle_type);

    return {
      content: [
        {
          type: "text" as const,
          text: `Dream cycle (${cycle_type}) complete in ${(stats.totalDurationMs / 1000).toFixed(1)}s.\n\nResults:\n- Resonance updated: ${stats.phase1_resonanceUpdated}\n- Memories deleted: ${stats.phase2_memoriesDeleted}\n- Memories archived: ${stats.phase2_memoriesArchived}\n- Synapses pruned: ${stats.phase2_synapsesPruned}\n- Clusters found: ${stats.phase3_clustersFound}\n- Consolidations: ${stats.phase3_consolidations}\n- Synapses strengthened: ${stats.phase3_synapsesStrengthened}\n- Nodes activated: ${stats.phase4_nodesActivated}\n- Novel synapses: ${stats.phase4_novelSynapses}`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_status ────────────────────────────────
server.tool(
  "cortex_status",
  "Get CORTEX system status including memory count, synapse count, resonance stats, and last dream cycle info.",
  {
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);

    const [memCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ count: string }>;

    const [synCount] = (
      await db.execute(sql`
        SELECT COUNT(*) as count FROM memory_synapses
        WHERE memory_a IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
           OR memory_b IN (SELECT id FROM memory_nodes WHERE agent_id = ${agentId})
      `)
    ).rows as Array<{ count: string }>;

    const [avgRes] = (
      await db.execute(sql`
        SELECT COALESCE(AVG(resonance_score), 0) as avg FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active'
      `)
    ).rows as Array<{ avg: string }>;

    const statusBreakdown = await db.execute(sql`
      SELECT status, COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} GROUP BY status
    `);

    const sourceBreakdown = await db.execute(sql`
      SELECT source_type, COUNT(*) as count FROM memory_nodes WHERE agent_id = ${agentId} AND status = 'active' GROUP BY source_type
    `);

    const lastDream = await db.execute(sql`
      SELECT cycle_type, stats, started_at, completed_at FROM dream_cycle_logs WHERE agent_id = ${agentId} ORDER BY started_at DESC LIMIT 1
    `);

    let output = `# CORTEX V2 Status\n\n`;
    output += `- Active Memories: ${memCount.count}\n`;
    output += `- Synapses: ${synCount.count}\n`;
    output += `- Avg Resonance: ${Number(avgRes.avg).toFixed(2)}\n\n`;

    output += `## Memory by Status\n`;
    for (const row of statusBreakdown.rows as Array<{
      status: string;
      count: string;
    }>) {
      output += `- ${row.status}: ${row.count}\n`;
    }

    output += `\n## Memory by Source\n`;
    for (const row of sourceBreakdown.rows as Array<{
      source_type: string;
      count: string;
    }>) {
      output += `- ${row.source_type}: ${row.count}\n`;
    }

    if (lastDream.rows.length > 0) {
      const dream = lastDream.rows[0] as {
        cycle_type: string;
        completed_at: string;
        stats: Record<string, unknown>;
      };
      output += `\n## Last Dream Cycle\n`;
      output += `- Type: ${dream.cycle_type}\n`;
      output += `- Completed: ${dream.completed_at || "in progress"}\n`;
      output += `- Stats: ${JSON.stringify(dream.stats)}\n`;
    }

    return {
      content: [{ type: "text" as const, text: output }],
    };
  }
);

// ─── Tool: cortex_artifact ──────────────────────────────
server.tool(
  "cortex_artifact",
  "Store a cognitive artifact (decision, learning, correction, or insight). Use this to record significant decisions with reasoning, lessons learned, corrections made, or insights discovered.",
  {
    agent_id: z
      .string()
      .default("arlo")
      .describe("Agent ID (default: arlo)"),
    artifact_type: z
      .enum(["decision", "learning", "correction", "insight"])
      .describe("Type of cognitive artifact"),
    content: z.record(z.unknown()).describe("Artifact content as JSON object"),
    session_id: z
      .string()
      .optional()
      .describe("Session identifier"),
  },
  async ({ agent_id, artifact_type, content, session_id }) => {
    const agentId = await resolveAgent(agent_id);

    const [artifact] = await db
      .insert(schema.cognitiveArtifacts)
      .values({
        agentId,
        artifactType: artifact_type,
        content,
        sessionId: session_id,
        resonanceScore: 5.0,
      })
      .returning();

    return {
      content: [
        {
          type: "text" as const,
          text: `Cognitive artifact stored (${artifact_type} #${artifact.id}).`,
        },
      ],
    };
  }
);

// ─── Tool: cortex_self_check (Phase 1) ─────────────────
server.tool(
  "cortex_self_check",
  "Run a self-diagnostic check on the agent's operational health. Checks skills, cron jobs, channels, and behavioral drift. Use during heartbeats or when something feels off.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    verbose: z.boolean().default(false).describe("Include detailed drift indicators"),
  },
  async ({ agent_id, verbose }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await runSelfCheck(agentId, verbose);
    return { content: [{ type: "text" as const, text: formatDiagnostic(result, verbose) }] };
  }
);

// ─── Tool: cortex_journal (Phase 1) ────────────────────
server.tool(
  "cortex_journal",
  "Log an agent state journal entry. Record current energy, confidence, concerns, and notes for self-awareness tracking.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    energy_state: z.enum(["high", "normal", "low", "depleted"]).default("normal").describe("Current energy level"),
    confidence: z.number().min(0).max(1).default(0.5).describe("Current confidence (0-1)"),
    active_threads: z.array(z.string()).default([]).describe("Currently active work threads"),
    concerns: z.array(z.string()).default([]).describe("Current concerns"),
    notes: z.string().optional().describe("Free-form notes"),
    session_id: z.string().optional().describe("Session identifier"),
  },
  async ({ agent_id, energy_state, confidence, active_threads, concerns, notes, session_id }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await writeJournalEntry(agentId, {
      energyState: energy_state,
      confidence,
      activeThreads: active_threads,
      concerns,
      notes,
      sessionId: session_id,
    });
    return { content: [{ type: "text" as const, text: `Journal entry stored (ID: ${id}).` }] };
  }
);

// ─── Tool: cortex_assess_state (Phase 2) ──────────────
server.tool(
  "cortex_assess_state",
  "Assess the principal's current state (energy, stress, focus) from recent message patterns and context. Returns communication guidance.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    recent_messages: z.array(z.string()).describe("Recent messages from the principal to analyze"),
    time_of_day: z.string().optional().describe("Current time (HH:MM format)"),
    calendar_context: z.string().optional().describe("Upcoming calendar context"),
  },
  async ({ agent_id, recent_messages, time_of_day, calendar_context }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await assessPrincipalState(agentId, recent_messages, time_of_day, undefined, calendar_context);
    return { content: [{ type: "text" as const, text: formatStateAssessment(result) }] };
  }
);

// ─── Tool: cortex_state_history (Phase 2) ─────────────
server.tool(
  "cortex_state_history",
  "Get recent history of the principal's assessed states. Useful for understanding trends and patterns.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    hours: z.number().default(24).describe("How many hours back to look"),
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveAgent(agent_id);
    const entries = await getStateHistory(agentId, hours);
    return { content: [{ type: "text" as const, text: formatStateHistory(entries) }] };
  }
);

// ─── Tool: cortex_bg_thread (Phase 3) ─────────────────
server.tool(
  "cortex_bg_thread",
  "Run a background reasoning thread. Strategic analyzes gaps and alignment. Operational checks system health. Relational tracks contact freshness.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    thread_type: z.enum(["strategic", "operational", "relational"]).describe("Type of reasoning thread"),
  },
  async ({ agent_id, thread_type }) => {
    const agentId = await resolveAgent(agent_id);
    const runners = { strategic: runStrategicThread, operational: runOperationalThread, relational: runRelationalThread };
    const result = await runners[thread_type](agentId);
    return { content: [{ type: "text" as const, text: formatThreadResult(thread_type, result) }] };
  }
);

// ─── Tool: cortex_synthesize (Phase 3) ────────────────
server.tool(
  "cortex_synthesize",
  "Run synthesis on recent novel synapses to discover unexpected connections and generate insights.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    hours: z.number().default(24).describe("How many hours of novel synapses to analyze"),
  },
  async ({ agent_id, hours }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await phaseSynthesis(agentId, hours);
    let text = `Synthesis complete: ${result.synthesesCreated} insights generated.`;
    if (result.insights.length > 0) {
      text += "\n\nInsights:\n" + result.insights.map(i => `- ${i.description}`).join("\n");
    }
    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: cortex_observe (Phase 4) ───────────────────
server.tool(
  "cortex_observe",
  "Capture and analyze the current screen state. Detects active app, window title, and visible content. Use for contextual awareness of what the principal is working on.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    store: z.boolean().default(true).describe("Store observation in memory (false = describe only)"),
  },
  async ({ agent_id, store }) => {
    const agentId = await resolveAgent(agent_id);
    const observation = await captureAndAnalyze();
    let text = formatObservation(observation);
    if (store) {
      const ids = await ingestObservation(agentId, observation);
      text += `\nStored as memory node(s): ${ids.join(", ")}`;
    }
    return { content: [{ type: "text" as const, text }] };
  }
);

// ─── Tool: cortex_relationship (Phase 5) ──────────────
server.tool(
  "cortex_relationship",
  "Look up a person's relationship profile. Returns communication preferences, open items, contact history, and personality model.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    name: z.string().describe("Person's name (fuzzy matched)"),
  },
  async ({ agent_id, name }) => {
    const agentId = await resolveAgent(agent_id);
    const rel = await getRelationship(agentId, name);
    if (!rel) return { content: [{ type: "text" as const, text: `No relationship found for "${name}".` }] };
    return { content: [{ type: "text" as const, text: formatRelationship(rel) }] };
  }
);

// ─── Tool: cortex_relationships (Phase 5) ─────────────
server.tool(
  "cortex_relationships",
  "List all relationships, optionally filtered by type or showing only overdue contacts.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    type: z.string().optional().describe("Filter by type: family, client, partner, vendor, friend, professional"),
    overdue_only: z.boolean().default(false).describe("Only show overdue contacts"),
  },
  async ({ agent_id, type, overdue_only }) => {
    const agentId = await resolveAgent(agent_id);
    const rels = await listRelationships(agentId, { type, overdueOnly: overdue_only });
    return { content: [{ type: "text" as const, text: formatRelationshipList(rels) }] };
  }
);

// ─── Tool: cortex_relationship_update (Phase 5) ───────
server.tool(
  "cortex_relationship_update",
  "Update a relationship profile. Set last contact, add notes, add/resolve open items.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    name: z.string().describe("Person's name"),
    last_contact: z.string().optional().describe("Set last contact ('now' or ISO date)"),
    note: z.string().optional().describe("Update notes"),
    add_item: z.string().optional().describe("Add an open item"),
    resolve_item: z.number().optional().describe("Resolve open item by index"),
  },
  async ({ agent_id, name, last_contact, note, add_item, resolve_item }) => {
    const agentId = await resolveAgent(agent_id);

    if (add_item) {
      await addOpenItem(agentId, name, add_item);
      return { content: [{ type: "text" as const, text: `Added open item for ${name}.` }] };
    }

    if (resolve_item !== undefined) {
      const { resolveOpenItem } = await import("../social/relationships.js");
      await resolveOpenItem(agentId, name, resolve_item);
      return { content: [{ type: "text" as const, text: `Resolved open item #${resolve_item} for ${name}.` }] };
    }

    const updates: Record<string, unknown> = {};
    if (last_contact) updates.lastContact = last_contact === "now" ? "now" : new Date(last_contact);
    if (note) updates.notes = note;

    const updated = await updateRelationship(agentId, name, updates);
    return { content: [{ type: "text" as const, text: `Updated ${updated.personName}.` }] };
  }
);

// ─── Tool: cortex_reason (Phase 6) ────────────────────
server.tool(
  "cortex_reason",
  "Store a reasoning trace for a significant decision. Records the decision, options considered, rationale, and confidence.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    decision: z.string().describe("What was decided"),
    context: z.string().describe("Context/situation"),
    options: z.array(z.object({
      name: z.string(),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
    })).optional().describe("Options that were considered"),
    chosen: z.string().describe("Which option was chosen"),
    rationale: z.string().describe("Why this option was chosen"),
    confidence: z.number().min(0).max(1).default(0.5).describe("Confidence in the decision (0-1)"),
    reversible: z.boolean().default(true).describe("Is this decision easily reversible?"),
    impacts: z.array(z.string()).default([]).describe("Expected impacts"),
  },
  async ({ agent_id, decision, context, options, chosen, rationale, confidence, reversible, impacts }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await storeReasoningTrace(agentId, {
      decision, context, options, chosen, rationale, confidence, reversible, impacts,
    });
    return { content: [{ type: "text" as const, text: `Reasoning trace stored (artifact #${id}).` }] };
  }
);

// ─── Tool: cortex_audit (Phase 6) ─────────────────────
server.tool(
  "cortex_audit",
  "Run a weekly reasoning audit. Analyzes recent reasoning traces for consistency, confidence calibration, bias, and alignment with core values.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    period: z.string().optional().describe("Period label (e.g. '2026-W07')"),
  },
  async ({ agent_id, period }) => {
    const agentId = await resolveAgent(agent_id);
    const result = await runWeeklyAudit(agentId, period);
    return { content: [{ type: "text" as const, text: formatAuditResult(result) }] };
  }
);

// ─── Tool: cortex_monologue (Phase 6) ─────────────────
server.tool(
  "cortex_monologue",
  "Record an inner monologue entry. For observations, reflections, and self-directed thoughts.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    content: z.string().describe("The thought or observation"),
    context: z.string().optional().describe("What triggered this thought"),
  },
  async ({ agent_id, content, context }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await writeInnerMonologue(agentId, content, context);
    return { content: [{ type: "text" as const, text: `Inner monologue stored (artifact #${id}).` }] };
  }
);

// ─── Tool: cortex_reconsolidate ─────────────────────────
server.tool(
  "cortex_reconsolidate",
  "Update a previously recalled memory with new information. The memory must have been recalled within the last hour (labile window). Use this to correct beliefs, update outdated information, or refine knowledge. The original content is preserved as an audit trail.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    memory_id: z.number().describe("ID of the memory to update (must have been recently recalled)"),
    new_content: z.string().describe("The updated memory content"),
    reason: z.string().default("belief_update").describe("Why the memory is being updated (e.g., correction, expansion, refinement, belief_update)"),
  },
  async ({ agent_id, memory_id, new_content, reason }) => {
    const result = await reconsolidate(memory_id, new_content, reason);

    if (result.status === "not_found") {
      return { content: [{ type: "text" as const, text: `Memory #${memory_id} not found.` }] };
    }
    if (result.status === "not_labile") {
      return { content: [{ type: "text" as const, text: `Memory #${memory_id} has not been recalled recently. Search or recall it first to open the reconsolidation window.` }] };
    }
    if (result.status === "window_closed") {
      return { content: [{ type: "text" as const, text: `Labile window for memory #${memory_id} has closed (>1 hour since recall). Recall it again to reopen.` }] };
    }

    return {
      content: [{
        type: "text" as const,
        text: `Memory #${memory_id} reconsolidated.\nReason: ${reason}\nResonance boost: +${result.resonanceBoost.toFixed(1)}\nOriginal preserved as artifact #${result.artifactId}.\n\nPrevious: "${result.previousContent?.slice(0, 200)}..."\nUpdated: "${result.newContent?.slice(0, 200)}..."`,
      }],
    };
  }
);

// ─── Tool: cortex_labile ────────────────────────────────
server.tool(
  "cortex_labile",
  "List all currently labile (modifiable) memories. These are memories recalled in the last hour that can be updated via cortex_reconsolidate.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
  },
  async ({ agent_id }) => {
    const agentId = await resolveAgent(agent_id);
    const labile = await getLabileMemories(agentId);

    if (labile.length === 0) {
      return { content: [{ type: "text" as const, text: "No labile memories. Recall or search for memories first to open reconsolidation windows." }] };
    }

    const formatted = labile
      .map((m) => `- Memory #${m.id} (recalled ${new Date(m.recalledAt).toLocaleTimeString()}): "${m.content.slice(0, 120)}..."`)
      .join("\n");

    return {
      content: [{ type: "text" as const, text: `# Labile Memories (${labile.length})\nThese can be updated via cortex_reconsolidate:\n\n${formatted}` }],
    };
  }
);

// ─── Tool: cortex_skill_store ────────────────────────────
server.tool(
  "cortex_skill_store",
  "Store a new procedural memory (skill, workflow, pattern, preference, or heuristic). Use this when you learn HOW to do something, identify a repeatable process, or discover a pattern that should be remembered as a capability.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    name: z.string().describe("Short name for the skill/workflow (e.g., 'Client proposal writing')"),
    description: z.string().describe("Detailed description of how to execute this"),
    procedural_type: z.enum(["skill", "workflow", "pattern", "preference", "heuristic"]).describe("Type of procedural knowledge"),
    trigger_context: z.string().describe("When does this apply? What triggers it?"),
    steps: z.array(z.string()).default([]).describe("Step-by-step execution or key principles"),
    domain_tags: z.array(z.string()).default([]).describe("Domain tags for retrieval (e.g., ['sales', 'outreach'])"),
    source_memory_ids: z.array(z.number()).optional().describe("IDs of episodic memories where this was learned"),
  },
  async ({ agent_id, name, description, procedural_type, trigger_context, steps, domain_tags, source_memory_ids }) => {
    const agentId = await resolveAgent(agent_id);
    const id = await storeProcedural({
      agentId, name, description, proceduralType: procedural_type,
      triggerContext: trigger_context, steps, domainTags: domain_tags,
      sourceMemoryIds: source_memory_ids,
    });
    return { content: [{ type: "text" as const, text: `Procedural memory stored: "${name}" (${procedural_type}) → #${id}` }] };
  }
);

// ─── Tool: cortex_skill_retrieve ────────────────────────
server.tool(
  "cortex_skill_retrieve",
  "Retrieve relevant skills, workflows, or patterns for a given task. Use this BEFORE starting a task to check if you already know how to do it.",
  {
    agent_id: z.string().default("arlo").describe("Agent ID"),
    task_context: z.string().describe("Describe the task you're about to do"),
    limit: z.number().default(5).describe("Max results"),
  },
  async ({ agent_id, task_context, limit }) => {
    const agentId = await resolveAgent(agent_id);
    const results = await retrieveProcedural(agentId, task_context, limit);

    if (results.length === 0) {
      return { content: [{ type: "text" as const, text: "No matching procedural memories found. This may be a new task type." }] };
    }

    const formatted = results.map((r) => {
      const steps = r.memory.steps.length > 0
        ? `\nSteps:\n${r.memory.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}`
        : "";
      return `## ${r.memory.name} (${r.memory.proceduralType}) [${r.memory.proficiency}]\nMatch: ${r.matchType} (${r.relevanceScore.toFixed(3)})\nTrigger: ${r.memory.triggerContext}\nSuccess rate: ${(r.memory.successRate * 100).toFixed(0)}% (${r.memory.executionCount} executions)${steps}\n\n${r.memory.description}`;
    }).join("\n\n---\n\n");

    return { content: [{ type: "text" as const, text: `# Procedural Memories for: "${task_context}"\n\n${formatted}` }] };
  }
);

// ─── Tool: cortex_skill_executed ────────────────────────
server.tool(
  "cortex_skill_executed",
  "Record that you applied a procedural memory and whether it was successful. This is how skills improve over time.",
  {
    procedural_id: z.number().describe("ID of the procedural memory that was applied"),
    success: z.boolean().describe("Was the outcome successful?"),
  },
  async ({ procedural_id, success }) => {
    const result = await recordExecution(procedural_id, success);
    return {
      content: [{
        type: "text" as const,
        text: `Execution recorded for #${procedural_id}. Proficiency: ${result.proficiency}. Success rate: ${(result.successRate * 100).toFixed(0)}%.`,
      }],
    };
  }
);

// ─── Tool: cortex_skill_refine ──────────────────────────
server.tool(
  "cortex_skill_refine",
  "Refine an existing procedural memory with updated steps, description, or trigger context. Use this when you discover a better way to do something.",
  {
    procedural_id: z.number().describe("ID of the procedural memory to refine"),
    description: z.string().optional().describe("Updated description"),
    steps: z.array(z.string()).optional().describe("Updated steps"),
    trigger_context: z.string().optional().describe("Updated trigger context"),
    domain_tags: z.array(z.string()).optional().describe("Updated domain tags"),
  },
  async ({ procedural_id, description, steps, trigger_context, domain_tags }) => {
    const newVersion = await refineProcedural(procedural_id, {
      description: description || undefined,
      steps: steps || undefined,
      triggerContext: trigger_context || undefined,
      domainTags: domain_tags || undefined,
    });
    return { content: [{ type: "text" as const, text: `Procedural memory #${procedural_id} refined → v${newVersion}` }] };
  }
);

// ─── Start Server ───────────────────────────────────────
async function main() {
  try {
    await initDatabase();
  } catch (err) {
    // Log to stderr so it doesn't interfere with MCP stdio
    console.error("[cortex-mcp] Database init warning:", err);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cortex-mcp] CORTEX V2 MCP server running");
}

main().catch((err) => {
  console.error("[cortex-mcp] Fatal:", err);
  process.exit(1);
});
