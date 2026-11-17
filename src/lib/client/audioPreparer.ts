import type { ClipDTO, MessageDTO, VoiceMode } from "@/lib/lesson/dto";
import { ClientApiError } from "./api";

export interface PreparerHooks {
  /** A scene's narration was recorded. */
  onClip(messageId: string, clip: ClipDTO): void;
  /** Voice must come from the browser instead (provider unavailable, or not the owner). */
  onFallback(messageId: string): void;
  /** Recording failed in a way the user should decide about (retry / browser voice). */
  onFailure(messageId: string, message: string): void;
}

export type AudioFn = (messageId: string, scene: number) => Promise<{ voiceMode: VoiceMode; clip?: ClipDTO }>;

const CONCURRENCY = 2;
const MAX_RETRIES = 2;

/**
 * Records the missing narration clips of a message: two scenes at a time, retrying transient
 * failures, and degrading to browser voice when the server says so. Framework-independent.
 */
export class AudioPreparer {
  private inflight = new Set<string>();

  constructor(
    private readonly hooks: PreparerHooks,
    private readonly requestAudio: AudioFn,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  isBusy(messageId: string): boolean {
    return this.inflight.has(messageId);
  }

  async ensure(message: MessageDTO): Promise<void> {
    const script = message.script;
    if (!script || message.voiceMode !== "eleven" || this.inflight.has(message.id)) return;
    const have = new Set(message.clips.map((c) => c.sceneIndex));
    const queue = Array.from({ length: script.scenes.length }, (_, i) => i).filter((i) => !have.has(i));
    if (queue.length === 0) return;

    this.inflight.add(message.id);
    let fellBack = false;
    let failure: string | null = null;

    const worker = async () => {
      while (queue.length > 0 && !fellBack && !failure) {
        const scene = queue.shift()!;
        for (let attempt = 0; ; attempt++) {
          try {
            const res = await this.requestAudio(message.id, scene);
            if (res.voiceMode === "browser" || !res.clip) fellBack = true;
            else this.hooks.onClip(message.id, res.clip);
            break;
          } catch (err) {
            const e = err instanceof ClientApiError ? err : null;
            if (e?.status === 403) {
              fellBack = true; // viewing someone else's lesson: narrate in the browser
              break;
            }
            if (e?.transient && attempt < MAX_RETRIES) {
              await this.sleep(900 * (attempt + 1));
              continue;
            }
            failure = e?.message ?? "Could not record the narration.";
            break;
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    } finally {
      this.inflight.delete(message.id);
    }
    if (fellBack) this.hooks.onFallback(message.id);
    else if (failure) this.hooks.onFailure(message.id, failure);
  }
}
