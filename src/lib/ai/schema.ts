import { ACTION_TYPES, COLOR_TOKENS, HIGHLIGHT_STYLES, SIZE_TOKENS } from "@/lib/lesson/types";

/**
 * JSON Schema handed to Gemini (`responseJsonSchema`) so the model returns well-formed JSON.
 * It is intentionally flat and permissive: the model fills only the fields each action type needs
 * and `sanitizeScript` enforces the real rules afterwards.
 */

const number = { type: "number" } as const;
const string = { type: "string" } as const;

const action = {
  type: "object",
  properties: {
    type: { type: "string", enum: [...ACTION_TYPES] },
    id: string,
    cue: string,
    text: string,
    x: number,
    y: number,
    w: number,
    h: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    from: string,
    to: string,
    bend: number,
    points: { type: "array", items: number },
    color: { type: "string", enum: [...COLOR_TOKENS] },
    fill: { type: "string", enum: [...COLOR_TOKENS] },
    size: { type: "string", enum: [...SIZE_TOKENS] },
    align: { type: "string", enum: ["left", "center", "right"] },
    dashed: { type: "boolean" },
    head: { type: "string", enum: ["end", "both", "none"] },
    fn: string,
    xmin: number,
    xmax: number,
    ymin: number,
    ymax: number,
    xLabel: string,
    yLabel: string,
    labels: { type: "array", items: string },
    target: string,
    style: { type: "string", enum: [...HIGHLIGHT_STYLES] },
    targets: { type: "array", items: string },
  },
  required: ["type", "id", "cue"],
} as const;

export const lessonResponseSchema = {
  type: "object",
  properties: {
    refusal: string,
    title: string,
    summary: string,
    scenes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: string,
          clear: { type: "boolean" },
          beats: {
            type: "array",
            items: {
              type: "object",
              properties: {
                say: string,
                draw: { type: "array", items: action },
              },
              required: ["say", "draw"],
            },
          },
        },
        required: ["title", "beats"],
      },
    },
    suggestions: { type: "array", items: string },
  },
  required: ["title", "summary", "scenes", "suggestions"],
} as const;
