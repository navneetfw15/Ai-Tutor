import type { ColorToken } from "@/lib/lesson/types";

/** Marker colours (always the same, even in dark mode: the board is a physical white board). */
export const INK: Record<ColorToken, string> = {
  ink: "#1f2430",
  blue: "#2563eb",
  red: "#dc2626",
  green: "#15a34a",
  orange: "#ea7a0c",
  purple: "#7c3aed",
  teal: "#0d9488",
  pink: "#db2777",
  gray: "#6b7280",
  yellow: "#e8b400",
};

/** Pastel fills that stay readable under dark ink. */
export const SOFT: Record<ColorToken, string> = {
  ink: "#e3e5ea",
  blue: "#dbe7fd",
  red: "#fbdcdc",
  green: "#d5f0dd",
  orange: "#fde4c8",
  purple: "#e6dcfb",
  teal: "#cdeeea",
  pink: "#fad5e7",
  gray: "#e7e8ec",
  yellow: "#fdf0b0",
};

export const BOARD_BG = "#fffdf8";
