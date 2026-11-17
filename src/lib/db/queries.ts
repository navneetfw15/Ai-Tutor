import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { ClipDTO, LessonDTO, LessonSummaryDTO, MessageDTO } from "@/lib/lesson/dto";
import { db } from "./client";
import { clips, lessons, messages, type MessageRow } from "./schema";

export interface ClipMeta {
  id: string;
  messageId: string;
  sceneIndex: number;
  durationMs: number;
  words: ClipDTO["words"];
}

export const clipUrl = (id: string) => `/api/clips/${id}`;

export function clipToDTO(c: ClipMeta): ClipDTO {
  return { sceneIndex: c.sceneIndex, url: clipUrl(c.id), durationMs: c.durationMs, words: c.words };
}

export function messageToDTO(m: MessageRow, messageClips: ClipMeta[]): MessageDTO {
  return {
    id: m.id,
    role: m.role,
    text: m.text,
    script: m.script ?? null,
    suggestions: m.suggestions ?? [],
    voiceMode: m.voiceMode,
    clips: messageClips.filter((c) => c.messageId === m.id).map(clipToDTO),
    createdAt: m.createdAt.toISOString(),
  };
}

/** Clip metadata only - never selects the audio bytes. */
export async function clipMetaForMessages(messageIds: string[]): Promise<ClipMeta[]> {
  if (messageIds.length === 0) return [];
  return db()
    .select({
      id: clips.id,
      messageId: clips.messageId,
      sceneIndex: clips.sceneIndex,
      durationMs: clips.durationMs,
      words: clips.words,
    })
    .from(clips)
    .where(inArray(clips.messageId, messageIds))
    .orderBy(asc(clips.sceneIndex));
}

export async function getLessonDTO(id: string, viewerId: string | null): Promise<LessonDTO | null> {
  const d = db();
  // One HTTP round trip to Neon for all three reads.
  const [lessonRows, rows, meta] = await d.batch([
    d.select().from(lessons).where(eq(lessons.id, id)).limit(1),
    d.select().from(messages).where(eq(messages.lessonId, id)).orderBy(asc(messages.seq)),
    d
      .select({
        id: clips.id,
        messageId: clips.messageId,
        sceneIndex: clips.sceneIndex,
        durationMs: clips.durationMs,
        words: clips.words,
      })
      .from(clips)
      .where(inArray(clips.messageId, d.select({ id: messages.id }).from(messages).where(eq(messages.lessonId, id))))
      .orderBy(asc(clips.sceneIndex)),
  ]);
  const lesson = lessonRows[0];
  if (!lesson) return null;
  return {
    id: lesson.id,
    title: lesson.title,
    topic: lesson.topic,
    createdAt: lesson.createdAt.toISOString(),
    isOwner: viewerId !== null && viewerId === lesson.ownerId,
    messages: rows.map((m) => messageToDTO(m, meta)),
  };
}

export async function listLessons(ownerId: string, limit = 40): Promise<LessonSummaryDTO[]> {
  const rows = await db()
    .select({ id: lessons.id, title: lessons.title, topic: lessons.topic, createdAt: lessons.createdAt })
    .from(lessons)
    .where(eq(lessons.ownerId, ownerId))
    .orderBy(desc(lessons.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

export async function nextSeq(lessonId: string): Promise<number> {
  const [row] = await db()
    .select({ max: sql<number>`coalesce(max(${messages.seq}), 0)` })
    .from(messages)
    .where(eq(messages.lessonId, lessonId));
  return Number(row?.max ?? 0) + 1;
}

export async function getClipMeta(messageId: string, sceneIndex: number): Promise<ClipMeta | null> {
  const [row] = await db()
    .select({
      id: clips.id,
      messageId: clips.messageId,
      sceneIndex: clips.sceneIndex,
      durationMs: clips.durationMs,
      words: clips.words,
    })
    .from(clips)
    .where(and(eq(clips.messageId, messageId), eq(clips.sceneIndex, sceneIndex)))
    .limit(1);
  return row ?? null;
}

/** Message (with its lesson owner) and the requested scene's clip metadata in one round trip. */
export async function getAudioContext(messageId: string, sceneIndex: number) {
  const d = db();
  const [rows, clipRows] = await d.batch([
    d
      .select({ message: messages, ownerId: lessons.ownerId })
      .from(messages)
      .innerJoin(lessons, eq(lessons.id, messages.lessonId))
      .where(eq(messages.id, messageId))
      .limit(1),
    d
      .select({
        id: clips.id,
        messageId: clips.messageId,
        sceneIndex: clips.sceneIndex,
        durationMs: clips.durationMs,
        words: clips.words,
      })
      .from(clips)
      .where(and(eq(clips.messageId, messageId), eq(clips.sceneIndex, sceneIndex)))
      .limit(1),
  ]);
  return { row: rows[0] ?? null, clip: clipRows[0] ?? null };
}
