"""REST 路由：鉴权、表格 CRUD、单元格/格式/行列操作、版本（列表/diff/恢复/回退）、
权限管理、Excel 导入导出、评论与 @提醒。

所有写操作都经过统一的 :func:`_apply` 入口 → ``store.apply_ops``，因此
REST 与 WebSocket 产生完全相同的操作日志与版本语义。
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
from typing import Optional
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from . import auth, config, crdt, store, xlsx
from .db import get_conn, write_lock
from .schemas import (
    CellsUpdateRequest,
    CommentCreate,
    CommentResolve,
    ImportRequest,
    LoginRequest,
    OperationRequest,
    PermissionRequest,
    RowColRequest,
    SheetCreate,
    SheetRename,
    XlsxExportRequest,
    XlsxImportRequest,
)

router = APIRouter(prefix="/api")


# --------------------------------------------------------------------------- 依赖


def current_user(request: Request) -> dict:
    """从 ``Authorization: Bearer`` 解析当前用户。"""
    token = auth.bearer_token(request.headers.get("Authorization"))
    if not token:
        raise auth.AuthError("缺少 Bearer 令牌")
    payload = auth.decode_token(token)
    conn = get_conn()
    try:
        user = store.get_user(conn, int(payload["sub"]))
    except (KeyError, ValueError, TypeError) as exc:
        raise auth.AuthError("令牌内容非法") from exc
    if not user:
        raise auth.AuthError("用户不存在")
    return {"id": int(user["id"]), "username": user["username"]}


def sheet_access(sheet_id: str, user: dict, needed: str = "viewer") -> str:
    """校验表格权限并返回当前角色。"""
    conn = get_conn()
    if not store.sheet_exists(conn, sheet_id):
        raise HTTPException(status_code=404, detail="表格不存在")
    role = store.get_role(conn, sheet_id, user["id"])
    return auth.require_role(role, needed, sheet_id=sheet_id)


def user_resolver() -> dict:
    """供 WebSocket 使用的用户查询闭包。"""
    conn = get_conn()
    return {"users": {u["username"]: u["id"] for u in store.list_users(conn)}}


# --------------------------------------------------------------------------- 鉴权


@router.post("/auth/login")
def login(body: LoginRequest):
    conn = get_conn()
    with write_lock:
        user = store.get_user_by_name(conn, body.username)
        if not user:
            if not config.is_dev_auto_register():
                raise auth.AuthError("用户名或口令错误", status_code=401)
            # 开发便利：首次登录即注册为 viewer，需管理员另行授权到 editor/owner。
            from .bootstrap import seed_user

            seed_user(conn, body.username, body.password, role=None)
            conn.commit()
            user = store.get_user_by_name(conn, body.username)
        if not user or not auth.verify_password(body.password, user["password_hash"]):
            raise auth.AuthError("用户名或口令错误", status_code=401)
    token, ttl = auth.issue_token(int(user["id"]), user["username"])
    return {
        "ok": True,
        "data": {"token": token, "token_type": "Bearer", "expires_in": ttl, "username": user["username"]},
    }


@router.get("/auth/me")
def me(user: dict = Depends(current_user)):
    conn = get_conn()
    roles = {}
    for sheet in store.list_sheets(conn, user["id"]):
        roles[sheet["id"]] = sheet.get("role")
    return {"ok": True, "data": {"id": user["id"], "username": user["username"], "roles": roles}}


# --------------------------------------------------------------------------- 表格


@router.get("/sheets")
def list_sheets(user: dict = Depends(current_user)):
    conn = get_conn()
    items = []
    for sheet in store.list_sheets(conn, user["id"]):
        if auth.role_level(sheet.get("role")) >= config.ROLE_LEVEL["viewer"]:
            items.append(sheet)
    return {"ok": True, "data": items}


@router.post("/sheets")
def create_sheet(body: SheetCreate, user: dict = Depends(current_user)):
    conn = get_conn()
    with write_lock:
        sheet_id = store.create_sheet(conn, body.name, user["id"], rows=body.rows, cols=body.cols)
        conn.commit()
    return {"ok": True, "data": {"id": sheet_id, "name": body.name, "role": "owner"}}


@router.get("/sheets/{sheet_id}")
def get_sheet(sheet_id: str, user: dict = Depends(current_user)):
    role = sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    return {"ok": True, "data": store.sheet_payload(conn, sheet_id, role)}


@router.patch("/sheets/{sheet_id}")
def rename_sheet(sheet_id: str, body: SheetRename, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "owner")
    conn = get_conn()
    with write_lock:
        store.rename_sheet(conn, sheet_id, body.name)
        conn.commit()
    return {"ok": True, "data": {"id": sheet_id, "name": body.name}}


@router.delete("/sheets/{sheet_id}")
def delete_sheet(sheet_id: str, user: dict = Depends(current_user)):
    """删除表格（仅所有者）：连带清理权限、单元格、结构、版本、操作日志与评论。"""
    sheet_access(sheet_id, user, "owner")
    conn = get_conn()
    with write_lock:
        removed = store.delete_sheet(conn, sheet_id)
        conn.commit()
    if not removed:
        raise HTTPException(status_code=404, detail="表格不存在")
    return {"ok": True, "data": {"id": sheet_id, "deleted": True}}


@router.get("/sheets/{sheet_id}/access")
def my_access(sheet_id: str, user: dict = Depends(current_user)):
    role = sheet_access(sheet_id, user, "viewer")
    return {"ok": True, "data": auth.explain(sheet_id, role)}


# ----------------------------------------------------------- 单元格与结构（写操作）


def _apply(sheet_id: str, ops: list, user: dict, role_needed: str = "editor") -> dict:
    """权限校验 + 应用操作。``ops`` 为空时只做校验（用于让 403 先于 400）。"""
    role = sheet_access(sheet_id, user, role_needed)
    if not ops:
        return {"role": role, "checked": True}
    try:
        result = store.apply_ops(sheet_id, ops, user["username"], client_id=f"rest:{user['username']}")
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["role"] = role
    return result


def _cell_payload(item, conn, sheet_id: str) -> dict:
    """把 ``row``/``col`` 索引解析为稳定元素 ID（并发插删行列时索引会漂移）。"""
    state = crdt.load_state(conn, sheet_id)
    if hasattr(item, "model_dump"):
        payload = item.model_dump(exclude_none=True)
    elif isinstance(item, dict):
        payload = {k: v for k, v in item.items() if v is not None}
    else:
        raise HTTPException(status_code=400, detail="updates 元素必须是对象")
    if payload.get("row_id") is None:
        raw_row = payload.get("row")
        if raw_row is None:
            raise HTTPException(status_code=400, detail="缺少 row 或 row_id")
        row = int(raw_row)
        if not (0 <= row < len(state.row_ids)):
            raise HTTPException(status_code=400, detail=f"行索引越界: {row}")
        payload["row_id"] = state.row_ids[row]
    elif payload["row_id"] not in state.row_ids:
        raise HTTPException(status_code=400, detail=f"行不存在: {payload['row_id']}")
    else:
        payload["row"] = state.row_ids.index(payload["row_id"])
    if payload.get("col_id") is None:
        raw_col = payload.get("col")
        if raw_col is None:
            raise HTTPException(status_code=400, detail="缺少 col 或 col_id")
        col = int(raw_col)
        if not (0 <= col < len(state.col_ids)):
            raise HTTPException(status_code=400, detail=f"列索引越界: {col}")
        payload["col_id"] = state.col_ids[col]
    elif payload["col_id"] not in state.col_ids:
        raise HTTPException(status_code=400, detail=f"列不存在: {payload['col_id']}")
    else:
        payload["col"] = state.col_ids.index(payload["col_id"])
    # 保留序号：结构被整体替换（导入/恢复）后，历史重放可据此迁移元素 ID
    return payload


@router.put("/sheets/{sheet_id}/cells")
def update_cells(sheet_id: str, body: CellsUpdateRequest, user: dict = Depends(current_user)):
    _apply(sheet_id, [], user)  # 权限与存在性校验优先于载荷校验（403 先于 400）
    conn = get_conn()
    ops = []
    try:
        for item in body.updates:
            payload = _cell_payload(item, conn, sheet_id)
            value = item.value
            if value is not None and len(value) > config.MAX_CELL_CHARS:
                raise HTTPException(status_code=400, detail="单元格内容超长")
            payload["value"] = value
            ops.append({"kind": crdt.OP_SET_CELL, "payload": payload, "version": body.version or {}})
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result = _apply(sheet_id, ops, user)
    return {"ok": True, "data": result}


@router.put("/sheets/{sheet_id}/formats")
def update_formats(sheet_id: str, body: CellsUpdateRequest, user: dict = Depends(current_user)):
    _apply(sheet_id, [], user)
    conn = get_conn()
    ops = []
    try:
        for item in body.updates:
            payload = _cell_payload(item, conn, sheet_id)
            payload["format"] = item.format
            ops.append({"kind": crdt.OP_SET_FORMAT, "payload": payload, "version": body.version or {}})
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": _apply(sheet_id, ops, user)}


@router.post("/sheets/{sheet_id}/ops")
def apply_operation(sheet_id: str, body: OperationRequest, user: dict = Depends(current_user)):
    """通用操作入口（幂等重放/离线补偿用）。"""
    kinds = {crdt.OP_INSERT_ROW, crdt.OP_DELETE_ROW, crdt.OP_INSERT_COL, crdt.OP_DELETE_COL}
    if body.kind not in kinds:
        raise HTTPException(status_code=400, detail=f"该接口不支持操作: {body.kind}")
    payload = dict(body.payload)
    if body.kind in (crdt.OP_INSERT_ROW, crdt.OP_INSERT_COL) and payload.get("element_id") is None:
        client = body.client_id or f"rest:{user['username']}"
        counter = int(payload.get("counter") or body.counter or 1)
        axis = "row" if body.kind == crdt.OP_INSERT_ROW else "col"
        payload["element_id"] = crdt.element_id(client, counter, axis)
    ops = [{"kind": body.kind, "payload": payload, "version": body.version or {}}]
    return {"ok": True, "data": _apply(sheet_id, ops, user)}


@router.post("/sheets/{sheet_id}/rows")
def insert_row_endpoint(
    sheet_id: str,
    body: RowColRequest,
    user: dict = Depends(current_user),
):
    payload = {
        "at": int(body.at),
        "element_id": crdt.element_id(f"rest:{user['username']}", body.counter or 1, "row"),
    }
    return {
        "ok": True,
        "data": _apply(sheet_id, [{"kind": crdt.OP_INSERT_ROW, "payload": payload, "version": {}}], user),
    }


@router.delete("/sheets/{sheet_id}/rows/{at}")
def delete_row_endpoint(sheet_id: str, at: int, user: dict = Depends(current_user)):
    return {
        "ok": True,
        "data": _apply(sheet_id, [{"kind": crdt.OP_DELETE_ROW, "payload": {"at": at}, "version": {}}], user),
    }


@router.post("/sheets/{sheet_id}/cols")
def insert_col_endpoint(
    sheet_id: str,
    body: RowColRequest,
    user: dict = Depends(current_user),
):
    payload = {
        "at": int(body.at),
        "element_id": crdt.element_id(f"rest:{user['username']}", body.counter or 1, "col"),
    }
    return {
        "ok": True,
        "data": _apply(sheet_id, [{"kind": crdt.OP_INSERT_COL, "payload": payload, "version": {}}], user),
    }


@router.delete("/sheets/{sheet_id}/cols/{at}")
def delete_col_endpoint(sheet_id: str, at: int, user: dict = Depends(current_user)):
    return {
        "ok": True,
        "data": _apply(sheet_id, [{"kind": crdt.OP_DELETE_COL, "payload": {"at": at}, "version": {}}], user),
    }


@router.post("/sheets/{sheet_id}/import")
def import_sheet_endpoint(sheet_id: str, body: ImportRequest, user: dict = Depends(current_user)):
    _apply(sheet_id, [], user)  # 先校验 editor 及以上，避免越权时先暴露校验细节
    try:
        result = store.replace_sheet(
            sheet_id, body.rows, body.cols, body.cells, user["username"], client_id=f"import:{user['username']}"
        )
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"ok": True, "data": result}


# --------------------------------------------------------------------------- 版本


@router.get("/sheets/{sheet_id}/versions")
def list_versions(sheet_id: str, limit: int = 100, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    return {"ok": True, "data": store.list_versions(conn, sheet_id, limit=limit)}


@router.get("/sheets/{sheet_id}/versions/{version_id}")
def get_version(sheet_id: str, version_id: int, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    try:
        state = store.materialize_version(conn, sheet_id, version_id)
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "data": {"version": version_id, **state.project()}}


@router.get("/sheets/{sheet_id}/versions/{version_id}/diff")
def diff_version(
    sheet_id: str,
    version_id: int,
    base: Optional[int] = None,
    user: dict = Depends(current_user),
):
    """与 ``base``（默认当前版本）对比该历史版本，返回单元格级 diff。"""
    sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    current = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS id FROM versions WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    base_id = int(base) if base is not None else int(current["id"] or 0)
    if base_id == 0:
        raise HTTPException(status_code=404, detail="暂无可对比版本")
    try:
        return {
            "ok": True,
            "data": store.diff_versions(conn, sheet_id, version_id, base_id),
        }
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/sheets/{sheet_id}/versions/{version_id}/restore")
def restore_version(sheet_id: str, version_id: int, user: dict = Depends(current_user)):
    """恢复历史版本（追加一条 replace 操作，不破坏历史）。"""
    sheet_access(sheet_id, user, "editor")
    conn = get_conn()
    try:
        state = store.materialize_version(conn, sheet_id, version_id)
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    projection = state.project()
    try:
        result = store.replace_sheet(
            sheet_id,
            projection["rows"],
            projection["cols"],
            projection["cells"],
            user["username"],
            client_id=f"restore:{user['username']}",
            formats=projection["formats"],
        )
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    result["restored_from"] = version_id
    return {"ok": True, "data": result}


@router.post("/sheets/{sheet_id}/rollback")
def rollback_last(sheet_id: str, user: dict = Depends(current_user), steps: int = 1):
    """回退最近 N 个版本（只允许 editor 及以上；等价于恢复 ``steps`` 步之前的状态）。"""
    sheet_access(sheet_id, user, "editor")
    conn = get_conn()
    steps = max(1, int(steps))
    rows = conn.execute(
        "SELECT id FROM versions WHERE sheet_id = ? AND snapshot IS NULL ORDER BY id DESC LIMIT ? OFFSET ?",
        (sheet_id, steps, steps),
    ).fetchone()
    if not rows:
        raise HTTPException(status_code=400, detail="没有可回退的版本")
    return restore_version(sheet_id, int(rows["id"]), user)


@router.post("/sheets/{sheet_id}/snapshot")
def make_snapshot(sheet_id: str, user: dict = Depends(current_user)):
    """手动建立压缩点（快照），用于收敛版本存储体积。"""
    sheet_access(sheet_id, user, "owner")
    conn = get_conn()
    with write_lock:
        version_id = store.create_snapshot(conn, sheet_id)
        compact = store.compact_versions(conn, sheet_id)
        conn.commit()
    return {"ok": True, "data": {"version": version_id, **compact}}


# --------------------------------------------------------------------------- 权限


@router.get("/sheets/{sheet_id}/permissions")
def list_permissions(sheet_id: str, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "owner")
    conn = get_conn()
    return {"ok": True, "data": store.list_permissions(conn, sheet_id)}


@router.put("/sheets/{sheet_id}/permissions")
def put_permission(sheet_id: str, body: PermissionRequest, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "owner")
    if body.role not in config.ROLE_LEVEL:
        raise HTTPException(status_code=400, detail=f"未知角色: {body.role}")
    conn = get_conn()
    with write_lock:
        target = store.get_user_by_name(conn, body.username)
        if not target:
            raise HTTPException(status_code=404, detail="用户不存在")
        store.set_permission(conn, sheet_id, int(target["id"]), body.role)
        conn.commit()
        data = store.list_permissions(conn, sheet_id)
    return {"ok": True, "data": data}


@router.delete("/sheets/{sheet_id}/permissions/{username}")
def delete_permission(sheet_id: str, username: str, user: dict = Depends(current_user)):
    sheet_access(sheet_id, user, "owner")
    conn = get_conn()
    with write_lock:
        target = store.get_user_by_name(conn, username)
        if not target:
            raise HTTPException(status_code=404, detail="用户不存在")
        owner = store.sheet_meta(conn, sheet_id) or {}
        if owner.get("owner_id") == target["id"]:
            raise HTTPException(status_code=400, detail="不能移除所有者权限")
        store.remove_permission(conn, sheet_id, int(target["id"]))
        conn.commit()
        data = store.list_permissions(conn, sheet_id)
    return {"ok": True, "data": data}


# --------------------------------------------------------------------------- Excel


def _decode_xlsx(body: XlsxImportRequest) -> bytes:
    try:
        data = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise HTTPException(status_code=400, detail="Excel 内容不是合法的 base64") from exc
    if not data:
        raise HTTPException(status_code=400, detail="Excel 内容为空")
    if len(data) > config.MAX_XLSX_BYTES:
        raise HTTPException(
            status_code=400, detail=f"Excel 文件过大（上限 {config.MAX_XLSX_BYTES // (1024 * 1024)}MB）"
        )
    return data


@router.post("/sheets/{sheet_id}/xlsx/parse")
def xlsx_parse(sheet_id: str, body: XlsxImportRequest, user: dict = Depends(current_user)):
    """解析上传的 xlsx，返回列出的工作表名与预览统计（不落库）。"""
    _apply(sheet_id, [], user)
    data = _decode_xlsx(body)
    try:
        result = xlsx.import_workbook(data, body.sheet_name)
    except xlsx.ExcelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "ok": True,
        "data": {
            "sheet_name": result["sheet_name"],
            "sheet_names": result["sheet_names"],
            "rows": result["rows"],
            "cols": result["cols"],
            "cell_count": len(result["cells"]),
            "format_count": len(result["formats"]),
            "skipped_long_cells": result["skipped_long_cells"],
        },
    }


@router.post("/sheets/{sheet_id}/xlsx/import")
def xlsx_import(sheet_id: str, body: XlsxImportRequest, user: dict = Depends(current_user)):
    """把 xlsx 的一个工作表导入为当前表格内容（整体替换，生成一个版本）。"""
    _apply(sheet_id, [], user)
    data = _decode_xlsx(body)
    try:
        parsed = xlsx.import_workbook(data, body.sheet_name)
    except xlsx.ExcelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    try:
        result = store.replace_sheet(
            sheet_id,
            parsed["rows"],
            parsed["cols"],
            parsed["cells"],
            user["username"],
            client_id=f"xlsx:{user['username']}",
            formats=parsed["formats"],
        )
    except crdt.InvalidOperation as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    # 响应补上表格名与角色：前端会直接用这个对象刷新状态（缺 name 会导致标题显示异常）
    result["name"] = (store.sheet_meta(get_conn(), sheet_id) or {}).get("name", "")
    result["role"] = sheet_access(sheet_id, user, "viewer")
    result["sheet_name"] = parsed["sheet_name"]
    result["skipped_long_cells"] = parsed["skipped_long_cells"]
    return {"ok": True, "data": result}


@router.post("/sheets/{sheet_id}/xlsx/export")
def xlsx_export(sheet_id: str, body: Optional[XlsxExportRequest] = None, user: dict = Depends(current_user)):
    """导出为 .xlsx（保留公式、样式、冻结窗格）。"""
    sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    payload = store.sheet_payload(conn, sheet_id)
    options = body or XlsxExportRequest()
    try:
        data = xlsx.export_workbook(
            payload["name"],
            payload["rows"],
            payload["cols"],
            payload["cells"],
            payload["formats"],
            frozen_rows=int(options.frozen_rows or 0),
            frozen_cols=int(options.frozen_cols or 0),
        )
    except xlsx.ExcelError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    filename = _safe_filename(payload["name"]) + ".xlsx"
    # HTTP 头只能承载 ASCII：中文文件名必须用 RFC 5987 的百分号编码放进 filename*
    quoted = quote(filename)
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={
            "Content-Disposition": f"attachment; filename=\"sheet.xlsx\"; filename*=UTF-8''{quoted}",
            "X-Filename": quoted,
        },
    )


def _safe_filename(name: str) -> str:
    cleaned = "".join(ch for ch in (name or "sheet") if ch not in '\\/:*?"<>|').strip()
    return (cleaned or "sheet")[:60]


# --------------------------------------------------------------------------- 评论


@router.get("/sheets/{sheet_id}/comments")
def list_comments(
    sheet_id: str,
    include_resolved: bool = True,
    user: dict = Depends(current_user),
):
    sheet_access(sheet_id, user, "viewer")
    conn = get_conn()
    return {
        "ok": True,
        "data": {
            "comments": store.list_comments(conn, sheet_id, include_resolved=include_resolved),
            "counts": store.comment_counts(conn, sheet_id),
            "members": store.sheet_members(conn, sheet_id),
        },
    }


@router.post("/sheets/{sheet_id}/comments")
def create_comment(sheet_id: str, body: CommentCreate, user: dict = Depends(current_user)):
    # 评论者及以上可写评论；viewer 只能读
    sheet_access(sheet_id, user, "commenter")
    conn = get_conn()
    if len(body.body) > config.MAX_COMMENT_CHARS:
        raise HTTPException(status_code=400, detail="评论内容超长")
    state = crdt.load_state(conn, sheet_id)
    row_id = body.row_id
    col_id = body.col_id
    if row_id is None or col_id is None:
        raise HTTPException(status_code=400, detail="缺少 row_id / col_id")
    if row_id not in state.row_ids or col_id not in state.col_ids:
        raise HTTPException(status_code=400, detail="该单元格已不存在（行或列已被删除）")
    members = [m["username"] for m in store.sheet_members(conn, sheet_id)]
    mentions = store.parse_mentions(body.body, members)
    with write_lock:
        comment = store.add_comment(
            conn, sheet_id, row_id, col_id, body.body, user["id"], user["username"], mentions
        )
        conn.commit()
        counts = store.comment_counts(conn, sheet_id)
    # 广播给同表格的其他客户端（与 WebSocket 上行写入保持一致的行为）
    _broadcast_from_sync(
        sheet_id,
        {"type": "comment_added", "comment": comment, "counts": counts, "mentions": mentions},
    )
    return {"ok": True, "data": {"comment": comment, "counts": counts, "mentions": mentions}}


def _broadcast_from_sync(sheet_id: str, message: dict) -> None:
    """在同步 REST 处理函数里把消息投递到 WebSocket 房间。

    同步端点由 FastAPI 放在线程池里执行，线程内没有运行中的事件循环，
    因此用启动时保存的主循环 + ``run_coroutine_threadsafe`` 投递。
    拿不到主循环时（例如 pytest 的同步 TestClient）静默跳过：
    广播是增强行为，不应让写入失败。
    """
    loop = _main_loop
    if loop is None or loop.is_closed():
        return
    from . import ws as ws_module

    try:
        asyncio.run_coroutine_threadsafe(ws_module.manager.broadcast(sheet_id, message), loop)
    except RuntimeError:
        return


#: 应用启动时保存的主事件循环（供同步端点跨线程投递广播）。
_main_loop: Optional[asyncio.AbstractEventLoop] = None


def remember_event_loop() -> None:
    """在 FastAPI startup 里调用，记录主循环。"""
    global _main_loop
    try:
        _main_loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - 正常启动时不会发生
        _main_loop = None


@router.post("/sheets/{sheet_id}/comments/{comment_id}/resolve")
def resolve_comment(
    sheet_id: str,
    comment_id: int,
    body: Optional[CommentResolve] = None,
    user: dict = Depends(current_user),
):
    sheet_access(sheet_id, user, "commenter")
    resolved = True if body is None else bool(body.resolved)
    conn = get_conn()
    with write_lock:
        comment = store.resolve_comment(conn, sheet_id, comment_id, resolved)
        if not comment:
            raise HTTPException(status_code=404, detail="评论不存在")
        conn.commit()
        counts = store.comment_counts(conn, sheet_id)
    _broadcast_from_sync(sheet_id, {"type": "comment_updated", "comment": comment, "counts": counts})
    return {"ok": True, "data": {"comment": comment, "counts": counts}}


@router.delete("/sheets/{sheet_id}/comments/{comment_id}")
def delete_comment(sheet_id: str, comment_id: int, user: dict = Depends(current_user)):
    role = sheet_access(sheet_id, user, "commenter")
    conn = get_conn()
    existing = store.get_comment(conn, comment_id)
    if not existing or existing["sheet_id"] != sheet_id:
        raise HTTPException(status_code=404, detail="评论不存在")
    # 只能删自己的评论；owner/editor 可删任意评论
    if existing["author"] != user["username"] and auth.role_level(role) < config.ROLE_LEVEL["editor"]:
        raise HTTPException(status_code=403, detail="只能删除自己的评论")
    with write_lock:
        removed = store.delete_comment(conn, sheet_id, comment_id)
        conn.commit()
        counts = store.comment_counts(conn, sheet_id)
    return {"ok": True, "data": {"deleted": (removed or {}).get("id"), "counts": counts}}
