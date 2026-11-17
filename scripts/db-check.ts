/**
 * Connectivity + schema smoke test: writes a lesson, message and (binary) clip, reads them back,
 * verifies the bytes survive the round trip, then cleans up.
 * Usage: npm run db:check
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../src/lib/db/client";
import { clips, lessons, messages } from "../src/lib/db/schema";

async function main() {
  const d = db();
  const id = `check_${randomBytes(4).toString("hex")}`;
  const audio = randomBytes(2048);

  await d.insert(lessons).values({ id, ownerId: "check", topic: "db check", title: "DB check" });
  await d.insert(messages).values({ id: `${id}_m`, lessonId: id, seq: 1, role: "assistant", text: "hello" });
  await d.insert(clips).values({
    id: `${id}_c`,
    messageId: `${id}_m`,
    sceneIndex: 0,
    audio,
    bytes: audio.length,
    durationMs: 1234,
    words: [[0, 5, 0, 400]],
  });

  const [row] = await d.select().from(clips).where(eq(clips.id, `${id}_c`));
  const same = row && Buffer.compare(row.audio, audio) === 0;
  console.log(`bytea round trip: ${same ? "OK" : "MISMATCH"} (${row?.audio.length} bytes)`);
  console.log("jsonb words:", JSON.stringify(row?.words));

  await d.delete(lessons).where(eq(lessons.id, id)); // cascades to messages + clips
  const left = await d.select().from(messages).where(eq(messages.lessonId, id));
  console.log(`cascade delete: ${left.length === 0 ? "OK" : "FAILED"}`);
  if (!same || left.length) process.exit(1);
}

main().catch((err) => {
  console.error("DB check failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
