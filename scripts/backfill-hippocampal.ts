/**
 * Backfill hippocampal codes for memories that have embeddings but no DG encoding.
 *
 * Run: npx tsx scripts/backfill-hippocampal.ts [--agent my-agent] [--batch 500] [--dry-run]
 *
 * This is a one-time operation to encode the existing corpus through the
 * Dentate Gyrus sparse coding pipeline. New memories get encoded at ingest time.
 */
import { db, schema, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";
import { dgEncode } from "../src/hippocampus/dentate-gyrus.js";
import { computeNovelty } from "../src/hippocampus/ca1-novelty.js";
import "dotenv/config";

const args = process.argv.slice(2);
const agentFilter = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : null;
const batchSize = args.includes("--batch") ? parseInt(args[args.indexOf("--batch") + 1]) : 500;
const dryRun = args.includes("--dry-run");

async function main() {
  await initDatabase();

  // Resolve agent ID if specified
  let agentIdFilter = "";
  if (agentFilter) {
    const agentResult = await db.execute(sql`
      SELECT id FROM agents WHERE external_id = ${agentFilter} LIMIT 1
    `);
    if (agentResult.rows.length === 0) {
      console.error(`Agent "${agentFilter}" not found`);
      process.exit(1);
    }
    const agentId = (agentResult.rows[0] as { id: number }).id;
    agentIdFilter = ` AND mn.agent_id = ${agentId}`;
    console.log(`[backfill] Filtering to agent: ${agentFilter} (id: ${agentId})`);
  }

  // Count memories needing backfill
  const countResult = await db.execute(sql`
    SELECT COUNT(*) AS cnt FROM memory_nodes mn
    WHERE mn.status = 'active'
      AND mn.embedding IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM hippocampal_codes hc WHERE hc.memory_id = mn.id
      )
  `);
  const totalMissing = Number((countResult.rows[0] as { cnt: string }).cnt);
  console.log(`[backfill] ${totalMissing} memories need hippocampal encoding`);

  if (dryRun) {
    console.log("[backfill] Dry run — exiting without changes");
    process.exit(0);
  }

  if (totalMissing === 0) {
    console.log("[backfill] Nothing to do");
    process.exit(0);
  }

  let processed = 0;
  let errors = 0;

  while (processed < totalMissing) {
    // Fetch a batch of memories missing hippocampal codes
    const batch = await db.execute(sql`
      SELECT mn.id, mn.agent_id, mn.embedding, mn.priority
      FROM memory_nodes mn
      WHERE mn.status = 'active'
        AND mn.embedding IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM hippocampal_codes hc WHERE hc.memory_id = mn.id
        )
      ORDER BY mn.id ASC
      LIMIT ${batchSize}
    `);

    const rows = batch.rows as Array<{
      id: number;
      agent_id: number;
      embedding: string;
      priority: number;
    }>;

    if (rows.length === 0) break;

    for (const row of rows) {
      try {
        // Parse embedding from pg format
        const embedding = (row.embedding as string)
          .slice(1, -1)
          .split(",")
          .map(Number);

        if (embedding.length !== 1024) {
          console.warn(`[backfill] Memory #${row.id}: embedding dim ${embedding.length}, skipping`);
          errors++;
          continue;
        }

        // Encode through DG
        const sparseCode = dgEncode(embedding);

        // Store hippocampal code
        // postgres-js needs array literals, not parameterized casts
        const indicesStr = `{${sparseCode.indices.join(",")}}`;
        const valuesStr = `{${sparseCode.values.join(",")}}`;
        await db.execute(sql`
          INSERT INTO hippocampal_codes (memory_id, agent_id, sparse_indices, sparse_values, sparse_dim, novelty_score)
          VALUES (
            ${row.id},
            ${row.agent_id},
            ${indicesStr}::int[],
            ${valuesStr}::real[],
            ${sparseCode.dim},
            NULL
          )
          ON CONFLICT (memory_id) DO NOTHING
        `);

        processed++;
      } catch (err) {
        console.error(`[backfill] Memory #${row.id} failed:`, err);
        errors++;
      }
    }

    const pct = ((processed / totalMissing) * 100).toFixed(1);
    console.log(`[backfill] Progress: ${processed}/${totalMissing} (${pct}%) — ${errors} errors`);
  }

  console.log(`\n[backfill] Complete: ${processed} encoded, ${errors} errors`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[backfill] Fatal:", err);
  process.exit(1);
});
