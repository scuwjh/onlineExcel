"""Excel（.xlsx）导入/导出。

设计要点
--------
- **导出**：把表格投影写成 xlsx，保留公式（以 ``=`` 原样写入，由 Excel 计算）、
  单元格样式（加粗/斜体/下划线/字色/底色/对齐）、冻结窗格与列宽。
  由于本项目的公式引擎只覆盖 SUM/AVERAGE/IF，导出时**不写入缓存计算值**，
  公式一律交给 Excel 求值（避免写出错误结果）。
- **导入**：解析工作表为 ``cells``/``formats``，公式以文本形式导入（前端不求值）。
  导入是"整体替换"语义，与 CSV 导入共用 ``store.replace_sheet`` 路径。
- 安全：限制文件大小、行列数、单元格长度；只读取值，不使用宏（``keep_vba`` 关闭）。
"""
from __future__ import annotations

import io
from typing import Optional

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from . import config, crdt

try:  # openpyxl 对非法路径的告警（如 "Sheet1" 之外的特殊字符）
    from openpyxl.utils.exceptions import InvalidFileException
except ImportError:  # pragma: no cover
    InvalidFileException = Exception  # type: ignore[assignment]


class ExcelError(Exception):
    """导入/导出过程中的可读错误。"""


# --------------------------------------------------------------------------- 导出


def _alignment(align: Optional[str]) -> Optional[Alignment]:
    if align == "center":
        return Alignment(horizontal="center", vertical="center")
    if align == "right":
        return Alignment(horizontal="right", vertical="center")
    if align == "left":
        return Alignment(horizontal="left", vertical="center")
    return None


def _fill(color: Optional[str]) -> Optional[PatternFill]:
    if not color:
        return None
    hex_color = color.lstrip("#")
    if len(hex_color) != 6:
        return None
    return PatternFill(start_color=hex_color.upper(), end_color=hex_color.upper(), fill_type="solid")


def export_workbook(
    sheet_name: str,
    rows: int,
    cols: int,
    cells: dict,
    formats: dict,
    *,
    frozen_rows: int = 0,
    frozen_cols: int = 0,
) -> bytes:
    """把表格导出为 xlsx 字节流。"""
    if rows <= 0 or cols <= 0:
        raise ExcelError("表格为空，无法导出")

    wb = Workbook()
    ws = wb.active
    ws.title = (sheet_name or "Sheet1")[:31] or "Sheet1"

    # 值与格式：只写非空单元格，避免产生上百万空对象
    for key, value in (cells or {}).items():
        try:
            row, col = crdt.parse_cell_key(str(key))
        except (ValueError, crdt.InvalidOperation):
            continue
        if row >= rows or col >= cols or value in (None, ""):
            continue
        text = str(value)
        target = ws.cell(row=row + 1, column=col + 1)
        if text.startswith("="):
            target.value = text  # 交由 Excel 求值
        else:
            number = _as_number(text)
            target.value = number if number is not None else text

    for key, fmt in (formats or {}).items():
        if not fmt:
            continue
        try:
            row, col = crdt.parse_cell_key(str(key))
        except (ValueError, crdt.InvalidOperation):
            continue
        if row >= rows or col >= cols:
            continue
        target = ws.cell(row=row + 1, column=col + 1)
        bold = bool(fmt.get("bold"))
        italic = bool(fmt.get("italic"))
        underline = "single" if fmt.get("underline") else None
        color = fmt.get("color")
        font_color = color.lstrip("#").upper() if isinstance(color, str) and len(color.strip("#")) == 6 else None
        if bold or italic or underline or font_color:
            target.font = Font(bold=bold, italic=italic, underline=underline, color=font_color)
        fill = _fill(fmt.get("bg"))
        if fill:
            target.fill = fill
        alignment = _alignment(fmt.get("align"))
        if alignment:
            target.alignment = alignment

    if frozen_rows or frozen_cols:
        ws.freeze_panes = ws.cell(row=frozen_rows + 1, column=frozen_cols + 1)

    for col in range(1, cols + 1):
        ws.column_dimensions[get_column_letter(col)].width = 14

    buffer = io.BytesIO()
    wb.save(buffer)
    wb.close()
    return buffer.getvalue()


def _as_number(text: str) -> Optional[float]:
    try:
        return int(text) if text.lstrip("-").isdigit() else float(text)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- 导入


def list_sheets(data: bytes) -> list:
    """列出工作簿里的工作表名（供前端选择）。"""
    wb = _open(data, read_only=True)
    try:
        return list(wb.sheetnames)
    finally:
        wb.close()


def _open(data: bytes, read_only: bool = False):
    if len(data) > config.MAX_XLSX_BYTES:
        raise ExcelError(f"文件过大（上限 {config.MAX_XLSX_BYTES // (1024 * 1024)}MB）")
    try:
        return load_workbook(io.BytesIO(data), read_only=read_only, data_only=False, keep_vba=False)
    except InvalidFileException as exc:
        raise ExcelError("不是有效的 .xlsx 文件") from exc
    except Exception as exc:  # openpyxl 对损坏文件会抛各种异常
        raise ExcelError(f"无法读取该 Excel 文件：{exc}") from exc


def import_workbook(data: bytes, sheet_name: Optional[str] = None) -> dict:
    """解析 xlsx 为 ``{rows, cols, cells, formats}``（公式以文本保存，前端不求值）。"""
    wb = _open(data)
    try:
        names = list(wb.sheetnames)
        if not names:
            raise ExcelError("该工作簿没有工作表")
        target_name = sheet_name or names[0]
        if target_name not in names:
            raise ExcelError(f"工作表不存在：{target_name}")
        ws = wb[target_name]

        max_row = min(ws.max_row or 0, config.MAX_ROWS)
        max_col = min(ws.max_column or 0, config.MAX_COLS)
        if max_row == 0 or max_col == 0:
            raise ExcelError("该工作表没有数据")

        cells: dict = {}
        formats: dict = {}
        long_cells = 0
        for row_index, row in enumerate(ws.iter_rows(min_row=1, max_row=max_row, max_col=max_col), start=0):
            for col_index, cell in enumerate(row, start=0):
                value = cell.value
                if value is None:
                    continue
                text = _to_text(value)
                if text == "":
                    continue
                if len(text) > config.MAX_CELL_CHARS:
                    long_cells += 1
                    continue
                cells[f"{row_index}:{col_index}"] = text
                fmt = _format_of(cell)
                if fmt:
                    formats[f"{row_index}:{col_index}"] = fmt

        return {
            "sheet_name": target_name,
            "sheet_names": names,
            "rows": max(1, max_row),
            "cols": max(1, max_col),
            "cells": cells,
            "formats": formats,
            "skipped_long_cells": long_cells,
        }
    finally:
        wb.close()


def _to_text(value) -> str:
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if isinstance(value, (int, float, str)):
        return str(value).strip() if isinstance(value, str) else str(value)
    # 日期/时间等：用 ISO 文本，避免丢失信息
    return value.isoformat() if hasattr(value, "isoformat") else str(value)


def _format_of(cell) -> Optional[dict]:
    fmt: dict = {}
    font = cell.font
    if font is not None:
        if font.bold:
            fmt["bold"] = True
        if font.italic:
            fmt["italic"] = True
        if font.underline:
            fmt["underline"] = True
        color = getattr(font.color, "rgb", None)
        if isinstance(color, str) and len(color) == 8 and color.upper() not in ("FF000000", "00000000"):
            fmt["color"] = f"#{color[2:].lower()}"
    fill = cell.fill
    bg = getattr(getattr(fill, "fgColor", None), "rgb", None) if fill is not None else None
    if isinstance(bg, str) and len(bg) == 8 and bg.upper() not in ("00000000", "FFFFFFFF"):
        fmt["bg"] = f"#{bg[2:].lower()}"
    align = getattr(cell.alignment, "horizontal", None)
    if align in ("left", "center", "right"):
        fmt["align"] = align
    return fmt or None
