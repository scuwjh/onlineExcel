"""FastAPI 应用入口：中间件、安全基线、异常脱敏与路由装配。"""
from __future__ import annotations

import logging
import os
import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import auth, bootstrap, config, routes, ws

logger = logging.getLogger("online_excel")

app = FastAPI(title="Online Excel API", version="2.0.0")

_allowed_origins = [
    origin.strip()
    for origin in os.environ.get(
        "OE_ALLOWED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,http://localhost:8080"
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

#: 登录失败限流（NFR-034：基础限流）。
_LOGIN_WINDOW = 60.0
_LOGIN_MAX_ATTEMPTS = int(os.environ.get("OE_LOGIN_MAX_ATTEMPTS", "20"))
_login_attempts: Dict[str, Deque[float]] = defaultdict(deque)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    if request.url.path.endswith("/auth/login"):
        key = request.client.host if request.client else "unknown"
        now = time.monotonic()
        bucket = _login_attempts[key]
        while bucket and now - bucket[0] > _LOGIN_WINDOW:
            bucket.popleft()
        if len(bucket) >= _LOGIN_MAX_ATTEMPTS:
            return JSONResponse(
                status_code=429,
                content={"ok": False, "error": "登录尝试过于频繁，请稍后再试", "code": "rate_limited"},
            )
        bucket.append(now)

    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; "
        "connect-src 'self' ws: wss:; frame-ancestors 'none'",
    )
    if os.environ.get("OE_HSTS", "0") == "1":
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.exception_handler(auth.AuthError)
async def auth_error_handler(request: Request, exc: auth.AuthError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "error": exc.detail, "code": "unauthorized"},
        headers=exc.headers,
    )


@app.exception_handler(StarletteHTTPException)
async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    code = {401: "unauthorized", 403: "forbidden", 404: "not_found", 429: "rate_limited"}.get(
        exc.status_code, "error"
    )
    return JSONResponse(
        status_code=exc.status_code,
        content={"ok": False, "error": str(exc.detail), "code": code},
    )


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"ok": False, "error": "请求参数不合法", "code": "invalid", "detail": exc.errors()[:10]},
    )


@app.on_event("startup")
def _startup() -> None:
    info = bootstrap.bootstrap()
    app.state.bootstrap_info = info
    if info.get("generated_admin_password"):
        logger.warning(
            "初始管理员 %s 已创建，口令：%s（请设置 OE_ADMIN_PASSWORD 固定口令）",
            info["admin_username"],
            info["generated_admin_password"],
        )
    logger.info(
        "启动完成：schema=%s admin=%s 迁移历史版本 %s 条",
        config.db_path(),
        info.get("admin_username"),
        info.get("legacy_versions_migrated", 0),
    )


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "data": {"status": "up"}}


@app.get("/api/config")
def public_config() -> dict:
    """前端可读取的非敏感运行时配置。"""
    return {
        "ok": True,
        "data": {
            "dev_auto_register": config.is_dev_auto_register(),
            "max_rows": config.MAX_ROWS,
            "max_cols": config.MAX_COLS,
            "roles": list(config.ROLE_LEVEL),
        },
    }


app.include_router(routes.router)
app.include_router(ws.router)
