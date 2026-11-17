import { and, eq } from "drizzle-orm";
import { ApiError, handle, ok } from "@/lib/api";
import { db } from "@/lib/db/client";
import { getLessonDTO } from "@/lib/db/queries";
import { lessons } from "@/lib/db/schema";
import { readOwnerId } from "@/lib/session";

const ID_RE = /^[0-9A-Za-z]{6,32}$/;

export async function GET(_req: Request, ctx: RouteContext<"/api/lessons/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    if (!ID_RE.test(id)) throw new ApiError(404, "not_found", "Lesson not found.");
    const lesson = await getLessonDTO(id, await readOwnerId());
    if (!lesson) throw new ApiError(404, "not_found", "We couldn't find that lesson. It may have been deleted.");
    return ok({ lesson });
  });
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/lessons/[id]">) {
  return handle(async () => {
    const { id } = await ctx.params;
    const ownerId = await readOwnerId();
    if (!ownerId || !ID_RE.test(id)) throw new ApiError(404, "not_found", "Lesson not found.");
    const deleted = await db()
      .delete(lessons)
      .where(and(eq(lessons.id, id), eq(lessons.ownerId, ownerId)))
      .returning({ id: lessons.id });
    if (deleted.length === 0) throw new ApiError(404, "not_found", "Lesson not found.");
    return ok({ deleted: true });
  });
}
