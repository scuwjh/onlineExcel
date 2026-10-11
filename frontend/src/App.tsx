/** 应用外壳：登录 → 表格工作区（协同编辑 + 历史版本 + 成员权限 + 评论 + 筛选排序 + Excel + 右键菜单/拖拽填充）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import CommentsPanel from "./components/CommentsPanel";
import ContextMenu, { type MenuItem } from "./components/ContextMenu";
import FormulaBar from "./components/FormulaBar";
import Grid from "./components/Grid";
import { PermissionsPanel, VersionsPanel } from "./components/Panels";
import PresenceBar from "./components/PresenceBar";
import Toolbar from "./components/Toolbar";
import ViewPanel from "./components/ViewPanel";
import { useComments } from "./hooks/useComments";
import { useSheet } from "./hooks/useSheet";
import { cellKey } from "./lib/gridUtils";
import { computeRowOrder } from "./lib/viewFilter";
import { evaluate } from "./lib/formula";
import { describeFill } from "./lib/fillSeries";
import type { ColumnFilter, NumberFormat, Role, SheetData, SheetSummary, SortRule, ValueFilter } from "./types";
import { NUMBER_FORMAT_LABELS } from "./types";

type Panel = "none" | "versions" | "permissions" | "comments" | "view";

/** 右键菜单的上下文。 */
interface MenuContext {
  x: number;
  y: number;
  target: "cell" | "row" | "col" | "corner";
  row?: number;
  col?: number;
}

export default function App() {
  const [token, setToken] = useState<string | null>(() => api.getToken());
  const [userName, setUserName] = useState<string>(() => api.getStoredUser() ?? "");
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [toast, setToast] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);
  // 视图状态（本地）：筛选与排序都不改数据
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const [valueFilters, setValueFilters] = useState<ValueFilter[]>([]);
  const [sorts, setSorts] = useState<SortRule[]>([]);
  /** 当前选区尺寸（状态栏显示"选中 4×3"）。 */
  const [rangeInfo, setRangeInfo] = useState<{ rows: number; cols: number; kind: string }>({
    rows: 1,
    cols: 1,
    kind: "cell",
  });
  /** 右键菜单上下文（REQ-005）。 */
  const [menu, setMenu] = useState<MenuContext | null>(null);
  /** 填充拖拽的目标区域预览（REQ-006）。 */
  const [fillPreview, setFillPreview] = useState<{ r0: number; c0: number; r1: number; c1: number } | null>(null);
  const xlsxRef = useRef<HTMLInputElement>(null);

  const refreshList = useCallback(async () => {
    try {
      setSheets(await api.listSheets());
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, []);

  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const onSheetChanged = useCallback(() => {
    void refreshList();
    void reloadRef.current();
  }, [refreshList]);

  /**
   * 评论（REQ-100）与单元格数据分开加载。
   * 这里先用 ref 转发 WebSocket 的评论广播（回调要稳定，避免 socket 锁死旧闭包），
   * 再把 ref 指向真实的评论 hook。
   */
  const commentsBridge = useRef<{
    applyRemote: (comment: api.SheetComment, counts: Record<string, number>) => void;
  } | null>(null);
  const onCommentBroadcast = useCallback((comment: Record<string, unknown>, counts: Record<string, number>) => {
    commentsBridge.current?.applyRemote(comment as unknown as api.SheetComment, counts);
  }, []);

  const sheetApi = useSheet(sheet, onSheetChanged, onCommentBroadcast);

  const comments = useComments(sheetApi.state.sheetId);
  commentsBridge.current = comments;

  // 打开评论面板时刷新一次：成员列表与角标可能已被其他端的操作改变
  useEffect(() => {
    if (panel === "comments") void comments.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  const reloadSheet = useCallback(async () => {
    if (!sheet?.id) return;
    try {
      setSheet(await api.getSheet(sheet.id));
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, [sheet?.id]);

  useEffect(() => {
    reloadRef.current = reloadSheet;
  }, [reloadSheet]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const list = await api.listSheets();
        setSheets(list);
        if (list.length) {
          setSheet(await api.getSheet(list[0].id));
        }
      } catch (err) {
        const message = (err as Error).message;
        if ((err as api.ApiError).status === 401) setToken(null);
        else setAppError(message);
      }
    })();
  }, [token]);

  const handleLogout = useCallback(() => {
    api.clearSession();
    setToken(null);
    setSheet(null);
    setSheets([]);
    setUserName("");
  }, []);

  const handleLogin = useCallback((nextToken: string, name: string) => {
    setToken(nextToken);
    setUserName(name);
    setAppError(null);
  }, []);

  const openSheet = useCallback(
    async (id: string) => {
      try {
        setSheet(await api.getSheet(id));
        setPanel("none");
      } catch (err) {
        setAppError((err as Error).message);
      }
    },
    [],
  );

  const newSheet = useCallback(async () => {
    try {
      const created = await api.createSheet("未命名表格", 1000, 26);
      setSheet(created);
      await refreshList();
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, [refreshList]);

  const role: Role | null = sheetApi.state.role ?? sheet?.role ?? null;
  const selectedKey = cellKey(sheetApi.state.selected.row, sheetApi.state.selected.col);
  const rawValue =
    sheetApi.state.editing || sheetApi.state.formulaEditing
      ? sheetApi.state.draft
      : (sheetApi.state.cells[selectedKey] ?? "");
  const selectedFormat = sheetApi.state.formats[selectedKey] ?? {};
  /** 活动格的求值结果：公式栏用它显示"实时计算"结果与错误检查（REQ-009）。 */
  const computedValue = useMemo(
    () => evaluate(sheetApi.state.cells[selectedKey] ?? null, sheetApi.state.cells),
    [sheetApi.state.cells, selectedKey],
  );

  const mergedComments = comments;
  const canComment = role === "owner" || role === "editor" || role === "commenter";

  // 视图（REQ-101）：条件筛选 + 按值多选筛选 + 多级排序，都只影响本端展示
  const rowOrder = useMemo(() => {
    if (!filters.length && !valueFilters.length && !sorts.length) return undefined;
    return computeRowOrder(sheetApi.state.rows, sheetApi.state.cells, filters, valueFilters, sorts);
  }, [filters, valueFilters, sorts, sheetApi.state.rows, sheetApi.state.cells]);

  /** 当前选区描述（工具栏显示，REQ-002/003 让用户确认选中的范围）。 */
  const rangeLabel = useMemo(() => {
    if (rangeInfo.kind === "all") return `全选 ${rangeInfo.rows}×${rangeInfo.cols}`;
    if (rangeInfo.kind === "row") return `整行 ${rangeInfo.rows} 行`;
    if (rangeInfo.kind === "col") return `整列 ${rangeInfo.cols} 列`;
    if (rangeInfo.rows === 1 && rangeInfo.cols === 1) return "单格";
    return `${rangeInfo.rows}×${rangeInfo.cols} 选区`;
  }, [rangeInfo]);

  /**
   * 右键菜单项（REQ-005）。
   *
   * 按命中区域（单元格 / 行号 / 列标 / 左上角）给出对应操作；
   * 菜单本身不持有业务逻辑，全部调用 useSheet 暴露的操作。
   */
  const openContextMenu = useCallback(
    (payload: MenuContext) => {
      // 右键单元格：先选中它（与 Excel 一致），行号/列标则整行整列选中
      if (payload.target === "row" && payload.row !== undefined) {
        sheetApi.selectRow(payload.row);
      } else if (payload.target === "col" && payload.col !== undefined) {
        sheetApi.selectCol(payload.col);
      } else if (payload.target === "cell" && payload.row !== undefined && payload.col !== undefined) {
        const inRange =
          payload.row >= Math.min(sheetApi.state.selected.row, sheetApi.state.anchor.row) &&
          payload.row <= Math.max(sheetApi.state.selected.row, sheetApi.state.anchor.row) &&
          payload.col >= Math.min(sheetApi.state.selected.col, sheetApi.state.anchor.col) &&
          payload.col <= Math.max(sheetApi.state.selected.col, sheetApi.state.anchor.col);
        if (!inRange) sheetApi.select(payload.row, payload.col);
      }
      setMenu(payload);
      // 焦点交还网格：菜单项执行后（例如"清空内容"）用户会直接按 Ctrl+Z，
      // 焦点若停在已卸载的菜单按钮上，快捷键会丢失（撤销看起来"没生效"）
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(".grid-shell")?.focus();
      });
    },
    [sheetApi],
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    const editable = sheetApi.editable;
    const sep = (key: string): MenuItem => ({ key, separator: true });
    const items: MenuItem[] = [];

    if (menu.target === "row") {
      items.push(
        {
          key: "row-insert-above",
          label: "在上方插入行",
          disabled: !editable,
          onSelect: () => sheetApi.insertRowAt(menu.row ?? 0, true),
        },
        {
          key: "row-insert-below",
          label: "在下方插入行",
          disabled: !editable,
          onSelect: () => sheetApi.insertRowAt(menu.row ?? 0, false),
        },
        {
          key: "row-delete",
          label: `删除选中行${rangeInfo.rows > 1 ? `（${rangeInfo.rows} 行）` : ""}`,
          disabled: !editable,
          danger: true,
          onSelect: () => sheetApi.deleteRowAt(menu.row ?? 0),
        },
        sep("row-sep"),
        { key: "row-clear-format", label: "清除行格式", disabled: !editable, onSelect: () => sheetApi.clearFormat() },
      );
      return items;
    }

    if (menu.target === "col") {
      items.push(
        { key: "col-insert-left", label: "在左侧插入列", disabled: !editable, onSelect: () => sheetApi.insertColAt(menu.col ?? 0, true) },
        { key: "col-insert-right", label: "在右侧插入列", disabled: !editable, onSelect: () => sheetApi.insertColAt(menu.col ?? 0, false) },
        {
          key: "col-delete",
          label: `删除选中列${rangeInfo.cols > 1 ? `（${rangeInfo.cols} 列）` : ""}`,
          disabled: !editable,
          danger: true,
          onSelect: () => sheetApi.deleteColAt(menu.col ?? 0),
        },
        sep("col-sep"),
        { key: "col-clear-format", label: "清除列格式", disabled: !editable, onSelect: () => sheetApi.clearFormat() },
      );
      return items;
    }

    // 单元格 / 矩形选区
    items.push(
      { key: "copy", label: "复制", hint: "Ctrl+C", onSelect: () => sheetApi.copySelection(false) },
      { key: "cut", label: "剪切", hint: "Ctrl+X", disabled: !editable, onSelect: () => sheetApi.copySelection(true) },
      sep("clip-sep"),
      {
        key: "clear-value",
        label: "清空内容",
        hint: "Delete",
        disabled: !editable,
        onSelect: () => {
          const r = sheetApi.targetRange();
          sheetApi.clearRange(r.r0, r.c0, r.r1, r.c1);
        },
      },
      {
        key: "clear-format",
        label: "清除格式",
        disabled: !editable,
        onSelect: () => sheetApi.clearFormat(),
      },
      sep("fmt-sep"),
      {
        key: "bold",
        label: selectedFormat.bold ? "取消加粗" : "加粗",
        hint: "B",
        disabled: !editable,
        onSelect: () => sheetApi.toggleStyle("bold"),
      },
      sep("numfmt-sep"),
      ...(Object.keys(NUMBER_FORMAT_LABELS) as NumberFormat[]).map((key) => ({
        key: `numfmt-${key}`,
        label: `数字格式：${NUMBER_FORMAT_LABELS[key]}`,
        disabled: !editable,
        onSelect: () => sheetApi.applyFormat({ numFmt: key }),
      })),
      sep("border-sep"),
      {
        key: "border-all",
        label: "四边加边框",
        disabled: !editable,
        onSelect: () => sheetApi.applyFormat({ borders: { top: true, right: true, bottom: true, left: true } }),
      },
      {
        key: "border-none",
        label: "清除边框",
        disabled: !editable,
        onSelect: () => sheetApi.applyFormat({ borders: { top: false, right: false, bottom: false, left: false } }),
      },
      sep("struct-sep"),
      { key: "row-insert", label: "在选中行上方插入行", disabled: !editable, onSelect: () => sheetApi.insertRow() },
      { key: "row-delete", label: "删除选中行", disabled: !editable, danger: true, onSelect: () => sheetApi.deleteRow() },
      { key: "col-insert", label: "在选中列左侧插入列", disabled: !editable, onSelect: () => sheetApi.insertCol() },
      { key: "col-delete", label: "删除选中列", disabled: !editable, danger: true, onSelect: () => sheetApi.deleteCol() },
      sep("comment-sep"),
      {
        key: "comment",
        label: "添加评论 / @提醒",
        onSelect: () => {
          sheetApi.select(sheetApi.state.selected.row, sheetApi.state.selected.col);
          setPanel("comments");
        },
      },
      {
        key: "freeze-here",
        label: "冻结到当前单元格",
        onSelect: () => sheetApi.freeze(),
      },
    );
    return items;
  }, [menu, rangeInfo.cols, rangeInfo.rows, selectedFormat.bold, sheetApi]);

  const notify = useMemo(() => (message: string) => setToast(message), []);

  /**
   * 填充柄（REQ-006）：按住右下角小方块拖动。
   *
   * 拖拽期间只算"目标矩形"用于预览；松手时一次性调用 fillRange，
   * 由它按源数据推断序列（数字等差 / 日期 / 公式相对引用 / 文本复制）。
   */
  const fillStateRef = useRef<{ source: { r0: number; c0: number; r1: number; c1: number } } | null>(null);

  const onFillStart = useCallback(() => {
    fillStateRef.current = { source: sheetApi.targetRange() };
    setFillPreview(null);
  }, [sheetApi]);

  const onFillMove = useCallback((row: number, col: number) => {
    const state = fillStateRef.current;
    if (!state) return;
    const { source } = state;
    // 纵向优先：鼠标超出行范围 → 向下/向上填充；否则横向
    let target = { ...source };
    if (row > source.r1) target = { ...source, r1: row };
    else if (row < source.r0) target = { ...source, r0: row };
    else if (col > source.c1) target = { ...source, c1: col };
    else if (col < source.c0) target = { ...source, c0: col };
    setFillPreview(target);
  }, []);

  const onFillEnd = useCallback(() => {
    const state = fillStateRef.current;
    const target = fillPreview;
    fillStateRef.current = null;
    setFillPreview(null);
    if (!state || !target) return;
    if (
      target.r0 === state.source.r0 &&
      target.r1 === state.source.r1 &&
      target.c0 === state.source.c0 &&
      target.c1 === state.source.c1
    ) {
      return; // 没拖动，什么也不做
    }
    sheetApi.fillRange(state.source, target, { series: true, format: true });
    const hint = describeFill(
      Array.from(
        { length: state.source.r1 - state.source.r0 + 1 },
        (_, i) => sheetApi.state.cells[cellKey(state.source.r0 + i, state.source.c0)] ?? "",
      ),
    );
    notify(`${hint}：${target.r1 - target.r0 + 1} 行 × ${target.c1 - target.c0 + 1} 列`);
  }, [fillPreview, notify, sheetApi]);

  useEffect(() => {
    if (sheetApi.state.error) {
      notify(sheetApi.state.error);
      sheetApi.dismissError();
    }
  }, [sheetApi, notify]);
  useEffect(() => {
    if (comments.error) {
      notify(comments.error);
      comments.clearError();
    }
  }, [comments, notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const selectedCellIds = useMemo(() => {
    const { selected, rowIds, colIds } = sheetApi.state;
    return {
      row: selected.row,
      col: selected.col,
      rowId: rowIds[selected.row] ?? "",
      colId: colIds[selected.col] ?? "",
      ref: `${String.fromCharCode(65 + Math.min(25, selected.col))}${selected.row + 1}`,
    };
  }, [sheetApi.state]);

  /** 在网格里定位到某个元素 ID 对应的行列（评论「定位」用）。 */
  const jumpToCell = useCallback(
    (rowId: string, colId: string) => {
      const { rowIds, colIds } = sheetApi.state;
      const row = rowIds.indexOf(rowId);
      const col = colIds.indexOf(colId);
      if (row >= 0 && col >= 0) sheetApi.select(row, col);
    },
    [sheetApi],
  );

  /** Excel 导入（REQ-050）：先解析出工作表列表，多表时让用户选择。 */
  const importXlsx = useCallback(
    async (file: File) => {
      const sheetId = sheetApi.state.sheetId;
      if (!sheetId) return;
      try {
        const parsed = await api.parseXlsx(sheetId, file);
        let target = parsed.sheet_name;
        if (parsed.sheet_names.length > 1) {
          const answer = window.prompt(
            `该工作簿包含 ${parsed.sheet_names.length} 个工作表，请输入要导入的名称：\n${parsed.sheet_names.join("、")}`,
            parsed.sheet_name,
          );
          if (answer === null) return;
          target = answer.trim() || parsed.sheet_name;
        }
        const updated = await api.importXlsx(sheetId, file, target);
        // 导入后以服务端权威数据刷新（同时更新表格名/角色等元信息）
        setSheet(await api.getSheet(sheetId));
        await refreshList();
        setFilters([]);
        setValueFilters([]);
        setSorts([]);
        notify(
          `已从「${updated.sheet_name}」导入 ${updated.rows} 行 × ${updated.cols} 列` +
            (updated.skipped_long_cells ? `，跳过 ${updated.skipped_long_cells} 个超长单元格` : ""),
        );
      } catch (err) {
        notify(String((err as Error).message ?? err));
      }
    },
    [notify, refreshList, sheetApi.state.sheetId],
  );

  /** Excel 导出（REQ-050）：保留公式与样式，冻结窗格一并带出。 */
  const exportXlsx = useCallback(async () => {    const sheetId = sheetApi.state.sheetId;
    if (!sheetId) return;
    try {
      await api.exportXlsx(sheetId, `${sheetApi.state.sheetName || "表格"}.xlsx`, {
        frozen_rows: sheetApi.state.frozenRows,
        frozen_cols: sheetApi.state.frozenCols,
      });
      notify("已导出 .xlsx（公式由 Excel 计算，样式与冻结窗格已保留）");
    } catch (err) {
      notify(String((err as Error).message ?? err));
    }
  }, [notify, sheetApi.state.frozenCols, sheetApi.state.frozenRows, sheetApi.state.sheetId, sheetApi.state.sheetName]);

  /** 删除当前表格（仅所有者）：删完切到列表里的下一张表。 */
  const deleteCurrentSheet = useCallback(async () => {
    const sheetId = sheetApi.state.sheetId;
    const name = sheetApi.state.sheetName || "该表格";
    if (!sheetId) return;
    if (!window.confirm(`确定删除「${name}」吗？表格内容、版本历史与评论都会一并删除，且不可恢复。`)) return;
    try {
      await api.deleteSheet(sheetId);
      const rest = await api.listSheets();
      setSheets(rest);
      setSheet(rest.length ? await api.getSheet(rest[0].id) : null);
      setFilters([]);
      setValueFilters([]);
      setSorts([]);
      notify(`已删除「${name}」`);
    } catch (err) {
      notify(String((err as Error).message ?? err));
    }
  }, [notify, sheetApi.state.sheetId, sheetApi.state.sheetName]);

  if (!token) {
    return (
      <>
        <LoginScreen onLogin={handleLogin} initialError={appError} />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  return (
    <div className="app">
      <Toolbar
        canUndo={sheetApi.canUndo}
        canRedo={sheetApi.canRedo}
        onUndo={sheetApi.undo}
        onRedo={sheetApi.redo}
        onNewSheet={newSheet}
        sheetName={sheetApi.state.sheetName || "未选择表格"}
        role={role}
        format={selectedFormat}
        onToggleStyle={sheetApi.toggleStyle}
        onAlign={(align) => sheetApi.applyFormat({ align })}
        onColor={(kind, color) => sheetApi.applyFormat(kind === "color" ? { color } : { bg: color })}
        onFont={(font) => sheetApi.applyFormat({ font: font === "系统默认" ? "" : font })}
        onFontSize={(size) => sheetApi.applyFormat({ size })}
        onNumberFormat={(numFmt) => sheetApi.applyFormat({ numFmt })}
        onBorders={(borders) => sheetApi.applyFormat({ borders })}
        onClearFormat={sheetApi.clearFormat}
        rangeLabel={rangeLabel}
        onInsertRow={sheetApi.insertRow}
        onDeleteRow={sheetApi.deleteRow}
        onInsertCol={sheetApi.insertCol}
        onDeleteCol={sheetApi.deleteCol}
        onImport={sheetApi.importCsv}
        onExport={sheetApi.exportCsv}
        onImportXlsx={() => xlsxRef.current?.click()}
        onExportXlsx={() => void exportXlsx()}
        frozen={sheetApi.state.frozenRows > 0 || sheetApi.state.frozenCols > 0}
        onFreeze={sheetApi.freeze}
        onUnfreeze={sheetApi.unfreeze}
        onShowVersions={() => setPanel(panel === "versions" ? "none" : "versions")}
        onShowPermissions={() => setPanel(panel === "permissions" ? "none" : "permissions")}
        onShowComments={() => setPanel(panel === "comments" ? "none" : "comments")}
        onShowView={() => setPanel(panel === "view" ? "none" : "view")}
        commentCount={comments.openCount}
        viewActive={Boolean(filters.length || valueFilters.length || sorts.length)}
        canDeleteSheet={role === "owner" && Boolean(sheetApi.state.sheetId)}
        onDeleteSheet={() => void deleteCurrentSheet()}
        onLogout={handleLogout}
        status={sheetApi.state.status}
        userName={userName}
      />
      <input
        ref={xlsxRef}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void importXlsx(file);
          e.target.value = "";
        }}
      />

      <div className="sheet-bar">
        <span className="sheet-bar-label">我的表格：</span>
        {sheets.map((item) => (
          <button
            key={item.id}
            className={`sheet-tab${item.id === sheetApi.state.sheetId ? " active" : ""}`}
            onClick={() => void openSheet(item.id)}
            title={`角色：${item.role ?? "无权限"}`}
          >
            {item.name}
            <span className="muted"> · {item.role ?? "-"}</span>
          </button>
        ))}
        {sheets.length === 0 && <span className="muted">还没有表格，点击「＋ 新建表格」开始</span>}
      </div>

      <FormulaBar
        selected={sheetApi.state.selected}
        rawValue={rawValue}
        readOnly={!sheetApi.editable}
        format={selectedFormat}
        cells={sheetApi.state.cells}
        rows={sheetApi.state.rows}
        cols={sheetApi.state.cols}
        onStart={() =>
          sheetApi.startFormulaEdit(sheetApi.state.selected.row, sheetApi.state.selected.col, rawValue)
        }
        onDraft={sheetApi.setDraft}
        onCommit={() =>
          sheetApi.commitCell(sheetApi.state.selected.row, sheetApi.state.selected.col, sheetApi.state.draft)
        }
        onCancel={sheetApi.cancelEdit}
      />
      <PresenceBar users={sheetApi.state.users} cursors={sheetApi.state.cursors} self={userName} />

      {panel === "versions" && sheetApi.state.sheetId && (
        <VersionsPanel
          sheetId={sheetApi.state.sheetId}
          currentVersion={sheetApi.state.version}
          canEdit={sheetApi.editable}
          onClose={() => setPanel("none")}
          onRestored={() => {
            void reloadSheet();
            void refreshList();
          }}
          onError={notify}
        />
      )}
      {panel === "permissions" && sheetApi.state.sheetId && (
        <PermissionsPanel sheetId={sheetApi.state.sheetId} onClose={() => setPanel("none")} onError={notify} />
      )}
      {panel === "comments" && sheetApi.state.sheetId && (
        <CommentsPanel
          comments={mergedComments.comments}
          members={mergedComments.members}
          selected={selectedCellIds}
          canComment={canComment}
          self={userName}
          onAdd={mergedComments.add}
          onResolve={mergedComments.resolve}
          onRemove={mergedComments.remove}
          onClose={() => setPanel("none")}
          onJump={jumpToCell}
        />
      )}
      {panel === "view" && sheetApi.state.sheetId && (
        <ViewPanel
          cols={sheetApi.state.cols}
          rows={sheetApi.state.rows}
          cells={sheetApi.state.cells}
          filters={filters}
          valueFilters={valueFilters}
          sorts={sorts}
          visibleRows={rowOrder ? rowOrder.length : sheetApi.state.rows}
          totalRows={sheetApi.state.rows}
          onSorts={setSorts}
          onFilters={setFilters}
          onValueFilters={setValueFilters}
          onClose={() => setPanel("none")}
        />
      )}

      {sheetApi.state.loading && <div className="loading">加载中…</div>}
      {!sheetApi.state.loading && sheetApi.state.sheetId && (
        <Grid
          cells={sheetApi.state.cells}
          formats={sheetApi.state.formats}
          rows={sheetApi.state.rows}
          cols={sheetApi.state.cols}
          selected={sheetApi.state.selected}
          anchor={sheetApi.state.anchor}
          selectionKind={sheetApi.state.selectionKind}
          editing={sheetApi.state.editing}
          draft={sheetApi.state.draft}
          cursors={sheetApi.state.cursors}
          frozenRows={sheetApi.state.frozenRows}
          frozenCols={sheetApi.state.frozenCols}
          self={userName}
          readOnly={!sheetApi.editable}
          onSelect={sheetApi.select}
          onExtendSelect={sheetApi.extendSelect}
          onSelectAll={sheetApi.selectAll}
          onSelectRow={sheetApi.selectRow}
          onSelectCol={sheetApi.selectCol}
          onRangeInfoChange={setRangeInfo}
          onClearRange={sheetApi.clearRange}
          onStartEdit={sheetApi.startEdit}
          onDraft={sheetApi.setDraft}
          onCommit={sheetApi.commitCell}
          onCancel={sheetApi.cancelEdit}
          onMove={sheetApi.select}
          onPaste={sheetApi.pasteBlock}
          onUndo={sheetApi.undo}
          onRedo={sheetApi.redo}
          rowOrder={rowOrder}
          commentCounts={mergedComments.counts}
          rowIds={sheetApi.state.rowIds}
          colIds={sheetApi.state.colIds}
          onOpenComments={(row, col) => {
            sheetApi.select(row, col);
            setPanel("comments");
          }}
          onContextMenu={openContextMenu}
          fillPreview={fillPreview}
          onFillStart={onFillStart}
          onFillMove={onFillMove}
          onFillEnd={onFillEnd}
          fillEnabled={sheetApi.editable}
        />
      )}
      {!sheetApi.state.loading && !sheetApi.state.sheetId && (
        <div className="loading">请选择或新建一个表格</div>
      )}

      {appError && (
        <div className="error" onClick={() => setAppError(null)}>
          {appError}（点击关闭）
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
      {/* 右键菜单（REQ-005） */}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />}
    </div>
  );
}

function LoginScreen({ onLogin, initialError }: { onLogin: (token: string, name: string) => void; initialError: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(username.trim(), password);
      onLogin(session.token, session.username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1>在线协同表格</h1>
        <p className="muted">JWT 鉴权 + 表格级 RBAC。首次登录会按用户名自动注册（开发模式）。</p>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          口令
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="muted login-hint">
          初始管理员由服务端启动时创建（口令见启动日志或 <code>OE_ADMIN_PASSWORD</code>）。
        </p>
      </form>
    </div>
  );
}
