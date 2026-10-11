/**
 * 单元格展示格式化（REQ-007 数字/日期格式）。
 *
 * 只影响**显示**，存储的原始值不变——这是"格式"与"值"分离的关键：
 * 导出 CSV/Excel 时仍写原始值，公式引用也仍按原始值参与计算。
 */
import type { CellFormat } from "../types";

const CURRENCY = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const PLAIN_NUMBER = new Intl.NumberFormat("zh-CN", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function toNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  // 允许 "1,234"、"￥12"、"45%"
  const cleaned = trimmed.replace(/[,\s￥¥$]/g, "");
  if (cleaned.endsWith("%")) {
    const n = Number(cleaned.slice(0, -1));
    return Number.isNaN(n) ? null : n / 100;
  }
  const n = Number(cleaned);
  return Number.isNaN(n) ? null : n;
}

/** 把 Excel 序列号（1899-12-30 起）或常见日期文本转成 Date。 */
function toDate(text: string): Date | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial > 0 && serial < 100000) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 86400000);
    }
  }
  const normalized = trimmed.replace(/[/.]/g, "-");
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * 按格式渲染显示文本。
 *
 * @param raw 原始值（公式已由调用方求值）
 * @param fmt 单元格格式
 */
export function formatCellDisplay(raw: string, fmt?: CellFormat): string {
  if (raw === "") return "";
  const kind = fmt?.numFmt ?? "general";
  if (kind === "general" || kind === "text") return raw;

  if (kind === "date") {
    const date = toDate(raw);
    if (!date) return raw;
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  const n = toNumber(raw);
  if (n === null) return raw; // 非数字：保持原样，避免把文本"格式化"成 0
  switch (kind) {
    case "integer":
      return INTEGER.format(n);
    case "number":
      return PLAIN_NUMBER.format(n);
    case "percent":
      return `${PLAIN_NUMBER.format(n * 100)}%`;
    case "currency":
      return CURRENCY.format(n);
    default:
      return raw;
  }
}

/** 该格式是否只是"显示层"（用于判断是否需要重绘）。 */
export function hasDisplayFormat(fmt?: CellFormat): boolean {
  return !!fmt?.numFmt && fmt.numFmt !== "general";
}
