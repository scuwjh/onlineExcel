"""鉴权与表格级 RBAC（② 的验收测试）。"""
from __future__ import annotations

from .conftest import cell_at, grant


def test_health_is_public(client):
    assert client.get("/api/health").json()["data"]["status"] == "up"


def test_null_owner_legacy_sheet_is_readonly_and_then_adopted(client, admin_headers, as_user):
    """回归：无 owner 且无任何权限记录的历史表默认只读；启动引导后接管给管理员。

    修复前 ``store.get_role`` 对这种情况直接返回 ``"editor"`` —— 配合自助注册
    （``OE_DEV_AUTO_REGISTER=1``），任何能登录的用户都能编辑迁移过来的旧表，
    且无人能管理/删除。修复后：未接管前只读（viewer），接管后归管理员
    （owner），未授权用户不再可见。
    """
    from app import bootstrap, store
    from app.db import get_conn

    conn = get_conn()
    conn.execute(
        "INSERT INTO sheets (id, name, created_at, updated_at, rows, cols, owner_id) "
        "VALUES ('orphan', '孤儿表', 't', 't', 5, 5, NULL)"
    )
    conn.commit()

    stranger = as_user("stranger")
    visible = client.get("/api/sheets", headers=stranger).json()["data"]
    orphan = next((s for s in visible if s["id"] == "orphan"), None)
    assert orphan is not None, "接管前，无主的旧表应对团队可见（只读）"
    assert orphan["role"] == "viewer", "无主旧表只应降级为只读，而不是 editor"
    assert (
        client.put(
            "/api/sheets/orphan/cells",
            json={"updates": [{"row": 0, "col": 0, "value": "x"}]},
            headers=stranger,
        ).status_code
        == 403
    ), "viewer 写单元格必须被拒"

    info = bootstrap.backfill_legacy_owners(conn)
    conn.commit()
    assert info == {"legacy_sheets_adopted": 1}

    admin_id = store.get_user_by_name(conn, "admin")["id"]
    stranger_id = store.get_user_by_name(conn, "stranger")["id"]
    assert store.get_role(conn, "orphan", admin_id) == "owner"
    assert store.get_role(conn, "orphan", stranger_id) is None

    visible_after = client.get("/api/sheets", headers=stranger).json()["data"]
    assert all(s["id"] != "orphan" for s in visible_after), "未授权用户不应再看到被接管的旧表"
    admin_visible = client.get("/api/sheets", headers=admin_headers).json()["data"]
    orphan_of_admin = next((s for s in admin_visible if s["id"] == "orphan"), None)
    assert orphan_of_admin is not None and orphan_of_admin["role"] == "owner"
    assert client.get("/api/health").json()["data"]["status"] == "up"


def test_protected_endpoints_reject_anonymous(client):
    assert client.get("/api/sheets").status_code == 401
    assert client.post("/api/sheets", json={"name": "x"}).status_code == 401
    assert client.get("/api/sheets/does-not-exist").status_code == 401


def test_invalid_token_rejected(client):
    headers = {"Authorization": "Bearer not-a-jwt"}
    assert client.get("/api/sheets", headers=headers).status_code == 401


def test_login_and_me(client, admin_headers):
    me = client.get("/api/auth/me", headers=admin_headers)
    assert me.status_code == 200
    assert me.json()["data"]["username"] == "admin"


def test_wrong_password_rejected(client):
    response = client.post("/api/auth/login", json={"username": "admin", "password": "nope"})
    assert response.status_code == 401
    assert response.json()["ok"] is False


def test_viewer_cannot_write(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    viewer = as_user("viewer1")
    grant(client, admin_headers, sheet_id, "viewer1", "viewer")

    # 可读
    assert client.get(f"/api/sheets/{sheet_id}", headers=viewer).status_code == 200
    # 不可写：单元格、格式、行列、导入、恢复全部 403
    assert (
        client.put(
            f"/api/sheets/{sheet_id}/cells",
            json={"updates": [{"row": 0, "col": 0, "value": "1"}]},
            headers=viewer,
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/sheets/{sheet_id}/formats",
            json={"updates": [{"row": 0, "col": 0, "format": {"bold": True}}]},
            headers=viewer,
        ).status_code
        == 403
    )
    assert client.post(f"/api/sheets/{sheet_id}/rows?at=0", json={"at": 0}, headers=viewer).status_code == 403
    assert client.delete(f"/api/sheets/{sheet_id}/rows/0", headers=viewer).status_code == 403
    assert (
        client.post(
            f"/api/sheets/{sheet_id}/import",
            json={"rows": 2, "cols": 2, "cells": {"0:0": "x"}},
            headers=viewer,
        ).status_code
        == 403
    )
    # 权限管理仅 owner
    assert client.get(f"/api/sheets/{sheet_id}/permissions", headers=viewer).status_code == 403


def test_editor_can_write_but_not_manage(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    editor = as_user("editor1")
    grant(client, admin_headers, sheet_id, "editor1", "editor")

    write = client.put(
        f"/api/sheets/{sheet_id}/cells",
        json={"updates": [{"row": 1, "col": 2, "value": "42"}]},
        headers=editor,
    )
    assert write.status_code == 200, write.text
    assert client.get(f"/api/sheets/{sheet_id}/permissions", headers=editor).status_code == 403


def test_users_without_grant_cannot_see_sheet(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    outsider = as_user("outsider")
    response = client.get(f"/api/sheets/{sheet_id}", headers=outsider)
    assert response.status_code == 403
    assert response.json()["code"] == "forbidden"


def test_sheet_list_only_shows_accessible_sheets(client, admin_headers, make_sheet, as_user):
    visible = make_sheet("可见")
    hidden = make_sheet("隐藏")
    other = as_user("other")
    grant(client, admin_headers, visible, "other", "viewer")

    listed = client.get("/api/sheets", headers=other).json()["data"]
    ids = {item["id"] for item in listed}
    assert visible in ids
    assert hidden not in ids


def test_owner_can_grant_and_revoke(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    bob = as_user("bob")
    assert client.get(f"/api/sheets/{sheet_id}", headers=bob).status_code == 403

    grant(client, admin_headers, sheet_id, "bob", "editor")
    assert client.get(f"/api/sheets/{sheet_id}", headers=bob).status_code == 200

    revoked = client.delete(f"/api/sheets/{sheet_id}/permissions/bob", headers=admin_headers)
    assert revoked.status_code == 200
    assert client.get(f"/api/sheets/{sheet_id}", headers=bob).status_code == 403


def test_cannot_remove_owner_permission(client, admin_headers, make_sheet):
    sheet_id = make_sheet()
    response = client.delete(f"/api/sheets/{sheet_id}/permissions/admin", headers=admin_headers)
    assert response.status_code == 400


def test_role_cannot_escalate_self(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    editor = as_user("sneaky")
    grant(client, admin_headers, sheet_id, "sneaky", "editor")
    response = client.put(
        f"/api/sheets/{sheet_id}/permissions",
        json={"username": "sneaky", "role": "owner"},
        headers=editor,
    )
    assert response.status_code == 403


def test_login_is_rate_limited(client, monkeypatch):
    from app import main

    monkeypatch.setattr(main, "_LOGIN_MAX_ATTEMPTS", 3)
    main._login_attempts.clear()
    codes = [
        client.post("/api/auth/login", json={"username": "admin", "password": "wrong"}).status_code
        for _ in range(5)
    ]
    assert 429 in codes


def test_security_headers_present(client):
    response = client.get("/api/health")
    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert "Content-Security-Policy" in response.headers


def test_login_autocreated_user_gets_no_sheet_access(client, admin_headers, make_sheet, as_user):
    """开发自动注册得到的账号默认是 viewer 且没有任何表格授权。"""
    sheet_id = make_sheet()
    newcomer = as_user("newcomer")
    assert client.get("/api/sheets", headers=newcomer).json()["data"] == []
    assert client.get(f"/api/sheets/{sheet_id}", headers=newcomer).status_code == 403


def test_cell_update_roundtrip_with_element_ids(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    sheet = client.get(f"/api/sheets/{sheet_id}", headers=admin_headers).json()["data"]
    row_id, col_id = sheet["rowIds"][2], sheet["colIds"][1]

    response = client.put(
        f"/api/sheets/{sheet_id}/cells",
        json={"updates": [{"row_id": row_id, "col_id": col_id, "value": "hello"}]},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert cell_at(response.json()["data"], 2, 1) == "hello"
