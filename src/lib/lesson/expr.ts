/**
 * A tiny, safe math-expression compiler used for `graph` actions. It never uses eval/Function:
 * the input is tokenised and parsed by a recursive-descent parser into a closure tree.
 *
 * Supported: numbers, `x`, `pi`, `e`, + - * / ^, unary minus, parentheses, implicit
 * multiplication ("2x", "3(x+1)") and the functions in FUNCS.
 */

export type Fn = (x: number) => number;

const FUNCS: Record<string, (n: number) => number> = {
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log10,
  floor: Math.floor,
  ceil: Math.ceil,
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

type Token =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: "+" | "-" | "*" | "/" | "^" | "(" | ")" };

function normalise(src: string): string {
  return src
    .toLowerCase()
    .replace(/−|–/g, "-")
    .replace(/×|·|⋅/g, "*")
    .replace(/÷/g, "/")
    .replace(/\*\*/g, "^")
    .replace(/²/g, "^2")
    .replace(/³/g, "^3")
    .replace(/π/g, "pi")
    .replace(/√/g, "sqrt")
    .replace(/^\s*(y|f\(x\))\s*=\s*/, "");
}

function tokenise(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
    } else if (/[0-9.]/.test(ch)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
      if (!m) return null;
      tokens.push({ t: "num", v: parseFloat(m[0]) });
      i += m[0].length;
    } else if (/[a-z]/.test(ch)) {
      const m = /^[a-z]+/.exec(src.slice(i))!;
      tokens.push({ t: "id", v: m[0] });
      i += m[0].length;
    } else if ("+-*/^()".includes(ch)) {
      tokens.push({ t: "op", v: ch as "+" });
      i++;
    } else {
      return null;
    }
  }
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Fn | null {
    try {
      const fn = this.expr();
      return this.pos === this.tokens.length ? fn : null;
    } catch {
      return null;
    }
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private isOp(v: string): boolean {
    const t = this.peek();
    return !!t && t.t === "op" && t.v === v;
  }

  private expr(): Fn {
    let left = this.term();
    while (this.isOp("+") || this.isOp("-")) {
      const plus = this.isOp("+");
      this.pos++;
      const right = this.term();
      const l = left;
      left = plus ? (x) => l(x) + right(x) : (x) => l(x) - right(x);
    }
    return left;
  }

  private startsPrimary(): boolean {
    const t = this.peek();
    return !!t && (t.t === "num" || t.t === "id" || (t.t === "op" && t.v === "("));
  }

  private term(): Fn {
    let left = this.unary();
    for (;;) {
      if (this.isOp("*") || this.isOp("/")) {
        const mul = this.isOp("*");
        this.pos++;
        const right = this.unary();
        const l = left;
        left = mul ? (x) => l(x) * right(x) : (x) => l(x) / right(x);
      } else if (this.startsPrimary()) {
        // implicit multiplication: 2x, 3(x+1), x sin(x)
        const right = this.unary();
        const l = left;
        left = (x) => l(x) * right(x);
      } else {
        return left;
      }
    }
  }

  private unary(): Fn {
    if (this.isOp("-")) {
      this.pos++;
      const inner = this.unary();
      return (x) => -inner(x);
    }
    if (this.isOp("+")) {
      this.pos++;
      return this.unary();
    }
    return this.power();
  }

  private power(): Fn {
    const base = this.primary();
    if (this.isOp("^")) {
      this.pos++;
      const exp = this.unary(); // right-associative, allows 2^-x
      return (x) => Math.pow(base(x), exp(x));
    }
    return base;
  }

  private primary(): Fn {
    const t = this.peek();
    if (!t) throw new Error("unexpected end");
    this.pos++;
    if (t.t === "num") {
      const v = t.v;
      return () => v;
    }
    if (t.t === "op" && t.v === "(") {
      const inner = this.expr();
      if (!this.isOp(")")) throw new Error("expected )");
      this.pos++;
      return inner;
    }
    if (t.t === "id") {
      if (t.v === "x") return (x) => x;
      // Own-property checks only: `"constructor" in {}` is true through the prototype chain.
      if (Object.hasOwn(CONSTS, t.v)) {
        const v = CONSTS[t.v];
        return () => v;
      }
      if (Object.hasOwn(FUNCS, t.v)) {
        if (!this.isOp("(")) throw new Error("function needs (");
        this.pos++;
        const arg = this.expr();
        if (!this.isOp(")")) throw new Error("expected )");
        this.pos++;
        const f = FUNCS[t.v];
        return (x) => f(arg(x));
      }
    }
    throw new Error("unexpected token");
  }
}

/** Compile an expression in `x`; returns null when it is not valid/safe. */
export function compileExpression(src: string): Fn | null {
  if (typeof src !== "string" || src.length === 0 || src.length > 160) return null;
  const tokens = tokenise(normalise(src));
  if (!tokens || tokens.length === 0 || tokens.length > 120) return null;
  return new Parser(tokens).parse();
}

/**
 * Sample `fn` across [xmin, xmax] and return polyline segments in data space, clipped exactly to
 * the plot window [ymin, ymax]. A segment ends at the boundary where the curve leaves the window
 * and a new one starts where it re-enters; non-finite values and huge jumps (asymptotes such as
 * tan(x) or 1/x) also break the line instead of drawing a vertical stroke.
 */
export function samplePlot(
  fn: Fn,
  xmin: number,
  xmax: number,
  ymin: number,
  ymax: number,
  samples = 240,
): [number, number][][] {
  const segments: [number, number][][] = [];
  let current: [number, number][] = [];
  const flush = () => {
    if (current.length > 1) segments.push(current);
    current = [];
  };
  const inside = (y: number) => y >= ymin && y <= ymax;
  const maxJump = (ymax - ymin) * 0.7;
  /** Point where the segment prev -> (x, y) crosses the nearest boundary of the window. */
  const crossing = (prev: [number, number], x: number, y: number): [number, number] => {
    const boundary = prev[1] > ymax || y > ymax ? ymax : ymin;
    const t = (boundary - prev[1]) / (y - prev[1]);
    return [prev[0] + t * (x - prev[0]), boundary];
  };

  let prev: [number, number] | null = null;
  for (let i = 0; i <= samples; i++) {
    const x = xmin + ((xmax - xmin) * i) / samples;
    const y = fn(x);
    if (!Number.isFinite(y)) {
      flush();
      prev = null;
      continue;
    }
    const nowIn = inside(y);
    const prevIn = prev !== null && inside(prev[1]);
    if (prev && Math.abs(y - prev[1]) > maxJump && nowIn && prevIn) flush(); // asymptote between samples
    if (nowIn) {
      if (prev && !prevIn) current.push(crossing(prev, x, y)); // re-entering the window
      current.push([x, y]);
    } else if (prev && prevIn) {
      current.push(crossing(prev, x, y)); // leaving the window
      flush();
    }
    prev = [x, y];
  }
  flush();
  return segments;
}
