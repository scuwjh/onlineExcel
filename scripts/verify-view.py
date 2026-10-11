"""筛选与排序的端到端验证（REQ-101）：条件筛选、按值多选筛选、多级排序。

用法::

    python scripts/verify-view.py [前端地址] [后端地址] [管理员] [口令]

视图都是**本端**状态：筛选只隐藏行、排序只改变展示顺序，都不改动存储数据。
脚本自建临时表格并在结束时删除。
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
SHEET = "verify-view-临时表"

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
        f"{API}/api/sheets", json={"name": SHEET, "rows": 20, "cols": 6}, headers=headers, timeout=60
    ).json()["data"]["id"]
    cells = {
        "0:0": "地区", "0:1": "金额", "0:2": "状态",
        "1:0": "华东", "1:1": "320", "1:2": "完成",
        "2:0": "华南", "2:1": "128", "2:2": "进行中",
        "3:0": "华北", "3:1": "980", "3:2": "完成",
        "4:0": "西南", "4:1": "55", "4:2": "待开始",
        "5:0": "华东", "5:1": "640", "5:2": "进行中",
        "6:0": "华南", "6:1": "210", "6:2": "完成",
    }
    httpx.post(
        f"{API}/api/sheets/{sheet_id}/import",
        json={"rows": 20, "cols": 6, "cells": cells},
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

            async def column_values(col: int) -> list:
                return await page.evaluate(
                    """(col) => [...document.querySelectorAll(`[data-cell][data-col="${col}"]`)]
                         .map((c) => c.innerText.trim()).filter((t) => t !== "")""",
                    col,
                )

            async def status() -> str:
                return await page.evaluate(
                    """() => document.querySelector('.grid-status')?.innerText.replace(/\\n/g, ' | ') ?? ''"""
                )

            await page.click('button[title="筛选与排序（仅影响本端显示）"]')
            await page.wait_for_selector(".view-panel", timeout=15000)

            # ------------------------------------------------ 按值多选筛选
            await page.wait_for_timeout(500)
            candidates = await page.evaluate(
                "() => [...document.querySelectorAll('.value-item .value-text')].map((e) => e.innerText.trim())"
            )
            check("筛选清单列出该列的值", "华东" in candidates and "华南" in candidates, str(candidates[:8]))

            await page.click('.view-panel button:has-text("全不选")')
            await page.wait_for_timeout(700)
            check("按值全不选 → 0 行", "显示 0 行" in (await status()), await status())

            await page.click('.view-panel button:has-text("全选")')
            await page.wait_for_timeout(700)
            check("按值全选 → 恢复原始行数", "显示" not in (await status()), await status())

            for label in ("华南", "华北", "西南"):
                await page.locator(f'.value-item:has-text("{label}") input').first.uncheck()
                await page.wait_for_timeout(350)
            await page.wait_for_timeout(700)
            visible = await column_values(0)
            check(
                "按值多选筛选只保留勾选值",
                "华东" in visible and "华南" not in visible and "华北" not in visible,
                str(visible),
            )

            await page.click('.view-panel button:has-text("全部清除")')
            await page.wait_for_timeout(800)

            # ------------------------------------------------ 条件筛选
            await page.click('.view-panel button:has-text("添加条件")')
            await page.wait_for_timeout(400)
            selects = page.locator(".filter-list .view-row select")
            await selects.nth(0).select_option("1")  # 金额列
            await selects.nth(1).select_option("gt")  # 大于
            await page.fill(".filter-list input", "300")
            await page.wait_for_timeout(1000)
            amounts = await column_values(1)
            check(
                "条件筛选（金额 > 300）",
                all(float(v.replace(",", "")) > 300 for v in amounts if v.isdigit()) and "980" in amounts,
                str(amounts),
            )
            await page.click('.view-panel button:has-text("全部清除")')
            await page.wait_for_timeout(800)
            check("清除筛选恢复全部行", "显示" not in (await status()), await status())

            # ------------------------------------------------ 多级排序
            sort_select = page.locator(".view-panel .view-row select").first
            await sort_select.select_option("0")  # 先按地区
            await page.wait_for_timeout(600)
            await sort_select.select_option("1")  # 再按金额（第二级）
            await page.wait_for_timeout(600)
            sort_rows = await page.evaluate(
                "() => document.querySelectorAll('.view-panel .filter-list .view-row').length"
            )
            check("多级排序可添加两条条件", sort_rows == 2, str(sort_rows))

            # 第一级：地区升序；第二级：金额降序
            rules = page.locator(".view-panel .filter-list .view-row")
            await rules.nth(1).locator("select").nth(1).select_option("desc")
            await page.wait_for_timeout(1200)
            pairs = await page.evaluate(
                """() => [...document.querySelectorAll('.grid-body .grid-row')].slice(0, 7).map((row) => {
                    const a = row.querySelector('[data-col="0"]')?.innerText.trim() ?? '';
                    const b = row.querySelector('[data-col="1"]')?.innerText.trim() ?? '';
                    return `${a}|${b}`;
                }).filter((t) => t !== '|')"""
            )
            # 升序下"地区"表头行排在最前，其后是华北/华东/华东/华南/华南/西南
            header_index = pairs.index("地区|金额") if "地区|金额" in pairs else -1
            body_pairs = pairs[header_index + 1 :] if header_index >= 0 else pairs
            expected_order = ["华北|980", "华东|640", "华东|320", "华南|210", "华南|128", "西南|55"]
            check("多级排序结果正确（地区升序 + 金额降序）", body_pairs[:6] == expected_order, str(body_pairs[:6]))

            server = httpx.get(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60).json()["data"]["cells"]
            check(
                "排序不影响存储数据",
                server.get("1:0") == "华东" and server.get("3:1") == "980",
                f"{server.get('1:0')}/{server.get('3:1')}",
            )

            await page.screenshot(path=str(SHOT / "view-panel.png"))
            await page.click('.panel-head button:has-text("关闭")')
            await page.wait_for_timeout(300)

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
