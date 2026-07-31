import { Router, Request, Response } from "express";
import { db, schema } from "../db/index.js";
import { chunkText } from "../ingestion/chunker.js";
import { embedTexts } from "../ingestion/embeddings.js";
import { extractEntities, extractSemanticTags } from "../ingestion/entities.js";
import { formSynapses } from "../ingestion/synapse-formation.js";
import { sanitizeText } from "./extract.js";
import { hippocampalEncode } from "../hippocampus/index.js";
import { analyzeValence } from "../valence/index.js";
import { eq, sql } from "drizzle-orm";
import { evaluateAdmission, type CortexTrust } from "./security.js";

const router = Router();

export interface IngestArgs {
  agentId: string;
  content: string;
  source?: string | null;
  sourceType?: string;
  priority?: number;
  entities?: string[];
  semanticTags?: string[];
  principal?: string;
  trust?: CortexTrust;
}

/**
 * Core ingestion pipeline: chunks → embeds → stores → forms synapses.
 * Shared by POST /api/v1/ingest and POST /api/v1/ingest/file.
 * Throws { status, message } on validation/lookup failure.
 */
export async function ingestContent(args: IngestArgs) {
  const {
    agentId,
    content,
    source,
    sourceType = "api",
    priority = 2,
    entities: providedEntities,
    semanticTags: providedTags,
    principal = "unknown",
    trust = "external",
  } = args;

  if (!agentId || !content) {
    throw { status: 400, message: "agentId and content required" };
  }

  const admission = evaluateAdmission(content, trust);
  await db.execute(sql`
    INSERT INTO memory_admission_events
      (agent_external_id, principal, trust, authority, content_sha256, admitted, reason, source)
    VALUES
      (${agentId}, ${principal}, ${trust}, ${admission.authority}, ${admission.digest},
       ${admission.admitted}, ${admission.reason || null}, ${source || null})
  `);
  if (!admission.admitted) {
    console.warn(`[admission] quarantined principal=${principal} digest=${admission.digest} reason=${admission.reason}`);
    throw { status: 422, message: "Content quarantined by memory admission policy" };
  }

  // Resolve agent
  const [agent] = await db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.externalId, agentId));

  if (!agent) {
    throw { status: 404, message: `Agent '${agentId}' not found` };
  }

  // Defensive: strip NUL/control bytes that Postgres TEXT rejects, so no
  // ingest path (PDF/DOCX/text/api) can ever fail the insert again.
  const safeContent = sanitizeText(content);

  // Chunk content
    const chunks = chunkText(safeContent);

    // Embed all chunks
    const embeddings = await embedTexts(chunks.map((c) => c.text));

    // Store chunks with surprise-gated resonance
    const insertedIds: number[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const autoEntities = await extractEntities(chunks[i].text);
      const autoTags = extractSemanticTags(chunks[i].text);

      // Hippocampal encoding: DG pattern separation + CA1 novelty detection
      const { sparseCode, noveltyResult } =
        await hippocampalEncode(agent.id, embeddings[i], priority);

      const [inserted] = await db
        .insert(schema.memoryNodes)
        .values({
          agentId: agent.id,
          content: chunks[i].text,
          source: source || null,
          sourceType: admission.authority === "evidence" ? `evidence:${sourceType}` : sourceType,
          chunkIndex: chunks[i].index,
          embedding: embeddings[i],
          entities: providedEntities
            ? [...new Set([...providedEntities, ...autoEntities])]
            : autoEntities,
          semanticTags: providedTags
            ? [...new Set([...providedTags, ...autoTags])]
            : autoTags,
          priority: noveltyResult.adjustedPriority,
          resonanceScore: noveltyResult.resonanceScore,
          status: "active",
        })
        .returning({ id: schema.memoryNodes.id });

      // Store novelty score on memory node
      await db.execute(
        sql`UPDATE memory_nodes SET novelty_score = ${noveltyResult.noveltyScore} WHERE id = ${inserted.id}`
      );

      // Store hippocampal code (DG sparse representation)
      await db.insert(schema.hippocampalCodes).values({
        memoryId: inserted.id,
        agentId: agent.id,
        sparseIndices: sparseCode.indices,
        sparseValues: sparseCode.values,
        sparseDim: sparseCode.dim,
        noveltyScore: noveltyResult.noveltyScore,
      });

      // Emotional valence analysis
      const { vector: ev, salience } = analyzeValence(chunks[i].text);
      await db.insert(schema.emotionalValence).values({
        memoryId: inserted.id,
        agentId: agent.id,
        valence: ev.valence,
        arousal: ev.arousal,
        dominance: ev.dominance,
        certainty: ev.certainty,
        relevance: ev.relevance,
        urgency: ev.urgency,
        intensity: salience.intensity,
        decayResistance: salience.decayResistance,
        recallBoost: salience.recallBoost,
        dominantDimension: salience.dominantDimension,
      });

      insertedIds.push(inserted.id);
    }

  // Form synapses
  const synapsesFormed = await formSynapses(agent.id, insertedIds);

  return {
    agentId,
    chunksStored: insertedIds.length,
    nodeIds: insertedIds,
    synapsesFormed,
  };
}

/**
 * POST /api/v1/ingest
 * Body: { agentId, content, source?, sourceType?, priority?, entities?, semanticTags? }
 */
router.post("/", async (req: Request, res: Response) => {
  try {
    const result = await ingestContent({
      ...(req.body || {}),
      principal: req.cortexPrincipal?.id,
      trust: req.cortexPrincipal?.trust,
    });
    res.json(result);
  } catch (err: any) {
    if (err && err.status) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    console.error("[ingest] Error:", err);
    res.status(500).json({ error: "Ingestion failed" });
  }
});

export { router as ingestRouter };
