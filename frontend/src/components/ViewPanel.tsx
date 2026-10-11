/**
 * 筛选与排序面板（REQ-101）。
 *
 * 语义说明（面板内也提示给用户）：
 * - 排序 = 本端**展示层**重排（支持多级：先按第一列，相同再按第二列），
 *   不改动存储顺序，也不影响其他人；
 * - 筛选 = 本端**视图**隐藏不匹配的行，不删除数据；支持"条件表达式"与"按值勾选"两类，
 *   两类叠加（都是「并且」）；
 * - 视图为本地状态，清除即回到原始顺序。
 */
import { useMemo, useState } from "react";
import { colLabel } from "../lib/gridUtils";
import { distinctValues } from "../lib/viewFilter";
import { FILTER_LABELS, FILTERS_WITHOUT_VALUE } from "../types";
import type { Cells, ColumnFilter, FilterOp, SortRule, ValueFilter } from "../types";

interface Props {
  cols: number;
  rows: number;
  cells: Cells;
  filters: ColumnFilter[];
  valueFilters: ValueFilter[];
  sorts: SortRule[];
  visibleRows: number;
  totalRows: number;
  onSorts: (sorts: SortRule[]) => void;
  onFilters: (filters: ColumnFilter[]) => void;
  onValueFilters: (filters: ValueFilter[]) => void;
  onClose: () => void;
}

const OPS: FilterOp[] = [
  "contains",
  "notContains",
  "equals",
  "notEquals",
  "empty",
  "notEmpty",
  "gt",
  "gte",
  "lt",
  "lte",
];

export default function ViewPanel(props: Props) {
  const { cols, rows, cells, filters, valueFilters, sorts, visibleRows, totalRows } = props;
  const [valueCol, setValueCol] = useState(0);
  const [valueSearch, setValueSearch] = useState("");

  const columnOptions = useMemo(
    () => Array.from({ length: cols }, (_, c) => ({ value: c, label: colLabel(c) })),
    [cols],
  );

  /** 当前"按值筛选"列的全部候选值。大表限制样本量，避免面板卡死。 */
  const candidates = useMemo(() => {
    if (rows > 5000) return [];
    return distinctValues(cells, rows, valueCol);
  }, [cells, rows, valueCol]);

  const filteredCandidates = useMemo(() => {
    const q = valueSearch.trim().toLowerCase();
    const list = q ? candidates.filter((v) => v.toLowerCase().includes(q)) : candidates;
    return list.slice(0, 200);
  }, [candidates, valueSearch]);

  const activeValueFilter = useMemo(
    () => valueFilters.find((f) => f.col === valueCol) ?? null,
    [valueCol, valueFilters],
  );

  const updateFilter = (index: number, patch: Partial<ColumnFilter>) => {
    props.onFilters(filters.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  };
  const removeFilter = (index: number) => props.onFilters(filters.filter((_, i) => i !== index));

  /** 勾选/取消某个值：第一次勾选时以"当前列全部值"为基准，避免误删未显示的项。 */
  const toggleValue = (value: string, checked: boolean) => {
    const base = activeValueFilter ? [...activeValueFilter.values] : [...candidates];
    const next = checked ? [...new Set([...base, value])] : base.filter((v) => v !== value);
    const rest = valueFilters.filter((f) => f.col !== valueCol);
    props.onValueFilters(next.length === candidates.length ? rest : [...rest, { col: valueCol, values: next }]);
  };

  const selectAllValues = () => props.onValueFilters(valueFilters.filter((f) => f.col !== valueCol));
  const clearValues = () => {
    const rest = valueFilters.filter((f) => f.col !== valueCol);
    props.onValueFilters([...rest, { col: valueCol, values: [] }]);
  };

  const addSort = (col: number) => props.onSorts([...sorts, { col, dir: "asc" }]);
  const updateSort = (index: number, patch: Partial<SortRule>) =>
    props.onSorts(sorts.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  const moveSort = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= sorts.length) return;
    const next = [...sorts];
    [next[index], next[target]] = [next[target], next[index]];
    props.onSorts(next);
  };

  return (
    <div className="panel view-panel">
      <div className="panel-head">
        <strong>筛选与排序</strong>
        <span className="muted">
          共 {totalRows.toLocaleString("en-US")} 行 · 当前显示 {visibleRows.toLocaleString("en-US")} 行
          {filters.length + valueFilters.length > 0 ? ` · 生效筛选 ${filters.length + valueFilters.length} 个` : ""}
        </span>
        <span className="spacer-flex" />
        <button
          onClick={() => {
            props.onSorts([]);
            props.onFilters([]);
            props.onValueFilters([]);
          }}
          disabled={!sorts.length && !filters.length && !valueFilters.length}
        >
          全部清除
        </button>
        <button onClick={props.onClose}>关闭</button>
      </div>

      <div className="panel-body column">
        {/* ------------------------------------------------------------ 排序 */}
        <div className="view-row">
          <span className="view-label">排序</span>
          <select
            value=""
            onChange={(e) => e.target.value !== "" && addSort(Number(e.target.value))}
          >
            <option value="">＋ 添加排序条件（可多级）</option>
            {columnOptions.map((c) => (
              <option key={c.value} value={c.value}>
                按 {c.label} 列
              </option>
            ))}
          </select>
          <span className="muted">先按第 1 条，相同再按第 2 条；空值恒排在末尾</span>
        </div>
        {sorts.length > 0 && (
          <div className="filter-list">
            {sorts.map((rule, index) => (
              <div className="view-row" key={index}>
                <span className="sort-index">{index + 1}</span>
                <select value={rule.col} onChange={(e) => updateSort(index, { col: Number(e.target.value) })}>
                  {columnOptions.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label} 列
                    </option>
                  ))}
                </select>
                <select
                  value={rule.dir}
                  onChange={(e) => updateSort(index, { dir: e.target.value as "asc" | "desc" })}
                >
                  <option value="asc">升序（小 → 大）</option>
                  <option value="desc">降序（大 → 小）</option>
                </select>
                <button onClick={() => moveSort(index, -1)} disabled={index === 0} title="上移优先级">
                  ↑
                </button>
                <button
                  onClick={() => moveSort(index, 1)}
                  disabled={index === sorts.length - 1}
                  title="下移优先级"
                >
                  ↓
                </button>
                <button onClick={() => props.onSorts(sorts.filter((_, i) => i !== index))}>移除</button>
              </div>
            ))}
          </div>
        )}

        {/* ------------------------------------------------ 筛选：按值勾选 */}
        <div className="view-row">
          <span className="view-label">按值</span>
          <select value={valueCol} onChange={(e) => setValueCol(Number(e.target.value))}>
            {columnOptions.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label} 列
              </option>
            ))}
          </select>
          <input
            placeholder="搜索值"
            value={valueSearch}
            onChange={(e) => setValueSearch(e.target.value)}
            disabled={rows > 5000}
          />
          <button onClick={selectAllValues} disabled={!activeValueFilter}>
            全选
          </button>
          <button onClick={clearValues} disabled={rows > 5000}>
            全不选
          </button>
          {rows > 5000 && <span className="muted">行数过多（&gt;5000），按值筛选已停用，请用条件筛选</span>}
        </div>
        {rows <= 5000 && (
          <div className="value-list">
            {filteredCandidates.length === 0 && <div className="muted">该列没有可选值</div>}
            {filteredCandidates.map((value) => {
              const checked = !activeValueFilter || activeValueFilter.values.includes(value);
              return (
                <label className="value-item" key={value || "(空)"}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => toggleValue(value, e.target.checked)}
                  />
                  <span className="value-text">{value === "" ? "（空白）" : value}</span>
                </label>
              );
            })}
          </div>
        )}

        {/* ------------------------------------------- 筛选：条件表达式 */}
        <div className="view-row">
          <span className="view-label">条件</span>
          <button onClick={() => props.onFilters([...filters, { col: 0, op: "contains", value: "" }])}>
            ＋ 添加条件
          </button>
          <span className="muted">与上面的「按值」筛选是「并且」关系；只隐藏本端显示，不删除数据</span>
        </div>
        {filters.length > 0 && (
          <div className="filter-list">
            {filters.map((filter, index) => (
              <div className="view-row" key={index}>
                <select value={filter.col} onChange={(e) => updateFilter(index, { col: Number(e.target.value) })}>
                  {columnOptions.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.label} 列
                    </option>
                  ))}
                </select>
                <select value={filter.op} onChange={(e) => updateFilter(index, { op: e.target.value as FilterOp })}>
                  {OPS.map((op) => (
                    <option key={op} value={op}>
                      {FILTER_LABELS[op]}
                    </option>
                  ))}
                </select>
                <input
                  value={filter.value ?? ""}
                  disabled={FILTERS_WITHOUT_VALUE.includes(filter.op)}
                  placeholder={FILTERS_WITHOUT_VALUE.includes(filter.op) ? "（无需填写）" : "比较值"}
                  onChange={(e) => updateFilter(index, { value: e.target.value })}
                />
                <button onClick={() => removeFilter(index)}>移除</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
