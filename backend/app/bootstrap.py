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
    """把 v1 的整表快照转换为 v2 的 ``replace`` 增量操作。

    v1 实际写入的快照是**逐格列表**（``[{"row","col","value","format"}]``，样式为 JSON
    字符串），早先的实现只识别 dict 形态，导致真实旧库一条都迁移不了，历史版本读取时
    还会因 ``data.get`` 作用在 list 上而 500。这里统一走
    :func:`crdt.normalize_legacy_snapshot` 兼容两种格式。
    """
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
        projection = crdt.normalize_legacy_snapshot(data)
        if projection is None:
            continue
        # v1 快照不含行列数：以表格当前尺寸兜底，避免网格比历史版本更小而被截断。
        sheet = conn.execute(
            "SELECT rows, cols FROM sheets WHERE id = ?", (row["sheet_id"],)
        ).fetchone()
        rows_count = max(projection["rows"], int(sheet["rows"] or 0) if sheet else 0)
        cols_count = max(projection["cols"], int(sheet["cols"] or 0) if sheet else 0)
        payload = {
            "rows": rows_count,
            "cols": cols_count,
            "cells": projection["cells"],
            "formats": projection["formats"],
            "client": f"legacy:{row['id']}",
        }
        ops = [{"kind": crdt.OP_REPLACE, "payload": payload, "version": {}}]
        conn.execute(
            "UPDATE versions SET ops = ?, snapshot = NULL, base_rows = ?, base_cols = ? WHERE id = ?",
            (
                json.dumps(ops, ensure_ascii=False),
                rows_count,
                cols_count,
                row["id"],
            ),
        )
        migrated += 1
    return {"legacy_versions_migrated": migrated}


def backfill_legacy_owners(conn) -> dict:
    """为迁移来的历史表格补 owner（连同 owner 权限行）。

    背景：v1 无权限体系，``_migrate`` 只给 ``sheets`` 加了 ``owner_id`` 列而未赋值。
    此前 ``store.get_role`` 对"无权限记录 + 无 owner"的表格兜底为 ``editor``，
    配合 ``OE_DEV_AUTO_REGISTER=1``，任何能登录的人都能编辑旧表，且无人能管理/删除。
    这里把这类表指认给初始管理员：表从此有管理者（可授权、可删除），
    其余用户在获得显式授权前不再自动可见/可编辑。幂等：已有 owner 的表不动。
    """
    adopted = 0
    username = os.environ.get("OE_ADMIN_USER", "admin")
    admin = conn.execute(
        "SELECT id FROM users WHERE username = ? ORDER BY id LIMIT 1", (username,)
    ).fetchone()
    if not admin:
        return {"legacy_sheets_adopted": 0}
    legacy_sheets = conn.execute(
        "SELECT id FROM sheets WHERE owner_id IS NULL ORDER BY id"
    ).fetchall()
    for sheet in legacy_sheets:
        sheet_id = sheet["id"]
        conn.execute("UPDATE sheets SET owner_id = ? WHERE id = ?", (admin["id"], sheet_id))
        store.set_permission(conn, sheet_id, admin["id"], "owner")
        adopted += 1
    if adopted:
        logger.warning(
            "已将 %d 张无所有者的历史表格指派给 %s（owner），此后未经授权的用户不再可编辑。",
            adopted,
            username,
        )
    return {"legacy_sheets_adopted": adopted}


def bootstrap() -> dict:
    """应用启动时的完整引导流程。"""
    init_db()
    conn = get_conn()
    with write_lock:
        password = ensure_admin(conn)
        migration = migrate_legacy_versions(conn)
        adoption = backfill_legacy_owners(conn)
        conn.commit()
    info = {
        "admin_username": os.environ.get("OE_ADMIN_USER", "admin"),
        "generated_admin_password": password,
        **migration,
        **adoption,
    }
    return info


def reset_for_tests(db_target: str) -> None:
    """测试辅助：指向临时库并重建结构。"""
    os.environ["OE_DB_PATH"] = db_target
    from . import db as _db

    _db.reset_connections()
    init_db()
