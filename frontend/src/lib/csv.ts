import type { Cells } from "../types";
import { cellKey } from "./gridUtils";

function escapeCsv(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

export function cellsToCsv(cells: Cells, rows: number, cols: number): string {
  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) {
      line.push(escapeCsv(cells[cellKey(r, c)] ?? ""));
    }
    lines.push(line.join(","));
  }
  return lines.join("\n");
}

export function csvToCells(text: string): { rows: number; cols: number; cells: Cells } {
  const parsed: string[][] = [];
  let row: string[] = [];
  let cur = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(cur);
      cur = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(cur);
      parsed.push(row);
      row = [];
      cur = "";
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  if (cur !== "" || row.length > 0) {
    row.push(cur);
    parsed.push(row);
  }

  while (parsed.length && parsed[parsed.length - 1].length === 1 && parsed[parsed.length - 1][0] === "") {
    parsed.pop();
  }

  const nrows = parsed.length;
  const ncols = parsed.reduce((m, r) => Math.max(m, r.length), 0);
  const cells: Cells = {};
  for (let r = 0; r < nrows; r++) {
    for (let c = 0; c < parsed[r].length; c++) {
      const v = parsed[r][c];
      if (v !== "") cells[cellKey(r, c)] = v;
    }
  }
  return { rows: Math.max(1, nrows), cols: Math.max(1, ncols), cells };
}

/**
 * 解析剪贴板内容为二维数组。
 * 优先按 Excel 的制表符分隔处理；若整段只有单列，则退回按行切分。
 */
export function parseClipboardGrid(text: string): string[][] {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n+$/, "");
  if (!normalized) return [];
  const hasTab = normalized.includes("\t");
  return normalized.split("\n").map((line) => (hasTab ? line.split("\t") : [line]));
}
