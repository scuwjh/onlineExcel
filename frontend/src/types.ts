/** 共享类型定义（与 docs/api-contract.md 保持一致）。 */

export type Cells = Record<string, string | null>;

/** 数字格式（REQ-007）：决定单元格的展示方式，不影响存储的原始值。 */
export type NumberFormat =
  | "general"
  | "number"
  | "integer"
  | "percent"
  | "currency"
  | "date"
  | "text";

/** 边框（REQ-007）：选中单元格时四边可独立开关。 */
export interface CellBorders {
  top?: boolean;
  right?: boolean;
  bottom?: boolean;
  left?: boolean;
}

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  /** 文字颜色（#rrggbb） */
  color?: string;
  /** 背景色（#rrggbb） */
  bg?: string;
  align?: "left" | "center" | "right";
  /** 垂直对齐 */
  valign?: "top" | "middle" | "bottom";
  /** 自动换行 */
  wrap?: boolean;
  /** 字体族 */
  font?: string;
  /** 字号（pt），范围 8–72 */
  size?: number;
  /** 数字/日期格式 */
  numFmt?: NumberFormat;
  /** 边框 */
  borders?: CellBorders;
}

/** 可用的字体族（浏览器端不一定都装了，按系统回退）。 */
export const FONT_FAMILIES = [
  "系统默认",
  "微软雅黑",
  "宋体",
  "黑体",
  "楷体",
  "Arial",
  "Times New Roman",
  "Consolas",
] as const;

export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72] as const;

export const NUMBER_FORMAT_LABELS: Record<NumberFormat, string> = {
  general: "常规",
  number: "数值（千分位）",
  integer: "整数",
  percent: "百分比",
  currency: "货币 ¥",
  date: "日期",
  text: "文本",
};


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

/**
 * 按值多选筛选（REQ-101）：勾选该列要保留的值。
 * 与条件筛选（``ColumnFilter``）叠加生效（都是「并且」关系）。
 */
export interface ValueFilter {
  col: number;
  /** 勾选保留的值（原始文本；空单元格用 ``""`` 表示） */
  values: string[];
}

export interface SortRule {
  col: number;
  dir: "asc" | "desc";
}

/** 视图状态：筛选与排序都只影响本端展示，不改动存储的数据顺序。 */
export interface ViewState {
  filters: ColumnFilter[];
  /** 按值多选筛选 */
  valueFilters: ValueFilter[];
  /** 多级排序：按数组顺序依次比较 */
  sorts: SortRule[];
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
