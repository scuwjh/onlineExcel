/**
 * 个性化快捷键（REQ-110）的纯逻辑层：命令目录 + 键位串解析 / 匹配 / 派发 / 冲突检测。
 *
 * 设计要点：
 * - **无任何依赖、无副作用**，可在浏览器与 Node（单测）里直接使用；
 * - 键位串是**与平台无关的规范形式**：`Ctrl` → `Meta` → `Alt` → `Shift` → 主键，
 *   例如 `Ctrl+Shift+1`、`Alt+=`、`Ctrl+Alt++`；
 * - `Ctrl` 与 `Meta` 在**匹配时等价**（macOS 的 ⌘ 与 Windows 的 Ctrl 共用一套配置），
 *   因此 `parseKeySpec` 保留两者、`matchesBinding` 只要求"二者之一"；
 * - `Alt` / `Shift` 严格匹配，避免 `Ctrl+5` 误吞 `Ctrl+Shift+5`；
 * - 事件主键会**还原 Shift 符号**（`!` → `1`、`?` → `/`），使 `Ctrl+Shift+1` 这类
 *   数字键快捷键在美式键盘上可用；
 * - 键位串的空串表示"已解绑"。
 */

export type CommandGroup = "编辑" | "格式" | "公式" | "结构" | "视图";

export interface CommandDef {
  id: string;
  label: string;
  group: CommandGroup;
  defaultKey: string;
  hint?: string;
}

/** 颜色类命令的上下文，取自 `UserPreferences.fillColors` / `highlightColors`。 */
export interface ShortcutContext {
  fillColors: string[];
  highlightColors: string[];
}

export interface KeySpec {
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

/** 键盘事件的最小结构（KeyboardEvent 或测试替身）。 */
export interface KeyLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

/** 颜色类命令最多生成 9 个（对应数字键 1..9）。 */
const MAX_COLOR_COMMANDS = 9;

/** 静态命令表（不含颜色类命令）。 */
export const BASE_COMMANDS: CommandDef[] = [
  // 编辑
  { id: "edit.find", label: "查找", group: "编辑", defaultKey: "Ctrl+F" },
  { id: "edit.replace", label: "替换", group: "编辑", defaultKey: "Ctrl+H" },
  { id: "edit.undo", label: "撤销", group: "编辑", defaultKey: "Ctrl+Z" },
  { id: "edit.redo", label: "重做", group: "编辑", defaultKey: "Ctrl+Y" },
  { id: "edit.copy", label: "复制", group: "编辑", defaultKey: "Ctrl+C" },
  { id: "edit.cut", label: "剪切", group: "编辑", defaultKey: "Ctrl+X" },
  { id: "edit.paste", label: "粘贴", group: "编辑", defaultKey: "Ctrl+V" },
  { id: "edit.clear", label: "清空内容", group: "编辑", defaultKey: "Delete" },
  { id: "edit.selectAll", label: "全选", group: "编辑", defaultKey: "Ctrl+A" },
  { id: "edit.edit", label: "编辑单元格", group: "编辑", defaultKey: "F2" },
  { id: "edit.fillDown", label: "向下填充", group: "编辑", defaultKey: "Ctrl+D" },
  { id: "edit.fillRight", label: "向右填充", group: "编辑", defaultKey: "Ctrl+R" },
  // 格式
  { id: "format.bold", label: "加粗", group: "格式", defaultKey: "Ctrl+B" },
  { id: "format.italic", label: "斜体", group: "格式", defaultKey: "Ctrl+I" },
  { id: "format.underline", label: "下划线", group: "格式", defaultKey: "Ctrl+U" },
  { id: "format.strike", label: "删除线", group: "格式", defaultKey: "Ctrl+5" },
  { id: "format.numFmt", label: "数字格式", group: "格式", defaultKey: "Ctrl+Shift+1" },
  { id: "format.percent", label: "百分比", group: "格式", defaultKey: "Ctrl+Shift+5" },
  { id: "format.borders", label: "边框", group: "格式", defaultKey: "Ctrl+Shift+7" },
  { id: "format.clear", label: "清除格式", group: "格式", defaultKey: "Ctrl+\\" },
  // 公式
  { id: "formula.sum", label: "自动求和", group: "公式", defaultKey: "Alt+=" },
  { id: "formula.average", label: "求平均", group: "公式", defaultKey: "Alt+Shift+=" },
  { id: "formula.insert", label: "插入公式", group: "公式", defaultKey: "Alt+F2" },
  // 结构
  { id: "merge.merge", label: "合并单元格", group: "结构", defaultKey: "Ctrl+M" },
  { id: "merge.unmerge", label: "取消合并", group: "结构", defaultKey: "Ctrl+Shift+M" },
  { id: "row.insert", label: "上方插入行", group: "结构", defaultKey: "Ctrl+Alt+=" },
  { id: "col.insert", label: "左侧插入列", group: "结构", defaultKey: "Ctrl+Alt++" },
  { id: "row.delete", label: "删除行", group: "结构", defaultKey: "Ctrl+Alt+-" },
  { id: "col.delete", label: "删除列", group: "结构", defaultKey: "Ctrl+Alt+Shift+-" },
  // 视图
  { id: "view.freeze", label: "冻结到当前单元格", group: "视图", defaultKey: "Ctrl+Alt+F" },
  { id: "view.settings", label: "打开设置", group: "视图", defaultKey: "Ctrl+," },
  { id: "view.comments", label: "评论面板", group: "视图", defaultKey: "Ctrl+Alt+M" },
  { id: "view.versions", label: "历史版本", group: "视图", defaultKey: "Ctrl+Alt+V" },
];

/** 颜色类命令：常用填色 / 高亮色按顺序绑定到 `Ctrl+Alt+1..9`、`Ctrl+Shift+Alt+1..9`。 */
export function dynamicCommands(ctx: ShortcutContext): CommandDef[] {
  const out: CommandDef[] = [];
  for (const color of (ctx?.fillColors ?? []).slice(0, MAX_COLOR_COMMANDS)) {
    const n = out.length + 1;
    out.push({ id: `format.fill.${color}`, label: `填充 ${color}`, group: "格式", defaultKey: `Ctrl+Alt+${n}` });
  }
  const highlights = (ctx?.highlightColors ?? []).slice(0, MAX_COLOR_COMMANDS);
  highlights.forEach((color, i) => {
    out.push({
      id: `format.highlight.${color}`,
      label: `高亮 ${color}`,
      group: "格式",
      defaultKey: `Ctrl+Shift+Alt+${i + 1}`,
    });
  });
  return out;
}

/** 静态命令 + 颜色类命令（顺序即派发优先级）。 */
export function allCommands(ctx: ShortcutContext): CommandDef[] {
  return [...BASE_COMMANDS, ...dynamicCommands(ctx)];
}

/** 命令 ID → 默认键位串（只含 defaultKey 非空的命令）。 */
export function defaultBindings(ctx: ShortcutContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const cmd of allCommands(ctx)) {
    if (cmd.defaultKey) out[cmd.id] = cmd.defaultKey;
  }
  return out;
}

/**
 * 默认表 + 用户覆盖。overrides 的值为空串表示**解绑**（从结果中删除该命令）；
 * overrides 里未出现在默认表中的命令（如插件命令）同样保留。
 */
export function resolveBindings(ctx: ShortcutContext, overrides: Record<string, string>): Record<string, string> {
  const out = defaultBindings(ctx);
  for (const [id, spec] of Object.entries(overrides ?? {})) {
    if (spec === "") delete out[id];
    else if (typeof spec === "string") out[id] = spec;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 键位串解析
// ---------------------------------------------------------------------------

type ModifierName = "ctrl" | "meta" | "alt" | "shift";

/** 修饰键别名（大小写不敏感；⌘/⌥ 等符号直接匹配）。 */
const MODIFIER_ALIASES: Record<string, ModifierName> = {
  ctrl: "ctrl",
  control: "ctrl",
  "⌃": "ctrl",
  meta: "meta",
  cmd: "meta",
  command: "meta",
  "⌘": "meta",
  alt: "alt",
  option: "alt",
  "⌥": "alt",
  shift: "shift",
  "⇧": "shift",
};

/** 事件里"只按了修饰键"的 key 值。 */
const PURE_MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock", "NumLock", "ScrollLock"]);

/** 具名主键（小写 → 规范写法）。 */
const NAMED_KEYS: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  tab: "Tab",
  escape: "Escape",
  delete: "Delete",
  backspace: "Backspace",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
};

/** 美式键盘 Shift 后的符号 → 基础键。 */
const SHIFT_SYMBOLS: Record<string, string> = {
  "!": "1",
  "@": "2",
  "#": "3",
  "$": "4",
  "%": "5",
  "^": "6",
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
  "~": "`",
};

/** 主键规范化：单字符字母大写、空格 → Space、具名键按规范大小写、F1..F12。 */
function canonicalKey(raw: string): string {
  if (raw === "") return "";
  if (raw === " " || raw === "Spacebar") return "Space";
  if (raw.length === 1) {
    return /[a-z]/i.test(raw) ? raw.toUpperCase() : raw;
  }
  const fn = /^f([1-9]|1[0-2])$/i.exec(raw);
  if (fn) return `F${fn[1]}`;
  return NAMED_KEYS[raw.toLowerCase()] ?? "";
}

/** 解析键位串；非法返回 null。 */
export function parseKeySpec(spec: string): KeySpec | null {
  const r = parseKeySpecDetailed(spec);
  return r.ok ? r.spec : null;
}

type ParseResult = { ok: true; spec: KeySpec } | { ok: false; error: string };

/** 带错误原因的解析，供 validateKeySpec 复用。 */
function parseKeySpecDetailed(spec: unknown): ParseResult {
  if (typeof spec !== "string") return { ok: false, error: "键位串必须是字符串" };
  const raw = spec.trim();
  if (raw === "") return { ok: false, error: "键位串不能为空" };

  // `+` 既是分隔符又是主键：只有写成 `Ctrl+Alt++` / `Ctrl++` 时，末尾的 `++` 才表示主键 `+`。
  let rest = raw;
  let plusIsMainKey = false;
  if (raw.length >= 2 && raw.endsWith("++")) {
    plusIsMainKey = true;
    rest = raw.slice(0, -2);
    if (rest === "") return { ok: false, error: "键位串不能只有 ++，请写成 Ctrl+Alt++ 这样的形式" };
  }

  const tokens = rest.split("+");
  if (tokens.some((t) => t.trim() === "")) {
    return { ok: false, error: `键位串格式错误：${raw} 中出现了多余的 +` };
  }

  const mods: Record<ModifierName, boolean> = { ctrl: false, meta: false, alt: false, shift: false };
  const keys: string[] = [];
  for (const token of tokens) {
    const alias = MODIFIER_ALIASES[token.toLowerCase()] ?? MODIFIER_ALIASES[token];
    if (alias) mods[alias] = true;
    else keys.push(token);
  }
  if (plusIsMainKey) {
    if (keys.length > 0) return { ok: false, error: `只能有一个主键：${raw}` };
    keys.push("+");
  }

  if (keys.length === 0) return { ok: false, error: "缺少主键：修饰键之后需要接一个主键（如 Ctrl+B）" };
  if (keys.length > 1) return { ok: false, error: `只能有一个主键：${keys.join("、")}` };
  const key = canonicalKey(keys[0]);
  if (!key) return { ok: false, error: `无法识别的按键：${keys[0]}` };

  return { ok: true, spec: { ctrl: mods.ctrl, meta: mods.meta, shift: mods.shift, alt: mods.alt, key } };
}

// ---------------------------------------------------------------------------
// 事件 → 键位串
// ---------------------------------------------------------------------------

/** 事件的规范化主键；无法识别或纯修饰键返回空串。 */
function eventKey(e: KeyLike): string {
  const raw = e?.key;
  if (typeof raw !== "string" || raw === "") return "";
  if (PURE_MODIFIER_KEYS.has(raw)) return "";
  // Shift 符号还原：按下 `!` 等价于 `Shift+1`
  const base = e.shiftKey && SHIFT_SYMBOLS[raw] ? SHIFT_SYMBOLS[raw] : raw;
  return canonicalKey(base);
}

/** 事件 → 规范化键位串（如 `Ctrl+Shift+Z`）；纯修饰键返回空串，调用方应忽略。 */
export function normalizeKey(e: KeyLike): string {
  const key = eventKey(e);
  if (!key) return "";
  const parts: string[] = [];
  if (e.ctrlKey) parts.push("Ctrl");
  if (e.metaKey) parts.push("Meta");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** 事件是否命中某个键位串（Ctrl 与 Meta 等价；Alt/Shift 严格匹配）。 */
export function matchesBinding(spec: string, e: KeyLike): boolean {
  const parsed = parseKeySpec(spec);
  if (!parsed) return false;
  const key = eventKey(e);
  if (!key) return false;
  if (parsed.key.toUpperCase() !== key.toUpperCase()) return false;

  const eventCtrlOrMeta = Boolean(e.ctrlKey) || Boolean(e.metaKey);
  if (parsed.ctrl || parsed.meta) {
    if (!eventCtrlOrMeta) return false;
  } else if (eventCtrlOrMeta) {
    return false;
  }
  if (parsed.alt !== Boolean(e.altKey)) return false;
  if (parsed.shift !== Boolean(e.shiftKey)) return false;
  return true;
}

/** 按 `allCommands(ctx)` 的顺序返回首个命中的命令 ID；无命中返回 null。 */
export function findCommand(e: KeyLike, bindings: Record<string, string>, ctx: ShortcutContext): string | null {
  for (const cmd of allCommands(ctx)) {
    const spec = bindings?.[cmd.id];
    if (!spec) continue; // 空串 = 已解绑
    if (matchesBinding(spec, e)) return cmd.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 展示 / 校验 / 冲突
// ---------------------------------------------------------------------------

/** 无 DOM 环境（Node 单测）一律按 other，避免 Node 21+ 自带的 navigator.platform 干扰。 */
function detectMac(): boolean {
  if (typeof window === "undefined") return false;
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  if (!nav) return false;
  return /mac/i.test(`${nav.platform ?? ""} ${nav.userAgent ?? ""}`);
}

/** 键位串 → 展示文案；无法解析的原样返回。 */
export function formatKeySpec(spec: string, platform?: "mac" | "other"): string {
  const parsed = parseKeySpec(spec);
  if (!parsed) return spec;
  const isMac = platform === "mac" || (platform !== "other" && detectMac());
  if (isMac) {
    // Ctrl 与 Meta 等价，统一显示为 ⌘（macOS 上的常用键）
    const cmdLike = parsed.ctrl || parsed.meta;
    return `${cmdLike ? "⌘" : ""}${parsed.alt ? "⌥" : ""}${parsed.shift ? "⇧" : ""}${parsed.key}`;
  }
  const parts: string[] = [];
  if (parsed.ctrl) parts.push("Ctrl");
  if (parsed.meta) parts.push("Meta");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

/** 校验用户输入的键位串；空串合法（表示解绑）。 */
export function validateKeySpec(spec: string): { ok: boolean; error?: string } {
  if (typeof spec !== "string") return { ok: false, error: "键位串必须是字符串" };
  if (spec.trim() === "") return { ok: true };
  if (spec.length > 40) return { ok: false, error: `键位串过长（${spec.length} 个字符，最多 40 个）` };
  const r = parseKeySpecDetailed(spec);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/** 找出被多个命令占用的同一键位串（忽略空串），按 spec 排序。 */
export function conflicts(bindings: Record<string, string>): Array<{ spec: string; commands: string[] }> {
  const bySpec = new Map<string, string[]>();
  for (const [id, spec] of Object.entries(bindings ?? {})) {
    if (typeof spec !== "string") continue;
    const s = spec.trim();
    if (s === "") continue; // 空串 = 解绑，不算冲突
    const list = bySpec.get(s);
    if (list) list.push(id);
    else bySpec.set(s, [id]);
  }
  const out: Array<{ spec: string; commands: string[] }> = [];
  for (const [spec, commands] of bySpec) {
    if (commands.length > 1) out.push({ spec, commands });
  }
  out.sort((a, b) => (a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0));
  return out;
}
