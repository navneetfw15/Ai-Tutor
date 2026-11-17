import { describe, expect, it } from "vitest";
import { wordsFromAlignment, type CharAlignment } from "@/lib/tts/align";

/** Build an alignment where each character lasts `step` seconds. */
function uniform(text: string, step = 0.1, offset = 0.05): CharAlignment {
  const chars = Array.from(text);
  return {
    characters: chars,
    character_start_times_seconds: chars.map((_, i) => offset + i * step),
    character_end_times_seconds: chars.map((_, i) => offset + (i + 1) * step),
  };
}

describe("wordsFromAlignment", () => {
  it("maps characters to words with exact offsets", () => {
    const text = "Hi there, friend.";
    const { words, durationMs } = wordsFromAlignment(text, uniform(text));
    expect(words.map(([a, b]) => text.slice(a, b))).toEqual(["Hi", "there,", "friend."]);
    expect(words[0]).toEqual([0, 2, 50, 250]);
    expect(words[1][2]).toBe(350); // 'there,' starts at char 3
    expect(durationMs).toBe(50 + 17 * 100 + 250);
  });

  it("keeps word starts non-decreasing even with jittery data", () => {
    const text = "one two three";
    const al = uniform(text);
    al.character_start_times_seconds[4] = 0.0; // 't' of "two" goes backwards in time
    const { words } = wordsFromAlignment(text, al);
    for (let i = 1; i < words.length; i++) expect(words[i][2]).toBeGreaterThanOrEqual(words[i - 1][2]);
    for (const w of words) expect(w[3]).toBeGreaterThanOrEqual(w[2]);
  });

  it("falls back to proportional mapping when lengths differ", () => {
    const text = "Plants need sunlight.";
    const normalized = "Plants need sunlight"; // provider dropped the period
    const { words } = wordsFromAlignment(text, uniform(normalized));
    expect(words).toHaveLength(3);
    expect(words[2][3]).toBeGreaterThan(words[0][3]);
  });

  it("rejects empty input", () => {
    expect(() => wordsFromAlignment("hello", { characters: [], character_start_times_seconds: [], character_end_times_seconds: [] })).toThrow();
    expect(() => wordsFromAlignment("   ", uniform("   "))).toThrow();
  });
});
