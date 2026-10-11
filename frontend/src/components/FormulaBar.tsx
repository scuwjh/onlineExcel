/**
 * 公式栏（REQ-009）。
 *
 * 能力：
 * - **实时计算**：输入时即显示求值结果（错误显示为 `#ERROR` 并给出提示）；
 * - **函数提示**：输入 `=` 或函数名前缀时弹出可用函数与参数签名（↑↓ 选择、Tab/Enter 补全）；
 * - **引用高亮**：公式里的 `A1`/`A1:B2` 按顺序着色，并在提示区列出各引用的当前值；
 * - **错误检查**：括号不配对、引用越界、循环引用等给出可读提示。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cellKey, parseCellRef, refOf } from "../lib/gridUtils";
import { evaluate, isFormula } from "../lib/formula";
import {
  FORMULA_OPERATORS,
  REFERENCE_COLORS,
  extractReferences,
  functionQueryAt,
  isValidReference,
  referenceQueryAt,
  suggestFunctions,
} from "../lib/formulaFunctions";
import type { CellFormat, Cells } from "../types";
import { formatCellDisplay } from "../lib/cellDisplay";

interface Props {
  selected: { row: number; col: number };
  rawValue: string;
  readOnly: boolean;
  format?: CellFormat;
  /** 整表数据：用于求值、引用取值与越界检查。 */
  cells?: Cells;
  rows?: number;
  cols?: number;
  onStart: () => void;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export default function FormulaBar({
  selected,
  rawValue,
  readOnly,
  format,
  cells = {},
  rows = 0,
  cols = 0,
  onStart,
  onDraft,
  onCommit,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // 用户按 Esc / 选择后暂时收起提示；再次输入会重新出现
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);

  const text = rawValue ?? "";
  const formula = isFormula(text);

  const suggestions = useMemo(() => suggestFunctions(functionQueryAt(text, caret)), [text, caret]);
  const references = useMemo(() => (formula ? extractReferences(text) : []), [formula, text]);

  /** 错误检查：括号配对、引用合法性/越界、循环引用、求值失败。 */
  const issues = useMemo(() => {
    const out: string[] = [];
    if (!formula) return out;
    const body = text.slice(1);
    let depth = 0;
    for (const ch of body) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (depth < 0) break;
    }
    if (depth > 0) out.push("括号未闭合");
    else if (depth < 0) out.push("括号多余");

    const pending = referenceQueryAt(text, caret);
    if (pending && !isValidReference(pending)) out.push(`引用不完整：${pending}`);

    for (const item of references) {
      try {
        const ref = item.ref.includes(":") ? item.ref.split(":")[0] : item.ref;
        const pos = parseCellRef(ref);
        if (rows && pos.row >= rows) out.push(`${ref} 超出表格行数（共 ${rows} 行）`);
        if (cols && pos.col >= cols) out.push(`${ref} 超出表格列数（共 ${cols} 列）`);
      } catch {
        out.push(`无法解析引用：${item.ref}`);
      }
    }
    const result = evaluate(text, cells);
    if (result === "#ERROR") out.push("求值失败（可能是循环引用、类型不匹配或不支持的操作）");
    return [...new Set(out)];
  }, [caret, cells, cols, formula, references, rows, text]);

  const result = useMemo(() => (formula ? evaluate(text, cells) : ""), [cells, formula, text]);

  /** 引用取值预览（最多列出 4 个，避免提示区过长）。 */
  const referencePreview = useMemo(() => {
    return references.slice(0, 4).map((item, index) => {
      let preview = "";
      try {
        if (item.ref.includes(":")) {
          const [a, b] = item.ref.split(":");
          const start = parseCellRef(a);
          const end = parseCellRef(b);
          let count = 0;
          for (let r = start.row; r <= end.row; r++) {
            for (let c = start.col; c <= end.col; c++) {
              if ((cells[cellKey(r, c)] ?? "") !== "") count++;
            }
          }
          preview = `${(end.row - start.row + 1) * (end.col - start.col + 1)} 格（非空 ${count}）`;
        } else {
          const pos = parseCellRef(item.ref);
          const value = evaluate(cells[cellKey(pos.row, pos.col)] ?? null, cells);
          preview = value === "" ? "（空白）" : value;
        }
      } catch {
        preview = "?";
      }
      return { ...item, preview, color: REFERENCE_COLORS[index % REFERENCE_COLORS.length] };
    });
  }, [cells, references]);

  const insertSuggestion = useCallback(
    (name: string) => {
      const input = inputRef.current;
      const query = functionQueryAt(text, caret) ?? "";
      const start = caret - query.length;
      const next = `${text.slice(0, start)}${name}(${text.slice(caret)}`;
      onDraft(next);
      setSuggestionsOpen(false);
      const nextCaret = start + name.length + 1;
      requestAnimationFrame(() => {
        input?.focus();
        input?.setSelectionRange(nextCaret, nextCaret);
        setCaret(nextCaret);
      });
    },
    [caret, onDraft, text],
  );

  // 用户按 Esc / 选择后暂时收起提示；再次输入会重新出现
  useEffect(() => setSuggestionsOpen(true), [text]);
  useEffect(() => setHighlight(0), [text]);

  const showSuggestions = focused && suggestionsOpen && !readOnly && suggestions.length > 0;

  /** 公式着色渲染（引用按出现顺序上色）。 */
  const renderHighlighted = () => {
    if (!formula) return <span>{text}</span>;
    const nodes: React.ReactNode[] = [];
    let last = 0;
    references.forEach((item, index) => {
      if (item.start > last) nodes.push(<span key={`t${last}`}>{text.slice(last, item.start)}</span>);
      const color = REFERENCE_COLORS[index % REFERENCE_COLORS.length];
      nodes.push(
        <span key={`r${item.start}`} className="formula-ref-token" style={{ color, borderBottom: `2px solid ${color}` }}>
          {text.slice(item.start, item.end)}
        </span>,
      );
      last = item.end;
    });
    if (last < text.length) nodes.push(<span key={`t${last}`}>{text.slice(last)}</span>);
    return <>{nodes}</>;
  };

  const refLabel = refOf(selected.row, selected.col);

  return (
    <div className={`formula-bar${issues.length ? " has-issue" : ""}`}>
      <div className="formula-ref" title="当前单元格">
        {refLabel}
      </div>
      <div className="formula-input-wrap">
        <input
          ref={inputRef}
          className="formula-input"
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          onFocus={() => {
            setFocused(true);
            onStart();
          }}
          onBlur={() => window.setTimeout(() => setFocused(false), 120)}
          onChange={(e) => {
            onDraft(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onClick={(e) => setCaret((e.target as HTMLInputElement).selectionStart ?? 0)}
          onKeyDown={(e) => {
            if (showSuggestions) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => Math.min(suggestions.length - 1, h + 1));
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => Math.max(0, h - 1));
                return;
              }
              if (e.key === "Tab" || (e.key === "Enter" && suggestions[highlight] && !e.shiftKey)) {
                e.preventDefault();
                insertSuggestion(suggestions[highlight].name);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setSuggestionsOpen(false);
                return;
              }
            }
            if (e.key === "Enter") {
              e.preventDefault();
              onCommit();
              inputRef.current?.blur();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onCancel();
              inputRef.current?.blur();
            }
          }}
          placeholder={readOnly ? "只读：当前角色不可编辑" : "输入值或公式，如 =SUM(A1:B2)"}
        />
        {/* 着色层：与输入框同字体同位置，仅在有公式时显示 */}
        {formula && (
          <div className="formula-highlight" aria-hidden="true">
            {renderHighlighted()}
          </div>
        )}
      </div>

      <div className="formula-meta">
        {formula && (
          <span className={`formula-result${result === "#ERROR" ? " error" : ""}`} title="实时计算结果">
            = {formatCellDisplay(result, format) || "（空）"}
          </span>
        )}
        {issues.length > 0 && (
          <span className="formula-issue" title={issues.join("；")}>
            ⚠ {issues[0]}
            {issues.length > 1 ? ` 等 ${issues.length} 项` : ""}
          </span>
        )}
      </div>

      {showSuggestions && (
        <div className="formula-hints">
          <div className="hint-title">函数（↑↓ 选择，Tab/Enter 补全）</div>
          {suggestions.map((fn, index) => (
            <button
              key={fn.name}
              className={index === highlight ? "active" : ""}
              onMouseDown={(e) => {
                e.preventDefault();
                insertSuggestion(fn.name);
              }}
            >
              <code>
                {fn.name}({fn.signature})
              </code>
              <span className="muted"> {fn.description}</span>
              <em>{fn.example}</em>
            </button>
          ))}
          {functionQueryAt(text, caret) === "" && (
            <>
              <div className="hint-title">运算符与引用</div>
              {FORMULA_OPERATORS.map((op) => (
                <div className="hint-plain" key={op.text}>
                  <code>{op.text}</code>
                  <span className="muted"> {op.description}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {focused && formula && referencePreview.length > 0 && !showSuggestions && (
        <div className="formula-hints refs">
          <div className="hint-title">引用的当前值</div>
          {referencePreview.map((item) => (
            <div className="hint-plain" key={item.ref}>
              <code style={{ color: item.color, borderBottom: `2px solid ${item.color}` }}>{item.ref}</code>
              <span className="muted"> = {item.preview}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
