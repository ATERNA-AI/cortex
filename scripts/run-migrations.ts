import { db, initDatabase } from "../src/db/index.js";
import { sql } from "drizzle-orm";

async function main() {
  console.log("[migrations] Running CORTEX V2.4 migrations...");

  // initDatabase() applies incremental ALTERs on top of the base schema,
  // so a fresh database needs `npm run db:push` (drizzle-kit) first.
  const check = await db.execute(
    sql`SELECT to_regclass('public.memory_nodes') AS t`
  );
  if (!check.rows[0]?.t) {
    console.error(
      "[migrations] Base schema not found (memory_nodes missing).\n" +
        "[migrations] On a fresh database, create the base schema first:\n" +
        "[migrations]   npm run db:push\n" +
        "[migrations] then re-run: npm run migrate"
    );
    process.exit(1);
  }

  await initDatabase();
  console.log("[migrations] All migrations applied successfully.");
  process.exit(0);
}

main().catch((err) => {
  console.error("[migrations] Failed:", err);
  process.exit(1);
});
