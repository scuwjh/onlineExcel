/**
 * 复制选区：同时产出 TSV（text/plain）、带样式 table（text/html）与区域截图（image/png）。
 *
 * 设计约束：
 * - 纯逻辑（测量 / 布局 / 序列化）不依赖任何 DOM，可在 Node 中直接单测；
 * - 模块顶层绝不访问 `document` / `window` / `navigator`，所有 DOM 访问都在函数内部
 *   且先做能力检测，Node 环境 import 本模块不报错；
 * - 不引入任何 npm 依赖。
 */

import type { CellFormat } from "../types";

/** 复制网格中的一个单元格：文本 + 可选格式。 */
export interface CopyCell {
  text: string;
  format?: CellFormat;
}

/** 行 × 列的复制网格。 */
export type CopyGrid = CopyCell[][];

/** 区域的像素布局结果。 */
export interface RangeLayout {
  width: number;
  height: number;
  colWidths: number[];
  rowHeights: number[];
  rows: number;
  cols: number;
  /** 计算宽度用的基准（便于测试）。 */
  charUnit: number;
}

export interface LayoutOptions {
  rowHeight?: number;
  minColWidth?: number;
  maxColWidth?: number;
  padding?: number;
  charUnit?: number;
}

/** 默认布局参数（与 Excel 视觉近似）。 */
export const DEFAULT_LAYOUT: Required<LayoutOptions> = {
  rowHeight: 28,
  minColWidth: 60,
  maxColWidth: 400,
  padding: 12,
  charUnit: 6.82,
};

const DEFAULT_FONT_SIZE = 11;
const BORDER_COLOR = "#d0d5dd";
const DEFAULT_TEXT_COLOR = "#1f2329";
const CELL_PADDING_X = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** CJK / 全角字符判定：码点 ≥ 0x2E80，或位于 0xFF00–0xFFEF、0x3000–0x303F。 */
function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x2e80 ||
    (codePoint >= 0xff00 && codePoint <= 0xffef) ||
    (codePoint >= 0x3000 && codePoint <= 0x303f)
  );
}

/**
 * 估算文本像素宽度。
 * unit = charUnit ?? (format.size ?? 11) * 0.62；CJK/全角按 2 个单位，其余（含 \t \n）按 1 个；
 * bold 再乘 1.05；返回 Math.ceil(units * unit)，空串为 0。
 */
export function measureText(text: string, format?: CellFormat, charUnit?: number): number {
  if (!text) return 0;
  const unit = charUnit ?? (format?.size ?? DEFAULT_FONT_SIZE) * 0.62;
  let units = 0;
  for (const ch of text) {
    const codePoint = ch.codePointAt(0) ?? 0;
    units += isWideCodePoint(codePoint) ? 2 : 1;
  }
  const factor = format?.bold ? 1.05 : 1;
  return Math.ceil(units * unit * factor);
}

/** 计算区域的行列尺寸；空 grid 退化为 1×1 的空内容。 */
export function layoutRange(grid: CopyGrid, options?: LayoutOptions): RangeLayout {
  const rowHeight = options?.rowHeight ?? DEFAULT_LAYOUT.rowHeight;
  const minColWidth = options?.minColWidth ?? DEFAULT_LAYOUT.minColWidth;
  const maxColWidth = options?.maxColWidth ?? DEFAULT_LAYOUT.maxColWidth;
  const padding = options?.padding ?? DEFAULT_LAYOUT.padding;
  const charUnit = options?.charUnit ?? DEFAULT_LAYOUT.charUnit;

  const source = grid ?? [];
  const rows = Math.max(1, source.length);
  let cols = 1;
  for (const row of source) cols = Math.max(cols, row?.length ?? 0);

  const colWidths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let content = 0;
    for (let r = 0; r < source.length; r++) {
      const cell = source[r]?.[c];
      if (!cell) continue;
      content = Math.max(content, measureText(cell.text ?? "", cell.format, charUnit));
    }
    colWidths.push(clamp(content + padding, minColWidth, maxColWidth));
  }

  const rowHeights: number[] = [];
  for (let r = 0; r < rows; r++) {
    const row = source[r];
    const wrapped = !!row && row.some((cell) => cell?.format?.wrap === true);
    rowHeights.push(wrapped ? rowHeight * 2 : rowHeight);
  }

  const width = colWidths.reduce((sum, value) => sum + value, 0);
  const height = rowHeights.reduce((sum, value) => sum + value, 0);
  return { width, height, colWidths, rowHeights, rows, cols, charUnit };
}

/** 需要引号包裹的单元格值（与 CSV 规则一致）：含 \t、\n 或 "。 */
function quoteTsv(value: string): string {
  if (value.includes("\t") || value.includes("\n") || value.includes('"')) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** 网格 → TSV 文本：行内 \t、行间 \n，末尾不加换行，缺失单元格按空串。 */
export function buildClipboardText(grid: CopyGrid): string {
  const source = grid ?? [];
  if (!source.length) return "";
  let cols = 0;
  for (const row of source) cols = Math.max(cols, row?.length ?? 0);
  const lines = source.map((row) => {
    const line: string[] = [];
    for (let c = 0; c < cols; c++) line.push(quoteTsv(row?.[c]?.text ?? ""));
    return line.join("\t");
  });
  return lines.join("\n");
}

/** HTML 转义（先处理 &）。 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 单元格内联样式。 */
function cellStyle(format?: CellFormat): string {
  const size = format?.size ?? DEFAULT_FONT_SIZE;
  const align = format?.align ?? "left";
  const valign = format?.valign ?? "middle";
  const parts = [
    `border:1px solid ${BORDER_COLOR}`,
    "padding:4px 6px",
    `font-size:${size}pt`,
    `vertical-align:${valign}`,
    `text-align:${align}`,
    "white-space:pre-wrap",
  ];
  if (format?.bg) parts.push(`background-color:${format.bg}`);
  if (format?.color) parts.push(`color:${format.color}`);
  if (format?.bold) parts.push("font-weight:bold");
  if (format?.italic) parts.push("font-style:italic");
  const decoration: string[] = [];
  if (format?.underline) decoration.push("underline");
  if (format?.strike) decoration.push("line-through");
  if (decoration.length) parts.push(`text-decoration:${decoration.join(" ")}`);
  return parts.join(";");
}

/**
 * 网格 → 带内联样式的 HTML table。
 * 表格总宽高取 layout（不传时内部调用 layoutRange）；空 grid 返回含单个空格的合法 table。
 */
export function buildClipboardHtml(grid: CopyGrid, layout?: RangeLayout): string {
  const source = grid ?? [];
  const range = layout ?? layoutRange(source);
  const rows: string[] = [];
  for (let r = 0; r < range.rows; r++) {
    const cells: string[] = [];
    for (let c = 0; c < range.cols; c++) {
      const cell = source[r]?.[c];
      const text = cell?.text ?? "";
      // 空单元格放一个空格，避免 IM/邮件客户端把空 td 折叠掉。
      const body = text === "" ? " " : escapeHtml(text);
      cells.push(`<td style="${cellStyle(cell?.format)}">${body}</td>`);
    }
    rows.push(`<tr>${cells.join("")}</tr>`);
  }
  return `<table border="0" cellspacing="0" cellpadding="0" style="border-collapse:collapse;table-layout:fixed;width:${range.width}px;height:${range.height}px">${rows.join("")}</table>`;
}

/** 是否支持写入图片剪贴板（Node 下恒为 false，不抛异常）。 */
export function supportsImageClipboard(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (typeof window.ClipboardItem === "undefined") return false;
  const clipboard = navigator.clipboard;
  return !!clipboard && typeof clipboard.write === "function";
}

/** 在浏览器中把区域渲染为 PNG。 */
export async function renderRangeToPng(grid: CopyGrid, layout?: RangeLayout): Promise<Blob> {
  if (typeof document === "undefined") {
    throw new Error("当前环境不支持 Canvas 渲染");
  }
  const range = layout ?? layoutRange(grid);
  const rawDpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
  const dpr = Math.min(Math.max(1, rawDpr), 2);

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(range.width * dpr);
  canvas.height = Math.round(range.height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("当前环境不支持 Canvas 渲染");
  ctx.scale(dpr, dpr);

  // 白底
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, range.width, range.height);

  let y = 0;
  for (let r = 0; r < range.rows; r++) {
    const rowHeight = range.rowHeights[r] ?? DEFAULT_LAYOUT.rowHeight;
    let x = 0;
    for (let c = 0; c < range.cols; c++) {
      const colWidth = range.colWidths[c] ?? DEFAULT_LAYOUT.minColWidth;
      const cell = grid?.[r]?.[c];
      const format = cell?.format;

      if (format?.bg) {
        ctx.fillStyle = format.bg;
        ctx.fillRect(x, y, colWidth, rowHeight);
      }
      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, colWidth - 1), Math.max(0, rowHeight - 1));

      const size = format?.size ?? DEFAULT_FONT_SIZE;
      const style = `${format?.italic ? "italic " : ""}${format?.bold ? "bold " : ""}`;
      ctx.font = `${style}${size}px ${format?.font || "sans-serif"}`;
      ctx.fillStyle = format?.color || DEFAULT_TEXT_COLOR;
      ctx.textBaseline = "middle";
      const align = format?.align ?? "left";
      ctx.textAlign = align;

      const maxWidth = Math.max(0, colWidth - CELL_PADDING_X * 2);
      const text = truncateToWidth(ctx, cell?.text ?? "", maxWidth);
      if (text) {
        let textX = x + CELL_PADDING_X;
        if (align === "center") textX = x + colWidth / 2;
        else if (align === "right") textX = x + colWidth - CELL_PADDING_X;
        ctx.fillText(text, textX, y + rowHeight / 2);
      }
      x += colWidth;
    }
    y += rowHeight;
  }

  return await new Promise<Blob>((resolve, reject) => {
    if (typeof canvas.toBlob !== "function") {
      reject(new Error("当前环境不支持 Canvas 导出"));
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Canvas 导出 PNG 失败"));
    }, "image/png");
  });
}

/** 宽度超出时截断并追加省略号。 */
function truncateToWidth(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (!text || maxWidth <= 0) return "";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const ellipsis = "…";
  if (ctx.measureText(ellipsis).width > maxWidth) return "";
  let result = "";
  for (const ch of text) {
    if (ctx.measureText(result + ch + ellipsis).width > maxWidth) break;
    result += ch;
  }
  return result + ellipsis;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

/**
 * 复制选区：优先写入三种格式，失败逐级退化为纯文本，绝不对调用方抛异常。
 */
export async function copyGridWithImage(
  grid: CopyGrid,
  options?: LayoutOptions,
): Promise<{ mode: "rich" | "text" | "failed"; reason?: string }> {
  const layout = layoutRange(grid, options);
  const text = buildClipboardText(grid);
  const html = buildClipboardHtml(grid, layout);
  let reason: string | undefined;

  if (supportsImageClipboard()) {
    try {
      const png = await renderRangeToPng(grid, layout);
      const item = new window.ClipboardItem({
        "text/plain": new Blob([text], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
        "image/png": png,
      });
      await navigator.clipboard.write([item]);
      return { mode: "rich" };
    } catch (error) {
      reason = errorMessage(error);
    }
  }

  try {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== "function") {
      throw new Error(reason ?? "当前环境不支持剪贴板");
    }
    await clipboard.writeText(text);
    return reason ? { mode: "text", reason } : { mode: "text" };
  } catch (error) {
    const message = errorMessage(error);
    return { mode: "failed", reason: reason ? `${reason}; ${message}` : message };
  }
}
