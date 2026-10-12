"""个性化偏好（REQ-110/112）与钉钉机器人（REQ-115）测试。

钉钉侧全部走 Mock：不打真实网络，只断言"加签是否正确、@手机号是否带上、
未配置/失败时是否安全降级、是否会拖累评论写入"。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
import urllib.parse

import pytest

from app import config, dingtalk
from app.db import get_conn

from .conftest import grant


# ------------------------------------------------------------------ 个性化偏好


def test_preferences_default_empty_then_roundtrip(client, admin_headers):
    empty = client.get("/api/preferences", headers=admin_headers)
    assert empty.status_code == 200
    assert empty.json()["data"] == {}

    payload = {
        "shortcuts": {"format.bold": "Ctrl+Alt+B", "formula.sum": "Alt+S"},
        "fillColors": ["#FFF2CC", "#FFD966"],
        "highlightColors": ["#D93025"],
        "enterDirection": "right",
    }
    saved = client.put("/api/preferences", json=payload, headers=admin_headers)
    assert saved.status_code == 200, saved.text
    data = saved.json()["data"]
    assert data["shortcuts"]["format.bold"] == "Ctrl+Alt+B"
    assert data["fillColors"] == ["#fff2cc", "#ffd966"]  # 颜色归一化为小写
    assert data["enterDirection"] == "right"

    again = client.get("/api/preferences", headers=admin_headers).json()["data"]
    assert again == data


def test_preferences_rejects_invalid_values(client, admin_headers):
    bad_color = client.put(
        "/api/preferences", json={"fillColors": ["red"]}, headers=admin_headers
    )
    assert bad_color.status_code == 400
    assert "#rrggbb" in bad_color.json()["error"]

    bad_direction = client.put(
        "/api/preferences", json={"enterDirection": "diagonal"}, headers=admin_headers
    )
    assert bad_direction.status_code == 400

    bad_shortcuts = client.put(
        "/api/preferences", json={"shortcuts": ["Ctrl+B"]}, headers=admin_headers
    )
    assert bad_shortcuts.status_code == 400

    too_many = client.put(
        "/api/preferences",
        json={"shortcuts": {f"cmd.{i}": "Ctrl+B" for i in range(200)}},
        headers=admin_headers,
    )
    assert too_many.status_code == 400


def test_preferences_size_limit(client, admin_headers, monkeypatch):
    monkeypatch.setattr(config, "MAX_PREFS_CHARS", 120)
    response = client.put(
        "/api/preferences",
        json={"shortcuts": {f"cmd.{i}": "Ctrl+Shift+Alt+Q" for i in range(10)}},
        headers=admin_headers,
    )
    assert response.status_code == 400
    assert "过大" in response.json()["error"]


def test_preferences_are_per_user(client, admin_headers, as_user):
    alice = as_user("alice")
    bob = as_user("bob")
    client.put("/api/preferences", json={"enterDirection": "up"}, headers=alice)
    client.put("/api/preferences", json={"enterDirection": "left"}, headers=bob)
    assert client.get("/api/preferences", headers=alice).json()["data"]["enterDirection"] == "up"
    assert client.get("/api/preferences", headers=bob).json()["data"]["enterDirection"] == "left"


def test_preferences_keeps_unknown_keys_and_requires_auth(client, admin_headers):
    assert client.get("/api/preferences").status_code == 401
    saved = client.put(
        "/api/preferences",
        json={"enterDirection": "none", "futureOption": {"a": 1}},
        headers=admin_headers,
    )
    assert saved.status_code == 200, saved.text
    assert saved.json()["data"]["futureOption"] == {"a": 1}


# ------------------------------------------------------------------ 钉钉：纯函数


def test_sign_url_matches_dingtalk_algorithm():
    webhook = "https://oapi.dingtalk.com/robot/send?access_token=abc"
    signed = dingtalk.sign_url(webhook, "SEC123", 1700000000000)
    expected_sign = urllib.parse.quote_plus(
        base64.b64encode(
            hmac.new(b"SEC123", b"1700000000000\nSEC123", hashlib.sha256).digest()
        ).decode()
    )
    assert signed.startswith(webhook + "&")
    assert f"timestamp=1700000000000" in signed
    assert f"sign={expected_sign}" in signed
    # 没有 query 时用 ? 连接
    assert dingtalk.sign_url("https://x/send", "s", 1).startswith("https://x/send?")


def test_build_payload_never_mentions_all():
    payload = dingtalk.build_payload("hello @13800000000", ["13800000000", ""])
    assert payload["msgtype"] == "text"
    assert payload["text"]["content"].startswith("hello")
    assert payload["at"] == {"atMobiles": ["13800000000"], "isAtAll": False}


def test_comment_text_contains_mobile_mention():
    text = dingtalk.comment_text(
        sheet_name="测试表", author="admin", body="看下这行", cell_label="B3", at_mobiles=["138"]
    )
    assert "测试表" in text and "admin" in text and "B3" in text and "看下这行" in text
    assert "@138" in text


def test_send_text_skips_without_config(monkeypatch):
    monkeypatch.setattr(config, "DINGTALK_ENABLED", False)
    monkeypatch.setattr(config, "DINGTALK_WEBHOOK", "")
    cfg = dingtalk.load_config()
    result = dingtalk.send_text("hi", ["138"], cfg=cfg)
    assert result["ok"] is False
    assert "未配置" in result["skipped"]


def test_send_text_posts_signed_payload(monkeypatch):
    captured = {}

    def fake_post(url, payload, timeout):
        captured["url"] = url
        captured["payload"] = payload
        return {"errcode": 0, "errmsg": "ok"}

    monkeypatch.setattr(dingtalk, "_post_json", fake_post)
    cfg = dingtalk.DingTalkConfig(
        enabled=True,
        webhook="https://oapi.dingtalk.com/robot/send?access_token=t",
        secret="SEC",
        mobiles={"alice": "13800000000"},
        timeout=3.0,
    )
    result = dingtalk.send_text("提醒", ["13800000000"], cfg=cfg)
    assert result["ok"] is True
    assert "timestamp=" in captured["url"] and "sign=" in captured["url"]
    assert captured["payload"]["at"]["atMobiles"] == ["13800000000"]


def test_send_text_swallows_network_error(monkeypatch):
    def boom(url, payload, timeout):
        raise TimeoutError("网络超时")

    monkeypatch.setattr(dingtalk, "_post_json", boom)
    cfg = dingtalk.DingTalkConfig(enabled=True, webhook="https://x", mobiles={})
    result = dingtalk.send_text("提醒", [], cfg=cfg)
    assert result["ok"] is False
    assert "网络超时" in result["error"]


def test_notify_comment_mentions_maps_users_to_mobiles(monkeypatch):
    sent = {}

    def fake_post(url, payload, timeout):
        sent["payload"] = payload
        return {"errcode": 0}

    monkeypatch.setattr(dingtalk, "_post_json", fake_post)
    cfg = dingtalk.DingTalkConfig(
        enabled=True,
        webhook="https://x",
        mobiles={"alice": "138", "bob": "139"},
    )
    result = dingtalk.notify_comment_mentions(
        sheet_name="表", author="admin", body="请看", mentioned_users=["alice", "carol"], cfg=cfg
    )
    assert result["ok"] is True
    assert result["at_mobiles"] == ["138"]  # carol 未配置手机号 → 不 @
    assert sent["payload"]["at"]["atMobiles"] == ["138"]
    assert "@138" in sent["payload"]["text"]["content"]


def test_notify_comment_mentions_skips_when_no_mapping(monkeypatch):
    monkeypatch.setattr(dingtalk, "_post_json", lambda *a, **k: pytest.fail("不应发起请求"))
    cfg = dingtalk.DingTalkConfig(enabled=True, webhook="https://x", mobiles={})
    result = dingtalk.notify_comment_mentions(
        sheet_name="表", author="admin", body="hi", mentioned_users=["alice"], cfg=cfg
    )
    assert result["ok"] is False
    assert "手机号" in result["skipped"]


def test_notify_in_background_runs_and_swallows_errors(monkeypatch):
    calls = []
    monkeypatch.setattr(dingtalk, "notify_comment_mentions", lambda **kw: calls.append(kw))
    dingtalk.notify_in_background(sheet_name="表", author="a", body="b", mentioned_users=["x"])
    for _ in range(100):
        if calls:
            break
        time.sleep(0.01)
    assert calls and calls[0]["mentioned_users"] == ["x"]

    # 后台任务内部异常不应冒泡
    def boom(**kw):
        raise RuntimeError("炸了")

    monkeypatch.setattr(dingtalk, "notify_comment_mentions", boom)
    dingtalk.notify_in_background(sheet_name="表", author="a", body="b", mentioned_users=["x"])


def test_dingtalk_mobiles_env_parsing(monkeypatch):
    monkeypatch.setenv("OE_DINGTALK_MOBILES", json.dumps({"alice": "138", "  bob ": " 139 "}))
    assert config.dingtalk_mobiles() == {"alice": "138", "bob": "139"}
    monkeypatch.setenv("OE_DINGTALK_MOBILES", "{not json")
    assert config.dingtalk_mobiles() == {}
    monkeypatch.setenv("OE_DINGTALK_MOBILES", "")
    assert config.dingtalk_mobiles() == {}


# ------------------------------------------------------------------ 钉钉：接口


def test_dingtalk_status_never_leaks_webhook(client, admin_headers, monkeypatch):
    monkeypatch.setattr(config, "DINGTALK_ENABLED", True)
    monkeypatch.setattr(config, "DINGTALK_WEBHOOK", "https://oapi.dingtalk.com/robot/send?access_token=secret")
    monkeypatch.setattr(config, "DINGTALK_SECRET", "SEC")
    monkeypatch.setattr(config, "DINGTALK_TIMEOUT", 3.0)
    monkeypatch.setenv("OE_DINGTALK_MOBILES", json.dumps({"alice": "138"}))
    data = client.get("/api/integrations/dingtalk", headers=admin_headers).json()["data"]
    assert data == {"enabled": True, "configured": True, "has_secret": True, "mobile_map_size": 1}
    assert "webhook" not in json.dumps(data)


def test_dingtalk_test_endpoint_requires_owner_and_config(client, admin_headers, make_sheet, as_user, monkeypatch):
    make_sheet()  # admin 至少拥有一张表
    monkeypatch.setattr(config, "DINGTALK_ENABLED", False)
    monkeypatch.setattr(config, "DINGTALK_WEBHOOK", "")
    no_config = client.post("/api/integrations/dingtalk/test", headers=admin_headers)
    assert no_config.status_code == 400

    outsider = as_user("nobody")
    monkeypatch.setattr(config, "DINGTALK_ENABLED", True)
    monkeypatch.setattr(config, "DINGTALK_WEBHOOK", "https://x")
    forbidden = client.post("/api/integrations/dingtalk/test", headers=outsider)
    assert forbidden.status_code == 403

    monkeypatch.setattr(dingtalk, "_post_json", lambda url, payload, timeout: {"errcode": 0})
    ok = client.post("/api/integrations/dingtalk/test", headers=admin_headers)
    assert ok.status_code == 200, ok.text
    assert ok.json()["data"]["ok"] is True


def test_comment_mention_triggers_dingtalk_notification(client, admin_headers, make_sheet, as_user, monkeypatch):
    sheet_id = make_sheet(rows=3, cols=3)
    as_user("alice")  # 注册后再授权
    grant(client, admin_headers, sheet_id, "alice", "editor")
    captured = {}
    monkeypatch.setattr(dingtalk, "notify_in_background", lambda **kw: captured.update(kw))

    sheet = client.get(f"/api/sheets/{sheet_id}", headers=admin_headers).json()["data"]
    response = client.post(
        f"/api/sheets/{sheet_id}/comments",
        json={
            "row_id": sheet["rowIds"][0],
            "col_id": sheet["colIds"][1],
            "body": "请 @alice 确认这一列",
        },
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["mentions"] == ["alice"]
    assert captured["mentioned_users"] == ["alice"]
    assert captured["cell_label"] == "B1"
    assert captured["author"] == "admin"


def test_comment_survives_dingtalk_failure(client, admin_headers, make_sheet, monkeypatch):
    """钉钉推送炸掉时，评论仍必须落库（后台线程 + 异常兜底）。"""
    sheet_id = make_sheet(rows=3, cols=3)

    def boom(**kw):
        raise RuntimeError("钉钉失败")

    monkeypatch.setattr(dingtalk, "notify_comment_mentions", boom)
    sheet = client.get(f"/api/sheets/{sheet_id}", headers=admin_headers).json()["data"]
    response = client.post(
        f"/api/sheets/{sheet_id}/comments",
        json={"row_id": sheet["rowIds"][0], "col_id": sheet["colIds"][0], "body": "普通评论"},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    conn = get_conn()
    count = conn.execute(
        "SELECT COUNT(*) AS n FROM comments WHERE sheet_id = ?", (sheet_id,)
    ).fetchone()
    assert int(count["n"]) == 1
