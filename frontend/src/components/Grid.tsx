/**
 * 虚拟滚动网格（div + sticky，取代上万单元格的完整 <table>）。
 *
 * 渲染策略
 * --------
 * - 只渲染可视窗口内的行列，DOM 节点数恒定（≈ 可视单元格数 + 冻结列）；
 * - 滚动高度由虚拟空间撑开，"占位条"补足左右/上下未渲染区域；
 * - 冻结行列用 ``position: sticky``：冻结列 ``left`` 固定，冻结行/表头
 *   ``top`` 固定，非冻结行按 ``top = 表头高 + 累计偏移 - scrollTop`` 定位。
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CellFormat, Cells, Cursor } from "../types";
import { COL_W, HEADER_H, ROW_H, ROW_HEAD_W } from "../types";
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
  readOnly: boolean;
  onSelect: (row: number, col: number) => void;
  onStartEdit: (row: number, col: number, draft: string) => void;
  onDraft: (draft: string) => void;
  onCommit: (row: number, col: number, value: string) => void;
  onCancel: () => void;
  onMove: (row: number, col: number) => void;
  onPaste: (row: number, col: number, text: string) => void;
  onUndo: () => void;
  onRedo: () => void;
}

interface ViewWindow {
  rowStart: number;
  rowEnd: number;
  colStart: number;
  colEnd: number;
  scrollTop: number;
  scrollLeft: number;
}

const OVERSCAN_ROWS = 8;
const OVERSCAN_COLS = 3;

export default function Grid(props: Props) {
  const {
    cells,
    formats,
    rows,
    cols,
    selected,
    editing,
    draft,
    cursors,
    frozenRows,
    frozenCols,
    self,
    readOnly,
  } = props;

  const scrollRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const committedRef = useRef(false);
  const [view, setView] = useState<ViewWindow>({
    rowStart: 0,
    rowEnd: 40,
    colStart: 0,
    colEnd: 20,
    scrollTop: 0,
    scrollLeft: 0,
  });
  const [size, setSize] = useState({ width: 900, height: 500 });

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const width = el.clientWidth;
    const height = el.clientHeight;
    const scrollTop = el.scrollTop;
    const scrollLeft = el.scrollLeft;

    setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));

    setView((prev) => {
      const usableHeight = Math.max(ROW_H, height - HEADER_H - frozenRows * ROW_H);
      const usableWidth = Math.max(COL_W, width - ROW_HEAD_W - frozenCols * COL_W);
      const rowStart = Math.max(frozenRows, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS);
      const rowEnd = Math.min(rows, rowStart + Math.ceil(usableHeight / ROW_H) + OVERSCAN_ROWS * 2);
      const colStart = Math.max(frozenCols, Math.floor(scrollLeft / COL_W) - OVERSCAN_COLS);
      const colEnd = Math.min(cols, colStart + Math.ceil(usableWidth / COL_W) + OVERSCAN_COLS * 2);
      if (
        prev.rowStart === rowStart &&
        prev.rowEnd === rowEnd &&
        prev.colStart === colStart &&
        prev.colEnd === colEnd &&
        prev.scrollTop === scrollTop &&
        prev.scrollLeft === scrollLeft
      ) {
        return prev;
      }
      return { rowStart, rowEnd, colStart, colEnd, scrollTop, scrollLeft };
    });
  }, [rows, cols, frozenRows, frozenCols]);

  useLayoutEffect(() => {
    measure();
    const el = scrollRef.current;
    if (!el) return;
    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(() => measure());
      observer.observe(el);
      return () => observer.disconnect();
    }
    const onResize = () => measure();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [measure]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      return;
    }
    // 编辑结束后把键盘焦点还给网格：否则 Ctrl+Z / 方向键等快捷键会全部失效
    // （此时 activeElement 已随输入框卸载回到 body）。
    if (!committedRef.current) focusShellRef.current?.();
  }, [editing]);

  const focusShell = useCallback(() => shellRef.current?.focus(), []);
  const focusShellRef = useRef(focusShell);
  focusShellRef.current = focusShell;

  /**
   * 进入编辑态。
   *
   * 编辑输入框是网格级别的"单例浮层"（见下方 editing 浮层渲染），不会被虚拟窗口的
   * 增删重排卸载，因此连续快速输入不会丢字符——这是把输入框放进单元格本身时踩过的坑。
   */
  const beginEdit = useCallback(
    (row: number, col: number, draftText: string) => {
      props.onStartEdit(row, col, draftText);
    },
    [props],
  );

  const visibleRows = useMemo(() => {
    const out: number[] = [];
    for (let r = view.rowStart; r < view.rowEnd; r++) out.push(r);
    return out;
  }, [view.rowStart, view.rowEnd]);

  const visibleCols = useMemo(() => {
    const out: number[] = [];
    for (let c = view.colStart; c < view.colEnd; c++) out.push(c);
    return out;
  }, [view.colStart, view.colEnd]);

  const scrollIntoView = useCallback((row: number, col: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const rowTop = row * ROW_H;
    const rowBottom = rowTop + ROW_H;
    const viewTop = el.scrollTop;
    const viewBottom = viewTop + el.clientHeight - HEADER_H;
    if (rowBottom > viewBottom) el.scrollTop = rowBottom - el.clientHeight + HEADER_H;
    else if (rowTop < viewTop) el.scrollTop = rowTop;

    const colLeft = col * COL_W;
    const colRight = colLeft + COL_W;
    const viewLeft = el.scrollLeft;
    const viewRight = viewLeft + el.clientWidth - ROW_HEAD_W;
    if (colRight > viewRight) el.scrollLeft = colRight - el.clientWidth + ROW_HEAD_W;
    else if (colLeft < viewLeft) el.scrollLeft = colLeft;
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const { row, col } = selected;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "z") {
          e.preventDefault();
          if (e.shiftKey) props.onRedo();
          else props.onUndo();
          return;
        }
        if (key === "y") {
          e.preventDefault();
          props.onRedo();
          return;
        }
        if (key === "c") {
          e.preventDefault();
          void navigator.clipboard?.writeText(cells[cellKey(row, col)] ?? "");
          return;
        }
        if (key === "v") {
          e.preventDefault();
          void navigator.clipboard?.readText().then((text) => {
            if (text) props.onPaste(row, col, text);
          });
          return;
        }
        return;
      }

      let nr = row;
      let nc = col;
      const pageRows = Math.max(1, Math.floor((size.height - HEADER_H) / ROW_H) - 1);
      switch (e.key) {
        case "ArrowUp":
          nr = Math.max(0, row - 1);
          break;
        case "ArrowDown":
          nr = Math.min(rows - 1, row + 1);
          break;
        case "ArrowLeft":
          nc = Math.max(0, col - 1);
          break;
        case "ArrowRight":
          nc = Math.min(cols - 1, col + 1);
          break;
        case "PageDown":
          nr = Math.min(rows - 1, row + pageRows);
          break;
        case "PageUp":
          nr = Math.max(0, row - pageRows);
          break;
        case "Home":
          nc = 0;
          break;
        case "End":
          nc = cols - 1;
          break;
        case "Enter":
        case "F2":
          e.preventDefault();
          if (!readOnly) beginEdit(row, col, cells[cellKey(row, col)] ?? "");
          return;
        case "Delete":
        case "Backspace":
          e.preventDefault();
          if (!readOnly) props.onCommit(row, col, "");
          return;
        case "Tab": {
          e.preventDefault();
          const target = e.shiftKey ? Math.max(0, col - 1) : Math.min(cols - 1, col + 1);
          props.onMove(row, target);
          scrollIntoView(row, target);
          focusShell();
          return;
        }
        default:
          if (e.key.length === 1 && !e.altKey && !readOnly) {
            e.preventDefault();
            beginEdit(row, col, e.key);
            return;
          }
          return;
      }

      e.preventDefault();
      if (nr !== row || nc !== col) {
        props.onMove(nr, nc);
        scrollIntoView(nr, nc);
      }
      focusShell();
    },
    [selected, cells, rows, cols, readOnly, props, size.height, scrollIntoView, focusShell, beginEdit],
  );

  // 事件委托：整表一个处理器，避免每个单元格各带闭包。
  const cellFromEvent = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest("[data-cell]") as HTMLElement | null;
    if (!target) return null;
    const row = Number(target.dataset.row);
    const col = Number(target.dataset.col);
    if (Number.isNaN(row) || Number.isNaN(col)) return null;
    return { row, col };
  }, []);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      const pos = cellFromEvent(e);
      if (!pos) return;
      props.onSelect(pos.row, pos.col);
      focusShell();
    },
    [cellFromEvent, props, focusShell],
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (readOnly) return;
      const pos = cellFromEvent(e);
      if (!pos) return;
      beginEdit(pos.row, pos.col, cells[cellKey(pos.row, pos.col)] ?? "");
    },
    [cellFromEvent, cells, readOnly, beginEdit],
  );

  const bodyHeight = rows * ROW_H;
  const bodyWidth = cols * COL_W;
  const topPad = Math.max(0, (view.rowStart - frozenRows) * ROW_H);
  const renderedRows = visibleRows.filter((r) => r >= frozenRows).length;
  const bottomPad = Math.max(0, bodyHeight - topPad - renderedRows * ROW_H);
  const leftPad = Math.max(0, (view.colStart - frozenCols) * COL_W);
  const renderedCols = visibleCols.filter((c) => c >= frozenCols).length;
  const rightPad = Math.max(0, bodyWidth - leftPad - renderedCols * COL_W);

  /** 冻结列位置由四个分层决定，不再依赖 sticky 偏移。 */
  const frozenEditCol = selected.col < frozenCols;
  const frozenEditRow = selected.row < frozenRows;
  const selectedVisible =
    frozenEditRow || (selected.row >= view.rowStart && selected.row < view.rowEnd);
  /** 编辑浮层：渲染在 .grid-space 里（原点在表头之上），与单元格同一坐标系。 */
  const editLeft =
    2 +
    ROW_HEAD_W +
    (frozenEditCol
      ? selected.col * COL_W
      : leftPad + (selected.col - view.colStart) * COL_W);
  const editTop = 2 + HEADER_H + selected.row * ROW_H;
  const editInput = (
    <input
      ref={inputRef}
      className="cell-input floating"
      defaultValue={draft}
      style={{
        position: "absolute",
        width: COL_W - 4,
        height: ROW_H - 4,
        // 与单元格同一坐标系（表体原点 = 表头下方）
        left: editLeft,
        top: editTop,
        zIndex: 80,
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        const text = inputRef.current?.value ?? "";
        if (e.key === "Enter") {
          e.preventDefault();
          committedRef.current = true;
          props.onCommit(selected.row, selected.col, text);
          focusShellRef.current?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          committedRef.current = true;
          props.onCancel();
          focusShellRef.current?.();
        } else if (e.key === "Tab") {
          e.preventDefault();
          committedRef.current = true;
          const next = e.shiftKey ? Math.max(0, selected.col - 1) : Math.min(cols - 1, selected.col + 1);
          props.onCommit(selected.row, selected.col, text);
          props.onMove(selected.row, next);
          scrollIntoView(selected.row, next);
          focusShellRef.current?.();
        }
      }}
      onBlur={() => {
        if (committedRef.current) {
          committedRef.current = false;
          return;
        }
        props.onCommit(selected.row, selected.col, inputRef.current?.value ?? "");
        focusShellRef.current?.();
      }}
    />
  );

  /**
   * 单元格样式：只负责外观与冻结列的横向固定。
   *
   * 纵向位置由"行"决定（行绝对定位在文档坐标，行内用 flex 流式排布）——
   * 曾经给每个单元格写绝对坐标，结果与行偏移叠加，数据只落在偶数行。
   */
  const cellStyle = (
    fmt: CellFormat | undefined,
    frozenCol: boolean,
    isSelected: boolean,
  ): React.CSSProperties => ({
    zIndex: frozenCol ? 30 : isSelected ? 6 : 1,
    fontWeight: fmt?.bold ? 700 : undefined,
    fontStyle: fmt?.italic ? "italic" : undefined,
    textDecoration: fmt?.underline ? "underline" : undefined,
    color: fmt?.color || undefined,
    backgroundColor: fmt?.bg || undefined,
    textAlign: fmt?.align || undefined,
  });

  /**
   * 渲染一行的单元格。
   *
   * 网格拆成四个层（与 CDK 的思路一致），因为 CSS sticky 的约束框会随
   * 行盒滚走而失效：
   * 1) 滚动区（行号 + 非冻结列）；2) 左侧冻结列层；3) 顶部冻结行层；4) 左上角。
   * 这里按 `colsToRender` 复用同一个渲染函数，保证两侧单元格样式一致。
   */
  const renderCells = (r: number, colsToRender: number[], spacerLeft: number) => (
    <>
      {spacerLeft > 0 && <div className="grid-spacer" style={{ width: spacerLeft }} />}
      {colsToRender.map((c) => {
        const key = cellKey(r, c);
        const isSelected = selected.row === r && selected.col === c;
        const remote = Object.values(cursors).some(
          (cur) => cur.user !== self && cur.row === r && cur.col === c,
        );
        return (
          <GridCell
            key={key}
            row={r}
            col={c}
            value={cells[key] ?? null}
            style={cellStyle(formats[key], c < frozenCols, isSelected)}
            className={`cell${c < frozenCols ? " frozen" : ""}${isSelected ? " selected" : ""}`}
            remote={remote}
            cells={cells}
          />
        );
      })}
    </>
  );

  const scrolledCols = visibleCols;
  // 冻结列恒为 0..frozenCols-1，不能用"可见窗口"过滤：
  // 横向滚动后可见窗口已不含冻结列，过滤会导致冻结列头/单元格不渲染。
  const frozenColList = useMemo(
    () => Array.from({ length: Math.min(frozenCols, cols) }, (_, c) => c),
    [frozenCols, cols],
  );
  const frozenRowList = useMemo(
    () => Array.from({ length: Math.min(frozenRows, rows) }, (_, r) => r),
    [frozenRows, rows],
  );
  const scrolledRowList = visibleRows.filter((r) => r >= frozenRows);

  /**
   * 冻结层的视口基准：
   * - 冻结行/左上角钉在表头下方，内部用行号 × 行高（文档坐标）；
   * - 冻结列层钉在视口左侧并向下延伸到滚动容器底部，内部用文档坐标 - scrollTop
   *   （即视口坐标）并配合 overflow: hidden 裁切，保证列头恒在视口顶部。
   */
  const frozenRowOrigin = HEADER_H + view.scrollTop;
  const frozenViewportH = Math.max(0, size.height - HEADER_H);
  const frozenColsW = ROW_HEAD_W + frozenCols * COL_W;
  const frozenRowsH = frozenRows * ROW_H;

  return (
    <div
      className="grid-shell"
      ref={shellRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      // 便于自动化测试断言当前虚拟窗口（不影响渲染）
      data-view={`${view.rowStart}-${view.rowEnd}:${view.colStart}-${view.colEnd}:${Math.round(view.scrollTop)}:${Math.round(view.scrollLeft)}`}
      data-rows={visibleRows.length}
    >
      <div className="grid-scroll" ref={scrollRef} onScroll={measure}>
        <div className="grid-space" style={{ width: ROW_HEAD_W + bodyWidth, height: HEADER_H + bodyHeight }}>
          {/* 表头（sticky 顶部；只含非冻结列，冻结列头在左上/左侧层） */}
          <div className="grid-header" style={{ height: HEADER_H, width: ROW_HEAD_W + bodyWidth }}>
            <div className="grid-spacer" style={{ width: ROW_HEAD_W }} />
            {leftPad > 0 && <div className="grid-spacer" style={{ width: leftPad }} />}
            {scrolledCols.map((c) => (
              <div
                key={`h-${c}`}
                className={`col-head${c === selected.col ? " active" : ""}`}
                style={{ flex: "none", zIndex: 40 }}
              >
                {colLabel(c)}
              </div>
            ))}
            {rightPad > 0 && <div className="grid-spacer" style={{ width: rightPad }} />}
          </div>

          {/* 滚动区：行号 + 非冻结列（文档坐标，随内容滚动）。
              左侧为冻结列让出固定宽度，否则会被冻结层盖住。 */}
          <div
            className="grid-body"
            style={{ top: HEADER_H, height: bodyHeight, width: ROW_HEAD_W + bodyWidth }}
          >
            {scrolledRowList.map((r) => (
              <div
                key={r}
                className="grid-row"
                style={{ top: r * ROW_H, height: ROW_H, width: ROW_HEAD_W + bodyWidth }}
              >
                <div className="grid-spacer" style={{ width: ROW_HEAD_W + frozenCols * COL_W }} />
                {renderCells(r, scrolledCols, leftPad)}
                {rightPad > 0 && <div className="grid-spacer" style={{ width: rightPad }} />}
              </div>
            ))}
          </div>

          {/* 左侧冻结列层：钉在视口左侧，覆盖表头 + 表体（行内容随纵向滚动裁切） */}
          {frozenCols > 0 && (
            <div
              className="grid-frozen-cols"
              style={{
                // .grid-space 的原点已在表头下方，因此这里不要再加 HEADER_H
                top: view.scrollTop,
                height: HEADER_H + frozenViewportH,
                width: frozenColsW,
                transform: `translateX(${view.scrollLeft}px)`,
              }}
            >
              <div className="frozen-cols-head" style={{ height: HEADER_H }}>
                {frozenColList.map((c) => (
                  <div
                    key={`fch-${c}`}
                    className={`col-head frozen${c === selected.col ? " active" : ""}`}
                    style={{ flex: "none" }}
                  >
                    {colLabel(c)}
                  </div>
                ))}
              </div>
              {scrolledRowList.map((r) => (
                <div
                  key={r}
                  className="grid-row"
                  style={{
                    top: HEADER_H + r * ROW_H - view.scrollTop,
                    height: ROW_H,
                    width: frozenColsW,
                  }}
                >
                  <div className={`row-head frozen${r === selected.row ? " active" : ""}`}>{r + 1}</div>
                  {renderCells(r, frozenColList, 0)}
                </div>
              ))}
            </div>
          )}

          {/* 顶部冻结行层：绝对定位钉在表头下方，内容用文档坐标（随横向滚动裁切） */}
          {frozenRows > 0 && (
            <div
              className="grid-frozen-rows"
              style={{
                top: frozenRowOrigin,
                height: frozenRowsH,
                width: size.width,
                transform: `translateX(${view.scrollLeft}px)`,
              }}
            >
              {frozenRowList.map((r) => (
                <div
                  key={r}
                  className="grid-row"
                  style={{ top: r * ROW_H, height: ROW_H, width: ROW_HEAD_W + bodyWidth }}
                >
                  <div className={`row-head frozen${r === selected.row ? " active" : ""}`}>{r + 1}</div>
                  {renderCells(r, scrolledCols, leftPad)}
                  {rightPad > 0 && <div className="grid-spacer" style={{ width: rightPad }} />}
                </div>
              ))}
            </div>
          )}

          {/* 左上角：冻结行 × 冻结列 */}
          {frozenRows > 0 && frozenCols > 0 && (
            <div
              className="grid-frozen-corner"
              style={{
                top: frozenRowOrigin,
                height: frozenRowsH,
                width: frozenColsW,
                transform: `translateX(${view.scrollLeft}px)`,
              }}
            >
              {frozenRowList.map((r) => (
                <div
                  key={r}
                  className="grid-row"
                  style={{ top: r * ROW_H, height: ROW_H, width: frozenColsW }}
                >
                  <div className={`row-head frozen${r === selected.row ? " active" : ""}`}>{r + 1}</div>
                  {renderCells(r, frozenColList, 0)}
                </div>
              ))}
            </div>
          )}

          {editing && selectedVisible && editInput}
        </div>
      </div>
      <div className="grid-status">
        <span>
          选中 {colLabel(selected.col)}
          {selected.row + 1}
        </span>
        <span className="muted">
          共 {rows.toLocaleString("en-US")} 行 × {cols} 列 · 已渲染 {visibleRows.length}×{visibleCols.length}
          {frozenRows || frozenCols ? ` · 冻结 ${frozenRows} 行 / ${frozenCols} 列` : ""}
        </span>
      </div>
    </div>
  );
}

interface CellProps {
  row: number;
  col: number;
  value: string | null;
  fmt?: CellFormat;
  style: React.CSSProperties;
  className: string;
  remote: boolean;
  cells: Cells;
}

function GridCell(props: CellProps) {
  const { row, col, value, style, className, remote } = props;
  return (
    <div
      data-cell="1"
      data-row={row}
      data-col={col}
      style={style}
      className={`${className}${remote ? " remote" : ""}`}
      title={remote ? "其他用户正在此处" : undefined}
    >
      <span>{evaluate(value, props.cells)}</span>
    </div>
  );
}
