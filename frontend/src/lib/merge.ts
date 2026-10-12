/**
 * 合并区域（MergeRegion）纯逻辑层。
 *
 * 后端以"稳定元素 ID"存储行列（类似 comments 的 row_id/col_id），投影给前端的
 * `MergeRegion` 已解析为 0 基下标且含端点。本模块只做纯计算：没有副作用、
 * 不修改入参、不依赖任何第三方库，便于在 MCP/WebSocket 增量同步与前端渲染之间复用。
 */

import type { MergeRegion } from "../types";

/** 合并区域在"稳定元素 ID"空间的表示（与 MergeRegion 一一对应）。 */
export interface RegionIds {
  r0: string;
  c0: string;
  r1: string;
  c1: string;
}

/** 保证 r0<=r1、c0<=c1（端点交换），始终返回新对象。 */
export function normalizeRegion(region: MergeRegion): MergeRegion {
  return {
    r0: Math.min(region.r0, region.r1),
    c0: Math.min(region.c0, region.c1),
    r1: Math.max(region.r0, region.r1),
    c1: Math.max(region.c0, region.c1),
  };
}

/** 归一化后的区域键，形如 "r0:c0:r1:c1"，用于集合比较与差集。 */
export function regionKey(region: MergeRegion): string {
  const n = normalizeRegion(region);
  return `${n.r0}:${n.c0}:${n.r1}:${n.c1}`;
}

/** 区域覆盖的单元格数量 = (r1-r0+1) * (c1-c0+1)。 */
export function regionCellCount(region: MergeRegion): number {
  const n = normalizeRegion(region);
  return (n.r1 - n.r0 + 1) * (n.c1 - n.c0 + 1);
}

/** 单元格 (row, col) 是否落在区域内（含端点）。 */
export function regionContains(region: MergeRegion, row: number, col: number): boolean {
  const n = normalizeRegion(region);
  return row >= n.r0 && row <= n.r1 && col >= n.c0 && col <= n.c1;
}

/** 两个区域是否相交（共享至少一个单元格）。 */
export function regionIntersects(a: MergeRegion, b: MergeRegion): boolean {
  const x = normalizeRegion(a);
  const y = normalizeRegion(b);
  return !(x.r1 < y.r0 || y.r1 < x.r0 || x.c1 < y.c0 || y.c1 < x.c0);
}

/** 两个区域是否表示同一片单元格（与端点书写顺序无关）。 */
export function regionEqual(a: MergeRegion, b: MergeRegion): boolean {
  return regionKey(a) === regionKey(b);
}

/** 用稳定元素 ID 在 rowIds/colIds 中定位下标；任一 ID 缺失返回 null。 */
export function regionFromIds(region: RegionIds, rowIds: string[], colIds: string[]): MergeRegion | null {
  const r0 = rowIds.indexOf(region.r0);
  const r1 = rowIds.indexOf(region.r1);
  const c0 = colIds.indexOf(region.c0);
  const c1 = colIds.indexOf(region.c1);
  if (r0 < 0 || r1 < 0 || c0 < 0 || c1 < 0) return null;
  return normalizeRegion({ r0, c0, r1, c1 });
}

/** 把下标区域翻译成稳定元素 ID；任一下标越界返回 null。 */
export function regionToIds(region: MergeRegion, rowIds: string[], colIds: string[]): RegionIds | null {
  const n = normalizeRegion(region);
  if (n.r0 < 0 || n.r1 >= rowIds.length) return null;
  if (n.c0 < 0 || n.c1 >= colIds.length) return null;
  return {
    r0: rowIds[n.r0],
    c0: colIds[n.c0],
    r1: rowIds[n.r1],
    c1: colIds[n.c1],
  };
}

/** 返回第一个包含该格的区域；没有则返回 null。 */
export function findRegionAt(merges: MergeRegion[], row: number, col: number): MergeRegion | null {
  for (const region of merges) {
    if (regionContains(region, row, col)) return region;
  }
  return null;
}

/**
 * 追加一个合并区域：
 * - 单格区域是 no-op，原样返回入参；
 * - 已存在完全相同的区域时幂等，原样返回入参；
 * - 否则移除所有与之相交的旧区域（相交即被吞并），把新区域追加到末尾。
 * 不修改入参。
 */
export function mergeRegions(merges: MergeRegion[], region: MergeRegion): MergeRegion[] {
  const next = normalizeRegion(region);
  if (regionCellCount(next) === 1) return merges;
  const key = regionKey(next);
  if (merges.some((r) => regionKey(r) === key)) return merges;
  const kept = merges.filter((r) => !regionIntersects(r, next));
  return [...kept, next];
}

/** 解除所有包含 (row, col) 的区域；无变化时返回入参本身。 */
export function unmergeRegions(merges: MergeRegion[], row: number, col: number): MergeRegion[] {
  const kept = merges.filter((r) => !regionContains(r, row, col));
  return kept.length === merges.length ? merges : kept;
}

/** 从 from 到 to 的合并差集：toMerge 为新增，toUnmerge 为移除；两数组均按 sortRegions 排序。 */
export function diffMerges(
  from: MergeRegion[],
  to: MergeRegion[],
): { toMerge: MergeRegion[]; toUnmerge: MergeRegion[] } {
  const fromKeys = new Set(from.map(regionKey));
  const toKeys = new Set(to.map(regionKey));
  const toMerge = to.filter((r) => !fromKeys.has(regionKey(r)));
  const toUnmerge = from.filter((r) => !toKeys.has(regionKey(r)));
  return { toMerge: sortRegions(toMerge), toUnmerge: sortRegions(toUnmerge) };
}

/**
 * 区域内所有"被遮挡"（非左上角）单元格的 "row:col" 集合。
 * 重叠时以先出现的区域的左上角为准：某格只有在"没有任何更早的区域把它当作左上角"
 * 且"它不是自己所属第一个区域的左上角"时才被遮挡。
 * 传入 rows/cols 时跳过越界单元格。
 */
export function hiddenCells(merges: MergeRegion[], rows?: number, cols?: number): Set<string> {
  const hidden = new Set<string>();
  const seen = new Set<string>();
  for (const raw of merges) {
    const region = normalizeRegion(raw);
    const anchor = anchorCell(region);
    for (let r = region.r0; r <= region.r1; r++) {
      if (rows !== undefined && (r < 0 || r >= rows)) continue;
      for (let c = region.c0; c <= region.c1; c++) {
        if (cols !== undefined && (c < 0 || c >= cols)) continue;
        const key = `${r}:${c}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (r === anchor.row && c === anchor.col) continue;
        hidden.add(key);
      }
    }
  }
  return hidden;
}

/** 合并区域的左上角（锚点）单元格。 */
export function anchorCell(region: MergeRegion): { row: number; col: number } {
  const n = normalizeRegion(region);
  return { row: n.r0, col: n.c0 };
}

/**
 * 把区域裁剪到 rows x cols 的表格内。
 * 下界越界（r0>=rows 或 c0>=cols）、裁剪后不足 2 格时返回 null。
 */
export function clampRegion(region: MergeRegion, rows: number, cols: number): MergeRegion | null {
  const n = normalizeRegion(region);
  if (rows <= 0 || cols <= 0) return null;
  // 下界完全越界：区域整片落在表格之外，没有任何可保留的合并。
  if (n.r0 >= rows || n.c0 >= cols) return null;
  const clipped: MergeRegion = {
    r0: Math.max(0, n.r0),
    c0: Math.max(0, n.c0),
    r1: Math.min(rows - 1, n.r1),
    c1: Math.min(cols - 1, n.c1),
  };
  if (clipped.r0 > clipped.r1 || clipped.c0 > clipped.c1) return null;
  return regionCellCount(clipped) >= 2 ? clipped : null;
}

/** A1 记法，如 {r0:0,c0:0,r1:1,c1:1} -> "A1:B2"，单格 -> "A1"。 */
export function regionLabel(region: MergeRegion): string {
  const n = normalizeRegion(region);
  const start = `${columnName(n.c0)}${n.r0 + 1}`;
  if (n.r0 === n.r1 && n.c0 === n.c1) return start;
  return `${start}:${columnName(n.c1)}${n.r1 + 1}`;
}

/** 按 r0,c0,r1,c1 升序排列，返回新数组（不修改入参）。 */
export function sortRegions(merges: MergeRegion[]): MergeRegion[] {
  return merges
    .slice()
    .sort((a, b) => a.r0 - b.r0 || a.c0 - b.c0 || a.r1 - b.r1 || a.c1 - b.c1);
}

/** 忽略顺序比较两组合并区域是否完全相同（不入参数组）。 */
export function mergesEqual(a: MergeRegion[], b: MergeRegion[]): boolean {
  const left = sortRegions(a);
  const right = sortRegions(b);
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (regionKey(left[i]) !== regionKey(right[i])) return false;
  }
  return true;
}

/** 0 基列下标 -> 列名（0->A, 25->Z, 26->AA, 27->AB）。 */
function columnName(col: number): string {
  let name = "";
  let n = col + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}
