/**
 * 个性化设置面板（REQ-110 / REQ-112 / REQ-115）。
 *
 * - 快捷键：按命令分组展示，支持逐条「设置」（按下按键即录制）、清除绑定、恢复默认，
 *   并在顶部实时提示按键冲突；
 * - 常用颜色：维护 `fillColors` / `highlightColors` 两个列表，
 *   列表顺序即 `Ctrl+Alt+1..9` / `Ctrl+Shift+Alt+1..9` 的绑定顺序；
 * - Enter 行为：Enter 提交后光标移动方向；
 * - 钉钉机器人：展示服务端集成状态，并允许表格所有者发送测试消息。
 *
 * 本组件不直接发起网络请求：状态与回调全部由父组件传入。
 */
import { useEffect, useMemo, useState } from "react";
import type { DingTalkStatus } from "../api";
import { conflicts, formatKeySpec, normalizeKey } from "../lib/shortcuts";
import type { CommandDef, CommandGroup } from "../lib/shortcuts";
import { DEFAULT_FILL_COLORS, DEFAULT_HIGHLIGHT_COLORS, ENTER_DIRECTIONS } from "../types";
import type { EnterDirection, UserPreferences } from "../types";

interface Props {
  prefs: UserPreferences;
  commands: CommandDef[];
  /** 命令 ID → 生效键位串（父层已合并默认值）；空串 / 缺失都表示未绑定。 */
  bindings: Record<string, string>;
  loading: boolean;
  saving: boolean;
  error: string | null;
  dingtalk: DingTalkStatus | null;
  canTestDingTalk: boolean;
  onSetKey: (commandId: string, spec: string) => { ok: boolean; error?: string };
  onUpdate: (patch: Partial<UserPreferences>) => void;
  onResetShortcuts: () => void;
  onSave: () => Promise<boolean>;
  onTestDingTalk: () => Promise<void>;
  onClose: () => void;
  onNotify: (message: string) => void;
}

/** 颜色列表最多 9 项：对应 Ctrl+Alt+1..9（高亮为 Ctrl+Shift+Alt+1..9）。 */
const MAX_COLORS = 9;

/** 分组展示顺序（只影响阅读顺序，不影响快捷键派发优先级）。 */
const GROUP_ORDER: CommandGroup[] = ["编辑", "格式", "公式", "结构", "视图"];

/** 两组颜色列表的键，用字面量联合以便安全地构造 `Partial<UserPreferences>`。 */
type ColorKey = "fillColors" | "highlightColors";

/** 平台判定：macOS 显示 ⌘/⌥/⇧，其它平台显示 Ctrl/Alt/Shift。 */
function detectPlatform(): "mac" | "other" {
  if (typeof navigator === "undefined") return "other";
  return /Mac/i.test(navigator.platform) ? "mac" : "other";
}

/** `<input type="color">` 只接受 `#rrggbb`；异常值回退为默认色，避免受控告警。 */
function safeColor(value: string, fallback: string): string {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export default function SettingsPanel(props: Props) {
  const { prefs, commands, bindings, loading, saving, error, dingtalk, canTestDingTalk } = props;

  /** 正在录制的命令 ID；null 表示没有录制。 */
  const [capturing, setCapturing] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [colorDraft, setColorDraft] = useState<Record<ColorKey, string>>({
    fillColors: safeColor(DEFAULT_FILL_COLORS[0] ?? "", "#fff2cc"),
    highlightColors: safeColor(DEFAULT_HIGHLIGHT_COLORS[0] ?? "", "#d93025"),
  });

  const platform = useMemo<"mac" | "other">(() => detectPlatform(), []);

  /** 命令 ID → 展示名（冲突提示里用中文名而不是内部 ID）。 */
  const labelOf = useMemo(() => {
    const map = new Map(commands.map((cmd) => [cmd.id, cmd.label]));
    return (id: string) => map.get(id) ?? id;
  }, [commands]);

  /** 按固定分组顺序整理命令；未知分组（如插件命令）追加在末尾。 */
  const groups = useMemo(() => {
    const byGroup = new Map<CommandGroup, CommandDef[]>();
    for (const cmd of commands) {
      const list = byGroup.get(cmd.group);
      if (list) list.push(cmd);
      else byGroup.set(cmd.group, [cmd]);
    }
    const out: Array<{ group: CommandGroup; items: CommandDef[] }> = [];
    for (const group of GROUP_ORDER) {
      const items = byGroup.get(group);
      if (items?.length) out.push({ group, items });
    }
    for (const [group, items] of byGroup) {
      if (!GROUP_ORDER.includes(group)) out.push({ group, items });
    }
    return out;
  }, [commands]);

  const conflictList = useMemo(() => conflicts(bindings), [bindings]);

  /** 录制态：捕获阶段监听 window.keydown，抢在表格自身快捷键之前处理。 */
  useEffect(() => {
    if (!capturing) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setCapturing(null);
        return;
      }
      const spec = normalizeKey(e);
      if (!spec) return; // 只按了修饰键，继续等待主键
      const result = props.onSetKey(capturing, spec);
      if (!result.ok && result.error) props.onNotify(result.error);
      setCapturing(null);
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [capturing, props]);

  /** 追加颜色：同列表内去重，满 9 个后不再追加。 */
  const addColor = (key: ColorKey) => {
    const colors = prefs[key];
    const value = colorDraft[key].toLowerCase();
    if (colors.length >= MAX_COLORS) return;
    if (colors.some((c) => c.toLowerCase() === value)) return;
    const next = [...colors, value];
    props.onUpdate(key === "fillColors" ? { fillColors: next } : { highlightColors: next });
  };

  /** 删除某个颜色（按值删除第一个匹配项）。 */
  const removeColor = (key: ColorKey, color: string) => {
    const next = prefs[key].filter((c) => c !== color);
    props.onUpdate(key === "fillColors" ? { fillColors: next } : { highlightColors: next });
  };

  /** 填色 / 高亮共用的列表渲染。 */
  const renderColorList = (key: ColorKey, title: string, hint: string) => {
    const colors = prefs[key];
    const draft = colorDraft[key];
    const duplicated = colors.some((c) => c.toLowerCase() === draft.toLowerCase());
    const full = colors.length >= MAX_COLORS;
    return (
      <div className="column" style={{ gap: 6 }} key={key}>
        <div className="view-row">
          <span className="view-label">{title}</span>
          <span className="muted">{hint}</span>
          <span className="spacer-flex" />
          <span className="muted">
            {colors.length} / {MAX_COLORS}
          </span>
        </div>
        <div className="view-row" style={{ flexWrap: "wrap" }}>
          {colors.length === 0 && <span className="muted">暂无常用颜色</span>}
          {colors.map((color, index) => (
            <span className="view-row" key={`${color}-${index}`} style={{ gap: 4 }}>
              <span
                style={{
                  display: "inline-block",
                  width: 18,
                  height: 18,
                  borderRadius: 3,
                  border: "1px solid #d0d5dd",
                  background: color,
                }}
              />
              <span className="muted">{color}</span>
              <button onClick={() => removeColor(key, color)}>删除</button>
            </span>
          ))}
        </div>
        <div className="view-row">
          <input
            type="color"
            value={safeColor(draft, key === "fillColors" ? "#fff2cc" : "#d93025")}
            onChange={(e) => setColorDraft((prev) => ({ ...prev, [key]: e.target.value }))}
          />
          <button onClick={() => addColor(key)} disabled={full || duplicated}>
            {duplicated ? "已存在" : "添加"}
          </button>
          {full && <span className="muted">最多 9 个（对应 Ctrl+Alt+1..9）</span>}
        </div>
      </div>
    );
  };

  return (
    <div className="panel settings-panel">
      <div className="panel-head">
        <strong>个性化设置</strong>
        <span className="spacer-flex" />
        <button className="ghost" onClick={props.onClose}>
          关闭
        </button>
      </div>

      <div className="panel-body column">
        {loading ? (
          <div className="muted">设置加载中…</div>
        ) : (
          <>
            {/* ------------------------------------------------ 快捷键 */}
            <div className="column" style={{ gap: 6 }}>
              <div className="view-row">
                <span className="view-label">快捷键</span>
                <span className="muted">点击「设置」后按下想要的组合键，Esc 取消</span>
                <span className="spacer-flex" />
                <button onClick={props.onResetShortcuts}>恢复默认快捷键</button>
              </div>

              {conflictList.length === 0 ? (
                <div className="muted">无按键冲突</div>
              ) : (
                <div className="error inline">
                  {conflictList.map((item) => (
                    <div key={item.spec}>
                      「{formatKeySpec(item.spec, platform)}」被「
                      {item.commands.map((id) => labelOf(id)).join("、")}」同时占用
                    </div>
                  ))}
                </div>
              )}

              {groups.map(({ group, items }) => (
                <div className="column" style={{ gap: 4 }} key={group}>
                  <div className="muted">{group}</div>
                  {items.map((cmd) => {
                    const spec = bindings[cmd.id] ?? "";
                    const bound = spec !== "";
                    const recording = capturing === cmd.id;
                    return (
                      <div className="view-row" key={cmd.id}>
                        <span className="view-label" style={{ minWidth: 140 }}>
                          {cmd.label}
                        </span>
                        <span className="tag">{bound ? formatKeySpec(spec, platform) : "未绑定"}</span>
                        <button onClick={() => setCapturing(recording ? null : cmd.id)}>
                          {recording ? "按下按键…Esc 取消" : "设置"}
                        </button>
                        <button onClick={() => props.onSetKey(cmd.id, "")} disabled={!bound}>
                          清除
                        </button>
                        {cmd.hint && <span className="muted">{cmd.hint}</span>}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* -------------------------------------------- 常用颜色 */}
            <div className="view-row">
              <span className="view-label">常用颜色</span>
              <span className="muted">顺序即快捷键 Ctrl+Alt+1..9 / Ctrl+Shift+Alt+1..9 的绑定顺序</span>
            </div>
            {renderColorList("fillColors", "填色", "工具栏「填色」下拉里的常用色")}
            {renderColorList("highlightColors", "高亮（文字色）", "工具栏「文字颜色」下拉里的常用色")}

            {/* ------------------------------------------ Enter 行为 */}
            <div className="view-row">
              <span className="view-label">Enter 行为</span>
              <select
                value={prefs.enterDirection}
                onChange={(e) => props.onUpdate({ enterDirection: e.target.value as EnterDirection })}
              >
                {ENTER_DIRECTIONS.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
              <span className="muted">Shift+Enter 会向反方向跳转；方向键/Tab 不受影响</span>
            </div>

            {/* ---------------------------------------------- 钉钉机器人（REQ-115） */}
            <div className="view-row">
              <span className="view-label">钉钉机器人</span>
              {dingtalk === null ? (
                <span className="muted">状态加载中…</span>
              ) : (
                <>
                  <span className="tag">{dingtalk.configured ? "已配置" : "未配置"}</span>
                  <span className="tag">{dingtalk.enabled ? "已启用" : "未启用"}</span>
                  <span className="tag">{dingtalk.has_secret ? "已加签" : "未加签"}</span>
                  <span className="muted">已映射手机号 {dingtalk.mobile_map_size} 个</span>
                </>
              )}
            </div>
            <div className="muted">
              配置来自服务端环境变量 OE_DINGTALK_ENABLED / OE_DINGTALK_WEBHOOK / OE_DINGTALK_SECRET /
              OE_DINGTALK_MOBILES；评论里的「@提及」会在评论落库后推送到群机器人（推送失败不影响评论）。
            </div>
            <div className="view-row">
              <button
                disabled={!canTestDingTalk || testing}
                onClick={async () => {
                  setTesting(true);
                  try {
                    await props.onTestDingTalk();
                  } finally {
                    setTesting(false);
                  }
                }}
              >
                {testing ? "发送中…" : "发送测试消息"}
              </button>
              {!canTestDingTalk && <span className="muted">只有表格所有者可以发送测试消息</span>}
            </div>

            {/* ------------------------------------------------ 底部操作 */}
            {error && <div className="error inline">{error}</div>}
            <div className="view-row">
              <button
                className="primary"
                disabled={saving || loading}
                onClick={async () => {
                  await props.onSave();
                }}
              >
                {saving ? "保存中…" : "保存设置"}
              </button>
              <button className="ghost" onClick={props.onClose}>
                关闭
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
