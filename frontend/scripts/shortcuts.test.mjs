import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 用系统临时目录，避免硬编码 "/tmp" 在 Windows 上被解析成 C:\tmp
const workDir = mkdtempSync(join(tmpdir(), "oe-shortcuts-"));
const bundlePath = join(workDir, "shortcuts.bundle.mjs");

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}\n  got ${a}\n  exp ${e}`); }
}

let parseKeySpec, normalizeKey, matchesBinding, findCommand, resolveBindings,
    defaultBindings, dynamicCommands, allCommands, conflicts, validateKeySpec,
    formatKeySpec, BASE_COMMANDS;

const spec = (ctrl, meta, shift, alt, key) => ({ ctrl, meta, shift, alt, key });
const ctx = {
  fillColors: ["#fff2cc", "#fce4d6", "#e2efda", "#deebf7", "#e4dfec", "#ffd966", "#f8cbad", "#c6e0b4", "#d9d9d9", "#cccccc"],
  highlightColors: ["#d93025", "#e37400", "#188038"],
};

try {
  await build({
    entryPoints: ["src/lib/shortcuts.ts"],
    bundle: true,
    format: "esm",
    outfile: bundlePath,
    logLevel: "silent",
  });
  ({
    parseKeySpec, normalizeKey, matchesBinding, findCommand, resolveBindings,
    defaultBindings, dynamicCommands, allCommands, conflicts, validateKeySpec,
    formatKeySpec, BASE_COMMANDS,
  } = await import(pathToFileURL(bundlePath).href));

  console.log("shortcuts 单元测试");

  // ---- parseKeySpec：正常 / 大小写 / 别名 / 任意顺序 / 非法 ----
  check("解析 Ctrl+Shift+1", parseKeySpec("Ctrl+Shift+1"), spec(true, false, true, false, "1"));
  check("解析大小写不敏感 ctrl+b", parseKeySpec("ctrl+b"), spec(true, false, false, false, "B"));
  check("别名 Cmd → Meta", parseKeySpec("Cmd+Z"), spec(false, true, false, false, "Z"));
  check("别名 Command → Meta", parseKeySpec("Command+Shift+K"), spec(false, true, true, false, "K"));
  check("别名 ⌘ → Meta", parseKeySpec("⌘+Z"), spec(false, true, false, false, "Z"));
  check("别名 Option → Alt", parseKeySpec("Option+2"), spec(false, false, false, true, "2"));
  check("别名 ⌥ → Alt", parseKeySpec("⌥+H"), spec(false, false, false, true, "H"));
  check("修饰键任意顺序", parseKeySpec("Shift+Alt+Ctrl+H"), spec(true, false, true, true, "H"));
  check("颜色命令键位任意顺序", parseKeySpec("Ctrl+Shift+Alt+3"), spec(true, false, true, true, "3"));
  check("主键 + 作为唯一字符", parseKeySpec("Ctrl+Alt++"), spec(true, false, false, true, "+"));
  check("反斜杠主键", parseKeySpec("Ctrl+\\"), spec(true, false, false, false, "\\"));
  check("逗号主键", parseKeySpec("Ctrl+,"), spec(true, false, false, false, ","));
  check("空格主键", parseKeySpec("Space"), spec(false, false, false, false, "Space"));
  check("功能键保持 Enter", parseKeySpec("Alt+Enter"), spec(false, false, false, true, "Enter"));
  check("空串返回 null", parseKeySpec(""), null);
  check("只有修饰键返回 null", parseKeySpec("Ctrl+"), null);
  check("Ctrl+Shift+ 返回 null", parseKeySpec("Ctrl+Shift+"), null);
  check("++ 返回 null", parseKeySpec("++"), null);
  check("Ctrl++B 返回 null", parseKeySpec("Ctrl++B"), null);
  check("未知按键返回 null", parseKeySpec("Ctrl+Foobar"), null);
  check("未知修饰键返回 null", parseKeySpec("Hyper+B"), null);
  check("多个主键返回 null", parseKeySpec("Ctrl+B+C"), null);

  // ---- normalizeKey：字母大写 / Shift 符号还原 / 纯修饰键 ----
  check("字母转大写", normalizeKey({ key: "b" }), "B");
  check("字母加 Ctrl", normalizeKey({ key: "b", ctrlKey: true }), "Ctrl+B");
  check("Shift+! 还原为 Ctrl+Shift+1", normalizeKey({ key: "!", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+1");
  check("Shift+@ 还原为 Shift+2", normalizeKey({ key: "@", shiftKey: true }), "Shift+2");
  check("Shift+? 还原为 Shift+/", normalizeKey({ key: "?", shiftKey: true }), "Shift+/");
  check("Shift+# 还原为 Ctrl+Shift+3", normalizeKey({ key: "#", ctrlKey: true, shiftKey: true }), "Ctrl+Shift+3");
  check("空格 → Space", normalizeKey({ key: " " }), "Space");
  check("纯修饰键 Control 返回空串", normalizeKey({ key: "Control" }), "");
  check("纯修饰键 Meta 返回空串", normalizeKey({ key: "Meta" }), "");
  check("纯修饰键 Alt 返回空串", normalizeKey({ key: "Alt" }), "");
  check("纯修饰键 Shift 返回空串", normalizeKey({ key: "Shift" }), "");
  check("修饰键固定顺序", normalizeKey({ key: "Z", ctrlKey: true, metaKey: true, altKey: true, shiftKey: true }), "Ctrl+Meta+Alt+Shift+Z");
  check("方向键保持", normalizeKey({ key: "ArrowUp" }), "ArrowUp");
  check("小写具名键规范化", normalizeKey({ key: "escape", altKey: true }), "Alt+Escape");
  check("数字键不还原时保持", normalizeKey({ key: "5", ctrlKey: true }), "Ctrl+5");
  check("小键盘 + 保持为 +", normalizeKey({ key: "+", ctrlKey: true, altKey: true }), "Ctrl+Alt++");

  // ---- matchesBinding：Ctrl/Meta 等价、Alt/Shift 严格 ----
  check("spec Ctrl 命中 ctrlKey", matchesBinding("Ctrl+B", { key: "b", ctrlKey: true }), true);
  check("spec Ctrl 命中 metaKey", matchesBinding("Ctrl+B", { key: "b", metaKey: true }), true);
  check("spec Meta 命中 ctrlKey", matchesBinding("Meta+B", { key: "b", ctrlKey: true }), true);
  check("无修饰键事件不命中 Ctrl+B", matchesBinding("Ctrl+B", { key: "b" }), false);
  check("spec 无修饰键时不接受 Ctrl", matchesBinding("B", { key: "b", ctrlKey: true }), false);
  check("无修饰键严格匹配", matchesBinding("B", { key: "b" }), true);
  check("Ctrl+Shift+1 命中 Shift+!", matchesBinding("Ctrl+Shift+1", { key: "!", ctrlKey: true, shiftKey: true }), true);
  check("Ctrl+5 不接受 Shift", matchesBinding("Ctrl+5", { key: "5", ctrlKey: true, shiftKey: true }), false);
  check("Alt+2 命中 altKey", matchesBinding("Alt+2", { key: "2", altKey: true }), true);
  check("Alt+2 不接受 Shift", matchesBinding("Alt+2", { key: "2", altKey: true, shiftKey: true }), false);
  check("Alt+Shift+= 命中", matchesBinding("Alt+Shift+=", { key: "=", altKey: true, shiftKey: true }), true);
  check("Alt+= 不接受 Shift", matchesBinding("Alt+=", { key: "=", altKey: true, shiftKey: true }), false);
  check("Ctrl+Alt++ 命中小键盘 +", matchesBinding("Ctrl+Alt++", { key: "+", ctrlKey: true, altKey: true }), true);
  check("Delete 命中", matchesBinding("Delete", { key: "Delete" }), true);
  check("纯修饰键事件不命中", matchesBinding("Ctrl+B", { key: "Control", ctrlKey: true }), false);

  // ---- 命令表 ----
  const baseMap = new Map(BASE_COMMANDS.map((c) => [c.id, c.defaultKey]));
  check("BASE_COMMANDS 数量", BASE_COMMANDS.length, 33);
  check("edit.find 默认键", baseMap.get("edit.find"), "Ctrl+F");
  check("edit.clear 默认键", baseMap.get("edit.clear"), "Delete");
  check("edit.edit 默认键", baseMap.get("edit.edit"), "F2");
  check("format.strike 默认键", baseMap.get("format.strike"), "Ctrl+5");
  check("format.numFmt 默认键", baseMap.get("format.numFmt"), "Ctrl+Shift+1");
  check("format.clear 默认键", baseMap.get("format.clear"), "Ctrl+\\");
  check("formula.sum 默认键", baseMap.get("formula.sum"), "Alt+=");
  check("col.insert 默认键", baseMap.get("col.insert"), "Ctrl+Alt++");
  check("col.delete 默认键", baseMap.get("col.delete"), "Ctrl+Alt+Shift+-");
  check("view.settings 默认键", baseMap.get("view.settings"), "Ctrl+,");
  check("命令分组", BASE_COMMANDS.filter((c) => c.group === "结构").map((c) => c.id),
    ["merge.merge", "merge.unmerge", "row.insert", "col.insert", "row.delete", "col.delete"]);

  // ---- dynamicCommands：id / label / defaultKey 顺序 ----
  const dyn = dynamicCommands(ctx);
  check("颜色命令只取前 9 个填色", dyn.filter((c) => c.id.startsWith("format.fill.")).length, 9);
  check("动态命令总数（9 填色 + 3 高亮）", dyn.length, 12);
  check("第一个填色命令", dyn[0], { id: "format.fill.#fff2cc", label: "填充 #fff2cc", group: "格式", defaultKey: "Ctrl+Alt+1" });
  check("第三个填色命令", dyn[2], { id: "format.fill.#e2efda", label: "填充 #e2efda", group: "格式", defaultKey: "Ctrl+Alt+3" });
  check("第九个填色命令", dyn[8].defaultKey, "Ctrl+Alt+9");
  check("第一个高亮命令", dyn[9], { id: "format.highlight.#d93025", label: "高亮 #d93025", group: "格式", defaultKey: "Ctrl+Shift+Alt+1" });
  check("allCommands = 静态表 + 动态命令", allCommands(ctx).length, BASE_COMMANDS.length + dyn.length);
  check("allCommands 静态表在前", allCommands(ctx).slice(0, BASE_COMMANDS.length).map((c) => c.id), BASE_COMMANDS.map((c) => c.id));

  // ---- defaultBindings / resolveBindings ----
  const defaults = defaultBindings(ctx);
  check("默认表不含空键位", Object.values(defaults).every((v) => v !== ""), true);
  check("默认表条目数", Object.keys(defaults).length, BASE_COMMANDS.length + dyn.length);
  check("默认表含动态填色 Ctrl+Alt+1", defaults["format.fill.#fff2cc"], "Ctrl+Alt+1");
  const overridden = resolveBindings(ctx, { "format.bold": "Ctrl+Shift+B" });
  check("覆盖单个命令", overridden["format.bold"], "Ctrl+Shift+B");
  check("覆盖不影响其它默认", overridden["edit.undo"], "Ctrl+Z");
  const unbound = resolveBindings(ctx, { "edit.undo": "" });
  check("空串解绑", Object.prototype.hasOwnProperty.call(unbound, "edit.undo"), false);
  check("解绑不影响其它命令", unbound["edit.redo"], "Ctrl+Y");
  check("保留默认表外的命令", resolveBindings(ctx, { "my.custom": "Ctrl+Alt+J" })["my.custom"], "Ctrl+Alt+J");
  check("默认表无冲突", conflicts(defaults), []);
  check("存在冲突时能发现（默认+覆盖）", conflicts(resolveBindings(ctx, { "format.bold": "Ctrl+I" })), [{ spec: "Ctrl+I", commands: ["format.bold", "format.italic"] }]);

  // ---- findCommand ----
  check("Ctrl+B 命中加粗", findCommand({ key: "b", ctrlKey: true }, defaults, ctx), "format.bold");
  check("⌘+B 命中加粗（等价）", findCommand({ key: "b", metaKey: true }, defaults, ctx), "format.bold");
  check("Ctrl+Shift+1 命中数字格式", findCommand({ key: "!", ctrlKey: true, shiftKey: true }, defaults, ctx), "format.numFmt");
  check("Ctrl+5 命中删除线", findCommand({ key: "5", ctrlKey: true }, defaults, ctx), "format.strike");
  check("Ctrl+Alt+1 命中填色", findCommand({ key: "1", ctrlKey: true, altKey: true }, defaults, ctx), "format.fill.#fff2cc");
  check("Ctrl+Shift+Alt+1 命中高亮", findCommand({ key: "1", ctrlKey: true, shiftKey: true, altKey: true }, defaults, ctx), "format.highlight.#d93025");
  check("未绑定组合返回 null", findCommand({ key: "q", ctrlKey: true }, defaults, ctx), null);
  check("解绑后不再命中", findCommand({ key: "b", ctrlKey: true }, resolveBindings(ctx, { "format.bold": "" }), ctx), null);
  check("空串键位被跳过", findCommand({ key: "b", ctrlKey: true }, { "format.bold": "" }, ctx), null);

  // ---- conflicts ----
  check("两个命令撞键", conflicts({ a: "Ctrl+B", b: "Ctrl+B", c: "Ctrl+I" }), [{ spec: "Ctrl+B", commands: ["a", "b"] }]);
  check("单命令不算冲突", conflicts({ a: "Ctrl+B", b: "Ctrl+I" }), []);
  check("忽略空串", conflicts({ a: "Ctrl+B", b: "", c: "  " }), []);
  check("多组冲突按 spec 排序", conflicts({ a: "Ctrl+Z", b: "Ctrl+A", c: "Ctrl+Z", d: "Ctrl+A" }),
    [{ spec: "Ctrl+A", commands: ["b", "d"] }, { spec: "Ctrl+Z", commands: ["a", "c"] }]);

  // ---- validateKeySpec ----
  check("空串表示解绑，合法", validateKeySpec(""), { ok: true });
  check("Ctrl+B 合法", validateKeySpec("Ctrl+B"), { ok: true });
  check("Ctrl+ 缺主键非法", validateKeySpec("Ctrl+").ok, false);
  check("Ctrl+ 给出中文原因", typeof validateKeySpec("Ctrl+").error === "string", true);
  check("Ctrl+Foobar 未知键名非法", validateKeySpec("Ctrl+Foobar").ok, false);
  check("Ctrl+Foobar 给出中文原因", typeof validateKeySpec("Ctrl+Foobar").error === "string", true);
  check("超长键位串非法", validateKeySpec(`Ctrl+${"A".repeat(40)}`).ok, false);
  check("超长键位串给出中文原因", typeof validateKeySpec(`Ctrl+${"A".repeat(40)}`).error === "string", true);
  check("Ctrl+Alt++ 合法", validateKeySpec("Ctrl+Alt++"), { ok: true });
  check("Ctrl+Shift+Alt+1 合法", validateKeySpec("Ctrl+Shift+Alt+1"), { ok: true });

  // ---- formatKeySpec ----
  check("mac 显示 ⌘⇧Z", formatKeySpec("Ctrl+Shift+Z", "mac"), "⌘⇧Z");
  check("mac 显示 ⌘⌥H", formatKeySpec("Ctrl+Alt+H", "mac"), "⌘⌥H");
  check("mac Meta 同样显示 ⌘", formatKeySpec("Meta+B", "mac"), "⌘B");
  check("mac 无分隔符", formatKeySpec("Ctrl+Shift+1", "mac"), "⌘⇧1");
  check("mac 小键盘加号", formatKeySpec("Ctrl+Alt++", "mac"), "⌘⌥+");
  check("other 显示 Ctrl+Shift+Z", formatKeySpec("Ctrl+Shift+Z", "other"), "Ctrl+Shift+Z");
  check("other 显示 Alt+2", formatKeySpec("Alt+2", "other"), "Alt+2");
  check("other 显示 Meta", formatKeySpec("Meta+B", "other"), "Meta+B");
  check("无 DOM 环境默认按 other", formatKeySpec("Ctrl+Shift+Z"), "Ctrl+Shift+Z");
  check("无法解析时原样返回", formatKeySpec("Ctrl+Foobar", "mac"), "Ctrl+Foobar");

  console.log(`\n${pass} 通过, ${fail} 失败`);
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

process.exit(fail ? 1 : 0);
