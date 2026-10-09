/**
 * 筛选与排序面板（REQ-101）。
 *
 * 语义说明（面板内也提示给用户）：
 * - 排序 = 本端**展示层**重排，不改动存储顺序，也不影响其他人；
 * - 筛选 = 本端**视图**隐藏不匹配的行，不删除数据；
 * - 「视图」为本地状态，刷新后回到原始顺序。
 */
import { useMemo } from "react";
import { colLabel } from "../lib/gridUtils";
import { FILTER_LABELS, FILTERS_WITHOUT_VALUE } from "../types";
import type { ColumnFilter, FilterOp, SortRule } from "../types";

interface Props {
  cols: number;
  filters: ColumnFilter[];
  sort: SortRule | null;
  visibleRows: number;
  totalRows: number;
  onSort: (sort: SortRule | null) => void;
  onFilters: (filters: ColumnFilter[]) => void;
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
  const { cols, filters, sort, visibleRows, totalRows } = props;

  const columnOptions = useMemo(
    () => Array.from({ length: cols }, (_, c) => ({ value: c, label: colLabel(c) })),
    [cols],
  );

  const updateFilter = (index: number, patch: Partial<ColumnFilter>) => {
    const next = filters.map((f, i) => (i === index ? { ...f, ...patch } : f));
    props.onFilters(next);
  };

  const addFilter = () => {
    props.onFilters([...filters, { col: 0, op: "contains", value: "" }]);
  };

  const removeFilter = (index: number) => {
    props.onFilters(filters.filter((_, i) => i !== index));
  };

  return (
    <div className="panel view-panel">
      <div className="panel-head">
        <strong>筛选与排序</strong>
        <span className="muted">
          共 {totalRows.toLocaleString("en-US")} 行 · 当前显示 {visibleRows.toLocaleString("en-US")} 行
        </span>
        <span className="spacer-flex" />
        <button
          onClick={() => {
            props.onSort(null);
            props.onFilters([]);
          }}
          disabled={!sort && filters.length === 0}
        >
          全部清除
        </button>
        <button onClick={props.onClose}>关闭</button>
      </div>

      <div className="panel-body column">
        <div className="view-row">
          <span className="view-label">排序</span>
          <select
            value={sort ? String(sort.col) : ""}
            onChange={(e) =>
              props.onSort(e.target.value === "" ? null : { col: Number(e.target.value), dir: sort?.dir ?? "asc" })
            }
          >
            <option value="">不排序（原始顺序）</option>
            {columnOptions.map((c) => (
              <option key={c.value} value={c.value}>
                按 {c.label} 列
              </option>
            ))}
          </select>
          <select
            value={sort?.dir ?? "asc"}
            disabled={!sort}
            onChange={(e) => sort && props.onSort({ col: sort.col, dir: e.target.value as "asc" | "desc" })}
          >
            <option value="asc">升序（小 → 大）</option>
            <option value="desc">降序（大 → 小）</option>
          </select>
          <span className="muted">仅改变本端展示顺序，不修改数据</span>
        </div>

        <div className="view-row">
          <span className="view-label">筛选</span>
          <button onClick={addFilter} disabled={filters.length >= cols}>
            ＋ 添加条件
          </button>
          <span className="muted">多条件为「并且」关系；筛选只隐藏本端显示，不删除数据</span>
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
                <select
                  value={filter.op}
                  onChange={(e) => updateFilter(index, { op: e.target.value as FilterOp })}
                >
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
