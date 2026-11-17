import type { Script, WordTiming } from "./types";

/** Wire types shared by the API routes and the browser. */

export interface ClipDTO {
  sceneIndex: number;
  /** URL of the MP3 for this scene. */
  url: string;
  durationMs: number;
  words: WordTiming[];
}

export type VoiceMode = "eleven" | "browser";

export interface MessageDTO {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Voiced + drawn content (the lesson or a mini-lesson answer); null for plain text. */
  script: Script | null;
  suggestions: string[];
  voiceMode: VoiceMode;
  clips: ClipDTO[];
  createdAt: string;
}

export interface LessonDTO {
  id: string;
  title: string;
  topic: string;
  createdAt: string;
  /** True when the requesting browser created this lesson (only owners may ask follow-ups). */
  isOwner: boolean;
  messages: MessageDTO[];
}

export interface LessonSummaryDTO {
  id: string;
  title: string;
  topic: string;
  createdAt: string;
}

export interface ApiErrorBody {
  error: { code: string; message: string; retryAfterSec?: number };
}
