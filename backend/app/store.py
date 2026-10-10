"""数据访问层：用户、权限、表格、操作日志、版本（diff 化）、快照压缩。

版本模型（v2，diff 化）
-----------------------
- 每个写操作产生一条 **操作记录**（``versions`` 行只保存 ``ops`` 增量 + ``user`` / ``message``），
  不再保存整表 JSON 快照；
- 只有 **压缩点** 才写 ``snapshot``（``OE_VERSION_SNAPSHOT_LIMIT`` 控制保留数量）；
- 操作明细写入 ``ops`` 表并按 ``OE_VERSION_OP_LIMIT`` 截断；
- 任意版本可原地重建（快照 + 增量回放），支持 **版本对比** 与 **恢复/回退**。
"""
from __future__ import annotations

import json
import re
import sqlite3
import uuid
from datetime import datetime, timezone
from typing import Iterable, Optional

from . import config, crdt
from .db import get_conn, write_lock

#: @提及的词法：``@`` 后接字母/数字/下划线/连字符/点，或一段中日韩文字。
#: 中文之间没有空格，用"遇到下一个 @ 或空白即止"的方式切分更贴近使用习惯。
MENTION_PATTERN = re.compile(r"@([A-Za-z0-9_.\-]{1,64}|[^\s@]{1,64})")

# --------------------------------------------------------------------------- 时间


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# --------------------------------------------------------------------------- 用户


def create_user(conn, username: str, password_hash: str) -> int:
    cur = conn.execute(
        "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
        (username, password_hash, now_iso()),
    )
    return int(cur.lastrowid)


def get_user_by_name(conn, username: str) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()


def get_user(conn, user_id: int) -> Optional[sqlite3.Row]:
    return conn.execute("SELECT * FROM users WHERE id = ?", (user_id,)).fetchone()


def list_users(conn) -> list:
    return [dict(r) for r in conn.execute("SELECT id, username, created_at FROM users ORDER BY id")]


# --------------------------------------------------------------------------- 权限


def set_permission(conn, sheet_id: str, user_id: int, role: str) -> None:
    if role not in config.ROLE_LEVEL:
        raise ValueError(f"未知角色: {role}")
    conn.execute(
        """
        INSERT INTO permissions (sheet_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(sheet_id, user_id) DO UPDATE SET role = excluded.role
        """,
        (sheet_id, user_id, role, now_iso()),
    )


def remove_permission(conn, sheet_id: str, user_id: int) -> None:
    conn.execute("DELETE FROM permissions WHERE sheet_id = ? AND user_id = ?", (sheet_id, user_id))


def get_role(conn, sheet_id: str, user_id: Optional[int]) -> Optional[str]:
    if user_id is None:
        return None
    row = conn.execute(
        "SELECT role FROM permissions WHERE sheet_id = ? AND user_id = ?", (sheet_id, user_id)
    ).fetchone()
    if row:
        return row["role"]
    # 兼容历史表格（v1 无权限体系）的兜底：
    # - 表上有任何权限记录 → 未授权用户无权限（None）；
    # - 有 owner 但无权限记录 → 其它用户无权限；
    # - 既无权限记录又无 owner（迁移遗漏）→ 只读 viewer。
    #   先前这里直接返回 "editor"：配合 OE_DEV_AUTO_REGISTER=1，任何能登录的人
    #   都能编辑迁移过来的旧表。改为只读后，旧表只能被显式授权，或被
    #   bootstrap.backfill_legacy_owners 指派 owner。
    legacy = conn.execute(
        "SELECT 1 FROM permissions WHERE sheet_id = ? LIMIT 1", (sheet_id,)
    ).fetchone()
    if legacy:
        return None
    sheet = conn.execute("SELECT owner_id FROM sheets WHERE id = ?", (sheet_id,)).fetchone()
    if not sheet:
        return None
    if sheet["owner_id"] is None:
        return "viewer"
    return None


def list_permissions(conn, sheet_id: str) -> list:
    rows = conn.execute(
        """
        SELECT p.user_id, p.role, u.username
        FROM permissions p LEFT JOIN users u ON u.id = p.user_id
        WHERE p.sheet_id = ? ORDER BY p.user_id
        """,
        (sheet_id,),
    ).fetchall()
    return [dict(r) for r in rows]


# --------------------------------------------------------------------------- 表格


def list_sheets(conn, user_id: Optional[int] = None) -> list:
    rows = conn.execute(
        """
        SELECT s.id, s.name, s.created_at, s.updated_at, s.rows, s.cols, s.owner_id,
               (SELECT role FROM permissions p WHERE p.sheet_id = s.id AND p.user_id = ?) AS role
        FROM sheets s
        ORDER BY s.updated_at DESC
        """,
        (user_id if user_id is not None else -1,),
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        if item["role"] is None and user_id is not None:
            item["role"] = get_role(conn, item["id"], user_id)
        out.append(item)
    return out


def create_sheet(conn, name: str, owner_id: Optional[int], rows: int = 100, cols: int = 20) -> str:
    rows = max(1, min(config.MAX_ROWS, int(rows)))
    cols = max(1, min(config.MAX_COLS, int(cols)))
    sheet_id = uuid.uuid4().hex
    ts = now_iso()
    conn.execute(
        "INSERT INTO sheets (id, name, created_at, updated_at, rows, cols, owner_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (sheet_id, name or "未命名表格", ts, ts, rows, cols, owner_id),
    )
    if owner_id is not None:
        set_permission(conn, sheet_id, owner_id, "owner")
    for i in range(rows):
        conn.execute(
            "INSERT INTO structure (sheet_id, axis, position, element_id) VALUES (?, 'row', ?, ?)",
            (sheet_id, i, f"{sheet_id}:r{i}"),
        )
    for i in range(cols):
        conn.execute(
            "INSERT INTO structure (sheet_id, axis, position, element_id) VALUES (?, 'col', ?, ?)",
            (sheet_id, i, f"{sheet_id}:c{i}"),
        )
    return sheet_id


def sheet_exists(conn, sheet_id: str) -> bool:
    return conn.execute("SELECT 1 FROM sheets WHERE id = ?", (sheet_id,)).fetchone() is not None


def sheet_meta(conn, sheet_id: str) -> Optional[dict]:
    row = conn.execute(
        "SELECT id, name, created_at, updated_at, rows, cols, owner_id FROM sheets WHERE id = ?",
        (sheet_id,),
    ).fetchone()
    return dict(row) if row else None


def rename_sheet(conn, sheet_id: str, name: str) -> None:
    conn.execute(
        "UPDATE sheets SET name = ?, updated_at = ? WHERE id = ?", (name, now_iso(), sheet_id)
    )


# --------------------------------------------------------------- 状态落库与操作应用


def _write_state(conn, state: crdt.SheetState, structure_changed: bool = True) -> None:
    """把状态投影写回派生表。

    ``structure_changed=False`` 时跳过结构重写：单元格写入不影响行列结构，
    而 structure 表在万行规模下重写代价约 0.3~0.6 秒（性能热点）。
    """
    sheet_id = state.sheet_id
    if structure_changed:
        crdt.invalidate_structure_cache(sheet_id)
        conn.execute("DELETE FROM structure WHERE sheet_id = ?", (sheet_id,))
        conn.executemany(
            "INSERT INTO structure (sheet_id, axis, position, element_id) VALUES (?, ?, ?, ?)",
            [(sheet_id, axis, position, element) for axis, position, element in state.structural_elements()],
        )
    conn.execute("DELETE FROM cells WHERE sheet_id = ?", (sheet_id,))
    conn.executemany(
        """
        INSERT INTO cells (sheet_id, row, col, value, format, value_ver, format_ver,
                           value_seq, format_seq, value_client, format_client)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        [
            (
                sheet_id,
                r,
                c,
                value_reg.value if value_reg else None,
                format_reg.value if format_reg else None,
                crdt.dump_version(value_reg.version) if value_reg else None,
                crdt.dump_version(format_reg.version) if format_reg else None,
                value_reg.seq if value_reg else 0,
                format_reg.seq if format_reg else 0,
                value_reg.client if value_reg else "",
                format_reg.client if format_reg else "",
            )
            for r, c, value_reg, format_reg in state.cell_rows()
        ],
    )
    ts = now_iso()
    conn.execute(
        "UPDATE sheets SET rows = ?, cols = ?, updated_at = ? WHERE id = ?",
        (len(state.row_ids), len(state.col_ids), ts, sheet_id),
    )


def _insert_version(
    conn,
    sheet_id: str,
    parent_id: Optional[int],
    seq: int,
    ops: list,
    user: str,
    message: str,
    snapshot: Optional[str] = None,
    base_rows: int = 0,
    base_cols: int = 0,
) -> int:
    cur = conn.execute(
        """
        INSERT INTO versions (sheet_id, parent_id, seq, ops, snapshot, user, message, created_at,
                              base_rows, base_cols)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            sheet_id,
            parent_id,
            seq,
            json.dumps(ops, ensure_ascii=False),
            snapshot,
            user,
            message,
            now_iso(),
            int(base_rows),
            int(base_cols),
        ),
    )
    return int(cur.lastrowid)


def _record_ops(conn, sheet_id: str, client_id: str, items: Iterable[tuple]) -> list:
    """把操作明细写入 ``ops`` 表并返回带真实 ``seq`` 的列表。"""
    recorded = []
    ts = now_iso()
    for kind, payload, version in items:
        blob = json.dumps({"payload": payload, "version": version}, ensure_ascii=False)
        if len(blob) > config.MAX_OP_PAYLOAD_CHARS:
            raise crdt.InvalidOperation("单条操作数据过大，已拒绝（请拆分导入）")
        cur = conn.execute(
            "INSERT INTO ops (sheet_id, client_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)",
            (sheet_id, client_id, kind, blob, ts),
        )
        recorded.append((int(cur.lastrowid), kind, payload, version))
    return recorded


def apply_ops(sheet_id: str, ops: list, user: str, client_id: str = "") -> dict:
    """应用一批操作：写操作日志 → 生成版本（仅增量）→ 刷新派生状态。

    ``ops`` 为 ``[{"kind": ..., "payload": {...}, "version": {...}}]``。
    返回 ``{version, seq, ops, rows, cols, cells, formats}``（后三者是变更后的完整投影，
    调用方可直接广播或回给本端）。
    """
    if not ops:
        raise crdt.InvalidOperation("操作列表为空")
    client_id = client_id or f"anonymous:{uuid.uuid4().hex[:8]}"
    with write_lock:
        conn = get_conn()
        if not sheet_exists(conn, sheet_id):
            raise crdt.SheetNotFound(sheet_id)
        conn.execute("BEGIN")
        try:
            state = crdt.load_state(conn, sheet_id)
            normalized = []
            for item in ops:
                kind = str(item.get("kind") or "")
                payload = dict(item.get("payload") or {})
                version = dict(item.get("version") or {})
                normalized.append((kind, payload, version))

            recorded = _record_ops(conn, sheet_id, client_id, normalized)

            # 按真实 seq 重放，保证与其它副本收敛到同一结果。
            assignments = []
            for seq, kind, payload, version in recorded:
                version = dict(version)
                version[client_id] = seq
                assignments.append((seq, kind, payload, version))
            for seq, kind, payload, version in sorted(assignments, key=lambda x: x[0]):
                crdt.apply_op(state, kind, payload, seq=seq, client_id=client_id, version=version)

            # 只有结构类操作才需要重写 structure 表（万行规模下是主要开销）。
            structure_changed = any(
                kind in crdt.STRUCTURAL_KINDS or kind == crdt.OP_REPLACE for _, kind, _, _ in assignments
            )
            parent = conn.execute(
                "SELECT COALESCE(MAX(id), 0) AS id FROM versions WHERE sheet_id = ?", (sheet_id,)
            ).fetchone()
            last_seq = max((seq for seq, *_ in assignments), default=0)
            version_id = _insert_version(
                conn=conn,
                sheet_id=sheet_id,
                parent_id=int(parent["id"]) or None,
                seq=last_seq,
                ops=[{"kind": k, "payload": p, "version": v} for _, k, p, v in assignments],
                user=user,
                message=", ".join(sorted({k for _, k, _, _ in assignments})),
                base_rows=len(state.row_ids),
                base_cols=len(state.col_ids),
            )
            _write_state(conn, state, structure_changed=structure_changed)
            conn.commit()
        except Exception:
            conn.rollback()
            raise
    _compact_ops(sheet_id)
    projection = state.project()
    return {
        "version": version_id,
        "seq": state.seq,
        "rowIds": state.row_ids,
        "colIds": state.col_ids,
        "opKinds": [kind for _, kind, _, _ in assignments],
        **projection,
    }


def replace_sheet(
    sheet_id: str,
    rows: int,
    cols: int,
    cells: dict,
    user: str,
    client_id: str = "",
    formats: Optional[dict] = None,
    row_ids: Optional[list] = None,
    col_ids: Optional[list] = None,
) -> dict:
    """整体替换（CSV 导入 / 版本恢复）→ 一条 ``replace`` 操作 + 一个版本。

    版本恢复（REQ-042）可传入 ``row_ids``/``col_ids`` 保留原元素 ID，
    避免评论等按元素 ID 锚定的数据失效。
    """
    if not (1 <= int(rows) <= config.MAX_ROWS and 1 <= int(cols) <= config.MAX_COLS):
        raise crdt.InvalidOperation(f"行列数超限：rows≤{config.MAX_ROWS}, cols≤{config.MAX_COLS}")
    payload = {
        "rows": int(rows),
        "cols": int(cols),
        "cells": cells or {},
        "formats": formats or {},
        "client": client_id or "import",
    }
    if row_ids is not None:
        payload["row_ids"] = row_ids
    if col_ids is not None:
        payload["col_ids"] = col_ids
    return apply_ops(sheet_id, [{"kind": crdt.OP_REPLACE, "payload": payload, "version": {}}], user, client_id)


def _compact_ops(sheet_id: str) -> None:
    """操作日志截断：保留快照点之后仍在使用的最近 N 条。"""
    limit = config.VERSION_OP_LIMIT
    if limit <= 0:
        return
    with write_lock:
        conn = get_conn()
        rows = conn.execute(
            "SELECT COUNT(*) AS n FROM ops WHERE sheet_id = ?", (sheet_id,)
        ).fetchone()
        if int(rows["n"] or 0) <= limit:
            return
        cutoff = conn.execute(
            "SELECT seq FROM ops WHERE sheet_id = ? ORDER BY seq DESC LIMIT 1 OFFSET ?",
            (sheet_id, limit),
        ).fetchone()
        if cutoff:
            conn.execute("DELETE FROM ops WHERE sheet_id = ? AND seq < ?", (sheet_id, cutoff["seq"]))
            conn.commit()


# --------------------------------------------------------------------------- 版本


def _version_row(conn, version_id: int):
    return conn.execute("SELECT * FROM versions WHERE id = ?", (version_id,)).fetchone()


def list_versions(conn, sheet_id: str, limit: int = 100) -> list:
    rows = conn.execute(
        """
        SELECT id, parent_id, seq, user, message, created_at, ops,
               LENGTH(ops) AS ops_bytes,
               LENGTH(COALESCE(snapshot, '')) AS snapshot_bytes,
               (snapshot IS NOT NULL) AS is_snapshot
        FROM versions WHERE sheet_id = ? ORDER BY id DESC LIMIT ?
        """,
        (sheet_id, limit),
    ).fetchall()
    out = []
    for row in rows:
        item = dict(row)
        try:
            item["ops_count"] = len(json.loads(row["ops"] or "[]"))
        except (json.JSONDecodeError, TypeError):
            item["ops_count"] = 0
        item["is_snapshot"] = bool(item["is_snapshot"])
        out.append(item)
    return out


def load_ops(conn, sheet_id: str, since_seq: int = 0) -> list:
    rows = conn.execute(
        "SELECT seq, client_id, kind, payload FROM ops WHERE sheet_id = ? AND seq > ? ORDER BY seq",
        (sheet_id, since_seq),
    ).fetchall()
    out = []
    for row in rows:
        try:
            blob = json.loads(row["payload"])
        except (json.JSONDecodeError, TypeError):
            continue
        out.append(
            {
                "seq": int(row["seq"]),
                "client_id": row["client_id"],
                "kind": row["kind"],
                "payload": blob.get("payload") or {},
                "version": blob.get("version") or {},
            }
        )
    return out


def materialize_version(conn, sheet_id: str, version_id: int) -> crdt.SheetState:
    """重建任意历史版本的状态：最近快照 + 其后增量回放。"""
    target = _version_row(conn, version_id)
    if not target or target["sheet_id"] != sheet_id:
        raise crdt.InvalidOperation("版本不存在")

    base = conn.execute(
        """
        SELECT id, snapshot FROM versions
        WHERE sheet_id = ? AND snapshot IS NOT NULL AND id <= ?
        ORDER BY id DESC LIMIT 1
        """,
        (sheet_id, version_id),
    ).fetchone()

    if base:
        try:
            data = json.loads(base["snapshot"])
        except (json.JSONDecodeError, TypeError):
            data = {}
        # 快照可能是 v1 的逐格列表（迁移前遗留 / 迁移失败的库）：归一化后再用，
        # 否则 data.get 会抛 AttributeError，把版本详情/对比/恢复整个打成 500。
        projection = crdt.normalize_legacy_snapshot(data) or {
            "rows": 0,
            "cols": 0,
            "cells": {},
            "formats": {},
        }
        state = crdt.state_from_projection(
            name="",
            rows=projection["rows"],
            cols=projection["cols"],
            cells=projection["cells"],
            formats=projection["formats"],
            batch=sheet_id,
        )
        state.sheet_id = sheet_id
        op_rows = conn.execute(
            "SELECT seq, ops, base_rows, base_cols FROM versions WHERE sheet_id = ? AND id > ? AND id <= ? ORDER BY id",
            (sheet_id, base["id"], version_id),
        ).fetchall()
    else:
        # 没有快照：从空表开始回放全部版本（每个版本自带结构基线）。
        state = crdt.SheetState(sheet_id=sheet_id)
        op_rows = conn.execute(
            "SELECT seq, ops, base_rows, base_cols FROM versions WHERE sheet_id = ? AND id <= ? ORDER BY id",
            (sheet_id, version_id),
        ).fetchall()

    for row in op_rows:
        # 每个版本都按自己的结构基线对齐：base_rows/cols 与当前结构不一致时就重建，
        # 否则该版本里的单元格操作会因找不到行列而整体丢失（曾导致历史版本内容为空）。
        _apply_version_row(state, row, apply_base=True)
    return state


def _apply_version_row(state: crdt.SheetState, row, apply_base: bool = True) -> None:
    """把一个版本的增量操作应用到状态上。

    ``apply_base=True`` 且该版本的结构基线与当前结构不一致时，先按基线重建行列
    （恢复"该操作发生前"的结构），随后回放增量。
    """
    rows = int(row["base_rows"] or 0)
    cols = int(row["base_cols"] or 0)
    seq = int(row["seq"] or 0)
    structure_differs = rows and (rows != len(state.row_ids) or cols != len(state.col_ids))
    if apply_base and structure_differs:
        crdt.apply_op(
            state,
            crdt.OP_REPLACE,
            {
                "rows": rows,
                "cols": cols,
                "cells": {},
                "formats": {},
                # 结构基线必须与创表时的元素 ID 方案一致（{sheet_id}:r{i}），
                # 否则版本内的单元格操作会找不到对应行列。
                "client": state.sheet_id,
            },
            seq=seq,
            client_id=state.sheet_id,
        )
    try:
        items = json.loads(row["ops"] or "[]")
    except (json.JSONDecodeError, TypeError):
        items = []
    for item in items:
        kind = item.get("kind") or ""
        payload = item.get("payload") or {}
        version = dict(item.get("version") or {})
        client = payload.get("client") or "history"
        version.setdefault(client, seq)
        try:
            crdt.apply_op(state, kind, payload, seq=seq, client_id=client, version=version)
        except crdt.InvalidOperation:
            # 历史日志可能缺少它当时依赖的结构信息（例如早期的整体替换未入日志），
            # 这类操作直接跳过：宁可少还原一个历史单元格，也不要让整个历史不可读。
            continue


def diff_versions(conn, sheet_id: str, from_id: int, to_id: int, limit: int = 2000) -> dict:
    """版本 diff（``from`` → ``to``）：单元格级 added / removed / changed + 结构变化。"""
    left = materialize_version(conn, sheet_id, from_id).project()
    right = materialize_version(conn, sheet_id, to_id).project()
    lcells, rcells = left["cells"], right["cells"]
    lfmt, rfmt = left["formats"], right["formats"]

    added, removed, changed = [], [], []
    for key, value in rcells.items():
        if key not in lcells:
            added.append({"cell": key, "value": value})
        elif lcells[key] != value:
            changed.append({"cell": key, "from": lcells[key], "to": value})
    for key, value in lcells.items():
        if key not in rcells:
            removed.append({"cell": key, "value": value})

    fmt_added, fmt_removed, fmt_changed = [], [], []
    for key, value in rfmt.items():
        if key not in lfmt:
            fmt_added.append({"cell": key, "format": value})
        elif lfmt[key] != value:
            fmt_changed.append({"cell": key, "from": lfmt[key], "to": value})
    for key, value in lfmt.items():
        if key not in rfmt:
            fmt_removed.append({"cell": key, "format": value})

    def _capped(items: list) -> dict:
        return {"items": items[:limit], "truncated": len(items) > limit, "total": len(items)}

    return {
        "from": {"version": from_id, "rows": left["rows"], "cols": left["cols"]},
        "to": {"version": to_id, "rows": right["rows"], "cols": right["cols"]},
        "structure": {
            "rows": right["rows"] - left["rows"],
            "cols": right["cols"] - left["cols"],
        },
        "cells": {
            "added": _capped(added),
            "removed": _capped(removed),
            "changed": _capped(changed),
        },
        "formats": {
            "added": _capped(fmt_added),
            "removed": _capped(fmt_removed),
            "changed": _capped(fmt_changed),
        },
        "summary": {
            "added": len(added),
            "removed": len(removed),
            "changed": len(changed),
            "formats": len(fmt_added) + len(fmt_removed) + len(fmt_changed),
        },
    }


def compact_versions(conn, sheet_id: str) -> dict:
    """压缩版本历史：只保留最近 N 个快照，其余转为纯增量。"""
    limit = max(1, config.VERSION_SNAPSHOT_LIMIT)
    snapshots = conn.execute(
        "SELECT id FROM versions WHERE sheet_id = ? AND snapshot IS NOT NULL ORDER BY id DESC",
        (sheet_id,),
    ).fetchall()
    dropped = 0
    for row in snapshots[limit:]:
        conn.execute("UPDATE versions SET snapshot = NULL WHERE id = ?", (row["id"],))
        dropped += 1
    return {"snapshots_kept": min(len(snapshots), limit), "snapshots_dropped": dropped}


def create_snapshot(conn, sheet_id: str, state: Optional[crdt.SheetState] = None) -> int:
    """显式写入一个压缩点快照，并让它成为后续 diff 的基线。"""
    state = state or crdt.load_state(conn, sheet_id)
    projection = state.project()
    snapshot = json.dumps(projection, ensure_ascii=False)
    parent = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS id FROM versions WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    return _insert_version(
        conn,
        sheet_id,
        parent_id=int(parent["id"]) or None,
        seq=state.seq,
        ops=[],
        user="system",
        message="snapshot",
        snapshot=snapshot,
        base_rows=len(state.row_ids),
        base_cols=len(state.col_ids),
    )


def sheet_payload(conn, sheet_id: str, role: Optional[str] = None) -> dict:
    """前端所需的完整表格数据（含行列结构 ID，便于后续按 ID 操作）。"""
    state = crdt.load_state(conn, sheet_id)
    projection = state.project()
    meta = sheet_meta(conn, sheet_id) or {}
    version_row = conn.execute(
        "SELECT COALESCE(MAX(id), 0) AS id FROM versions WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    return {
        "id": sheet_id,
        "name": meta.get("name", state.name),
        "rows": projection["rows"],
        "cols": projection["cols"],
        "cells": projection["cells"],
        "formats": projection["formats"],
        "version": int(version_row["id"] or 0),
        "seq": state.seq,
        "rowIds": state.row_ids,
        "colIds": state.col_ids,
        "role": role,
    }


# --------------------------------------------------------------------------- 评论


def parse_mentions(body: str, known_users: Optional[Iterable[str]] = None) -> list:
    """从评论正文解析 ``@用户名``。

    传 ``known_users`` 时只保留确实存在的用户名（避免把邮箱、@某人 的笔误算成提醒）。
    返回去重后的用户名列表，保持出现顺序。
    """
    found: list = []
    known = set(known_users) if known_users is not None else None
    for match in MENTION_PATTERN.finditer(body or ""):
        name = match.group(1)
        if known is not None and name not in known:
            continue
        if name and name not in found:
            found.append(name)
    return found


def add_comment(
    conn,
    sheet_id: str,
    row_id: str,
    col_id: str,
    body: str,
    author_id: Optional[int],
    author: str,
    mentions: Optional[list] = None,
) -> dict:
    mentions_json = json.dumps(mentions or [], ensure_ascii=False)
    cur = conn.execute(
        """
        INSERT INTO comments (sheet_id, row_id, col_id, author_id, author, body, mentions, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (sheet_id, row_id, col_id, author_id, author, body, mentions_json, now_iso()),
    )
    return get_comment(conn, int(cur.lastrowid)) or {}


def get_comment(conn, comment_id: int) -> Optional[dict]:
    row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
    return _comment_row(row) if row else None


def _comment_row(row) -> dict:
    try:
        mentions = json.loads(row["mentions"] or "[]")
    except (json.JSONDecodeError, TypeError):
        mentions = []
    return {
        "id": int(row["id"]),
        "sheet_id": row["sheet_id"],
        "row_id": row["row_id"],
        "col_id": row["col_id"],
        "author_id": row["author_id"],
        "author": row["author"],
        "body": row["body"],
        "mentions": mentions,
        "resolved": bool(row["resolved"]),
        "created_at": row["created_at"],
    }


def list_comments(conn, sheet_id: str, include_resolved: bool = True, limit: int = 500) -> list:
    sql = "SELECT * FROM comments WHERE sheet_id = ?"
    if not include_resolved:
        sql += " AND resolved = 0"
    sql += " ORDER BY id LIMIT ?"
    return [_comment_row(r) for r in conn.execute(sql, (sheet_id, limit))]


def resolve_comment(conn, sheet_id: str, comment_id: int, resolved: bool = True) -> Optional[dict]:
    conn.execute(
        "UPDATE comments SET resolved = ? WHERE id = ? AND sheet_id = ?",
        (1 if resolved else 0, comment_id, sheet_id),
    )
    return get_comment(conn, comment_id)


def delete_comment(conn, sheet_id: str, comment_id: int) -> Optional[dict]:
    row = get_comment(conn, comment_id)
    if not row or row["sheet_id"] != sheet_id:
        return None
    conn.execute("DELETE FROM comments WHERE id = ? AND sheet_id = ?", (comment_id, sheet_id))
    return row


def comment_counts(conn, sheet_id: str) -> dict:
    """每个单元格的未解决评论数（供前端画角标）。键为 ``row_id:col_id``。"""
    rows = conn.execute(
        """
        SELECT row_id, col_id, COUNT(*) AS n FROM comments
        WHERE sheet_id = ? AND resolved = 0
        GROUP BY row_id, col_id
        """,
        (sheet_id,),
    ).fetchall()
    return {f"{r['row_id']}:{r['col_id']}": int(r["n"]) for r in rows}


def sheet_members(conn, sheet_id: str) -> list:
    """可被 @提及 的成员（viewer 及以上，按用户名排序）。"""
    rows = conn.execute(
        """
        SELECT DISTINCT u.username, p.role FROM permissions p
        JOIN users u ON u.id = p.user_id
        WHERE p.sheet_id = ?
        ORDER BY u.username
        """,
        (sheet_id,),
    ).fetchall()
    return [
        {"username": r["username"], "role": r["role"]}
        for r in rows
        if config.ROLE_LEVEL.get(r["role"], 0) >= config.ROLE_LEVEL["viewer"]
    ]


#: 与表格相关的所有表（删除表格时逐一清理，避免留下孤儿数据）。
_SHEET_TABLES = ("permissions", "cells", "structure", "versions", "ops", "comments")


def delete_sheet(conn, sheet_id: str) -> bool:
    """删除表格及其全部派生数据（仅所有者可操作，路由层负责鉴权）。"""
    row = conn.execute("SELECT id FROM sheets WHERE id = ?", (sheet_id,)).fetchone()
    if not row:
        return False
    for table in _SHEET_TABLES:
        conn.execute(f"DELETE FROM {table} WHERE sheet_id = ?", (sheet_id,))
    conn.execute("DELETE FROM sheets WHERE id = ?", (sheet_id,))
    crdt.invalidate_structure_cache(sheet_id)
    return True
