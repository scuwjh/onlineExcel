"""Pydantic 请求/响应模型（接口契约见 docs/api-contract.md）。"""
from __future__ import annotations

from typing import Any, Optional, Union

from pydantic import BaseModel, Field


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


class SheetCreate(BaseModel):
    name: str = "未命名表格"
    rows: int = 100
    cols: int = 20


class SheetRename(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class CellUpdate(BaseModel):
    """定位既可用索引（``row``/``col``），也可用稳定元素 ID（``row_id``/``col_id``）。

    并发插删行列时索引会漂移，客户端应优先传元素 ID。
    """

    row: Optional[int] = None
    col: Optional[int] = None
    row_id: Optional[str] = None
    col_id: Optional[str] = None
    value: Optional[str] = None
    format: Optional[dict] = None


class CellsUpdateRequest(BaseModel):
    updates: list[CellUpdate]
    user: str = "anonymous"
    version: dict = Field(default_factory=dict)
    client_id: Optional[str] = None


class RowColRequest(BaseModel):
    at: int = 0
    counter: Optional[int] = None
    position_id: Optional[str] = None


class ImportRequest(BaseModel):
    rows: int
    cols: int
    cells: dict = Field(default_factory=dict)
    formats: dict = Field(default_factory=dict)
    user: str = "anonymous"
    version: dict = Field(default_factory=dict)


class OperationRequest(BaseModel):
    kind: str
    payload: dict = Field(default_factory=dict)
    version: dict = Field(default_factory=dict)
    client_id: Optional[str] = None
    counter: Optional[int] = None


class PermissionRequest(BaseModel):
    username: str
    role: str


class CommentCreate(BaseModel):
    row: int
    col: int
    text: str = Field(min_length=1, max_length=2000)
    mentions: list = Field(default_factory=list)


JsonValue = Union[str, int, float, bool, None, dict, list, Any]
