"""运行时配置：全部通过环境变量覆盖，默认值面向本地 MVP。

安全说明
--------
`OE_JWT_SECRET` 未设置时使用开发默认密钥，并在启动日志中告警。
生产部署必须显式设置该变量（见 README「安全基线」）。
"""
from __future__ import annotations

import os
import secrets
import warnings
from pathlib import Path

DEV_SECRET = "dev-insecure-secret-change-me"

_DEV_SECRET_WARNED = False

# 角色能力矩阵：数值越大权限越高。
ROLE_LEVEL = {"viewer": 1, "commenter": 2, "editor": 3, "owner": 4}
ROLE_NAMES = tuple(ROLE_LEVEL)

#: 版本快照保留条数：超过后自动压缩，只保留最近 N 个快照（diff 化的核心约束）。
VERSION_SNAPSHOT_LIMIT = int(os.environ.get("OE_VERSION_SNAPSHOT_LIMIT", "20"))
#: 操作日志单表上限，超过后截断最老记录（快照已覆盖其效果）。
VERSION_OP_LIMIT = int(os.environ.get("OE_VERSION_OP_LIMIT", "5000"))
#: 单个操作 payload 大小上限（字符数），防止超大导入撑爆日志。
MAX_OP_PAYLOAD_CHARS = int(os.environ.get("OE_MAX_OP_PAYLOAD", "200000"))
#: 表格行列上限（NFR 输入校验要求）。
MAX_ROWS = int(os.environ.get("OE_MAX_ROWS", "100000"))
MAX_COLS = int(os.environ.get("OE_MAX_COLS", "500"))
#: 单元格文本长度上限。
MAX_CELL_CHARS = int(os.environ.get("OE_MAX_CELL_CHARS", "32767"))
#: 单个 WebSocket 消息的体积上限（字符数）。超过则只发送必要元数据，
#: 由客户端改用 REST 拉取权威状态（大表格的 welcome/结构变更会命中该上限）。
MAX_WS_MESSAGE_CHARS = int(os.environ.get("OE_MAX_WS_MESSAGE", "900000"))
#: 默认令牌有效期（秒）。
TOKEN_TTL_SECONDS = int(os.environ.get("OE_TOKEN_TTL", str(12 * 3600)))


def db_path() -> Path:
    """数据库文件路径；测试通过 ``OE_DB_PATH`` 指向临时文件（含 ``:memory:``）。"""
    env = os.environ.get("OE_DB_PATH")
    if env:
        if env == ":memory:":
            return Path(":memory:")
        return Path(env)
    return Path(__file__).resolve().parent.parent / "data.db"


def jwt_secret() -> str:
    global _DEV_SECRET_WARNED
    secret = os.environ.get("OE_JWT_SECRET")
    if secret:
        return secret
    if not _DEV_SECRET_WARNED:
        _DEV_SECRET_WARNED = True
        warnings.warn(
            "OE_JWT_SECRET 未设置，正在使用开发默认密钥；生产环境必须显式配置。",
            RuntimeWarning,
            stacklevel=2,
        )
    return DEV_SECRET


def jwt_algorithm() -> str:
    return "HS256"


def bootstrap_admin_password() -> str:
    """初始管理员口令。

    未显式配置时生成一次性随机口令并打印到启动日志，避免硬编码弱口令。
    """
    return os.environ.get("OE_ADMIN_PASSWORD") or _random_password()


def _random_password() -> str:
    return secrets.token_urlsafe(12)


def is_dev_auto_register() -> bool:
    """开发便利开关：允许登录接口在用户不存在时按用户名自动注册为 viewer。"""
    return os.environ.get("OE_DEV_AUTO_REGISTER", "1") not in {"0", "false", "False"}
