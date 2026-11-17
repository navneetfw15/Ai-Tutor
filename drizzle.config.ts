import { defineConfig } from "drizzle-kit";

// `drizzle-kit generate` only needs the schema; the URL is used by `drizzle-kit studio`/`push`.
const url =
  process.env.DATABASE_URL_UNPOOLED || (process.env.DATABASE_URL ?? "").replace("-pooler", "");

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dbCredentials: { url },
});
