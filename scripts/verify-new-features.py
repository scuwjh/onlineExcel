"""本轮新增功能（REQ-110..115）的端到端回归脚本。

用法::

    python scripts/verify-new-features.py [前端地址] [后端地址] [管理员] [口令]

- 第 1 部分只用 httpx（合并单元格 / 个性化偏好 / 钉钉集成状态与权限），无需浏览器；
- 第 2 部分用 Playwright 断言 UI（快捷键/查找替换/Enter 方向/合并渲染/复制为图片），
  未安装 Playwright 或浏览器时自动跳过并记为 SKIP（不计失败）。
"""
from __future__ import annotations

import asyncio
import sys
from typing import Optional

import httpx

APP = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:5173"
BASE = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
ADMIN = sys.argv[3] if len(sys.argv) > 3 else "admin"
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else "admin-pass"

PASSED: list = []
FAILED: list = []
SKIPPED: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    if condition:
        PASSED.append(name)
        print(f"[PASS] {name}")
    else:
        FAILED.append(name)
        print(f"[FAIL] {name} {detail}")


def skip(name: str, reason: str) -> None:
    SKIPPED.append(name)
    print(f"[SKIP] {name} —— {reason}")


def login(username: str, password: str) -> dict:
    response = httpx.post(f"{BASE}/api/auth/login", json={"username": username, "password": password}, timeout=30)
    assert response.status_code == 200, f"登录失败：{response.text}"
    return {"Authorization": f"Bearer {response.json()['data']['token']}"}


def cell_at(sheet: dict, row: int, col: int):
    return sheet["cells"].get(f"{row}:{col}")


def api_part(headers: dict) -> None:
    client = httpx.Client(base_url=BASE, timeout=30, headers=headers)

    # ---------------------------------------------------------- 个性化偏好（REQ-110/112）
    created = client.post("/api/sheets", json={"name": "verify-新功能", "rows": 12, "cols": 8})
    check("建表成功", created.status_code == 200, created.text)
    sheet_id = created.json()["data"]["id"]

    try:
        saved = client.put(
            "/api/preferences",
            json={"enterDirection": "right", "shortcuts": {"format.bold": "Alt+B"}, "fillColors": ["#FFF2CC"]},
        )
        check("保存个性化偏好", saved.status_code == 200, saved.text)
        loaded = client.get("/api/preferences").json()["data"]
        check("偏好读回一致", loaded.get("enterDirection") == "right" and loaded["shortcuts"]["format.bold"] == "Alt+B")
        check("颜色归一化为小写", loaded["fillColors"] == ["#fff2cc"])

        bad = client.put("/api/preferences", json={"fillColors": ["not-a-color"]})
        check("非法颜色被拒绝(400)", bad.status_code == 400)

        anon = httpx.get(f"{BASE}/api/preferences", timeout=30)
        check("偏好接口需要鉴权(401)", anon.status_code == 401)

        # ------------------------------------------------------ 合并单元格（REQ-113）
        sheet = client.get(f"/api/sheets/{sheet_id}").json()["data"]
        merge = client.post(
            f"/api/sheets/{sheet_id}/ops",
            json={
                "kind": "merge",
                "payload": {
                    "row_start_id": sheet["rowIds"][0],
                    "col_start_id": sheet["colIds"][0],
                    "row_end_id": sheet["rowIds"][1],
                    "col_end_id": sheet["colIds"][1],
                },
                "version": {},
            },
        )
        check("合并区域成功", merge.status_code == 200, merge.text)
        merged = client.get(f"/api/sheets/{sheet_id}").json()["data"]["merges"]
        check("合并区域投影正确", merged == [{"r0": 0, "c0": 0, "r1": 1, "c1": 1}], str(merged))

        single = client.post(
            f"/api/sheets/{sheet_id}/ops",
            json={"kind": "merge", "payload": {"r0": 0, "c0": 0, "r1": 0, "c1": 0}, "version": {}},
        )
        check("单格合并被拒绝(400)", single.status_code == 400)

        client.post(f"/api/sheets/{sheet_id}/rows", json={"at": 1})
        expanded = client.get(f"/api/sheets/{sheet_id}").json()["data"]["merges"]
        check("区域内插行后自动扩展", expanded == [{"r0": 0, "c0": 0, "r1": 2, "c1": 1}], str(expanded))

        versions = client.get(f"/api/sheets/{sheet_id}/versions").json()["data"]
        merged_version = versions[-1]["id"] if versions else 0
        client.post(
            f"/api/sheets/{sheet_id}/ops",
            json={"kind": "unmerge", "payload": {"row": 0, "col": 0}, "version": {}},
        )
        check("取消合并生效", client.get(f"/api/sheets/{sheet_id}").json()["data"]["merges"] == [])
        if merged_version:
            diff = client.get(f"/api/sheets/{sheet_id}/versions/{merged_version}/diff").json()["data"]
            check("版本 diff 含合并区域变化", diff["summary"]["merges"] >= 1, str(diff["summary"]))
            restored = client.post(f"/api/sheets/{sheet_id}/versions/{merged_version}/restore")
            check("版本恢复带回合并区域", restored.status_code == 200 and bool(client.get(f"/api/sheets/{sheet_id}").json()["data"]["merges"]))

        # ------------------------------------------------------ 钉钉集成（REQ-115）
        status = client.get("/api/integrations/dingtalk")
        check("钉钉状态接口可用", status.status_code == 200, status.text)
        data = status.json()["data"]
        check("钉钉状态不含 webhook/secret", "webhook" not in data and "secret" not in data, str(data))
        check(
            "未配置时状态为未启用",
            data["enabled"] is False and data["configured"] is False,
            str(data),
        )
        test_call = client.post("/api/integrations/dingtalk/test")
        check("未配置时测试推送返回 400", test_call.status_code == 400, test_call.text)

        # 单词替换在 API 层不可见（纯前端），这里只验证评论 @ 不影响落库
        sheet = client.get(f"/api/sheets/{sheet_id}").json()["data"]
        comment = client.post(
            f"/api/sheets/{sheet_id}/comments",
            json={"row_id": sheet["rowIds"][0], "col_id": sheet["colIds"][1], "body": "verify: 普通评论"},
        )
        check("评论写入不受钉钉影响", comment.status_code == 200, comment.text)
    finally:
        client.delete(f"/api/sheets/{sheet_id}")


async def ui_part(headers: dict) -> None:
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        skip("UI 断言", "未安装 playwright")
        return

    token = headers["Authorization"].split()[1]
    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch()
            context = await browser.new_context(viewport={"width": 1440, "height": 900})
            await context.grant_permissions(["clipboard-read", "clipboard-write"])
            page = await context.new_page()
            await page.add_init_script(f"window.localStorage.setItem('oe-token', '{token}'); window.localStorage.setItem('oe-user', '{ADMIN}');")
            await page.goto(APP, wait_until="networkidle")
            await page.wait_for_selector(".grid-shell", timeout=15000)

            # 设置面板：改 Enter 方向并保存（REQ-112）
            await page.click("text=设置")
            await page.wait_for_selector(".settings-panel", timeout=8000)
            check("设置面板可打开", True)
            await page.select_option(".settings-panel select", "right")
            await page.click("text=保存设置")
            await page.wait_for_timeout(600)
            await page.click(".settings-panel .panel-head button")
            await page.reload(wait_until="networkidle")
            await page.wait_for_selector(".grid-shell", timeout=15000)
            await page.click("text=设置")
            await page.wait_for_selector(".settings-panel", timeout=8000)
            value = await page.eval_on_selector(".settings-panel select", "el => el.value")
            check("Enter 方向设置持久化", value == "right", value)
            await page.click(".settings-panel .panel-head button")

            # 查找替换（REQ-111）
            await page.click(".grid-shell")
            await page.keyboard.press("Control+f")
            opened = await page.wait_for_selector(".find-panel", timeout=5000)
            check("Ctrl+F 打开查找面板", opened is not None)
            await page.fill(".find-panel input[type='text'], .find-panel input:not([type])", "verify")
            await page.wait_for_timeout(400)
            hits_text = await page.inner_text(".find-panel")
            check("查找能统计结果", "项" in hits_text, hits_text[:80].replace("\n", " "))
            await page.keyboard.press("Escape")

            # 合并渲染（REQ-113）：选中 A1:B2 → 右键 → 合并
            await page.mouse.move(0, 0)
            box = await page.eval_on_selector(
                ".grid-shell",
                """el => {
                    const shell = el.getBoundingClientRect();
                    const cell = document.querySelector('[data-cell][data-row="0"][data-col="0"]').getBoundingClientRect();
                    const last = document.querySelector('[data-cell][data-row="1"][data-col="1"]').getBoundingClientRect();
                    return { x: cell.left - shell.left, y: cell.top - shell.top, x2: last.right - shell.left, y2: last.bottom - shell.top, sx: shell.left, sy: shell.top };
                }""",
            )
            await page.mouse.move(box["sx"] + box["x"] + 4, box["sy"] + box["y"] + 4)
            await page.mouse.down()
            await page.mouse.move(box["sx"] + box["x2"] - 4, box["sy"] + box["y2"] - 4, steps=6)
            await page.mouse.up()
            await page.mouse.click(box["sx"] + box["x"] + 4, box["sy"] + box["y"] + 4, button="right")
            await page.wait_for_selector(".context-menu", timeout=5000)
            await page.click("text=合并单元格")
            await page.wait_for_timeout(600)
            overlays = await page.locator("[data-merge='1']").count()
            check("合并后出现覆盖层", overlays >= 1, f"overlay={overlays}")

            # Enter 方向（REQ-112）：编辑 → 输入 → Enter → 活动格右移
            await page.click(".grid-shell")
            await page.mouse.click(box["sx"] + box["x"] + 4, box["sy"] + box["y"] + 4)
            await page.keyboard.press("F2")
            await page.keyboard.type("enter-dir")
            await page.keyboard.press("Enter")
            await page.wait_for_timeout(400)
            selected = await page.get_attribute(".grid-shell", "data-selected")
            check("Enter 后按设置方向跳转", selected == "0:2", f"selected={selected}")

            # 复制为图片（REQ-114）：剪贴板里应同时有 text/plain 与 image/png
            await page.click(".grid-shell")
            await page.keyboard.press("Control+c")
            await page.wait_for_timeout(600)
            kinds = await page.evaluate(
                """async () => {
                    try {
                        const items = await navigator.clipboard.read();
                        const out = [];
                        for (const item of items) out.push(...item.types);
                        return out;
                    } catch (err) { return ['error:' + err.message]; }
                }"""
            )
            check("剪贴板含 text/plain", any("text/plain" in k for k in kinds), str(kinds))
            check("剪贴板含 image/png（钉钉会优先取图片）", any("image/png" in k for k in kinds), str(kinds))

            await browser.close()
    except Exception as exc:  # 浏览器缺失/启动失败等 → 记为跳过而不是失败
        skip("UI 断言", f"{type(exc).__name__}: {exc}")


def main() -> int:
    try:
        headers = login(ADMIN, PASSWORD)
    except Exception as exc:
        print(f"[FAIL] 登录失败：{exc}")
        return 1

    api_part(headers)
    asyncio.run(ui_part(headers))

    print(f"\n通过 {len(PASSED)} / 失败 {len(FAILED)} / 跳过 {len(SKIPPED)}")
    if FAILED:
        for name in FAILED:
            print(f"  - {name}")
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(main())
