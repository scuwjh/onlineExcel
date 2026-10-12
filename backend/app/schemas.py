"""Pydantic 请求/响应模型（接口契约见 docs/api-contract.md）。"""
from __future__ import annotations

import re
from typing import Any, Optional, Union

from pydantic import BaseModel, ConfigDict, Field


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
    """新建评论：定位用稳定元素 ID（``row_id``/``col_id``），也兼容索引。"""

    body: str = Field(min_length=1, max_length=2000)
    row_id: Optional[str] = None
    col_id: Optional[str] = None
    row: Optional[int] = None
    col: Optional[int] = None


class CommentResolve(BaseModel):
    resolved: bool = True


class PreferencesUpdate(BaseModel):
    """个性化配置（REQ-110/112）：覆盖式写入，未知键原样保留。

    服务端做类型/长度/枚举校验（见 :func:`validate_preferences`），
    但不认识具体命令 ID —— 命令表由前端 `lib/shortcuts.ts` 维护。
    """

    model_config = ConfigDict(extra="allow")

    # 字段故意用 Any：非法取值统一由 validate_preferences 给出中文 400，
    # 而不是 pydantic 的 422 结构化报错（契约要求 invalid + 可直接展示的消息）。
    shortcuts: Any = Field(default_factory=dict)
    fillColors: Any = Field(default_factory=list)
    highlightColors: Any = Field(default_factory=list)
    enterDirection: Any = "down"


#: 单用户可保存的常用颜色数量上限（键位 Ctrl+Alt+1..9 只覆盖 9 个，留余量）。
MAX_PREF_COLORS = 24
MAX_PREF_SHORTCUTS = 80
ENTER_DIRECTIONS = ("down", "up", "left", "right", "none")
_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{6}$")


def validate_preferences(raw: dict) -> dict:
    """校验并归一化个性化配置；非法时抛 ``ValueError``（消息可直接展示）。"""
    if not isinstance(raw, dict):
        raise ValueError("配置必须是对象")
    prefs = dict(raw)

    shortcuts = prefs.get("shortcuts", {})
    if not isinstance(shortcuts, dict):
        raise ValueError("shortcuts 必须是对象")
    if len(shortcuts) > MAX_PREF_SHORTCUTS:
        raise ValueError(f"快捷键最多 {MAX_PREF_SHORTCUTS} 条")
    clean_shortcuts: dict = {}
    for command, spec in shortcuts.items():
        if not isinstance(command, str) or not isinstance(spec, str):
            raise ValueError("快捷键必须是「命令 → 键位串」的字符串映射")
        if len(command) > 64 or len(spec) > 40:
            raise ValueError("快捷键命令或键位串过长")
        clean_shortcuts[command] = spec
    prefs["shortcuts"] = clean_shortcuts

    for key in ("fillColors", "highlightColors"):
        colors = prefs.get(key, [])
        if not isinstance(colors, list):
            raise ValueError(f"{key} 必须是数组")
        if len(colors) > MAX_PREF_COLORS:
            raise ValueError(f"{key} 最多 {MAX_PREF_COLORS} 个颜色")
        for color in colors:
            if not isinstance(color, str) or not _COLOR_PATTERN.match(color):
                raise ValueError(f"{key} 只接受 #rrggbb 形式的颜色")
        prefs[key] = [str(color).lower() for color in colors]

    direction = prefs.get("enterDirection", "down")
    if direction not in ENTER_DIRECTIONS:
        raise ValueError("enterDirection 只能是 " + "/".join(ENTER_DIRECTIONS))
    prefs["enterDirection"] = direction
    return prefs


class XlsxImportRequest(BaseModel):
    """xlsx 内容以 base64 传输（避免额外依赖 multipart）。"""

    data: str = Field(min_length=1)
    sheet_name: Optional[str] = None


class XlsxExportRequest(BaseModel):
    frozen_rows: int = 0
    frozen_cols: int = 0


JsonValue = Union[str, int, float, bool, None, dict, list, Any]
