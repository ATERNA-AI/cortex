import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, basename } from "path";
import { db, schema } from "../db/index.js";
import { chunkText } from "./chunker.js";
import { embedTexts } from "./embeddings.js";
import { extractEntities, extractSemanticTags } from "./entities.js";
import { formSynapses } from "./synapse-formation.js";
import { hippocampalEncode } from "../hippocampus/index.js";
import { analyzeValence } from "../valence/index.js";
import { eq, and, sql } from "drizzle-orm";
import "dotenv/config";
import { defaultAgentId } from "../default-agent.js";

interface IngestOptions {
  agentId: number;
  sourcePath: string;
  sourceType?: string;
  priority?: number;
}

/**
 * Determine priority from file path/content.
 * P0: MEMORY.md, STANDING-ORDERS.md, SOUL.md, AGENTS.md
 * P1: Daily memory files, USER.md
 * P2: Logs, enhancement files
 * P3: Telegram, limitless
 * P4: Ephemeral/temp
 */
function inferPriority(filePath: string): number {
  const name = basename(filePath).toLowerCase();
  if (
    ["memory.md", "standing-orders.md", "soul.md", "agents.md"].includes(name)
  ) {
    return 0;
  }
  if (name === "user.md" || /^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
    return 1;
  }
  if (name.startsWith("enhancement") || filePath.includes("/logs/")) {
    return 2;
  }
  if (
    filePath.includes("/telegram/") ||
    filePath.includes("/limitless/")
  ) {
    return 3;
  }
  return 2;
}

/**
 * Ingest a single markdown file: chunk → embed → store → form synapses.
 */
export async function ingestFile(options: IngestOptions): Promise<number> {
  const {
    agentId,
    sourcePath,
    sourceType = "markdown",
    priority,
  } = options;

  const content = readFileSync(sourcePath, "utf-8");
  if (!content.trim()) return 0;

  const filePriority = priority ?? inferPriority(sourcePath);

  // Check if already ingested (by source path) — delete old chunks to re-ingest
  const existing = await db
    .select({ id: schema.memoryNodes.id })
    .from(schema.memoryNodes)
    .where(
      and(
        eq(schema.memoryNodes.agentId, agentId),
        eq(schema.memoryNodes.source, sourcePath)
      )
    );

  if (existing.length > 0) {
    await db
      .delete(schema.memoryNodes)
      .where(
        and(
          eq(schema.memoryNodes.agentId, agentId),
          eq(schema.memoryNodes.source, sourcePath)
        )
      );
    console.log(
      `[ingest] Cleared ${existing.length} old chunks for ${basename(sourcePath)}`
    );
  }

  // Chunk
  const chunks = chunkText(content);
  console.log(
    `[ingest] ${basename(sourcePath)}: ${chunks.length} chunks (${content.length} chars)`
  );

  // Extract entities & tags per chunk
  const chunkEntities = await Promise.all(chunks.map((c) => extractEntities(c.text)));
  const chunkTags = chunks.map((c) => extractSemanticTags(c.text));

  // Embed all chunks
  const embeddings = await embedTexts(chunks.map((c) => c.text));

  // Store in DB with surprise-gated resonance
  const insertedIds: number[] = [];
  for (let i = 0; i < chunks.length; i++) {
    // Hippocampal encoding: DG pattern separation + CA1 novelty detection
    const { sparseCode, noveltyResult } =
      await hippocampalEncode(agentId, embeddings[i], filePriority);

    const [inserted] = await db
      .insert(schema.memoryNodes)
      .values({
        agentId,
        content: chunks[i].text,
        source: sourcePath,
        sourceType,
        chunkIndex: chunks[i].index,
        embedding: embeddings[i],
        entities: chunkEntities[i],
        semanticTags: chunkTags[i],
        priority: noveltyResult.adjustedPriority,
        resonanceScore: noveltyResult.resonanceScore,
        accessCount: 0,
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
      agentId,
      sparseIndices: sparseCode.indices,
      sparseValues: sparseCode.values,
      sparseDim: sparseCode.dim,
      noveltyScore: noveltyResult.noveltyScore,
    });

    // Emotional valence analysis
    const { vector: ev, salience } = analyzeValence(chunks[i].text);
    await db.insert(schema.emotionalValence).values({
      memoryId: inserted.id,
      agentId,
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

  // Form synapses between new nodes and existing graph
  await formSynapses(agentId, insertedIds);

  return insertedIds.length;
}

/**
 * Recursively find all .md files in a directory.
 */
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...findMarkdownFiles(fullPath));
        } else if (entry.endsWith(".md")) {
          files.push(fullPath);
        }
      } catch {
        // skip inaccessible files
      }
    }
  } catch {
    // skip inaccessible dirs
  }
  return files;
}

/**
 * Ingest all markdown files from V1 corpus directories.
 */
export async function ingestCorpus(agentId: number): Promise<void> {
  const workspace = process.env.CORTEX_WORKSPACE || process.cwd();

  const sourceDirs = [
    { path: workspace, type: "markdown" },
    { path: join(workspace, "memory"), type: "markdown" },
    { path: join(workspace, "logs"), type: "markdown" },
    { path: join(workspace, "context/telegram"), type: "telegram" },
    { path: join(workspace, "context/limitless/lifelogs"), type: "limitless" },
    { path: join(workspace, "context/limitless/lifelogs-new"), type: "limitless" },
    { path: join(workspace, "context/limitless/pulls"), type: "limitless" },
  ];

  // Core files at workspace root
  const coreFiles = [
    "MEMORY.md",
    "STANDING-ORDERS.md",
    "AGENTS.md",
    "SOUL.md",
    "USER.md",
    "TOOLS.md",
  ];

  let totalChunks = 0;

  // Ingest core files first
  for (const file of coreFiles) {
    const fullPath = join(workspace, file);
    try {
      statSync(fullPath);
      const count = await ingestFile({
        agentId,
        sourcePath: fullPath,
        sourceType: "markdown",
      });
      totalChunks += count;
    } catch {
      console.log(`[ingest] Skipping ${file} (not found)`);
    }
  }

  // Ingest from directories
  for (const dir of sourceDirs) {
    try {
      statSync(dir.path);
    } catch {
      console.log(`[ingest] Skipping directory ${dir.path} (not found)`);
      continue;
    }

    const files = findMarkdownFiles(dir.path);
    // Filter out core files we already ingested
    const filtered = files.filter(
      (f) => !coreFiles.some((cf) => f.endsWith(`/${cf}`))
    );

    console.log(`[ingest] ${dir.path}: ${filtered.length} files`);

    for (const file of filtered) {
      try {
        const count = await ingestFile({
          agentId,
          sourcePath: file,
          sourceType: dir.type,
        });
        totalChunks += count;
      } catch (err) {
        console.error(`[ingest] Error ingesting ${file}:`, err);
      }
    }
  }

  console.log(`[ingest] Corpus ingestion complete: ${totalChunks} total chunks`);
}

// CLI entry point
if (process.argv[1]?.endsWith("ingest-markdown.ts") || process.argv[1]?.endsWith("ingest-markdown.js")) {
  const agentExternalId = process.argv[2] || defaultAgentId();

  (async () => {
    const { initDatabase } = await import("../db/index.js");
    await initDatabase();

    // Ensure agent exists
    let [agent] = await db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.externalId, agentExternalId));

    if (!agent) {
      [agent] = await db
        .insert(schema.agents)
        .values({
          externalId: agentExternalId,
          name: agentExternalId.charAt(0).toUpperCase() + agentExternalId.slice(1),
          ownerId: "rez",
        })
        .returning();
      console.log(`[ingest] Created agent: ${agent.name} (id: ${agent.id})`);
    }

    await ingestCorpus(agent.id);
  })();
}
