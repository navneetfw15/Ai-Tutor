import { eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { clips } from "@/lib/db/schema";

const ID_RE = /^[0-9A-Za-z]{6,32}$/;
const CACHE = "public, max-age=31536000, immutable";

/** Streams a narration clip with HTTP Range support so the audio element can seek. */
export async function GET(req: Request, ctx: RouteContext<"/api/clips/[id]">) {
  const { id } = await ctx.params;
  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });

  const [clip] = await db()
    .select({ audio: clips.audio, mime: clips.mime })
    .from(clips)
    .where(eq(clips.id, id))
    .limit(1);
  if (!clip) return new Response("Not found", { status: 404 });

  const total = clip.audio.length;
  const base = { "Content-Type": clip.mime, "Accept-Ranges": "bytes", "Cache-Control": CACHE };

  const range = req.headers.get("range");
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] !== "" || m[2] !== "")) {
      let start: number;
      let end: number;
      if (m[1] === "") {
        // suffix range: last N bytes
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === "" ? total - 1 : Math.min(Number(m[2]), total - 1);
      }
      if (start >= total || start > end) {
        return new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${total}` } });
      }
      const slice = clip.audio.subarray(start, end + 1);
      return new Response(new Uint8Array(slice), {
        status: 206,
        headers: { ...base, "Content-Range": `bytes ${start}-${end}/${total}`, "Content-Length": String(slice.length) },
      });
    }
  }
  return new Response(new Uint8Array(clip.audio), { headers: { ...base, "Content-Length": String(total) } });
}
