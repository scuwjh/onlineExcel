/**
 * 拖拽填充（REQ-006）。
 *
 * 语义与 Excel 的"填充柄"一致：
 * - 单格数字 → 按 **+1 等差** 递增（`1` → `2,3,4`）；
 * - 两个及以上数字 → 按**相邻差值**延续，支持递减与小数（`1,3` → `5,7`）；
 * - 日期 → 按天数递增（`2026-01-01` → `2026-01-02`）；
 * - 数字 + 文本（如 `第1周`）→ 只递增其中的数字部分；
 * - 文本 → **原样复制**；
 * - 公式 → 按**相对引用**偏移（`=SUM(B2:C2)` 向下填充变成 `=SUM(B3:C3)`），与 Excel 一致。
 *
 * 纯函数、无副作用，便于单测（`frontend/scripts/fill.test.mjs`）。
 */
import { colLabel, parseCellRef } from "./gridUtils";

/** 从一段文本里拆出"前缀 + 数字 + 后缀"，用于 `第1周` 这类模式。 */
function splitNumeric(text: string): { prefix: string; value: number; suffix: string; decimals: number } | null {
  const match = text.match(/^([^\d\-+.]*)(-?\d+(?:\.\d+)?)(.*)$/);
  if (!match) return null;
  const value = Number(match[2]);
  if (Number.isNaN(value)) return null;
  const decimals = match[2].includes(".") ? match[2].split(".")[1].length : 0;
  return { prefix: match[1], value, suffix: match[3], decimals };
}

/**
 * 把日期文本解析成**UTC 时间戳**（按年月日逐段解析）。
 *
 * 不用 `new Date("2026-1-5")`：该写法按**本地时区**解释，再用 `getUTC*` 输出时
 * 在东八区会整体偏移一天（`2026-01-05` → `2026-01-04T16:00Z`）。
 */
function parseDateText(trimmed: string): number | null {
  const match = trimmed.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return Date.UTC(year, month - 1, day);
}

/**
 * 判断文本是否像日期；是则返回 UTC 毫秒时间戳，否则 null。
 *
 * 注意：**不能**把普通数字当成 Excel 序列号——`1`、`320` 这类值会被误判成
 * 1900 年的日期，导致"1,3 → 5,7"这种等差填充变成日期递增（已在单测中抓到）。
 * 因此只有带日期分隔符（`2026-01-05`、`2026/1/5`）的文本才按日期处理。
 */
export function parseDateLike(text: string): number | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}([ T].*)?$/.test(trimmed)) return null;
  return parseDateText(trimmed);
}

/** 时间戳 → `YYYY-MM-DD`。 */
function formatDate(ms: number): string {
  const date = new Date(ms);
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 去掉浮点误差、按原小数位输出。 */
function formatNumber(value: number, decimals: number): string {
  const fixed = decimals > 0 ? value.toFixed(Math.min(10, decimals)) : String(Math.round(value));
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

/**
 * 把公式里的相对引用按 (dRow, dCol) 偏移。
 *
 * 行为与 Excel 一致：`A1` 相对偏移；带 `$` 的行/列锁定不偏移（如 `$A$1`）。
 */
export function shiftFormula(formula: string, dRow: number, dCol: number): string {
  if (!formula.startsWith("=")) return formula;
  return formula.replace(
    /(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})/g,
    (whole, colLock: string, colLetters: string, rowLock: string, rowDigits: string) => {
      // 函数名（如 SUM）不会被此正则匹配（后面必须跟数字），但形如 LOG10 的仍需排除
      let col = 0;
      for (const ch of colLetters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
      col -= 1;
      const row = Number(rowDigits) - 1;
      const newCol = colLock ? col : col + dCol;
      const newRow = rowLock ? row : row + dRow;
      if (newCol < 0 || newRow < 0) return whole; // 越界则保持原样
      return `${colLock}${colLabel(newCol)}${rowLock}${newRow + 1}`;
    },
  );
}

/**
 * 计算填充值。
 *
 * @param sources 源区域按"填充方向"排列的一维值（沿填充轴，从靠近目标的一端到远离的一端）
 * @param count 需要生成的数量
 * @param vertical 是否纵向填充（决定公式按行还是按列偏移）
 * @param dRowPerStep 每步的行位移（带符号；纵向填充时使用）
 * @param dColPerStep 每步的列位移（带符号；横向填充时使用）
 */
export function fillSeries(
  sources: string[],
  count: number,
  vertical: boolean,
  dRowPerStep: number,
  dColPerStep: number,
): string[] {
  const out: string[] = [];
  if (!sources.length || count <= 0) return out;

  const last = sources[sources.length - 1] ?? "";

  // 1) 公式：按相对引用偏移（保持与源的最后一条相同的步进）
  if (last.startsWith("=")) {
    for (let step = 1; step <= count; step++) {
      out.push(shiftFormula(last, dRowPerStep * step, dColPerStep * step));
    }
    return out;
  }

  // 2) 日期序列
  const dates = sources.map((s) => parseDateLike(s));
  if (dates.every((d) => d !== null)) {
    const ms = dates as number[];
    const stepDays = ms.length > 1 ? (ms[ms.length - 1] - ms[ms.length - 2]) / 86400000 : 1;
    for (let i = 1; i <= count; i++) out.push(formatDate(ms[ms.length - 1] + stepDays * i * 86400000));
    return out;
  }

  // 3) 纯数字 / 数字+文本（第1周）
  const parts = sources.map((s) => splitNumeric(s));
  if (parts.every((p) => p !== null)) {
    const list = parts as NonNullable<typeof parts[number]>[];
    // 前后缀必须一致，否则退化为复制
    const sameAffix = list.every((p) => p.prefix === list[0].prefix && p.suffix === list[0].suffix);
    if (sameAffix) {
      const step = list.length > 1 ? list[list.length - 1].value - list[list.length - 2].value : 1;
      for (let i = 1; i <= count; i++) {
        const value = list[list.length - 1].value + step * i;
        out.push(`${list[0].prefix}${formatNumber(value, list[0].decimals)}${list[0].suffix}`);
      }
      return out;
    }
  }

  // 4) 文本/混合：原样循环复制
  for (let i = 0; i < count; i++) out.push(sources[i % sources.length]);
  return out;
}

/** 判断一段区间是否可直接按"等差/日期/公式"延续（用于状态栏提示）。 */
export function describeFill(sources: string[]): string {
  if (!sources.length) return "填充";
  const last = sources[sources.length - 1] ?? "";
  if (last.startsWith("=")) return "填充公式（相对引用）";
  if (sources.every((s) => parseDateLike(s) !== null)) return "填充日期序列";
  const parts = sources.map((s) => splitNumeric(s));
  if (parts.every((p) => p !== null) && parts.every((p) => p!.prefix === parts[0]!.prefix && p!.suffix === parts[0]!.suffix)) {
    return sources.length > 1 ? "填充等差数列" : "填充序列（+1）";
  }
  return "复制填充";
}

/** 把引用拆成列/行（供测试与其他模块复用）。 */
export { parseCellRef };
