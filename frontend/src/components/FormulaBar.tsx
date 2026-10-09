import { refOf } from "../lib/gridUtils";

interface Props {
  selected: { row: number; col: number };
  rawValue: string;
  onStart: () => void;
  onDraft: (draft: string) => void;
  onCommit: () => void;
  onCancel: () => void;
}

export default function FormulaBar({ selected, rawValue, onStart, onDraft, onCommit, onCancel }: Props) {
  return (
    <div className="formula-bar">
      <div className="formula-ref">{refOf(selected.row, selected.col)}</div>
      <input
        className="formula-input"
        value={rawValue}
        onFocus={onStart}
        onChange={(e) => onDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        placeholder="输入值或公式，如 =SUM(A1:B2)"
      />
    </div>
  );
}
