import { colLabel, parseCellRef, parseRange } from "./gridUtils";

type CellStore = Record<string, string | null>;

export function isFormula(value: string | null | undefined): boolean {
  return !!value && value.startsWith("=");
}

export function evaluate(value: string | null | undefined, cells: CellStore): string {
  if (value == null) return "";
  if (!value.startsWith("=")) return value;
  try {
    return formatResult(evalExpr(value.slice(1), cells, new Set()));
  } catch {
    return "#ERROR";
  }
}

function formatResult(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1000) / 1000);
  }
  return String(v);
}

function cellValue(ref: string, cells: CellStore, visiting: Set<string>): number | null {
  const key = ref.toUpperCase();
  if (visiting.has(key)) throw new Error("循环引用");
  const { row, col } = parseCellRef(key);
  const raw = cells[`${row}:${col}`];
  if (raw == null || raw === "") return null;
  if (raw.startsWith("=")) {
    visiting.add(key);
    const v = evalExpr(raw.slice(1), cells, visiting);
    visiting.delete(key);
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  }
  const n = Number(raw);
  return Number.isNaN(n) ? null : n;
}

function rangeValues(ref: string, cells: CellStore, visiting: Set<string>): number[] {
  if (ref.includes(":")) {
    const { start, end } = parseRange(ref);
    const out: number[] = [];
    for (let r = start.row; r <= end.row; r++) {
      for (let c = start.col; c <= end.col; c++) {
        const v = cellValue(`${colLabel(c)}${r + 1}`, cells, visiting);
        if (v != null) out.push(v);
      }
    }
    return out;
  }
  const v = cellValue(ref, cells, visiting);
  return v == null ? [] : [v];
}

function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

function evalCond(cond: string, cells: CellStore, visiting: Set<string>): boolean {
  const m = cond.match(/^([A-Z]+[0-9]+)\s*(>=|<=|<>|>|<|=)\s*(.+)$/i);
  if (m) {
    const left = cellValue(m[1], cells, visiting) ?? 0;
    const right = Number(m[3]);
    if (Number.isNaN(right)) return Boolean(evalExpr(cond, cells, visiting));
    switch (m[2]) {
      case ">=": return left >= right;
      case "<=": return left <= right;
      case "<>": return left !== right;
      case ">": return left > right;
      case "<": return left < right;
      case "=": return left === right;
    }
  }
  return Boolean(evalExpr(cond, cells, visiting));
}

function evalExpr(expr: string, cells: CellStore, visiting: Set<string>): unknown {
  const t = expr.trim();
  const upper = t.toUpperCase();

  if (upper.startsWith("SUM(") && t.endsWith(")")) {
    const args = splitTopLevel(t.slice(4, -1));
    const values = args.flatMap((a) => rangeValues(a.trim(), cells, visiting));
    return values.reduce((s, v) => s + v, 0);
  }
  if (upper.startsWith("AVERAGE(") && t.endsWith(")")) {
    const args = splitTopLevel(t.slice(8, -1));
    const values = args.flatMap((a) => rangeValues(a.trim(), cells, visiting));
    return values.length ? values.reduce((s, v) => s + v, 0) / values.length : 0;
  }
  if (upper.startsWith("IF(") && t.endsWith(")")) {
    const args = splitTopLevel(t.slice(3, -1));
    if (args.length < 2) throw new Error("IF 参数不足");
    const cond = evalCond(args[0].trim(), cells, visiting);
    return cond
      ? evalExpr(args[1].trim(), cells, visiting)
      : args[2]
        ? evalExpr(args[2].trim(), cells, visiting)
        : false;
  }

  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }

  const n = Number(t);
  if (!Number.isNaN(n)) return n;

  if (/^[A-Z]+[0-9]+$/.test(upper)) {
    return cellValue(t, cells, visiting);
  }

  throw new Error(`无法解析: ${t}`);
}
