"""pytest 公共夹具：临时数据库、鉴权客户端、角色化用户。

测试使用独立临时 SQLite 文件，并在每个用例前重建结构，避免相互污染。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))


@pytest.fixture()
def tmp_db(tmp_path, monkeypatch):
    """临时数据库文件路径（每个用例独立）。"""
    path = tmp_path / "test.db"
    monkeypatch.setenv("OE_DB_PATH", str(path))
    monkeypatch.setenv("OE_JWT_SECRET", "test-secret")
    monkeypatch.setenv("OE_ADMIN_PASSWORD", "admin-pass")
    monkeypatch.setenv("OE_DEV_AUTO_REGISTER", "1")
    monkeypatch.setenv("OE_LOGIN_MAX_ATTEMPTS", "1000")

    from app import db as db_module

    db_module.reset_connections()
    yield path
    db_module.reset_connections()


@pytest.fixture()
def client(tmp_db):
    from fastapi.testclient import TestClient

    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


def auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def login(client, username: str, password: str = "pw123456") -> dict:
    """登录并返回请求头；首次登录会在开发模式下自动注册。"""
    response = client.post("/api/auth/login", json={"username": username, "password": password})
    assert response.status_code == 200, response.text
    return auth(response.json()["data"]["token"])


@pytest.fixture()
def admin_headers(client) -> dict:
    return login(client, "admin", "admin-pass")


@pytest.fixture()
def as_user(client):
    """``as_user("bob")`` → bob 的鉴权头（自动注册为 viewer）。"""
    return lambda username, password="pw123456": login(client, username, password)


@pytest.fixture()
def make_sheet(client, admin_headers):
    """创建表格并返回 ``(sheet_id, 创建者头)``。"""

    def _make(name: str = "测试表格", rows: int = 10, cols: int = 5, headers=None):
        response = client.post(
            "/api/sheets",
            json={"name": name, "rows": rows, "cols": cols},
            headers=headers or admin_headers,
        )
        assert response.status_code == 200, response.text
        return response.json()["data"]["id"]

    return _make


def grant(client, owner_headers, sheet_id: str, username: str, role: str) -> None:
    response = client.put(
        f"/api/sheets/{sheet_id}/permissions",
        json={"username": username, "role": role},
        headers=owner_headers,
    )
    assert response.status_code == 200, response.text


def cell_at(sheet: dict, row: int, col: int):
    return sheet["cells"].get(f"{row}:{col}")
