import { useRef } from "react";
import type { CellFormat } from "../types";

interface Props {
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onNewSheet: () => void;
  sheetName: string;
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
}

export default function Toolbar(props: Props) {
  const f = props.format;
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="toolbar">
      <button onClick={props.onUndo} disabled={!props.canUndo} title="撤销 (Ctrl+Z)">↶ 撤销</button>
      <button onClick={props.onRedo} disabled={!props.canRedo} title="重做 (Ctrl+Shift+Z)">↷ 重做</button>
      <span className="divider"></span>
      <button className={f.bold ? "active" : ""} onClick={() => props.onToggleStyle("bold")} title="加粗">B</button>
      <button className={f.italic ? "active" : ""} onClick={() => props.onToggleStyle("italic")} title="斜体">I</button>
      <button className={f.underline ? "active" : ""} onClick={() => props.onToggleStyle("underline")} title="下划线">U</button>
      <span className="divider"></span>
      <button className={f.align === "left" ? "active" : ""} onClick={() => props.onAlign("left")} title="左对齐">⬅</button>
      <button className={f.align === "center" ? "active" : ""} onClick={() => props.onAlign("center")} title="居中">↔</button>
      <button className={f.align === "right" ? "active" : ""} onClick={() => props.onAlign("right")} title="右对齐">➡</button>
      <label className="color-pick" title="文字颜色">
        <input type="color" value={f.color || "#000000"} onChange={(e) => props.onColor("color", e.target.value)} />
        字色
      </label>
      <label className="color-pick" title="背景色">
        <input type="color" value={f.bg || "#ffffff"} onChange={(e) => props.onColor("bg", e.target.value)} />
        底色
      </label>
      <span className="divider"></span>
      <button onClick={props.onInsertRow} title="在选中行上方插入行">＋行</button>
      <button onClick={props.onDeleteRow} title="删除选中行">－行</button>
      <button onClick={props.onInsertCol} title="在选中列左侧插入列">＋列</button>
      <button onClick={props.onDeleteCol} title="删除选中列">－列</button>
      <span className="divider"></span>
      {props.frozen ? (
        <button onClick={props.onUnfreeze} title="取消冻结">取消冻结</button>
      ) : (
        <button onClick={props.onFreeze} title="冻结当前选中位置上方行与左侧列">冻结窗格</button>
      )}
      <button onClick={() => fileRef.current?.click()} title="从 CSV 导入，覆盖当前表格">导入 CSV</button>
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
      <button onClick={props.onExport} title="导出当前表格为 CSV">导出 CSV</button>
      <span className="divider"></span>
      <span className="sheet-name">{props.sheetName}</span>
      <button onClick={props.onNewSheet} title="新建表格">＋ 新建表格</button>
    </div>
  );
}
