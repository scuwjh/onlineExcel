"""钉钉机器人推送（REQ-115）。

设计要点
--------
- 配置全部来自环境变量（见 :mod:`app.config`），**不经接口回传**，避免 webhook 泄漏；
- 评论落库后由调用方在**后台线程**里投递，钉钉不可用时只记日志，
  绝不影响评论写入与 WebSocket 广播；
- 自定义机器人的 @ 语义要求「文本里出现 @手机号」且 `atMobiles` 同时带上手机号，
  两者缺一钉钉都不会真正提醒到人，因此 :func:`build_payload` 与
  :func:`comment_text` 一起保证这一点；
- 从不使用 `isAtAll`，避免全群打扰。
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from typing import Iterable, Optional

from . import config

logger = logging.getLogger("online_excel.dingtalk")


@dataclass
class DingTalkConfig:
    """一次推送所需的配置快照（便于测试注入）。"""

    enabled: bool = False
    webhook: str = ""
    secret: str = ""
    mobiles: dict = field(default_factory=dict)
    timeout: float = 5.0

    @property
    def configured(self) -> bool:
        return bool(self.enabled and self.webhook)


def load_config() -> DingTalkConfig:
    """从环境变量构造配置。"""
    return DingTalkConfig(
        enabled=config.DINGTALK_ENABLED,
        webhook=config.DINGTALK_WEBHOOK,
        secret=config.DINGTALK_SECRET,
        mobiles=config.dingtalk_mobiles(),
        timeout=config.DINGTALK_TIMEOUT,
    )


def sign_url(webhook: str, secret: str, timestamp_ms: int) -> str:
    """按钉钉「加签」规范把 ``timestamp`` 与 ``sign`` 追加到 webhook 上。"""
    string_to_sign = f"{timestamp_ms}\n{secret}"
    digest = hmac.new(
        secret.encode("utf-8"), string_to_sign.encode("utf-8"), hashlib.sha256
    ).digest()
    sign = urllib.parse.quote_plus(base64.b64encode(digest).decode("utf-8"))
    separator = "&" if "?" in webhook else "?"
    return f"{webhook}{separator}timestamp={timestamp_ms}&sign={sign}"


def build_payload(text: str, at_mobiles: Optional[Iterable[str]] = None) -> dict:
    mobiles = [str(m) for m in (at_mobiles or []) if m]
    return {
        "msgtype": "text",
        "text": {"content": text},
        "at": {"atMobiles": mobiles, "isAtAll": False},
    }


def _post_json(url: str, payload: dict, timeout: float) -> dict:
    """真实投递（测试通过 monkeypatch 本函数替换掉网络调用）。"""
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - 白名单 webhook
        raw = response.read().decode("utf-8", "ignore")
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"errcode": -1, "errmsg": raw[:200]}


def send_text(
    text: str,
    at_mobiles: Optional[Iterable[str]] = None,
    *,
    cfg: Optional[DingTalkConfig] = None,
) -> dict:
    """发送一条 text 消息；未配置或失败都返回结构化结果，不抛异常。"""
    cfg = cfg or load_config()
    mobiles = [str(m) for m in (at_mobiles or []) if m]
    if not cfg.configured:
        return {
            "ok": False,
            "skipped": "未配置钉钉机器人（需 OE_DINGTALK_ENABLED=1 且 OE_DINGTALK_WEBHOOK）",
            "at_mobiles": mobiles,
        }
    url = sign_url(cfg.webhook, cfg.secret, int(time.time() * 1000)) if cfg.secret else cfg.webhook
    payload = build_payload(text, mobiles)
    try:
        result = _post_json(url, payload, cfg.timeout)
    except Exception as exc:  # 网络/超时/HTTP 错误都不应影响调用方
        logger.warning("钉钉推送失败：%s", exc)
        return {"ok": False, "error": str(exc), "at_mobiles": mobiles}
    errcode = int(result.get("errcode", -1) or 0)
    ok = errcode == 0
    if not ok:
        logger.warning("钉钉推送被拒绝：errcode=%s errmsg=%s", errcode, result.get("errmsg"))
    return {
        "ok": ok,
        "errcode": errcode,
        "errmsg": result.get("errmsg", ""),
        "at_mobiles": mobiles,
    }


def comment_text(
    *,
    sheet_name: str,
    author: str,
    body: str,
    cell_label: str = "",
    at_mobiles: Optional[Iterable[str]] = None,
) -> str:
    """拼装提醒正文：包含 ``@手机号``（钉钉 @ 生效的必要条件）。"""
    where = f"《{sheet_name}》" if sheet_name else ""
    at_cell = f"{cell_label} " if cell_label else ""
    prefix = f"【表格提醒】{author} 在 {where}{at_cell}的评论中提到你："
    mentions = " ".join(f"@{mobile}" for mobile in (at_mobiles or []) if mobile)
    text = f"{prefix}{body}"
    return f"{text} {mentions}" if mentions else text


def notify_comment_mentions(
    *,
    sheet_name: str,
    author: str,
    body: str,
    mentioned_users: Iterable[str],
    cell_label: str = "",
    cfg: Optional[DingTalkConfig] = None,
) -> dict:
    """按「用户名 → 手机号」映射把 @提及 转成钉钉 atMobiles 并推送。"""
    cfg = cfg or load_config()
    users = [str(name) for name in (mentioned_users or []) if name]
    if not users:
        return {"ok": False, "skipped": "没有 @提及", "at_mobiles": []}
    mobiles: list = []
    for name in users:
        mobile = cfg.mobiles.get(name)
        if mobile and mobile not in mobiles:
            mobiles.append(mobile)
    if not mobiles:
        return {
            "ok": False,
            "skipped": "被 @ 的用户未配置手机号（OE_DINGTALK_MOBILES）",
            "at_mobiles": [],
            "users": users,
        }
    text = comment_text(
        sheet_name=sheet_name, author=author, body=body, cell_label=cell_label, at_mobiles=mobiles
    )
    result = send_text(text, mobiles, cfg=cfg)
    result["users"] = users
    return result


def notify_in_background(**kwargs) -> None:
    """在后台线程投递提醒：调用方（评论接口）不应被网络耗时或失败拖累。"""

    def _run() -> None:
        try:
            notify_comment_mentions(**kwargs)
        except Exception:  # pragma: no cover - 兜底，绝不冒泡到请求线程
            logger.exception("钉钉提醒后台任务异常")

    thread = threading.Thread(target=_run, name="dingtalk-notify", daemon=True)
    thread.start()


def status() -> dict:
    """集成状态（**不包含** webhook 与 secret）。"""
    cfg = load_config()
    return {
        "enabled": bool(cfg.enabled),
        "configured": bool(cfg.configured),
        "has_secret": bool(cfg.secret),
        "mobile_map_size": len(cfg.mobiles),
    }
