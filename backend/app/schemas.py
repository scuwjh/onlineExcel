"""Pydantic 请求/响应模型。"""
from typing import Optional

from pydantic import BaseModel


class SheetCreate(BaseModel):
    name: str = "未命名表格"


class CellUpdate(BaseModel):
    row: int
    col: int
    value: Optional[str] = None


class CellsUpdateRequest(BaseModel):
    updates: list[CellUpdate]
    user: str = "anonymous"


class ImportRequest(BaseModel):
    rows: int
    cols: int
    cells: dict[str, Optional[str]] = {}
    user: str = "anonymous"
