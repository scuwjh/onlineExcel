import { DEFAULT_COLS, DEFAULT_ROWS } from "../types";

export function colLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export function cellKey(row: number, col: number): string {
  return `${row}:${col}`;
}

export function refOf(row: number, col: number): string {
  return `${colLabel(col)}${row + 1}`;
}

export function parseCellRef(ref: string): { row: number; col: number } {
  const m = ref.toUpperCase().match(/^([A-Z]+)([0-9]+)$/);
  if (!m) throw new Error(`非法单元格引用: ${ref}`);
  const colLetters = m[1];
  let col = 0;
  for (const ch of colLetters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }
  return { row: parseInt(m[2], 10) - 1, col: col - 1 };
}

export function parseRange(ref: string): {
  start: { row: number; col: number };
  end: { row: number; col: number };
} {
  const [a, b] = ref.split(":");
  const start = parseCellRef(a);
  const end = b ? parseCellRef(b) : start;
  return {
    start: { row: Math.min(start.row, end.row), col: Math.min(start.col, end.col) },
    end: { row: Math.max(start.row, end.row), col: Math.max(start.col, end.col) },
  };
}

export function transformGrid<T>(
  map: Record<string, T>,
  fn: (row: number, col: number) => { row: number; col: number } | null,
): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [key, val] of Object.entries(map)) {
    const [r, c] = key.split(":").map(Number);
    const res = fn(r, c);
    if (res) out[cellKey(res.row, res.col)] = val;
  }
  return out;
}

export function inBounds(row: number, col: number, rows = DEFAULT_ROWS, cols = DEFAULT_COLS): boolean {
  return row >= 0 && row < rows && col >= 0 && col < cols;
}
