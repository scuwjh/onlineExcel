"""鉴权与授权：PBKDF2 口令散列、JWT 签发校验、表格级 RBAC 判定。"""
from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from fastapi import HTTPException

from . import config

_PBKDF2_ROUNDS = 120_000


class AuthError(HTTPException):
    def __init__(self, detail: str = "未认证", status_code: int = 401) -> None:
        super().__init__(status_code=status_code, detail=detail, headers={"WWW-Authenticate": "Bearer"})


# --------------------------------------------------------------------------- 口令


def hash_password(password: str, *, salt: Optional[str] = None) -> str:
    """返回 ``pbkdf2_sha256$rounds$salt$hash``（十六进制）。"""
    if not password:
        raise ValueError("口令不能为空")
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), _PBKDF2_ROUNDS)
    return f"pbkdf2_sha256${_PBKDF2_ROUNDS}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, rounds, salt, expected = stored.split("$")
        if algo != "pbkdf2_sha256":
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt), int(rounds)
        )
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(digest.hex(), expected)


# ----------------------------------------------------------------------------- JWT


def issue_token(user_id: int, username: str, ttl_seconds: Optional[int] = None) -> tuple[str, int]:
    ttl = ttl_seconds or config.TOKEN_TTL_SECONDS
    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "name": username,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=ttl)).timestamp()),
        "jti": secrets.token_hex(8),
    }
    token = jwt.encode(payload, config.jwt_secret(), algorithm=config.jwt_algorithm())
    return token, ttl


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, config.jwt_secret(), algorithms=[config.jwt_algorithm()])
    except jwt.ExpiredSignatureError as exc:  # pragma: no cover - 依赖时钟
        raise AuthError("令牌已过期") from exc
    except jwt.InvalidTokenError as exc:
        raise AuthError("令牌无效") from exc


def bearer_token(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    parts = header.split()
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


# ------------------------------------------------------------------------ 授权判定


def role_level(role: Optional[str]) -> int:
    if not role:
        return 0
    return config.ROLE_LEVEL.get(role, 0)


def require_role(role: Optional[str], needed: str, *, sheet_id: str = "") -> str:
    """校验角色是否满足最低要求，不满足则抛出 403。"""
    if role_level(role) < config.ROLE_LEVEL[needed]:
        raise HTTPException(
            status_code=403,
            detail=f"权限不足：需要 {needed} 及以上角色（当前 {role or '无权限'}）",
        )
    return role or needed


def explain(sheet_id: str, role: Optional[str]) -> dict:
    """供前端渲染的权限说明。"""
    return {
        "sheet_id": sheet_id,
        "role": role,
        "level": role_level(role),
        "can_view": role_level(role) >= config.ROLE_LEVEL["viewer"],
        "can_comment": role_level(role) >= config.ROLE_LEVEL["commenter"],
        "can_edit": role_level(role) >= config.ROLE_LEVEL["editor"],
        "can_manage": role_level(role) >= config.ROLE_LEVEL["owner"],
    }
