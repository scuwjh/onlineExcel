import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-findreplace-"));
const bundlePath = join(workDir, "findReplace.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}

let DEFAULT_FIND_OPTIONS, compileMatcher, findMatches, findMatchesInOrder, replaceInValue, replaceAll, nextHitIndex, describeOptions;
try {
  await build({
    entryPoints: ["src/lib/findReplace.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({
    DEFAULT_FIND_OPTIONS,
    compileMatcher,
    findMatches,
    findMatchesInOrder,
    replaceInValue,
    replaceAll,
    nextHitIndex,
    describeOptions,
  } = await import(pathToFileURL(bundlePath).href));

  console.log("findReplace 单元测试");

  const opt = (patch) => ({ ...DEFAULT_FIND_OPTIONS, ...patch });
  const coords = (hits) => hits.map((hit) => [hit.row, hit.col]);

  // ── 默认值与摘要文案 ──────────────────────────────────────────────
  check("默认选项", DEFAULT_FIND_OPTIONS, { query: "", matchCase: false, wholeCell: false, regex: false });
  check("摘要：全部未启用", describeOptions(opt({})), "默认匹配（忽略大小写、包含即命中）");
  check("摘要：仅区分大小写", describeOptions(opt({ matchCase: true })), "区分大小写");
  check("摘要：仅整格匹配", describeOptions(opt({ wholeCell: true })), "整格匹配");
  check("摘要：仅正则", describeOptions(opt({ regex: true })), "正则");
  check("摘要：三项组合顺序", describeOptions(opt({ query: "x", matchCase: true, wholeCell: true, regex: true })), "区分大小写 · 整格匹配 · 正则");

  // ── 忽略大小写 vs 区分大小写 ─────────────────────────────────────
  check("忽略大小写：AbC 命中 abc", compileMatcher(opt({ query: "abc" })).test("AbC"), true);
  check("区分大小写：AbC 不命中 abc", compileMatcher(opt({ query: "abc", matchCase: true })).test("AbC"), false);
  check("区分大小写：abc 命中 abc", compileMatcher(opt({ query: "abc", matchCase: true })).test("abc"), true);
  check("空查询：test 恒为 false", compileMatcher(opt({ query: "" })).test("任意内容"), false);
  check("空查询：findMatches 返回空", findMatches({ "0:0": "任意内容" }, 2, 2, opt({ query: "" })), []);

  // ── 整格匹配 vs 包含匹配 ─────────────────────────────────────────
  check("包含匹配：子串命中", compileMatcher(opt({ query: "bc" })).test("abcd"), true);
  check("整格匹配：子串不命中", compileMatcher(opt({ query: "bc", wholeCell: true })).test("abcd"), false);
  check("整格匹配：完全相等命中", compileMatcher(opt({ query: "abcd", wholeCell: true })).test("abcd"), true);
  check("整格匹配：忽略大小写", compileMatcher(opt({ query: "ABCD", wholeCell: true })).test("abcd"), true);
  check("整格匹配：null 不命中非空查询", compileMatcher(opt({ query: "abc", wholeCell: true })).test(null), false);

  // ── 非正则模式下的字面量语义（特殊字符不能当正则） ────────────────
  check("字面量 a+b 命中 xa+by", compileMatcher(opt({ query: "a+b" })).test("xa+by"), true);
  check("字面量 a+b 不误匹配 aab", compileMatcher(opt({ query: "a+b" })).test("aab"), false);
  check("字面量 a.b 命中 a.b", compileMatcher(opt({ query: "a.b" })).test("a.b"), true);
  check("字面量 a.b 不误匹配 axb", compileMatcher(opt({ query: "a.b" })).test("axb"), false);
  check("字面量 (x) 命中 f(x)", compileMatcher(opt({ query: "(x)" })).test("f(x)"), true);
  check("字面量 (x) 不误匹配 x", compileMatcher(opt({ query: "(x)" })).test("x"), false);
  check("字面量替换不吃 $1", replaceInValue("xa+by", opt({ query: "a+b" }), "$1"), "x$1y");
  check("字面量替换 a.b", replaceInValue("a.b", opt({ query: "a.b" }), "X"), "X");

  // ── 非法正则：返回 error 且不抛异常 ──────────────────────────────
  const bad = compileMatcher(opt({ query: "(unclosed", regex: true }));
  check("非法正则：kind 为 regex", bad.error && bad.error.kind, "regex");
  check(
    "非法正则：返回可直接展示的中文说明",
    !!(bad.error && bad.error.message.startsWith("正则表达式无效：") && bad.error.message.length > "正则表达式无效：".length),
    true,
  );
  check("非法正则：test 恒为 false", bad.test("任意内容"), false);
  check("非法正则：findMatches 返回空", findMatches({ "0:0": "任意内容" }, 1, 1, opt({ query: "(unclosed", regex: true })), []);
  check("非法正则：replaceInValue 原样返回", replaceInValue("任意内容", opt({ query: "(unclosed", regex: true }), "X"), "任意内容");
  check("合法正则：error 为 null", compileMatcher(opt({ query: "a+", regex: true })).error, null);
  check("正则整格匹配：12a 不命中 \\d+", compileMatcher(opt({ query: "\\d+", wholeCell: true, regex: true })).test("12a"), false);
  check("正则整格匹配：123 命中 \\d+", compileMatcher(opt({ query: "\\d+", wholeCell: true, regex: true })).test("123"), true);

  // ── 正则替换：$1 反向引用 ────────────────────────────────────────
  check("正则替换 $1 反向引用", replaceInValue("abc-123", opt({ query: "([a-z]+)-(\\d+)", regex: true }), "$2-$1"), "123-abc");
  check("正则替换全局替换", replaceInValue("a1 b2", opt({ query: "([a-z])(\\d)", regex: true }), "$2$1"), "1a 2b");
  check("正则整格替换未命中不改值", replaceInValue("12a34", opt({ query: "\\d+", wholeCell: true, regex: true }), "N"), "12a34");
  check("正则整格替换命中并用 $&", replaceInValue("123", opt({ query: "\\d+", wholeCell: true, regex: true }), "<$&>"), "<123>");

  // ── findMatches：行优先顺序、limit、null 视为空串 ────────────────
  const grid = { "0:0": "hit", "0:2": "hit", "1:0": "hit", "1:2": "miss" };
  check("findMatches 行优先顺序", coords(findMatches(grid, 2, 3, opt({ query: "hit" }))), [[0, 0], [0, 2], [1, 0]]);
  check("findMatches 返回单元格原值", findMatches(grid, 2, 3, opt({ query: "hit" }))[1].value, "hit");
  check("findMatches 尊重 limit", coords(findMatches(grid, 2, 3, opt({ query: "hit" }), 2)), [[0, 0], [0, 2]]);
  check("findMatches limit=0 返回空", findMatches(grid, 2, 3, opt({ query: "hit" }), 0), []);
  check(
    "findMatches null 视为空串",
    findMatches({ "0:0": null, "0:1": "x" }, 1, 2, opt({ query: "^$", regex: true })),
    [{ row: 0, col: 0, value: "" }],
  );
  check("findMatches 缺失单元格不报错", findMatches({}, 2, 2, opt({ query: "hit" })), []);
  const big = {};
  for (let r = 0; r < 50; r++) for (let c = 0; c < 50; c++) big[`${r}:${c}`] = "x";
  check("findMatches 默认上限 2000", findMatches(big, 50, 50, opt({ query: "x" })).length, 2000);

  // ── findMatchesInOrder：只搜展示行且保序 ─────────────────────────
  const rowGrid = { "0:0": "hit", "1:0": "hit", "2:0": "hit" };
  check("按展示顺序搜索", coords(findMatchesInOrder(rowGrid, 3, 1, [2, 0], opt({ query: "hit" }))), [[2, 0], [0, 0]]);
  check("重复行只算一次", coords(findMatchesInOrder(rowGrid, 3, 1, [2, 2, 2], opt({ query: "hit" }))), [[2, 0]]);
  check("越界行安全跳过", coords(findMatchesInOrder(rowGrid, 3, 1, [9, -1, 1], opt({ query: "hit" }))), [[1, 0]]);
  check("不搜未列出的行", coords(findMatchesInOrder(rowGrid, 3, 1, [0], opt({ query: "hit" }))), [[0, 0]]);
  check("展示顺序下 limit 生效", coords(findMatchesInOrder(rowGrid, 3, 1, [2, 0, 1], opt({ query: "hit" }), 2)), [[2, 0], [0, 0]]);

  // ── replaceInValue ───────────────────────────────────────────────
  check("未命中返回原字符串", replaceInValue("abc", opt({ query: "z" }), "X"), "abc");
  check("未命中 null 仍为 null", replaceInValue(null, opt({ query: "a" }), "X"), null);
  check("null 命中可替换", replaceInValue(null, opt({ query: "^$", regex: true }), "X"), "X");
  check("包含匹配替换全部出现", replaceInValue("foo foo foo", opt({ query: "foo" }), "x"), "x x x");
  check("忽略大小写替换全部出现", replaceInValue("Foo foo", opt({ query: "foo" }), "x"), "x x");
  check("区分大小写只替换精确匹配", replaceInValue("Foo foo", opt({ query: "foo", matchCase: true }), "x"), "Foo x");
  check("整格匹配替换整格", replaceInValue("foo", opt({ query: "foo", wholeCell: true }), "bar"), "bar");
  check("整格匹配未命中不改值", replaceInValue("foobar", opt({ query: "foo", wholeCell: true }), "bar"), "foobar");
  check("整格匹配可替换为空串", replaceInValue("foo", opt({ query: "foo", wholeCell: true }), ""), "");

  // ── replaceAll：count / updates / truncated ──────────────────────
  const book = { "0:0": "foo", "1:1": "foo", "2:2": "bar" };
  check(
    "replaceAll 写入 updates 并计数",
    replaceAll(book, 3, 3, opt({ query: "foo" }), "baz"),
    { updates: { "0:0": "baz", "1:1": "baz" }, count: 2, truncated: false },
  );
  check(
    "replaceAll count 按单元格数而非出现次数",
    replaceAll({ "0:0": "foo foo foo" }, 1, 1, opt({ query: "foo" }), "x"),
    { updates: { "0:0": "x x x" }, count: 1, truncated: false },
  );
  check(
    "replaceAll 小 limit 触发 truncated",
    replaceAll(book, 3, 3, opt({ query: "foo" }), "baz", 1),
    { updates: { "0:0": "baz" }, count: 1, truncated: true },
  );
  check("replaceAll limit 足够则不截断", replaceAll(book, 3, 3, opt({ query: "foo" }), "baz", 2).truncated, false);
  check(
    "replaceAll 未命中不写 updates",
    replaceAll(book, 3, 3, opt({ query: "nope" }), "baz"),
    { updates: {}, count: 0, truncated: false },
  );
  check(
    "replaceAll 可清空单元格",
    replaceAll({ "0:0": "foo" }, 1, 1, opt({ query: "foo" }), ""),
    { updates: { "0:0": "" }, count: 1, truncated: false },
  );
  check(
    "replaceAll 原值为 null 且新值为空串时跳过",
    replaceAll({ "0:0": null }, 1, 1, opt({ query: "^$", regex: true }), ""),
    { updates: {}, count: 0, truncated: false },
  );

  // ── nextHitIndex：向前 / 向后 / 回绕 / 空表 / selected 为 null ────
  const hits = [
    { row: 0, col: 0, value: "hit" },
    { row: 0, col: 2, value: "hit" },
    { row: 1, col: 0, value: "hit" },
  ];
  check("nextHitIndex 向后取下一个", nextHitIndex(hits, { row: 0, col: 0 }, 1), 1);
  check("nextHitIndex 向前取上一个", nextHitIndex(hits, { row: 1, col: 0 }, -1), 1);
  check("nextHitIndex 向后回绕到 0", nextHitIndex(hits, { row: 1, col: 0 }, 1), 0);
  check("nextHitIndex 向前回绕到末尾", nextHitIndex(hits, { row: 0, col: 0 }, -1), 2);
  check("nextHitIndex 空表向后返回 -1", nextHitIndex([], { row: 0, col: 0 }, 1), -1);
  check("nextHitIndex 空表向前返回 -1", nextHitIndex([], null, -1), -1);
  check("nextHitIndex selected 为 null 取首个", nextHitIndex(hits, null, 1), 0);
  check("nextHitIndex selected 为 null 取末尾", nextHitIndex(hits, null, -1), 2);
  check("nextHitIndex 选中非命中格向后", nextHitIndex(hits, { row: 0, col: 1 }, 1), 1);
  check("nextHitIndex 选中非命中格向前", nextHitIndex(hits, { row: 0, col: 1 }, -1), 0);
  check("nextHitIndex 严格在其后（不含自身）", nextHitIndex(hits, { row: 0, col: 2 }, -1), 0);

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
