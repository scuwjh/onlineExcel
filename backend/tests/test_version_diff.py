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


def test_restore_preserves_element_ids(client, admin_headers, make_sheet):
    """REQ-042：恢复历史版本必须保留原行列元素 ID，评论等按 ID 锚定的数据不失效。"""
    sheet_id = make_sheet(rows=3, cols=2)
    initial = client.get(f"/api/sheets/{sheet_id}", headers=admin_headers).json()["data"]
    old_row_ids = initial["rowIds"]
    old_col_ids = initial["colIds"]
    set_cells(client, admin_headers, sheet_id, [(0, 0, "old")])
    target = versions(client, admin_headers, sheet_id)[0]["id"]
    set_cells(client, admin_headers, sheet_id, [(1, 1, "new")])

    restored = client.post(f"/api/sheets/{sheet_id}/versions/{target}/restore", headers=admin_headers)
    assert restored.status_code == 200, restored.text
    assert restored.json()["data"]["cells"]["0:0"] == "old"

    after = client.get(f"/api/sheets/{sheet_id}", headers=admin_headers).json()["data"]
    # 元素 ID 必须与恢复目标完全一致（此前会用 restore:xxx 重建，导致评论锚点失效）
    assert after["rowIds"] == old_row_ids, after["rowIds"]
    assert after["colIds"] == old_col_ids, after["colIds"]


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

def test_legacy_v1_cell_list_snapshot_is_migrated_and_readable(tmp_path, monkeypatch):
    """回归：v1 真实快照是**逐格列表**（不是 dict），迁移必须成功且历史链路可读。

    修复前：``migrate_legacy_versions`` 只认 dict → 一条都不迁移；随后
    ``materialize_version`` 对 list 调 ``data.get`` → 版本详情/对比/恢复全部 500。
    """
    import sqlite3

    db_file = tmp_path / "legacy_v1.db"
    conn = sqlite3.connect(db_file)
    # 与 v1 真实建表语句一致：versions 只有 snapshot（NOT NULL），没有 ops/user。
    conn.executescript(
        """
        CREATE TABLE sheets (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            rows INTEGER NOT NULL DEFAULT 100,
            cols INTEGER NOT NULL DEFAULT 20
        );
        CREATE TABLE cells (
            sheet_id TEXT NOT NULL, row INTEGER NOT NULL, col INTEGER NOT NULL,
            value TEXT, format TEXT, PRIMARY KEY (sheet_id, row, col)
        );
        CREATE TABLE versions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sheet_id TEXT NOT NULL,
            snapshot TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
        """
    )
    conn.execute(
        "INSERT INTO sheets (id, name, created_at, updated_at, rows, cols) "
        "VALUES ('legacy', '测试', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 4, 3)"
    )
    conn.execute("INSERT INTO cells (sheet_id, row, col, value) VALUES ('legacy', 0, 0, 'a')")

    def snapshot(cells):
        return json.dumps(cells, ensure_ascii=False)

    # 版本 1：空表；版本 2：三格 + 一条 JSON 字符串样式；版本 3：内容变化。
    v1 = []
    v2 = [
        {"row": 0, "col": 0, "value": "a", "format": None},
        {"row": 0, "col": 1, "value": "b", "format": json.dumps({"align": "right"})},
        {"row": 1, "col": 0, "value": "c", "format": None},
    ]
    v3 = [
        {"row": 0, "col": 0, "value": "a2", "format": None},
        {"row": 1, "col": 0, "value": "c", "format": None},
    ]
    for snap in (v1, v2, v3):
        conn.execute(
            "INSERT INTO versions (sheet_id, snapshot, created_at) VALUES ('legacy', ?, '2026-01-01T00:00:00Z')",
            (snapshot(snap),),
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
            rows = conn.execute(
                "SELECT id, ops, snapshot FROM versions WHERE sheet_id = 'legacy' ORDER BY id"
            ).fetchall()
            # 三条都必须被迁移：快照清空、改写为 replace 增量。
            assert len(rows) == 3
            for row in rows:
                assert row["snapshot"] is None, f"版本 {row['id']} 未被迁移"
                ops = json.loads(row["ops"])
                assert [op["kind"] for op in ops] == ["replace"]
            # 样式必须解码为对象，而不是被二次编码成字符串。
            payload2 = json.loads(rows[1]["ops"])[0]["payload"]
            assert payload2["formats"]["0:1"] == {"align": "right"}
            assert payload2["cells"] == {"0:0": "a", "0:1": "b", "1:0": "c"}
            # 网格以表格当前尺寸兜底（4x3），不会比历史内容更小。
            assert (payload2["rows"], payload2["cols"]) == (4, 3)

            admin_password = "admin-pass"
            login = legacy_client.post(
                "/api/auth/login", json={"username": "admin", "password": admin_password}
            )
            if login.status_code == 401:
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

            # 版本详情：修复前这里 500（AttributeError: 'list' object has no attribute 'get'）。
            detail = legacy_client.get("/api/sheets/legacy/versions/2", headers=headers)
            assert detail.status_code == 200, detail.text
            data = detail.json()["data"]
            assert data["cells"] == {"0:0": "a", "0:1": "b", "1:0": "c"}
            assert data["formats"]["0:1"] == {"align": "right"}

            # 空快照版本：应还原为空表而不是报错。
            empty = legacy_client.get("/api/sheets/legacy/versions/1", headers=headers)
            assert empty.status_code == 200, empty.text
            assert empty.json()["data"]["cells"] == {}

            # 版本对比与恢复：修复前均为 500。
            diff = legacy_client.get("/api/sheets/legacy/versions/2/diff", headers=headers)
            assert diff.status_code == 200, diff.text

            restore = legacy_client.post("/api/sheets/legacy/versions/2/restore", headers=headers)
            assert restore.status_code == 200, restore.text

            # 恢复后当前表格内容应回到版本 2。
            sheet = legacy_client.get("/api/sheets/legacy", headers=headers).json()["data"]
            assert sheet["cells"]["0:1"] == "b"
            assert sheet["cells"]["1:0"] == "c"

            # 缺陷二：迁移来的旧表必须被指认给初始管理员（owner），
            # 而不是对所有登录用户默认开放 editor。
            access = legacy_client.get("/api/sheets/legacy/access", headers=headers)
            assert access.status_code == 200, access.text
            assert access.json()["data"]["role"] == "owner"
            assert access.json()["data"]["can_manage"] is True

            # 未授权的新用户（自助注册）不再能看到被接管的旧表。
            stranger = legacy_client.post(
                "/api/auth/login", json={"username": "stranger", "password": "pw123"}
            )
            assert stranger.status_code == 200, stranger.text
            s_headers = {"Authorization": f"Bearer {stranger.json()['data']['token']}"}
            visible = legacy_client.get("/api/sheets", headers=s_headers).json()["data"]
            assert all(sheet["id"] != "legacy" for sheet in visible), (
                "未授权用户不应看到被接管的旧表"
            )
    finally:
        db_module.reset_connections()
