import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-fill-"));
const bundlePath = join(workDir, "fill.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}

let fillSeries, shiftFormula, describeFill;
try {
  await build({
    entryPoints: ["src/lib/fillSeries.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({ fillSeries, shiftFormula, describeFill } = await import(pathToFileURL(bundlePath).href));

  console.log("fillSeries 单元测试");

  // 单格数字 → +1 递增
  check("单格数字按 +1 递增", fillSeries(["1"], 3, true, 1, 0), ["2", "3", "4"]);
  // 两格数字 → 按差值延续
  check("两格数字按差值延续", fillSeries(["1", "3"], 3, true, 1, 0), ["5", "7", "9"]);
  // 递减
  check("递减序列", fillSeries(["10", "8"], 2, true, 1, 0), ["6", "4"]);
  // 小数
  check("小数等差", fillSeries(["1.5"], 2, true, 1, 0), ["2.5", "3.5"]);
  // 文本 → 复制
  check("文本原样复制", fillSeries(["甲"], 3, true, 1, 0), ["甲", "甲", "甲"]);
  check("多格文本循环复制", fillSeries(["甲", "乙"], 4, true, 1, 0), ["甲", "乙", "甲", "乙"]);
  // 数字 + 文本
  check("第1周 → 第2周/第3周", fillSeries(["第1周"], 2, true, 1, 0), ["第2周", "第3周"]);
  check("编号(1) 前缀后缀保持", fillSeries(["编号(1)"], 2, true, 1, 0), ["编号(2)", "编号(3)"]);
  // 日期
  check("日期按天递增", fillSeries(["2026-01-01"], 2, true, 1, 0), ["2026-01-02", "2026-01-03"]);
  check("日期按差值递增", fillSeries(["2026-01-01", "2026-01-08"], 2, true, 1, 0), ["2026-01-15", "2026-01-22"]);
  check("斜杠日期同样识别", fillSeries(["2026/1/5"], 1, true, 1, 0), ["2026-01-06"]);
  // 回归：普通数字不能被当成日期序列号
  check("三格数字仍为等差", fillSeries(["1", "3", "5"], 2, true, 1, 0), ["7", "9"]);
  check("金额数字为等差", fillSeries(["320"], 2, true, 1, 0), ["321", "322"]);
  // 公式：相对引用偏移
  check("公式向下相对偏移", fillSeries(["=SUM(B2:C2)"], 2, true, 1, 0), ["=SUM(B3:C3)", "=SUM(B4:C4)"]);
  check("公式向右相对偏移", fillSeries(["=A1*2"], 2, false, 0, 1), ["=B1*2", "=C1*2"]);
  check("绝对引用不偏移", fillSeries(["=$A$1+B2"], 1, true, 1, 0), ["=$A$1+B3"]);
  check("shiftFormula 列锁定", shiftFormula("=A$1+B2", 1, 1), "=B$1+C3");
  // 混合：数字 + 文本不一致 → 复制
  check("前后缀不一致时复制", fillSeries(["第1周", "第2月"], 2, true, 1, 0), ["第1周", "第2月"]);
  // 空源
  check("空源返回空", fillSeries([], 3, true, 1, 0), []);
  // 提示文案
  check("提示：等差数列", describeFill(["1", "3"]), "填充等差数列");
  check("提示：公式", describeFill(["=A1"]), "填充公式（相对引用）");
  check("提示：日期", describeFill(["2026-01-01"]), "填充日期序列");
  check("提示：复制", describeFill(["甲"]), "复制填充");

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
