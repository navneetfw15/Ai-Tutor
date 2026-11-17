import type {
  ApiErrorBody,
  ClipDTO,
  LessonDTO,
  LessonSummaryDTO,
  MessageDTO,
  VoiceMode,
} from "@/lib/lesson/dto";

export class ClientApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly retryAfterSec?: number,
  ) {
    super(message);
    this.name = "ClientApiError";
  }
  /** Worth retrying automatically (network blips, overloaded upstream). */
  get transient(): boolean {
    return this.code === "network" || this.status === 502 || this.status === 503 || this.status === 504;
  }
}

async function request<T>(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<T> {
  const { timeoutMs = 30_000, signal, ...rest } = init;
  const timeout = AbortSignal.timeout(timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: { "content-type": "application/json", ...rest.headers },
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === "TimeoutError";
    throw new ClientApiError(
      timedOut ? "That took too long. Please try again." : "Can't reach the server. Check your connection and try again.",
      "network",
      0,
    );
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* empty or non-JSON body */
  }
  if (!res.ok) {
    const err = (body as ApiErrorBody | null)?.error;
    throw new ClientApiError(err?.message ?? "Something went wrong. Please try again.", err?.code ?? "error", res.status, err?.retryAfterSec);
  }
  return body as T;
}

export const api = {
  createLesson: (topic: string, signal?: AbortSignal) =>
    request<{ lessonId?: string; refusal?: string }>("/api/lessons", {
      method: "POST",
      body: JSON.stringify({ topic }),
      timeoutMs: 100_000,
      signal,
    }),

  getLesson: (id: string) => request<{ lesson: LessonDTO }>(`/api/lessons/${encodeURIComponent(id)}`),

  listLessons: () => request<{ lessons: LessonSummaryDTO[] }>("/api/lessons"),

  deleteLesson: (id: string) => request<{ deleted: boolean }>(`/api/lessons/${encodeURIComponent(id)}`, { method: "DELETE" }),

  ask: (id: string, body: { text: string; sceneIndex?: number; spokenSoFar?: string }) =>
    request<{ user: MessageDTO; assistant: MessageDTO }>(`/api/lessons/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
      timeoutMs: 100_000,
    }),

  audio: (messageId: string, scene: number) =>
    request<{ voiceMode: VoiceMode; clip?: ClipDTO; reason?: string }>(`/api/messages/${encodeURIComponent(messageId)}/audio`, {
      method: "POST",
      body: JSON.stringify({ scene }),
      timeoutMs: 70_000,
    }),
};
