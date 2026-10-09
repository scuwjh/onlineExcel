"""协同收敛（④ 的验收测试）。

覆盖三层：
1. 纯函数层：LWW 寄存器的确定性判定（``Reg.loses_to``）；
2. 操作层：乱序重放同一批操作必须收敛到同一状态；
3. 接口层：两个客户端的并发写入（含并发插入同一行位置、删除与插入竞争）最终一致。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import crdt


def headers_for(client, username: str) -> dict:
    response = client.post("/api/auth/login", json={"username": username, "password": "pw123456"})
    assert response.status_code == 200, response.text
    return {"Authorization": f"Bearer {response.json()['data']['token']}"}


def get_sheet(client, headers, sheet_id) -> dict:
    response = client.get(f"/api/sheets/{sheet_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def put_cell(client, headers, sheet_id, row_id=None, col_id=None, row=None, col=None, value=None, version=None):
    update = {"value": value, "version": version or {}}
    if row_id is not None:
        update["row_id"] = row_id
    if col_id is not None:
        update["col_id"] = col_id
    if row is not None:
        update["row"] = row
    if col is not None:
        update["col"] = col
    response = client.put(
        f"/api/sheets/{sheet_id}/cells", json={"updates": [update]}, headers=headers
    )
    assert response.status_code == 200, response.text
    return response.json()["data"]


# ------------------------------------------------------------------ 1. 纯函数层


def reg(value, version, seq, client):
    return crdt.Reg(value=value, version=version, seq=seq, client=client)


def test_concurrent_cells_resolve_deterministically_by_client_id():
    # 两个副本都只见过 seq=5，之后各自写入 → 版本向量不可比较（真并发）
    a = reg("A", {"c1": 5}, 10, "c1")
    b = reg("B", {"c2": 5}, 10, "c2")
    assert a.loses_to(b) is True
    assert b.loses_to(a) is False
    # 无论谁先到达，最终胜者一致（client_id 字典序大者胜）
    assert sorted([a, b], key=lambda r: r.client)[-1].value == "B"


def test_causally_newer_value_wins_over_older():
    old = reg("old", {"c1": 3}, 3, "c1")
    new = reg("new", {"c1": 4}, 4, "c1")
    assert old.loses_to(new) is True
    assert new.loses_to(old) is False


def test_same_operation_is_idempotent():
    a = reg("x", {"c1": 7}, 7, "c1")
    same = reg("x", {"c1": 7}, 7, "c1")
    assert a.loses_to(same) is False


def test_replay_order_does_not_change_final_state():
    """同一批操作按不同顺序（但 seq 递增重放）得到相同结果。"""
    state_a = crdt.SheetState(sheet_id="s", row_ids=["r0", "r1"], col_ids=["c0", "c1"])
    state_b = crdt.SheetState(sheet_id="s", row_ids=["r0", "r1"], col_ids=["c0", "c1"])
    ops = [
        (5, "c1", {"row_id": "r0", "col_id": "c0", "value": "from-c1"}),
        (6, "c2", {"row_id": "r0", "col_id": "c0", "value": "from-c2"}),
    ]
    for seq, client, payload in ops:
        incoming = crdt.Reg(value=payload["value"], version={client: seq}, seq=seq, client=client)
        current = state_a.values.get(("r0", "c0"))
        if current is None or current.loses_to(incoming):
            state_a.values[("r0", "c0")] = incoming
    for seq, client, payload in reversed(ops):
        incoming = crdt.Reg(value=payload["value"], version={client: seq}, seq=seq, client=client)
        current = state_b.values.get(("r0", "c0"))
        if current is None or current.loses_to(incoming):
            state_b.values[("r0", "c0")] = incoming
    assert state_a.project()["cells"] == state_b.project()["cells"] == {"0:0": "from-c2"}


# --------------------------------------------------------------- 2. 接口层并发


def test_two_clients_concurrent_edit_converges(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet(rows=5, cols=5)
    alice = as_user("alice")
    bob = as_user("bob")
    from .conftest import grant

    grant(client, admin_headers, sheet_id, "alice", "editor")
    grant(client, admin_headers, sheet_id, "bob", "editor")

    base = get_sheet(client, alice, sheet_id)
    row_id, col_id = base["rowIds"][0], base["colIds"][0]

    first = put_cell(client, alice, sheet_id, row_id, col_id, value="alice", version={"alice": 1})
    second = put_cell(client, bob, sheet_id, row_id, col_id, value="bob", version={"bob": 2})

    assert set(first["cells"].values()) == {"alice"}
    assert set(second["cells"].values()) == {"bob"}
    # 两个客户端拉取到的权威状态必须一致
    assert get_sheet(client, alice, sheet_id)["cells"] == get_sheet(client, bob, sheet_id)["cells"]


def test_bob_lww_after_seeing_alice_wins(client, admin_headers, make_sheet, as_user):
    """因果在后（版本向量包含 alice 的操作）的写入必须获胜。"""
    from .conftest import grant

    sheet_id = make_sheet(rows=5, cols=5)
    alice = as_user("alice")
    bob = as_user("bob")
    grant(client, admin_headers, sheet_id, "alice", "editor")
    grant(client, admin_headers, sheet_id, "bob", "editor")

    base = get_sheet(client, alice, sheet_id)
    row_id, col_id = base["rowIds"][1], base["colIds"][1]
    alice_result = put_cell(client, alice, sheet_id, row_id, col_id, value="alice", version={"alice": 1})
    alice_seq = alice_result["seq"]
    bob_result = put_cell(
        client, bob, sheet_id, row_id, col_id, value="bob-after", version={"alice": alice_seq}
    )
    assert bob_result["cells"] == {"1:1": "bob-after"}
    assert get_sheet(client, alice, sheet_id)["cells"]["1:1"] == "bob-after"


def test_concurrent_row_insert_at_same_position_keeps_both_rows(
    client, admin_headers, make_sheet, as_user
):
    from .conftest import grant

    sheet_id = make_sheet(rows=10, cols=3)
    alice = as_user("alice")
    bob = as_user("bob")
    grant(client, admin_headers, sheet_id, "alice", "editor")
    grant(client, admin_headers, sheet_id, "bob", "editor")

    first = client.post(
        f"/api/sheets/{sheet_id}/rows", json={"at": 0, "counter": 1}, headers=alice
    )
    assert first.status_code == 200, first.text
    second = client.post(
        f"/api/sheets/{sheet_id}/rows", json={"at": 0, "counter": 1}, headers=bob
    )
    assert second.status_code == 200, second.text

    sheet = get_sheet(client, alice, sheet_id)
    assert sheet["rows"] == 12, "两次并发插入都必须保留，且不能错位"
    assert len(set(sheet["rowIds"])) == 12
    # 后写者插在最前（按 seq 排序重放的确定性结果）
    assert sheet["rowIds"][0] == second.json()["data"]["rowIds"][0]
    assert get_sheet(client, bob, sheet_id)["rowIds"] == sheet["rowIds"]


def test_duplicate_insert_is_idempotent(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    payload = {"at": 0, "element_id": "fixed-elem"}
    for _ in range(3):
        response = client.post(f"/api/sheets/{sheet_id}/ops", json={"kind": "insert_row", "payload": payload}, headers=admin_headers)
        assert response.status_code == 200, response.text
    sheet = get_sheet(client, admin_headers, sheet_id)
    assert sheet["rows"] == 4, "相同 element_id 的重复插入只应生效一次"


def test_delete_row_removes_its_cells_without_ghosts(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=2)
    base = get_sheet(client, admin_headers, sheet_id)
    for row_index in range(4):
        put_cell(
            client,
            admin_headers,
            sheet_id,
            base["rowIds"][row_index],
            base["colIds"][0],
            value=f"row{row_index}",
        )
    deleted_id = base["rowIds"][1]
    response = client.post(
        f"/api/sheets/{sheet_id}/ops",
        json={"kind": "delete_row", "payload": {"element_id": deleted_id}},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    sheet = get_sheet(client, admin_headers, sheet_id)
    assert sheet["rows"] == 3
    assert deleted_id not in sheet["rowIds"]
    assert "row1" not in sheet["cells"].values()
    # 其余行的数据顺序保持
    assert [sheet["cells"].get(f"{i}:0") for i in range(3)] == ["row0", "row2", "row3"]


def test_delete_and_concurrent_edit_converge(client, admin_headers, make_sheet, as_user):
    """删除行与另一端的并发写入竞争：结果确定且两端一致。"""
    from .conftest import grant

    sheet_id = make_sheet(rows=3, cols=2)
    alice = as_user("alice")
    bob = as_user("bob")
    grant(client, admin_headers, sheet_id, "alice", "editor")
    grant(client, admin_headers, sheet_id, "bob", "editor")

    base = get_sheet(client, alice, sheet_id)
    target_row, col = base["rowIds"][0], base["colIds"][0]

    delete_response = client.post(
        f"/api/sheets/{sheet_id}/ops",
        json={"kind": "delete_row", "payload": {"element_id": target_row}},
        headers=alice,
    )
    assert delete_response.status_code == 200, delete_response.text

    # bob 拿着过期坐标写入 → 必须被拒绝（而不是写到别的行上）
    stale = client.put(
        f"/api/sheets/{sheet_id}/cells",
        json={"updates": [{"row_id": target_row, "col_id": col, "value": "ghost"}]},
        headers=bob,
    )
    assert stale.status_code == 400
    assert "不存在" in stale.json()["error"]

    final_alice = get_sheet(client, alice, sheet_id)
    final_bob = get_sheet(client, bob, sheet_id)
    assert final_alice["cells"] == final_bob["cells"]
    assert final_alice["rowIds"] == final_bob["rowIds"]


# -------------------------------------------------------------------- 3. WebSocket


def test_ws_requires_token(client, admin_headers, make_sheet):
    sheet_id = make_sheet()
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/sheets/{sheet_id}?token=bad-token") as ws:
            ws.receive_json()


def test_ws_handshake_and_broadcast(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    token = admin_headers["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as ws:
        welcome = ws.receive_json()
        assert welcome["type"] == "welcome"
        assert welcome["role"] == "owner"
        assert welcome["rowIds"] and welcome["colIds"]

        ws.send_json(
            {
                "type": "cell_update",
                "row": 0,
                "col": 0,
                "row_id": welcome["rowIds"][0],
                "col_id": welcome["colIds"][0],
                "value": "ws-value",
                "client_id": "c-ws",
                "version": {},
            }
        )
        message = ws.receive_json()
        assert message["type"] == "cell_update"
        assert message["cells"].get("0:0") == "ws-value"
        assert message["seq"] > 0 and message["version"] > 0

    assert get_sheet(client, admin_headers, sheet_id)["cells"]["0:0"] == "ws-value"


def test_ws_viewer_write_rejected(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet(rows=3, cols=3)
    viewer_headers = as_user("watcher")
    from .conftest import grant

    grant(client, admin_headers, sheet_id, "watcher", "viewer")
    token = viewer_headers["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as ws:
        welcome = ws.receive_json()
        assert welcome["role"] == "viewer"
        ws.send_json({"type": "cell_update", "row": 0, "col": 0, "value": "nope"})
        error = ws.receive_json()
        assert error["type"] == "error" and error["code"] == "forbidden"
    assert get_sheet(client, admin_headers, sheet_id)["cells"] == {}


def test_ws_outsider_connection_closed(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet()
    outsider = as_user("stranger")
    token = outsider["Authorization"].split()[1]
    with pytest.raises(Exception):
        with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}"):
            pass


def test_ws_two_clients_stay_consistent(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    token = admin_headers["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as alice:
        welcome = alice.receive_json()
        with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as bob:
            bob.receive_json()  # bob 的 welcome
            alice.receive_json()  # alice 收到 bob 的 presence
            alice.send_json(
                {
                    "type": "cell_update",
                    "row": 1,
                    "col": 1,
                    "row_id": welcome["rowIds"][1],
                    "col_id": welcome["colIds"][1],
                    "value": "shared",
                }
            )
            got = bob.receive_json()
            assert got["type"] == "cell_update"
            assert got["cells"]["1:1"] == "shared"


def test_ws_insert_row_broadcasts_authoritative_projection(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=2, cols=2)
    token = admin_headers["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as ws:
        welcome = ws.receive_json()
        ws.send_json({"type": "row_insert", "at": 0, "counter": 1})
        message = ws.receive_json()
        assert message["type"] == "row_insert"
        assert message["rows"] == 3
        assert len(message["rowIds"]) == 3
        assert message["rowIds"][0] not in welcome["rowIds"]
