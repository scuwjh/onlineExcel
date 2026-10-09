"""WebSocket 实时协同：鉴权、按表格房间广播、协同操作入口。

消息形态（服务端 → 客户端）::

    {"type": "welcome",   "seq": 12, "version": 34, "role": "editor", "user": "alice",
     "rows": 100, "cols": 20, "rowIds": [...], "colIds": [...], "users": [...], "seq": 12}
    {"type": "cell_update",  "seq": 13, "version": 35, "row_id": "...", "col_id": "...",
     "row": 3, "col": 2, "value": "1", "user": "alice", "cells": {...}, "formats": {...}}
    {"type": "cell_format",  ...同上，带 "format": {...}}
    {"type": "insert_row",   "seq": 14, "version": 36, "at": 3, "element_id": "...",
     "rowIds": [...], "colIds": [...], "rows": 101, "cols": 20, "user": "alice"}
    {"type": "delete_row" | "insert_col" | "delete_col", 同上}
    {"type": "sheet_import", "seq": 15, "version": 37, "rows": 20, "cols": 5,
     "rowIds": [...], "colIds": [...], "user": "alice"}   # 客户端收到后重新拉取
    {"type": "cursor",  "row": 3, "col": 2, "user": "alice"}
    {"type": "presence","user": "alice", "online": true, "users": ["alice"]}
    {"type": "error",   "code": "forbidden" | "invalid" | "unauthorized", "message": "..."}
"""
from __future__ import annotations

import json
import logging
from typing import Dict, Optional, Set

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from . import auth, config, crdt, store
from .db import get_conn

logger = logging.getLogger("online_excel.ws")
router = APIRouter()

WRITE_KINDS = {
    "cell_update": crdt.OP_SET_CELL,
    "cell_format": crdt.OP_SET_FORMAT,
}
STRUCT_KINDS = {
    "row_insert": crdt.OP_INSERT_ROW,
    "row_delete": crdt.OP_DELETE_ROW,
    "col_insert": crdt.OP_INSERT_COL,
    "col_delete": crdt.OP_DELETE_COL,
}
BROADCAST_TYPES = {
    crdt.OP_SET_CELL: "cell_update",
    crdt.OP_SET_FORMAT: "cell_format",
    crdt.OP_INSERT_ROW: "row_insert",
    crdt.OP_DELETE_ROW: "row_delete",
    crdt.OP_INSERT_COL: "col_insert",
    crdt.OP_DELETE_COL: "col_delete",
    crdt.OP_REPLACE: "sheet_import",
}


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: Dict[str, Set[WebSocket]] = {}
        self._users: Dict[WebSocket, str] = {}

    async def connect(self, sheet_id: str, websocket: WebSocket, user: str) -> None:
        await websocket.accept()
        self._rooms.setdefault(sheet_id, set()).add(websocket)
        self._users[websocket] = user

    def disconnect(self, sheet_id: str, websocket: WebSocket) -> Optional[str]:
        room = self._rooms.get(sheet_id)
        if room and websocket in room:
            room.discard(websocket)
            if not room:
                self._rooms.pop(sheet_id, None)
        return self._users.pop(websocket, None)

    def online_users(self, sheet_id: str) -> list:
        seen = []
        for ws in self._rooms.get(sheet_id, set()):
            user = self._users.get(ws)
            if user and user not in seen:
                seen.append(user)
        return sorted(seen)

    async def send(self, websocket: WebSocket, message: dict) -> None:
        try:
            await websocket.send_text(json.dumps(message, ensure_ascii=False))
        except Exception:  # pragma: no cover - 连接已断开
            pass

    async def broadcast(self, sheet_id: str, message: dict, skip: Optional[WebSocket] = None) -> None:
        for ws in list(self._rooms.get(sheet_id, set())):
            if ws is skip:
                continue
            await self.send(ws, message)


manager = ConnectionManager()


def _authenticate(websocket: WebSocket) -> Optional[dict]:
    """支持 ``?token=`` 与 ``Authorization: Bearer``（浏览器 WebSocket 只能带 query）。"""
    token = websocket.query_params.get("token") or auth.bearer_token(
        websocket.headers.get("authorization")
    )
    if not token:
        return None
    try:
        payload = auth.decode_token(token)
    except auth.AuthError:
        return None
    conn = get_conn()
    try:
        user = store.get_user(conn, int(payload.get("sub", 0)))
    except (TypeError, ValueError):
        return None
    if not user:
        return None
    return {"id": int(user["id"]), "username": user["username"]}


def _structural_payload(kind: str, msg: dict, state: crdt.SheetState, client_id: str, counter: int) -> dict:
    """把 ``at`` 索引解析成稳定元素 ID，并生成新元素 ID（并发安全）。"""
    at = int(msg.get("at") or 0)
    axis = "row" if kind in (crdt.OP_INSERT_ROW, crdt.OP_DELETE_ROW) else "col"
    ids = state.row_ids if axis == "row" else state.col_ids
    at = max(0, min(len(ids), at))
    if kind in (crdt.OP_INSERT_ROW, crdt.OP_INSERT_COL):
        element = msg.get("element_id") or crdt.element_id(client_id, counter, axis)
        return {"at": at, "element_id": element}
    target = msg.get("element_id")
    if not target:
        if not (0 <= at < len(ids)):
            raise crdt.InvalidOperation(f"{axis} 索引越界: {at}")
        target = ids[at]
    return {"element_id": target}


def _fits(message: dict) -> bool:
    """消息是否在单帧体积上限内（超限则退化为元数据 + 客户端 REST 拉取）。"""
    return len(json.dumps(message, ensure_ascii=False)) <= config.MAX_WS_MESSAGE_CHARS


@router.websocket("/ws/sheets/{sheet_id}")
async def sheet_ws(websocket: WebSocket, sheet_id: str) -> None:
    user = _authenticate(websocket)
    if not user:
        await websocket.close(code=4401, reason="unauthorized")
        return

    conn = get_conn()
    if not store.sheet_exists(conn, sheet_id):
        await websocket.close(code=4404, reason="sheet not found")
        return
    role = store.get_role(conn, sheet_id, user["id"])
    if auth.role_level(role) < config.ROLE_LEVEL["viewer"]:
        await websocket.close(code=4403, reason="forbidden")
        return

    username = user["username"]
    #: 客户端本地操作计数，用于生成并发安全的元素 ID。
    counters: Dict[str, int] = {}

    await manager.connect(sheet_id, websocket, username)
    state = crdt.load_state(conn, sheet_id)
    projection = state.project()
    version_row = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS id FROM versions WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    try:
        welcome = {
            "type": "welcome",
            "seq": state.seq,
            "version": int(version_row["id"] or 0),
            "role": role,
            "user": username,
            "rows": len(state.row_ids),
            "cols": len(state.col_ids),
            "rowIds": state.row_ids,
            "colIds": state.col_ids,
            "cells": projection["cells"],
            "formats": projection["formats"],
            "users": manager.online_users(sheet_id),
        }
        if not _fits(welcome):
            # 大表格：不推送全量投影，客户端收到 reload 标记后通过 REST 拉取。
            welcome = {
                "type": "welcome",
                "seq": state.seq,
                "version": int(version_row["id"] or 0),
                "role": role,
                "user": username,
                "rows": len(state.row_ids),
                "cols": len(state.col_ids),
                "reload": True,
                "users": manager.online_users(sheet_id),
            }
        await manager.send(websocket, welcome)
        await manager.broadcast(
            sheet_id,
            {"type": "presence", "user": username, "online": True, "users": manager.online_users(sheet_id)},
            skip=websocket,
        )

        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            if mtype == "cursor":
                await manager.broadcast(
                    sheet_id,
                    {"type": "cursor", "row": msg.get("row"), "col": msg.get("col"), "user": username},
                    skip=websocket,
                )
                continue
            if mtype == "ping":
                await manager.send(websocket, {"type": "pong", "seq": state.seq})
                continue
            if mtype not in WRITE_KINDS and mtype not in STRUCT_KINDS:
                await manager.send(
                    websocket, {"type": "error", "code": "invalid", "message": f"未知消息类型: {mtype}"}
                )
                continue

            # 每次写入都重新校验角色（权限可能刚被调整）。
            role = store.get_role(conn, sheet_id, user["id"])
            if auth.role_level(role) < config.ROLE_LEVEL["editor"]:
                await manager.send(
                    websocket,
                    {"type": "error", "code": "forbidden", "message": f"当前角色 {role or '无权限'} 不可编辑"},
                )
                continue

            client_id = str(msg.get("client_id") or f"ws:{username}")
            version = dict(msg.get("version") or {})
            counter = int(msg.get("counter") or counters.get("n", 0) + 1)
            counters["n"] = max(counters.get("n", 0), counter)
            try:
                state = crdt.load_state(conn, sheet_id)
                if mtype in STRUCT_KINDS:
                    kind = STRUCT_KINDS[mtype]
                    payload = _structural_payload(kind, msg, state, client_id, counter)
                else:
                    kind = WRITE_KINDS[mtype]
                    payload = _cell_payload(mtype, msg, state)
                ops = [{"kind": kind, "payload": payload, "version": version}]
                result = store.apply_ops(sheet_id, ops, username, client_id=client_id)
            except crdt.SheetNotFound:
                await websocket.close(code=4404, reason="sheet not found")
                return
            except crdt.InvalidOperation as exc:
                await manager.send(websocket, {"type": "error", "code": "invalid", "message": str(exc)})
                continue

            message = {
                "type": BROADCAST_TYPES[kind],
                "seq": result["seq"],
                "version": result["version"],
                "user": username,
                "role": role,
            }
            if kind == crdt.OP_REPLACE:
                message.update(
                    {
                        "rows": result.get("rows"),
                        "cols": result.get("cols"),
                        "rowIds": result.get("rowIds"),
                        "colIds": result.get("colIds"),
                        "cells": result.get("cells", {}),
                        "formats": result.get("formats", {}),
                    }
                )
            elif kind in (crdt.OP_SET_CELL, crdt.OP_SET_FORMAT):
                message.update(
                    {
                        "row_id": payload["row_id"],
                        "col_id": payload["col_id"],
                        "row": msg.get("row"),
                        "col": msg.get("col"),
                        "value": payload.get("value"),
                        "format": payload.get("format"),
                        "rows": result.get("rows"),
                        "cols": result.get("cols"),
                        "cells": result.get("cells", {}),
                        "formats": result.get("formats", {}),
                    }
                )
            else:
                message.update(
                    {
                        "at": payload.get("at"),
                        "element_id": payload.get("element_id"),
                        "rowIds": result.get("rowIds"),
                        "colIds": result.get("colIds"),
                        "rows": result.get("rows"),
                        "cols": result.get("cols"),
                        # 结构变化会影响所有单元格坐标，随广播带上权威投影，避免各端漂移。
                        "cells": result.get("cells", {}),
                        "formats": result.get("formats", {}),
                    }
                )

            if not _fits(message):
                # 大表格：投影过大 → 只广播变更元数据，客户端用 REST 重新拉取权威状态。
                slim = {
                    "type": message["type"],
                    "seq": message["seq"],
                    "version": message["version"],
                    "user": message["user"],
                    "role": message["role"],
                    "reload": True,
                    "rows": result.get("rows"),
                    "cols": result.get("cols"),
                    "row_id": message.get("row_id"),
                    "col_id": message.get("col_id"),
                    "row": message.get("row"),
                    "col": message.get("col"),
                    "value": message.get("value"),
                    "format": message.get("format"),
                    "at": message.get("at"),
                    "element_id": message.get("element_id"),
                }
                message = {k: v for k, v in slim.items() if v is not None}

            await manager.broadcast(sheet_id, message, skip=websocket)
            await manager.send(websocket, message)
    except WebSocketDisconnect:
        pass
    except Exception:  # pragma: no cover - 兜底日志
        logger.exception("WebSocket 处理异常 sheet=%s user=%s", sheet_id, username)
    finally:
        manager.disconnect(sheet_id, websocket)
        await manager.broadcast(
            sheet_id,
            {"type": "presence", "user": username, "online": False, "users": manager.online_users(sheet_id)},
        )


def _cell_payload(mtype: str, msg: dict, state: crdt.SheetState) -> dict:
    row_id = msg.get("row_id")
    col_id = msg.get("col_id")
    if row_id is None:
        row = int(msg.get("row") or 0)
        if not (0 <= row < len(state.row_ids)):
            raise crdt.InvalidOperation(f"行索引越界: {row}")
        row_id = state.row_ids[row]
    elif row_id not in state.row_ids:
        raise crdt.InvalidOperation(f"行不存在: {row_id}")
    else:
        row = state.row_ids.index(row_id)
    if col_id is None:
        col = int(msg.get("col") or 0)
        if not (0 <= col < len(state.col_ids)):
            raise crdt.InvalidOperation(f"列索引越界: {col}")
        col_id = state.col_ids[col]
    elif col_id not in state.col_ids:
        raise crdt.InvalidOperation(f"列不存在: {col_id}")
    else:
        col = state.col_ids.index(col_id)

    # 序号一并入操作日志：结构被整体替换（CSV 导入 / 版本恢复）后，
    # 历史重放可据此把旧的元素 ID 迁移到新结构。
    payload = {"row_id": row_id, "col_id": col_id, "row": row, "col": col}
    if mtype == "cell_update":
        value = msg.get("value")
        if value is not None:
            if not isinstance(value, str):
                value = str(value)
            if len(value) > config.MAX_CELL_CHARS:
                raise crdt.InvalidOperation("单元格内容超长")
        payload["value"] = value
    else:
        fmt = msg.get("format")
        if fmt is not None and not isinstance(fmt, dict):
            raise crdt.InvalidOperation("format 必须是对象或 null")
        payload["format"] = fmt
    return payload
