/**
 * CORTEX V2 — Embedding Engine
 *
 * Supports three providers:
 *   - "ollama" (default): Local inference via mxbai-embed-large (1024-dim)
 *   - "voyage": VoyageAI API (voyage-3, 1024-dim)
 *   - "local": In-process CPU inference, zero external services (512-dim,
 *     zero-padded to 1024 — padding preserves cosine similarity exactly).
 *     Model weights ship via npm, so it works fully offline: no API keys,
 *     no Ollama daemon, no model downloads at runtime.
 *
 * Configure via env:
 *   EMBEDDING_PROVIDER=ollama|voyage|local (default: ollama)
 *   EMBEDDING_MODEL=mxbai-embed-large|voyage-3 (auto-set per provider)
 *   OLLAMA_URL=http://localhost:11434
 *   VOYAGE_API_KEY=pa-...
 */
import "dotenv/config";

const EMBEDDING_PROVIDER = process.env.EMBEDDING_PROVIDER || "ollama";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const VOYAGE_API_KEY = process.env.VOYAGE_API_KEY || "";
const EMBEDDING_MODEL =
  process.env.EMBEDDING_MODEL ||
  (EMBEDDING_PROVIDER === "voyage"
    ? "voyage-3"
    : EMBEDDING_PROVIDER === "local"
      ? "energetic-ai/model-embeddings-en"
      : "mxbai-embed-large");
const EMBEDDING_DIM = 1024;
const BATCH_SIZE = 32;

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Retry a fetch-bound async call with exponential backoff. Voyage's
 * TLS connections occasionally drop mid-session on long ingest runs
 * (UND_ERR_SOCKET "other side closed"). A single retry with jitter is
 * enough to survive it; three attempts gives us headroom for the
 * rare API 5xx as well.
 */
async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = i === attempts - 1;
      if (isLast) break;
      const backoffMs = 500 * Math.pow(2, i) + Math.floor(Math.random() * 250);
      console.error(
        `[embeddings] ${label} failed (attempt ${i + 1}/${attempts}) — retrying in ${backoffMs}ms:`,
        err instanceof Error ? err.message : err
      );
      await sleep(backoffMs);
    }
  }
  throw lastErr;
}

// ─── Ollama Provider ────────────────────────────────────

async function ollamaEmbed(text: string): Promise<number[]> {
  const response = await fetch(`${OLLAMA_URL}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      prompt: text,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Ollama embedding error (${response.status}): ${error}`);
  }

  const data = (await response.json()) as { embedding: number[] };
  return data.embedding;
}

// ─── Voyage Provider ────────────────────────────────────

async function voyageEmbedBatch(texts: string[]): Promise<number[][]> {
  if (!VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage");
  }

  return withRetry("voyage batch", async () => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: texts,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage embedding error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data.map((d) => d.embedding);
  });
}

async function voyageEmbedQuery(text: string): Promise<number[]> {
  if (!VOYAGE_API_KEY) {
    throw new Error("VOYAGE_API_KEY is required when EMBEDDING_PROVIDER=voyage");
  }

  return withRetry("voyage query", async () => {
    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
        input: [text],
        input_type: "query",
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Voyage query embedding error (${response.status}): ${error}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return data.data[0].embedding;
  });
}

// ─── Local Provider (in-process, offline) ───────────────

interface LocalEmbeddingModel {
  embed: (texts: string[]) => Promise<number[][]>;
}

let localModelPromise: Promise<LocalEmbeddingModel> | null = null;

/**
 * Lazy-load the in-process model exactly once. The weights are bundled
 * in the optional npm packages @energetic-ai/embeddings and
 * @energetic-ai/model-embeddings-en, so first use needs no network.
 */
function getLocalModel(): Promise<LocalEmbeddingModel> {
  if (!localModelPromise) {
    localModelPromise = (async () => {
      let embPkg: any;
      let modelPkg: any;
      try {
        embPkg = (await import("@energetic-ai/embeddings")) as any;
        modelPkg = (await import("@energetic-ai/model-embeddings-en")) as any;
      } catch {
        throw new Error(
          "EMBEDDING_PROVIDER=local requires the optional local-embedding packages. " +
            "Install them with: npm install @energetic-ai/embeddings @energetic-ai/model-embeddings-en"
        );
      }
      const { initModel } = embPkg.default ?? embPkg;
      const { modelSource } = modelPkg.default ?? modelPkg;
      return initModel(modelSource);
    })();
  }
  return localModelPromise;
}

/**
 * Zero-pad a vector to EMBEDDING_DIM so it fits the vector(1024) schema.
 * Appending zeros changes neither dot products against other padded
 * vectors nor norms, so cosine similarity is preserved exactly.
 */
function padToDim(vec: number[]): number[] {
  if (vec.length >= EMBEDDING_DIM) return vec.slice(0, EMBEDDING_DIM);
  return vec.concat(new Array(EMBEDDING_DIM - vec.length).fill(0));
}

async function localEmbedBatch(texts: string[]): Promise<number[][]> {
  const model = await getLocalModel();
  const embeddings = await model.embed(texts);
  return embeddings.map(padToDim);
}

// ─── Unified Interface ──────────────────────────────────

/**
 * Generate embeddings for multiple texts.
 * Routes to Ollama or Voyage based on EMBEDDING_PROVIDER env.
 */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  if (EMBEDDING_PROVIDER === "local") {
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      allEmbeddings.push(...(await localEmbedBatch(batch)));
    }
    return allEmbeddings;
  }

  if (EMBEDDING_PROVIDER === "voyage") {
    const allEmbeddings: number[][] = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const embeddings = await voyageEmbedBatch(batch);
      allEmbeddings.push(...embeddings);
      console.log(
        `[embeddings] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} — ${batch.length} texts (voyage)`
      );
      if (i + BATCH_SIZE < texts.length) await sleep(100);
    }
    return allEmbeddings;
  }

  // Default: Ollama
  const allEmbeddings: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const embeddings = await Promise.all(batch.map((t) => ollamaEmbed(t)));
    allEmbeddings.push(...embeddings);
    console.log(
      `[embeddings] Batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(texts.length / BATCH_SIZE)} — ${batch.length} texts (ollama)`
    );
    if (i + BATCH_SIZE < texts.length) await sleep(200);
  }
  return allEmbeddings;
}

/**
 * Embed a single query text.
 * Uses input_type="query" for Voyage (optimized for search retrieval).
 */
export async function embedQuery(text: string): Promise<number[]> {
  if (EMBEDDING_PROVIDER === "local") {
    const [embedding] = await localEmbedBatch([text]);
    return embedding;
  }
  if (EMBEDDING_PROVIDER === "voyage") {
    return voyageEmbedQuery(text);
  }
  return ollamaEmbed(text);
}

export { EMBEDDING_DIM, EMBEDDING_MODEL, EMBEDDING_PROVIDER };
