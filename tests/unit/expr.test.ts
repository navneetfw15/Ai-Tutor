import { describe, expect, it } from "vitest";
import { compileExpression, samplePlot } from "@/lib/lesson/expr";

const ev = (src: string, x: number) => compileExpression(src)?.(x);

describe("compileExpression", () => {
  it("evaluates arithmetic with correct precedence", () => {
    expect(ev("1 + 2 * 3", 0)).toBe(7);
    expect(ev("(1 + 2) * 3", 0)).toBe(9);
    expect(ev("2 ^ 3 ^ 2", 0)).toBe(512); // right-associative
    expect(ev("10 / 4", 0)).toBe(2.5);
  });

  it("treats unary minus as lower precedence than ^", () => {
    expect(ev("-x^2", 3)).toBe(-9);
    expect(ev("2^-x", 2)).toBe(0.25);
  });

  it("supports x, constants and functions", () => {
    expect(ev("x^2 - 2*x + 1", 3)).toBe(4);
    expect(ev("sin(pi/2)", 0)).toBeCloseTo(1);
    expect(ev("sqrt(x)", 16)).toBe(4);
    expect(ev("ln(e)", 0)).toBeCloseTo(1);
    expect(ev("abs(x)", -7)).toBe(7);
  });

  it("supports implicit multiplication and unicode", () => {
    expect(ev("2x + 1", 4)).toBe(9);
    expect(ev("3(x+1)", 1)).toBe(6);
    expect(ev("x²", 5)).toBe(25);
    expect(ev("x**2", 5)).toBe(25);
    expect(ev("y = x^2", 3)).toBe(9);
    expect(ev("2π", 0)).toBeCloseTo(2 * Math.PI);
  });

  it("rejects invalid or unsafe input", () => {
    expect(compileExpression("x +")).toBeNull();
    expect(compileExpression("alert(1)")).toBeNull();
    expect(compileExpression("process.exit()")).toBeNull();
    expect(compileExpression("constructor")).toBeNull();
    expect(compileExpression("x; y")).toBeNull();
    expect(compileExpression("")).toBeNull();
    expect(compileExpression("1+".repeat(100) + "1")).toBeNull();
    expect(compileExpression("sin x")).toBeNull();
  });
});

describe("samplePlot", () => {
  it("splits the curve at asymptotes", () => {
    const fn = compileExpression("1/x")!;
    const segments = samplePlot(fn, -2, 2, -4, 4);
    expect(segments.length).toBeGreaterThanOrEqual(2);
    for (const seg of segments) for (const [, y] of seg) expect(Number.isFinite(y)).toBe(true);
  });

  it("clips the curve exactly at the plot window (no clamped tails)", () => {
    const segments = samplePlot(compileExpression("x^3")!, -3, 3, -2, 2);
    expect(segments).toHaveLength(1);
    for (const [, y] of segments[0]) {
      expect(y).toBeGreaterThanOrEqual(-2 - 1e-9);
      expect(y).toBeLessThanOrEqual(2 + 1e-9);
    }
    expect(segments[0][0][1]).toBeCloseTo(-2, 6); // starts on the lower boundary
    expect(segments[0].at(-1)![1]).toBeCloseTo(2, 6); // ends on the upper boundary
  });

  it("breaks the line at tan(x) asymptotes instead of drawing vertical strokes", () => {
    const segments = samplePlot(compileExpression("tan(x)")!, -4.5, 4.5, -3, 3);
    expect(segments.length).toBeGreaterThanOrEqual(3);
    for (const seg of segments) {
      for (let i = 1; i < seg.length; i++) expect(Math.abs(seg[i][1] - seg[i - 1][1])).toBeLessThan(4.2);
    }
  });

  it("returns one segment for a smooth function", () => {
    const segments = samplePlot(compileExpression("x^2")!, -3, 3, 0, 9);
    expect(segments).toHaveLength(1);
    expect(segments[0].length).toBeGreaterThan(100);
  });
});
