/**
 * 协同表格状态机。
 *
 * 权威来源是服务端：本地写入先乐观更新，服务端回执（带权威投影）再整体校准，
 * 因此即使并发插删行列也不会出现坐标漂移。每条写操作都携带版本向量
 * （``{clientId: seq}``），服务端据此做 LWW 判定。
 *
 * 撤销/重做由 reducer 统一维护：`history` 保存"写入之前"的快照（改 `cells` 的
 * action 在同一 reducer 里顺便压栈），`future` 保存重做栈。这样撤销恢复的一定是
 * 本次改动前的状态，不会把自己写进去。
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import * as api from "../api";
import { cellKey } from "../lib/gridUtils";
import { fillSeries } from "../lib/fillSeries";
import { structureDeltas } from "../lib/structure";
import { cellsToCsv, csvToCells, parseClipboardGrid } from "../lib/csv";
import type { CellFormat, Cells, Cursor, Role, SheetData } from "../types";
import { DEFAULT_COLS, DEFAULT_ROWS } from "../types";
import { connectWS, type WsClient, type WsMessage } from "../ws";

export interface CellPoint {
  row: number;
  col: number;
}

/** 撤销/重做快照：一次写操作前的完整状态（单元格值 + 格式 + 结构）。 */
export interface HistoryEntry {
  cells: Cells;
  formats: Record<string, CellFormat>;
  rows: number;
  cols: number;
  rowIds: string[];
  colIds: string[];
}

/** 选区类型（REQ-002/003）。 */
export type SelectionKind = "cell" | "row" | "col" | "all";

export interface SheetState {  sheetId: string | null;
  sheetName: string;
  role: Role | null;
  cells: Cells;
  formats: Record<string, CellFormat>;
  rowIds: string[];
  colIds: string[];
  rows: number;
  cols: number;
  version: number;
  seq: number;
  selected: CellPoint;
  /** 框选锚点：与 selected 一起构成选区（REQ-002/003）。 */
  anchor: CellPoint;
  /**
   * 选区类型（REQ-002/003）：
   * - ``cell``：普通单元格/矩形框选；
   * - ``row``：点行号选中的整行（可跨多行）；
   * - ``col``：点列标选中的整列（可跨多列）；
   * - ``all``：Ctrl+A 或点左上角的全选。
   */
  selectionKind: SelectionKind;
  editing: CellPoint | null;
  /** 焦点在公式栏（REQ-009）：此时 draft 是唯一真相，网格不弹浮层。 */
  formulaEditing: boolean;
  draft: string;
  users: Record<string, boolean>;
  cursors: Record<string, Cursor>;
  frozenRows: number;
  frozenCols: number;
  history: HistoryEntry[];
  future: HistoryEntry[];
  status: "connecting" | "open" | "closed";
  error: string | null;
  loading: boolean;
}

type Action =
  | { type: "LOAD"; sheet: SheetData }
  | { type: "SELECT"; row: number; col: number }
  | { type: "SELECT_EXTEND"; row: number; col: number }
  | { type: "SELECT_ALL"; rows: number; cols: number }
  | { type: "SELECT_ROW"; row: number; col: number }
  | { type: "SELECT_COL"; row: number; col: number }
  | { type: "SELECT_ROW_EXTEND"; from: number; to: number }
  | { type: "SELECT_COL_EXTEND"; from: number; to: number }
  | { type: "START_EDIT"; row: number; col: number; draft: string }
  /** 只在公式栏里编辑：改草稿但**不**打开网格的单元格编辑浮层。 */
  | { type: "START_FORMULA"; row: number; col: number; draft: string }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "CANCEL_EDIT" }
  | { type: "LOCAL_CELL"; row: number; col: number; value: string | null; record?: boolean }
  | { type: "LOCAL_CELLS"; updates: Record<string, string | null>; record?: boolean }
  | { type: "REMOTE_CELL"; row: number; col: number; value: string | null; cells?: Cells; version?: number; seq?: number }
  | { type: "REMOTE_FORMAT"; row: number; col: number; format: CellFormat | null; formats?: Record<string, CellFormat> }
  | { type: "LOCAL_FORMAT"; row: number; col: number; format: CellFormat | null; record?: boolean }
  | {
      type: "LOCAL_FORMATS";
      entries: Array<{ row: number; col: number; format: CellFormat | null }>;
      record?: boolean;
    }
  | {
      type: "REMOTE_STRUCTURE";
      cells?: Cells;
      formats?: Record<string, CellFormat>;
      rowIds?: string[];
      colIds?: string[];
      rows?: number;
      cols?: number;
      seq?: number;
      version?: number;
      /** 本端自己发出的结构操作回执：把操作前的快照压入撤销栈。 */
      record?: HistoryEntry;
      /** 结构撤销/重做的回执期间：保留现有撤销/重做栈，不被清空。 */
      preserve?: boolean;
    }
  | { type: "SET_CURSOR"; cursor: Cursor }
  | { type: "SET_PRESENCE"; user: string; online: boolean; users?: string[] }
  | { type: "FREEZE"; rows: number; cols: number }
  | { type: "UNFREEZE" }
  | { type: "STATUS"; status: SheetState["status"] }
  | { type: "ERROR"; error: string | null }
  | { type: "LOADING"; loading: boolean }
  | { type: "CLEAR_HISTORY" }
  | { type: "UNDO" }
  | { type: "REDO" };

const initialState: SheetState = {
  sheetId: null,
  sheetName: "",
  role: null,
  cells: {},
  formats: {},
  rowIds: [],
  colIds: [],
  rows: DEFAULT_ROWS,
  cols: DEFAULT_COLS,
  version: 0,
  seq: 0,
  selected: { row: 0, col: 0 },
  anchor: { row: 0, col: 0 },
  selectionKind: "cell",
  editing: null,
  formulaEditing: false,
  draft: "",
  users: {},
  cursors: {},
  frozenRows: 0,
  frozenCols: 0,
  history: [],
  future: [],
  status: "closed",
  error: null,
  loading: true,
};

const HISTORY_LIMIT = 50;

/** 取当前状态的撤销快照（含格式与结构），历史栈与重做栈均用此类型。 */
function snapshotOf(state: SheetState): HistoryEntry {
  return {
    cells: state.cells,
    formats: state.formats,
    rows: state.rows,
    cols: state.cols,
    rowIds: state.rowIds,
    colIds: state.colIds,
  };
}

function pushHistory(state: SheetState, entry: HistoryEntry): HistoryEntry[] {
  return [...state.history, entry].slice(-HISTORY_LIMIT);
}

function reducer(state: SheetState, action: Action): SheetState {
  switch (action.type) {
    case "LOAD":
      return {
        ...initialState,
        sheetId: action.sheet.id,
        sheetName: action.sheet.name,
        role: action.sheet.role,
        cells: action.sheet.cells,
        formats: action.sheet.formats,
        rowIds: action.sheet.rowIds ?? [],
        colIds: action.sheet.colIds ?? [],
        rows: action.sheet.rows,
        cols: action.sheet.cols,
        version: action.sheet.version,
        seq: action.sheet.seq ?? 0,
        status: state.status,
        loading: false,
      };
    case "SELECT":
      return {
        ...state,
        selected: { row: action.row, col: action.col },
        anchor: { row: action.row, col: action.col },
        selectionKind: "cell",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_EXTEND":
      // Shift+方向键：移动活动格，但保持锚点不动 → 选区扩大/收缩。
      // 从"整行/整列"选区进入拖拽扩展时，退化为矩形选区（与 Excel 一致）。
      return {
        ...state,
        selected: { row: action.row, col: action.col },
        selectionKind: state.selectionKind === "all" ? "all" : "cell",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_ALL":
      return {
        ...state,
        // 活动格放在右下角，锚点放在左上角 → 覆盖整张表
        selected: { row: Math.max(0, action.rows - 1), col: Math.max(0, action.cols - 1) },
        anchor: { row: 0, col: 0 },
        selectionKind: "all",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_ROW":
      // 点行号：整行选中（锚点落在该行首列，活动格落在该行末列 → 整行）
      return {
        ...state,
        selected: { row: action.row, col: Math.max(action.col, 0) },
        anchor: { row: action.row, col: 0 },
        selectionKind: "row",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_COL":
      return {
        ...state,
        selected: { row: Math.max(action.row, 0), col: action.col },
        anchor: { row: 0, col: action.col },
        selectionKind: "col",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_ROW_EXTEND":
      // Shift+点行号 / 拖动行号：连续整行
      return {
        ...state,
        selected: { row: action.to, col: state.selected.col },
        anchor: { row: action.from, col: 0 },
        selectionKind: "row",
        editing: null,
        formulaEditing: false,
      };
    case "SELECT_COL_EXTEND":
      return {
        ...state,
        selected: { row: state.selected.row, col: action.to },
        anchor: { row: 0, col: action.from },
        selectionKind: "col",
        editing: null,
        formulaEditing: false,
      };
    case "START_EDIT":
      return {
        ...state,
        selected: { row: action.row, col: action.col },
        editing: { row: action.row, col: action.col },
        formulaEditing: false,
        draft: action.draft,
      };
    case "START_FORMULA":
      // 焦点在公式栏：不设置 editing（否则网格会再弹输入框抢焦点），
      // 但要用 formulaEditing 让 rawValue 读到 draft。
      return {
        ...state,
        selected: { row: action.row, col: action.col },
        editing: null,
        formulaEditing: true,
        draft: action.draft,
      };
    case "SET_DRAFT":
      return { ...state, draft: action.draft };
    case "CANCEL_EDIT":
      return { ...state, editing: null, formulaEditing: false };
    case "LOCAL_CELL": {
      const key = cellKey(action.row, action.col);
      const record = action.record !== false;
      return {
        ...state,
        cells: { ...state.cells, [key]: action.value },
        editing: null,
        formulaEditing: false,
        history: record ? pushHistory(state, snapshotOf(state)) : state.history,
        future: record ? [] : state.future,
      };
    }
    case "LOCAL_CELLS": {
      const cells = { ...state.cells };
      for (const [key, value] of Object.entries(action.updates)) cells[key] = value;
      const record = action.record !== false;
      return {
        ...state,
        cells,
        editing: null,
        history: record ? pushHistory(state, snapshotOf(state)) : state.history,
        future: record ? [] : state.future,
      };
    }
    case "REMOTE_CELL": {
      // 服务端回执带权威投影 → 整体覆盖；否则做单格补丁。历史栈由调用方决定是否清空。
      const cells = action.cells ?? { ...state.cells, [cellKey(action.row, action.col)]: action.value };
      return {
        ...state,
        cells,
        version: action.version ?? state.version,
        seq: action.seq ?? state.seq,
      };
    }
    case "REMOTE_FORMAT": {
      const formats = action.formats ? { ...action.formats } : { ...state.formats };
      if (!action.formats) {
        const key = cellKey(action.row, action.col);
        if (action.format) formats[key] = action.format;
        else delete formats[key];
      }
      return { ...state, formats };
    }
    case "LOCAL_FORMAT": {
      const key = cellKey(action.row, action.col);
      const formats = { ...state.formats };
      if (action.format && Object.keys(action.format).length) formats[key] = action.format;
      else delete formats[key];
      const record = action.record !== false;
      return {
        ...state,
        formats,
        history: record ? pushHistory(state, snapshotOf(state)) : state.history,
        future: record ? [] : state.future,
      };
    }
    case "LOCAL_FORMATS": {
      // 选区批量套用格式：一次记录历史，整批可撤销
      const formats = { ...state.formats };
      for (const entry of action.entries) {
        const key = cellKey(entry.row, entry.col);
        if (entry.format && Object.keys(entry.format).length) formats[key] = entry.format;
        else delete formats[key];
      }
      const record = action.record !== false;
      return {
        ...state,
        formats,
        history: record ? pushHistory(state, snapshotOf(state)) : state.history,
        future: record ? [] : state.future,
      };
    }
    case "REMOTE_STRUCTURE": {
      // 本端自己的结构操作回执（record）→ 压入撤销栈；结构撤销/重做回执（preserve）→ 保留栈
      if (action.record) {
        return {
          ...state,
          cells: action.cells ?? state.cells,
          formats: action.formats ?? state.formats,
          rowIds: action.rowIds ?? state.rowIds,
          colIds: action.colIds ?? state.colIds,
          rows: action.rows ?? state.rows,
          cols: action.cols ?? state.cols,
          seq: action.seq ?? state.seq,
          version: action.version ?? state.version,
          editing: null,
          history: pushHistory(state, action.record),
          future: [],
        };
      }
      return {
        ...state,
        cells: action.cells ?? state.cells,
        formats: action.formats ?? state.formats,
        rowIds: action.rowIds ?? state.rowIds,
        colIds: action.colIds ?? state.colIds,
        rows: action.rows ?? state.rows,
        cols: action.cols ?? state.cols,
        seq: action.seq ?? state.seq,
        version: action.version ?? state.version,
        editing: null,
        history: action.preserve ? state.history : [],
        future: action.preserve ? state.future : [],
      };
    }
    case "SET_CURSOR":
      return { ...state, cursors: { ...state.cursors, [action.cursor.user]: action.cursor } };
    case "SET_PRESENCE": {
      const users = { ...state.users };
      if (action.users) {
        for (const key of Object.keys(users)) users[key] = action.users.includes(key);
        for (const user of action.users) users[user] = true;
      } else {
        users[action.user] = action.online;
      }
      return { ...state, users };
    }
    case "FREEZE":
      return {
        ...state,
        frozenRows: Math.min(action.rows, state.rows),
        frozenCols: Math.min(action.cols, state.cols),
      };
    case "UNFREEZE":
      return { ...state, frozenRows: 0, frozenCols: 0 };
    case "STATUS":
      return { ...state, status: action.status };
    case "ERROR":
      return { ...state, error: action.error };
    case "LOADING":
      return { ...state, loading: action.loading };
    case "CLEAR_HISTORY":
      return { ...state, history: [], future: [] };
    case "UNDO": {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        cells: prev.cells,
        formats: prev.formats,
        rows: prev.rows,
        cols: prev.cols,
        rowIds: prev.rowIds,
        colIds: prev.colIds,
        history: state.history.slice(0, -1),
        future: [...state.future, snapshotOf(state)].slice(-HISTORY_LIMIT),
        editing: null,
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        cells: next.cells,
        formats: next.formats,
        rows: next.rows,
        cols: next.cols,
        rowIds: next.rowIds,
        colIds: next.colIds,
        history: pushHistory(state, snapshotOf(state)),
        future: state.future.slice(0, -1),
        editing: null,
      };
    }
    default:
      return state;
  }
}

function clientId(): string {
  const key = "oe-client";
  const saved = window.localStorage.getItem(key);
  if (saved) return saved;
  const generated = `c-${Math.random().toString(36).slice(2, 10)}`;
  window.localStorage.setItem(key, generated);
  return generated;
}

/** 下行消息的 ``version`` 是服务端版本号；上行才是版本向量。 */
function asNumber(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function sameIds(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** 两个 cell 快照（按 "row:col" 索引）的差异 → 需要写回的值表。 */
function diffCells(from: Cells, to: Cells): Record<string, string | null> {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const updates: Record<string, string | null> = {};
  for (const key of keys) {
    const a = from[key] ?? null;
    const b = to[key] ?? null;
    if (a !== b) updates[key] = b;
  }
  return updates;
}

/** 两个 format 快照的差异（空对象视为删除）。 */
function diffFormats(
  from: Record<string, CellFormat>,
  to: Record<string, CellFormat>,
): Record<string, CellFormat | null> {
  const keys = new Set([...Object.keys(from), ...Object.keys(to)]);
  const updates: Record<string, CellFormat | null> = {};
  for (const key of keys) {
    const a = from[key] ?? null;
    const b = to[key] ?? null;
    const an = a && Object.keys(a).length ? a : null;
    const bn = b && Object.keys(b).length ? b : null;
    if (JSON.stringify(an ?? {}) !== JSON.stringify(bn ?? {})) updates[key] = bn;
  }
  return updates;
}

export interface UseSheetResult {
  state: SheetState;
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  select: (row: number, col: number) => void;
  /** Shift+方向键：移动活动格并保持锚点（扩展选区）。 */
  extendSelect: (row: number, col: number) => void;
  /** Ctrl+A：全选。 */
  selectAll: () => void;
  /** 点行号：整行选中（Shift 时为连续多行）。 */
  selectRow: (row: number, extend?: boolean) => void;
  /** 点列标：整列选中（Shift 时为连续多列）。 */
  selectCol: (col: number, extend?: boolean) => void;
  /** 当前选区（锚点与活动格之间的矩形）。 */
  targetRange: () => { r0: number; c0: number; r1: number; c1: number };
  /** 清空选区内的所有单元格（Delete/Backspace）。 */
  clearRange: (r0: number, c0: number, r1: number, c1: number) => void;
  startEdit: (row: number, col: number, draft: string) => void;
  /** 公式栏进入编辑态（不动网格浮层）。 */
  startFormulaEdit: (row: number, col: number, draft: string) => void;
  setDraft: (draft: string) => void;
  cancelEdit: () => void;
  commitCell: (row: number, col: number, value: string) => void;
  /** 把格式套用到当前选区（单元格/框选/整行整列/全选都支持）。 */
  applyFormat: (partial: Partial<CellFormat>) => void;
  /** 把格式套用到指定范围。 */
  applyFormatToRange: (partial: Partial<CellFormat>, range?: { r0: number; c0: number; r1: number; c1: number }) => void;
  /** 清空指定范围（默认当前选区）的格式。 */
  clearFormat: (range?: { r0: number; c0: number; r1: number; c1: number }) => void;
  toggleStyle: (key: "bold" | "italic" | "underline" | "strike") => void;
  pasteBlock: (row: number, col: number, text: string) => void;
  insertRow: () => void;
  deleteRow: () => void;
  insertCol: () => void;
  deleteCol: () => void;
  /** 在指定行上方/下方插入行（右键菜单）。 */
  insertRowAt: (row: number, above?: boolean) => void;
  /** 删除指定行；整行选区时删除全部选中行。 */
  deleteRowAt: (row: number) => void;
  insertColAt: (col: number, left?: boolean) => void;
  deleteColAt: (col: number) => void;
  /** 拖拽填充（REQ-006）：源区域 → 目标区域。 */
  fillRange: (
    source: { r0: number; c0: number; r1: number; c1: number },
    target: { r0: number; c0: number; r1: number; c1: number },
    options?: { series: boolean; format: boolean },
  ) => void;
  /** 复制/剪切当前选区（cut=true 时记录源区，粘贴后清空）。 */
  copySelection: (cut?: boolean) => string;
  undo: () => void;
  redo: () => void;
  freeze: () => void;
  unfreeze: () => void;
  exportCsv: () => void;
  importCsv: (file: File) => Promise<void>;
  reload: () => Promise<void>;
  notify: (message: string) => void;
  dismissError: () => void;
}

export function useSheet(
  sheet: SheetData | null,
  onSheetChanged?: () => void,
  onCommentAdded?: (comment: Record<string, unknown>, counts: Record<string, number>) => void,
): UseSheetResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WsClient | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  /** 评论广播回调：用 ref 持有，避免 socket 回调锁死旧闭包。 */
  const onCommentAddedRef = useRef(onCommentAdded);
  onCommentAddedRef.current = onCommentAdded;
  /** 右键"剪切"的源区域：下次粘贴时清空（Excel 语义）。 */
  const cutRangeRef = useRef<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const versionRef = useRef<Record<string, number>>({});
  const counterRef = useRef(0);
  /** 本端最近一次乐观写入，用于识别服务端回执（回执不带 client_id）。 */
  const pendingRef = useRef<{ row: number; col: number; value: string | null } | null>(null);
  /** 批量写入（粘贴/撤销/重做）可能一次发出多格，逐条登记以便回执识别。 */
  const pendingBatchRef = useRef<Set<string>>(new Set());
  const localId = useMemo(clientId, []);

  const notify = useCallback((message: string) => dispatch({ type: "ERROR", error: message }), []);
  const dismissError = useCallback(() => dispatch({ type: "ERROR", error: null }), []);
  const clearHistory = useCallback(() => dispatch({ type: "CLEAR_HISTORY" }), []);

  const loadedRef = useRef<{ id: string; version: number } | null>(null);

  /**
   * 结构操作回执守卫：
   * - ``op``：本端刚发出一次普通的插入/删除行列，回执到达时把操作前的快照压入撤销栈；
   * - ``undo``/``redo``：本端正在重放结构差异（一次可能多条 op），回执期间保留撤销栈不清空。
   */
  const structureGuardRef = useRef<
  | { kind: "op"; record: HistoryEntry }
  | { kind: "undo" | "redo"; remaining: number }
  | null
>(null);

  useEffect(() => {
    if (!sheet) {
      dispatch({ type: "LOADING", loading: false });
      return;
    }
    // 换了表格，或同一张表的服务端版本前进了（例如 Excel 导入、版本恢复），才整体重载。
    // 父组件在每次写入后都会重新拉取同一张表；用版本号判断可避免把本地撤销栈清掉，
    // 同时又能在导入这类"整表替换"后立刻刷新内容。
    const previous = loadedRef.current;
    const sameSnapshot = previous !== null && previous.id === sheet.id && previous.version >= sheet.version;
    if (sameSnapshot) {
      dispatch({ type: "LOADING", loading: false });
      return;
    }
    loadedRef.current = { id: sheet.id, version: sheet.version };
    dispatch({ type: "LOAD", sheet });
    versionRef.current = {};
    counterRef.current = 0;
    pendingRef.current = null;
    pendingBatchRef.current.clear();
  }, [sheet]);

  const handleMessage = useCallback(
    (msg: WsMessage) => {
      if (typeof msg.seq === "number" && typeof msg.user === "string") {
        versionRef.current[msg.user] = Math.max(versionRef.current[msg.user] ?? 0, msg.seq);
      }
      switch (msg.type) {
        case "welcome":
          if (msg.rowIds && msg.colIds) {
            dispatch({
              type: "REMOTE_STRUCTURE",
              cells: msg.cells,
              formats: msg.formats,
              rowIds: msg.rowIds,
              colIds: msg.colIds,
              rows: msg.rows,
              cols: msg.cols,
              seq: asNumber(msg.seq),
              version: asNumber(msg.version),
            });
          } else if (msg.reload) {
            void api
              .getSheet(stateRef.current.sheetId ?? "")
              .then((fresh) => dispatch({ type: "LOAD", sheet: fresh }))
              .catch((err) => notify(String((err as Error).message ?? err)));
          }
          if (Array.isArray(msg.users)) {
            for (const user of msg.users) dispatch({ type: "SET_PRESENCE", user, online: true });
          }
          break;
        case "cell_update": {
          // 回执可能只带 row_id/col_id（批量或 REST 回写），统一换算成索引再比对。
          const state = stateRef.current;
          let row = typeof msg.row === "number" ? msg.row : -1;
          let col = typeof msg.col === "number" ? msg.col : -1;
          if ((row < 0 || col < 0) && msg.row_id && msg.col_id) {
            const ri = state.rowIds.indexOf(String(msg.row_id));
            const ci = state.colIds.indexOf(String(msg.col_id));
            if (ri >= 0) row = ri;
            if (ci >= 0) col = ci;
          }
          const value = (msg.value as string | null) ?? null;
          const pending = pendingRef.current;
          const mineSingle =
            pending !== null && pending.row === row && pending.col === col && (pending.value ?? null) === value;
          const mineBatch = pendingBatchRef.current.has(`${row}:${col}:${value === null ? "" : value}`);
          if (mineSingle) pendingRef.current = null;
          if (mineBatch) pendingBatchRef.current.delete(`${row}:${col}:${value === null ? "" : value}`);
          if (!mineSingle && !mineBatch) {
            // 其他人的写入会带来本端未见过的新状态 → 撤销栈不再可靠，清空
            clearHistory();
          }
          dispatch({
            type: "REMOTE_CELL",
            row,
            col,
            value,
            cells: msg.cells,
            version: asNumber(msg.version),
            seq: asNumber(msg.seq),
          });
          if (msg.reload) {
            void api
              .getSheet(stateRef.current.sheetId ?? "")
              .then((fresh) => dispatch({ type: "LOAD", sheet: fresh }))
              .catch((err) => notify(String((err as Error).message ?? err)));
          }
          break;
        }
        case "cell_format":
          dispatch({
            type: "REMOTE_FORMAT",
            row: Number(msg.row ?? 0),
            col: Number(msg.col ?? 0),
            format: (msg.format as CellFormat | null) ?? null,
            formats: msg.formats,
          });
          break;
        case "row_insert":
        case "row_delete":
        case "col_insert":
        case "col_delete":
        case "sheet_import": {
          // 本端自己发起的结构操作回执：见 structureGuardRef 注释
          const guard = structureGuardRef.current;
          let record: HistoryEntry | undefined;
          let preserve = false;
          if (guard) {
            if (guard.kind === "op") {
              structureGuardRef.current = null;
              record = guard.record;
            } else {
              guard.remaining -= 1;
              if (guard.remaining <= 0) structureGuardRef.current = null;
              preserve = true;
            }
          }
          if (msg.reload) {
            void api
              .getSheet(stateRef.current.sheetId ?? "")
              .then((fresh) => dispatch({ type: "LOAD", sheet: fresh }))
              .catch((err) => notify(String((err as Error).message ?? err)));
            break;
          }
          dispatch({
            type: "REMOTE_STRUCTURE",
            cells: msg.cells,
            formats: msg.formats,
            rowIds: msg.rowIds,
            colIds: msg.colIds,
            rows: msg.rows,
            cols: msg.cols,
            seq: asNumber(msg.seq),
            version: asNumber(msg.version),
            record,
            preserve,
          });
          break;
        }
        case "cursor":
          dispatch({
            type: "SET_CURSOR",
            cursor: { user: String(msg.user), row: Number(msg.row ?? 0), col: Number(msg.col ?? 0) },
          });
          break;
        case "presence":
          dispatch({
            type: "SET_PRESENCE",
            user: String(msg.user),
            online: Boolean(msg.online),
            users: Array.isArray(msg.users) ? (msg.users as string[]) : undefined,
          });
          break;
        case "error":
          notify(String(msg.message ?? "服务端拒绝了该操作"));
          break;
        case "comment_added":
          // 他人新增评论：交给评论 hook 合并（含角标计数）
        case "comment_updated": {
          const comment = msg.comment as Record<string, unknown> | undefined;
          const counts = (msg.counts as Record<string, number>) ?? {};
          if (comment) onCommentAddedRef.current?.(comment, counts);
          break;
        }
        default:
          break;
      }
    },
    [notify, clearHistory],
  );

  // 用 ref 持有最新 handler，避免长生命周期 socket 回调里锁死旧闭包（会误判本端回执）。
  const handleMessageRef = useRef(handleMessage);
  handleMessageRef.current = handleMessage;

  useEffect(() => {
    if (!state.sheetId) return;
    const client = connectWS(state.sheetId, {
      onMessage: (msg) => handleMessageRef.current(msg),
      onStatus: (status) => dispatch({ type: "STATUS", status }),
      onFatal: (reason) => {
        dispatch({ type: "STATUS", status: "closed" });
        notify(`实时连接失败：${reason}`);
      },
    });
    wsRef.current = client;
    return () => {
      client.close();
      wsRef.current = null;
    };
  }, [state.sheetId, handleMessage, notify]);

  const send = useCallback((msg: WsMessage) => {
    wsRef.current?.send(msg);
  }, []);

  const bump = useCallback(() => {
    counterRef.current += 1;
    versionRef.current[localId] = counterRef.current;
    return { ...versionRef.current };
  }, [localId]);

  const editable = state.role === "owner" || state.role === "editor";

  const select = useCallback(
    (row: number, col: number) => {
      dispatch({ type: "SELECT", row, col });
      send({ type: "cursor", row, col });
    },
    [send],
  );

  const extendSelect = useCallback(
    (row: number, col: number) => {
      const { rows, cols } = stateRef.current;
      const nr = Math.max(0, Math.min(rows - 1, row));
      const nc = Math.max(0, Math.min(cols - 1, col));
      dispatch({ type: "SELECT_EXTEND", row: nr, col: nc });
      send({ type: "cursor", row: nr, col: nc });
    },
    [send],
  );

  const selectAll = useCallback(() => {
    const { rows, cols } = stateRef.current;
    dispatch({ type: "SELECT_ALL", rows, cols });
  }, []);

  /** 当前选区矩形（整行/整列/全选时自动展开为对应的完整范围）。 */
  const targetRange = useCallback(() => {
    const { selected, anchor, rows, cols, selectionKind } = stateRef.current;
    if (selectionKind === "all") return { r0: 0, c0: 0, r1: Math.max(0, rows - 1), c1: Math.max(0, cols - 1) };
    if (selectionKind === "row") {
      const r0 = Math.min(selected.row, anchor.row);
      const r1 = Math.max(selected.row, anchor.row);
      return { r0, c0: 0, r1, c1: Math.max(0, cols - 1) };
    }
    if (selectionKind === "col") {
      const c0 = Math.min(selected.col, anchor.col);
      const c1 = Math.max(selected.col, anchor.col);
      return { r0: 0, c0, r1: Math.max(0, rows - 1), c1 };
    }
    return {
      r0: Math.min(selected.row, anchor.row),
      c0: Math.min(selected.col, anchor.col),
      r1: Math.max(selected.row, anchor.row),
      c1: Math.max(selected.col, anchor.col),
    };
  }, []);

  /** 点行号/点列标：整行整列选中；Shift 时为连续多行/多列。 */
  const selectRow = useCallback((row: number, extend = false) => {
    const { rows, cols, anchor, selectionKind } = stateRef.current;
    const target = Math.max(0, Math.min(rows - 1, row));
    if (extend || selectionKind === "row") {
      const from = selectionKind === "row" ? anchor.row : target;
      dispatch({ type: "SELECT_ROW_EXTEND", from, to: target });
    } else {
      dispatch({ type: "SELECT_ROW", row: target, col: Math.max(0, cols - 1) });
    }
  }, []);

  const selectCol = useCallback((col: number, extend = false) => {
    const { rows, cols, anchor, selectionKind } = stateRef.current;
    const target = Math.max(0, Math.min(cols - 1, col));
    if (extend || selectionKind === "col") {
      const from = selectionKind === "col" ? anchor.col : target;
      dispatch({ type: "SELECT_COL_EXTEND", from, to: target });
    } else {
      dispatch({ type: "SELECT_COL", row: Math.max(0, rows - 1), col: target });
    }
  }, []);

  const startEdit = useCallback(
    (row: number, col: number, draft: string) => {
      if (!editable) return;
      dispatch({ type: "START_EDIT", row, col, draft });
    },
    [editable],
  );

  /** 公式栏获得焦点：只进入"公式编辑"状态，不打开网格浮层。 */
  const startFormulaEdit = useCallback(
    (row: number, col: number, draft: string) => {
      if (!editable) return;
      dispatch({ type: "START_FORMULA", row, col, draft });
    },
    [editable],
  );

  const setDraft = useCallback((draft: string) => dispatch({ type: "SET_DRAFT", draft }), []);
  const cancelEdit = useCallback(() => dispatch({ type: "CANCEL_EDIT" }), []);

  const commitCell = useCallback(
    (row: number, col: number, value: string) => {
      if (!editable) {
        dispatch({ type: "CANCEL_EDIT" });
        return;
      }
      const normalized = value === "" ? null : value;
      const current = stateRef.current.cells[cellKey(row, col)] ?? null;
      if (current === normalized) {
        dispatch({ type: "CANCEL_EDIT" });
        return;
      }
      const sheetId = stateRef.current.sheetId;
      const rowId = stateRef.current.rowIds[row];
      const colId = stateRef.current.colIds[col];
      dispatch({ type: "LOCAL_CELL", row, col, value: normalized });
      pendingRef.current = { row, col, value: normalized };
      const version = bump();
      send({
        type: "cell_update",
        row,
        col,
        row_id: rowId,
        col_id: colId,
        value: normalized,
        client_id: localId,
        counter: counterRef.current,
        version,
      });
      // 离线兜底：WebSocket 不可用时走 REST，语义完全一致。
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (sheetId) {
          api
            .updateCells(sheetId, [{ row_id: rowId, col_id: colId, value: normalized }], version)
            .catch((err) => notify(String(err.message ?? err)));
        }
      }
    },
    [bump, editable, localId, notify, send],
  );

  /** 把单元格写入目标列表发给服务端（WS 优先，大批量走 REST 分块；不碰本地状态）。 */
  const sendCellTargets = useCallback(
    (payload: api.CellTarget[], pendingKeys: string[], sheetId: string | null) => {
      if (!payload.length) return;
      const version = bump();
      for (const key of pendingKeys) pendingBatchRef.current.add(key);
      // 大批量写入（框选清空 / 大块粘贴 / 撤销回放）：逐格走 WS 消息太多，改走 REST 分块，
      // 服务端同样会应用并把权威投影广播回来。
      if (payload.length > 300) {
        if (sheetId) {
          const CHUNK = 1000;
          for (let i = 0; i < payload.length; i += CHUNK) {
            api
              .updateCells(sheetId, payload.slice(i, i + CHUNK), version)
              .catch((err) => notify(String(err.message ?? err)));
          }
        }
        return;
      }
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        if (sheetId) {
          api.updateCells(sheetId, payload, version).catch((err) => notify(String(err.message ?? err)));
        }
        return;
      }
      for (const item of payload) {
        send({
          type: "cell_update",
          row_id: item.row_id,
          col_id: item.col_id,
          value: item.value,
          client_id: localId,
          version,
        });
      }
    },
    [bump, localId, notify, send],
  );

  const applyCellMap = useCallback(
    (updates: Record<string, string | null>, record = true) => {
      if (!Object.keys(updates).length) return;
      dispatch({ type: "LOCAL_CELLS", updates, record });
      const sheetId = stateRef.current.sheetId;
      const payload: api.CellTarget[] = [];
      const keys: string[] = [];
      for (const [key, value] of Object.entries(updates)) {
        const [row, col] = key.split(":").map(Number);
        keys.push(`${row}:${col}:${value === null ? "" : value}`);
        payload.push({
          row_id: stateRef.current.rowIds[row],
          col_id: stateRef.current.colIds[col],
          value,
        });
      }
      sendCellTargets(payload, keys, sheetId);
    },
    [sendCellTargets],
  );

  const pasteBlock = useCallback(
    (row: number, col: number, text: string) => {
      if (!editable) return;
      const grid = parseClipboardGrid(text);
      if (!grid.length) return;
      const updates: Record<string, string | null> = {};
      grid.forEach((line, dr) => {
        line.forEach((value, dc) => {
          const r = row + dr;
          const c = col + dc;
          if (r < stateRef.current.rows && c < stateRef.current.cols) {
            updates[cellKey(r, c)] = value === "" ? null : value;
          }
        });
      });
      applyCellMap(updates);
    },
    [applyCellMap, editable],
  );

  /** Delete/Backspace：清空选区内的所有单元格（一次记录，可撤销）。 */
  const clearRange = useCallback(
    (r0: number, c0: number, r1: number, c1: number) => {
      if (!editable) return;
      const { rows, cols, cells } = stateRef.current;
      const updates: Record<string, string | null> = {};
      for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) {
          const key = cellKey(r, c);
          if (cells[key] !== undefined && cells[key] !== null && cells[key] !== "") {
            updates[key] = null;
          }
        }
      }
      applyCellMap(updates);
    },
    [applyCellMap, editable],
  );

  /**
   * 把格式套用到**当前选区**（REQ-007）。
   *
   * 之前只作用于活动单元格，选区/整行整列选中时用户会以为"没生效"。
   * 这里对选区内每个单元格合并 partial，一次记录历史、一次广播多条。
   */
  /** 把格式套用到指定范围（默认当前选区）。 */
  const applyFormatToRange = useCallback(
    (partial: Partial<CellFormat>, range?: { r0: number; c0: number; r1: number; c1: number }) => {
      if (!editable) return;
      const { formats, rowIds, colIds } = stateRef.current;
      const { r0, c0, r1, c1 } = range ?? targetRange();
      const updates: Array<{ row: number; col: number; format: CellFormat }> = [];
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          const key = cellKey(r, c);
          const next: CellFormat = { ...(formats[key] ?? {}), ...partial };
          // 全空的格式对象视为"无格式"，避免存一堆空对象
          const meaningful = Object.fromEntries(
            Object.entries(next).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== ""),
          ) as CellFormat;
          updates.push({ row: r, col: c, format: meaningful });
        }
      }
      if (!updates.length) return;

      // 一次性压入历史（整批可撤销）
      const entries = updates.map((u) => ({ row: u.row, col: u.col, format: u.format }));
      dispatch({ type: "LOCAL_FORMATS", entries });

      const version = bump();
      for (const u of updates) {
        send({
          type: "cell_format",
          row: u.row,
          col: u.col,
          row_id: rowIds[u.row],
          col_id: colIds[u.col],
          format: u.format,
          client_id: localId,
          version,
        });
      }
    },
    [bump, editable, localId, send, targetRange],
  );

  /** 兼容旧调用：把格式套用到当前选区。 */
  const applyFormat = useCallback(
    (partial: Partial<CellFormat>) => applyFormatToRange(partial),
    [applyFormatToRange],
  );

  /** 清空指定范围（默认当前选区）的格式。 */
  const clearFormat = useCallback(
    (range?: { r0: number; c0: number; r1: number; c1: number }) => {
      if (!editable) return;
      const { formats, rowIds, colIds } = stateRef.current;
      const { r0, c0, r1, c1 } = range ?? targetRange();
    const entries: Array<{ row: number; col: number; format: CellFormat | null }> = [];
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const key = cellKey(r, c);
        if (formats[key]) entries.push({ row: r, col: c, format: null });
      }
    }
    if (!entries.length) return;
    dispatch({ type: "LOCAL_FORMATS", entries });
    const version = bump();
    for (const entry of entries) {
      send({
        type: "cell_format",
        row: entry.row,
        col: entry.col,
        row_id: rowIds[entry.row],
        col_id: colIds[entry.col],
        format: null,
        client_id: localId,
        version,
      });
    }
  }, [bump, editable, localId, send, targetRange]);

  const toggleStyle = useCallback(
    (key: "bold" | "italic" | "underline" | "strike") => {
      const current =
        stateRef.current.formats[cellKey(stateRef.current.selected.row, stateRef.current.selected.col)] ?? {};
      applyFormat({ [key]: !current[key] } as Partial<CellFormat>);
    },
    [applyFormat],
  );

  /**
   * 结构操作。
   *
   * @param kind 插入/删除行或列
   * @param at 目标位置（默认当前活动格）；右键菜单会指定被点的那一行/列
   */
  const structural = useCallback(
    (kind: "row_insert" | "row_delete" | "col_insert" | "col_delete", at?: number) => {
      if (!editable) return;
      const before = stateRef.current;
      const axisRow = kind.startsWith("row");
      const position = Math.max(
        0,
        Math.min((axisRow ? before.rows : before.cols) - 1, at ?? (axisRow ? before.selected.row : before.selected.col)),
      );
      const elementId = axisRow ? before.rowIds[position] : before.colIds[position];
      // 记录操作前的快照：回执到达时压入撤销栈 → 插入/删除行列可撤销
      structureGuardRef.current = { kind: "op", record: snapshotOf(before) };
      const payload: WsMessage = { type: kind, at: position, client_id: localId, version: bump() };
      if (kind === "row_insert" || kind === "col_insert") {
        counterRef.current += 1;
        payload.counter = counterRef.current;
      } else {
        payload.element_id = elementId;
      }
      send(payload);
    },
    [bump, editable, localId, send],
  );

  const insertRow = useCallback(() => structural("row_insert"), [structural]);
  const deleteRow = useCallback(() => structural("row_delete"), [structural]);
  const insertCol = useCallback(() => structural("col_insert"), [structural]);
  const deleteCol = useCallback(() => structural("col_delete"), [structural]);

  /** 选区跨多行/多列时，右键删除要删掉整个选区（Excel 语义）。 */
  const multiDeleteTargets = useCallback((axis: "row" | "col", at: number) => {
    const { rows, cols, selected, anchor, selectionKind } = stateRef.current;
    const limit = axis === "row" ? rows : cols;
    if (selectionKind === "row" && axis === "row") {
      const from = Math.min(selected.row, anchor.row);
      const to = Math.max(selected.row, anchor.row);
      return Array.from({ length: to - from + 1 }, (_, i) => Math.min(limit - 1, from + i));
    }
    if (selectionKind === "col" && axis === "col") {
      const from = Math.min(selected.col, anchor.col);
      const to = Math.max(selected.col, anchor.col);
      return Array.from({ length: to - from + 1 }, (_, i) => Math.min(limit - 1, from + i));
    }
    return [Math.max(0, Math.min(limit - 1, at))];
  }, []);

  /** 右键菜单：在被点行号的**上方/下方**插入行（下方 = 该行索引 +1）。 */
  const insertRowAt = useCallback(
    (row: number, above = true) => structural("row_insert", above ? row : row + 1),
    [structural],
  );
  /** 删除被点的行；若选区跨多行，则删掉整个选区。 */
  const deleteRowAt = useCallback(
    (row: number) => {
      const items = multiDeleteTargets("row", row);
      // 从后往前删，避免索引位移
      for (const at of [...items].sort((a, b) => b - a)) structural("row_delete", at);
    },
    [multiDeleteTargets, structural],
  );
  const insertColAt = useCallback(
    (col: number, left = true) => structural("col_insert", left ? col : col + 1),
    [structural],
  );
  const deleteColAt = useCallback(
    (col: number) => {
      const items = multiDeleteTargets("col", col);
      for (const at of [...items].sort((a, b) => b - a)) structural("col_delete", at);
    },
    [multiDeleteTargets, structural],
  );

  /**
   * 拖拽填充（REQ-006）。
   *
   * `source` 是含源数据的矩形，`target` 是拖拽到的矩形（两者沿某轴相邻）。
   * 支持序列（等差/日期/数字+文本）、公式相对引用偏移、文本复制，并可同时复制格式。
   */
  const fillRange = useCallback(
    (
      source: { r0: number; c0: number; r1: number; c1: number },
      target: { r0: number; c0: number; r1: number; c1: number },
      options: { series: boolean; format: boolean } = { series: true, format: true },
    ) => {
      if (!editable) return;
      const { rows, cols, cells, formats, rowIds, colIds } = stateRef.current;
      const horizontal = target.c0 !== source.c0 || target.c1 !== source.c1;
      const vertical = target.r0 !== source.r0 || target.r1 !== source.r1;
      if (!horizontal && !vertical) return;

      const clampRow = (r: number) => Math.max(0, Math.min(rows - 1, r));
      const clampCol = (c: number) => Math.max(0, Math.min(cols - 1, c));
      const tr0 = clampRow(Math.min(target.r0, target.r1));
      const tr1 = clampRow(Math.max(target.r0, target.r1));
      const tc0 = clampCol(Math.min(target.c0, target.c1));
      const tc1 = clampCol(Math.max(target.c0, target.c1));

      const updates: Record<string, string | null> = {};
      const formatUpdates: Array<{ row: number; col: number; format: CellFormat | null }> = [];

      // 方向判断必须用**未排序**的目标边界：tr0/tr1 是 min/max 之后的（永远上小下大），
      // 用它去比较会得到 fillDown/fillUp 都为 false（曾经的 bug：填充落空值）
      const fillDown = vertical && target.r1 > source.r1;
      const fillUp = vertical && target.r0 < source.r0;
      const fillRight = horizontal && target.c1 > source.c1;
      const fillLeft = horizontal && target.c0 < source.c0;
      const verticalFill = (fillDown || fillUp) && !horizontal;
      const horizontalFill = (fillRight || fillLeft) && !vertical;

      for (let r = tr0; r <= tr1; r++) {
        for (let c = tc0; c <= tc1; c++) {
          // 目标区里落在源矩形内的格子不动
          if (r >= source.r0 && r <= source.r1 && c >= source.c0 && c <= source.c1) continue;
          let sources: string[] = [];
          let dRowPerStep = 0;
          let dColPerStep = 0;
          if (verticalFill) {
            const col = c;
            const from = fillDown ? source.r0 : source.r1;
            const to = fillDown ? source.r1 : source.r0;
            for (let sr = from; fillDown ? sr <= to : sr >= to; sr = fillDown ? sr + 1 : sr - 1) {
              sources.push(cells[cellKey(sr, col)] ?? (options.series ? "" : ""));
            }
            dRowPerStep = fillDown ? 1 : -1;
          } else {
            const row = r;
            const from = fillRight ? source.c0 : source.c1;
            const to = fillRight ? source.c1 : source.c0;
            for (let sc = from; fillRight ? sc <= to : sc >= to; sc = fillRight ? sc + 1 : sc - 1) {
              sources.push(cells[cellKey(row, sc)] ?? "");
            }
            dColPerStep = fillRight ? 1 : -1;
          }
          // 生成到当前格需要的步数
          const steps = verticalFill
            ? fillDown
              ? r - source.r1
              : source.r0 - r
            : fillRight
              ? c - source.c1
              : source.c0 - c;
          const generated = options.series
            ? fillSeries(sources, steps, verticalFill, dRowPerStep, dColPerStep)
            : [];
          const value = options.series ? (generated[steps - 1] ?? "") : sources[0] ?? "";
          updates[cellKey(r, c)] = value === "" ? null : value;

          if (options.format) {
            // 格式跟随：取源区对应行/列的格式（Excel 的填充柄也会带格式）
            const srcRow = verticalFill ? (fillDown ? source.r1 : source.r0) : r;
            const srcCol = horizontalFill ? (fillRight ? source.c1 : source.c0) : c;
            formatUpdates.push({ row: r, col: c, format: formats[cellKey(srcRow, srcCol)] ?? null });
          }
        }
      }

      if (!Object.keys(updates).length) return;
      applyCellMap(updates);
      if (formatUpdates.length) {
        const meaningful = formatUpdates.filter((item) => item.format && Object.keys(item.format).length);
        if (meaningful.length) {
          dispatch({ type: "LOCAL_FORMATS", entries: meaningful, record: false });
          const version = bump();
          for (const item of meaningful) {
            send({
              type: "cell_format",
              row: item.row,
              col: item.col,
              row_id: rowIds[item.row],
              col_id: colIds[item.col],
              format: item.format,
              client_id: localId,
              version,
            });
          }
        }
      }
    },
    [applyCellMap, bump, dispatch, editable, localId, send],
  );

  /** 把选区序列化为制表符分隔文本（供右键"复制"/"剪切"与状态栏提示）。 */
  const rangeToText = useCallback((range: { r0: number; c0: number; r1: number; c1: number }) => {
    const { cells } = stateRef.current;
    const lines: string[] = [];
    for (let r = range.r0; r <= range.r1; r++) {
      const line: string[] = [];
      for (let c = range.c0; c <= range.c1; c++) line.push(cells[cellKey(r, c)] ?? "");
      lines.push(line.join("\t"));
    }
    return lines.join("\n");
  }, []);

  /** 复制当前选区到系统剪贴板。 */
  const copySelection = useCallback(
    (cut = false) => {
      const range = targetRange();
      const text = rangeToText(range);
      void navigator.clipboard?.writeText(text);
      if (cut && editable) {
        // 剪切：粘贴时清空源区（Excel 语义），这里用 ref 记下来
        cutRangeRef.current = range;
      }
      return text;
    },
    [editable, rangeToText, targetRange],
  );

  /** 计算把 ``target`` 恢复成当前状态所需的单元格写入。 */
  /** 撤销/重做时，把结构迁移到目标快照：先删后插，元素 ID 精确回放（服务端接受显式 ID）。 */
  const sendStructureTransition = useCallback(
    (target: HistoryEntry, mode: "undo" | "redo") => {
      const before = stateRef.current;
      const ops = [
        ...structureDeltas(before.rowIds, target.rowIds, "row"),
        ...structureDeltas(before.colIds, target.colIds, "col"),
      ];
      if (!ops.length) return;
      structureGuardRef.current = { kind: mode, remaining: ops.length };
      for (const op of ops) {
        const msg: WsMessage = { type: op.type, client_id: localId, version: bump() };
        if (op.type === "row_insert" || op.type === "col_insert") {
          counterRef.current += 1;
          msg.counter = counterRef.current;
          msg.at = op.at;
        }
        msg.element_id = op.element_id;
        send(msg);
      }
    },
    [bump, localId, send],
  );

  /** 把格式差异写回服务端（按传入元素 ID 定位，撤销/重做时结构可能已变化）。 */
  const sendFormatTargets = useCallback(
    (updates: Record<string, CellFormat | null>, ids: HistoryEntry) => {
      const sheetId = stateRef.current.sheetId;
      for (const [key, format] of Object.entries(updates)) {
        const [row, col] = key.split(":").map(Number);
        const rowId = ids.rowIds[row];
        const colId = ids.colIds[col];
        if (!rowId || !colId) continue;
        dispatch({ type: "LOCAL_FORMAT", row, col, format: format ?? null, record: false });
        const version = bump();
        send({
          type: "cell_format",
          row,
          col,
          row_id: rowId,
          col_id: colId,
          format: format ?? null,
          client_id: localId,
          version,
        });
        if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
          if (sheetId) {
            api
              .updateFormats(sheetId, [{ row_id: rowId, col_id: colId, format: format ?? null }], version)
              .catch((err) => notify(String(err.message ?? err)));
          }
        }
      }
    },
    [bump, localId, notify, send],
  );

  /**
   * 撤销：恢复到上一个操作前的快照。
   * - 纯值/格式操作：本地回滚 + 差异写回（不再压栈）；
   * - 结构操作：回放逆操作（元素 ID 精确恢复，评论等锚点不会失效），
   *   结构回执到达期间保留撤销栈（structureGuardRef）。
   */
  const undo = useCallback(() => {
    const before = stateRef.current;
    const entry = before.history[before.history.length - 1];
    if (!entry) return;
    const hasStructure =
      entry.rows !== before.rows ||
      entry.cols !== before.cols ||
      !sameIds(entry.rowIds, before.rowIds) ||
      !sameIds(entry.colIds, before.colIds);
    dispatch({ type: "UNDO" });
    if (!hasStructure) {
      const cells = diffCells(before.cells, entry.cells);
      if (Object.keys(cells).length) applyCellMap(cells, false);
      const formats = diffFormats(before.formats, entry.formats);
      if (Object.keys(formats).length) sendFormatTargets(formats, entry);
      return;
    }
    // 结构差异：结构操作先发（回执带权威投影），单元格/格式差异随后按目标元素 ID 写回。
    const payload: api.CellTarget[] = [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(diffCells(before.cells, entry.cells))) {
      const [row, col] = key.split(":").map(Number);
      payload.push({ row_id: entry.rowIds[row], col_id: entry.colIds[col], value });
      keys.push(`${row}:${col}:${value === null ? "" : value}`);
    }
    sendStructureTransition(entry, "undo");
    if (payload.length) sendCellTargets(payload, keys, before.sheetId);
    const formats = diffFormats(before.formats, entry.formats);
    if (Object.keys(formats).length) sendFormatTargets(formats, entry);
  }, [applyCellMap, sendCellTargets, sendFormatTargets, sendStructureTransition]);

  const redo = useCallback(() => {
    const before = stateRef.current;
    const entry = before.future[before.future.length - 1];
    if (!entry) return;
    const hasStructure =
      entry.rows !== before.rows ||
      entry.cols !== before.cols ||
      !sameIds(entry.rowIds, before.rowIds) ||
      !sameIds(entry.colIds, before.colIds);
    dispatch({ type: "REDO" });
    if (!hasStructure) {
      const cells = diffCells(before.cells, entry.cells);
      if (Object.keys(cells).length) applyCellMap(cells, false);
      const formats = diffFormats(before.formats, entry.formats);
      if (Object.keys(formats).length) sendFormatTargets(formats, entry);
      return;
    }
    const payload: api.CellTarget[] = [];
    const keys: string[] = [];
    for (const [key, value] of Object.entries(diffCells(before.cells, entry.cells))) {
      const [row, col] = key.split(":").map(Number);
      payload.push({ row_id: entry.rowIds[row], col_id: entry.colIds[col], value });
      keys.push(`${row}:${col}:${value === null ? "" : value}`);
    }
    sendStructureTransition(entry, "redo");
    if (payload.length) sendCellTargets(payload, keys, before.sheetId);
    const formats = diffFormats(before.formats, entry.formats);
    if (Object.keys(formats).length) sendFormatTargets(formats, entry);
  }, [applyCellMap, sendCellTargets, sendFormatTargets, sendStructureTransition]);

  const freeze = useCallback(() => {
    const { selected } = stateRef.current;
    dispatch({ type: "FREEZE", rows: selected.row + 1, cols: selected.col + 1 });
  }, []);
  const unfreeze = useCallback(() => dispatch({ type: "UNFREEZE" }), []);

  const exportCsv = useCallback(() => {
    const { cells, rows, cols, sheetName } = stateRef.current;
    const csv = cellsToCsv(cells, rows, cols);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${sheetName || "表格"}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, []);

  const importCsv = useCallback(
    async (file: File) => {
      const sheetId = stateRef.current.sheetId;
      if (!sheetId || !editable) return;
      try {
        const text = (await file.text()).replace(/^\ufeff/, "");
        const { rows, cols, cells } = csvToCells(text);
        const updated = await api.importSheet(sheetId, rows, cols, cells, bump());
        dispatch({ type: "LOAD", sheet: updated });
        onSheetChanged?.();
      } catch (err) {
        notify(String((err as Error).message ?? err));
      }
    },
    [bump, editable, notify, onSheetChanged],
  );

  const reload = useCallback(async () => {
    const sheetId = stateRef.current.sheetId;
    if (!sheetId) return;
    try {
      dispatch({ type: "LOADING", loading: true });
      const fresh = await api.getSheet(sheetId);
      dispatch({ type: "LOAD", sheet: fresh });
    } catch (err) {
      notify(String((err as Error).message ?? err));
    } finally {
      dispatch({ type: "LOADING", loading: false });
    }
  }, [notify]);

  return {
    state,
    editable,
    canUndo: state.history.length > 0,
    canRedo: state.future.length > 0,
    select,
    extendSelect,
    selectAll,
    selectRow,
    selectCol,
    targetRange,
    clearRange,
    startEdit,
    startFormulaEdit,
    setDraft,
    cancelEdit,
    commitCell,
    applyFormat,
    applyFormatToRange,
    clearFormat,
    toggleStyle,
    pasteBlock,
    insertRow,
    deleteRow,
    insertCol,
    deleteCol,
    insertRowAt,
    deleteRowAt,
    insertColAt,
    deleteColAt,
    fillRange,
    copySelection,
    undo,
    redo,
    freeze,
    unfreeze,
    exportCsv,
    importCsv,
    reload,
    notify,
    dismissError,
  };
}
