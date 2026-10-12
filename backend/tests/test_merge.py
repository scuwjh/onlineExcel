"""合并单元格（REQ-113）的协同语义测试。

覆盖：CRDT 纯函数层、REST /ops 入口、索引回退、幂等与相交替换、
行列插删的跟随规则、版本 diff / 快照 / 恢复、权限边界、WS 广播与删除清理。
"""
from __future__ import annotations

import pytest

from app import crdt
from app.db import get_conn

from .conftest import grant


def get_sheet(client, headers, sheet_id) -> dict:
    response = client.get(f"/api/sheets/{sheet_id}", headers=headers)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def post_op(client, headers, sheet_id, kind: str, payload: dict):
    return client.post(
        f"/api/sheets/{sheet_id}/ops",
        json={"kind": kind, "payload": payload, "version": {}},
        headers=headers,
    )


def merge(client, headers, sheet_id, r0, c0, r1, c1, index_form: bool = False):
    payload = {"r0": r0, "c0": c0, "r1": r1, "c1": c1} if index_form else None
    if payload is None:
        sheet = get_sheet(client, headers, sheet_id)
        payload = {
            "row_start_id": sheet["rowIds"][r0],
            "col_start_id": sheet["colIds"][c0],
            "row_end_id": sheet["rowIds"][r1],
            "col_end_id": sheet["colIds"][c1],
        }
    response = post_op(client, headers, sheet_id, "merge", payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]


def unmerge(client, headers, sheet_id, row, col, index_form: bool = False):
    if index_form:
        payload = {"row": row, "col": col}
    else:
        sheet = get_sheet(client, headers, sheet_id)
        payload = {"row_id": sheet["rowIds"][row], "col_id": sheet["colIds"][col]}
    response = post_op(client, headers, sheet_id, "unmerge", payload)
    assert response.status_code == 200, response.text
    return response.json()["data"]


# ------------------------------------------------------------------ 1. 纯函数层


def test_crdt_merge_uses_element_ids_and_projects_indices():
    state = crdt.SheetState(sheet_id="s")
    state.row_ids = ["r0", "r1", "r2"]
    state.col_ids = ["c0", "c1"]
    crdt.apply_op(
        state,
        crdt.OP_MERGE,
        {"row_start_id": "r0", "col_start_id": "c0", "row_end_id": "r1", "col_end_id": "c1"},
        seq=1,
        client_id="t",
    )
    assert state.merges == [("r0", "c0", "r1", "c1")]
    assert state.project()["merges"] == [{"r0": 0, "c0": 0, "r1": 1, "c1": 1}]

    # 在区域内部插入一行：端点不变，但投影扩展开
    crdt.apply_op(state, crdt.OP_INSERT_ROW, {"at": 1, "element_id": "rx"}, seq=2, client_id="t")
    assert state.project()["merges"] == [{"r0": 0, "c0": 0, "r1": 2, "c1": 1}]

    # 删除端点所在行：区域失效
    crdt.apply_op(state, crdt.OP_DELETE_ROW, {"element_id": "r0"}, seq=3, client_id="t")
    assert state.project()["merges"] == []


def test_crdt_merge_rejects_single_cell_and_normalizes_endpoints():
    state = crdt.SheetState(sheet_id="s", row_ids=["r0", "r1"], col_ids=["c0", "c1"])
    with pytest.raises(crdt.InvalidOperation):
        crdt.apply_op(
            state,
            crdt.OP_MERGE,
            {"row_start_id": "r0", "col_start_id": "c0", "row_end_id": "r0", "col_end_id": "c0"},
            seq=1,
            client_id="t",
        )
    # 端点顺序颠倒也能合并（内部归一化）
    crdt.apply_op(
        state,
        crdt.OP_MERGE,
        {"row_start_id": "r1", "col_start_id": "c1", "row_end_id": "r0", "col_end_id": "c0"},
        seq=2,
        client_id="t",
    )
    assert state.merges == [("r0", "c0", "r1", "c1")]


def test_crdt_unmerge_is_noop_on_unmerged_cell():
    state = crdt.SheetState(sheet_id="s", row_ids=["r0", "r1"], col_ids=["c0", "c1"])
    crdt.apply_op(
        state,
        crdt.OP_UNMERGE,
        {"row_id": "r0", "col_id": "c0"},
        seq=1,
        client_id="t",
    )
    assert state.merges == []


# ------------------------------------------------------------------ 2. REST 入口


def test_merge_via_rest_and_get_sheet(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    result = merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    assert "merge" in result["opKinds"]
    assert result["merges"] == [{"r0": 0, "c0": 0, "r1": 1, "c1": 1}]
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 0, "c0": 0, "r1": 1, "c1": 1}
    ]


def test_merge_accepts_index_payload_and_is_idempotent(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1, index_form=True)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1, index_form=True)
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 0, "c0": 0, "r1": 1, "c1": 1}
    ]


def test_overlapping_merge_replaces_previous_region(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=5, cols=5)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    merge(client, admin_headers, sheet_id, 1, 1, 2, 2)
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 1, "c0": 1, "r1": 2, "c1": 2}
    ]


def test_single_cell_merge_is_rejected(client, admin_headers, make_sheet):
    sheet_id = make_sheet()
    response = post_op(client, admin_headers, sheet_id, "merge", {"r0": 0, "c0": 0, "r1": 0, "c1": 0})
    assert response.status_code == 400
    assert "2 个单元格" in response.json()["error"]


def test_unmerge_removes_region_and_keeps_other_cells(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    result = unmerge(client, admin_headers, sheet_id, 1, 1)
    assert result["merges"] == []
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == []
    # 落在未合并单元格上：仍是 200，且状态不变
    response = post_op(client, admin_headers, sheet_id, "unmerge", {"row": 3, "col": 3})
    assert response.status_code == 200


def test_merge_follows_row_insert_and_delete(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=5, cols=5)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    # 区域内插行 → 区域扩展到 3 行
    client.post(f"/api/sheets/{sheet_id}/rows", json={"at": 1}, headers=admin_headers)
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 0, "c0": 0, "r1": 2, "c1": 1}
    ]
    # 区域之后插行 → 区域不受影响
    client.post(f"/api/sheets/{sheet_id}/rows", json={"at": 5}, headers=admin_headers)
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 0, "c0": 0, "r1": 2, "c1": 1}
    ]
    # 删除端点行 → 区域消失
    client.delete(f"/api/sheets/{sheet_id}/rows/0", headers=admin_headers)
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == []


def test_merge_does_not_clear_cell_values(client, admin_headers, make_sheet):
    """合并只隐藏、不删数据：区域内其它单元格的值仍在投影里。"""
    sheet_id = make_sheet(rows=3, cols=3)
    client.put(
        f"/api/sheets/{sheet_id}/cells",
        json={"updates": [
            {"row": 0, "col": 0, "value": "A"},
            {"row": 1, "col": 1, "value": "B"},
        ]},
        headers=admin_headers,
    )
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    sheet = get_sheet(client, admin_headers, sheet_id)
    assert sheet["cells"].get("1:1") == "B"


def test_merge_requires_editor(client, admin_headers, make_sheet, as_user):
    sheet_id = make_sheet(rows=3, cols=3)
    viewer = as_user("carol")  # 首次登录即注册，随后才能被授权
    grant(client, admin_headers, sheet_id, "carol", "viewer")
    response = client.post(
        f"/api/sheets/{sheet_id}/ops",
        json={"kind": "merge", "payload": {"r0": 0, "c0": 0, "r1": 1, "c1": 1}, "version": {}},
        headers=viewer,
    )
    assert response.status_code == 403
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == []


# ------------------------------------------------------------------ 3. 版本 / 快照 / diff


def test_merge_appears_in_version_diff_and_restore(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    client.put(
        f"/api/sheets/{sheet_id}/cells",
        json={"updates": [{"row": 2, "col": 2, "value": "x"}]},
        headers=admin_headers,
    )
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    versions = client.get(f"/api/sheets/{sheet_id}/versions", headers=admin_headers).json()["data"]
    assert versions, "合并应产生一个版本"
    merged_version = versions[0]["id"]

    # 取消合并 → 与"合并版本"对比应该只剩 merges.removed
    unmerge(client, admin_headers, sheet_id, 0, 0)
    diff = client.get(
        f"/api/sheets/{sheet_id}/versions/{merged_version}/diff", headers=admin_headers
    ).json()["data"]
    assert diff["merges"]["removed"]["total"] == 1
    assert diff["summary"]["merges"] >= 1

    # 恢复到合并版本 → 合并区域回来
    restored = client.post(
        f"/api/sheets/{sheet_id}/versions/{merged_version}/restore", headers=admin_headers
    )
    assert restored.status_code == 200, restored.text
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == [
        {"r0": 0, "c0": 0, "r1": 1, "c1": 1}
    ]


def test_merge_survives_snapshot_and_materialize(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=4, cols=4)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 2)
    snapshot = client.post(f"/api/sheets/{sheet_id}/snapshot", headers=admin_headers)
    assert snapshot.status_code == 200, snapshot.text
    version_id = snapshot.json()["data"]["version"]

    detail = client.get(
        f"/api/sheets/{sheet_id}/versions/{version_id}", headers=admin_headers
    )
    assert detail.status_code == 200, detail.text
    assert detail.json()["data"]["merges"] == [{"r0": 0, "c0": 0, "r1": 1, "c1": 2}]


def test_import_clears_merges(client, admin_headers, make_sheet):
    """整体替换（CSV/Excel 导入）会重建结构，合并区域随之清空。"""
    sheet_id = make_sheet(rows=4, cols=4)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    response = client.post(
        f"/api/sheets/{sheet_id}/import",
        json={"rows": 3, "cols": 3, "cells": {"0:0": "z"}, "formats": {}},
        headers=admin_headers,
    )
    assert response.status_code == 200, response.text
    assert get_sheet(client, admin_headers, sheet_id)["merges"] == []


# ------------------------------------------------------------------ 4. WebSocket


def test_ws_merge_broadcast_includes_merges(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    token = admin_headers["Authorization"].split()[1]
    with client.websocket_connect(f"/ws/sheets/{sheet_id}?token={token}") as ws:
        welcome = ws.receive_json()
        assert welcome["merges"] == []
        ws.send_json(
            {
                "type": "merge",
                "row_start_id": welcome["rowIds"][0],
                "col_start_id": welcome["colIds"][0],
                "row_end_id": welcome["rowIds"][1],
                "col_end_id": welcome["colIds"][1],
            }
        )
        message = ws.receive_json()
        assert message["type"] == "merge"
        assert message["merges"] == [{"r0": 0, "c0": 0, "r1": 1, "c1": 1}]

        ws.send_json({"type": "unmerge", "row_id": welcome["rowIds"][0], "col_id": welcome["colIds"][0]})
        message = ws.receive_json()
        assert message["type"] == "unmerge"
        assert message["merges"] == []


# ------------------------------------------------------------------ 5. 清理


def test_delete_sheet_removes_merges(client, admin_headers, make_sheet):
    sheet_id = make_sheet(rows=3, cols=3)
    merge(client, admin_headers, sheet_id, 0, 0, 1, 1)
    assert client.delete(f"/api/sheets/{sheet_id}", headers=admin_headers).status_code == 200
    conn = get_conn()
    rows = conn.execute("SELECT COUNT(*) AS n FROM merges WHERE sheet_id = ?", (sheet_id,)).fetchone()
    assert int(rows["n"]) == 0
