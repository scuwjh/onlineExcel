/** 历史版本（对比 / 恢复 / 回退 / 压缩点）与成员权限管理面板。 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import type { PermissionEntry, Role, VersionDiff, VersionEntry } from "../types";

interface VersionsPanelProps {
  sheetId: string;
  currentVersion: number;
  canEdit: boolean;
  onClose: () => void;
  onRestored: () => void;
  onError: (message: string) => void;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function VersionsPanel({ sheetId, currentVersion, canEdit, onClose, onRestored, onError }: VersionsPanelProps) {
  const [versions, setVersions] = useState<VersionEntry[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setVersions(await api.listVersions(sheetId, 50));
    } catch (err) {
      onError(String((err as Error).message ?? err));
    }
  }, [sheetId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const compare = useCallback(
    async (versionId: number) => {
      try {
        setBusy(true);
        setDiff(await api.diffVersion(sheetId, versionId));
      } catch (err) {
        onError(String((err as Error).message ?? err));
      } finally {
        setBusy(false);
      }
    },
    [onError, sheetId],
  );

  const restore = useCallback(
    async (versionId: number) => {
      try {
        setBusy(true);
        await api.restoreVersion(sheetId, versionId);
        setDiff(null);
        await load();
        onRestored();
      } catch (err) {
        onError(String((err as Error).message ?? err));
      } finally {
        setBusy(false);
      }
    },
    [load, onError, onRestored, sheetId],
  );

  const snapshot = useCallback(async () => {
    try {
      setBusy(true);
      await api.makeSnapshot(sheetId);
      await load();
    } catch (err) {
      onError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [load, onError, sheetId]);

  const totalDelta =
    (diff?.summary.added ?? 0) + (diff?.summary.removed ?? 0) + (diff?.summary.changed ?? 0) + (diff?.summary.formats ?? 0);

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>历史版本</strong>
        <span className="muted">
          增量存储：每个版本只保存 diff，压缩点保存快照（当前 v{currentVersion}）
        </span>
        <span className="spacer-flex" />
        <button onClick={snapshot} disabled={busy}>
          建立压缩点
        </button>
        <button onClick={onClose}>关闭</button>
      </div>

      <div className="panel-body">
        <div className="panel-list">
          {versions.length === 0 && <div className="muted">暂无版本记录</div>}
          {versions.map((version) => (
            <div key={version.id} className={`version-item${version.is_snapshot ? " snapshot" : ""}`}>
              <div className="version-line">
                <span className="version-id">v{version.id}</span>
                <span className="version-user">{version.user}</span>
                <span className="muted">{formatTime(version.created_at)}</span>
              </div>
              <div className="version-meta muted">
                {version.is_snapshot ? "快照点 · " : ""}
                {version.ops_count} 个操作 · 增量 {version.ops_bytes}B
                {version.is_snapshot ? ` · 快照 ${version.snapshot_bytes}B` : ""}
                {version.id === currentVersion ? " · 当前" : ""}
              </div>
              <div className="version-actions">
                <button onClick={() => compare(version.id)} disabled={busy}>
                  与当前对比
                </button>
                <button onClick={() => restore(version.id)} disabled={busy || !canEdit} title={canEdit ? "恢复到此版本" : "需要编辑权限"}>
                  恢复
                </button>
              </div>
            </div>
          ))}
        </div>

        <div className="panel-diff">
          {!diff && <div className="muted">选择左侧任意版本，点击「与当前对比」查看单元格级差异。</div>}
          {diff && (
            <>
              <div className="diff-head">
                <strong>
                  v{diff.from.version} → v{diff.to.version}
                </strong>
                <span className="muted">
                  新增 {diff.summary.added} · 删除 {diff.summary.removed} · 修改 {diff.summary.changed} · 格式{" "}
                  {diff.summary.formats}（结构 {diff.structure.rows >= 0 ? "+" : ""}
                  {diff.structure.rows} 行 / {diff.structure.cols >= 0 ? "+" : ""}
                  {diff.structure.cols} 列）
                </span>
                {totalDelta === 0 && <span className="muted">与当前版本内容一致</span>}
              </div>
              <DiffBucket title="新增" bucket={diff.cells.added} />
              <DiffBucket title="修改" bucket={diff.cells.changed} />
              <DiffBucket title="删除" bucket={diff.cells.removed} />
              <DiffBucket title="格式变更" bucket={diff.formats.changed} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffBucket({ title, bucket }: { title: string; bucket: { items: Array<Record<string, unknown>>; truncated: boolean; total: number } }) {
  if (!bucket.total) return null;
  return (
    <div className="diff-bucket">
      <div className="diff-title">
        {title}（{bucket.total}）
        {bucket.truncated ? " · 仅显示前若干项" : ""}
      </div>
      <ul>
        {bucket.items.slice(0, 200).map((item, index) => (
          <li key={index}>
            <code>{String(item.cell)}</code>
            {"from" in item ? (
              <>
                {" "}
                <span className="diff-old">{JSON.stringify(item.from)}</span> →{" "}
                <span className="diff-new">{JSON.stringify(item.to)}</span>
              </>
            ) : (
              <> <span className="diff-new">{JSON.stringify(item.value ?? item.format)}</span></>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface PermissionsPanelProps {
  sheetId: string;
  onClose: () => void;
  onError: (message: string) => void;
}

const ROLES: Role[] = ["owner", "editor", "commenter", "viewer"];

export function PermissionsPanel({ sheetId, onClose, onError }: PermissionsPanelProps) {
  const [entries, setEntries] = useState<PermissionEntry[]>([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setEntries(await api.listPermissions(sheetId));
    } catch (err) {
      onError(String((err as Error).message ?? err));
    }
  }, [sheetId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const grant = useCallback(async () => {
    if (!username.trim()) return;
    try {
      setBusy(true);
      setEntries(await api.setPermission(sheetId, username.trim(), role));
      setUsername("");
    } catch (err) {
      onError(String((err as Error).message ?? err));
    } finally {
      setBusy(false);
    }
  }, [onError, role, sheetId, username]);

  const revoke = useCallback(
    async (name: string) => {
      try {
        setBusy(true);
        setEntries(await api.removePermission(sheetId, name));
      } catch (err) {
        onError(String((err as Error).message ?? err));
      } finally {
        setBusy(false);
      }
    },
    [onError, sheetId],
  );

  const changeRole = useCallback(
    async (name: string, next: Role) => {
      try {
        setBusy(true);
        setEntries(await api.setPermission(sheetId, name, next));
      } catch (err) {
        onError(String((err as Error).message ?? err));
      } finally {
        setBusy(false);
      }
    },
    [onError, sheetId],
  );

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>成员权限</strong>
        <span className="muted">owner 可管理，editor 可编辑，commenter 只读+评论，viewer 只读</span>
        <span className="spacer-flex" />
        <button onClick={onClose}>关闭</button>
      </div>
      <div className="panel-body column">
        <div className="perm-add">
          <input placeholder="用户名" value={username} onChange={(e) => setUsername(e.target.value)} />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
          <button onClick={grant} disabled={busy || !username.trim()}>
            授权 / 更新
          </button>
        </div>
        <table className="perm-table">
          <thead>
            <tr>
              <th>用户</th>
              <th>角色</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.user_id}>
                <td>{entry.username ?? `#${entry.user_id}`}</td>
                <td>
                  <select
                    value={entry.role}
                    disabled={busy}
                    onChange={(e) => changeRole(entry.username ?? "", e.target.value as Role)}
                  >
                    {ROLES.map((item) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button onClick={() => revoke(entry.username ?? "")} disabled={busy || entry.role === "owner"}>
                    移除
                  </button>
                </td>
              </tr>
            ))}
            {entries.length === 0 && (
              <tr>
                <td colSpan={3} className="muted">
                  暂无成员记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
