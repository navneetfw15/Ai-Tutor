import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { env } from "@/lib/env";
import * as schema from "./schema";

let cached: ReturnType<typeof create> | undefined;

function create() {
  const sql = neon(env().DATABASE_URL);
  return drizzle({ client: sql, schema });
}

/** Lazily-created Drizzle client over Neon's serverless HTTP driver. */
export function db() {
  cached ??= create();
  return cached;
}

export { schema };
