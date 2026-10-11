/**
 * 公式函数元数据（REQ-009 函数提示/自动补全）。
 *
 * 与 `formula.ts` 的求值器分开：这里只描述"有哪些函数、参数是什么、有什么用"，
 * 供公式栏做提示与补全；真正的实现仍在 `formula.ts` 的 `Parser` 里。
 * 两边的函数名必须保持一致（`SUPPORTED_FUNCTIONS` 用于自检）。
 */

export interface FormulaFunction {
  name: string;
  /** 参数签名，例如 "number1, [number2], …" */
  signature: string;
  /** 一句话说明 */
  description: string;
  /** 示例 */
  example: string;
}

export const FORMULA_FUNCTIONS: FormulaFunction[] = [
  {
    name: "SUM",
    signature: "number1, [number2], …",
    description: "求和：把参数与区域内的数字相加",
    example: "=SUM(B2:B9)",
  },
  {
    name: "AVERAGE",
    signature: "number1, [number2], …",
    description: "求算术平均值（忽略空单元格）",
    example: "=AVERAGE(B2:B9)",
  },
  {
    name: "IF",
    signature: "条件, 真值, [假值]",
    description: "条件判断：条件成立返回真值，否则返回假值",
    example: '=IF(B2>100,"达标","未达标")',
  },
];

/** 求值器实际支持的函数名（formula.ts 的 Parser 分派）。 */
export const SUPPORTED_FUNCTIONS = ["SUM", "AVERAGE", "IF"] as const;

/** 运算符提示（输入 = 时一并展示）。 */
export const FORMULA_OPERATORS = [
  { text: "+ - * /", description: "四则运算（支持括号）" },
  { text: "= <> > >= < <=", description: "比较运算（用于 IF 条件）" },
  { text: "A1  A1:B2", description: "单元格引用与区域" },
  { text: '"文本"', description: "字符串字面量" },
];

/** 取光标所在位置正在输入的函数名（形如 `=SU` 或 `=IF(A1>1, SU`）。 */
export function functionQueryAt(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = before.match(/([A-Za-z]+)$/);
  return match ? match[1].toUpperCase() : null;
}

/** 按前缀过滤函数列表；空前缀返回全部。 */
export function suggestFunctions(prefix: string | null): FormulaFunction[] {
  if (prefix === null) return [];
  if (!prefix) return FORMULA_FUNCTIONS;
  return FORMULA_FUNCTIONS.filter((fn) => fn.name.startsWith(prefix));
}

/**
 * 取光标前正在编辑的引用片段（用于高亮/校验），例如 `=SUM(B2:B` 返回 `B2:B`。
 */
export function referenceQueryAt(text: string, caret: number): string | null {
  const before = text.slice(0, caret);
  const match = before.match(/([A-Za-z]{1,3}[0-9]{0,7}(?::[A-Za-z]{1,3}[0-9]{0,7})?)$/);
  return match ? match[1].toUpperCase() : null;
}

/** 校验引用是否完整合法（如 A1、A1:B2）。 */
export function isValidReference(ref: string): boolean {
  return /^[A-Z]{1,3}[0-9]+(:[A-Z]{1,3}[0-9]+)?$/.test(ref.toUpperCase());
}

/**
 * 从公式中抽取所有完整引用，返回 `{ ref, start, end }`（start/end 相对整串公式）。
 * 用于在公式栏里高亮引用并按顺序着色。
 */
export function extractReferences(formula: string): Array<{ ref: string; start: number; end: number }> {
  const out: Array<{ ref: string; start: number; end: number }> = [];
  const pattern = /[A-Za-z]{1,3}[0-9]{1,7}(?::[A-Za-z]{1,3}[0-9]{1,7})?/g;
  for (const match of formula.matchAll(pattern)) {
    const start = match.index ?? 0;
    // 跳过函数名（如 SUM）以及字符串字面量内部的片段
    const before = formula.slice(0, start);
    if (/[A-Za-z]$/.test(before)) continue;
    if ((before.match(/"/g)?.length ?? 0) % 2 === 1) continue;
    out.push({ ref: match[0].toUpperCase(), start, end: start + match[0].length });
  }
  return out;
}

/** 引用高亮配色（循环使用，像 Excel 那样给每个引用一个颜色）。 */
export const REFERENCE_COLORS = ["#1a73e8", "#e8710a", "#12805c", "#9334e6", "#d93025", "#0b8043"];
