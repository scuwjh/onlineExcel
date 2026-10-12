import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-copyimage-"));
const bundlePath = join(workDir, "copyImage.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}

let measureText, layoutRange, buildClipboardText, buildClipboardHtml, escapeHtml;
let supportsImageClipboard, renderRangeToPng, copyGridWithImage, DEFAULT_LAYOUT;
try {
  await build({
    entryPoints: ["src/lib/copyImage.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({ measureText, layoutRange, buildClipboardText, buildClipboardHtml, escapeHtml,
     supportsImageClipboard, renderRangeToPng, copyGridWithImage, DEFAULT_LAYOUT } =
    await import(pathToFileURL(bundlePath).href));

  const sum = (values) => values.reduce((total, value) => total + value, 0);

  console.log("copyImage 单元测试");

  // ---------- measureText ----------
  check("measureText：默认基准为字号 11×0.62", DEFAULT_LAYOUT.charUnit, 6.82);
  check("measureText：ab（charUnit 10）= 20", measureText("ab", undefined, 10), 20);
  check("measureText：中文（charUnit 10）= 40", measureText("中文", undefined, 10), 40);
  check("measureText：中文比英文宽", measureText("中", undefined, 10) > measureText("a", undefined, 10), true);
  check("measureText：全角标点按 2 个单位", measureText("，", undefined, 10), 20);
  check("measureText：空串为 0", measureText("", undefined, 10), 0);
  check("measureText：无参时用默认字号", measureText("a"), 7);
  check("measureText：字号 20 → 13", measureText("a", { size: 20 }), 13);
  check("measureText：bold 更宽", measureText("ab", { bold: true }, 10), 21);
  check("measureText：bold 相对非 bold 更宽", measureText("ab", { bold: true }, 10) > measureText("ab", undefined, 10), true);
  check("measureText：制表符/换行按 1 个单位", measureText("\t\n", undefined, 10), 20);

  // ---------- layoutRange ----------
  const empty = layoutRange([]);
  check("layoutRange：空 grid 退化为 1×1", [empty.rows, empty.cols], [1, 1]);
  check("layoutRange：空 grid 列宽取 minColWidth", empty.colWidths, [60]);
  check("layoutRange：空 grid 行高取 rowHeight", empty.rowHeights, [28]);
  check("layoutRange：空 grid 总宽高", [empty.width, empty.height], [60, 28]);
  check("layoutRange：charUnit 原样返回", layoutRange([[{ text: "a" }]], { charUnit: 10 }).charUnit, 10);
  check("layoutRange：列宽 clamp 到 min", layoutRange([[{ text: "a" }]], { charUnit: 10 }).colWidths, [60]);
  check("layoutRange：无单元格时取 minColWidth", layoutRange([[{ text: "" }]], { charUnit: 10 }).colWidths, [60]);
  check("layoutRange：列宽 clamp 到 max", layoutRange([[{ text: "a".repeat(60) }]], { charUnit: 10 }).colWidths, [400]);
  check("layoutRange：padding 参与列宽", layoutRange([[{ text: "a" }]], { charUnit: 10, padding: 4 }).colWidths, [60]);
  check(
    "layoutRange：自定义 min/max/padding",
    layoutRange([[{ text: "a" }]], { charUnit: 10, padding: 4, minColWidth: 0, maxColWidth: 1000 }).colWidths,
    [14],
  );
  const ragged = layoutRange([[{ text: "aa" }, { text: "b" }], [{ text: "c" }]], { charUnit: 10 });
  check("layoutRange：cols 取最长行", [ragged.rows, ragged.cols], [2, 2]);
  check("layoutRange：列宽按列内最大文本", ragged.colWidths, [60, 60]);
  check("layoutRange：width === Σ colWidths", ragged.width, sum(ragged.colWidths));
  const wrapGrid = layoutRange([[{ text: "a", format: { wrap: true } }], [{ text: "b" }]]);
  check("layoutRange：wrap 行高翻倍", wrapGrid.rowHeights, [56, 28]);
  check("layoutRange：height === Σ rowHeights", wrapGrid.height, sum(wrapGrid.rowHeights));
  check("layoutRange：wrap 只影响本行", layoutRange([[{ text: "a" }], [{ text: "b", format: { wrap: true } }]]).rowHeights, [28, 56]);

  // ---------- buildClipboardText ----------
  check("TSV：基本拼接", buildClipboardText([[{ text: "a" }, { text: "b" }], [{ text: "c" }, { text: "d" }]]), "a\tb\nc\td");
  check("TSV：含制表符加引号", buildClipboardText([[{ text: "a\tb" }]]), "\"a\tb\"");
  check("TSV：含换行加引号", buildClipboardText([[{ text: "a\nb" }]]), "\"a\nb\"");
  check("TSV：引号转义为双引号", buildClipboardText([[{ text: "say \"hi\"" }]]), "\"say \"\"hi\"\"\"");
  check("TSV：缺失单元格按空串", buildClipboardText([[{ text: "a" }, { text: "b" }], [{ text: "c" }]]), "a\tb\nc\t");
  check("TSV：空 grid 为空串", buildClipboardText([]), "");
  const tsv = buildClipboardText([[{ text: "a" }], [{ text: "b" }]]);
  check("TSV：末尾不加换行", tsv.endsWith("\n"), false);
  check("TSV：两行内容", tsv, "a\nb");

  // ---------- escapeHtml ----------
  check("escapeHtml：&", escapeHtml("&"), "&amp;");
  check("escapeHtml：<", escapeHtml("<"), "&lt;");
  check("escapeHtml：>", escapeHtml(">"), "&gt;");
  check("escapeHtml：双引号", escapeHtml("\""), "&quot;");
  check("escapeHtml：单引号", escapeHtml("'"), "&#39;");
  check("escapeHtml：& 优先处理", escapeHtml("&<"), "&amp;&lt;");
  check("escapeHtml：标签整体转义", escapeHtml("<script>"), "&lt;script&gt;");

  // ---------- buildClipboardHtml ----------
  const styled = buildClipboardHtml([[
    { text: "标题", format: { bg: "#fff2cc", bold: true, color: "#ff0000", align: "center", valign: "top", underline: true, strike: true, size: 14 } },
  ]]);
  check("HTML：含 table 标签", styled.includes("<table"), true);
  check("HTML：含内联背景色", styled.includes("background-color:#fff2cc"), true);
  check("HTML：含粗体", styled.includes("font-weight:bold"), true);
  check("HTML：含颜色", styled.includes("color:#ff0000"), true);
  check("HTML：含字号", styled.includes("font-size:14pt"), true);
  check("HTML：含水平对齐", styled.includes("text-align:center"), true);
  check("HTML：含垂直对齐", styled.includes("vertical-align:top"), true);
  check("HTML：下划线+删除线组合", styled.includes("text-decoration:underline line-through"), true);
  check("HTML：含边框与内边距", styled.includes("border:1px solid #d0d5dd") && styled.includes("padding:4px 6px"), true);
  check("HTML：含 pre-wrap", styled.includes("white-space:pre-wrap"), true);
  const htmlLayout = layoutRange([[{ text: "a" }]]);
  check("HTML：表格总宽高取 layout", buildClipboardHtml([[{ text: "a" }]], htmlLayout).includes(`width:${htmlLayout.width}px;height:${htmlLayout.height}px`), true);
  const escapedHtml = buildClipboardHtml([[{ text: "<script>alert(1)</script>" }]]);
  check("HTML：<script> 被转义", escapedHtml.includes("<script>"), false);
  check("HTML：转义后文本存在", escapedHtml.includes("&lt;script&gt;"), true);
  const emptyHtml = buildClipboardHtml([]);
  check("HTML：空 grid 仍是合法 table", emptyHtml.startsWith("<table") && emptyHtml.endsWith("</table>"), true);
  check("HTML：空 grid 含单个空格", emptyHtml.includes("> </td>"), true);

  // ---------- Node 环境能力检测 ----------
  check("supportsImageClipboard：Node 返回 false", supportsImageClipboard(), false);

  let pngError = "(未抛错)";
  try {
    await renderRangeToPng([[{ text: "a" }]]);
  } catch (error) {
    pngError = error instanceof Error ? error.message : String(error);
  }
  check("renderRangeToPng：Node 下 reject", pngError, "当前环境不支持 Canvas 渲染");

  let result, threw = false;
  try {
    result = await copyGridWithImage([[{ text: "a" }, { text: "b" }]]);
  } catch {
    threw = true;
  }
  check("copyGridWithImage：不抛异常", threw, false);
  check("copyGridWithImage：Node 下 mode=failed", result && result.mode, "failed");
  check("copyGridWithImage：失败时带 reason", typeof (result && result.reason) === "string" && result.reason.length > 0, true);

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
