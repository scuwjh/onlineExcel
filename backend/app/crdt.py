"""协同状态机（CRDT 风格）。

模型
----
- **行/列是一等有序元素**：每个元素有稳定 ID（``{client}:{counter}``），插删操作针对 ID
  而非索引。并发在“同一位置”插入时，按服务端分配的操作序 ``seq`` 决定先后，
  因此所有副本对同一份操作日志重放后必然得到相同的行列顺序（收敛）。
- **单元格是 LWW 寄存器**：值与格式各自带版本向量（version vector）+ 客户端 ID + ``seq``。
  比较规则：版本向量可比较时以支配关系取胜；并发时以 ``client_id`` 字典序打破平局，
  保证不同到达顺序下结果一致。
- **删除即移除**：删除行/列时连同其单元格一起删除，避免“幽灵单元”。

该模块保持纯函数风格（除 ``load_state`` 外），便于单元测试直接构造状态。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Iterable, Optional

CELL_SEPARATOR = ":"

# 操作类型
OP_INSERT_ROW = "insert_row"
OP_DELETE_ROW = "delete_row"
OP_INSERT_COL = "insert_col"
OP_DELETE_COL = "delete_col"
OP_SET_CELL = "set_cell"
OP_SET_FORMAT = "set_format"
OP_REPLACE = "replace"
STRUCTURAL_KINDS = (OP_INSERT_ROW, OP_DELETE_ROW, OP_INSERT_COL, OP_DELETE_COL)
CELL_KINDS = (OP_SET_CELL, OP_SET_FORMAT)
OP_KINDS = STRUCTURAL_KINDS + CELL_KINDS + (OP_REPLACE,)


class SheetNotFound(Exception):
    """表格不存在。"""


class InvalidOperation(Exception):
    """操作非法（越界、未知类型、payload 过大等）。"""


# --------------------------------------------------------------------------- 引用工具


def col_label(index: int) -> str:
    """0 → A、25 → Z、26 → AA。"""
    n = index + 1
    label = ""
    while n > 0:
        n, rem = divmod(n - 1, 26)
        label = chr(65 + rem) + label
    return label


def cell_ref(row: int, col: int) -> str:
    return f"{col_label(col)}{row + 1}"


def parse_cell_ref(ref: str) -> tuple:
    """``A1`` → ``(0, 0)``。非法引用抛 :class:`InvalidOperation`。"""
    text = ref.strip().upper()
    letters = ""
    digits = ""
    for ch in text:
        if ch.isalpha() and not digits:
            letters += ch
        elif ch.isdigit():
            digits += ch
        else:
            raise InvalidOperation(f"非法单元格引用: {ref}")
    if not letters or not digits:
        raise InvalidOperation(f"非法单元格引用: {ref}")
    col = 0
    for ch in letters:
        col = col * 26 + (ord(ch) - 64)
    row = int(digits) - 1
    if row < 0 or col - 1 < 0:
        raise InvalidOperation(f"非法单元格引用: {ref}")
    return row, col - 1


def cell_key(row: int, col: int) -> str:
    return f"{row}{CELL_SEPARATOR}{col}"


def parse_cell_key(key: str) -> tuple:
    row, col = key.split(CELL_SEPARATOR)
    return int(row), int(col)


# ------------------------------------------------------------------------ 版本向量


def load_version(raw: Optional[str]) -> dict:
    if not raw:
        return {}
    try:
        data = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {str(k): int(v) for k, v in data.items()}


def dump_version(version: dict) -> str:
    return json.dumps(version, sort_keys=True, separators=(",", ":"))


def version_dominates(a: dict, b: dict) -> bool:
    """``a`` 是否支配 ``b``（a 每个分量都 ≥ b）。"""
    return all(a.get(k, 0) >= v for k, v in b.items())


def compare_versions(a: dict, b: dict) -> str:
    """返回 ``"gt"`` / ``"lt"`` / ``"eq"`` / ``"concurrent"``。"""
    a_dom = version_dominates(a, b)
    b_dom = version_dominates(b, a)
    if a_dom and b_dom:
        return "eq"
    if a_dom:
        return "gt"
    if b_dom:
        return "lt"
    return "concurrent"


@dataclass(frozen=True)
class Reg:
    """一个 LWW 寄存器的当前值及其因果元数据。"""

    value: Optional[str] = None
    version: dict = field(default_factory=dict)
    seq: int = 0
    client: str = ""

    def loses_to(self, other: "Reg") -> bool:
        """``self`` 是否应被 ``other`` 覆盖（确定性判定）。"""
        if other.seq == self.seq and other.client == self.client:
            return False  # 同一操作，幂等
        if other.seq > self.seq and compare_versions(other.version, self.version) != "lt":
            return True
        rel = compare_versions(other.version, self.version)
        if rel == "gt":
            return True
        if rel == "lt":
            return False
        if rel == "eq":
            return False
        # 并发：双方都未见过对方 → 用客户端 ID 与 seq 做确定性打破平局
        return (other.client, other.seq) > (self.client, self.seq)


def parse_reg(raw_value: Optional[str], raw_version: Optional[str], seq: int, client: str) -> Reg:
    return Reg(value=raw_value, version=load_version(raw_version), seq=int(seq or 0), client=client or "")


def dump_reg(reg: Reg) -> dict:
    return {
        "value": reg.value,
        "version": dump_version(reg.version),
        "seq": reg.seq,
        "client": reg.client,
    }


# ----------------------------------------------------------------------------- 状态


@dataclass
class SheetState:
    """一份可重放/可投影的表格状态。"""

    sheet_id: str
    name: str = ""
    row_ids: list = field(default_factory=list)
    col_ids: list = field(default_factory=list)
    values: dict = field(default_factory=dict)  # (row_id, col_id) -> Reg
    formats: dict = field(default_factory=dict)
    seq: int = 0

    # -- 查询 -------------------------------------------------------------

    def row_index(self, row_id: str) -> int:
        try:
            return self.row_ids.index(row_id)
        except ValueError as exc:
            raise InvalidOperation(f"行不存在: {row_id}") from exc

    def col_index(self, col_id: str) -> int:
        try:
            return self.col_ids.index(col_id)
        except ValueError as exc:
            raise InvalidOperation(f"列不存在: {col_id}") from exc

    def project(self) -> dict:
        """投影为前端使用的 ``cells`` / ``formats``（键为 ``"row:col"``）。"""
        row_pos = {rid: i for i, rid in enumerate(self.row_ids)}
        col_pos = {cid: i for i, cid in enumerate(self.col_ids)}
        cells: dict = {}
        formats: dict = {}
        for (row_id, col_id), reg in self.values.items():
            if reg.value is None:
                continue
            r = row_pos.get(row_id)
            c = col_pos.get(col_id)
            if r is None or c is None:
                continue
            cells[f"{r}{CELL_SEPARATOR}{c}"] = reg.value
        for (row_id, col_id), reg in self.formats.items():
            if reg.value is None:
                continue
            r = row_pos.get(row_id)
            c = col_pos.get(col_id)
            if r is None or c is None:
                continue
            try:
                formats[f"{r}{CELL_SEPARATOR}{c}"] = json.loads(reg.value)
            except (json.JSONDecodeError, TypeError):
                continue
        return {"cells": cells, "formats": formats, "rows": len(self.row_ids), "cols": len(self.col_ids)}

    def structural_elements(self) -> list:
        out = [("row", i, rid) for i, rid in enumerate(self.row_ids)]
        out.extend(("col", i, cid) for i, cid in enumerate(self.col_ids))
        return out

    def cell_rows(self) -> Iterable[tuple]:
        """展开为 ``(row_index, col_index, value_reg, format_reg)``，供落库/导出。"""
        row_pos = {rid: i for i, rid in enumerate(self.row_ids)}
        col_pos = {cid: i for i, cid in enumerate(self.col_ids)}
        keys = set(self.values) | set(self.formats)
        for row_id, col_id in keys:
            r = row_pos.get(row_id)
            c = col_pos.get(col_id)
            if r is None or c is None:
                continue
            yield r, c, self.values.get((row_id, col_id)), self.formats.get((row_id, col_id))


# --------------------------------------------------------------------- 操作应用


def element_id(client_id: str, counter: int, axis: str) -> str:
    return f"{client_id}:{axis[0]}{counter}"


def _require_int(payload: dict, key: str, default: Optional[int] = None) -> int:
    if key not in payload or payload[key] is None:
        if default is None:
            raise InvalidOperation(f"缺少参数 {key}")
        return default
    try:
        return int(payload[key])
    except (TypeError, ValueError) as exc:
        raise InvalidOperation(f"参数 {key} 必须是整数") from exc


def apply_op(
    state: SheetState,
    kind: str,
    payload: dict,
    *,
    seq: int,
    client_id: str,
    version: Optional[dict] = None,
) -> None:
    """把一个操作应用到状态上（就地修改）。``seq`` 为服务端分配的操作序。"""
    if kind not in OP_KINDS:
        raise InvalidOperation(f"未知操作类型: {kind}")
    version = dict(version or {})

    if kind == OP_INSERT_ROW or kind == OP_INSERT_COL:
        _apply_insert(state, kind, payload, seq=seq, client_id=client_id)

    elif kind == OP_DELETE_ROW or kind == OP_DELETE_COL:
        axis = "row" if kind == OP_DELETE_ROW else "col"
        element_id_value = payload.get("element_id")
        if element_id_value:
            _remove_element(state, axis, str(element_id_value))
        else:
            at = _require_int(payload, "at", 0)
            ids = state.row_ids if axis == "row" else state.col_ids
            if 0 <= at < len(ids):
                _remove_element(state, axis, ids[at])

    elif kind == OP_SET_CELL:
        _apply_cell(state, payload, seq=seq, client_id=client_id, version=version, is_format=False)

    elif kind == OP_SET_FORMAT:
        _apply_cell(state, payload, seq=seq, client_id=client_id, version=version, is_format=True)

    elif kind == OP_REPLACE:
        _apply_replace(state, payload, seq=seq, client_id=client_id)

    state.seq = max(state.seq, seq)


def _apply_insert(
    state: SheetState, kind: str, payload: dict, *, seq: int, client_id: str
) -> None:
    axis = "row" if kind == OP_INSERT_ROW else "col"
    ids = state.row_ids if axis == "row" else state.col_ids
    at = _require_int(payload, "at", 0)
    at = max(0, min(len(ids), at))
    new_id = payload.get("element_id")
    if not new_id:
        counter = _require_int(payload, "counter", seq)
        new_id = element_id(client_id, counter, axis)
    new_id = str(new_id)
    if new_id in ids:
        return  # 幂等重放
    ids.insert(at, new_id)


def _remove_element(state: SheetState, axis: str, element_id_value: str) -> None:
    if axis == "row":
        if element_id_value not in state.row_ids:
            return
        state.row_ids.remove(element_id_value)
    else:
        if element_id_value not in state.col_ids:
            return
        state.col_ids.remove(element_id_value)
    for key in [k for k in state.values if element_id_value in k]:
        state.values.pop(key, None)
    for key in [k for k in state.formats if element_id_value in k]:
        state.formats.pop(key, None)


def _resolve_rowcol(state: SheetState, payload: dict) -> tuple:
    """把 ``element_id`` 或索引解析为 ``(row_id, col_id)``。

    结构性操作会整体重建行列（CSV 导入、版本恢复），此时**旧版本里记录的
    element_id 在新结构里并不存在**。历史重放因此需要"结构迁移回退"：
    当 element_id 找不到但该操作仍带着序号（``row``/``col``）时，按序号解析。
    """
    row_id = payload.get("row_id")
    col_id = payload.get("col_id")
    if row_id is None:
        at = _require_int(payload, "row", None)
        if not (0 <= at < len(state.row_ids)):
            raise InvalidOperation(f"row 索引越界: {at}（当前 {len(state.row_ids)} 行）")
        row_id = state.row_ids[at]
    elif row_id not in state.row_ids:
        at = payload.get("row")
        if at is None:
            raise InvalidOperation(f"row_id 不存在: {row_id}")
        at = int(at)
        if not (0 <= at < len(state.row_ids)):
            raise InvalidOperation(f"row_id {row_id} 已失效且序号越界: {at}")
        row_id = state.row_ids[at]
    if col_id is None:
        at = _require_int(payload, "col", None)
        if not (0 <= at < len(state.col_ids)):
            raise InvalidOperation(f"col 索引越界: {at}（当前 {len(state.col_ids)} 列）")
        col_id = state.col_ids[at]
    elif col_id not in state.col_ids:
        at = payload.get("col")
        if at is None:
            raise InvalidOperation(f"col_id 不存在: {col_id}")
        at = int(at)
        if not (0 <= at < len(state.col_ids)):
            raise InvalidOperation(f"col_id {col_id} 已失效且序号越界: {at}")
        col_id = state.col_ids[at]
    return row_id, col_id


def _apply_cell(
    state: SheetState,
    payload: dict,
    *,
    seq: int,
    client_id: str,
    version: dict,
    is_format: bool,
) -> None:
    row_id, col_id = _resolve_rowcol(state, payload)
    value = payload.get("value")
    if value is not None and not isinstance(value, str):
        value = json.dumps(value, ensure_ascii=False) if is_format else str(value)
    if is_format and payload.get("format") is not None:
        value = json.dumps(payload["format"], ensure_ascii=False)
    if value == "" and not is_format:
        value = None  # 空串等价于清空
    store = state.formats if is_format else state.values
    key = (row_id, col_id)
    incoming = Reg(value=value, version=version, seq=seq, client=client_id)
    current = store.get(key)
    if current is None or current.loses_to(incoming):
        store[key] = incoming


def _apply_replace(state: SheetState, payload: dict, *, seq: int, client_id: str) -> None:
    """整体替换（CSV 导入 / 版本恢复）：重建结构并一次性写入单元格。"""
    rows = _require_int(payload, "rows", 0)
    cols = _require_int(payload, "cols", 0)
    if rows < 0 or cols < 0:
        raise InvalidOperation("行列数不能为负")
    batch = payload.get("client") or client_id
    # 版本恢复（REQ-042）会带上原版本的行列元素 ID：评论、历史操作等锚点不会因此失效。
    # 未提供时（普通导入）按批次生成全新 ID。
    row_ids = payload.get("row_ids")
    col_ids = payload.get("col_ids")
    if row_ids is not None and (not isinstance(row_ids, list) or len(row_ids) != rows):
        raise InvalidOperation("row_ids 与 rows 数量不一致")
    if col_ids is not None and (not isinstance(col_ids, list) or len(col_ids) != cols):
        raise InvalidOperation("col_ids 与 cols 数量不一致")
    state.row_ids = [str(x) for x in row_ids] if row_ids else [element_id(batch, i, "row") for i in range(rows)]
    state.col_ids = [str(x) for x in col_ids] if col_ids else [element_id(batch, i, "col") for i in range(cols)]
    state.values = {}
    state.formats = {}
    version = {client_id: seq}
    cells = payload.get("cells") or {}
    for key, value in cells.items():
        try:
            r, c = parse_cell_key(str(key))
        except (ValueError, InvalidOperation):
            continue
        if not (0 <= r < rows and 0 <= c < cols):
            continue
        if value is None or value == "":
            continue
        state.values[(state.row_ids[r], state.col_ids[c])] = Reg(
            value=str(value), version=dict(version), seq=seq, client=client_id
        )
    formats = payload.get("formats") or {}
    for key, fmt in formats.items():
        try:
            r, c = parse_cell_key(str(key))
        except (ValueError, InvalidOperation):
            continue
        if not (0 <= r < rows and 0 <= c < cols) or fmt is None:
            continue
        state.formats[(state.row_ids[r], state.col_ids[c])] = Reg(
            value=json.dumps(fmt, ensure_ascii=False), version=dict(version), seq=seq, client=client_id
        )


# --------------------------------------------------------------------- 状态加载

#: 结构缓存：行列元素 ID 列表按 sheet 缓存，写操作后失效（避免每次写都全表扫描 structure）。
_STRUCTURE_CACHE: dict = {}


def invalidate_structure_cache(sheet_id: str) -> None:
    _STRUCTURE_CACHE.pop(sheet_id, None)


def load_structure(conn, sheet_id: str) -> tuple:
    cached = _STRUCTURE_CACHE.get(sheet_id)
    if cached is not None:
        # 返回副本：调用方会就地增删行列，不能污染缓存。
        return list(cached[0]), list(cached[1])
    row_ids: list = []
    col_ids: list = []
    for row in conn.execute(
        "SELECT axis, position, element_id FROM structure WHERE sheet_id = ? ORDER BY axis, position",
        (sheet_id,),
    ):
        if row["axis"] == "row":
            row_ids.append(row["element_id"])
        else:
            col_ids.append(row["element_id"])
    row_ids = list(dict.fromkeys(row_ids))
    col_ids = list(dict.fromkeys(col_ids))
    _STRUCTURE_CACHE[sheet_id] = (row_ids, col_ids)
    return row_ids, col_ids


def load_state(conn, sheet_id: str) -> SheetState:
    """从数据库读取结构与单元格，构造当前状态。"""
    sheet = conn.execute("SELECT id, name FROM sheets WHERE id = ?", (sheet_id,)).fetchone()
    if not sheet:
        raise SheetNotFound(sheet_id)
    state = SheetState(sheet_id=sheet_id, name=sheet["name"])
    state.row_ids, state.col_ids = load_structure(conn, sheet_id)
    row_ids, col_ids = state.row_ids, state.col_ids

    for row in conn.execute(
        """
        SELECT row, col, value, format, value_ver, format_ver,
               value_seq, format_seq, value_client, format_client
        FROM cells WHERE sheet_id = ?
        """,
        (sheet_id,),
    ):
        r, c = int(row["row"]), int(row["col"])
        if not (0 <= r < len(state.row_ids) and 0 <= c < len(state.col_ids)):
            continue
        key = (state.row_ids[r], state.col_ids[c])
        if row["value"] is not None or row["value_ver"] is not None:
            state.values[key] = parse_reg(
                row["value"], row["value_ver"], row["value_seq"], row["value_client"]
            )
        if row["format"] is not None or row["format_ver"] is not None:
            state.formats[key] = parse_reg(
                row["format"], row["format_ver"], row["format_seq"], row["format_client"]
            )

    seq_row = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM ops WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    state.seq = int(seq_row["seq"] or 0)
    return state


def state_from_projection(name: str, rows: int, cols: int, cells: dict, formats: dict, batch: str = "snapshot") -> SheetState:
    """由 ``project()`` 的产物反向构造状态（快照恢复用）。"""
    state = SheetState(sheet_id="")
    state.name = name
    state.row_ids = [element_id(batch, i, "row") for i in range(rows)]
    state.col_ids = [element_id(batch, i, "col") for i in range(cols)]
    for key, value in (cells or {}).items():
        try:
            r, c = parse_cell_key(str(key))
        except (ValueError, InvalidOperation):
            continue
        if 0 <= r < rows and 0 <= c < cols and value not in (None, ""):
            state.values[(state.row_ids[r], state.col_ids[c])] = Reg(value=str(value))
    for key, fmt in (formats or {}).items():
        try:
            r, c = parse_cell_key(str(key))
        except (ValueError, InvalidOperation):
            continue
        if 0 <= r < rows and 0 <= c < cols and fmt is not None:
            state.formats[(state.row_ids[r], state.col_ids[c])] = Reg(
                value=json.dumps(fmt, ensure_ascii=False)
            )
    return state


def _safe_int(value) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _decode_legacy_format(raw):
    """解码 v1 单元格样式。

    v1 把样式以 **JSON 字符串** 存进快照（例如 ``'{"align": "right"}'``），而
    ``state_from_projection`` / ``apply_op`` 期望的是对象（内部再做 ``json.dumps``）。
    这里必须解码，否则样式会被二次编码成字符串，前端拿到的是字符串而非样式对象。
    """
    if raw is None:
        return None
    if isinstance(raw, str):
        try:
            decoded = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        return decoded if isinstance(decoded, dict) else None
    return raw if isinstance(raw, dict) else None


def normalize_legacy_snapshot(data) -> Optional[dict]:
    """把历史快照归一化为 ``project()`` 形态的投影 ``{"rows","cols","cells","formats"}``。

    兼容两种真实存在过的存储格式：

    - **v2 快照**（dict）：``{"rows":16,"cols":8,"cells":{"0:0":"a"},"formats":{...}}``
    - **v1 快照**（list）：``[{"row":0,"col":0,"value":"a","format":"{\\"align\\":\\"right\\"}"}, ...]``
      —— 只记录非空单元格，行列数需要由最大下标推导。

    无法识别时返回 ``None``。
    """
    if isinstance(data, dict):
        return {
            "rows": _safe_int(data.get("rows")),
            "cols": _safe_int(data.get("cols")),
            "cells": dict(data.get("cells") or {}),
            "formats": dict(data.get("formats") or {}),
        }
    if not isinstance(data, list):
        return None

    cells: dict = {}
    formats: dict = {}
    max_row = -1
    max_col = -1
    for entry in data:
        if not isinstance(entry, dict):
            continue
        try:
            r = int(entry.get("row", -1))
            c = int(entry.get("col", -1))
        except (TypeError, ValueError):
            continue
        if r < 0 or c < 0:
            continue
        key = cell_key(r, c)
        if r > max_row:
            max_row = r
        if c > max_col:
            max_col = c
        value = entry.get("value")
        if value is not None and value != "":
            cells[key] = value
        fmt = _decode_legacy_format(entry.get("format"))
        if fmt is not None:
            formats[key] = fmt
    # 行列数取最大下标 +1（v1 快照不含行列数）；调用方可再用表格当前尺寸取大者兜底。
    return {"rows": max_row + 1, "cols": max_col + 1, "cells": cells, "formats": formats}


def state_to_ops(state: SheetState, *, seq: int, client_id: str) -> list:
    """把状态编码为一条 ``replace`` + 若干 ``set_cell`` 操作（版本恢复用）。

    返回 ``[(kind, payload, version)]``，由调用方落库并分配真实 ``seq``。
    """
    rows = len(state.row_ids)
    cols = len(state.col_ids)
    projection = state.project()
    ops = [
        (
            OP_REPLACE,
            {
                "rows": rows,
                "cols": cols,
                "cells": projection["cells"],
                "formats": projection["formats"],
                "client": client_id,
            },
            {},
        )
    ]
    return ops
