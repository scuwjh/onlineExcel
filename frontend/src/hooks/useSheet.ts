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
import { cellsToCsv, csvToCells, parseClipboardGrid } from "../lib/csv";
import type { CellFormat, Cells, Cursor, Role, SheetData } from "../types";
import { DEFAULT_COLS, DEFAULT_ROWS } from "../types";
import { connectWS, type WsClient, type WsMessage } from "../ws";

export interface SheetState {
  sheetId: string | null;
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
  selected: { row: number; col: number };
  editing: { row: number; col: number } | null;
  draft: string;
  users: Record<string, boolean>;
  cursors: Record<string, Cursor>;
  frozenRows: number;
  frozenCols: number;
  history: Cells[];
  future: Cells[];
  status: "connecting" | "open" | "closed";
  error: string | null;
  loading: boolean;
}

type Action =
  | { type: "LOAD"; sheet: SheetData }
  | { type: "SELECT"; row: number; col: number }
  | { type: "START_EDIT"; row: number; col: number; draft: string }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "CANCEL_EDIT" }
  | { type: "LOCAL_CELL"; row: number; col: number; value: string | null; record?: boolean }
  | { type: "LOCAL_CELLS"; updates: Record<string, string | null>; record?: boolean }
  | { type: "REMOTE_CELL"; row: number; col: number; value: string | null; cells?: Cells; version?: number; seq?: number }
  | { type: "REMOTE_FORMAT"; row: number; col: number; format: CellFormat | null; formats?: Record<string, CellFormat> }
  | { type: "LOCAL_FORMAT"; row: number; col: number; format: CellFormat }
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
  editing: null,
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

function pushHistory(state: SheetState, cells: Cells): Cells[] {
  return [...state.history, cells].slice(-HISTORY_LIMIT);
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
      return { ...state, selected: { row: action.row, col: action.col }, editing: null };
    case "START_EDIT":
      return {
        ...state,
        selected: { row: action.row, col: action.col },
        editing: { row: action.row, col: action.col },
        draft: action.draft,
      };
    case "SET_DRAFT":
      return { ...state, draft: action.draft };
    case "CANCEL_EDIT":
      return { ...state, editing: null };
    case "LOCAL_CELL": {
      const key = cellKey(action.row, action.col);
      const record = action.record !== false;
      return {
        ...state,
        cells: { ...state.cells, [key]: action.value },
        editing: null,
        history: record ? pushHistory(state, state.cells) : state.history,
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
        history: record ? pushHistory(state, state.cells) : state.history,
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
      return { ...state, formats: { ...state.formats, [key]: action.format } };
    }
    case "REMOTE_STRUCTURE":
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
        history: [],
        future: [],
      };
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
        cells: prev,
        history: state.history.slice(0, -1),
        future: [...state.future, state.cells].slice(-HISTORY_LIMIT),
        editing: null,
      };
    }
    case "REDO": {
      if (state.future.length === 0) return state;
      const next = state.future[state.future.length - 1];
      return {
        ...state,
        cells: next,
        future: state.future.slice(0, -1),
        history: pushHistory(state, state.cells),
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

export interface UseSheetResult {
  state: SheetState;
  editable: boolean;
  canUndo: boolean;
  canRedo: boolean;
  select: (row: number, col: number) => void;
  startEdit: (row: number, col: number, draft: string) => void;
  setDraft: (draft: string) => void;
  cancelEdit: () => void;
  commitCell: (row: number, col: number, value: string) => void;
  applyFormat: (partial: Partial<CellFormat>) => void;
  toggleStyle: (key: "bold" | "italic" | "underline") => void;
  pasteBlock: (row: number, col: number, text: string) => void;
  insertRow: () => void;
  deleteRow: () => void;
  insertCol: () => void;
  deleteCol: () => void;
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

export function useSheet(sheet: SheetData | null, onSheetChanged?: () => void): UseSheetResult {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WsClient | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
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

  const loadedSheetRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sheet) {
      dispatch({ type: "LOADING", loading: false });
      return;
    }
    // 只在"换了表格"时整体重载。
    // 父组件在每次写入后都会重新拉取同一张表（refreshList/reloadSheet），
    // 若按对象标识重载，会把本地撤销栈和乐观状态一起清掉。
    if (loadedSheetRef.current === sheet.id) {
      dispatch({ type: "LOADING", loading: false });
      return;
    }
    loadedSheetRef.current = sheet.id;
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
        case "sheet_import":
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
          });
          break;
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

  const startEdit = useCallback(
    (row: number, col: number, draft: string) => {
      if (!editable) return;
      dispatch({ type: "START_EDIT", row, col, draft });
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

  const applyCellMap = useCallback(
    (updates: Record<string, string | null>, record = true) => {
      if (!Object.keys(updates).length) return;
      dispatch({ type: "LOCAL_CELLS", updates, record });
      const sheetId = stateRef.current.sheetId;
      const version = bump();
      const payload: api.CellTarget[] = Object.entries(updates).map(([key, value]) => {
        const [row, col] = key.split(":").map(Number);
        pendingBatchRef.current.add(`${row}:${col}:${value === null ? "" : value}`);
        return {
          row_id: stateRef.current.rowIds[row],
          col_id: stateRef.current.colIds[col],
          value,
        };
      });
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

  const applyFormat = useCallback(
    (partial: Partial<CellFormat>) => {
      if (!editable) return;
      const { selected, formats, rowIds, colIds } = stateRef.current;
      const key = cellKey(selected.row, selected.col);
      const next: CellFormat = { ...(formats[key] ?? {}), ...partial };
      dispatch({ type: "LOCAL_FORMAT", row: selected.row, col: selected.col, format: next });
      const version = bump();
      send({
        type: "cell_format",
        row: selected.row,
        col: selected.col,
        row_id: rowIds[selected.row],
        col_id: colIds[selected.col],
        format: next,
        client_id: localId,
        version,
      });
    },
    [bump, editable, localId, send],
  );

  const toggleStyle = useCallback(
    (key: "bold" | "italic" | "underline") => {
      const current =
        stateRef.current.formats[cellKey(stateRef.current.selected.row, stateRef.current.selected.col)] ?? {};
      applyFormat({ [key]: !current[key] } as Partial<CellFormat>);
    },
    [applyFormat],
  );

  const structural = useCallback(
    (kind: "row_insert" | "row_delete" | "col_insert" | "col_delete") => {
      if (!editable) return;
      const { selected, rowIds, colIds } = stateRef.current;
      const axisRow = kind.startsWith("row");
      const at = axisRow ? selected.row : selected.col;
      const elementId = axisRow ? rowIds[at] : colIds[at];
      const payload: WsMessage = { type: kind, at, client_id: localId, version: bump() };
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

  /** 计算把 ``target`` 恢复成当前状态所需的单元格写入。 */
  const restoreTargets = useCallback((target: Cells): Record<string, string | null> => {
    const { cells, rowIds, colIds } = stateRef.current;
    const updates: Record<string, string | null> = {};
    for (let r = 0; r < rowIds.length; r++) {
      for (let c = 0; c < colIds.length; c++) {
        const key = cellKey(r, c);
        const before = target[key] ?? null;
        const now = cells[key] ?? null;
        if (before !== now) updates[key] = before;
      }
    }
    return updates;
  }, []);

  const undo = useCallback(() => {
    const { history } = stateRef.current;
    if (!history.length) return;
    const updates = restoreTargets(history[history.length - 1]);
    dispatch({ type: "UNDO" });
    // 回写不再压栈，避免撤销本身又被记录成一次可撤销的操作
    if (Object.keys(updates).length) applyCellMap(updates, false);
  }, [applyCellMap, restoreTargets]);

  const redo = useCallback(() => {
    const { future } = stateRef.current;
    if (!future.length) return;
    const updates = restoreTargets(future[future.length - 1]);
    dispatch({ type: "REDO" });
    if (Object.keys(updates).length) applyCellMap(updates, false);
  }, [applyCellMap, restoreTargets]);

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
    startEdit,
    setDraft,
    cancelEdit,
    commitCell,
    applyFormat,
    toggleStyle,
    pasteBlock,
    insertRow,
    deleteRow,
    insertCol,
    deleteCol,
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
