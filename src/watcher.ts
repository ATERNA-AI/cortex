import { watch } from "chokidar";
import { ingestFile } from "./ingestion/ingest-markdown.js";
import { ingestTelegramFile } from "./ingestion/ingest-telegram.js";
import { ingestLimitlessFile } from "./ingestion/ingest-limitless.js";
import { initDatabase, db, schema } from "./db/index.js";
import { eq } from "drizzle-orm";
import "dotenv/config";
import { defaultAgentId } from "./default-agent.js";

const DEBOUNCE_MS = 5 * 60 * 1000; // 5 minutes
const pendingIngests = new Map<string, NodeJS.Timeout>();

/**
 * File watcher for automatic re-ingestion on changes.
 * Watches the agent workspace memory/ directory and related paths.
 * Debounced at 5 minutes to avoid thrashing.
 */
async function startWatcher() {
  await initDatabase();

  const agentExternalId = process.argv[2] || defaultAgentId();
  const workspace =
    process.env.CORTEX_WORKSPACE || process.cwd();

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
        name:
          agentExternalId.charAt(0).toUpperCase() + agentExternalId.slice(1),
        ownerId: "rez",
      })
      .returning();
  }

  const watchPaths = [
    `${workspace}/memory`,
    `${workspace}/MEMORY.md`,
    `${workspace}/STANDING-ORDERS.md`,
    `${workspace}/context/telegram`,
    `${workspace}/context/limitless`,
    `${workspace}/logs`,
  ];

  console.log(`[watcher] Watching for changes (agent: ${agent.name})`);
  console.log(`[watcher] Paths: ${watchPaths.join(", ")}`);
  console.log(`[watcher] Debounce: ${DEBOUNCE_MS / 1000}s`);

  const watcher = watch(watchPaths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  function queueIngest(filePath: string) {
    if (!filePath.endsWith(".md")) return;

    // Clear existing debounce timer for this file
    if (pendingIngests.has(filePath)) {
      clearTimeout(pendingIngests.get(filePath)!);
    }

    pendingIngests.set(
      filePath,
      setTimeout(async () => {
        pendingIngests.delete(filePath);
        console.log(`[watcher] Ingesting: ${filePath}`);

        try {
          let sourceType = "markdown";
          if (filePath.includes("/telegram/")) sourceType = "telegram";
          if (filePath.includes("/limitless/")) sourceType = "limitless";

          if (sourceType === "telegram") {
            await ingestTelegramFile(agent.id, filePath);
          } else if (sourceType === "limitless") {
            await ingestLimitlessFile(agent.id, filePath);
          } else {
            await ingestFile({
              agentId: agent.id,
              sourcePath: filePath,
              sourceType,
            });
          }
          console.log(`[watcher] Done: ${filePath}`);
        } catch (err) {
          console.error(`[watcher] Error ingesting ${filePath}:`, err);
        }
      }, DEBOUNCE_MS)
    );

    console.log(
      `[watcher] Queued: ${filePath} (will ingest in ${DEBOUNCE_MS / 1000}s)`
    );
  }

  watcher
    .on("add", queueIngest)
    .on("change", queueIngest)
    .on("error", (err) => console.error("[watcher] Error:", err));

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log("\n[watcher] Shutting down...");
    watcher.close();
    process.exit(0);
  });
}

startWatcher();
