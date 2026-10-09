import { useEffect, useRef } from "react";
import type { CellFormat, Cells, Cursor } from "../types";
import { cellKey, colLabel } from "../lib/gridUtils";
import { evaluate } from "../lib/formula";

interface Props {
  cells: Cells;
  formats: Record<string, CellFormat>;
  rows: number;
  cols: number;
  selected: { row: number; col: number };
  editing: { row: number; col: number } | null;
  draft: string;
  cursors: Record<string, Cursor>;
  frozenRows: number;
  frozenCols: number;
  self: string;
  onSelect: (row: number, col: number) => void;
  onStartEdit: (row: number, col: number, draft: string) => void;
  onDraft: (draft: string) => void;
  onCommit: (row: number, col: number, value: string) => void;
  onCancel: () => void;
  onMove: (row: number, col: number) => void;
}

export default function Grid(props: Props) {
  const { cells, formats, rows, cols, selected, editing, draft, cursors, frozenRows, frozenCols, self } = props;
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const HEADER_H = 24;
  const ROW_H = 24;
  const HEADER_W = 48;
  const CELL_W = 96;

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  function focusShell() {
    shellRef.current?.focus();
  }

  function handleShellKeyDown(e: React.KeyboardEvent) {
    if (editing) return;
    const { row, col } = selected;
    let nr = row;
    let nc = col;

    if (e.key === "ArrowUp") nr = Math.max(0, row - 1);
    else if (e.key === "ArrowDown") nr = Math.min(rows - 1, row + 1);
    else if (e.key === "ArrowLeft") nc = Math.max(0, col - 1);
    else if (e.key === "ArrowRight") nc = Math.min(cols - 1, col + 1);
    else if (e.key === "Enter" || e.key === "F2") {
      const raw = cells[cellKey(row, col)] ?? "";
      props.onStartEdit(row, col, raw);
      return;
    } else if (e.key === "Delete" || e.key === "Backspace") {
      props.onCommit(row, col, "");
      return;
    } else if (e.key === "Tab") {
      e.preventDefault();
      nc = Math.min(cols - 1, col + 1);
    }

    if (nr !== row || nc !== col) {
      e.preventDefault();
      props.onMove(nr, nc);
      focusShell();
    }
  }

  return (
    <div className="grid-shell" ref={shellRef} tabIndex={0} onKeyDown={handleShellKeyDown}>
      <div className="grid-scroll">
        <table className="grid-table">
          <thead>
            <tr>
              <th className="corner"></th>
              {Array.from({ length: cols }).map((_, c) => (
                <th key={c} className="col-head">{colLabel(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: rows }).map((_, r) => (
              <tr key={r}>
                <th className="row-head">{r + 1}</th>
                {Array.from({ length: cols }).map((_, c) => {
                  const key = cellKey(r, c);
                  const isSelected = selected.row === r && selected.col === c;
                  const isEditing = editing?.row === r && editing?.col === c;
                  const remote = Object.values(cursors).find(
                    (cur) => cur.user !== self && cur.row === r && cur.col === c,
                  );
                  const fmt = formats[key];
                  const isFrozenRow = r < frozenRows;
                  const isFrozenCol = c < frozenCols;
                  const style: React.CSSProperties = {
                    fontWeight: fmt?.bold ? 700 : undefined,
                    fontStyle: fmt?.italic ? "italic" : undefined,
                    textDecoration: fmt?.underline ? "underline" : undefined,
                    color: fmt?.color || undefined,
                    backgroundColor: fmt?.bg || undefined,
                    textAlign: fmt?.align || undefined,
                  };
                  if (isFrozenRow) {
                    style.position = "sticky";
                    style.top = `${HEADER_H + r * ROW_H}px`;
                    style.zIndex = 1;
                    style.backgroundColor = fmt?.bg || "#ffffff";
                  }
                  if (isFrozenCol) {
                    style.position = "sticky";
                    style.left = `${HEADER_W + c * CELL_W}px`;
                    style.zIndex = 1;
                    style.backgroundColor = fmt?.bg || "#ffffff";
                  }
                  return (
                    <td
                      key={key}
                      style={style}
                      className={`cell${isSelected ? " selected" : ""}${remote ? " remote" : ""}`}
                      onClick={() => {
                        props.onSelect(r, c);
                        focusShell();
                      }}
                      onDoubleClick={() => {
                        const raw = cells[key] ?? "";
                        props.onStartEdit(r, c, raw);
                      }}
                    >
                      {isEditing ? (
                        <input
                          ref={inputRef}
                          className="cell-input"
                          value={draft}
                          onChange={(e) => props.onDraft(e.target.value)}
                          onBlur={() => props.onCommit(r, c, draft)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              props.onCommit(r, c, draft);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              props.onCancel();
                            }
                          }}
                        />
                      ) : (
                        <span>{evaluate(cells[key] ?? null, cells)}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
