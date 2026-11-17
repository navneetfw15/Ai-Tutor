/**
 * Dev tool: generate one lesson with the configured model and print a summary.
 * Usage: node --env-file=.env.local --import tsx scripts/gen-sample.ts "topic" [out.json]
 */
import { writeFileSync } from "node:fs";
import { generateLesson } from "../src/lib/ai/generate";
import { sceneText } from "../src/lib/lesson/types";

async function main() {
  const topic = process.argv[2] ?? "How does photosynthesis work?";
  const out = process.argv[3];
  const res = await generateLesson(topic);
  console.log(`model=${res.model} time=${(res.ms / 1000).toFixed(1)}s words=${res.words} scenes=${res.script.scenes.length}`);
  console.log(`title: ${res.script.title}\nsummary: ${res.script.summary}`);
  res.script.scenes.forEach((s, i) => {
    const kinds = s.beats.flatMap((b) => b.draw).map((a) => a.type);
    console.log(`  ${i + 1}. ${s.title} [clear=${s.clear}] words=${sceneText(s).split(/\s+/).length} actions=${kinds.length} (${kinds.join(",")})`);
  });
  const all = res.script.scenes.flatMap((s) => s.beats.flatMap((b) => b.draw));
  console.log(`actions=${all.length} withCue=${all.filter((a) => a.cue).length}`);
  console.log("suggestions:", res.script.suggestions.join(" | "));
  if (res.warnings.length) console.log("warnings:\n  " + res.warnings.join("\n  "));
  if (out) writeFileSync(out, JSON.stringify(res.script, null, 2));
}

main().catch((e) => {
  console.error("FAILED:", e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
