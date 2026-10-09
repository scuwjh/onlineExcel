/** REST 客户端：统一携带 Bearer 令牌，并把接口错误转成可展示的中文信息。 */
import type {
  Access,
  CellFormat,
  Cells,
  PermissionEntry,
  Role,
  SheetData,
  SheetSummary,
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

export type { Cells };
