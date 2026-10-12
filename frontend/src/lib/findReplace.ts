/**
 * 查找与替换（REQ：查找/替换）—— 纯逻辑层。
 *
 * 不依赖 React / DOM / 第三方库，便于在 `frontend/scripts/findReplace.test.mjs` 中直接单测。
 * 约定：
 * - `query` 为空串时**不做任何匹配**（`test` 恒为 `false`，`findMatches` 返回 `[]`）；
 * - 非正则模式一律按**字面量**处理：`a+b`、`a.b`、`(x)` 都按原文匹配，绝不把用户输入拼进
 *   `RegExp`；子串替换用索引扫描实现，因此 `$1` 之类的字符只会被原样写入；
 * - 正则模式编译失败**不抛异常**，而是通过 `FindError` 返回可直接展示的中文说明；
 * - 正则替换走 `String.prototype.replace`，因此支持 `$1` 反向引用。
 */
import type { Cells } from "../types";
import { cellKey } from "./gridUtils";

export interface FindOptions {
  query: string;
  matchCase: boolean; // 区分大小写
  wholeCell: boolean; // 整格匹配
  regex: boolean; // 按正则
}

export interface FindError {
  kind: "regex";
  message: string;
}

export interface FindHit {
  row: number;
  col: number;
  value: string;
}

export interface ReplaceResult {
  updates: Record<string, string | null>;
  count: number;
  truncated: boolean;
}

/** 默认查找选项：忽略大小写、包含即命中、非正则、空查询。 */
export const DEFAULT_FIND_OPTIONS: FindOptions = {
  query: "",
  matchCase: false,
  wholeCell: false,
  regex: false,
};

/** `findMatches` / `findMatchesInOrder` 的默认命中上限。 */
const DEFAULT_FIND_LIMIT = 2000;
/** `replaceAll` 的默认替换上限。 */
const DEFAULT_REPLACE_LIMIT = 5000;

/**
 * 在 `value` 中把**字面量** `needle` 的全部出现替换为 `replacement`。
 *
 * 用索引扫描而非 `split`/`join`，这样 `matchCase: false` 也能正确忽略大小写；
 * 同时避免把用户输入拼进 `RegExp`（`a+b`、`$1` 等特殊字符不会被解释）。
 * 若极端语言环境下大小写转换改变了字符串长度（如土耳其语 `İ`），比较会失配但**不会错位**。
 */
function replaceLiteralAll(value: string, needle: string, replacement: string, matchCase: boolean): string {
  if (needle === "") return value;
  let out = "";
  let index = 0;
  while (index < value.length) {
    const end = index + needle.length;
    if (end <= value.length) {
      const candidate = value.slice(index, end);
      if ((matchCase ? candidate : candidate.toLowerCase()) === needle) {
        out += replacement;
        index = end;
        continue;
      }
    }
    out += value[index];
    index += 1;
  }
  return out;
}

/** 编译出的匹配器：除 `test` / `error` 外，还带"已命中后如何替换整格"的闭包。 */
interface CompiledMatcher {
  test(value: string | null | undefined): boolean;
  error: FindError | null;
  /** 把**已命中**的整格值替换为 `replacement`（正则模式支持 `$1`）。 */
  replace(value: string, replacement: string): string;
}

/** 一次编译出测试/替换所需的全部正则；失败时返回原始错误信息。 */
function compileRegexes(
  query: string,
  matchCase: boolean,
): { probe: RegExp; wholeProbe: RegExp; replacer: RegExp; wholeReplacer: RegExp } | string {
  const flags = matchCase ? "" : "i";
  const globalFlags = matchCase ? "g" : "gi";
  try {
    return {
      probe: new RegExp(query, flags),
      wholeProbe: new RegExp(`^(?:${query})$`, flags),
      replacer: new RegExp(query, globalFlags),
      wholeReplacer: new RegExp(`^(?:${query})$`, globalFlags),
    };
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** 内部：编译出可匹配 + 可替换的匹配器。 */
function buildMatcher(options: FindOptions): CompiledMatcher {
  const query = typeof options.query === "string" ? options.query : "";
  // 空查询不做任何匹配
  if (query === "") return { test: () => false, error: null, replace: (value) => value };

  if (options.regex) {
    const compiled = compileRegexes(query, options.matchCase);
    if (typeof compiled === "string") {
      return {
        test: () => false,
        error: { kind: "regex", message: `正则表达式无效：${compiled}` },
        replace: (value) => value,
      };
    }
    const pattern = options.wholeCell ? compiled.wholeProbe : compiled.probe;
    const replacer = options.wholeCell ? compiled.wholeReplacer : compiled.replacer;
    return {
      test: (value) => pattern.test(value ?? ""),
      error: null,
      // 整格匹配时用锚定正则替换，因此整格被 replacement 取代，且仍支持 $1
      replace: (value, replacement) => value.replace(replacer, replacement),
    };
  }

  // 非正则：一律字面量比较
  const needle = options.matchCase ? query : query.toLowerCase();
  return {
    test: (value) => {
      const text = value ?? "";
      const folded = options.matchCase ? text : text.toLowerCase();
      return options.wholeCell ? folded === needle : folded.includes(needle);
    },
    error: null,
    replace: (value, replacement) =>
      options.wholeCell ? replacement : replaceLiteralAll(value, needle, replacement, options.matchCase),
  };
}

/**
 * 编译匹配器。编译非法正则时返回 `error` 且 `test` 恒为 `false`（不抛异常）。
 */
export function compileMatcher(options: FindOptions): {
  test(value: string | null | undefined): boolean;
  error: FindError | null;
} {
  const matcher = buildMatcher(options);
  return {
    test: (value) => matcher.test(value),
    error: matcher.error,
  };
}

/** 行优先扫描的实现：`rowOrder` 为 `null` 时按 0..rows-1 顺序。 */
function collectHits(
  cells: Cells,
  rows: number,
  cols: number,
  rowOrder: number[] | null,
  options: FindOptions,
  limit: number,
): FindHit[] {
  const hits: FindHit[] = [];
  if (limit <= 0) return hits;
  const matcher = buildMatcher(options);

  const scanRow = (row: number): boolean => {
    for (let col = 0; col < cols; col++) {
      const raw = cells[cellKey(row, col)];
      if (!matcher.test(raw)) continue;
      hits.push({ row, col, value: raw ?? "" });
      if (hits.length >= limit) return true; // 达到上限立即停止
    }
    return false;
  };

  if (rowOrder) {
    const seen = new Set<number>();
    for (const row of rowOrder) {
      if (seen.has(row)) continue; // 重复行只算一次
      seen.add(row);
      if (!Number.isInteger(row) || row < 0 || row >= rows) continue; // 越界行安全跳过
      if (scanRow(row)) return hits;
    }
    return hits;
  }

  for (let row = 0; row < rows; row++) {
    if (scanRow(row)) break;
  }
  return hits;
}

/**
 * 按**行优先**（row 0..rows-1、col 0..cols-1）查找，最多返回 `limit`（默认 2000）条。
 * `value` 为单元格原值，`null` 视为 `""`。
 */
export function findMatches(
  cells: Cells,
  rows: number,
  cols: number,
  options: FindOptions,
  limit = DEFAULT_FIND_LIMIT,
): FindHit[] {
  return collectHits(cells, rows, cols, null, options, limit);
}

/**
 * 按传入的 `rowOrder`（**展示顺序**，可能被筛选/排序重排，也可能不含全部行）依次查找。
 * `rowOrder` 中越界或重复的项安全跳过（重复只算一次），其余同 `findMatches`。
 */
export function findMatchesInOrder(
  cells: Cells,
  rows: number,
  cols: number,
  rowOrder: number[],
  options: FindOptions,
  limit = DEFAULT_FIND_LIMIT,
): FindHit[] {
  return collectHits(cells, rows, cols, rowOrder, options, limit);
}

/**
 * 替换单个值：未命中**原样返回**（`null` 仍为 `null`）；命中返回替换后的字符串（可能是 `""`）。
 * `value === null` 时视为 `""` 参与匹配，命中后返回字符串。
 */
export function replaceInValue(value: string | null, options: FindOptions, replacement: string): string | null {
  const matcher = buildMatcher(options);
  if (!matcher.test(value)) return value;
  return matcher.replace(value ?? "", replacement);
}

/**
 * 全表替换：命中且值会变化的格子写入 `updates["row:col"]`，`count` 为**被替换的单元格数**。
 * 原值为 `null` 且新值为 `""` 时跳过（无意义写入）；达到 `limit`（默认 5000）时
 * `truncated: true` 并停止（仅当确实还有更多命中时才会置位）。
 */
export function replaceAll(
  cells: Cells,
  rows: number,
  cols: number,
  options: FindOptions,
  replacement: string,
  limit = DEFAULT_REPLACE_LIMIT,
): ReplaceResult {
  const updates: Record<string, string | null> = {};
  let count = 0;
  let truncated = false;

  const matcher = buildMatcher(options);
  outer: for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const key = cellKey(row, col);
      const raw = cells[key] ?? null;
      const next = matcher.test(raw) ? matcher.replace(raw ?? "", replacement) : raw;
      if (next === raw) continue; // 未命中，或替换后值没变
      if (raw === null && next === "") continue; // 原本为空 → 空串，无需写入
      if (count >= limit) {
        truncated = true; // 还有待替换的单元格，但已达上限
        break outer;
      }
      updates[key] = next;
      count += 1;
    }
  }

  return { updates, count, truncated };
}

/**
 * 在 `hits`（行优先或展示顺序）里找下一个/上一个命中的下标。
 *
 * - `direction: 1` 取**严格位于** `selected` 之后的第一个，`-1` 取严格位于之前的最后一个；
 * - 不存在时回绕（`1` → 0，`-1` → `hits.length - 1`）；
 * - `hits` 为空返回 `-1`；`selected` 为 `null` 时取首个（`-1` 取末尾）。
 */
export function nextHitIndex(
  hits: FindHit[],
  selected: { row: number; col: number } | null,
  direction: 1 | -1,
): number {
  if (!hits.length) return -1;
  if (!selected) return direction === -1 ? hits.length - 1 : 0;

  // 选中格本身是命中格：直接按数组顺序取相邻项（保证"展示顺序"语义）
  const current = hits.findIndex((hit) => hit.row === selected.row && hit.col === selected.col);
  if (current >= 0) {
    const next = current + direction;
    if (next >= 0 && next < hits.length) return next;
    return direction === -1 ? hits.length - 1 : 0;
  }

  // 选中格不是命中格：按行优先顺序找严格位于其后的第一个 / 之前的最后一个
  if (direction === 1) {
    for (let i = 0; i < hits.length; i++) {
      const hit = hits[i];
      if (hit.row > selected.row || (hit.row === selected.row && hit.col > selected.col)) return i;
    }
    return 0;
  }
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    if (hit.row < selected.row || (hit.row === selected.row && hit.col < selected.col)) return i;
  }
  return hits.length - 1;
}

/** 生成中文选项摘要，例如 `区分大小写 · 整格匹配 · 正则`。 */
export function describeOptions(options: FindOptions): string {
  const parts: string[] = [];
  if (options.matchCase) parts.push("区分大小写");
  if (options.wholeCell) parts.push("整格匹配");
  if (options.regex) parts.push("正则");
  if (!parts.length) return "默认匹配（忽略大小写、包含即命中）";
  return parts.join(" · ");
}
