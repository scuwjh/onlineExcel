import { useRef } from "react";
import type { CellFormat, Role } from "../types";

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onNewSheet: () => void;
  sheetName: string;
  role: Role | null;
  format: CellFormat;
  onToggleStyle: (key: "bold" | "italic" | "underline") => void;
  onAlign: (align: "left" | "center" | "right") => void;
  onColor: (kind: "color" | "bg", color: string) => void;
  onInsertRow: () => void;
  onDeleteRow: () => void;
  onInsertCol: () => void;
  onDeleteCol: () => void;
  onImport: (file: File) => void;
  onExport: () => void;
  frozen: boolean;
  onFreeze: () => void;
  onUnfreeze: () => void;
  onShowVersions: () => void;
  onShowPermissions: () => void;
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
