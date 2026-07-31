import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { SQL } from "drizzle-orm";
import * as schema from "./schema.js";
import "dotenv/config";

const DATABASE_URL = process.env.DATABASE_URL!;
const isNeon = DATABASE_URL.includes("neon.tech");

const client = postgres(DATABASE_URL, {
  ...(isNeon ? { ssl: "require" } : {}),
});

const rawDb = drizzle(client, { schema });

// Neon HTTP driver returns { rows: [...], rowCount: N }.
// postgres-js returns RowList (array-like, no .rows).
// This shim adds .rows/.rowCount at runtime so the entire codebase works unchanged.
interface NeonCompatResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

type CortexDb = Omit<PostgresJsDatabase<typeof schema>, "execute"> & {
  execute: (query: SQL) => Promise<NeonCompatResult>;
};

const origExecute = rawDb.execute.bind(rawDb);
const patchedDb = rawDb as unknown as CortexDb;
(patchedDb as any).execute = async (query: SQL): Promise<NeonCompatResult> => {
  const result = await origExecute(query);
  const arr = Array.isArray(result) ? [...result] : [];
  // postgres-js exposes affected-row count on `.count` — essential for
  // UPDATE/DELETE without RETURNING, where the row array is empty (arr.length
  // would be 0). Prefer `.count`; fall back to arr.length for other drivers.
  const affected =
    typeof (result as any)?.count === "number"
      ? (result as any).count
      : arr.length;
  return Object.assign(result, {
    rows: arr,
    rowCount: affected,
  }) as unknown as NeonCompatResult;
};

export const db = patchedDb;

// Enable pgvector extension on first connection + schema migrations
export async function initDatabase() {
  await client`CREATE EXTENSION IF NOT EXISTS vector`;
  // Append-only admission ledger. Stores provenance and digests, never raw
  // rejected content, so poisoning attempts remain auditable without becoming
  // another executable-memory surface.
  await client`CREATE TABLE IF NOT EXISTS memory_admission_events (
    id BIGSERIAL PRIMARY KEY,
    agent_external_id VARCHAR(255) NOT NULL,
    principal VARCHAR(255) NOT NULL,
    trust VARCHAR(32) NOT NULL,
    authority VARCHAR(32) NOT NULL,
    content_sha256 CHAR(64) NOT NULL,
    admitted BOOLEAN NOT NULL,
    reason VARCHAR(128),
    source VARCHAR(512),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await client`CREATE INDEX IF NOT EXISTS idx_admission_agent_created ON memory_admission_events(agent_external_id, created_at DESC)`;
  // Build 1: novelty_score for surprise-gated ingestion
  await client`ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS novelty_score REAL DEFAULT NULL`;
  // Build 3: last_recalled_at for memory reconsolidation
  await client`ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS last_recalled_at TIMESTAMP DEFAULT NULL`;
  // Build 4: hippocampal codes table for DG pattern separation
  await client`CREATE TABLE IF NOT EXISTS hippocampal_codes (
    id SERIAL PRIMARY KEY,
    memory_id INTEGER NOT NULL UNIQUE REFERENCES memory_nodes(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    sparse_indices INTEGER[] NOT NULL,
    sparse_values REAL[] NOT NULL,
    sparse_dim INTEGER DEFAULT 4096,
    novelty_score REAL,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await client`CREATE INDEX IF NOT EXISTS idx_hc_agent ON hippocampal_codes(agent_id)`;
  await client`CREATE INDEX IF NOT EXISTS idx_hc_memory ON hippocampal_codes(memory_id)`;
  await client`CREATE INDEX IF NOT EXISTS idx_hc_indices ON hippocampal_codes USING GIN(sparse_indices)`;
  // Build 5: emotional valence table for multi-dimensional emotional context
  await client`CREATE TABLE IF NOT EXISTS emotional_valence (
    id SERIAL PRIMARY KEY,
    memory_id INTEGER NOT NULL UNIQUE REFERENCES memory_nodes(id) ON DELETE CASCADE,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    valence REAL NOT NULL DEFAULT 0,
    arousal REAL NOT NULL DEFAULT 0,
    dominance REAL NOT NULL DEFAULT 0,
    certainty REAL NOT NULL DEFAULT 0,
    relevance REAL NOT NULL DEFAULT 0.3,
    urgency REAL NOT NULL DEFAULT 0,
    intensity REAL NOT NULL DEFAULT 0,
    decay_resistance REAL NOT NULL DEFAULT 0,
    recall_boost REAL NOT NULL DEFAULT 0,
    dominant_dimension VARCHAR(32),
    created_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await client`CREATE INDEX IF NOT EXISTS idx_ev_agent ON emotional_valence(agent_id)`;
  await client`CREATE INDEX IF NOT EXISTS idx_ev_memory ON emotional_valence(memory_id)`;
  await client`CREATE INDEX IF NOT EXISTS idx_ev_intensity ON emotional_valence(intensity)`;
  await client`CREATE INDEX IF NOT EXISTS idx_ev_decay_resistance ON emotional_valence(decay_resistance)`;
  // Build 6: procedural memories table for skill/workflow/habit storage
  await client`CREATE TABLE IF NOT EXISTS procedural_memories (
    id SERIAL PRIMARY KEY,
    agent_id INTEGER NOT NULL REFERENCES agents(id),
    name VARCHAR(255) NOT NULL,
    description TEXT NOT NULL,
    procedural_type VARCHAR(32) NOT NULL,
    trigger_context TEXT NOT NULL,
    steps TEXT[] DEFAULT '{}'::text[],
    embedding vector(1024),
    proficiency VARCHAR(32) DEFAULT 'novice',
    execution_count INTEGER DEFAULT 0,
    success_count INTEGER DEFAULT 0,
    success_rate REAL DEFAULT 0,
    domain_tags TEXT[] DEFAULT '{}'::text[],
    source_memory_ids INTEGER[] DEFAULT '{}'::int[],
    version INTEGER DEFAULT 1,
    status VARCHAR(32) DEFAULT 'active',
    last_executed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW() NOT NULL
  )`;
  await client`CREATE INDEX IF NOT EXISTS idx_proc_agent ON procedural_memories(agent_id)`;
  await client`CREATE INDEX IF NOT EXISTS idx_proc_type ON procedural_memories(procedural_type)`;
  await client`CREATE INDEX IF NOT EXISTS idx_proc_proficiency ON procedural_memories(proficiency)`;
  await client`CREATE INDEX IF NOT EXISTS idx_proc_domain_tags ON procedural_memories USING GIN(domain_tags)`;
  await client`CREATE INDEX IF NOT EXISTS idx_proc_status ON procedural_memories(status)`;

  // Build 7: Temporal validity windows (Zep-competitive feature)
  await client`ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP DEFAULT NULL`;
  await client`ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS valid_until TIMESTAMP DEFAULT NULL`;
  await client`ALTER TABLE memory_nodes ADD COLUMN IF NOT EXISTS superseded_by INTEGER DEFAULT NULL`;
  await client`CREATE INDEX IF NOT EXISTS idx_mn_valid_until ON memory_nodes(valid_until) WHERE valid_until IS NOT NULL`;

  // Build 8: Performance indexes for production-scale query patterns
  // Composite index for synapse traversal (CA3 pattern completion, dream pruning)
  await client`CREATE INDEX IF NOT EXISTS idx_synapses_a_strength ON memory_synapses(memory_a, connection_strength)`;
  await client`CREATE INDEX IF NOT EXISTS idx_synapses_b_strength ON memory_synapses(memory_b, connection_strength)`;
  // Composite index for common memory filtering (search, dream, background threads)
  await client`CREATE INDEX IF NOT EXISTS idx_mn_agent_status_priority ON memory_nodes(agent_id, status, priority)`;
  // HNSW index for vector similarity search (pgvector 0.5+)
  await client`CREATE INDEX IF NOT EXISTS idx_mn_embedding_hnsw ON memory_nodes USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64)`;
  // Index for resonance-based queries (dream pruning, consolidation)
  await client`CREATE INDEX IF NOT EXISTS idx_mn_agent_resonance ON memory_nodes(agent_id, resonance_score) WHERE status = 'active'`;

  console.log("[db] pgvector extension enabled, schema migrations applied (v7: production indexes)");
}

export { schema };
