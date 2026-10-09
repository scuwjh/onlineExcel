export type Cells = Record<string, string | null>;

export interface CellFormat {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  bg?: string;
  align?: "left" | "center" | "right";
}

export interface SheetData {
  id: string;
  name: string;
  cells: Cells;
  formats: Record<string, CellFormat>;
  version: number;
  rows: number;
  cols: number;
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

export const DEFAULT_ROWS = 100;
export const DEFAULT_COLS = 20;
