"""启动引导：初始化数据库、创建管理员、迁移历史全表快照。

迁移策略（v1 → v2）
-------------------
v1 的 ``versions`` 只有整表 JSON 快照。这里把它们转换成一个 ``replace`` 操作，
使历史版本仍然可以被重建、对比与恢复，但之后不再产生新的全表快照。
"""
from __future__ import annotations

import json
import logging
import os
from typing import Optional

from . import auth, config, crdt, store
from .db import get_conn, init_db, write_lock

logger = logging.getLogger("online_excel.bootstrap")


def seed_user(conn, username: str, password: str, role: Optional[str] = None) -> int:
    user_id = store.create_user(conn, username, auth.hash_password(password))
    return user_id


def ensure_admin(conn) -> Optional[str]:
    """确保存在初始管理员；返回自动生成的初始口令（若有）。"""
    username = os.environ.get("OE_ADMIN_USER", "admin")
    existing = store.get_user_by_name(conn, username)
    if existing:
        return None
    password = config.bootstrap_admin_password()
    user_id = seed_user(conn, username, password)
    conn.execute("UPDATE users SET id = id WHERE id = ?", (user_id,))
    logger.warning(
        "已创建初始管理员 %s，口令：%s —— 请立即通过环境变量 OE_ADMIN_PASSWORD 固定口令。",
        username,
        password,
    )
    return password


def migrate_legacy_versions(conn) -> dict:
    """把 v1 的整表快照转换为 v2 的 ``replace`` 增量操作。"""
    rows = conn.execute(
        """
        SELECT id, sheet_id, snapshot, user, ops FROM versions
        WHERE snapshot IS NOT NULL AND (ops IS NULL OR ops = '[]')
        ORDER BY id
        """
    ).fetchall()
    migrated = 0
    for row in rows:
        try:
            data = json.loads(row["snapshot"])
        except (json.JSONDecodeError, TypeError):
            continue
        if not isinstance(data, dict):
            continue
        cells = {str(k): v for k, v in (data.get("cells") or {}).items()}
        payload = {
            "rows": int(data.get("rows") or 0),
            "cols": int(data.get("cols") or 0),
            "cells": cells,
            "formats": data.get("formats") or {},
            "client": f"legacy:{row['id']}",
        }
        ops = [{"kind": crdt.OP_REPLACE, "payload": payload, "version": {}}]
        conn.execute(
            "UPDATE versions SET ops = ?, snapshot = NULL, base_rows = ?, base_cols = ? WHERE id = ?",
            (
                json.dumps(ops, ensure_ascii=False),
                int(data.get("rows") or 0),
                int(data.get("cols") or 0),
                row["id"],
            ),
        )
        migrated += 1
    return {"legacy_versions_migrated": migrated}


def bootstrap() -> dict:
    """应用启动时的完整引导流程。"""
    init_db()
    conn = get_conn()
    with write_lock:
        password = ensure_admin(conn)
        migration = migrate_legacy_versions(conn)
        conn.commit()
    info = {
        "admin_username": os.environ.get("OE_ADMIN_USER", "admin"),
        "generated_admin_password": password,
        **migration,
    }
    return info


def reset_for_tests(db_target: str) -> None:
    """测试辅助：指向临时库并重建结构。"""
    os.environ["OE_DB_PATH"] = db_target
    from . import db as _db

    _db.reset_connections()
    init_db()
