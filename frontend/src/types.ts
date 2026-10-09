/** 共享类型定义（与 docs/api-contract.md 保持一致）。 */

export type Cells = Record<string, string | null>;

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right";
}

/** 角色：owner > editor > commenter > viewer */
export type Role = "owner" | "editor" | "commenter" | "viewer";

export interface Access {
  sheet_id: string;
  role: Role | null;
  level: number;
  can_view: boolean;
  can_comment: boolean;
  can_edit: boolean;
  can_manage: boolean;
}

export interface SheetSummary {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
  rows: number;
  cols: number;
  owner_id: number | null;
  role: Role | null;
}

export interface SheetData {
  id: string;
  name: string;
  cells: Cells;
  formats: Record<string, CellFormat>;
  version: number;
  seq: number;
  rows: number;
  cols: number;
  /** 稳定的行元素 ID（并发插删行列时用于定位，不随索引漂移）。 */
  rowIds: string[];
  colIds: string[];
  role: Role | null;
}

export interface Presence {
  user: string;
  online: boolean;
}

export interface Cursor {
  user: string;
  row: number;
  col: number;
}

export interface VersionEntry {
  id: number;
  parent_id: number | null;
  seq: number;
  user: string;
  message: string;
  created_at: string;
  ops_bytes: number;
  snapshot_bytes: number;
  is_snapshot: boolean;
  ops_count: number;
}

export interface DiffBucket {
  items: Array<Record<string, unknown>>;
  truncated: boolean;
  total: number;
}

export interface VersionDiff {
  from: { version: number; rows: number; cols: number };
  to: { version: number; rows: number; cols: number };
  structure: { rows: number; cols: number };
  cells: { added: DiffBucket; removed: DiffBucket; changed: DiffBucket };
  formats: { added: DiffBucket; removed: DiffBucket; changed: DiffBucket };
  summary: { added: number; removed: number; changed: number; formats: number };
}

export interface PermissionEntry {
  user_id: number;
  role: Role;
  username: string | null;
}

/** 筛选运算符（REQ-101）。 */
export type FilterOp =
  | "contains"
  | "notContains"
  | "equals"
  | "notEquals"
  | "empty"
  | "notEmpty"
  | "gt"
  | "gte"
  | "lt"
  | "lte";

export interface ColumnFilter {
  col: number;
  op: FilterOp;
  value?: string;
}

export interface SortRule {
  col: number;
  dir: "asc" | "desc";
}

/** 视图状态：筛选与排序都只影响本端展示，不改动存储的数据顺序。 */
export interface ViewState {
  filters: ColumnFilter[];
  sort: SortRule | null;
}

export const FILTER_LABELS: Record<FilterOp, string> = {
  contains: "包含",
  notContains: "不包含",
  equals: "等于",
  notEquals: "不等于",
  empty: "为空",
  notEmpty: "不为空",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
};

export const FILTERS_WITHOUT_VALUE: FilterOp[] = ["empty", "notEmpty"];


export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 20;

/** 虚拟滚动几何常量（px）：与 styles.css 中的样式保持一致。 */
export const ROW_H = 28;
export const COL_W = 108;
export const HEADER_H = 30;
export const ROW_HEAD_W = 56;

export function canEdit(role: Role | null): boolean {
  return role === "owner" || role === "editor";
}

export function canManage(role: Role | null): boolean {
  return role === "owner";
}
