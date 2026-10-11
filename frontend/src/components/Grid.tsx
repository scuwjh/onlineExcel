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
import { formatCellDisplay } from "../lib/cellDisplay";
import type { SelectionKind } from "../hooks/useSheet";

interface Props {
  cells: Cells;
  formats: Record<string, CellFormat>;
  rows: number;
  cols: number;
  selected: { row: number; col: number };
  /** 框选锚点（Shift+方向键扩展选区时保持不变）。 */
  anchor: { row: number; col: number };
  /** 选区类型：普通框选 / 整行 / 整列 / 全选（REQ-002/003）。 */
  selectionKind: SelectionKind;
  editing: { row: number; col: number } | null;
  draft: string;
  cursors: Record<string, Cursor>;
  frozenRows: number;
  frozenCols: number;
  self: string;
  readOnly: boolean;
  onSelect: (row: number, col: number) => void;
  /** Shift+方向键：移动活动格并保持锚点。 */
  onExtendSelect: (row: number, col: number) => void;
  /** Ctrl+A：全选。 */
  onSelectAll: () => void;
  /** 点行号：整行选中；Shift 时为连续多行。 */
  onSelectRow: (row: number, extend?: boolean) => void;
  /** 点列标：整列选中；Shift 时为连续多列。 */
  onSelectCol: (col: number, extend?: boolean) => void;
  /** 选区尺寸变化（用于状态栏显示"4×3"）。 */
  onRangeInfoChange?: (info: { rows: number; cols: number; kind: SelectionKind }) => void;
  /** Delete/Backspace：清空选区。 */
  onClearRange: (r0: number, c0: number, r1: number, c1: number) => void;
  onStartEdit: (row: number, col: number, draft: string) => void;
  onDraft: (draft: string) => void;
  onCommit: (row: number, col: number, value: string) => void;
  onCancel: () => void;
  onMove: (row: number, col: number) => void;
  onPaste: (row: number, col: number, text: string) => void;
  onUndo: () => void;
  onRedo: () => void;
  /**
   * 展示行序（REQ-101）：数组下标是"视图位置"，值是真实数据行号。
   * 筛选/排序只影响这里，数据本身与存储顺序不变。
   */
  rowOrder?: number[];
  /** 单元格评论数（键为 ``row_id:col_id``），用于画角标。 */
  commentCounts?: Record<string, number>;
  /** 行列的稳定元素 ID（评论角标按元素 ID 定位）。 */
  rowIds?: string[];
  colIds?: string[];
  onOpenComments?: (row: number, col: number) => void;
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
    anchor,
    selectionKind,
    editing,
    draft,
    cursors,
    frozenRows,
    frozenCols,
    self,
    readOnly,
  } = props;

  /** 当前选区（锚点与活动格之间的矩形；整行整列时按类型展开）。 */
  const range = useMemo(() => {
    if (selectionKind === "all") return { r0: 0, c0: 0, r1: Math.max(0, rows - 1), c1: Math.max(0, cols - 1) };
    if (selectionKind === "row") {
      return {
        r0: Math.min(selected.row, anchor.row),
        r1: Math.max(selected.row, anchor.row),
        c0: 0,
        c1: Math.max(0, cols - 1),
      };
    }
    if (selectionKind === "col") {
      return {
        r0: 0,
        r1: Math.max(0, rows - 1),
        c0: Math.min(selected.col, anchor.col),
        c1: Math.max(selected.col, anchor.col),
      };
    }
    return {
      r0: Math.min(selected.row, anchor.row),
      r1: Math.max(selected.row, anchor.row),
      c0: Math.min(selected.col, anchor.col),
      c1: Math.max(selected.col, anchor.col),
    };
  }, [selected, anchor, selectionKind, rows, cols]);
  const inRange = useCallback(
    (r: number, c: number) => r >= range.r0 && r <= range.r1 && c >= range.c0 && c <= range.c1,
    [range],
  );

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

  /** 展示行序：默认 0..rows-1；筛选/排序后由父组件传入重排结果。 */
  const order = props.rowOrder && props.rowOrder.length !== rows ? props.rowOrder : props.rowOrder;
  const viewHeight = order ? order.length : rows;
  const rowAt = useCallback((slot: number) => (order ? order[slot] : slot), [order]);

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
      const rowEnd = Math.min(viewHeight, rowStart + Math.ceil(usableHeight / ROW_H) + OVERSCAN_ROWS * 2);
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
  }, [viewHeight, cols, frozenRows, frozenCols]);

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

  const scrollIntoView = useCallback(
    (row: number, col: number) => {
      const el = scrollRef.current;
      if (!el) return;
      const slot = order ? order.indexOf(row) : row; // 过滤/排序后行号不等于显示位置
      const rowTop = (slot < 0 ? 0 : slot) * ROW_H;
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
    },
    [order],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const { row, col } = selected;
      if (e.ctrlKey || e.metaKey) {
        const key = e.key.toLowerCase();
        if (key === "a") {
          e.preventDefault();
          props.onSelectAll();
          return;
        }
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
      /** 上下移动按"展示顺序"走：被筛选隐藏的行会自动跳过。 */
      const step = (delta: number) => {
        if (!order) return Math.min(rows - 1, Math.max(0, row + delta));
        const slot = order.indexOf(row);
        const next = Math.min(order.length - 1, Math.max(0, (slot < 0 ? 0 : slot) + delta));
        return order[next] ?? row;
      };
      switch (e.key) {
        case "ArrowUp":
          nr = step(-1);
          break;
        case "ArrowDown":
          nr = step(1);
          break;
        case "ArrowLeft":
          nc = Math.max(0, col - 1);
          break;
        case "ArrowRight":
          nc = Math.min(cols - 1, col + 1);
          break;
        case "PageDown":
          nr = step(pageRows);
          break;
        case "PageUp":
          nr = step(-pageRows);
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
          if (!readOnly) {
            if (range.r1 > range.r0 || range.c1 > range.c0) props.onClearRange(range.r0, range.c0, range.r1, range.c1);
            else props.onCommit(row, col, "");
          }
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
        // Shift+方向键扩展选区：只移动活动格，锚点不动
        if (e.shiftKey) props.onExtendSelect(nr, nc);
        else props.onMove(nr, nc);
        scrollIntoView(nr, nc);
      }
      focusShell();
    },
    [selected, cells, rows, cols, readOnly, props, size.height, scrollIntoView, focusShell, beginEdit, range, inRange],
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

  /**
   * 鼠标拖拽框选（REQ-002）。
   *
   * 拖拽期间只能看到"当前可见行"，所以按**展示顺序**换算：
   * 单元格用真实数据行号，行号/列标用序号。
   */
  const dragRef = useRef<
    | { mode: "cell"; anchor: { row: number; col: number } }
    | { mode: "row"; from: number }
    | { mode: "col"; from: number }
    | null
  >(null);
  /** 本次按下是否真的拖动过（决定 click 是否再选中一次）。 */
  const dragMovedRef = useRef(false);

  const rowFromEvent = useCallback((e: React.MouseEvent): number | null => {
    const head = (e.target as HTMLElement).closest("[data-row-head]") as HTMLElement | null;
    if (!head) return null;
    const row = Number(head.dataset.rowHead);
    return Number.isNaN(row) ? null : row;
  }, []);

  const colFromEvent = useCallback((e: React.MouseEvent): number | null => {
    const head = (e.target as HTMLElement).closest("[data-col-head]") as HTMLElement | null;
    if (!head) return null;
    const col = Number(head.dataset.colHead);
    return Number.isNaN(col) ? null : col;
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const rowHead = rowFromEvent(e);
      if (rowHead !== null) {
        e.preventDefault();
        dragRef.current = { mode: "row", from: rowHead };
        props.onSelectRow(rowHead, e.shiftKey);
        focusShell();
        return;
      }
      const colHead = colFromEvent(e);
      if (colHead !== null) {
        e.preventDefault();
        dragRef.current = { mode: "col", from: colHead };
        props.onSelectCol(colHead, e.shiftKey);
        focusShell();
        return;
      }
      const pos = cellFromEvent(e);
      if (pos) {
        // 单击立即选中并把锚点移到该格；拖拽时由 mousemove 走扩展选中，
        // 松手后的 click 不再重复选中（否则会把刚框出来的选区收成单格）。
        dragRef.current = { mode: "cell", anchor: pos };
        dragMovedRef.current = false;
        props.onSelect(pos.row, pos.col);
      }
    },
    [cellFromEvent, colFromEvent, focusShell, props, rowFromEvent, selected.col, selected.row],
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.mode === "cell") {
        const pos = cellFromEvent(e);
        if (!pos) return;
        if (pos.row === selected.row && pos.col === selected.col) return;
        dragMovedRef.current = true;
        props.onExtendSelect(pos.row, pos.col);
        // 拖到边缘时自动滚动
        const el = scrollRef.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          const margin = ROW_H;
          if (e.clientY > rect.bottom - margin) el.scrollTop += ROW_H;
          else if (e.clientY < rect.top + margin) el.scrollTop -= ROW_H;
          if (e.clientX > rect.right - margin) el.scrollLeft += COL_W;
          else if (e.clientX < rect.left + margin) el.scrollLeft -= COL_W;
        }
        return;
      }
      if (drag.mode === "row") {
        const row = rowFromEvent(e);
        if (row !== null && row !== selected.row) props.onSelectRow(row, true);
        return;
      }
      const col = colFromEvent(e);
      if (col !== null && col !== selected.col) props.onSelectCol(col, true);
    },
    [cellFromEvent, colFromEvent, props, rowFromEvent, selected.col, selected.row],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  // 拖拽在表格外结束（或鼠标离开窗口）时也要收尾
  useEffect(() => {
    const stop = () => {
      dragRef.current = null;
    };
    window.addEventListener("mouseup", stop);
    return () => window.removeEventListener("mouseup", stop);
  }, []);

  // 把选区尺寸告诉父组件（状态栏显示）
  useEffect(() => {
    props.onRangeInfoChange?.({
      rows: range.r1 - range.r0 + 1,
      cols: range.c1 - range.c0 + 1,
      kind: selectionKind,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.r0, range.r1, range.c0, range.c1, selectionKind]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // 刚结束拖拽框选：不再把选区收成单格
      if (dragMovedRef.current) {
        dragMovedRef.current = false;
        return;
      }
      // 行号/列标/左上角已在自己的 mousedown 里选中，click 不能再按单格处理，
      // 否则会把刚选中的整行/整列收成一个单元格（历史 bug）。
      const target = e.target as HTMLElement;
      if (target.closest("[data-row-head]") || target.closest("[data-col-head]") || target.closest(".corner")) {
        return;
      }
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
   * 单元格样式：负责外观与冻结列的横向固定（REQ-007）。
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
    // 下划线与删除线可以同时存在
    textDecoration:
      [fmt?.underline ? "underline" : "", fmt?.strike ? "line-through" : ""].filter(Boolean).join(" ") || undefined,
    color: fmt?.color || undefined,
    backgroundColor: fmt?.bg || undefined,
    textAlign: fmt?.align || undefined,
    fontFamily: fmt?.font ? `"${fmt.font}", "${fmt.font}", sans-serif` : undefined,
    fontSize: fmt?.size ? `${fmt.size}px` : undefined,
    whiteSpace: fmt?.wrap ? "pre-wrap" : undefined,
    overflow: fmt?.wrap ? "hidden" : undefined,
    justifyContent:
      fmt?.valign === "top" ? "flex-start" : fmt?.valign === "bottom" ? "flex-end" : undefined,
    borderTop: fmt?.borders?.top ? "1px solid #5b6b7c" : undefined,
    borderRight: fmt?.borders?.right ? "1px solid #5b6b7c" : undefined,
    borderBottom: fmt?.borders?.bottom ? "1px solid #5b6b7c" : undefined,
    borderLeft: fmt?.borders?.left ? "1px solid #5b6b7c" : undefined,
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
        const isInRange = inRange(r, c);
        const remote = Object.values(cursors).some(
          (cur) => cur.user !== self && cur.row === r && cur.col === c,
        );
        // 评论角标：数量取自稳定元素 ID（row_id:col_id），行列插删后依然跟随
        const commentKey = `${rowIdsForComments[r] ?? ""}:${colIdsForComments[c] ?? ""}`;
        const commentCount = props.commentCounts?.[commentKey] ?? 0;
        return (
          <GridCell
            key={key}
            row={r}
            col={c}
            value={cells[key] ?? null}
            style={cellStyle(formats[key], c < frozenCols, isSelected)}
            fmt={formats[key]}
            className={`cell${c < frozenCols ? " frozen" : ""}${isSelected ? " selected" : isInRange ? " in-range" : ""}`}
            remote={remote}
            cells={cells}
            commentCount={commentCount}
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
  const rowIdsForComments = props.rowIds ?? [];
  const colIdsForComments = props.colIds ?? [];
  const orderIndexOf = useCallback(
    (row: number) => {
      if (!order) return row;
      const idx = order.indexOf(row);
      return idx < 0 ? row : idx;
    },
    [order],
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
      className={`grid-shell kind-${selectionKind}`}
      ref={shellRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={endDrag}
      onMouseLeave={endDrag}
      // 便于自动化测试断言当前虚拟窗口（不影响渲染）
      data-view={`${view.rowStart}-${view.rowEnd}:${view.colStart}-${view.colEnd}:${Math.round(view.scrollTop)}:${Math.round(view.scrollLeft)}`}
      data-rows={visibleRows.length}
      data-order={order ? order.slice(0, 12).join(",") : "none"}
      data-range={`${range.r0}:${range.c0}-${range.r1}:${range.c1}`}
      data-anchor={`${anchor.row}:${anchor.col}`}
      data-selected={`${selected.row}:${selected.col}`}
      data-selkind={`${selectionKind}|${typeof selectionKind}|${JSON.stringify(props.selectionKind)}`}
    >
      <div className="grid-scroll" ref={scrollRef} onScroll={measure}>
        <div className="grid-space" style={{ width: ROW_HEAD_W + bodyWidth, height: HEADER_H + bodyHeight }}>
          {/* 表头（sticky 顶部；只含非冻结列，冻结列头在左上/左侧层） */}
          <div className="grid-header" style={{ height: HEADER_H, width: ROW_HEAD_W + bodyWidth }}>
            {/* 左上角（行号列与表头交汇处）：横向滚动时钉在左缘；点击=全选 */}
            <div
              className={`corner${selectionKind === "all" ? " active" : ""}`}
              title="全选（Ctrl+A）"
              onMouseDown={(e) => {
                e.preventDefault();
                props.onSelectAll();
                focusShell();
              }}
            />
            {leftPad > 0 && <div className="grid-spacer" style={{ width: leftPad }} />}
            {scrolledCols.map((c) => (
              <div
                key={`h-${c}`}
                data-col-head={c}
                title={`选中 ${colLabel(c)} 列`}
                className={`col-head${c >= range.c0 && c <= range.c1 ? " active" : ""}`}
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
            {visibleRows.map((slot) => {
              const r = rowAt(slot);
              return (
                <div
                  key={r}
                  className="grid-row"
                  style={{ top: slot * ROW_H, height: ROW_H, width: ROW_HEAD_W + bodyWidth }}
                >
                  {frozenCols === 0 ? (
                    <div
                      data-row-head={r}
                      title={`选中第 ${r + 1} 行`}
                      // 强调色只给"真正在选区内的行号"：原先按 selectionKind 判断，
                      // 该条件对所有行都成立，等于把整列行号都刷成选中态（无法区分选了哪几行）
                      className={`row-head${r >= range.r0 && r <= range.r1 ? " active" : ""}`}
                    >
                      {r + 1}
                    </div>
                  ) : (
                    <div className="grid-spacer" style={{ width: ROW_HEAD_W }} />
                  )}
                  {frozenCols > 0 && <div className="grid-spacer" style={{ width: frozenCols * COL_W }} />}
                  {renderCells(r, scrolledCols, leftPad)}
                  {rightPad > 0 && <div className="grid-spacer" style={{ width: rightPad }} />}
                </div>
              );
            })}
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
                {/* 行号列宽占位：让冻结列头与下方数据列对齐 */}
                <div className="grid-spacer" style={{ width: ROW_HEAD_W }} />
                {frozenColList.map((c) => (
                  <div
                    key={`fch-${c}`}
                    data-col-head={c}
                    title={`选中 ${colLabel(c)} 列`}
                    className={`col-head frozen${c >= range.c0 && c <= range.c1 ? " active" : ""}`}
                    style={{ flex: "none" }}
                  >
                    {colLabel(c)}
                  </div>
                ))}
              </div>
              {/* 滚动区每一行的冻结列：行内容在文档坐标随纵向滚动，横向被层钉住。
                  之前只渲染冻结行（frozenRowList），导致普通行的冻结列数据消失。 */}
              {visibleRows.map((slot) => {
                const r = rowAt(slot);
                return (
                  <div
                    key={r}
                    className="grid-row"
                    style={{
                      top: HEADER_H + orderIndexOf(r) * ROW_H - view.scrollTop,
                      height: ROW_H,
                      width: frozenColsW,
                    }}
                  >
                    <div
                      data-row-head={r}
                      title={`选中第 ${r + 1} 行`}
                      className={`row-head frozen${r >= range.r0 && r <= range.r1 ? " active" : ""}`}
                    >
                      {r + 1}
                    </div>
                    {renderCells(r, frozenColList, 0)}
                  </div>
                );
              })}
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
                  <div
                    data-row-head={r}
                    title={`选中第 ${r + 1} 行`}
                    className={`row-head frozen${r >= range.r0 && r <= range.r1 ? " active" : ""}`}
                  >
                    {r + 1}
                  </div>
                  {/* 让出冻结列宽度，与滚动区非冻结列对齐 */}
                  {frozenCols > 0 && <div className="grid-spacer" style={{ width: frozenCols * COL_W }} />}
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
                  <div
                    data-row-head={r}
                    title={`选中第 ${r + 1} 行`}
                    className={`row-head frozen${r >= range.r0 && r <= range.r1 ? " active" : ""}`}
                  >
                    {r + 1}
                  </div>
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
          {selectionKind === "all" ? "全选 " : selectionKind === "row" ? "整行 " : selectionKind === "col" ? "整列 " : "选中 "}
          {colLabel(range.c0)}
          {range.r0 + 1}
          {range.r1 > range.r0 || range.c1 > range.c0
            ? ` : ${colLabel(range.c1)}${range.r1 + 1}（${range.r1 - range.r0 + 1}行 × ${range.c1 - range.c0 + 1}列）`
            : ""}
        </span>
        <span className="muted">
          共 {rows.toLocaleString("en-US")} 行 × {cols} 列
          {order ? ` · 显示 ${order.length.toLocaleString("en-US")} 行（筛选/排序生效）` : ""}
          {" · "}已渲染 {visibleRows.length}×{visibleCols.length}
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
  commentCount?: number;
}

function GridCell(props: CellProps) {
  const { row, col, value, fmt, style, className, remote, commentCount = 0 } = props;
  const title = [remote ? "其他用户正在此处" : "", commentCount ? `${commentCount} 条评论` : ""]
    .filter(Boolean)
    .join(" · ");
  // 求值（公式）后再按数字/日期格式渲染；原始值始终不变（REQ-007/009）
  const text = formatCellDisplay(evaluate(value, props.cells), fmt);
  return (
    <div
      data-cell="1"
      data-row={row}
      data-col={col}
      data-comments={commentCount || undefined}
      style={style}
      className={`${className}${remote ? " remote" : ""}${commentCount ? " has-comment" : ""}`}
      title={title || undefined}
    >
      <span>{text}</span>
      {commentCount > 0 && <i className="comment-badge" aria-label={`${commentCount} 条评论`} />}
    </div>
  );
}
