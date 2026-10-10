/**
 * 单元格公式求值（前端实时）。
 *
 * 支持：
 * - 四则运算 `+ - * /`、一元负号、括号；
 * - 单元格引用 `A1`、区域 `A1:B2`（仅用于 SUM/AVERAGE 参数）；
 * - 函数 `SUM`、`AVERAGE`、`IF`（可嵌套任意表达式）；
 * - 比较运算 `= <> > >= < <=`（用于 IF 条件）；
 * - 字符串字面量 `"文本"` / `'文本'`；
 * - 循环引用检测。
 *
 * 求值失败一律返回 `#ERROR`（与 Excel 的 #VALUE!/#NAME? 等观感一致）。
 */
import { colLabel, parseCellRef, parseRange } from "./gridUtils";

type CellStore = Record<string, string | null>;
type V = number | string | boolean | null;

export function isFormula(value: string | null | undefined): boolean {
  return !!value && value.startsWith("=");
}

export function evaluate(value: string | null | undefined, cells: CellStore): string {
  if (value == null) return "";
  if (!value.startsWith("=")) return value;
  try {
    return formatResult(new Parser(value.slice(1), cells, new Set()).parseExpr());
  } catch {
    return "#ERROR";
  }
}

function formatResult(v: V): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  return v;
}

function toNumber(v: V): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return null;
  const n = Number(v.trim());
  return Number.isNaN(n) ? null : n;
}

function scalarToString(v: V): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return String(v);
}

/** 四则运算：操作数必须是数字（文本/空值参与算术会报错，像 Excel 的 #VALUE!）。 */
function arith(a: V, b: V, op: string): number {
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na === null || nb === null) throw new Error(`算术运算需要数字: ${scalarToString(a)} ${op} ${scalarToString(b)}`);
  switch (op) {
    case "+":
      return na + nb;
    case "-":
      return na - nb;
    case "*":
      return na * nb;
    case "/":
      return nb === 0 ? (na === 0 ? 0 : Infinity) : na / nb;
  }
  throw new Error(`未知运算符: ${op}`);
}

function compareValues(a: V, b: V, op: string): boolean {
  const na = toNumber(a);
  const nb = toNumber(b);
  // 两端都能转数字 → 数值比较（空单元格当 0，符合表格习惯）
  if (na !== null && nb !== null) {
    switch (op) {
      case "=":
        return na === nb;
      case "<>":
        return na !== nb;
      case ">":
        return na > nb;
      case ">=":
        return na >= nb;
      case "<":
        return na < nb;
      case "<=":
        return na <= nb;
    }
  }
  const sa = scalarToString(a);
  const sb = scalarToString(b);
  switch (op) {
    case "=":
      return sa === sb;
    case "<>":
      return sa !== sb;
    case ">":
      return sa > sb;
    case ">=":
      return sa >= sb;
    case "<":
      return sa < sb;
    case "<=":
      return sa <= sb;
  }
  return false;
}

function truthy(v: V): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  return v !== "";
}

type Token =
  | { type: "num"; value: number }
  | { type: "str"; value: string }
  | { type: "ref"; value: string }
  | { type: "range"; a: string; b: string }
  | { type: "ident"; value: string }
  | { type: "op"; value: string };

class Parser {
  private i = 0;
  private readonly tokens: Token[];

  constructor(
    private readonly src: string,
    private readonly cells: CellStore,
    private readonly visiting: Set<string>,
  ) {
    this.tokens = tokenize(src);
  }

  /** expression := comparison */
  parseExpr(): V {
    const v = this.comparison();
    if (this.i < this.tokens.length) throw new Error(`多余的输入: ${this.src}`);
    return v;
  }

  private peekOp(ops: string[]): string | null {
    const t = this.tokens[this.i];
    if (t && t.type === "op" && ops.includes(t.value)) return t.value;
    return null;
  }

  private next(): Token {
    const t = this.tokens[this.i];
    if (!t) throw new Error(`表达式意外结束: ${this.src}`);
    this.i++;
    return t;
  }

  /** 消费下一个运算符 token（供 + - * / 等确定只有 value 的操作数使用）。 */
  private nextOp(expected: string[]): string {
    const t = this.tokens[this.i];
    if (!t || t.type !== "op" || !expected.includes(t.value)) {
      throw new Error(`缺少运算符: ${this.src}`);
    }
    this.i++;
    return t.value;
  }

  private expectOp(op: string): void {
    const t = this.tokens[this.i];
    if (!t || t.type !== "op" || t.value !== op) throw new Error(`缺少 ${op}: ${this.src}`);
    this.i++;
  }

  /** comparison := additive [ (=|<>|>|>=|<|<=) additive ] */
  private comparison(): V {
    const left = this.additive();
    const op = this.peekOp(["=", "<>", ">", ">=", "<", "<="]);
    if (!op) return left;
    this.next();
    const right = this.additive();
    return compareValues(left, right, op);
  }

  private additive(): V {
    let left = this.multiplicative();
    while (this.peekOp(["+", "-"])) {
      const op = this.nextOp(["+", "-"]);
      const right = this.multiplicative();
      left = arith(left, right, op);
    }
    return left;
  }

  private multiplicative(): V {
    let left = this.unary();
    while (this.peekOp(["*", "/"])) {
      const op = this.nextOp(["*", "/"]);
      const right = this.unary();
      left = arith(left, right, op);
    }
    return left;
  }

  private unary(): V {
    const op = this.peekOp(["+", "-"]);
    if (op) {
      this.next();
      const v = this.unary();
      if (op === "-") {
        const n = toNumber(v);
        if (n === null) throw new Error(`负号需要数字: ${scalarToString(v)}`);
        return -n;
      }
      return v;
    }
    return this.primary();
  }

  private primary(): V {
    const t = this.next();
    switch (t.type) {
      case "num":
      case "str":
        return t.value;
      case "ref":
        return this.cellValue(t.value);
      case "range":
        throw new Error(`区域只能用于 SUM/AVERAGE 参数: ${t.a}:${t.b}`);
      case "ident":
        return this.funcCall(t.value);
      case "op":
        if (t.value === "(") {
          const inner = this.comparison();
          this.expectOp(")");
          return inner;
        }
        throw new Error(`意外的符号: ${t.value}`);
    }
  }

  private funcCall(name: string): V {
    const upper = name.toUpperCase();
    this.expectOp("(");
    if (upper === "SUM" || upper === "AVERAGE") {
      const values: number[] = [];
      if (!this.peekOp([")"])) {
        do {
          values.push(...this.aggregateArg());
        } while (this.peekOp([","]) && this.next());
      }
      this.expectOp(")");
      const sum = values.reduce((s, n) => s + n, 0);
      return upper === "SUM" ? sum : values.length ? sum / values.length : 0;
    }
    if (upper === "IF") {
      const cond = this.comparison();
      this.expectOp(",");
      const yes = this.comparison();
      let no: V = false;
      if (this.peekOp([","])) {
        this.next();
        no = this.comparison();
      }
      this.expectOp(")");
      return truthy(cond) ? yes : no;
    }
    throw new Error(`未知函数: ${name}`);
  }

  /** SUM/AVERAGE 参数：区域返回其数值序列；普通表达式返回单值（文本/空值忽略）。 */
  private aggregateArg(): number[] {
    const t = this.tokens[this.i];
    if (t && t.type === "range") {
      this.next();
      const out: number[] = [];
      const { start, end } = parseRange(`${t.a}:${t.b}`);
      for (let r = start.row; r <= end.row; r++) {
        for (let c = start.col; c <= end.col; c++) {
          const n = toNumber(this.cellValue(`${colLabel(c)}${r + 1}`));
          if (n !== null) out.push(n);
        }
      }
      return out;
    }
    const v = this.comparison();
    const n = toNumber(v);
    return n !== null ? [n] : [];
  }

  private cellValue(ref: string): V {
    const key = ref.toUpperCase();
    if (this.visiting.has(key)) throw new Error(`循环引用: ${key}`);
    const { row, col } = parseCellRef(key);
    const raw = this.cells[`${row}:${col}`];
    if (raw == null || raw === "") return null;
    if (raw.startsWith("=")) {
      this.visiting.add(key);
      try {
        return new Parser(raw.slice(1), this.cells, this.visiting).parseExpr();
      } finally {
        this.visiting.delete(key);
      }
    }
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const isIdentChar = (ch: string) => /[A-Za-z_.]/.test(ch);

  while (i < n) {
    const ch = src[i];
    if (ch === " " || ch === "\t") {
      i++;
      continue;
    }
    // 字符串字面量
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let out = "";
      while (j < n && src[j] !== quote) out += src[j++];
      if (j >= n) throw new Error(`字符串未闭合: ${src.slice(i)}`);
      tokens.push({ type: "str", value: out });
      i = j + 1;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < n && /[0-9.]/.test(src[j])) j++;
      const text = src.slice(i, j);
      const num = Number(text);
      if (Number.isNaN(num)) throw new Error(`非法数字: ${text}`);
      tokens.push({ type: "num", value: num });
      i = j;
      continue;
    }
    // 标识符 / 单元格引用（可能有区间 A1:B2）：字母开头，后面可跟数字（如 C2）
    if (isIdentChar(ch)) {
      let j = i;
      while (j < n && /[A-Za-z_.]/.test(src[j])) j++;
      let k = j;
      while (k < n && /[0-9]/.test(src[k])) k++;
      const word = src.slice(i, k);
      i = k;
      // 字母+数字 → 单元格引用（可能是区间）
      if (/^[A-Za-z]+[0-9]+$/.test(word)) {
        if (src[i] === ":") {
          const m = src.slice(i + 1).match(/^[A-Za-z]+[0-9]+/);
          if (m) {
            tokens.push({ type: "range", a: word.toUpperCase(), b: m[0].toUpperCase() });
            i = i + 1 + m[0].length;
            continue;
          }
        }
        tokens.push({ type: "ref", value: word.toUpperCase() });
      } else {
        tokens.push({ type: "ident", value: word.toUpperCase() });
      }
      continue;
    }
    // 运算符
    const two = src.slice(i, i + 2);
    if (two === ">=" || two === "<=" || two === "<>") {
      tokens.push({ type: "op", value: two });
      i += 2;
      continue;
    }
    if ("+-*/()=<>,".includes(ch)) {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }
    throw new Error(`无法识别的字符: ${ch}`);
  }
  return tokens;
}