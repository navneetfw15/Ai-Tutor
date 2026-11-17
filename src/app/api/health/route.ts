import { sql } from "drizzle-orm";
import { connection } from "next/server";
import { handle, ok } from "@/lib/api";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";

/** Deployment check: verifies configuration and database connectivity. Never returns secrets. */
export async function GET() {
  // Always evaluate at request time, never at build time. This sits outside `handle` on purpose:
  // during prerendering Next aborts via a rejection that must reach the framework, not our logger.
  await connection();
  return handle(async () => {
    const config = env(); // throws ConfigError -> 503 if required variables are missing
    await db().execute(sql`select 1`);
    return ok({
      ok: true,
      database: "connected",
      llm: { provider: "google", model: config.GEMINI_MODEL },
      voice: config.ttsProvider,
    });
  });
}
