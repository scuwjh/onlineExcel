"""本轮新增功能的端到端验证：Excel 导入导出（REQ-050）、评论与 @提醒（REQ-100）、
筛选与排序（REQ-101）。

用法::

    python scripts/verify-features.py [前端地址] [后端地址] [管理员] [口令]

前置条件：后端已启动、前端开发服务器已启动、已安装 playwright 与 openpyxl。

脚本会自建一张临时表格并在结束时删除，不会污染演示数据。
"""
from __future__ import annotations

import asyncio
import sys
import tempfile
from pathlib import Path

import httpx
from openpyxl import Workbook, load_workbook
from playwright.async_api import async_playwright

APP = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:5173"
API = sys.argv[2] if len(sys.argv) > 2 else "http://127.0.0.1:8000"
ADMIN = sys.argv[3] if len(sys.argv) > 3 else "admin"
PASSWORD = sys.argv[4] if len(sys.argv) > 4 else "admin-pass"
TMP = Path(tempfile.gettempdir()) / "oe-verify-features"
TMP.mkdir(parents=True, exist_ok=True)

SHEET_NAME = "verify-features-临时表"
PASSED: list = []
FAILED: list = []


def check(name: str, ok: bool, detail: str = "") -> None:
    (PASSED if ok else FAILED).append(name)
    print(f"[{'PASS' if ok else 'FAIL'}] {name}{(' -> ' + detail) if detail and not ok else ''}", flush=True)


def admin_headers() -> dict:
    response = httpx.post(f"{API}/api/auth/login", json={"username": ADMIN, "password": PASSWORD}, timeout=30)
    response.raise_for_status()
    return {"Authorization": f"Bearer {response.json()['data']['token']}"}


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
    headers = admin_headers()
    created = httpx.post(
        f"{API}/api/sheets",
        json={"name": SHEET_NAME, "rows": 20, "cols": 6},
        headers=headers,
        timeout=60,
    )
    sheet_id = created.json()["data"]["id"]
    cells = {
        "0:0": "地区", "0:1": "金额", "0:2": "负责人",
        "1:0": "华东", "1:1": "320", "1:2": "ann",
        "2:0": "华南", "2:1": "128", "2:2": "bob",
        "3:0": "华北", "3:1": "980", "3:2": "ann",
        "4:0": "西南", "4:1": "55", "4:2": "carol",
        "5:0": "华东", "5:1": "640", "5:2": "bob",
    }
    httpx.post(
        f"{API}/api/sheets/{sheet_id}/import",
        json={"rows": 20, "cols": 6, "cells": cells},
        headers=headers,
        timeout=60,
    )
    # 让 ann/bob 成为可被 @ 的成员
    for name in ("ann", "bob"):
        httpx.post(f"{API}/api/auth/login", json={"username": name, "password": "pw123456"}, timeout=20)
        httpx.put(
            f"{API}/api/sheets/{sheet_id}/permissions",
            json={"username": name, "role": "editor"},
            headers=headers,
            timeout=30,
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
            await page.locator(f'.sheet-tab:has-text("{SHEET_NAME}")').first.click()
            await page.wait_for_timeout(2500)
            check("临时表格已打开", SHEET_NAME in (await page.inner_text(".sheet-name")))

            # ------------------------------------------------------ REQ-100 评论
            await page.locator('[data-cell][data-row="1"][data-col="0"]').click()
            await page.click('button[title="评论与 @提醒"]')
            await page.wait_for_selector(".comments-panel", timeout=15000)
            check("评论面板打开", await page.is_visible(".comment-editor textarea"))

            # fill() 不触发 React onChange，必须真实输入
            await page.click(".comment-editor textarea")
            await page.type(".comment-editor textarea", "@a", delay=30)
            await page.wait_for_timeout(600)
            hints = await page.evaluate(
                "() => [...document.querySelectorAll('.mention-hints button')].map((b) => b.textContent.trim())"
            )
            check("@ 触发成员候选", len(hints) >= 2, str(hints))
            if hints:
                await page.locator(".mention-hints button").first.click()
                await page.wait_for_timeout(300)
                completed = await page.input_value(".comment-editor textarea")
                check("点击候选补全提及", completed.startswith("@") and len(completed) > 2, completed)
            await page.click(".comment-editor textarea")
            await page.keyboard.press("End")
            await page.type(".comment-editor textarea", " 请复核金额 @bob 同步", delay=25)
            await page.wait_for_timeout(400)
            await page.click('button:has-text("发表评论")')
            await page.wait_for_timeout(1500)

            listed = await page.evaluate(
                """() => {
                    const item = document.querySelector('.comment-item');
                    if (!item) return null;
                    return {
                        text: item.querySelector('.comment-text')?.innerText ?? '',
                        mentions: item.querySelector('.comment-mentions')?.innerText ?? '',
                        highlight: [...item.querySelectorAll('mark.mention')].length,
                    };
                }"""
            )
            check("评论创建成功", bool(listed) and "请复核" in listed["text"], str(listed)[:140])
            check("正文 @提及被高亮", bool(listed) and listed["highlight"] >= 2, str(listed and listed["highlight"]))
            check(
                "@提及解析出 admin 与 bob",
                bool(listed) and "admin" in listed["mentions"] and "bob" in listed["mentions"],
                str(listed and listed["mentions"]),
            )

            badge = await page.evaluate(
                """() => {
                    const cell = document.querySelector('[data-cell][data-row="1"][data-col="0"]');
                    return cell ? { count: cell.dataset.comments, badge: !!cell.querySelector('.comment-badge') } : null;
                }"""
            )
            check("单元格显示评论角标", bool(badge) and badge["badge"] and badge["count"] == "1", str(badge))

            await page.click('.comment-item button:has-text("解决")')
            await page.wait_for_timeout(1200)
            cleared = await page.evaluate(
                """() => {
                    const cell = document.querySelector('[data-cell][data-row="1"][data-col="0"]');
                    return cell ? !!cell.querySelector('.comment-badge') : null;
                }"""
            )
            check("解决后角标消失", cleared is False, str(cleared))
            await page.check(".inline-check input")
            await page.wait_for_timeout(400)
            check("可查看已解决评论", "已解决" in (await page.inner_text(".comment-list")))
            await page.click('.panel-head button:has-text("关闭")')
            await page.wait_for_timeout(400)

            # 第二端通过 REST 发评论 → 应经 WebSocket 广播到本页
            other = await context.new_page()
            await login(other, ADMIN, PASSWORD)
            await other.locator(f'.sheet-tab:has-text("{SHEET_NAME}")').first.click()
            await other.wait_for_timeout(2000)
            base = httpx.get(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60).json()["data"]
            httpx.post(
                f"{API}/api/sheets/{sheet_id}/comments",
                json={"row_id": base["rowIds"][3], "col_id": base["colIds"][1], "body": "另一端的评论 @ann"},
                headers=headers,
                timeout=30,
            )
            await page.wait_for_timeout(2000)
            broadcast = await page.evaluate(
                """() => {
                    const cell = document.querySelector('[data-cell][data-row="3"][data-col="1"]');
                    return cell ? cell.dataset.comments ?? null : null;
                }"""
            )
            check("评论经 WebSocket 广播到其他客户端", broadcast == "1", str(broadcast))
            await other.close()

            # ---------------------------------------------------- REQ-050 导出
            async with page.expect_download(timeout=30000) as download_info:
                await page.click('button[title="导出为 Excel(.xlsx)：保留公式、样式与冻结窗格"]')
            download = await download_info.value
            exported = TMP / "exported.xlsx"
            await download.save_as(str(exported))
            check("导出 Excel 触发下载", exported.exists() and exported.stat().st_size > 0)

            book = load_workbook(str(exported))
            sheet = book.active
            check(
                "导出内容与类型正确",
                sheet["A2"].value == "华东" and sheet["B2"].value == 320 and sheet["B3"].value == 128,
                f"{sheet['A2'].value}/{sheet['B2'].value}/{sheet['B3'].value}",
            )
            book.close()
            await page.wait_for_timeout(600)

            # ---------------------------------------------------- REQ-050 导入
            book = Workbook()
            first = book.active
            first.title = "导入源"
            first.append(["产品", "数量"])
            first.append(["键盘", 12])
            first.append(["鼠标", 30])
            book.create_sheet("备用")
            source = TMP / "import-source.xlsx"
            book.save(str(source))
            book.close()

            page.on("dialog", lambda dialog: asyncio.ensure_future(dialog.accept("导入源")))
            # 页面有两个 file input：CSV 在前、Excel 在后
            await page.set_input_files('input[type="file"] >> nth=1', str(source))
            await page.wait_for_timeout(3000)
            imported = await page.evaluate(
                """() => {
                    const read = (r, c) => document.querySelector(`[data-cell][data-row="${r}"][data-col="${c}"]`)?.innerText.trim();
                    return { a1: read(0, 0), b2: read(1, 1), status: document.querySelector('.grid-status')?.innerText.replace(/\\n/g, ' | ') };
                }"""
            )
            check("Excel 导入覆盖表格内容", imported["a1"] == "产品" and imported["b2"] == "12", str(imported))
            # 导入前是 20×6，导入后应变成 3×2（表头 + 2 行数据）
            check("导入后网格按新维度重绘", "共 3 行 × 2 列" in (imported["status"] or ""), str(imported["status"]))

            # -------------------------------------------------- REQ-101 筛选排序
            # 重新铺一份带数值的数据
            httpx.post(
                f"{API}/api/sheets/{sheet_id}/import",
                json={"rows": 20, "cols": 6, "cells": cells},
                headers=headers,
                timeout=60,
            )
            await page.reload(wait_until="domcontentloaded")
            await page.wait_for_selector(".grid-shell", timeout=30000)
            await page.locator(f'.sheet-tab:has-text("{SHEET_NAME}")').first.click()
            await page.wait_for_timeout(2500)

            await page.click('button[title="筛选与排序（仅影响本端显示）"]')
            await page.wait_for_selector(".view-panel", timeout=15000)
            await page.click('.view-panel button:has-text("添加条件")')
            await page.wait_for_timeout(400)
            selects = page.locator(".filter-list .view-row select")
            await selects.nth(0).select_option("1")
            await selects.nth(1).select_option("gt")
            await page.fill(".filter-list input", "300")
            await page.wait_for_timeout(1200)
            filtered = await page.evaluate(
                """() => [...document.querySelectorAll('[data-cell][data-col="1"]')]
                        .map((c) => c.innerText.trim()).filter((t) => t !== "")"""
            )
            check(
                "筛选只保留匹配行",
                "980" in filtered and "640" in filtered and "320" in filtered and "55" not in filtered and "128" not in filtered,
                str(filtered),
            )
            await page.click('.view-panel button:has-text("全部清除")')
            await page.wait_for_timeout(1000)

            sort_selects = page.locator(".view-panel .view-row select")
            await sort_selects.nth(0).select_option("1")
            await page.wait_for_timeout(400)
            await sort_selects.nth(1).select_option("desc")
            await page.wait_for_timeout(1200)
            ordered = await page.evaluate(
                """() => [...document.querySelectorAll('[data-cell][data-col="1"]')]
                        .map((c) => c.innerText.trim()).filter((t) => t !== "")"""
            )
            check(
                "按金额降序排列（空行垫底）",
                ordered[:6] == ["金额", "980", "640", "320", "128", "55"],
                str(ordered[:6]),
            )
            await page.click('.view-panel button:has-text("全部清除")')
            await page.wait_for_timeout(1000)
            restored = await page.evaluate(
                """() => document.querySelector('[data-cell][data-row="1"][data-col="1"]')?.innerText.trim()"""
            )
            check("清除后恢复原始行序", restored == "320", str(restored))
            await page.click('.panel-head button:has-text("关闭")')
            await page.wait_for_timeout(400)

            check("前端无未捕获异常", not errors, "; ".join(errors[:3]))
            await browser.close()
    finally:
        # 清理临时表格，避免影响演示数据与后续验证
        httpx.delete(f"{API}/api/sheets/{sheet_id}", headers=headers, timeout=60)

    print(f"\n结果：{len(PASSED)} 通过 / {len(FAILED)} 失败", flush=True)
    if FAILED:
        print("失败项：" + ", ".join(FAILED), flush=True)
    return 1 if FAILED else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
