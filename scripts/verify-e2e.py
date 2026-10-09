"""端到端验证脚本：真实 HTTP + WebSocket 服务下的协同与鉴权链路。

用法
----
1. 先启动后端（默认 http://127.0.0.1:8000）：

       cd backend && uvicorn app.main:app

2. 运行本脚本：

       pip install httpx websockets
       python scripts/verify-e2e.py http://127.0.0.1:8000 <管理员用户名> <管理员口令>

覆盖的断言（约 40 项）
---------------------
- 鉴权：匿名 401、非法令牌 401、带令牌 200；
- 权限：未授权 403、owner 授权、viewer 只读（REST + WebSocket 双通道）、撤销权限后立即失效；
- 大表格：10 万行建表、稳定行列 ID、WebSocket 走 reload 退化路径、写入落库；
- 协同：双端写入互见、因果在后的 LWW 胜出、并发插入同一行位置两行都保留、行序收敛一致；
- 版本：增量存储（单版本 < 2KB、无整表快照堆积）、单元格级 diff、恢复、回退；
- 输入校验：建表行列被夹取到上限。
"""
from __future__ import annotations

import asyncio
import json
import sys

import httpx
import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8000"
ADMIN = sys.argv[2] if len(sys.argv) > 2 else "admin"
PASSWORD = sys.argv[3] if len(sys.argv) > 3 else "admin-pass"

PASSED: list = []
FAILED: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASSED if condition else FAILED).append(name)
    mark = "PASS" if condition else "FAIL"
    suffix = f" -> {detail}" if detail and not condition else ""
    print(f"[{mark}] {name}{suffix}", flush=True)


def login(username: str, password: str) -> str:
    response = httpx.post(f"{BASE}/api/auth/login", json={"username": username, "password": password}, timeout=30)
    response.raise_for_status()
    return response.json()["data"]["token"]


def new_sheet(headers: dict, name: str, rows: int, cols: int) -> dict:
    created = httpx.post(
        f"{BASE}/api/sheets", json={"name": name, "rows": rows, "cols": cols}, headers=headers, timeout=180
    )
    assert created.status_code == 200, created.text
    sheet_id = created.json()["data"]["id"]
    fetched = httpx.get(f"{BASE}/api/sheets/{sheet_id}", headers=headers, timeout=180)
    assert fetched.status_code == 200, fetched.text
    return fetched.json()["data"]


async def recv_until(ws, wanted: set, timeout: float = 10.0):
    """读取消息直到出现目标类型（跳过 presence/cursor 等干扰）。"""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"等待 {wanted} 超时")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        message = json.loads(raw)
        if message.get("type") in wanted:
            return message


async def main() -> int:
    admin_token = login(ADMIN, PASSWORD)
    admin_headers = {"Authorization": f"Bearer {admin_token}"}
    ws_base = BASE.replace("http://", "ws://").replace("https://", "wss://")

    # ---------------------------------------------------------------- 1) 鉴权
    check("匿名访问被拒绝(401)", httpx.get(f"{BASE}/api/sheets", timeout=30).status_code == 401)
    check(
        "带令牌可访问(200)",
        httpx.get(f"{BASE}/api/sheets", headers=admin_headers, timeout=30).status_code == 200,
    )
    check(
        "非法令牌被拒绝(401)",
        httpx.get(f"{BASE}/api/sheets", headers={"Authorization": "Bearer nope"}, timeout=30).status_code == 401,
    )

    # ------------------------------------------------------- 2) 万行表格与权限
    big = new_sheet(admin_headers, "万行表格", 100000, 26)
    check("万行表格结构正确", big["rows"] == 100000 and big["cols"] == 26, f"{big['rows']}x{big['cols']}")
    check("返回稳定行列 ID", len(big["rowIds"]) == 100000 and len(big["colIds"]) == 26)

    viewer_token = login("verify-viewer", "viewer-pass")
    viewer_headers = {"Authorization": f"Bearer {viewer_token}"}
    check(
        "未授权用户读取被拒绝(403)",
        httpx.get(f"{BASE}/api/sheets/{big['id']}", headers=viewer_headers, timeout=30).status_code == 403,
    )
    check(
        "owner 授予 viewer 成功",
        httpx.put(
            f"{BASE}/api/sheets/{big['id']}/permissions",
            json={"username": "verify-viewer", "role": "viewer"},
            headers=admin_headers,
            timeout=30,
        ).status_code
        == 200,
    )
    check(
        "viewer 可读(200)",
        httpx.get(f"{BASE}/api/sheets/{big['id']}", headers=viewer_headers, timeout=120).status_code == 200,
    )
    check(
        "viewer 写入被拒绝(403)",
        httpx.put(
            f"{BASE}/api/sheets/{big['id']}/cells",
            json={"updates": [{"row": 0, "col": 0, "value": "x"}]},
            headers=viewer_headers,
            timeout=30,
        ).status_code
        == 403,
    )
    access = httpx.get(f"{BASE}/api/sheets/{big['id']}/access", headers=viewer_headers, timeout=30).json()["data"]
    check("access 返回 viewer 且不可编辑", access["role"] == "viewer" and access["can_edit"] is False, json.dumps(access))
    check(
        "对不存在的表格授权返回 404",
        httpx.put(
            f"{BASE}/api/sheets/__placeholder__/permissions",
            json={"username": "verify-viewer", "role": "viewer"},
            headers=admin_headers,
            timeout=30,
        ).status_code
        == 404,
    )

    # ------------------------------------ 3) 大表格 WebSocket 走 reload 退化路径
    async with websockets.connect(f"{ws_base}/ws/sheets/{big['id']}?token={admin_token}") as ws:
        welcome = await recv_until(ws, {"welcome"})
        check("大表格 welcome 触发 reload", welcome.get("reload") is True, json.dumps(welcome)[:160])
        check("大表格 welcome 不含全量投影", "cells" not in welcome and "rowIds" not in welcome)
        await ws.send(
            json.dumps({"type": "cell_update", "row": 5, "col": 3, "value": "big-write", "client_id": "verify-big"})
        )
        echo = await recv_until(ws, {"cell_update"})
        check(
            "大表格写入回执可用",
            echo.get("reload") is True or echo.get("cells", {}).get("5:3") == "big-write",
            json.dumps(echo)[:200],
        )
    persisted = httpx.get(f"{BASE}/api/sheets/{big['id']}", headers=admin_headers, timeout=120).json()["data"]
    check("大表格写入已持久化", persisted["cells"].get("5:3") == "big-write", json.dumps(persisted["cells"])[:120])

    # ------------------------------------------- 4) 小表格：双端协同与收敛
    small = new_sheet(admin_headers, "小表格", 20, 5)
    row_id, col_id = small["rowIds"][0], small["colIds"][0]
    httpx.put(
        f"{BASE}/api/sheets/{small['id']}/permissions",
        json={"username": "verify-viewer", "role": "viewer"},
        headers=admin_headers,
        timeout=30,
    )

    async with websockets.connect(f"{ws_base}/ws/sheets/{small['id']}?token={admin_token}") as a:
        welcome_a = await recv_until(a, {"welcome"})
        check("WS 握手拿到 welcome(owner)", welcome_a.get("role") == "owner", json.dumps(welcome_a)[:120])
        check("小表格 welcome 含结构", bool(welcome_a.get("rowIds")))

        async with websockets.connect(f"{ws_base}/ws/sheets/{small['id']}?token={admin_token}") as b:
            check("第二个客户端加入成功", bool((await recv_until(b, {"welcome"})).get("rowIds")))
            await recv_until(a, {"presence"})

            await a.send(
                json.dumps(
                    {
                        "type": "cell_update",
                        "row_id": row_id,
                        "col_id": col_id,
                        "value": "from-a",
                        "client_id": "verify-a",
                        "version": {"verify-a": 1},
                    }
                )
            )
            got_a = await recv_until(a, {"cell_update"})
            got_b = await recv_until(b, {"cell_update"})
            check("A 的写入回执给 A", got_a["cells"].get("0:0") == "from-a", json.dumps(got_a.get("cells"))[:120])
            check("A 的写入广播给 B", got_b["cells"].get("0:0") == "from-a", json.dumps(got_b.get("cells"))[:120])

            await b.send(
                json.dumps(
                    {
                        "type": "cell_update",
                        "row_id": row_id,
                        "col_id": col_id,
                        "value": "from-b-after",
                        "client_id": "verify-b",
                        "version": {"verify-a": got_a["seq"]},
                    }
                )
            )
            final_a = await recv_until(a, {"cell_update"})
            final_b = await recv_until(b, {"cell_update"})
            check("LWW：因果在后胜出", final_a["cells"].get("0:0") == "from-b-after", str(final_a["cells"])[:120])
            check("LWW：两端一致", final_b["cells"] == final_a["cells"])

            await a.send(json.dumps({"type": "row_insert", "at": 0, "counter": 1, "client_id": "verify-a"}))
            await recv_until(a, {"row_insert"})
            await recv_until(b, {"row_insert"})
            await b.send(json.dumps({"type": "row_insert", "at": 0, "counter": 1, "client_id": "verify-b"}))
            insert_b = await recv_until(b, {"row_insert"})
            broadcast = await recv_until(a, {"row_insert"})
            check("并发同位置插入保留两行", broadcast["rows"] == 22, str(broadcast.get("rows")))
            check(
                "两端行序收敛一致",
                broadcast["rowIds"] == insert_b["rowIds"],
                f"A[0:3]={broadcast['rowIds'][:3]} B[0:3]={insert_b['rowIds'][:3]}",
            )
            check(
                "两次插入的元素 ID 都保留",
                {"verify-a:r1", "verify-b:r1"}.issubset(set(broadcast["rowIds"][:2])),
                str(broadcast["rowIds"][:3]),
            )
            rest = httpx.get(f"{BASE}/api/sheets/{small['id']}", headers=admin_headers, timeout=30).json()["data"]
            check(
                "REST 复核与 WS 状态一致",
                rest["rowIds"] == broadcast["rowIds"] and rest["rows"] == broadcast["rows"],
                f"rest={rest['rows']} ws={broadcast['rows']}",
            )

            async with websockets.connect(f"{ws_base}/ws/sheets/{small['id']}?token={viewer_token}") as v:
                await recv_until(v, {"welcome"})
                await v.send(json.dumps({"type": "cell_update", "row": 0, "col": 0, "value": "nope"}))
                deny = await recv_until(v, {"error"})
                check("WS 中 viewer 写入被拒", deny.get("code") == "forbidden", json.dumps(deny)[:120])

        try:
            async with websockets.connect(f"{ws_base}/ws/sheets/{small['id']}?token=bad-token"):
                check("WS 无有效令牌被拒", False, "连接竟然成功")
        except Exception as exc:  # noqa: BLE001
            check("WS 无有效令牌被拒", True, type(exc).__name__)

    # ------------------------------------------------- 5) 权限收紧后立即生效
    check(
        "owner 可撤销权限",
        httpx.delete(
            f"{BASE}/api/sheets/{big['id']}/permissions/verify-viewer", headers=admin_headers, timeout=30
        ).status_code
        == 200,
    )
    check(
        "撤销后 viewer 读取被拒(403)",
        httpx.get(f"{BASE}/api/sheets/{big['id']}", headers=viewer_headers, timeout=30).status_code == 403,
    )

    # ---------------------------------------------- 6) 版本：增量存储 / diff / 恢复
    for index in range(5):
        httpx.put(
            f"{BASE}/api/sheets/{small['id']}/cells",
            json={"updates": [{"row_id": row_id, "col_id": col_id, "value": f"rest-{index}"}]},
            headers=admin_headers,
            timeout=30,
        )
    versions = httpx.get(
        f"{BASE}/api/sheets/{small['id']}/versions?limit=10", headers=admin_headers, timeout=30
    ).json()["data"]
    check("版本列表可读", len(versions) >= 5, str(len(versions)))
    check(
        "单版本增量体积可控(<2KB)",
        max((v["ops_bytes"] or 0) for v in versions) < 2048,
        f"{max((v['ops_bytes'] or 0) for v in versions)}B",
    )
    check(
        "没有整表快照堆积",
        sum(v["snapshot_bytes"] or 0 for v in versions) < 20000,
        f"{sum(v['snapshot_bytes'] or 0 for v in versions)}B",
    )

    oldest = versions[-1]["id"]
    diff = httpx.get(f"{BASE}/api/sheets/{small['id']}/versions/{oldest}/diff", headers=admin_headers, timeout=60)
    check("版本 diff 可读(200)", diff.status_code == 200, diff.text[:200])
    if diff.status_code == 200:
        summary = diff.json()["data"]["summary"]
        check(
            "diff 报告出变更项",
            summary["added"] + summary["changed"] + summary["removed"] > 0,
            json.dumps(summary),
        )
    check(
        "版本恢复成功",
        httpx.post(
            f"{BASE}/api/sheets/{small['id']}/versions/{oldest}/restore", headers=admin_headers, timeout=60
        ).status_code
        == 200,
    )
    check(
        "回退一步成功",
        httpx.post(f"{BASE}/api/sheets/{small['id']}/rollback?steps=1", headers=admin_headers, timeout=60).status_code
        == 200,
    )

    # ------------------------------------------------------------- 7) 输入校验
    overflow = httpx.post(
        f"{BASE}/api/sheets", json={"name": "超限", "rows": 999999, "cols": 5}, headers=admin_headers, timeout=180
    )
    check("创建表格时行列被夹取到上限", overflow.status_code == 200, overflow.text[:160])
    if overflow.status_code == 200:
        clamped = httpx.get(
            f"{BASE}/api/sheets/{overflow.json()['data']['id']}", headers=admin_headers, timeout=180
        ).json()["data"]
        check("夹取后行数为上限", clamped["rows"] == 100000, str(clamped["rows"]))

    print(f"\n结果：{len(PASSED)} 通过 / {len(FAILED)} 失败", flush=True)
    if FAILED:
        print("失败项：" + ", ".join(FAILED), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
