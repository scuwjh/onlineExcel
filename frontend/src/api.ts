import type { Cells, SheetData } from "./types";

const BASE = "/api";

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const body = await res.json();
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || body.detail || `请求失败 ${res.status}`);
  }
  return body.data as T;
}

export async function listSheets(): Promise<Array<{ id: string; name: string }>> {
  return request("/sheets");
}

export async function createSheet(name: string): Promise<{ id: string; name: string }> {
  return request("/sheets", { method: "POST", body: JSON.stringify({ name }) });
}

export async function getSheet(id: string): Promise<SheetData> {
  return request(`/sheets/${id}`);
}

export async function updateCells(
  id: string,
  updates: Array<{ row: number; col: number; value: string | null }>,
  user: string,
): Promise<{ version: number }> {
  return request(`/sheets/${id}/cells`, {
    method: "PUT",
    body: JSON.stringify({ updates, user }),
  });
}

export async function listVersions(id: string): Promise<Array<{ id: number; created_at: string }>> {
  return request(`/sheets/${id}/versions`);
}

export async function restoreVersion(id: string, versionId: number): Promise<{ version: number }> {
  return request(`/sheets/${id}/versions/${versionId}/restore`, { method: "POST" });
}

export async function importSheet(
  id: string,
  rows: number,
  cols: number,
  cells: Cells,
  user: string,
): Promise<SheetData> {
  return request(`/sheets/${id}/import`, {
    method: "POST",
    body: JSON.stringify({ rows, cols, cells, user }),
  });
}

export type { Cells };
