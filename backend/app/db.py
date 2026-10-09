"""SQLite 数据层：连接、建表、迁移与快照工具。"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).resolve().parent.parent / "data.db"

_SCHEMA = """
CREATE TABLE IF NOT EXISTS sheets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    rows INTEGER NOT NULL DEFAULT 100,
    cols INTEGER NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS cells (
    sheet_id TEXT NOT NULL,
    row INTEGER NOT NULL,
    col INTEGER NOT NULL,
    value TEXT,
    format TEXT,
    PRIMARY KEY (sheet_id, row, col)
);
CREATE TABLE IF NOT EXISTS versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sheet_id TEXT NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    sheet_cols = [r["name"] for r in conn.execute("PRAGMA table_info(sheets)")]
    if "rows" not in sheet_cols:
        conn.execute("ALTER TABLE sheets ADD COLUMN rows INTEGER NOT NULL DEFAULT 100")
    if "cols" not in sheet_cols:
        conn.execute("ALTER TABLE sheets ADD COLUMN cols INTEGER NOT NULL DEFAULT 20")

    cell_cols = [r["name"] for r in conn.execute("PRAGMA table_info(cells)")]
    if "format" not in cell_cols:
        conn.execute("ALTER TABLE cells ADD COLUMN format TEXT")


def init_db() -> None:
    conn = get_conn()
    try:
        conn.executescript(_SCHEMA)
        _migrate(conn)
        conn.commit()
    finally:
        conn.close()
