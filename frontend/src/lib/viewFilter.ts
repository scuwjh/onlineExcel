/**
 * 筛选与排序（REQ-101）。
 *
 * 语义边界（刻意如此，避免把"视图"变成"数据变更"）：
 * - **筛选**：纯本地视图，只隐藏行，不改动任何数据，也不广播；
 *   支持两类条件，二者叠加（都是「并且」）：
 *   1. 条件表达式（包含/等于/大于…，见 `ColumnFilter`）；
 *   2. 按值多选（勾选该列要保留的值，见 `ValueFilter`，对应"筛选清单"交互）。
 * - **排序**：同样是**展示层重排**，支持多级排序（先按第一列，相同再按第二列…），
 *   不写入存储顺序，因此不需要协同冲突处理；清除排序即可恢复原始行序。
 *
 * 取值时会像网格一样对公式求值，因此可以按计算结果筛选/排序。
 */
import { cellKey } from "./gridUtils";
import { evaluate } from "./formula";
import type { Cells, ColumnFilter, FilterOp, SortRule, ValueFilter } from "../types";
import { FILTERS_WITHOUT_VALUE } from "../types";

function valueOf(cells: Cells, row: number, col: number): string {
  return evaluate(cells[cellKey(row, col)] ?? null, cells);
}

function asNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isNaN(n) ? null : n;
}

/**
 * 比较两个单元格文本。
 *
 * 规则（与用户直觉一致）：
 * 1. **空值永远排在最后**（无论升序还是降序）——否则"金额降序"会把空行排到最前面；
 * 2. 两侧都是数字时按数值比较；
 * 3. 数字优先于纯文本；
 * 4. 其余按中文本地化字符串比较（稳定）。
 */
function compareText(a: string, b: string): number {
  const emptyA = a.trim() === "";
  const emptyB = b.trim() === "";
  if (emptyA || emptyB) {
    if (emptyA && emptyB) return 0;
    return emptyA ? 1 : -1;
  }
  const na = asNumber(a);
  const nb = asNumber(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1;
  if (nb !== null) return 1;
  return a.localeCompare(b, "zh-Hans-CN");
}

/** 空值不参与方向反转：升序/降序都把空行放在末尾。 */
function compareForSort(a: string, b: string, dir: number): number {
  const emptyA = a.trim() === "";
  const emptyB = b.trim() === "";
  if (emptyA !== emptyB) return emptyA ? 1 : -1;
  if (emptyA && emptyB) return 0;
  return compareText(a, b) * dir;
}

function matches(text: string, filter: ColumnFilter): boolean {
  const op: FilterOp = filter.op;
  const target = (filter.value ?? "").trim();
  if (!FILTERS_WITHOUT_VALUE.includes(op)) {
    switch (op) {
      case "contains":
        return text.toLowerCase().includes(target.toLowerCase());
      case "notContains":
        return !text.toLowerCase().includes(target.toLowerCase());
      case "equals":
        return text === target;
      case "notEquals":
        return text !== target;
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const left = asNumber(text);
        const right = asNumber(target);
        if (left === null || right === null) return false;
        if (op === "gt") return left > right;
        if (op === "gte") return left >= right;
        if (op === "lt") return left < right;
        return left <= right;
      }
      default:
        return true;
    }
  }
  if (op === "empty") return text.trim() === "";
  return text.trim() !== "";
}

/** 按值多选：`values` 里放的是原始文本（空单元格记为空串）。 */
function matchesValues(text: string, filter: ValueFilter): boolean {
  return filter.values.includes(text);
}

/** 某列的全部去重值（按出现顺序，供"筛选清单"展示）。 */
export function distinctValues(cells: Cells, rows: number, col: number, limit = 1000): string[] {
  const seen = new Set<string>();
  for (let r = 0; r < rows; r++) {
    seen.add(valueOf(cells, r, col));
    if (seen.size > limit) break;
  }
  return [...seen];
}

/** 某列每个值出现的行数（清单里显示计数）。 */
export function valueCounts(cells: Cells, rows: number, col: number): Map<string, number> {
  const counts = new Map<string, number>();
  for (let r = 0; r < rows; r++) {
    const text = valueOf(cells, r, col);
    counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  return counts;
}

/**
 * 计算「可见行」的展示顺序：先筛选（条件 + 按值），再按排序规则多级重排。
 */
export function computeRowOrder(
  rows: number,
  cells: Cells,
  filters: ColumnFilter[],
  valueFilters: ValueFilter[],
  sorts: SortRule[],
): number[] {
  let order: number[] = [];
  for (let r = 0; r < rows; r++) order.push(r);

  if (filters.length) {
    order = order.filter((r) => filters.every((f) => matches(valueOf(cells, r, f.col), f)));
  }
  if (valueFilters.length) {
    order = order.filter((r) => valueFilters.every((f) => matchesValues(valueOf(cells, r, f.col), f)));
  }

  if (sorts.length) {
    order = [...order].sort((a, b) => {
      for (const rule of sorts) {
        const dir = rule.dir === "asc" ? 1 : -1;
        const diff = compareForSort(valueOf(cells, a, rule.col), valueOf(cells, b, rule.col), dir);
        if (diff !== 0) return diff;
      }
      return a - b; // 全部相同：按原行号稳定排序
    });
  }
  return order;
}

/** 该行是否因为筛选被隐藏（用于状态栏提示）。 */
export function hiddenRowCount(total: number, shown: number): number {
  return Math.max(0, total - shown);
}

export function describeFilters(filters: ColumnFilter[]): string {
  return filters.length ? `筛选 ${filters.length} 列` : "";
}
