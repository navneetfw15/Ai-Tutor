/**
 * Applies the SQL migrations in ./drizzle to the Neon database.
 * Usage: npm run db:migrate   (reads DATABASE_URL_UNPOOLED / DATABASE_URL from .env.local or the environment)
 */
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { migrate } from "drizzle-orm/neon-http/migrator";

async function main() {
  const url =
    process.env.DATABASE_URL_UNPOOLED || (process.env.DATABASE_URL ?? "").replace("-pooler", "");
  if (!url) throw new Error("Set DATABASE_URL (or DATABASE_URL_UNPOOLED) before running migrations.");
  const db = drizzle({ client: neon(url) });
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("Migrations applied.");
}

main().catch((err) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
