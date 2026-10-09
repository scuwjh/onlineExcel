"""版本 diff 化（① 的验收测试）：无全表快照、可对比、可恢复、可回退、可压缩。"""
from __future__ import annotations

import json

from app import config
from app.db import get_conn


def set_cells(client, headers, sheet_id, pairs):
    updates = [{"row": r, "col": c, "value": v} for r, c, v in pairs]
    response = client.put(f"/api/sheets/{sheet_id}/cells", json={"updates": updates}, headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def versions(client, headers, sheet_id):
    return client.get(f"/api/sheets/{sheet_id}/versions", headers=headers).json()["data"]


def sql(query: str, params: tuple = ()):
    """直接读派生表，用于断言存储形态。"""
    return get_conn().execute(f"SELECT {query}", params).fetchall()


def test_writes_store_only_deltas(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=20, cols=10)
    set_cells(client, admin_headers, sheet_id, [(r, c, f"v{r}-{c}") for r in range(20) for c in range(10)])

    rows = sql("id, seq, ops, snapshot, message FROM versions")
    assert rows, "应当产生版本记录"
    for row in rows:
        ops = json.loads(row["ops"])
        assert ops, f"版本 {row['id']} 缺少增量操作"
    assert sum(1 for row in rows if row["snapshot"] is not None) <= config.VERSION_SNAPSHOT_LIMIT

    set_cells(client, admin_headers, sheet_id, [(0, 0, "tiny")])
    last = sql("ops, LENGTH(ops) AS size, snapshot FROM versions ORDER BY id DESC")[0]
    assert last["snapshot"] is None
    assert last["size"] < 400, f"单格更新的增量应很小，实际 {last['size']} 字节"


def test_version_diff_reports_cell_level_changes(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=5, cols=5)
    set_cells(client, admin_headers, sheet_id, [(0, 0, "1"), (1, 1, "2")])
    base_version = versions(client, admin_headers, sheet_id)[0]["id"]
    set_cells(client, admin_headers, sheet_id, [(0, 0, "9"), (2, 2, "new")])

    response = client.get(
        f"/api/sheets/{sheet_id}/versions/{base_version}/diff", headers=admin_headers
    )
    assert response.status_code == 200, response.text
    diff = response.json()["data"]
    assert diff["summary"]["added"] == 1
    assert diff["summary"]["changed"] == 1
    assert diff["summary"]["removed"] == 0
    assert {"cell": "2:2", "value": "new"} in diff["cells"]["added"]["items"]
    assert {"cell": "0:0", "from": "1", "to": "9"} in diff["cells"]["changed"]["items"]


def test_version_content_can_be_rebuilt(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    set_cells(client, admin_headers, sheet_id, [(0, 0, "old")])
    target = versions(client, admin_headers, sheet_id)[0]["id"]
    set_cells(client, admin_headers, sheet_id, [(0, 0, "new")])

    historical = client.get(f"/api/sheets/{sheet_id}/versions/{target}", headers=admin_headers).json()["data"]
    assert historical["cells"]["0:0"] == "old"


def test_restore_is_append_only(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    set_cells(client, admin_headers, sheet_id, [(0, 0, "old")])
    target = versions(client, admin_headers, sheet_id)[0]["id"]
    set_cells(client, admin_headers, sheet_id, [(0, 0, "new")])
    before = len(versions(client, admin_headers, sheet_id))

    restored = client.post(
        f"/api/sheets/{sheet_id}/versions/{target}/restore", headers=admin_headers
    )
    assert restored.status_code == 200, restored.text
    assert restored.json()["data"]["cells"]["0:0"] == "old"

    after = versions(client, admin_headers, sheet_id)
    assert len(after) == before + 1
    assert client.get(f"/api/sheets/{sheet_id}/versions/{target}", headers=admin_headers).status_code == 200


def test_rollback_moves_back_one_version(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    set_cells(client, admin_headers, sheet_id, [(0, 0, "v1")])
    set_cells(client, admin_headers, sheet_id, [(0, 0, "v2")])

    rolled = client.post(f"/api/sheets/{sheet_id}/rollback?steps=1", headers=admin_headers)
    assert rolled.status_code == 200, rolled.text
    assert rolled.json()["data"]["cells"]["0:0"] == "v1"


def test_snapshot_compaction_keeps_state_rebuildable(client, admin_headers, make_sheet, monkeypatch):
    monkeypatch.setenv("OE_VERSION_SNAPSHOT_LIMIT", "2")
    config.VERSION_SNAPSHOT_LIMIT = 2
    sheet_id = make_sheet(rows=3, cols=3)
    ids = []
    for i in range(6):
        set_cells(client, admin_headers, sheet_id, [(0, 0, f"step{i}")])
        ids.append(versions(client, admin_headers, sheet_id)[0]["id"])
        client.post(f"/api/sheets/{sheet_id}/snapshot", headers=admin_headers)

    total_versions = sql("COUNT(*) AS n FROM versions")[0]["n"]
    assert total_versions >= 12
    live_snapshots = len([r for r in sql("snapshot FROM versions") if r["snapshot"]])
    assert live_snapshots <= config.VERSION_SNAPSHOT_LIMIT

    oldest = client.get(f"/api/sheets/{sheet_id}/versions/{ids[0]}", headers=admin_headers)
    assert oldest.status_code == 200, oldest.text
    assert oldest.json()["data"]["cells"]["0:0"] == "step0"


def test_legacy_full_snapshot_is_migrated(tmp_path, monkeypatch):
    import sqlite3

    db_file = tmp_path / "legacy.db"
    conn = sqlite3.connect(db_file)
    conn.executescript(
        """
        CREATE TABLE sheets (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL,
                             updated_at TEXT NOT NULL, rows INTEGER NOT NULL DEFAULT 100,
                             cols INTEGER NOT NULL DEFAULT 20);
        CREATE TABLE cells (sheet_id TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL,
                            value TEXT, format TEXT, PRIMARY KEY (sheet_id, row, col));
        CREATE TABLE versions (id INTEGER PRIMARY KEY AUTOINCREMENT, sheet_id TEXT NOT NULL,
                               snapshot TEXT NOT NULL, created_at TEXT NOT NULL);
        """
    )
    conn.execute(
        "INSERT INTO sheets (id, name, created_at, updated_at, rows, cols) VALUES ('legacy', 't', 't', 't', 2, 2)"
    )
    conn.execute("INSERT INTO cells (sheet_id, row, col, value) VALUES ('legacy', 0, 0, 'old-value')")
    conn.execute(
        "INSERT INTO versions (sheet_id, snapshot, created_at) VALUES ('legacy', ?, 't')",
        (json.dumps({"rows": 2, "cols": 2, "cells": {"0:0": "old-value"}, "formats": {}}),),
    )
    conn.commit()
    conn.close()

    monkeypatch.setenv("OE_DB_PATH", str(db_file))
    from app import db as db_module

    db_module.reset_connections()
    from fastapi.testclient import TestClient

    from app.main import app

    try:
        with TestClient(app) as legacy_client:
            conn = get_conn()
            row = conn.execute("SELECT ops, snapshot FROM versions WHERE sheet_id = 'legacy'").fetchone()
            assert row["snapshot"] is None
            assert [op["kind"] for op in json.loads(row["ops"])] == ["replace"]

            admin_password = "admin-pass"
            login = legacy_client.post(
                "/api/auth/login", json={"username": "admin", "password": admin_password}
            )
            if login.status_code == 401:  # 管理员在其它库中已存在 → 直接改写口令哈希
                from app import auth as auth_module

                conn.execute(
                    "UPDATE users SET password_hash = ? WHERE username = 'admin'",
                    (auth_module.hash_password(admin_password),),
                )
                conn.commit()
                login = legacy_client.post(
                    "/api/auth/login", json={"username": "admin", "password": admin_password}
                )
            assert login.status_code == 200, login.text
            headers = {"Authorization": f"Bearer {login.json()['data']['token']}"}

            content = legacy_client.get("/api/sheets/legacy/versions/1", headers=headers)
            assert content.status_code == 200, content.text
            assert content.json()["data"]["cells"]["0:0"] == "old-value"

            sheet = legacy_client.get("/api/sheets/legacy", headers=headers).json()["data"]
            assert sheet["rows"] == 2 and sheet["cols"] == 2
            assert sheet["cells"]["0:0"] == "old-value"
    finally:
        db_module.reset_connections()