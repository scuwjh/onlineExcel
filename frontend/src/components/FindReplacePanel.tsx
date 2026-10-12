/**
 * 查找与替换面板（REQ-111）。
 *
 * - 顶部输入框即查即搜（匹配逻辑由父组件调用 `lib/findReplace` 完成）；
 * - 三个选项：区分大小写 / 整格匹配 / 正则表达式，下方给出中文摘要；
 * - 结果列表可滚动，点击某条即跳转到对应单元格，当前项高亮标记；
 * - 替换区在只读角色（viewer）下整块禁用，只能查找。
 *
 * 本组件不直接发起网络请求，也不改动表格数据：所有动作都通过父组件回调完成。
 */
import { describeOptions } from "../lib/findReplace";
import type { FindHit, FindOptions } from "../lib/findReplace";
import { refOf } from "../lib/gridUtils";

interface Props {
  options: FindOptions;
  onOptions: (patch: Partial<FindOptions>) => void;
  hits: FindHit[];
  /** 当前高亮项下标，-1 表示无。 */
  hitIndex: number;
  truncated: boolean;
  /** 例如正则非法时的错误说明。 */
  error: string | null;
  replacement: string;
  onReplacement: (value: string) => void;
  onFindNext: () => void;
  onFindPrev: () => void;
  onReplaceOne: () => void;
  onReplaceAll: () => void;
  onJump: (hit: FindHit) => void;
  onClose: () => void;
  /** viewer 只能查找，不能替换。 */
  readOnly: boolean;
  /** 结果上限（仅用于文案），默认 2000。 */
  limit?: number;
}

/** 结果列表里单条值片段的最大长度。 */
const SNIPPET_MAX = 40;

/** 值 → 列表展示片段：空值给中文占位，过长截断加省略号。 */
function snippetOf(value: string): string {
  if (value === "") return "（空）";
  return value.length > SNIPPET_MAX ? `${value.slice(0, SNIPPET_MAX)}…` : value;
}

export default function FindReplacePanel(props: Props) {
  const { options, hits, hitIndex, truncated, error, replacement, readOnly } = props;
  const limit = props.limit ?? 2000;
  const total = hits.length;
  const current = hitIndex >= 0 && hitIndex < total ? hitIndex : -1;

  return (
    <div className="panel find-replace-panel">
      <div className="panel-head">
        <strong>查找与替换</strong>
        {readOnly && <span className="tag">只读</span>}
        <span className="spacer-flex" />
        <button className="ghost" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <div className="panel-body column">
        {/* ---------------------------------------------------- 查找输入 */}
        <div className="view-row">
          <span className="view-label">查找</span>
          <input
            autoFocus
            value={options.query}
            placeholder="输入要查找的内容"
            onChange={(e) => props.onOptions({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (e.shiftKey) props.onFindPrev();
                else props.onFindNext();
              } else if (e.key === "Escape") {
                e.preventDefault();
                props.onClose();
              }
            }}
          />
          <span className="muted">
            {total === 0 ? "无结果" : `第 ${hitIndex < 0 ? 0 : hitIndex + 1} / ${total} 项`}
            {truncated ? `（结果过多，仅显示前 ${limit} 项）` : ""}
          </span>
        </div>

        {/* ------------------------------------------------------ 选项 */}
        <div className="view-row">
          <label className="inline-check">
            <input
              type="checkbox"
              checked={options.matchCase}
              onChange={(e) => props.onOptions({ matchCase: e.target.checked })}
            />
            区分大小写
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={options.wholeCell}
              onChange={(e) => props.onOptions({ wholeCell: e.target.checked })}
            />
            整格匹配
          </label>
          <label className="inline-check">
            <input
              type="checkbox"
              checked={options.regex}
              onChange={(e) => props.onOptions({ regex: e.target.checked })}
            />
            正则表达式
          </label>
          <span className="muted">{describeOptions(options)}</span>
        </div>

        {/* -------------------------------------------------- 上一个/下一个 */}
        <div className="view-row">
          <button onClick={props.onFindPrev} disabled={total === 0}>
            上一个
          </button>
          <button onClick={props.onFindNext} disabled={total === 0}>
            下一个
          </button>
          <span className="muted">Enter 下一个，Shift+Enter 上一个</span>
        </div>

        {error && <div className="error inline">{error}</div>}
        {truncated && <div className="muted">结果过多，仅显示前 {limit} 项</div>}

        {/* ---------------------------------------------------- 结果列表 */}
        <div className="column" style={{ gap: 4, maxHeight: 160, overflowY: "auto" }}>
          {total === 0 && <div className="muted">没有匹配项</div>}
          {hits.map((hit, index) => (
            <button
              key={`${hit.row}:${hit.col}:${index}`}
              className={index === current ? "view-row active" : "view-row"}
              style={{
                width: "100%",
                textAlign: "left",
                cursor: "pointer",
                ...(index === current ? { fontWeight: 600 } : {}),
              }}
              onClick={() => props.onJump(hit)}
            >
              <span className="tag">{refOf(hit.row, hit.col)}</span>
              <span className="muted">{snippetOf(hit.value)}</span>
            </button>
          ))}
        </div>

        {/* ------------------------------------------------------ 替换区 */}
        <div className="view-row">
          <span className="view-label">替换为</span>
          <input
            value={replacement}
            placeholder="替换后的内容"
            disabled={readOnly}
            onChange={(e) => props.onReplacement(e.target.value)}
          />
          <button onClick={props.onReplaceOne} disabled={readOnly || total === 0}>
            替换
          </button>
          <button onClick={props.onReplaceAll} disabled={readOnly || total === 0}>
            全部替换（{total}）
          </button>
          {readOnly && <span className="muted">只读角色只能查找</span>}
        </div>
      </div>
    </div>
  );
}
