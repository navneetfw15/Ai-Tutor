import { sql } from "drizzle-orm";
import { db } from "@/lib/db/client";

export interface RateResult {
  ok: boolean;
  count: number;
  limit: number;
  retryAfterSec: number;
}

/**
 * Fixed-window counter stored in Postgres (no extra service needed). One atomic upsert per hit.
 * `key` should include what is being limited and who, e.g. `lesson:u:<ownerId>`.
 */
export async function hit(key: string, limit: number, windowSec = 3600): Promise<RateResult> {
  const result = await db().execute(sql`
    insert into rate_limits (key, window_start, count)
    values (${key}, now(), 1)
    on conflict (key) do update set
      window_start = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then now() else rate_limits.window_start end,
      count = case when rate_limits.window_start < now() - make_interval(secs => ${windowSec}) then 1 else rate_limits.count + 1 end
    returning count, extract(epoch from (window_start + make_interval(secs => ${windowSec}) - now()))::int as retry_after
  `);
  const row = (result.rows?.[0] ?? {}) as { count?: number; retry_after?: number };
  const count = Number(row.count ?? 1);
  return { ok: count <= limit, count, limit, retryAfterSec: Math.max(1, Number(row.retry_after ?? windowSec)) };
}
