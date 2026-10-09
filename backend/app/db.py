"""SQLite 数据层：连接、建表与轻量迁移。

设计要点
--------
- 每个请求使用独立连接（WAL + busy_timeout），并发写由 ``locks.write_lock`` 串行化；
- ``schema_meta`` 记录 schema 版本，迁移幂等且可重复执行；
- 所有派生状态（``cells``）都能由 ``versions``/``ops`` 重新推导，便于崩溃后自愈。
"""
from __future__ import annotations

import sqlite3
import threading
from typing import Optional

from . import config

_local = threading.local()
_write_lock = threading.RLock()
SCHEMA_VERSION = 2

_SCHEMA = """
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rows INTEGER NOT NULL DEFAULT 100,
    cols INTEGER NOT NULL DEFAULT 20,
    owner_id INTEGER
);

CREATE TABLE IF NOT EXISTS permissions (
    sheet_id TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (sheet_id, user_id)
);

CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id TEXT NOT NULL,
    parent_id INTEGER,
    seq INTEGER NOT NULL DEFAULT 0,
    ops TEXT NOT NULL DEFAULT '[]',
    snapshot TEXT,
    user TEXT NOT NULL DEFAULT 'anonymous',
    message TEXT NOT NULL DEFAULT '',
    base_rows INTEGER NOT NULL DEFAULT 0,
    base_cols INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_sheet ON versions (sheet_id, id);

CREATE TABLE IF NOT EXISTS ops (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ops_sheet ON ops (sheet_id, seq);

CREATE TABLE IF NOT EXISTS cells (
    sheet_id TEXT NOT NULL,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    value TEXT,
    format TEXT,
    value_ver TEXT,
    format_ver TEXT,
    value_seq INTEGER NOT NULL DEFAULT 0,
    format_seq INTEGER NOT NULL DEFAULT 0,
    value_client TEXT NOT NULL DEFAULT '',
    format_client TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (sheet_id, row, col)
);

CREATE TABLE IF NOT EXISTS structure (
    sheet_id TEXT NOT NULL,
    axis TEXT NOT NULL,
    position INTEGER NOT NULL,
    element_id TEXT NOT NULL,
    PRIMARY KEY (sheet_id, axis, position)
);
"""


class _WriteLock:
    """全局写锁：SQLite 单写者模型下的最简串行化手段。"""

    def __enter__(self) -> "_WriteLock":
        _write_lock.acquire()
        return self

    def __exit__(self, *exc: object) -> None:
        _write_lock.release()
        return None


write_lock = _WriteLock()


def db_target() -> str:
    return str(config.db_path())


def get_conn() -> sqlite3.Connection:
    """返回当前线程的连接（内存库常驻复用，文件库复用同一连接）。"""
    conn: Optional[sqlite3.Connection] = getattr(_local, "conn", None)
    if conn is not None and getattr(_local, "target", None) == db_target():
        return conn
    if conn is not None:
        conn.close()
    target = db_target()
    conn = sqlite3.connect(target, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    if target != ":memory:":
        conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA busy_timeout=5000")
    _local.conn = conn
    _local.target = target
    return conn


def reset_connections() -> None:
    """测试用：丢弃当前线程缓存的连接。"""
    conn: Optional[sqlite3.Connection] = getattr(_local, "conn", None)
    if conn is not None:
        conn.close()
    _local.conn = None
    _local.target = None


def _columns(conn: sqlite3.Connection, table: str) -> set:
    try:
        return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    except sqlite3.DatabaseError:
        return set()


def _migrate(conn: sqlite3.Connection) -> None:
    """把 v1（全表快照）结构平滑升级到 v2（操作日志 + 增量）。"""
    sheet_cols = _columns(conn, "sheets")
    if sheet_cols and "owner_id" not in sheet_cols:
        conn.execute("ALTER TABLE sheets ADD COLUMN owner_id INTEGER")

    version_cols = _columns(conn, "versions")
    if version_cols:
        # v1 的 snapshot 是 NOT NULL，无法承载 diff 化后的可空快照 → 原地重建表。
        ddl = conn.execute(
            "SELECT sql FROM sqlite_master WHERE type='table' AND name='versions'"
        ).fetchone()
        if ddl and "snapshot" in (ddl["sql"] or "") and "NOT NULL" in (ddl["sql"] or ""):
            conn.execute("ALTER TABLE versions RENAME TO versions_v1")
            conn.execute(
                """
                CREATE TABLE versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    sheet_id TEXT NOT NULL,
                    parent_id INTEGER,
                    seq INTEGER NOT NULL DEFAULT 0,
                    ops TEXT NOT NULL DEFAULT '[]',
                    snapshot TEXT,
                    user TEXT NOT NULL DEFAULT 'anonymous',
                    message TEXT NOT NULL DEFAULT '',
                    base_rows INTEGER NOT NULL DEFAULT 0,
                    base_cols INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                INSERT INTO versions (id, sheet_id, seq, ops, snapshot, created_at)
                SELECT id, sheet_id, 0, '[]', snapshot, created_at FROM versions_v1
                """
            )
            conn.execute("DROP TABLE versions_v1")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_versions_sheet ON versions (sheet_id, id)")
            version_cols = _columns(conn, "versions")

    if version_cols:
        additions = {
            "parent_id": "INTEGER",
            "seq": "INTEGER NOT NULL DEFAULT 0",
            "ops": "TEXT NOT NULL DEFAULT '[]'",
            "user": "TEXT NOT NULL DEFAULT 'anonymous'",
            "message": "TEXT NOT NULL DEFAULT ''",
            "base_rows": "INTEGER NOT NULL DEFAULT 0",
            "base_cols": "INTEGER NOT NULL DEFAULT 0",
        }
        for name, ddl in additions.items():
            if name not in version_cols:
                conn.execute(f"ALTER TABLE versions ADD COLUMN {name} {ddl}")
        conn.execute("UPDATE versions SET ops = '[]' WHERE ops IS NULL")

    cell_cols = _columns(conn, "cells")
    if cell_cols:
        additions = {
            "value_ver": "TEXT",
            "format_ver": "TEXT",
            "value_seq": "INTEGER NOT NULL DEFAULT 0",
            "format_seq": "INTEGER NOT NULL DEFAULT 0",
            "value_client": "TEXT NOT NULL DEFAULT ''",
            "format_client": "TEXT NOT NULL DEFAULT ''",
        }
        for name, ddl in additions.items():
            if name not in cell_cols:
                conn.execute(f"ALTER TABLE cells ADD COLUMN {name} {ddl}")

    # structure 是纯派生缓存：结构不符时直接丢弃重建（由 _seed_structure 重填）。
    structure_cols = _columns(conn, "structure")
    if structure_cols and "element_id" not in structure_cols:  # pragma: no cover
        conn.execute("DROP TABLE structure")
        conn.execute(
            """
            CREATE TABLE structure (
                sheet_id TEXT NOT NULL,
                axis TEXT NOT NULL,
                position INTEGER NOT NULL,
                element_id TEXT NOT NULL,
                PRIMARY KEY (sheet_id, axis, position)
            )
            """
        )


def _seed_structure(conn: sqlite3.Connection) -> None:
    """为历史表格补建行列结构。

    历史版本（v1）只有行列计数，没有稳定元素 ID。这里按确定性规则补建：
    第 i 行 ID 为 ``{sheet}:r{i}``、第 i 列 ID 为 ``{sheet}:c{i}``。
    由于结构是派生缓存且 v1 的坐标就是索引，重建即可，无需搬移 ``cells``。
    """
    rows = conn.execute("SELECT id, rows, cols FROM sheets").fetchall()
    for row in rows:
        sheet_id = row["id"]
        has = conn.execute(
            "SELECT 1 FROM structure WHERE sheet_id = ? LIMIT 1", (sheet_id,)
        ).fetchone()
        if has:
            continue
        for i in range(int(row["rows"] or 0)):
            conn.execute(
                "INSERT OR IGNORE INTO structure (sheet_id, axis, position, element_id) VALUES (?, 'row', ?, ?)",
                (sheet_id, i, f"{sheet_id}:r{i}"),
            )
        for i in range(int(row["cols"] or 0)):
            conn.execute(
                "INSERT OR IGNORE INTO structure (sheet_id, axis, position, element_id) VALUES (?, 'col', ?, ?)",
                (sheet_id, i, f"{sheet_id}:c{i}"),
            )


def init_db() -> None:
    conn = get_conn()
    with write_lock:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        _seed_structure(conn)
        conn.execute(
            "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (str(SCHEMA_VERSION),),
        )
        conn.commit()


def table_names(conn: Optional[sqlite3.Connection] = None) -> list:
    c = conn or get_conn()
    return [r["name"] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")]
