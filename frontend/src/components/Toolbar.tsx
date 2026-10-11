import { useRef } from "react";
import type { CellBorders, CellFormat, NumberFormat, Role } from "../types";
import { FONT_FAMILIES, FONT_SIZES, NUMBER_FORMAT_LABELS } from "../types";

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onNewSheet: () => void;
  sheetName: string;
  role: Role | null;
  format: CellFormat;
  onToggleStyle: (key: "bold" | "italic" | "underline" | "strike") => void;
  onAlign: (align: "left" | "center" | "right") => void;
  onColor: (kind: "color" | "bg", color: string) => void;
  /** 字体族 / 字号 / 数字格式 / 边框（REQ-007）。 */
  onFont: (font: string) => void;
  onFontSize: (size: number) => void;
  onNumberFormat: (numFmt: NumberFormat) => void;
  onBorders: (borders: CellBorders) => void;
  onClearFormat: () => void;
  /** 当前选区描述，例如 "4×3" 或 "整行 2 行"。 */
  rangeLabel: string;
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertCol: () => void;
  onDeleteCol: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  onImportXlsx: () => void;
  onExportXlsx: () => void;
  frozen: boolean;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onShowVersions: () => void;
  onShowPermissions: () => void;
  onShowComments: () => void;
  onShowView: () => void;
  commentCount: number;
  viewActive: boolean;
  canDeleteSheet: boolean;
  onDeleteSheet: () => void;
  onLogout: () => void;
  status: "connecting" | "open" | "closed";
  userName: string;
}

export default function Toolbar(props: Props) {
  const f = props.format;
  const fileRef = useRef<HTMLInputElement>(null);
  const editable = props.role === "owner" || props.role === "editor";
  const manageable = props.role === "owner";

  return (
    <div className="toolbar">
      <button onClick={props.onUndo} disabled={!props.canUndo || !editable} title="撤销 (Ctrl+Z)">
        ↶ 撤销
      </button>
      <button onClick={props.onRedo} disabled={!props.canRedo || !editable} title="重做 (Ctrl+Shift+Z)">
        ↷ 重做
      </button>
      <span className="divider" />
      <select
        className="fmt-select"
        disabled={!editable}
        value={f.font && FONT_FAMILIES.includes(f.font as (typeof FONT_FAMILIES)[number]) ? f.font : "系统默认"}
        onChange={(e) => props.onFont(e.target.value)}
        title="字体"
      >
        {FONT_FAMILIES.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <select
        className="fmt-select size"
        disabled={!editable}
        value={f.size ?? 12}
        onChange={(e) => props.onFontSize(Number(e.target.value))}
        title="字号"
      >
        {FONT_SIZES.map((size) => (
          <option key={size} value={size}>
            {size}
          </option>
        ))}
      </select>
      <span className="divider" />
      <button className={f.bold ? "active" : ""} disabled={!editable} onClick={() => props.onToggleStyle("bold")} title="加粗">
        B
      </button>
      <button className={f.italic ? "active" : ""} disabled={!editable} onClick={() => props.onToggleStyle("italic")} title="斜体">
        I
      </button>
      <button
        className={f.underline ? "active" : ""}
        disabled={!editable}
        onClick={() => props.onToggleStyle("underline")}
        title="下划线"
      >
        U
      </button>
      <button className={f.strike ? "active" : ""} disabled={!editable} onClick={() => props.onToggleStyle("strike")} title="删除线">
        S
      </button>
      <span className="divider" />
      <button className={f.align === "left" ? "active" : ""} disabled={!editable} onClick={() => props.onAlign("left")} title="左对齐">
        ⬅
      </button>
      <button className={f.align === "center" ? "active" : ""} disabled={!editable} onClick={() => props.onAlign("center")} title="居中">
        ↔
      </button>
      <button className={f.align === "right" ? "active" : ""} disabled={!editable} onClick={() => props.onAlign("right")} title="右对齐">
        ➡
      </button>
      <label className="color-pick" title="文字颜色">
        <input
          type="color"
          disabled={!editable}
          value={f.color || "#000000"}
          onChange={(e) => props.onColor("color", e.target.value)}
        />
        字色
      </label>
      <label className="color-pick" title="背景色">
        <input type="color" disabled={!editable} value={f.bg || "#ffffff"} onChange={(e) => props.onColor("bg", e.target.value)} />
        底色
      </label>
      <span className="divider" />
      {/* 边框：四个方向独立开关，作用于整个选区 */}
      <span className="border-group" title="边框（作用于整个选区）">
        {(
          [
            ["top", "上"],
            ["right", "右"],
            ["bottom", "下"],
            ["left", "左"],
          ] as Array<[keyof CellBorders, string]>
        ).map(([side, label]) => (
          <button
            key={side}
            className={f.borders?.[side] ? "active" : ""}
            disabled={!editable}
            onClick={() => props.onBorders({ ...(f.borders ?? {}), [side]: !f.borders?.[side] })}
            title={`${label}边框`}
          >
            {label}
          </button>
        ))}
        <button
          disabled={!editable}
          onClick={() => props.onBorders({ top: true, right: true, bottom: true, left: true })}
          title="四边全加边框"
        >
          全
        </button>
        <button
          disabled={!editable}
          onClick={() => props.onBorders({ top: false, right: false, bottom: false, left: false })}
          title="清除边框"
        >
          无
        </button>
      </span>
      <select
        className="fmt-select"
        disabled={!editable}
        value={f.numFmt ?? "general"}
        onChange={(e) => props.onNumberFormat(e.target.value as NumberFormat)}
        title="数字/日期格式（只影响显示，不改原始值）"
      >
        {(Object.keys(NUMBER_FORMAT_LABELS) as NumberFormat[]).map((key) => (
          <option key={key} value={key}>
            {NUMBER_FORMAT_LABELS[key]}
          </option>
        ))}
      </select>
      <button disabled={!editable} onClick={() => props.onClearFormat()} title="清除选区格式">
        清格式
      </button>
      <span className="range-label" title="当前选区">
        {props.rangeLabel}
      </span>
      <span className="divider" />
      <button onClick={props.onInsertRow} disabled={!editable} title="在选中行上方插入行">
        ＋行
      </button>
      <button onClick={props.onDeleteRow} disabled={!editable} title="删除选中行">
        －行
      </button>
      <button onClick={props.onInsertCol} disabled={!editable} title="在选中列左侧插入列">
        ＋列
      </button>
      <button onClick={props.onDeleteCol} disabled={!editable} title="删除选中列">
        －列
      </button>
      <span className="divider" />
      {props.frozen ? (
        <button onClick={props.onUnfreeze} title="取消冻结">
          取消冻结
        </button>
      ) : (
        <button onClick={props.onFreeze} title="冻结当前选中位置上方行与左侧列">
          冻结窗格
        </button>
      )}
      <button onClick={() => fileRef.current?.click()} disabled={!editable} title="从 CSV 导入，覆盖当前表格">
        导入 CSV
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".csv,text/csv"
        style={{ display: "none" }}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) props.onImport(file);
          e.target.value = "";
        }}
      />
      <button onClick={props.onExport} title="导出当前表格为 CSV">
        导出 CSV
      </button>
      <span className="divider" />
      <button onClick={props.onImportXlsx} disabled={!editable} title="从 Excel(.xlsx) 导入，覆盖当前表格">
        导入 Excel
      </button>
      <button onClick={props.onExportXlsx} title="导出为 Excel(.xlsx)：保留公式、样式与冻结窗格">
        导出 Excel
      </button>
      <span className="divider" />
      <button
        className={props.viewActive ? "active" : ""}
        onClick={props.onShowView}
        title="筛选与排序（仅影响本端显示）"
      >
        筛选排序{props.viewActive ? " ●" : ""}
      </button>
      <button
        className={props.commentCount > 0 ? "active" : ""}
        onClick={props.onShowComments}
        title="评论与 @提醒"
      >
        评论{props.commentCount > 0 ? ` ${props.commentCount}` : ""}
      </button>
      <span className="divider" />
      <button onClick={props.onShowVersions} title="查看历史版本与对比">
        历史版本
      </button>
      <button onClick={props.onShowPermissions} disabled={!manageable} title="成员与角色管理">
        成员权限
      </button>
      <span className="divider" />
      <span className="sheet-name">{props.sheetName}</span>
      <button onClick={props.onNewSheet} title="新建表格">
        ＋ 新建表格
      </button>
      <button onClick={props.onDeleteSheet} disabled={!props.canDeleteSheet} title="删除当前表格（仅所有者，不可恢复）">
        删除表格
      </button>
      <span className={`conn conn-${props.status}`} title={`连接状态：${props.status}`}>
        {props.status === "open" ? "已连接" : props.status === "connecting" ? "连接中" : "已断开"}
      </span>
      <span className="toolbar-user">
        {props.userName}（{props.role ?? "无权限"}）
      </span>
      <button onClick={props.onLogout} title="退出登录">
        退出
      </button>
    </div>
  );
}
