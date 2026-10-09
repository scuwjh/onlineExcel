/**
 * 评论与 @提醒面板（REQ-100）。
 *
 * - 顶部：针对当前选中单元格的评论输入框，``@`` 触发成员下拉（成员取自表格权限列表）；
 * - 列表：默认只看当前单元格，可切换到"整表"视图；支持解决 / 重新打开 / 删除；
 * - @提及会高亮显示，便于确认提醒对象。
 */
import { useCallback, useMemo, useState } from "react";
import type { SheetComment } from "../api";

interface Props {
  comments: SheetComment[];
  members: Array<{ username: string; role: string }>;
  /** 当前选中的单元格（用于过滤与新建评论）。 */
  selected: { row: number; col: number; ref: string; rowId: string; colId: string };
  canComment: boolean;
  self: string;
  onAdd: (rowId: string, colId: string, body: string) => Promise<boolean>;
  onResolve: (commentId: number, resolved: boolean) => Promise<void>;
  onRemove: (commentId: number) => Promise<void>;
  onClose: () => void;
  onJump: (rowId: string, colId: string) => void;
}

const MENTION_RE = /@([A-Za-z0-9_.\-]{1,64}|[^\s@]{1,64})/g;

/** 把正文拆成文本与 @提及 片段，用于高亮渲染。 */
function renderBody(body: string, members: Set<string>) {
  const parts: Array<{ text: string; mention: boolean }> = [];
  let last = 0;
  for (const match of body.matchAll(MENTION_RE)) {
    const name = match[1];
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: body.slice(last, index), mention: false });
    const isMember = members.has(name);
    parts.push({ text: match[0], mention: isMember });
    last = index + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

export default function CommentsPanel(props: Props) {
  const { comments, members, selected, canComment, self } = props;
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<"cell" | "sheet">("cell");
  const [showResolved, setShowResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  const memberNames = useMemo(() => new Set(members.map((m) => m.username)), [members]);
  const suggestions = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return members.filter((m) => m.username.toLowerCase().includes(q)).slice(0, 6);
  }, [mentionQuery, members]);

  const visible = useMemo(() => {
    const base =
      scope === "cell"
        ? comments.filter((c) => c.row_id === selected.rowId && c.col_id === selected.colId)
        : comments;
    return showResolved ? base : base.filter((c) => !c.resolved);
  }, [comments, scope, selected.colId, selected.rowId, showResolved]);

  const cellCommentCount = useMemo(
    () => comments.filter((c) => c.row_id === selected.rowId && c.col_id === selected.colId && !c.resolved).length,
    [comments, selected.colId, selected.rowId],
  );

  const onDraftChange = useCallback((text: string) => {
    setDraft(text);
    // 取光标前的最后一段：@ 后跟非空白字符即视为正在输入提及
    const match = text.match(/@([^\s@]*)$/);
    setMentionQuery(match ? match[1] : null);
  }, []);

  const pickMention = useCallback((username: string) => {
    setDraft((prev) => `${prev.replace(/@([^\s@]*)$/, `@${username}`)} `);
    setMentionQuery(null);
  }, []);

  const submit = useCallback(async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    const ok = await props.onAdd(selected.rowId, selected.colId, body);
    setBusy(false);
    if (ok) setDraft("");
    else setError("评论发送失败");
  }, [draft, props, selected.colId, selected.rowId]);

  return (
    <div className="panel comments-panel">
      <div className="panel-head">
        <strong>评论与 @提醒</strong>
        <span className="muted">
          {selected.ref} · 本单元格 {cellCommentCount} 条未解决
        </span>
        <span className="spacer-flex" />
        <button className={scope === "cell" ? "active" : ""} onClick={() => setScope("cell")}>
          当前单元格
        </button>
        <button className={scope === "sheet" ? "active" : ""} onClick={() => setScope("sheet")}>
          整表（{comments.filter((c) => !c.resolved).length}）
        </button>
        <label className="inline-check">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          显示已解决
        </label>
        <button onClick={props.onClose}>关闭</button>
      </div>

      <div className="panel-body comments-body">
        <div className="comment-editor">
          <textarea
            value={draft}
            placeholder={canComment ? `针对 ${selected.ref} 评论，输入 @ 可提醒成员` : "当前角色只能查看评论"}
            disabled={!canComment || busy}
            rows={3}
            onChange={(e) => onDraftChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          {suggestions.length > 0 && (
            <div className="mention-hints">
              {suggestions.map((m) => (
                <button key={m.username} onClick={() => pickMention(m.username)}>
                  @{m.username}
                  <span className="muted"> · {m.role}</span>
                </button>
              ))}
            </div>
          )}
          <div className="comment-actions">
            <span className="muted">Ctrl/⌘ + Enter 发送</span>
            <span className="spacer-flex" />
            <button onClick={() => setDraft("")} disabled={!draft || busy}>
              清空
            </button>
            <button onClick={() => void submit()} disabled={!canComment || !draft.trim() || busy}>
              {busy ? "发送中…" : "发表评论"}
            </button>
          </div>
          {error && <div className="error inline">{error}</div>}
        </div>

        <div className="comment-list">
          {visible.length === 0 && (
            <div className="muted">
              {scope === "cell" ? "当前单元格还没有评论" : "整表还没有评论"}
              {!showResolved && comments.length > visible.length ? "（勾选「显示已解决」查看历史）" : ""}
            </div>
          )}
          {visible.map((comment) => (
            <div key={comment.id} className={`comment-item${comment.resolved ? " resolved" : ""}`}>
              <div className="comment-line">
                <span className="comment-author">{comment.author === self ? "我" : comment.author}</span>
                <span className="muted">{new Date(comment.created_at).toLocaleString()}</span>
                {comment.resolved && <span className="tag">已解决</span>}
                <span className="spacer-flex" />
                <button
                  onClick={() => props.onJump(comment.row_id, comment.col_id)}
                  title="定位到该单元格"
                >
                  定位
                </button>
                <button onClick={() => void props.onResolve(comment.id, !comment.resolved)}>
                  {comment.resolved ? "重新打开" : "解决"}
                </button>
                {canComment && (
                  <button onClick={() => void props.onRemove(comment.id)} title="删除评论">
                    删除
                  </button>
                )}
              </div>
              <div className="comment-text">
                {renderBody(comment.body, memberNames).map((part, index) =>
                  part.mention ? (
                    <mark key={index} className="mention">
                      {part.text}
                    </mark>
                  ) : (
                    <span key={index}>{part.text}</span>
                  ),
                )}
              </div>
              {comment.mentions.length > 0 && (
                <div className="comment-mentions muted">提醒了：{comment.mentions.join("、")}</div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
