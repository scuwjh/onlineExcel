"""WebSocket 实时协同：cell_update / cell_format / 行列操作 / cursor / presence。"""
import json

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from .schemas import CellUpdate
from .sheets import apply_updates, apply_format, insert_row, delete_row, insert_col, delete_col

router = APIRouter()


class ConnectionManager:
    def __init__(self) -> None:
        self._rooms: dict[str, set[WebSocket]] = {}
        self._users: dict[WebSocket, str] = {}

    async def connect(self, sheet_id: str, websocket: WebSocket) -> None:
        await websocket.accept()
        self._rooms.setdefault(sheet_id, set()).add(websocket)

    def disconnect(self, sheet_id: str, websocket: WebSocket) -> None:
        room = self._rooms.get(sheet_id)
        if room and websocket in room:
            room.remove(websocket)
            if not room:
                self._rooms.pop(sheet_id, None)
        self._users.pop(websocket, None)

    async def broadcast(self, sheet_id: str, message: dict) -> None:
        for ws in list(self._rooms.get(sheet_id, set())):
            try:
                await ws.send_text(json.dumps(message, ensure_ascii=False))
            except Exception:
                pass


manager = ConnectionManager()


@router.websocket("/ws/sheets/{sheet_id}")
async def sheet_ws(websocket: WebSocket, sheet_id: str) -> None:
    user = websocket.query_params.get("user", "anonymous")
    await manager.connect(sheet_id, websocket)
    manager._users[websocket] = user
    try:
        await manager.broadcast(sheet_id, {"type": "presence", "user": user, "online": True})
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")
            if mtype == "cell_update":
                update = CellUpdate(
                    row=int(msg.get("row", 0)),
                    col=int(msg.get("col", 0)),
                    value=msg.get("value"),
                )
                result = apply_updates(sheet_id, [update], user)
                await manager.broadcast(
                    sheet_id,
                    {
                        "type": "cell_update",
                        "row": update.row,
                        "col": update.col,
                        "value": update.value,
                        "user": user,
                        "version": result["version"],
                    },
                )
            elif mtype == "cell_format":
                row = int(msg.get("row", 0))
                col = int(msg.get("col", 0))
                fmt = msg.get("format")
                result = apply_format(sheet_id, row, col, fmt, user)
                await manager.broadcast(
                    sheet_id,
                    {
                        "type": "cell_format",
                        "row": row,
                        "col": col,
                        "format": fmt,
                        "user": user,
                        "version": result["version"],
                    },
                )
            elif mtype == "row_insert":
                at = int(msg.get("at", 0))
                result = insert_row(sheet_id, at, user)
                await manager.broadcast(
                    sheet_id, {"type": "row_insert", "at": at, "rows": result["rows"], "user": user}
                )
            elif mtype == "row_delete":
                at = int(msg.get("at", 0))
                result = delete_row(sheet_id, at, user)
                await manager.broadcast(
                    sheet_id, {"type": "row_delete", "at": at, "rows": result["rows"], "user": user}
                )
            elif mtype == "col_insert":
                at = int(msg.get("at", 0))
                result = insert_col(sheet_id, at, user)
                await manager.broadcast(
                    sheet_id, {"type": "col_insert", "at": at, "cols": result["cols"], "user": user}
                )
            elif mtype == "col_delete":
                at = int(msg.get("at", 0))
                result = delete_col(sheet_id, at, user)
                await manager.broadcast(
                    sheet_id, {"type": "col_delete", "at": at, "cols": result["cols"], "user": user}
                )
            elif mtype == "sheet_import":
                await manager.broadcast(sheet_id, {"type": "sheet_import", "user": user})
            elif mtype == "cursor":
                await manager.broadcast(
                    sheet_id,
                    {
                        "type": "cursor",
                        "row": msg.get("row"),
                        "col": msg.get("col"),
                        "user": user,
                    },
                )
            elif mtype == "presence":
                await manager.broadcast(
                    sheet_id,
                    {
                        "type": "presence",
                        "user": user,
                        "online": bool(msg.get("online", True)),
                    },
                )
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(sheet_id, websocket)
        await manager.broadcast(sheet_id, {"type": "presence", "user": user, "online": False})
