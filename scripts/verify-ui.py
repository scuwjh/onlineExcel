"""浏览器端端到端验证：登录、网格渲染、协同编辑、撤销/重做、版本面板、大表格虚拟滚动。

前提
----
1. 后端运行在 ``http://127.0.0.1:8000``（``cd backend && uvicorn app.main:app``）；
2. 前端开发服务器运行在 ``http://localhost:5173``（``cd frontend && npm run dev``，已代理 /api 与 /ws）；
3. 安装依赖：``pip install playwright httpx && playwright install msedge``。

默认使用系统已安装的 Microsoft Edge（``channel="msedge"``），不额外下载浏览器。
运行：

    python scripts/verify-ui.py [APP_URL] [API_URL] [管理员用户名] [管理员口令]
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import httpx
from playwright.async_api import async_playwright

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
API = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
ADMIN = sys.argv[3] if len(sys.argv) > 3 else "admin"
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else "admin-pass"
#: 截图输出目录（已在 .gitignore 中忽略，避免测试产物污染工作区）
SHOT_DIR = Path(__file__).resolve().parent / "artifacts"
SHOT_DIR.mkdir(parents=True, exist_ok=True)

PASSED: list = []
FAILED: list = []


def check(name: str, condition: bool, detail: str = "") -> None:
    (PASSED if condition else FAILED).append(name)
    mark = "PASS" if condition else "FAIL"
    suffix = f" -> {detail}" if detail and not condition else ""
    print(f"[{mark}] {name}{suffix}", flush=True)


async def login(page, username: str, password: str = "pw123456", expect_grid: bool = True) -> None:
    await page.goto(APP, wait_until="domcontentloaded")
    try:
        await page.wait_for_selector(".login-card", timeout=8000)
    except Exception:
        # 同一浏览器上下文已登录（localStorage 共享），直接进入工作区
        await page.wait_for_selector(".grid-shell", timeout=20000)
        return
    await page.fill('input[autocomplete="username"]', username)
    await page.fill('input[type="password"]', password)
    await page.click('button[type="submit"]')
    if expect_grid:
        await page.wait_for_selector(".grid-shell", timeout=30000)
    else:
        # 无任何表格授权的账号：停在"请选择或新建一个表格"的状态
        await page.wait_for_selector(".loading", timeout=30000)


async def cell_text(page, row: int, col: int) -> str:
    locator = page.locator(f'[data-cell][data-row="{row}"][data-col="{col}"]')
    await locator.scroll_into_view_if_needed(timeout=15000)
    return (await locator.inner_text()).strip()


async def click_cell(page, row: int, col: int) -> None:
    locator = page.locator(f'[data-cell][data-row="{row}"][data-col="{col}"]')
    await locator.scroll_into_view_if_needed(timeout=15000)
    await locator.click()


async def main() -> int:
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(channel="msedge", headless=True)
        context = await browser.new_context(
            viewport={"width": 1440, "height": 900},
            permissions=["clipboard-read", "clipboard-write"],
        )
        page = await context.new_page()
        errors: list = []
        page.on("pageerror", lambda exc: errors.append(str(exc)))

        # ------------------------------------------------------------ 登录界面
        await page.goto(APP, wait_until="domcontentloaded")
        await page.wait_for_selector(".login-card", timeout=20000)
        check("登录界面渲染", await page.is_visible(".login-card"))
        await page.screenshot(path=str(SHOT_DIR / "shot-login.png"))

        await page.fill('input[autocomplete="username"]', ADMIN)
        await page.fill('input[type="password"]', PASSWORD)
        await page.click('button[type="submit"]')
        await page.wait_for_selector(".grid-shell", timeout=30000)
        check("登录后进入工作区", await page.is_visible(".grid-shell"))
        check("工具栏渲染", await page.is_visible(".toolbar"))
        check("公式栏渲染", await page.is_visible(".formula-bar"))

        status = await page.inner_text(".grid-status")
        check("状态栏显示行数", "共" in status and "行" in status, status)

        # --------------------------------------------------- 虚拟滚动（DOM 恒定）
        cell_count = await page.locator("[data-cell]").count()
        check("虚拟滚动：DOM 单元格数量受控(<3000)", 0 < cell_count < 3000, f"{cell_count} 个")

        # ----------------------------------------------------------- 单元格编辑
        # 用时间戳保证每轮都产生真实变更（避免上次残留值让写入成为 no-op）
        stamp = str(int(asyncio.get_event_loop().time() * 1000) % 100000)
        await click_cell(page, 2, 1)
        await page.keyboard.press("F2")
        await page.keyboard.type(f"e2e-{stamp}")
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(1500)
        text = await cell_text(page, 2, 1)
        check("单元格编辑生效", text == f"e2e-{stamp}", text)

        token = httpx.post(
            f"{API}/api/auth/login", json={"username": ADMIN, "password": PASSWORD}, timeout=20
        ).json()["data"]["token"]
        headers = {"Authorization": f"Bearer {token}"}
        sheets = httpx.get(f"{API}/api/sheets", headers=headers, timeout=20).json()["data"]
        sheet_id = sheets[0]["id"]
        persisted = httpx.get(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=30).json()["data"]
        check("编辑已持久化到服务端", f"e2e-{stamp}" in persisted["cells"].values(), json.dumps(persisted["cells"])[:120])

        # ------------------------------------------------------------- 公式求值
        await click_cell(page, 0, 0)
        await page.keyboard.type("3")
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(700)
        await click_cell(page, 1, 0)
        await page.keyboard.type("4")
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(700)
        await click_cell(page, 2, 0)
        await page.keyboard.type("=SUM(A1:A2)")
        await page.keyboard.press("Enter")
        await page.wait_for_timeout(900)
        sum_text = await cell_text(page, 2, 0)
        check("公式 SUM 前端求值", sum_text == "7", sum_text)

        # ---------------------------------------------------------- 撤销 / 重做
        # 依次撤销三次写入（A1、A2、A3），应回到公式写入之前
        for _ in range(3):
            await page.keyboard.press("Control+z")
            await page.wait_for_timeout(1200)
        after_undo = await cell_text(page, 2, 0)
        check("连续撤销回到写入前", after_undo != "7", after_undo)
        for _ in range(3):
            await page.keyboard.press("Control+Shift+z")
            await page.wait_for_timeout(1200)
        after_redo = await cell_text(page, 2, 0)
        check("连续重做恢复公式结果", after_redo == "7", after_redo)

        # -------------------------------------------------------------- 行列操作
        await page.click('button[title="在选中行上方插入行"]')
        await page.wait_for_timeout(1200)
        check("插入行后渲染正常", await page.locator(".grid-shell").is_visible())

        # ------------------------------------------------------ 剪贴板批量粘贴
        await click_cell(page, 5, 3)
        await page.evaluate("async () => { await navigator.clipboard.writeText('a\\tb\\nc\\td'); }")
        await page.keyboard.press("Control+v")
        await page.wait_for_timeout(1500)
        pasted = await cell_text(page, 6, 4)
        check("剪贴板批量粘贴", pasted == "d", pasted)

        # ---------------------------------------------------------- 历史版本面板
        await page.click('button[title="查看历史版本与对比"]')
        await page.wait_for_selector(".panel", timeout=15000)
        version_items = await page.locator(".version-item").count()
        check("版本面板列出历史", version_items > 0, f"{version_items} 条")
        await page.locator(".version-item").last.locator('button:has-text("与当前对比")').click()
        await page.wait_for_selector(".diff-head", timeout=20000)
        diff_text = await page.inner_text(".panel-diff")
        check("版本 diff 展示差异", "→" in diff_text or "新增" in diff_text or "修改" in diff_text, diff_text[:80])
        await page.screenshot(path=str(SHOT_DIR / "shot-versions.png"))
        await page.click('.panel-head button:has-text("关闭")')
        await page.wait_for_timeout(400)

        # ---------------------------------------------------------- 成员权限面板
        await page.click('button[title="成员与角色管理"]')
        await page.wait_for_selector(".perm-table", timeout=15000)
        perm_rows = await page.locator(".perm-table tbody tr").count()
        check("权限面板列出成员", perm_rows > 0, f"{perm_rows} 行")
        await page.screenshot(path=str(SHOT_DIR / "shot-permissions.png"))
        await page.click('.panel-head button:has-text("关闭")')
        await page.wait_for_timeout(400)

        # ------------------------------------------------------------ 大表格滚动
        await page.click('button[title="新建表格"]')
        await page.wait_for_timeout(3000)
        cells_before = await page.locator("[data-cell]").count()
        status_big = await page.inner_text(".grid-status")
        await page.evaluate("() => { const el = document.querySelector('.grid-scroll'); if (el) el.scrollTop = 20000; }")
        await page.wait_for_timeout(1500)
        cells_after = await page.locator("[data-cell]").count()
        check("大表格滚动后 DOM 仍受控", 0 < cells_after < 3000, f"{cells_after} 个")
        check("大表格状态栏行数正确", "1,000" in status_big or "1000" in status_big, status_big)
        check("滚动前后渲染规模稳定", abs(cells_after - cells_before) < 600, f"{cells_before} -> {cells_after}")
        await page.screenshot(path=str(SHOT_DIR / "shot-bigsheet.png"))

        # ------------------------------------------------------- 无权限用户空态
        peer_context = await browser.new_context(viewport={"width": 1100, "height": 700})
        page2 = await peer_context.new_page()
        await login(page2, "verify-peer", expect_grid=False)
        peer_grid = await page2.locator(".grid-shell").count()
        peer_hint = await page2.locator(".loading").count()
        check("无权限用户看到空态提示", peer_grid == 0 and peer_hint > 0, f"grid={peer_grid} hint={peer_hint}")

        # --------------------------------------------------------- 双标签实时同步
        page3 = await context.new_page()
        await login(page3, ADMIN, PASSWORD)
        await page3.wait_for_timeout(2500)
        # 两个标签显式打开同一张表（第一张），避免"最近更新"排序带来的歧义
        for target in (page3, page):
            await target.locator(".sheet-tab").first.click()
            await target.wait_for_timeout(1200)
        check(
            "两个标签视图一致",
            (await page.inner_text(".sheet-name")) == (await page3.inner_text(".sheet-name")),
            f"{await page.inner_text('.sheet-name')} / {await page3.inner_text('.sheet-name')}",
        )
        # 回到顶部，确保目标单元格落在虚拟窗口内
        for target in (page, page3):
            await target.evaluate(
                "() => { const el = document.querySelector('.grid-scroll'); if (el) { el.scrollTop = 0; el.scrollLeft = 0; } }"
            )
            await target.wait_for_timeout(600)
        await click_cell(page3, 8, 2)
        await page3.keyboard.type("sync-check")
        await page3.keyboard.press("Enter")
        await page3.wait_for_timeout(2500)
        synced = await cell_text(page, 8, 2)
        check("第二个标签的编辑实时同步到第一个标签", synced == "sync-check", synced)
        presence = await page.inner_text(".presence-bar")
        check("在线名单已更新", "在线" in presence, presence)

        check("前端无未捕获异常", not errors, "; ".join(errors[:3]))

        await page.screenshot(path=str(SHOT_DIR / "shot-main.png"))
        await browser.close()

    print(f"\n结果：{len(PASSED)} 通过 / {len(FAILED)} 失败", flush=True)
    if FAILED:
        print("失败项：" + ", ".join(FAILED), flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
