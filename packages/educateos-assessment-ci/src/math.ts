// A safe arithmetic reader for math answer checks. It is a small recursive-descent parser over a
// fixed grammar, never `eval` or `Function`, so an answer can only ever be a number:
//
//   expression := term (("+" | "-") term)*
//   term       := power (("*" | "/" | "×" | "÷") power)*
//   power      := unary ("^" power)?          right-associative
//   unary      := ("+" | "-") unary | primary
//   primary    := number | "(" expression ")"
//   number     := digits ["." digits] | "." digits
//
// Anything else (a name, a call, a string, a second operator) is a syntax error.
import type { EvaluationKit } from "./sdk.ts";

/** Thrown for text outside the arithmetic subset, or arithmetic with no finite value. */
export class ArithmeticError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArithmeticError";
  }
}

/** The longest expression read. */
export const MAX_EXPRESSION_LENGTH = 200;
/** The deepest nesting of parentheses and unary signs read. */
const MAX_DEPTH = 32;

type Token = { kind: "number"; value: number; at: number } | { kind: "op"; value: string; at: number };

const OPERATORS = new Set(["+", "-", "*", "/", "×", "÷", "^", "(", ")"]);

function isOp(token: Token | undefined, ...ops: string[]): boolean {
  return token?.kind === "op" && ops.includes(token.value);
}

function tokenize(source: string, kit: EvaluationKit): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    kit.step();
    const char = source[i]!;
    if (char === " " || char === "\t") {
      i += 1;
    } else if (OPERATORS.has(char)) {
      tokens.push({ kind: "op", value: char, at: i });
      i += 1;
    } else if ((char >= "0" && char <= "9") || char === ".") {
      const match = /^(?:\d+(?:\.\d+)?|\.\d+)/.exec(source.slice(i));
      if (match === null) throw new ArithmeticError(`Unexpected "${char}" at position ${i + 1}.`);
      tokens.push({ kind: "number", value: Number(match[0]), at: i });
      i += match[0].length;
    } else {
      throw new ArithmeticError(`Unexpected "${char}" at position ${i + 1}: only numbers, + - * / ^ and parentheses are allowed.`);
    }
  }
  return tokens;
}

/** Reads `source` as arithmetic in the safe subset and returns its value, spending a step per token. */
export function evaluateArithmetic(source: string, kit: EvaluationKit): number {
  if (source.length > MAX_EXPRESSION_LENGTH) throw new ArithmeticError(`An expression is at most ${MAX_EXPRESSION_LENGTH} characters.`);
  const tokens = tokenize(source, kit);
  let position = 0;
  let depth = 0;

  const peek = (): Token | undefined => tokens[position];
  const unexpected = (token: Token | undefined): ArithmeticError =>
    token === undefined
      ? new ArithmeticError("The expression ends too early.")
      : new ArithmeticError(`Unexpected "${token.kind === "op" ? token.value : String(token.value)}" at position ${token.at + 1}.`);
  const nested = <T>(read: () => T): T => {
    depth += 1;
    if (depth > MAX_DEPTH) throw new ArithmeticError("The expression is nested too deeply.");
    try {
      return read();
    } finally {
      depth -= 1;
    }
  };

  const expression = (): number => {
    let value = term();
    while (isOp(peek(), "+", "-")) {
      const op = tokens[position++]!.value;
      const right = term();
      value = op === "+" ? value + right : value - right;
    }
    return value;
  };
  const term = (): number => {
    let value = power();
    while (isOp(peek(), "*", "/", "×", "÷")) {
      const op = tokens[position++]!.value;
      const right = power();
      if ((op === "/" || op === "÷") && right === 0) throw new ArithmeticError("Division by zero.");
      value = op === "*" || op === "×" ? value * right : value / right;
    }
    return value;
  };
  const power = (): number => {
    const base = unary();
    if (!isOp(peek(), "^")) return base;
    position += 1;
    return nested(() => base ** power());
  };
  const unary = (): number => {
    if (isOp(peek(), "+", "-")) {
      const sign = tokens[position++]!.value;
      return nested(() => (sign === "-" ? -unary() : unary()));
    }
    return primary();
  };
  const primary = (): number => {
    const token = peek();
    if (token?.kind === "number") {
      position += 1;
      return token.value;
    }
    if (isOp(token, "(")) {
      position += 1;
      const value = nested(expression);
      if (!isOp(peek(), ")")) throw unexpected(peek());
      position += 1;
      return value;
    }
    throw unexpected(token);
  };

  const value = expression();
  if (position < tokens.length) throw unexpected(tokens[position]);
  if (!Number.isFinite(value)) throw new ArithmeticError("The expression has no finite value.");
  return value;
}

/** A kit with a fixed budget, for reading a short expression outside a run, such as an answer key in a config. */
export function standaloneKit(maxSteps = 10_000): EvaluationKit {
  let used = 0;
  return {
    step(units = 1) {
      used += units;
      if (used > maxSteps) throw new ArithmeticError("The expression is too long to read.");
    },
  };
}
