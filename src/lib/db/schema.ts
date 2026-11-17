import {
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import type { Script, WordTiming } from "@/lib/lesson/types";

/**
 * Postgres bytea <-> Node Buffer. The Neon HTTP driver accepts hex text (`\x...`) as a parameter
 * and returns bytea columns as a Buffer/Uint8Array.
 */
const bytea = customType<{ data: Buffer; driverData: string | Uint8Array }>({
  dataType() {
    return "bytea";
  },
  toDriver(value) {
    return `\\x${value.toString("hex")}`;
  },
  fromDriver(value) {
    if (typeof value === "string") {
      return Buffer.from(value.startsWith("\\x") ? value.slice(2) : value, "hex");
    }
    return Buffer.from(value);
  },
});

export const lessons = pgTable(
  "lessons",
  {
    id: text("id").primaryKey(),
    /** Anonymous per-browser owner id (cookie). There are no user accounts. */
    ownerId: text("owner_id").notNull(),
    topic: text("topic").notNull(),
    title: text("title").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("lessons_owner_created_idx").on(t.ownerId, t.createdAt)],
);

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    lessonId: text("lesson_id")
      .notNull()
      .references(() => lessons.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role", { enum: ["user", "assistant"] }).notNull(),
    /** Chat text. For assistant messages with a script this is the short intro/reply. */
    text: text("text").notNull(),
    /** Validated lesson script (whiteboard + narration). Null for plain messages. */
    script: jsonb("script").$type<Script | null>(),
    suggestions: jsonb("suggestions").$type<string[]>(),
    /** "eleven" = narration comes from stored TTS clips, "browser" = browser speech synthesis. */
    voiceMode: text("voice_mode", { enum: ["eleven", "browser"] }).notNull().default("eleven"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("messages_lesson_seq_uq").on(t.lessonId, t.seq)],
);

export const clips = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    sceneIndex: integer("scene_index").notNull(),
    audio: bytea("audio").notNull(),
    mime: text("mime").notNull().default("audio/mpeg"),
    bytes: integer("bytes").notNull(),
    durationMs: integer("duration_ms").notNull(),
    words: jsonb("words").$type<WordTiming[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [unique("clips_message_scene_uq").on(t.messageId, t.sceneIndex)],
);

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

export type LessonRow = typeof lessons.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type ClipRow = typeof clips.$inferSelect;
