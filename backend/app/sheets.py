"""表格 REST 路由与单元格/格式/行列/版本业务逻辑。"""
import json
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException

from .db import get_conn
from .schemas import CellUpdate, CellsUpdateRequest, ImportRequest, SheetCreate

router = APIRouter(prefix="/api/sheets", tags=["sheets"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _snapshot(conn, sheet_id: str) -> str:
    rows = conn.execute(
        "SELECT row, col, value, format FROM cells WHERE sheet_id = ? ORDER BY row, col",
        (sheet_id,),
    ).fetchall()
    return json.dumps([dict(r) for r in rows], ensure_ascii=False)


def _version_count(conn, sheet_id: str) -> int:
    row = conn.execute(
        "SELECT COUNT(*) AS n FROM versions WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    return int(row["n"])


def _check_sheet(conn, sheet_id: str) -> None:
    exists = conn.execute("SELECT 1 FROM sheets WHERE id = ?", (sheet_id,)).fetchone()
    if not exists:
        raise HTTPException(status_code=404, detail="表格不存在")


def _save_version(conn, sheet_id: str) -> None:
    conn.execute(
        "INSERT INTO versions (sheet_id, snapshot, created_at) VALUES (?, ?, ?)",
        (sheet_id, _snapshot(conn, sheet_id), _now()),
    )


def _get_sheet_row(conn, sheet_id: str):
    return conn.execute(
        "SELECT id, name, rows, cols FROM sheets WHERE id = ?", (sheet_id,)
    ).fetchone()


def _cells_map(conn, sheet_id: str) -> dict:
    rows = conn.execute(
        "SELECT row, col, value FROM cells WHERE sheet_id = ?", (sheet_id,)
    ).fetchall()
    return {f"{r['row']}:{r['col']}": r["value"] for r in rows}


def _formats_map(conn, sheet_id: str) -> dict:
    rows = conn.execute(
        "SELECT row, col, format FROM cells WHERE sheet_id = ? AND format IS NOT NULL",
        (sheet_id,),
    ).fetchall()
    out = {}
    for r in rows:
        if r["format"]:
            try:
                out[f"{r['row']}:{r['col']}"] = json.loads(r["format"])
            except json.JSONDecodeError:
                continue
    return out


def apply_updates(sheet_id: str, updates: list[CellUpdate], user: str) -> dict:
    """落库一组单元格值更新并生成版本快照。"""
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        changed = []
        for u in updates:
            conn.execute(
                """
                INSERT INTO cells (sheet_id, row, col, value)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(sheet_id, row, col)
                DO UPDATE SET value = excluded.value
                """,
                (sheet_id, u.row, u.col, u.value),
            )
            changed.append({"row": u.row, "col": u.col, "value": u.value})
        conn.execute("UPDATE sheets SET updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"version": _version_count(conn, sheet_id), "changed": changed, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def apply_format(sheet_id: str, row: int, col: int, fmt: Optional[dict], user: str) -> dict:
    """更新单个单元格格式（fmt 为 None 表示清除）。"""
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        fmt_json = json.dumps(fmt, ensure_ascii=False) if fmt else None
        conn.execute(
            """
            INSERT INTO cells (sheet_id, row, col, value, format)
            VALUES (?, ?, ?, NULL, ?)
            ON CONFLICT(sheet_id, row, col)
            DO UPDATE SET format = excluded.format
            """,
            (sheet_id, row, col, fmt_json),
        )
        conn.execute("UPDATE sheets SET updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"version": _version_count(conn, sheet_id), "row": row, "col": col, "format": fmt, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _shift_rows(conn, sheet_id: str, at: int, delta: int) -> None:
    """将 row >= at 的行整体移动 delta（插入为正，删除为负）。"""
    rows = conn.execute(
        "SELECT row, col, value, format FROM cells WHERE sheet_id = ? AND row >= ?",
        (sheet_id, at),
    ).fetchall()
    conn.execute("DELETE FROM cells WHERE sheet_id = ? AND row >= ?", (sheet_id, at))
    for r in rows:
        conn.execute(
            "INSERT INTO cells (sheet_id, row, col, value, format) VALUES (?, ?, ?, ?, ?)",
            (sheet_id, r["row"] + delta, r["col"], r["value"], r["format"]),
        )


def _shift_cols(conn, sheet_id: str, at: int, delta: int) -> None:
    rows = conn.execute(
        "SELECT row, col, value, format FROM cells WHERE sheet_id = ? AND col >= ?",
        (sheet_id, at),
    ).fetchall()
    conn.execute("DELETE FROM cells WHERE sheet_id = ? AND col >= ?", (sheet_id, at))
    for r in rows:
        conn.execute(
            "INSERT INTO cells (sheet_id, row, col, value, format) VALUES (?, ?, ?, ?, ?)",
            (sheet_id, r["row"], r["col"] + delta, r["value"], r["format"]),
        )


def insert_row(sheet_id: str, at: int, user: str) -> dict:
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        _shift_rows(conn, sheet_id, at, 1)
        conn.execute("UPDATE sheets SET rows = rows + 1, updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"rows": _get_sheet_row(conn, sheet_id)["rows"], "at": at, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_row(sheet_id: str, at: int, user: str) -> dict:
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        conn.execute("DELETE FROM cells WHERE sheet_id = ? AND row = ?", (sheet_id, at))
        _shift_rows(conn, sheet_id, at + 1, -1)
        conn.execute("UPDATE sheets SET rows = rows - 1, updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"rows": _get_sheet_row(conn, sheet_id)["rows"], "at": at, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def insert_col(sheet_id: str, at: int, user: str) -> dict:
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        _shift_cols(conn, sheet_id, at, 1)
        conn.execute("UPDATE sheets SET cols = cols + 1, updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"cols": _get_sheet_row(conn, sheet_id)["cols"], "at": at, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_col(sheet_id: str, at: int, user: str) -> dict:
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        conn.execute("DELETE FROM cells WHERE sheet_id = ? AND col = ?", (sheet_id, at))
        _shift_cols(conn, sheet_id, at + 1, -1)
        conn.execute("UPDATE sheets SET cols = cols - 1, updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"cols": _get_sheet_row(conn, sheet_id)["cols"], "at": at, "user": user}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def import_sheet(sheet_id: str, rows: int, cols: int, cells: dict, user: str) -> dict:
    """用新内容整体替换表格（用于 CSV 导入），并生成版本快照。"""
    conn = get_conn()
    try:
        _check_sheet(conn, sheet_id)
        conn.execute("BEGIN")
        _save_version(conn, sheet_id)
        conn.execute("DELETE FROM cells WHERE sheet_id = ?", (sheet_id,))
        for key, value in cells.items():
            try:
                r, c = (int(x) for x in key.split(":"))
            except (ValueError, TypeError):
                continue
            conn.execute(
                "INSERT INTO cells (sheet_id, row, col, value) VALUES (?, ?, ?, ?)",
                (sheet_id, r, c, value),
            )
        conn.execute(
            "UPDATE sheets SET rows = ?, cols = ?, updated_at = ? WHERE id = ?",
            (rows, cols, _now(), sheet_id),
        )
        conn.commit()
        return _sheet_data(conn, sheet_id)
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()


def _sheet_data(conn, sheet_id: str) -> dict:
    row = _get_sheet_row(conn, sheet_id)
    return {
        "id": row["id"],
        "name": row["name"],
        "rows": row["rows"],
        "cols": row["cols"],
        "cells": _cells_map(conn, sheet_id),
        "formats": _formats_map(conn, sheet_id),
        "version": _version_count(conn, sheet_id),
    }


@router.get("")
def list_sheets():
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at, rows, cols FROM sheets ORDER BY updated_at DESC"
        ).fetchall()
        return {"ok": True, "data": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.post("")
def create_sheet(body: SheetCreate):
    sheet_id = uuid.uuid4().hex
    now = _now()
    conn = get_conn()
    try:
        conn.execute(
            "INSERT INTO sheets (id, name, created_at, updated_at, rows, cols) VALUES (?, ?, ?, ?, 100, 20)",
            (sheet_id, body.name, now, now),
        )
        conn.commit()
        return {"ok": True, "data": {"id": sheet_id, "name": body.name}}
    finally:
        conn.close()


@router.get("/{sheet_id}")
def get_sheet(sheet_id: str):
    conn = get_conn()
    try:
        row = _get_sheet_row(conn, sheet_id)
        if not row:
            raise HTTPException(status_code=404, detail="表格不存在")
        return {"ok": True, "data": _sheet_data(conn, sheet_id)}
    finally:
        conn.close()


@router.put("/{sheet_id}/cells")
def update_cells(sheet_id: str, body: CellsUpdateRequest):
    result = apply_updates(sheet_id, body.updates, body.user)
    return {"ok": True, "data": result}


@router.post("/{sheet_id}/import")
def import_sheet_endpoint(sheet_id: str, body: ImportRequest):
    return {"ok": True, "data": import_sheet(sheet_id, body.rows, body.cols, body.cells, body.user)}


@router.post("/{sheet_id}/rows")
def insert_row_endpoint(sheet_id: str, at: int, user: str = "anonymous"):
    return {"ok": True, "data": insert_row(sheet_id, at, user)}


@router.delete("/{sheet_id}/rows/{at}")
def delete_row_endpoint(sheet_id: str, at: int, user: str = "anonymous"):
    return {"ok": True, "data": delete_row(sheet_id, at, user)}


@router.post("/{sheet_id}/cols")
def insert_col_endpoint(sheet_id: str, at: int, user: str = "anonymous"):
    return {"ok": True, "data": insert_col(sheet_id, at, user)}


@router.delete("/{sheet_id}/cols/{at}")
def delete_col_endpoint(sheet_id: str, at: int, user: str = "anonymous"):
    return {"ok": True, "data": delete_col(sheet_id, at, user)}


@router.get("/{sheet_id}/versions")
def list_versions(sheet_id: str):
    conn = get_conn()
    try:
        rows = conn.execute(
            "SELECT id, sheet_id, created_at FROM versions WHERE sheet_id = ? ORDER BY id DESC LIMIT 50",
            (sheet_id,),
        ).fetchall()
        return {"ok": True, "data": [dict(r) for r in rows]}
    finally:
        conn.close()


@router.post("/{sheet_id}/versions/{version_id}/restore")
def restore_version(sheet_id: str, version_id: int):
    conn = get_conn()
    try:
        vrow = conn.execute(
            "SELECT snapshot FROM versions WHERE id = ? AND sheet_id = ?",
            (version_id, sheet_id),
        ).fetchone()
        if not vrow:
            raise HTTPException(status_code=404, detail="版本不存在")

        conn.execute("BEGIN")
        conn.execute("DELETE FROM cells WHERE sheet_id = ?", (sheet_id,))
        for cell in json.loads(vrow["snapshot"]):
            conn.execute(
                "INSERT INTO cells (sheet_id, row, col, value, format) VALUES (?, ?, ?, ?, ?)",
                (sheet_id, cell["row"], cell["col"], cell["value"], cell.get("format")),
            )
        conn.execute(
            "INSERT INTO versions (sheet_id, snapshot, created_at) VALUES (?, ?, ?)",
            (sheet_id, vrow["snapshot"], _now()),
        )
        conn.execute("UPDATE sheets SET updated_at = ? WHERE id = ?", (_now(), sheet_id))
        conn.commit()
        return {"ok": True, "data": {"version": _version_count(conn, sheet_id)}}
    except HTTPException:
        conn.rollback()
        raise
    finally:
        conn.close()
