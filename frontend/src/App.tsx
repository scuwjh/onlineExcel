import { useEffect, useMemo, useReducer, useRef } from "react";
import type { CellFormat, Cells, Cursor, SheetData } from "./types";
import { DEFAULT_COLS, DEFAULT_ROWS } from "./types";
import { cellKey, transformGrid } from "./lib/gridUtils";
import { createSheet, getSheet, importSheet, listSheets, updateCells } from "./api";
import { connectWS, send, type WsMessage } from "./ws";
import { cellsToCsv, csvToCells } from "./lib/csv";
import Grid from "./components/Grid";
import FormulaBar from "./components/FormulaBar";
import Toolbar from "./components/Toolbar";
import PresenceBar from "./components/PresenceBar";

interface State {
  sheets: Array<{ id: string; name: string }>;
  sheetId: string | null;
  sheetName: string;
  cells: Cells;
  formats: Record<string, CellFormat>;
  rows: number;
  cols: number;
  version: number;
  selected: { row: number; col: number };
  editing: { row: number; col: number } | null;
  draft: string;
  users: Record<string, boolean>;
  cursors: Record<string, Cursor>;
  frozenRows: number;
  frozenCols: number;
  history: Cells[];
  future: Cells[];
  error: string | null;
}

type Action =
  | { type: "LOAD_SHEET"; sheet: SheetData }
  | { type: "SET_SHEETS"; sheets: State["sheets"] }
  | { type: "SELECT"; row: number; col: number }
  | { type: "START_EDIT"; row: number; col: number; draft: string }
  | { type: "SET_DRAFT"; draft: string }
  | { type: "COMMIT"; row: number; col: number; value: string | null }
  | { type: "APPLY_REMOTE_CELL"; row: number; col: number; value: string | null; version?: number }
  | { type: "APPLY_FORMAT"; row: number; col: number; format: CellFormat | null }
  | { type: "APPLY_REMOTE_FORMAT"; row: number; col: number; format: CellFormat | null }
  | { type: "INSERT_ROW"; at: number; fromRemote?: boolean }
  | { type: "DELETE_ROW"; at: number; fromRemote?: boolean }
  | { type: "INSERT_COL"; at: number; fromRemote?: boolean }
  | { type: "DELETE_COL"; at: number; fromRemote?: boolean }
  | { type: "CANCEL_EDIT" }
  | { type: "UNDO" }
  | { type: "REDO" }
  | { type: "SET_CURSOR"; cursor: Cursor }
  | { type: "SET_PRESENCE"; user: string; online: boolean }
  | { type: "FREEZE"; rows: number; cols: number }
  | { type: "UNFREEZE" }
  | { type: "RELOAD_SHEET"; sheet: SheetData }
  | { type: "SET_ERROR"; error: string };

const initialState: State = {
  sheets: [],
  sheetId: null,
  sheetName: "",
  cells: {},
  formats: {},
  rows: DEFAULT_ROWS,
  cols: DEFAULT_COLS,
  version: 0,
  selected: { row: 0, col: 0 },
  editing: null,
  draft: "",
  users: {},
  cursors: {},
  frozenRows: 0,
  frozenCols: 0,
  history: [],
  future: [],
  error: null,
};

function shiftSelected(selected: { row: number; col: number }, kind: string, at: number) {
  const s = { ...selected };
  if (kind === "INSERT_ROW" && s.row >= at) s.row += 1;
  if (kind === "DELETE_ROW" && s.row > at) s.row -= 1;
  if (kind === "DELETE_ROW" && s.row === at) s.row = Math.max(0, at - 1);
  if (kind === "INSERT_COL" && s.col >= at) s.col += 1;
  if (kind === "DELETE_COL" && s.col > at) s.col -= 1;
  if (kind === "DELETE_COL" && s.col === at) s.col = Math.max(0, at - 1);
  return s;
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case "LOAD_SHEET":
      return {
        ...state,
        sheetId: action.sheet.id,
        sheetName: action.sheet.name,
        cells: action.sheet.cells,
        formats: action.sheet.formats,
        rows: action.sheet.rows,
        cols: action.sheet.cols,
        version: action.sheet.version,
        editing: null,
        history: [],
        future: [],
        users: {},
        cursors: {},
      };
    case "SET_SHEETS":
      return { ...state, sheets: action.sheets };
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
    case "COMMIT": {
      const key = cellKey(action.row, action.col);
      return {
        ...state,
        cells: { ...state.cells, [key]: action.value },
        editing: null,
        history: [...state.history, state.cells].slice(-50),
        future: [],
      };
    }
    case "APPLY_REMOTE_CELL": {
      const key = cellKey(action.row, action.col);
      return {
        ...state,
        cells: { ...state.cells, [key]: action.value },
        version: action.version ?? state.version,
      };
    }
    case "APPLY_FORMAT": {
      const key = cellKey(action.row, action.col);
      const formats = { ...state.formats };
      if (action.format) formats[key] = action.format;
      else delete formats[key];
      return { ...state, formats, history: [], future: [] };
    }
    case "APPLY_REMOTE_FORMAT": {
      const key = cellKey(action.row, action.col);
      const formats = { ...state.formats };
      if (action.format) formats[key] = action.format;
      else delete formats[key];
      return { ...state, formats };
    }
    case "INSERT_ROW":
      return {
        ...state,
        cells: transformGrid(state.cells, (r, c) => (r >= action.at ? { row: r + 1, col: c } : { row: r, col: c })),
        formats: transformGrid(state.formats, (r, c) => (r >= action.at ? { row: r + 1, col: c } : { row: r, col: c })),
        rows: state.rows + 1,
        selected: shiftSelected(state.selected, "INSERT_ROW", action.at),
        history: action.fromRemote ? state.history : [],
        future: [],
      };
    case "DELETE_ROW":
      return {
        ...state,
        cells: transformGrid(state.cells, (r, c) => (r === action.at ? null : r > action.at ? { row: r - 1, col: c } : { row: r, col: c })),
        formats: transformGrid(state.formats, (r, c) => (r === action.at ? null : r > action.at ? { row: r - 1, col: c } : { row: r, col: c })),
        rows: Math.max(1, state.rows - 1),
        selected: shiftSelected(state.selected, "DELETE_ROW", action.at),
        history: action.fromRemote ? state.history : [],
        future: [],
      };
    case "INSERT_COL":
      return {
        ...state,
        cells: transformGrid(state.cells, (r, c) => (c >= action.at ? { row: r, col: c + 1 } : { row: r, col: c })),
        formats: transformGrid(state.formats, (r, c) => (c >= action.at ? { row: r, col: c + 1 } : { row: r, col: c })),
        cols: state.cols + 1,
        selected: shiftSelected(state.selected, "INSERT_COL", action.at),
        history: action.fromRemote ? state.history : [],
        future: [],
      };
    case "DELETE_COL":
      return {
        ...state,
        cells: transformGrid(state.cells, (r, c) => (c === action.at ? null : c > action.at ? { row: r, col: c - 1 } : { row: r, col: c })),
        formats: transformGrid(state.formats, (r, c) => (c === action.at ? null : c > action.at ? { row: r, col: c - 1 } : { row: r, col: c })),
        cols: Math.max(1, state.cols - 1),
        selected: shiftSelected(state.selected, "DELETE_COL", action.at),
        history: action.fromRemote ? state.history : [],
        future: [],
      };
    case "CANCEL_EDIT":
      return { ...state, editing: null };
    case "UNDO": {
      if (state.history.length === 0) return state;
      const prev = state.history[state.history.length - 1];
      return {
        ...state,
        cells: prev,
        history: state.history.slice(0, -1),
        future: [...state.future, state.cells].slice(-50),
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
        history: [...state.history, state.cells].slice(-50),
        editing: null,
      };
    }
    case "SET_CURSOR":
      return { ...state, cursors: { ...state.cursors, [action.cursor.user]: action.cursor } };
    case "SET_PRESENCE":
      return { ...state, users: { ...state.users, [action.user]: action.online } };
    case "FREEZE":
      return { ...state, frozenRows: action.rows, frozenCols: action.cols };
    case "UNFREEZE":
      return { ...state, frozenRows: 0, frozenCols: 0 };
    case "RELOAD_SHEET":
      return {
        ...state,
        cells: action.sheet.cells,
        formats: action.sheet.formats,
        rows: action.sheet.rows,
        cols: action.sheet.cols,
        version: action.sheet.version,
        editing: null,
        history: [],
        future: [],
      };
    case "SET_ERROR":
      return { ...state, error: action.error };
    default:
      return state;
  }
}

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;

  const userName = useMemo(() => {
    const saved = window.localStorage.getItem("oe-user");
    if (saved) return saved;
    const u = `用户${Math.floor(1000 + Math.random() * 9000)}`;
    window.localStorage.setItem("oe-user", u);
    return u;
  }, []);

  useEffect(() => {
    (async () => {
      try {
        let sheets = await listSheets();
        if (sheets.length === 0) {
          await createSheet("未命名表格");
          sheets = await listSheets();
        }
        const sheet = await getSheet(sheets[0].id);
        dispatch({ type: "LOAD_SHEET", sheet });
        dispatch({ type: "SET_SHEETS", sheets });
      } catch (err) {
        dispatch({ type: "SET_ERROR", error: String(err) });
      }
    })();
  }, []);

  useEffect(() => {
    if (!state.sheetId) return;
    const { socket, close } = connectWS(state.sheetId, userName, {
      onMessage: (msg) => {
        if (msg.type === "cell_update") {
          dispatch({
            type: "APPLY_REMOTE_CELL",
            row: msg.row as number,
            col: msg.col as number,
            value: (msg.value as string | null) ?? null,
            version: msg.version as number | undefined,
          });
        } else if (msg.type === "cell_format") {
          dispatch({
            type: "APPLY_REMOTE_FORMAT",
            row: msg.row as number,
            col: msg.col as number,
            format: (msg.format as CellFormat | null) ?? null,
          });
        } else if (msg.type === "row_insert" && msg.user !== userName) {
          dispatch({ type: "INSERT_ROW", at: msg.at as number, fromRemote: true });
        } else if (msg.type === "row_delete" && msg.user !== userName) {
          dispatch({ type: "DELETE_ROW", at: msg.at as number, fromRemote: true });
        } else if (msg.type === "col_insert" && msg.user !== userName) {
          dispatch({ type: "INSERT_COL", at: msg.at as number, fromRemote: true });
        } else if (msg.type === "col_delete" && msg.user !== userName) {
          dispatch({ type: "DELETE_COL", at: msg.at as number, fromRemote: true });
        } else if (msg.type === "cursor") {
          dispatch({
            type: "SET_CURSOR",
            cursor: { user: msg.user as string, row: msg.row as number, col: msg.col as number },
          });
        } else if (msg.type === "presence") {
          dispatch({ type: "SET_PRESENCE", user: msg.user as string, online: msg.online as boolean });
        } else if (msg.type === "sheet_import" && msg.user !== userName) {
          const sid = stateRef.current.sheetId;
          if (sid) {
            getSheet(sid)
              .then((sheet) => dispatch({ type: "RELOAD_SHEET", sheet }))
              .catch((e) => console.error(e));
          }
        }
      },
      onClose: () => {
        wsRef.current = null;
      },
    });
    wsRef.current = socket;
    return close;
  }, [state.sheetId, userName]);

  function sendWs(msg: WsMessage) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      send(ws, msg);
    }
  }

  function commitCell(row: number, col: number, value: string) {
    const key = cellKey(row, col);
    const prev = stateRef.current.cells[key] ?? null;
    const normalized: string | null = value === "" ? null : value;
    if (prev === normalized) {
      dispatch({ type: "CANCEL_EDIT" });
      return;
    }
    dispatch({ type: "COMMIT", row, col, value: normalized });
    const ws = wsRef.current;
    const sheetId = stateRef.current.sheetId;
    if (ws && ws.readyState === WebSocket.OPEN) {
      sendWs({ type: "cell_update", row, col, value: normalized, user: userName });
    } else if (sheetId) {
      updateCells(sheetId, [{ row, col, value: normalized }], userName).catch((e) => console.error(e));
    }
  }

  function commitSelected() {
    const s = stateRef.current;
    commitCell(s.selected.row, s.selected.col, s.draft);
  }

  function moveTo(row: number, col: number) {
    dispatch({ type: "SELECT", row, col });
    sendWs({ type: "cursor", row, col, user: userName });
  }

  function applyFormat(partial: Partial<CellFormat>) {
    const s = stateRef.current;
    const key = cellKey(s.selected.row, s.selected.col);
    const current = s.formats[key] ?? {};
    const next: CellFormat = { ...current, ...partial };
    dispatch({ type: "APPLY_FORMAT", row: s.selected.row, col: s.selected.col, format: next });
    sendWs({ type: "cell_format", row: s.selected.row, col: s.selected.col, format: next, user: userName });
  }

  function toggleStyle(key: "bold" | "italic" | "underline") {
    const s = stateRef.current;
    const current = s.formats[cellKey(s.selected.row, s.selected.col)] ?? {};
    const partial: Partial<CellFormat> = {};
    partial[key] = !current[key];
    applyFormat(partial);
  }

  function rowOp(kind: "INSERT_ROW" | "DELETE_ROW") {
    const s = stateRef.current;
    const at = s.selected.row;
    if (kind === "INSERT_ROW") {
      dispatch({ type: "INSERT_ROW", at });
      sendWs({ type: "row_insert", at, user: userName });
    } else {
      dispatch({ type: "DELETE_ROW", at });
      sendWs({ type: "row_delete", at, user: userName });
    }
  }

  function colOp(kind: "INSERT_COL" | "DELETE_COL") {
    const s = stateRef.current;
    const at = s.selected.col;
    if (kind === "INSERT_COL") {
      dispatch({ type: "INSERT_COL", at });
      sendWs({ type: "col_insert", at, user: userName });
    } else {
      dispatch({ type: "DELETE_COL", at });
      sendWs({ type: "col_delete", at, user: userName });
    }
  }

  async function newSheet() {
    try {
      const created = await createSheet("未命名表格");
      const sheet = await getSheet(created.id);
      dispatch({ type: "LOAD_SHEET", sheet });
      dispatch({ type: "SET_SHEETS", sheets: await listSheets() });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: String(err) });
    }
  }

  function exportCsv() {
    const s = stateRef.current;
    const csv = cellsToCsv(s.cells, s.rows, s.cols);
    const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${s.sheetName || "表格"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importCsvFile(file: File) {
    const s = stateRef.current;
    if (!s.sheetId) return;
    try {
      const text = (await file.text()).replace(/^\ufeff/, "");
      const { rows, cols, cells } = csvToCells(text);
      const sheet = await importSheet(s.sheetId, rows, cols, cells, userName);
      dispatch({ type: "LOAD_SHEET", sheet });
      sendWs({ type: "sheet_import", user: userName });
    } catch (err) {
      dispatch({ type: "SET_ERROR", error: String(err) });
    }
  }

  function freezePane() {
    const s = stateRef.current;
    dispatch({ type: "FREEZE", rows: s.selected.row + 1, cols: s.selected.col + 1 });
  }

  const selectedKey = cellKey(state.selected.row, state.selected.col);
  const rawValue = state.editing ? state.draft : (state.cells[selectedKey] ?? "");
  const selectedFormat = state.formats[selectedKey] ?? {};

  return (
    <div className="app">
      <Toolbar
        canUndo={state.history.length > 0}
        canRedo={state.future.length > 0}
        onUndo={() => dispatch({ type: "UNDO" })}
        onRedo={() => dispatch({ type: "REDO" })}
        onNewSheet={newSheet}
        sheetName={state.sheetName}
        format={selectedFormat}
        onToggleStyle={toggleStyle}
        onAlign={(align) => applyFormat({ align })}
        onColor={(kind, color) => applyFormat(kind === "color" ? { color } : { bg: color })}
        onInsertRow={() => rowOp("INSERT_ROW")}
        onDeleteRow={() => rowOp("DELETE_ROW")}
        onInsertCol={() => colOp("INSERT_COL")}
        onDeleteCol={() => colOp("DELETE_COL")}
        onImport={importCsvFile}
        onExport={exportCsv}
        frozen={state.frozenRows > 0 || state.frozenCols > 0}
        onFreeze={freezePane}
        onUnfreeze={() => dispatch({ type: "UNFREEZE" })}
      />
      <FormulaBar
        selected={state.selected}
        rawValue={rawValue}
        onStart={() =>
          dispatch({
            type: "START_EDIT",
            row: state.selected.row,
            col: state.selected.col,
            draft: state.cells[selectedKey] ?? "",
          })
        }
        onDraft={(draft) => dispatch({ type: "SET_DRAFT", draft })}
        onCommit={commitSelected}
        onCancel={() => dispatch({ type: "CANCEL_EDIT" })}
      />
      <PresenceBar users={state.users} cursors={state.cursors} self={userName} />
      {state.error && <div className="error">{state.error}</div>}
      {state.sheetId ? (
        <Grid
          cells={state.cells}
          formats={state.formats}
          rows={state.rows}
          cols={state.cols}
          selected={state.selected}
          editing={state.editing}
          draft={state.draft}
          cursors={state.cursors}
          frozenRows={state.frozenRows}
          frozenCols={state.frozenCols}
          self={userName}
          onSelect={moveTo}
          onStartEdit={(row, col, draft) => dispatch({ type: "START_EDIT", row, col, draft })}
          onDraft={(draft) => dispatch({ type: "SET_DRAFT", draft })}
          onCommit={commitCell}
          onCancel={() => dispatch({ type: "CANCEL_EDIT" })}
          onMove={moveTo}
        />
      ) : (
        <div className="loading">加载中…</div>
      )}
    </div>
  );
}
