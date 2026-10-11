"""选区、基础格式与公式栏的端到端验证（REQ-002/003、REQ-007、REQ-009）。

用法::

    python scripts/verify-grid.py [前端地址] [后端地址] [管理员] [口令]

前置条件：后端已启动、前端开发服务器已启动、已安装 playwright 与 httpx。
脚本自建临时表格并在结束时删除，不污染演示数据。
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

import httpx
from playwright.async_api import async_playwright

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
API = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
ADMIN = sys.argv[3] if len(sys.argv) > 3 else "admin"
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else "admin-pass"
SHOT = Path(__file__).resolve().parent / "artifacts"
SHOT.mkdir(parents=True, exist_ok=True)
SHEET = "verify-grid-临时表"

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
        f"{API}/api/sheets", json={"name": SHEET, "rows": 30, "cols": 8}, headers=headers, timeout=60
    ).json()["data"]["id"]
    cells = {
        "0:0": "地区", "0:1": "金额", "0:2": "占比", "0:3": "日期",
        "1:0": "华东", "1:1": "320", "1:2": "0.32", "1:3": "2026-01-05",
        "2:0": "华南", "2:1": "128", "2:2": "0.128", "2:3": "2026-02-11",
        "3:0": "华北", "3:1": "980", "3:2": "0.98", "3:3": "2026-03-20",
        "4:0": "西南", "4:1": "55", "4:2": "0.055", "4:3": "2026-04-02",
        "5:0": "华东", "5:1": "640", "5:2": "0.64", "5:3": "2026-05-18",
    }
    httpx.post(
        f"{API}/api/sheets/{sheet_id}/import",
        json={"rows": 30, "cols": 8, "cells": cells},
        headers=headers,
        timeout=60,
    )

    try:
        async with async_playwright() as pw:
            browser = await pw.chromium.launch(channel="msedge", headless=True)
            context = await browser.new_context(
                viewport={"width": 1500, "height": 950},
                permissions=["clipboard-read", "clipboard-write"],
            )
            page = await context.new_page()
            errors: list = []
            page.on("pageerror", lambda exc: errors.append(str(exc)))

            await login(page, ADMIN, PASSWORD)
            await page.locator(f'.sheet-tab:has-text("{SHEET}")').first.click()
            await page.wait_for_timeout(2500)
            check("打开临时表格", SHEET in (await page.inner_text(".sheet-name")))

            async def cell_box(row: int, col: int):
                loc = page.locator(f'[data-cell][data-row="{row}"][data-col="{col}"]')
                await loc.scroll_into_view_if_needed(timeout=15000)
                return await loc.bounding_box()

            async def range_state():
                return await page.evaluate(
                    """() => {
                        const shell = document.querySelector('.grid-shell');
                        const cells = [...document.querySelectorAll('.cell.in-range')]
                          .map((c) => `${c.dataset.row},${c.dataset.col}`);
                        // 活动格用 .selected 标记，不在 .in-range 里，统计时要一起算
                        const highlighted = new Set([...cells, ...[...document.querySelectorAll('.cell.selected')]
                          .map((c) => `${c.dataset.row},${c.dataset.col}`)]);
                        const rows = [...document.querySelectorAll('.row-head.active')].map((e) => e.dataset.rowHead);
                        const cols = [...document.querySelectorAll('.col-head.active')].map((e) => e.dataset.colHead);
                        return { range: shell.dataset.range, anchor: shell.dataset.anchor,
                                 selected: shell.dataset.selected,
                                 inRange: highlighted.size, rows, cols,
                                 status: document.querySelector('.grid-status')?.innerText.split('\\n')[0],
                                 rangeLabel: document.querySelector('.range-label')?.innerText ?? null };
                    }"""
                )

            # ================================================== REQ-002/003 选区
            # 拖拽落点要落在单元格内部（用中心点）；落在行间隙会停在上一行
            a = await cell_box(1, 0)
            d = await cell_box(3, 2)
            await page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
            await page.mouse.down()
            await page.mouse.move(d["x"] + d["width"] / 2, d["y"] + d["height"] / 2, steps=10)
            await page.mouse.up()
            await page.wait_for_timeout(400)
            dragged = await range_state()
            check(
                "鼠标拖拽框选（A2:C4，3×3）",
                dragged["range"] == "1:0-3:2" and "3行 × 3列" in (dragged["status"] or ""),
                str(dragged),
            )
            check("选区高亮铺满（9 格）", dragged["inRange"] == 9, str(dragged["inRange"]))

            # Shift+方向键扩展；不带 Shift 则收成单格（与 Excel 一致）
            await page.locator('[data-cell][data-row="1"][data-col="0"]').click()
            await page.wait_for_timeout(200)
            await page.keyboard.press("Shift+ArrowDown")
            await page.wait_for_timeout(200)
            await page.keyboard.press("Shift+ArrowRight")
            await page.wait_for_timeout(200)
            await page.keyboard.press("Shift+ArrowRight")
            await page.wait_for_timeout(300)
            shifted = await range_state()
            check(
                "Shift+方向键扩展选区（2×3）",
                shifted["range"] == "1:0-2:2" and "2行 × 3列" in (shifted["status"] or ""),
                str(shifted),
            )
            await page.keyboard.press("ArrowDown")
            await page.wait_for_timeout(300)
            moved = await range_state()
            check("不带 Shift 的方向键收成单格", moved["range"] == "3:2-3:2" and moved["inRange"] == 1, str(moved))

            await page.keyboard.press("Control+a")
            await page.wait_for_timeout(400)
            allsel = await range_state()
            check("Ctrl+A 全选（30×8）", allsel["range"] == "0:0-29:7", str(allsel))

            await page.locator('[data-row-head="2"]').first.click()
            await page.wait_for_timeout(400)
            rowsel = await range_state()
            check(
                "点行号整行选中",
                rowsel["rows"] == ["2"] and rowsel["range"] == "2:0-2:7" and "整行" in (rowsel["status"] or ""),
                str(rowsel),
            )

            await page.keyboard.down("Shift")
            await page.locator('[data-row-head="4"]').first.click()
            await page.keyboard.up("Shift")
            await page.wait_for_timeout(400)
            multirow = await range_state()
            check(
                "Shift+点行号选中连续多行（2-4）",
                multirow["rows"] == ["2", "3", "4"] and multirow["range"] == "2:0-4:7",
                str(multirow),
            )

            await page.locator('[data-col-head="1"]').first.click()
            await page.wait_for_timeout(400)
            colsel = await range_state()
            check(
                "点列标整列选中",
                colsel["cols"] == ["1"] and colsel["range"] == "0:1-29:1" and "整列" in (colsel["status"] or ""),
                str(colsel),
            )

            await page.locator(".corner").first.click()
            await page.wait_for_timeout(400)
            cornersel = await range_state()
            check("点左上角全选", "全选" in (cornersel["status"] or ""), str(cornersel))

            # ================================================== REQ-007 基础格式
            await page.locator('[data-col-head="1"]').first.click()
            await page.wait_for_timeout(300)
            await page.select_option('select[title="数字/日期格式（只影响显示，不改原始值）"]', "currency")
            await page.wait_for_timeout(1200)
            money = await page.evaluate(
                """() => [1, 2].map((r) =>
                    document.querySelector(`[data-cell][data-row="${r}"][data-col="1"]`)?.innerText.trim())"""
            )
            check("整列套用货币格式", all("¥" in (m or "") for m in money), str(money))

            await page.locator('[data-col-head="2"]').first.click()
            await page.wait_for_timeout(300)
            await page.select_option('select[title="数字/日期格式（只影响显示，不改原始值）"]', "percent")
            await page.wait_for_timeout(1200)
            pct = await page.evaluate(
                """() => document.querySelector('[data-cell][data-row="1"][data-col="2"]')?.innerText.trim()"""
            )
            check("百分比格式渲染（0.32 → 32%）", pct == "32%", str(pct))

            await page.locator('[data-col-head="3"]').first.click()
            await page.wait_for_timeout(300)
            await page.select_option('select[title="数字/日期格式（只影响显示，不改原始值）"]', "date")
            await page.wait_for_timeout(1200)
            date_text = await page.evaluate(
                """() => document.querySelector('[data-cell][data-row="1"][data-col="3"]')?.innerText.trim()"""
            )
            check("日期格式渲染", date_text == "2026-01-05", str(date_text))

            raw = httpx.get(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60).json()["data"]["cells"]
            check(
                "数字格式只影响显示（原始值不变）",
                raw.get("1:1") == "320" and raw.get("1:2") == "0.32",
                f"{raw.get('1:1')}/{raw.get('1:2')}",
            )

            a = await cell_box(1, 0)
            c = await cell_box(2, 1)
            await page.mouse.move(a["x"] + a["width"] / 2, a["y"] + a["height"] / 2)
            await page.mouse.down()
            await page.mouse.move(c["x"] + c["width"] / 2, c["y"] + c["height"] / 2, steps=8)
            await page.mouse.up()
            await page.wait_for_timeout(300)
            await page.select_option('select[title="字号"]', "18")
            await page.wait_for_timeout(900)
            await page.select_option('select[title="字体"]', "微软雅黑")
            await page.wait_for_timeout(900)
            await page.click('.border-group button[title="下边框"]')
            await page.wait_for_timeout(900)
            await page.click('button[title="删除线"]')
            await page.wait_for_timeout(900)
            styled = await page.evaluate(
                """() => {
                    const css = (e) => (e ? getComputedStyle(e) : null);
                    const a = css(document.querySelector('[data-cell][data-row="1"][data-col="0"]'));
                    const b = css(document.querySelector('[data-cell][data-row="2"][data-col="1"]'));
                    return { a: { size: a?.fontSize, family: a?.fontFamily, border: a?.borderBottomWidth, deco: a?.textDecorationLine },
                             b: { size: b?.fontSize, deco: b?.textDecorationLine } };
                }"""
            )
            check(
                "选区批量套用字号/字体/边框/删除线",
                styled["a"]["size"] == "18px"
                and "微软雅黑" in styled["a"]["family"]
                and styled["a"]["border"] == "1px"
                and "line-through" in styled["a"]["deco"]
                and styled["b"]["size"] == "18px"
                and "line-through" in styled["b"]["deco"],
                str(styled),
            )

            await page.click('button[title="清除选区格式"]')
            await page.wait_for_timeout(1200)
            cleared = await page.evaluate(
                """() => {
                    const cs = getComputedStyle(document.querySelector('[data-cell][data-row="1"][data-col="0"]'));
                    return { size: cs.fontSize, deco: cs.textDecorationLine };
                }"""
            )
            check("清除选区格式生效", cleared["size"] != "18px" and "line-through" not in cleared["deco"], str(cleared))
            await page.screenshot(path=str(SHOT / "grid-format.png"))

            # ================================================== REQ-009 公式栏
            await page.locator('[data-cell][data-row="6"][data-col="0"]').click()
            await page.wait_for_timeout(300)
            bar = page.locator(".formula-input")
            await bar.click()
            await bar.type("=SU", delay=60)
            await page.wait_for_timeout(500)
            hints = await page.evaluate(
                "() => [...document.querySelectorAll('.formula-hints button code')].map((e) => e.textContent)"
            )
            check("函数提示（=SU → SUM）", any(h.startswith("SUM") for h in hints), str(hints))

            await bar.press("Tab")
            await page.wait_for_timeout(300)
            check("Tab 补全函数名", (await page.input_value(".formula-input")).startswith("=SUM("), await page.input_value(".formula-input"))

            await page.fill(".formula-input", "")
            await page.locator(".formula-input").click()
            await page.keyboard.type("=B2*2", delay=40)
            await page.wait_for_timeout(600)
            token_count = await page.evaluate("() => document.querySelectorAll('.formula-ref-token').length")
            result_text = await page.evaluate("() => document.querySelector('.formula-result')?.innerText ?? null")
            check("引用高亮（B2 着色）", token_count >= 1, str(token_count))
            check("实时计算显示结果", result_text is not None and "640" in result_text, str(result_text))

            await page.fill(".formula-input", "")
            await page.locator(".formula-input").click()
            await page.keyboard.type("=SUM(B2:B9", delay=30)
            await page.wait_for_timeout(600)
            issue = await page.evaluate("() => document.querySelector('.formula-issue')?.innerText ?? null")
            check("错误检查（括号未闭合）", issue is not None and "括号" in issue, str(issue))

            await page.fill(".formula-input", "=SUM(B2:B6)")
            await page.locator(".formula-input").press("Enter")
            await page.wait_for_timeout(1500)
            formula_cell = await page.evaluate(
                """() => document.querySelector('[data-cell][data-row="6"][data-col="0"]')?.innerText.trim()"""
            )
            check("公式写入并求值（320+128+980+55+640）", formula_cell == "2123", str(formula_cell))

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
