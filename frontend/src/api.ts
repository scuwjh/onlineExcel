/** REST 客户端：统一携带 Bearer 令牌，并把接口错误转成可展示的中文信息。 */
import type {
  Access,
  CellFormat,
  Cells,
  PermissionEntry,
  Role,
  SheetData,
  SheetSummary,
  UserPreferences,
  VersionDiff,
  VersionEntry,
} from "./types";

const BASE = "/api";
const TOKEN_KEY = "oe-token";
const USER_KEY = "oe-user";

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): string | null {
  return window.localStorage.getItem(USER_KEY);
}

export function saveSession(token: string, username: string): void {
  window.localStorage.setItem(TOKEN_KEY, token);
  window.localStorage.setItem(USER_KEY, username);
}

export function clearSession(): void {
  window.localStorage.removeItem(TOKEN_KEY);
}

export interface ApiError extends Error {
  status: number;
  code?: string;
}

function makeError(message: string, status: number, code?: string): ApiError {
  const error = new Error(message) as ApiError;
  error.status = status;
  error.code = code;
  return error;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...options, headers: { ...headers, ...(options?.headers as object) } });
  let body: { ok?: boolean; data?: unknown; error?: string; detail?: unknown; code?: string } | null = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status === 401) {
    clearSession();
    throw makeError(body?.error || "登录已过期，请重新登录", 401, "unauthorized");
  }
  if (!res.ok || body?.ok === false) {
    const detail = typeof body?.detail === "string" ? body.detail : undefined;
    throw makeError(body?.error || detail || `请求失败 ${res.status}`, res.status, body?.code);
  }
  return (body?.data ?? null) as T;
}

export async function login(username: string, password: string): Promise<{ token: string; username: string }> {
  const data = await request<{ token: string; username: string }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
  saveSession(data.token, data.username);
  return data;
}

export async function fetchMe(): Promise<{ id: number; username: string; roles: Record<string, Role | null> }> {
  return request("/auth/me");
}

export async function listSheets(): Promise<SheetSummary[]> {
  return request("/sheets");
}

export async function createSheet(name: string, rows = 100, cols = 20): Promise<SheetData> {
  const created = await request<{ id: string }>("/sheets", {
    method: "POST",
    body: JSON.stringify({ name, rows, cols }),
  });
  return getSheet(created.id);
}

export async function renameSheet(id: string, name: string): Promise<void> {
  await request(`/sheets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) });
}

export async function getSheet(id: string): Promise<SheetData> {
  return request(`/sheets/${id}`);
}

export async function getAccess(id: string): Promise<Access> {
  return request(`/sheets/${id}/access`);
}

export interface CellTarget {
  row?: number;
  col?: number;
  row_id?: string;
  col_id?: string;
  value?: string | null;
  format?: CellFormat | null;
}

export async function updateCells(
  id: string,
  updates: CellTarget[],
  version: Record<string, number> = {},
): Promise<SheetData> {
  return request(`/sheets/${id}/cells`, {
    method: "PUT",
    body: JSON.stringify({ updates, version }),
  });
}

export async function updateFormats(
  id: string,
  updates: CellTarget[],
  version: Record<string, number> = {},
): Promise<SheetData> {
  return request(`/sheets/${id}/formats`, {
    method: "PUT",
    body: JSON.stringify({ updates, version }),
  });
}

export async function insertRow(id: string, at: number, counter: number): Promise<SheetData> {
  return request(`/sheets/${id}/rows`, { method: "POST", body: JSON.stringify({ at, counter }) });
}

export async function deleteRow(id: string, at: number): Promise<SheetData> {
  return request(`/sheets/${id}/rows/${at}`, { method: "DELETE" });
}

export async function insertCol(id: string, at: number, counter: number): Promise<SheetData> {
  return request(`/sheets/${id}/cols`, { method: "POST", body: JSON.stringify({ at, counter }) });
}

export async function deleteCol(id: string, at: number): Promise<SheetData> {
  return request(`/sheets/${id}/cols/${at}`, { method: "DELETE" });
}

export async function importSheet(
  id: string,
  rows: number,
  cols: number,
  cells: Cells,
  version: Record<string, number> = {},
): Promise<SheetData> {
  return request(`/sheets/${id}/import`, {
    method: "POST",
    body: JSON.stringify({ rows, cols, cells, version }),
  });
}

export async function listVersions(id: string, limit = 50): Promise<VersionEntry[]> {
  return request(`/sheets/${id}/versions?limit=${limit}`);
}

export async function getVersion(id: string, versionId: number): Promise<{ version: number; cells: Cells }> {
  return request(`/sheets/${id}/versions/${versionId}`);
}

export async function diffVersion(id: string, versionId: number, base?: number): Promise<VersionDiff> {
  const query = base ? `?base=${base}` : "";
  return request(`/sheets/${id}/versions/${versionId}/diff${query}`);
}

export async function restoreVersion(id: string, versionId: number): Promise<SheetData> {
  return request(`/sheets/${id}/versions/${versionId}/restore`, { method: "POST" });
}

export async function rollback(id: string, steps = 1): Promise<SheetData> {
  return request(`/sheets/${id}/rollback?steps=${steps}`, { method: "POST" });
}

export async function makeSnapshot(id: string): Promise<{ version: number }> {
  return request(`/sheets/${id}/snapshot`, { method: "POST" });
}

export async function listPermissions(id: string): Promise<PermissionEntry[]> {
  return request(`/sheets/${id}/permissions`);
}

export async function setPermission(id: string, username: string, role: Role): Promise<PermissionEntry[]> {
  return request(`/sheets/${id}/permissions`, {
    method: "PUT",
    body: JSON.stringify({ username, role }),
  });
}

export async function removePermission(id: string, username: string): Promise<PermissionEntry[]> {
  return request(`/sheets/${id}/permissions/${encodeURIComponent(username)}`, { method: "DELETE" });
}

/** 删除整张表格（仅所有者）。 */
export async function deleteSheet(id: string): Promise<{ id: string; deleted: boolean }> {
  return request(`/sheets/${id}`, { method: "DELETE" });
}

// ------------------------------------------------------------------------- Excel

export interface XlsxParseResult {
  sheet_name: string;
  sheet_names: string[];
  rows: number;
  cols: number;
  cell_count: number;
  format_count: number;
  skipped_long_cells: number;
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return window.btoa(binary);
}

/** 读取 xlsx 并列出其中的工作表（不落库），用于导入前的选择。 */
export async function parseXlsx(id: string, file: File, sheetName?: string): Promise<XlsxParseResult> {
  const data = toBase64(await file.arrayBuffer());
  return request(`/sheets/${id}/xlsx/parse`, {
    method: "POST",
    body: JSON.stringify({ data, sheet_name: sheetName ?? null }),
  });
}

/** 把 xlsx 的一个工作表导入为当前表格内容（整体替换）。 */
export async function importXlsx(
  id: string,
  file: File,
  sheetName?: string,
): Promise<SheetData & { sheet_name: string; skipped_long_cells: number }> {
  const data = toBase64(await file.arrayBuffer());
  return request(`/sheets/${id}/xlsx/import`, {
    method: "POST",
    body: JSON.stringify({ data, sheet_name: sheetName ?? null }),
  });
}

/** 导出为 .xlsx 并触发浏览器下载（保留公式与样式）。 */
export async function exportXlsx(
  id: string,
  filename: string,
  options: { frozen_rows?: number; frozen_cols?: number } = {},
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}/sheets/${id}/xlsx/export`, {
    method: "POST",
    headers,
    body: JSON.stringify(options),
  });
  if (!res.ok) {
    let message = `导出失败 ${res.status}`;
    try {
      const body = await res.json();
      message = body?.error || message;
    } catch {
      /* 保持默认信息 */
    }
    throw makeError(message, res.status);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename.toLowerCase().endsWith(".xlsx") ? filename : `${filename}.xlsx`;
  anchor.click();
  URL.revokeObjectURL(url);
}

// -------------------------------------------------------------------------- 评论

export interface SheetComment {
  id: number;
  sheet_id: string;
  row_id: string;
  col_id: string;
  author_id: number | null;
  author: string;
  body: string;
  mentions: string[];
  resolved: boolean;
  created_at: string;
}

export interface CommentsPayload {
  comments: SheetComment[];
  counts: Record<string, number>;
  members: Array<{ username: string; role: Role }>;
}

export async function listComments(id: string, includeResolved = true): Promise<CommentsPayload> {
  return request(`/sheets/${id}/comments?include_resolved=${includeResolved ? "true" : "false"}`);
}

export async function createComment(
  id: string,
  rowId: string,
  colId: string,
  body: string,
): Promise<{ comment: SheetComment; counts: Record<string, number>; mentions: string[] }> {
  return request(`/sheets/${id}/comments`, {
    method: "POST",
    body: JSON.stringify({ row_id: rowId, col_id: colId, body }),
  });
}

export async function resolveComment(
  id: string,
  commentId: number,
  resolved = true,
): Promise<{ comment: SheetComment; counts: Record<string, number> }> {
  return request(`/sheets/${id}/comments/${commentId}/resolve`, {
    method: "POST",
    body: JSON.stringify({ resolved }),
  });
}

export async function deleteComment(
  id: string,
  commentId: number,
): Promise<{ deleted: number; counts: Record<string, number> }> {
  return request(`/sheets/${id}/comments/${commentId}`, { method: "DELETE" });
}

// --------------------------------------------------------------- 个性化偏好（REQ-110/112）

export async function getPreferences(): Promise<Partial<UserPreferences>> {
  return request("/preferences");
}

export async function savePreferences(prefs: UserPreferences): Promise<UserPreferences> {
  return request("/preferences", { method: "PUT", body: JSON.stringify(prefs) });
}

// ------------------------------------------------------------------ 钉钉集成（REQ-115）

export interface DingTalkStatus {
  enabled: boolean;
  configured: boolean;
  has_secret: boolean;
  mobile_map_size: number;
}

export async function getDingTalkStatus(): Promise<DingTalkStatus> {
  return request("/integrations/dingtalk");
}

export async function testDingTalk(): Promise<{ ok: boolean; errmsg?: string }> {
  return request("/integrations/dingtalk/test", { method: "POST" });
}

export type { Cells };
