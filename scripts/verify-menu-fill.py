"""右键菜单（REQ-005）与拖拽填充（REQ-006）的浏览器联动验证。

用法::

    python scripts/verify-menu-fill.py [前端地址] [后端地址] [管理员] [口令]

脚本自建临时表格并在结束时删除。
"""
from __future__ import annotations

import asyncio
import sys
from pathlib import Path

import httpx
from playwright.async_api import async_playwright

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
API = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
ADMIN = sys.argv[3] if len(sys.argv) > 3 else "admin"
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else "admin-pass"
SHOT = Path(__file__).resolve().parent / "artifacts"
SHOT.mkdir(parents=True, exist_ok=True)
SHEET = "verify-menu-fill-临时表"

PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail and not ok else ''}", flush=True)


async def login(page, username: str, password: str) -> None:
    await page.goto(APP, wait_until="domcontentloaded")
    try:
        await page.wait_for_selector(".login-card", timeout=8000)
    except Exception:
        await page.wait_for_selector(".grid-shell", timeout=20000)
        return
    await page.fill('input[autocomplete="username"]', username)
    await page.fill('input[type="password"]', password)
    await page.click('button[type="submit"]')
    await page.wait_for_selector(".grid-shell", timeout=30000)


async def main() -> int:
    token = httpx.post(
        f"{API}/api/auth/login", json={"username": ADMIN, "password": PASSWORD}, timeout=30
    ).json()["data"]["token"]
    headers = {"Authorization": f"Bearer {token}"}
    sheet_id = httpx.post(
        f"{API}/api/sheets", json={"name": SHEET, "rows": 20, "cols": 8}, headers=headers, timeout=60
    ).json()["data"]["id"]
    cells = {
        "0:0": "序号", "0:1": "金额", "0:2": "日期", "0:3": "名称",
        "1:0": "1", "1:1": "100", "1:2": "2026-01-01", "1:3": "甲",
        "2:0": "", "2:1": "", "2:2": "", "2:3": "",
    }
    httpx.post(
        f"{API}/api/sheets/{sheet_id}/import",
        json={"rows": 20, "cols": 8, "cells": cells},
        headers=headers,
        timeout=60,
    )

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="msedge", headless=True)
            page = await browser.new_page(viewport={"width": 1500, "height": 950})
            errors: list = []
            page.on("pageerror", lambda exc: errors.append(str(exc)))

            await login(page, ADMIN, PASSWORD)
            await page.locator(f'.sheet-tab:has-text("{SHEET}")').first.click()
            await page.wait_for_timeout(2500)
            check("打开临时表格", SHEET in (await page.inner_text(".sheet-name")))

            async def wait_until(predicate, timeout_ms: int = 8000, interval_ms: int = 250) -> bool:
                """轮询等待条件成立。

                写入走 WebSocket、回执带权威投影返回，耗时不确定；
                用固定 sleep 断言会偶发失败（曾把"清空内容可撤销"误判为失败）。
                """
                waited = 0
                while waited <= timeout_ms:
                    if await predicate():
                        return True
                    await page.wait_for_timeout(interval_ms)
                    waited += interval_ms
                return False

            async def _is(factory, expected):
                """factory 是"调用后返回协程"的无参函数（如 lambda: cell_text(1, 3)）。"""
                return (await factory()) == expected

            async def _all(*pairs) -> bool:
                """pairs 为 (factory, expected) 交替出现。"""
                for index in range(0, len(pairs), 2):
                    if (await pairs[index]()) != pairs[index + 1]:
                        return False
                return True

            async def server_cell(row: int, col: int):
                data = httpx.get(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60).json()["data"]
                return data["cells"].get(f"{row}:{col}")

            async def cell_text(row: int, col: int) -> str:
                return await page.evaluate(
                    """([r, c]) => document.querySelector(`[data-cell][data-row="${r}"][data-col="${c}"]`)?.innerText.trim() ?? ''""",
                    [row, col],
                )

            async def open_menu_on(row: int, col: int) -> None:
                loc = page.locator(f'[data-cell][data-row="{row}"][data-col="{col}"]')
                await loc.scroll_into_view_if_needed(timeout=15000)
                await loc.click(button="right")
                await page.wait_for_selector(".context-menu", timeout=10000)

            async def menu_labels() -> list:
                return await page.evaluate(
                    "() => [...document.querySelectorAll('.context-menu .menu-item .menu-label')].map((e) => e.innerText.trim())"
                )

            # ==================================================== REQ-005 右键菜单
            await open_menu_on(1, 0)
            labels = await menu_labels()
            check(
                "单元格右键菜单出现且含常用项",
                any("复制" in l for l in labels) and any("清空内容" in l for l in labels) and any("删除选中行" in l for l in labels),
                str(labels[:10]),
            )
            check("菜单含数字格式项", any("货币" in l for l in labels), str(labels))

            # 关闭：点菜单外
            await page.mouse.click(700, 700)
            await page.wait_for_timeout(300)
            check("点击外部关闭菜单", await page.locator(".context-menu").count() == 0)

            # Esc 关闭
            await open_menu_on(1, 0)
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(300)
            check("Esc 关闭菜单", await page.locator(".context-menu").count() == 0)

            # 右键单元格 → 选中该格（Excel 语义）
            await open_menu_on(3, 2)
            selected = await page.evaluate("() => document.querySelector('.grid-shell').dataset.selected")
            check("右键会先选中该单元格", selected == "3:2", str(selected))
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(200)

            # 菜单里清空内容
            await page.locator('[data-cell][data-row="1"][data-col="3"]').click()
            await page.wait_for_timeout(200)
            await open_menu_on(1, 3)
            await page.locator('.context-menu .menu-item:has-text("清空内容")').click()
            await page.wait_for_timeout(1200)
            check("右键清空内容生效", await cell_text(1, 3) == "", await cell_text(1, 3))
            await page.keyboard.press("Control+z")
            restored = await wait_until(lambda: _is(lambda: cell_text(1, 3), "甲"))
            check("清空内容可撤销", restored, await cell_text(1, 3))

            # 菜单里套用数字格式（货币）
            await page.locator('[data-cell][data-row="1"][data-col="1"]').click()
            await page.wait_for_timeout(200)
            await open_menu_on(1, 1)
            await page.locator('.context-menu .menu-item:has-text("数字格式：货币")').click()
            await page.wait_for_timeout(1200)
            money = await cell_text(1, 1)
            check("右键套用货币格式", "¥" in money, money)

            # 行号右键：插入/删除行（先记下插入前的行数作为撤销基准）
            rows_before_insert = await page.evaluate(
                """() => Number((document.querySelector('.grid-status').innerText.match(/共\\s*(\\d+)\\s*行/) || [0, 0])[1])"""
            )
            row_head = page.locator('[data-row-head="2"]').first
            await row_head.scroll_into_view_if_needed(timeout=10000)
            await row_head.click(button="right")
            await page.wait_for_selector(".context-menu", timeout=10000)
            row_labels = await menu_labels()
            check(
                "行号右键菜单含插入/删除行",
                any("在上方插入行" in l for l in row_labels) and any("删除选中行" in l for l in row_labels),
                str(row_labels),
            )
            await page.locator('.context-menu .menu-item:has-text("在上方插入行")').click()
            await page.wait_for_timeout(1800)
            # 被点的行号是第 3 行（索引 2）：插入后原内容"被下推"到索引 3，
            # 同时该行仍是空行（新插入的行）
            after_insert = [await cell_text(r, 0) for r in range(0, 4)]
            # 插入前 A2='1'、A3=''；在第 3 行上方插入后 A2='1'、A3=''（新空行）、A4=''
            check(
                "行号右键在上方插入行",
                after_insert[0] == "序号" and after_insert[1] == "1",
                str(after_insert),
            )
            # 撤销：行数应回到插入前
            await page.keyboard.press("Control+z")
            await page.wait_for_timeout(2500)
            rows_after_undo = await page.evaluate(
                """() => Number((document.querySelector('.grid-status').innerText.match(/共\\s*(\\d+)\\s*行/) || [0, 0])[1])"""
            )
            undone_values = [await cell_text(r, 0) for r in range(0, 3)]
            check(
                "插入行可撤销",
                rows_after_undo == rows_before_insert and undone_values[1] == "1",
                f"before={rows_before_insert} after={rows_after_undo} values={undone_values}",
            )

            # 列标右键
            col_head = page.locator('[data-col-head="2"]').first
            await col_head.click(button="right")
            await page.wait_for_selector(".context-menu", timeout=10000)
            col_labels = await menu_labels()
            check(
                "列标右键菜单含插入/删除列",
                any("在左侧插入列" in l for l in col_labels) and any("删除选中列" in l for l in col_labels),
                str(col_labels),
            )
            await page.keyboard.press("Escape")
            await page.wait_for_timeout(300)

            # ==================================================== REQ-006 拖拽填充
            #
            # 前面的插入行/撤销会让行号位移，所以每次填充前都先用 REST 把已知数据
            # 重新铺到固定位置（并重新打开表格以拿到权威状态），避免断言受历史影响。
            FILL_CELLS = {
                "0:0": "序号", "0:1": "金额", "0:2": "日期", "0:3": "名称",
                "1:0": "1", "1:1": "100", "1:2": "2026-01-01", "1:3": "甲",
                "2:0": "3", "2:1": "", "2:2": "", "2:3": "",
            }

            async def reset_data() -> None:
                response = httpx.post(
                    f"{API}/api/sheets/{sheet_id}/import",
                    json={"rows": 20, "cols": 8, "cells": FILL_CELLS},
                    headers=headers,
                    timeout=60,
                )
                assert response.status_code == 200, f"重置数据失败：{response.status_code} {response.text[:200]}"
                await page.reload(wait_until="domcontentloaded")
                await page.wait_for_selector(".grid-shell", timeout=30000)
                await page.locator(f'.sheet-tab:has-text("{SHEET}")').first.click()
                await page.wait_for_timeout(2000)
                # 确认页面拿到的是重置后的数据（防止断言读到旧状态）
                actual = await page.evaluate(
                    """() => [1, 2].map((r) => document.querySelector(`[data-cell][data-row="${r}"][data-col="0"]`)?.innerText.trim())"""
                )
                assert actual == ["1", "3"], f"重置后 A2:A3 应为 ['1','3']，实际 {actual}"

            async def drag_fill(from_row: int, from_col: int, to_row: int, to_col: int, source_rows: int = 1) -> None:
                """从 (from_row, from_col) 的选区右下角拖到目标格。

                `source_rows` > 1 时先用 Shift+方向键把源区域扩成多行——
                只有源区域真的多行，填充才会按"相邻差值"延续（Excel 语义）。
                """
                await page.locator(f'[data-cell][data-row="{from_row}"][data-col="{from_col}"]').click()
                await page.wait_for_timeout(250)
                for _ in range(source_rows - 1):
                    await page.keyboard.press("Shift+ArrowDown")
                    await page.wait_for_timeout(150)
                await page.wait_for_timeout(250)
                box = await page.locator("[data-fill-handle]").first.bounding_box()
                target_box = await page.locator(f'[data-cell][data-row="{to_row}"][data-col="{to_col}"]').bounding_box()
                await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
                await page.mouse.down()
                await page.mouse.move(
                    target_box["x"] + target_box["width"] / 2,
                    target_box["y"] + target_box["height"] / 2,
                    steps=10,
                )
                await page.mouse.up()
                await page.wait_for_timeout(1600)

            await reset_data()
            await page.locator('[data-cell][data-row="1"][data-col="0"]').click()
            await page.wait_for_timeout(300)
            check("填充柄出现", await page.locator("[data-fill-handle]").count() > 0)

            # 拖拽中显示预览
            box = await page.locator("[data-fill-handle]").first.bounding_box()
            target_box = await page.locator('[data-cell][data-row="4"][data-col="0"]').bounding_box()
            await page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            await page.mouse.down()
            await page.mouse.move(
                target_box["x"] + target_box["width"] / 2, target_box["y"] + target_box["height"] / 2, steps=10
            )
            await page.wait_for_timeout(250)
            check("拖拽时显示填充预览", await page.evaluate("() => document.querySelectorAll('.fill-preview').length") == 1)
            await page.mouse.up()
            await page.wait_for_timeout(1600)
            series = [await cell_text(r, 0) for r in range(1, 5)]
            check("单格数字向下填充（1 → 2,3,4）", series == ["1", "2", "3", "4"], str(series))

            # 两格等差：选中 A2:A3（1,3）后拖到 A4 → 应延续为 5
            await reset_data()
            before_fill = [await cell_text(r, 0) for r in range(1, 4)]
            await drag_fill(1, 0, 3, 0, source_rows=2)
            arithmetic = [await cell_text(r, 0) for r in range(1, 4)]
            check(
                "两格等差延续（1,3 → 5）",
                arithmetic == ["1", "3", "5"],
                f"before={before_fill} after={arithmetic}",
            )

            # 日期序列
            await reset_data()
            await drag_fill(1, 2, 3, 2)
            dates = [await cell_text(r, 2) for r in range(1, 4)]
            check("日期序列填充", dates == ["2026-01-01", "2026-01-02", "2026-01-03"], str(dates))

            # 文本复制
            await reset_data()
            await drag_fill(1, 3, 3, 3)
            texts = [await cell_text(r, 3) for r in range(1, 4)]
            check("文本复制填充", texts == ["甲", "甲", "甲"], str(texts))

            # 横向填充：金额 100 → 101,102
            await reset_data()
            await drag_fill(1, 1, 1, 3)
            horizontal = [await cell_text(1, c) for c in range(1, 4)]
            check(
                "横向等差填充（100 → 101,102）",
                horizontal[0] in ("100", "¥100.00") and "101" in horizontal[1] and "102" in horizontal[2],
                str(horizontal),
            )

            # 服务端落库校验（最后一次填充是横向的那组数据；等待 WS 往返完成）
            await reset_data()
            await drag_fill(1, 1, 1, 3)
            frontend_ok = await wait_until(
                lambda: _all(
                    lambda: cell_text(1, 1), "100",
                    lambda: cell_text(1, 2), "101",
                    lambda: cell_text(1, 3), "102",
                )
            )
            frontend_values = [await cell_text(1, c) for c in range(1, 4)]
            check("横向填充前端已生效", frontend_ok, str(frontend_values))
            synced = await wait_until(
                lambda: _all(
                    lambda: server_cell(1, 1), "100",
                    lambda: server_cell(1, 2), "101",
                    lambda: server_cell(1, 3), "102",
                )
            )
            check(
                "填充已同步到服务端",
                synced,
                f"{await server_cell(1, 1)}/{await server_cell(1, 2)}/{await server_cell(1, 3)}",
            )

            await page.screenshot(path=str(SHOT / "menu-fill.png"))
            check("前端无未捕获异常", not errors, "; ".join(errors[:3]))
            await browser.close()
    finally:
        httpx.delete(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60)

    print(f"\n结果：{len(PASSED)} 通过 / {len(FAILED)} 失败", flush=True)
    if FAILED:
        print("失败项：" + ", ".join(FAILED), flush=True)
    print(f"截图目录：{SHOT}", flush=True)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
