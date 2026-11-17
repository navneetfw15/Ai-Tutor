import { describe, expect, it, vi } from "vitest";
import { AudioPreparer, type AudioFn } from "@/lib/client/audioPreparer";
import { ClientApiError } from "@/lib/client/api";
import type { ClipDTO, MessageDTO } from "@/lib/lesson/dto";

const clip = (i: number): ClipDTO => ({ sceneIndex: i, url: `/api/clips/c${i}`, durationMs: 1000, words: [[0, 3, 0, 500]] });

function message(scenes: number, clips: ClipDTO[] = [], voiceMode: MessageDTO["voiceMode"] = "eleven"): MessageDTO {
  return {
    id: "m1",
    role: "assistant",
    text: "",
    suggestions: [],
    voiceMode,
    clips,
    createdAt: "2026-01-01T00:00:00Z",
    script: {
      title: "T",
      summary: "",
      suggestions: [],
      scenes: Array.from({ length: scenes }, (_, i) => ({ title: `S${i}`, clear: true, beats: [{ say: `Scene ${i}.`, draw: [] }] })),
    },
  };
}

function setup(audio: AudioFn) {
  const hooks = { onClip: vi.fn(), onFallback: vi.fn(), onFailure: vi.fn() };
  const sleeps: number[] = [];
  const preparer = new AudioPreparer(hooks, audio, async (ms) => void sleeps.push(ms));
  return { preparer, hooks, sleeps };
}

describe("AudioPreparer", () => {
  it("records every missing scene and reports each clip", async () => {
    const audio = vi.fn<AudioFn>(async (_id, scene) => ({ voiceMode: "eleven", clip: clip(scene) }));
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(4));
    expect(audio).toHaveBeenCalledTimes(4);
    expect(hooks.onClip).toHaveBeenCalledTimes(4);
    expect(hooks.onFallback).not.toHaveBeenCalled();
    expect(hooks.onFailure).not.toHaveBeenCalled();
    expect(preparer.isBusy("m1")).toBe(false);
  });

  it("skips scenes that already have clips and does nothing when complete", async () => {
    const audio = vi.fn<AudioFn>(async (_id, scene) => ({ voiceMode: "eleven", clip: clip(scene) }));
    const { preparer } = setup(audio);
    await preparer.ensure(message(3, [clip(0), clip(2)]));
    expect(audio.mock.calls.map((c) => c[1])).toEqual([1]);
    audio.mockClear();
    await preparer.ensure(message(2, [clip(0), clip(1)]));
    expect(audio).not.toHaveBeenCalled();
  });

  it("ignores browser-voice messages and messages without a script", async () => {
    const audio = vi.fn<AudioFn>();
    const { preparer } = setup(audio);
    await preparer.ensure(message(3, [], "browser"));
    await preparer.ensure({ ...message(3), script: null });
    expect(audio).not.toHaveBeenCalled();
  });

  it("never runs more than two requests at once", async () => {
    let running = 0;
    let peak = 0;
    const audio: AudioFn = async (_id, scene) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--;
      return { voiceMode: "eleven", clip: clip(scene) };
    };
    const { preparer } = setup(audio);
    await preparer.ensure(message(6));
    expect(peak).toBe(2);
  });

  it("does not start a second job for a message that is already being recorded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const audio = vi.fn<AudioFn>(async (_id, scene) => {
      await gate;
      return { voiceMode: "eleven", clip: clip(scene) };
    });
    const { preparer } = setup(audio);
    const first = preparer.ensure(message(2));
    expect(preparer.isBusy("m1")).toBe(true);
    await preparer.ensure(message(2)); // returns immediately
    release();
    await first;
    expect(audio).toHaveBeenCalledTimes(2);
  });

  it("falls back to browser voice when the server says so, and stops requesting", async () => {
    const audio = vi.fn<AudioFn>(async () => ({ voiceMode: "browser" }));
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(6));
    expect(hooks.onFallback).toHaveBeenCalledWith("m1");
    expect(hooks.onFailure).not.toHaveBeenCalled();
    expect(audio.mock.calls.length).toBeLessThanOrEqual(2); // the two parallel workers; no more after fallback
  });

  it("falls back for viewers who do not own the lesson (403)", async () => {
    const audio = vi.fn<AudioFn>(async () => {
      throw new ClientApiError("no", "forbidden", 403);
    });
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(3));
    expect(hooks.onFallback).toHaveBeenCalledWith("m1");
  });

  it("retries transient failures with backoff and then succeeds", async () => {
    let calls = 0;
    const audio: AudioFn = async (_id, scene) => {
      calls++;
      if (calls <= 2) throw new ClientApiError("busy", "tts_unavailable", 503);
      return { voiceMode: "eleven", clip: clip(scene) };
    };
    const { preparer, hooks, sleeps } = setup(audio);
    await preparer.ensure(message(1));
    expect(hooks.onClip).toHaveBeenCalledTimes(1);
    expect(hooks.onFailure).not.toHaveBeenCalled();
    expect(sleeps).toEqual([900, 1800]);
  });

  it("reports a failure after retries are exhausted", async () => {
    const audio = vi.fn<AudioFn>(async () => {
      throw new ClientApiError("The voice service is busy.", "tts_unavailable", 503);
    });
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(1));
    expect(audio).toHaveBeenCalledTimes(3); // first try + 2 retries
    expect(hooks.onFailure).toHaveBeenCalledWith("m1", "The voice service is busy.");
    expect(preparer.isBusy("m1")).toBe(false);
  });

  it("does not retry non-transient errors such as rate limits", async () => {
    const audio = vi.fn<AudioFn>(async () => {
      throw new ClientApiError("Slow down", "rate_limited", 429);
    });
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(1));
    expect(audio).toHaveBeenCalledTimes(1);
    expect(hooks.onFailure).toHaveBeenCalledWith("m1", "Slow down");
  });

  it("can be retried after a failure", async () => {
    let fail = true;
    const audio: AudioFn = async (_id, scene) => {
      if (fail) throw new ClientApiError("nope", "rate_limited", 429);
      return { voiceMode: "eleven", clip: clip(scene) };
    };
    const { preparer, hooks } = setup(audio);
    await preparer.ensure(message(1));
    expect(hooks.onFailure).toHaveBeenCalledTimes(1);
    fail = false;
    await preparer.ensure(message(1));
    expect(hooks.onClip).toHaveBeenCalledTimes(1);
  });
});
