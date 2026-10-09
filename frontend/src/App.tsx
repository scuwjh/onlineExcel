/** 应用外壳：登录 → 表格工作区（协同编辑 + 历史版本 + 成员权限）。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import FormulaBar from "./components/FormulaBar";
import Grid from "./components/Grid";
import { PermissionsPanel, VersionsPanel } from "./components/Panels";
import PresenceBar from "./components/PresenceBar";
import Toolbar from "./components/Toolbar";
import { useSheet } from "./hooks/useSheet";
import { cellKey } from "./lib/gridUtils";
import type { Role, SheetData, SheetSummary } from "./types";

type Panel = "none" | "versions" | "permissions";

export default function App() {
  const [token, setToken] = useState<string | null>(() => api.getToken());
  const [userName, setUserName] = useState<string>(() => api.getStoredUser() ?? "");
  const [sheets, setSheets] = useState<SheetSummary[]>([]);
  const [sheet, setSheet] = useState<SheetData | null>(null);
  const [panel, setPanel] = useState<Panel>("none");
  const [toast, setToast] = useState<string | null>(null);
  const [appError, setAppError] = useState<string | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setSheets(await api.listSheets());
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, []);

  const reloadRef = useRef<() => Promise<void>>(async () => {});
  const onSheetChanged = useCallback(() => {
    void refreshList();
    void reloadRef.current();
  }, [refreshList]);

  const sheetApi = useSheet(sheet, onSheetChanged);

  const reloadSheet = useCallback(async () => {
    if (!sheet?.id) return;
    try {
      setSheet(await api.getSheet(sheet.id));
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, [sheet?.id]);

  useEffect(() => {
    reloadRef.current = reloadSheet;
  }, [reloadSheet]);

  useEffect(() => {
    if (!token) return;
    void (async () => {
      try {
        const list = await api.listSheets();
        setSheets(list);
        if (list.length) {
          setSheet(await api.getSheet(list[0].id));
        }
      } catch (err) {
        const message = (err as Error).message;
        if ((err as api.ApiError).status === 401) setToken(null);
        else setAppError(message);
      }
    })();
  }, [token]);

  const handleLogout = useCallback(() => {
    api.clearSession();
    setToken(null);
    setSheet(null);
    setSheets([]);
    setUserName("");
  }, []);

  const handleLogin = useCallback((nextToken: string, name: string) => {
    setToken(nextToken);
    setUserName(name);
    setAppError(null);
  }, []);

  const openSheet = useCallback(
    async (id: string) => {
      try {
        setSheet(await api.getSheet(id));
        setPanel("none");
      } catch (err) {
        setAppError((err as Error).message);
      }
    },
    [],
  );

  const newSheet = useCallback(async () => {
    try {
      const created = await api.createSheet("未命名表格", 1000, 26);
      setSheet(created);
      await refreshList();
    } catch (err) {
      setAppError((err as Error).message);
    }
  }, [refreshList]);

  const role: Role | null = sheetApi.state.role ?? sheet?.role ?? null;
  const selectedKey = cellKey(sheetApi.state.selected.row, sheetApi.state.selected.col);
  const rawValue = sheetApi.state.editing
    ? sheetApi.state.draft
    : (sheetApi.state.cells[selectedKey] ?? "");
  const selectedFormat = sheetApi.state.formats[selectedKey] ?? {};

  const notify = useMemo(() => (message: string) => setToast(message), []);
  useEffect(() => {
    if (sheetApi.state.error) {
      notify(sheetApi.state.error);
      sheetApi.dismissError();
    }
  }, [sheetApi, notify]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  if (!token) {
    return (
      <>
        <LoginScreen onLogin={handleLogin} initialError={appError} />
        {toast && <div className="toast">{toast}</div>}
      </>
    );
  }

  return (
    <div className="app">
      <Toolbar
        canUndo={sheetApi.canUndo}
        canRedo={sheetApi.canRedo}
        onUndo={sheetApi.undo}
        onRedo={sheetApi.redo}
        onNewSheet={newSheet}
        sheetName={sheetApi.state.sheetName || "未选择表格"}
        role={role}
        format={selectedFormat}
        onToggleStyle={sheetApi.toggleStyle}
        onAlign={(align) => sheetApi.applyFormat({ align })}
        onColor={(kind, color) => sheetApi.applyFormat(kind === "color" ? { color } : { bg: color })}
        onInsertRow={sheetApi.insertRow}
        onDeleteRow={sheetApi.deleteRow}
        onInsertCol={sheetApi.insertCol}
        onDeleteCol={sheetApi.deleteCol}
        onImport={sheetApi.importCsv}
        onExport={sheetApi.exportCsv}
        frozen={sheetApi.state.frozenRows > 0 || sheetApi.state.frozenCols > 0}
        onFreeze={sheetApi.freeze}
        onUnfreeze={sheetApi.unfreeze}
        onShowVersions={() => setPanel(panel === "versions" ? "none" : "versions")}
        onShowPermissions={() => setPanel(panel === "permissions" ? "none" : "permissions")}
        onLogout={handleLogout}
        status={sheetApi.state.status}
        userName={userName}
      />

      <div className="sheet-bar">
        <span className="sheet-bar-label">我的表格：</span>
        {sheets.map((item) => (
          <button
            key={item.id}
            className={`sheet-tab${item.id === sheetApi.state.sheetId ? " active" : ""}`}
            onClick={() => void openSheet(item.id)}
            title={`角色：${item.role ?? "无权限"}`}
          >
            {item.name}
            <span className="muted"> · {item.role ?? "-"}</span>
          </button>
        ))}
        {sheets.length === 0 && <span className="muted">还没有表格，点击「＋ 新建表格」开始</span>}
      </div>

      <FormulaBar
        selected={sheetApi.state.selected}
        rawValue={rawValue}
        readOnly={!sheetApi.editable}
        onStart={() =>
          sheetApi.startEdit(sheetApi.state.selected.row, sheetApi.state.selected.col, rawValue)
        }
        onDraft={sheetApi.setDraft}
        onCommit={() =>
          sheetApi.commitCell(sheetApi.state.selected.row, sheetApi.state.selected.col, sheetApi.state.draft)
        }
        onCancel={sheetApi.cancelEdit}
      />
      <PresenceBar users={sheetApi.state.users} cursors={sheetApi.state.cursors} self={userName} />

      {panel === "versions" && sheetApi.state.sheetId && (
        <VersionsPanel
          sheetId={sheetApi.state.sheetId}
          currentVersion={sheetApi.state.version}
          canEdit={sheetApi.editable}
          onClose={() => setPanel("none")}
          onRestored={() => {
            void reloadSheet();
            void refreshList();
          }}
          onError={notify}
        />
      )}
      {panel === "permissions" && sheetApi.state.sheetId && (
        <PermissionsPanel sheetId={sheetApi.state.sheetId} onClose={() => setPanel("none")} onError={notify} />
      )}

      {sheetApi.state.loading && <div className="loading">加载中…</div>}
      {!sheetApi.state.loading && sheetApi.state.sheetId && (
        <Grid
          cells={sheetApi.state.cells}
          formats={sheetApi.state.formats}
          rows={sheetApi.state.rows}
          cols={sheetApi.state.cols}
          selected={sheetApi.state.selected}
          editing={sheetApi.state.editing}
          draft={sheetApi.state.draft}
          cursors={sheetApi.state.cursors}
          frozenRows={sheetApi.state.frozenRows}
          frozenCols={sheetApi.state.frozenCols}
          self={userName}
          readOnly={!sheetApi.editable}
          onSelect={sheetApi.select}
          onStartEdit={sheetApi.startEdit}
          onDraft={sheetApi.setDraft}
          onCommit={sheetApi.commitCell}
          onCancel={sheetApi.cancelEdit}
          onMove={sheetApi.select}
          onPaste={sheetApi.pasteBlock}
          onUndo={sheetApi.undo}
          onRedo={sheetApi.redo}
        />
      )}
      {!sheetApi.state.loading && !sheetApi.state.sheetId && (
        <div className="loading">请选择或新建一个表格</div>
      )}

      {appError && (
        <div className="error" onClick={() => setAppError(null)}>
          {appError}（点击关闭）
        </div>
      )}
      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}

function LoginScreen({ onLogin, initialError }: { onLogin: (token: string, name: string) => void; initialError: string | null }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await api.login(username.trim(), password);
      onLogin(session.token, session.username);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <h1>在线协同表格</h1>
        <p className="muted">JWT 鉴权 + 表格级 RBAC。首次登录会按用户名自动注册（开发模式）。</p>
        <label>
          用户名
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" />
        </label>
        <label>
          口令
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "登录中…" : "登录"}
        </button>
        <p className="muted login-hint">
          初始管理员由服务端启动时创建（口令见启动日志或 <code>OE_ADMIN_PASSWORD</code>）。
        </p>
      </form>
    </div>
  );
}
