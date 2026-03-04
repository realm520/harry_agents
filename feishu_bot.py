"""
Lark 机器人集成（HTTP 推送模式）
- 使用 aiohttp 接收 Lark 事件推送
- 发送文本消息和卡片消息（用于确认按钮）
- 解析用户命令（/deploy, /cancel, /status）
"""

import asyncio
import logging
import json
import re
from typing import TYPE_CHECKING

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
)
from aiohttp import web
import toml

if TYPE_CHECKING:
    from orchestrator import Orchestrator

logger = logging.getLogger(__name__)

_RE_DEPLOY = re.compile(r"^/deploy\s+(\S+)",        re.IGNORECASE)
_RE_CANCEL = re.compile(r"^/cancel\s+(\S+)\s*(.*)", re.IGNORECASE)
_RE_STATUS = re.compile(r"^/status$",               re.IGNORECASE)
_RE_AT     = re.compile(r"@\S+\s*")


class FeishuBot:
    """
    Lark 机器人。接收消息 → 调用 Orchestrator → 回复消息。

    支持的命令（在 Lark 群中 @机器人 发送）：
    - 普通文本          → 启动新任务
    - /deploy <task_id> → 确认部署
    - /cancel <task_id> → 取消任务
    - /status           → 查询当前任务状态
    """

    def __init__(self, config_path: str = "config.toml"):
        cfg = toml.load(config_path)
        feishu_cfg = cfg["feishu"]

        self._app_id     = feishu_cfg["app_id"]
        self._app_secret = feishu_cfg["app_secret"]
        self._port       = feishu_cfg.get("port", 8765)

        self._lark_client = (
            lark.Client.builder()
            .app_id(self._app_id)
            .app_secret(self._app_secret)
            .log_level(lark.LogLevel.WARNING)
            .build()
        )

        self._orchestrator: "Orchestrator | None" = None

    def set_orchestrator(self, orchestrator: "Orchestrator"):
        self._orchestrator = orchestrator

    # ------------------------------------------------------------------ #
    # 启动（HTTP 服务器）
    # ------------------------------------------------------------------ #

    def start(self):
        """启动 HTTP 事件服务器（阻塞）"""
        app = web.Application()
        app.router.add_post("/", self._handle_http_event)
        logger.info(f"[FeishuBot] 启动 HTTP 服务器，监听端口 {self._port}...")
        web.run_app(app, port=self._port, access_log=None)

    # ------------------------------------------------------------------ #
    # 事件处理
    # ------------------------------------------------------------------ #

    async def _handle_http_event(self, request: web.Request) -> web.Response:
        """处理 Lark HTTP 推送事件"""
        try:
            body = await request.json()
        except Exception:
            return web.Response(status=400)

        # URL 验证（首次配置时 Lark 发送 challenge）
        if body.get("type") == "url_verification":
            challenge = body.get("challenge", "")
            logger.info(f"[FeishuBot] URL 验证通过")
            return web.Response(
                text=json.dumps({"challenge": challenge}),
                content_type="application/json",
            )

        # 消息事件
        header = body.get("header", {})
        if header.get("event_type") == "im.message.receive_v1":
            asyncio.ensure_future(self._handle_message_event(body.get("event", {})))

        return web.Response(text="{}", content_type="application/json")

    async def _handle_message_event(self, event: dict):
        """解析消息事件并分发"""
        try:
            msg = event.get("message", {})

            if msg.get("message_type") != "text":
                return

            content_dict = json.loads(msg.get("content", "{}"))
            text = _RE_AT.sub("", content_dict.get("text", "")).strip()
            if not text:
                return

            chat_id    = msg.get("chat_id", "")
            message_id = msg.get("message_id", "")
            sender_id  = event.get("sender", {}).get("sender_id", {}).get("open_id", "")

            logger.info(f"[FeishuBot] 收到消息: chat={chat_id}, text={text[:80]}")

            await self._dispatch(chat_id, message_id, sender_id, text)
        except Exception as e:
            logger.exception(f"[FeishuBot] 消息处理异常: {e}")

    async def _dispatch(self, chat_id: str, message_id: str, sender_id: str, text: str):
        """根据文本内容分发到对应处理器"""
        if not self._orchestrator:
            logger.error("[FeishuBot] Orchestrator 未初始化")
            return

        m = _RE_DEPLOY.match(text)
        if m:
            await self._orchestrator.confirm_deploy(m.group(1), sender_id)
            return

        m = _RE_CANCEL.match(text)
        if m:
            await self._orchestrator.reject_task(m.group(1), m.group(2).strip())
            return

        if _RE_STATUS.match(text):
            active = self._orchestrator.list_active_tasks()
            if not active:
                await self.send_text(chat_id, "当前没有进行中的任务。")
            else:
                lines = ["**进行中的任务：**"]
                for t in active:
                    lines.append(f"• `{t.task_id}` [{t.state}]\n  {t.original_request[:60]}")
                await self.send_text(chat_id, "\n".join(lines))
            return

        await self._orchestrator.handle_feishu_message(chat_id, message_id, sender_id, text)

    # ------------------------------------------------------------------ #
    # 发送消息
    # ------------------------------------------------------------------ #

    async def send_text(self, chat_id: str, text: str):
        """发送纯文本消息"""
        try:
            request = (
                CreateMessageRequest.builder()
                .receive_id_type("chat_id")
                .request_body(
                    CreateMessageRequestBody.builder()
                    .receive_id(chat_id)
                    .msg_type("text")
                    .content(json.dumps({"text": text}))
                    .build()
                )
                .build()
            )
            loop = asyncio.get_event_loop()
            resp = await loop.run_in_executor(
                None, lambda: self._lark_client.im.v1.message.create(request)
            )
            if not resp.success():
                logger.error(f"[FeishuBot] 发送消息失败: {resp.msg}")
        except Exception as e:
            logger.exception(f"[FeishuBot] 发送消息异常: {e}")

    async def send_deploy_confirm_card(self, chat_id: str, task_id: str, summary: str):
        """发送部署确认交互卡片"""
        card = {
            "schema": "2.0",
            "body": {
                "elements": [
                    {
                        "tag": "div",
                        "text": {
                            "tag": "lark_md",
                            "content": f"**任务 `{task_id}` 需要确认部署**\n\n{summary}",
                        },
                    },
                    {
                        "tag": "action",
                        "actions": [
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "✅ 确认部署"},
                                "type": "primary",
                                "value": {"action": "deploy", "task_id": task_id},
                            },
                            {
                                "tag": "button",
                                "text": {"tag": "plain_text", "content": "❌ 取消"},
                                "type": "danger",
                                "value": {"action": "cancel", "task_id": task_id},
                            },
                        ],
                    },
                ]
            },
        }
        try:
            request = (
                CreateMessageRequest.builder()
                .receive_id_type("chat_id")
                .request_body(
                    CreateMessageRequestBody.builder()
                    .receive_id(chat_id)
                    .msg_type("interactive")
                    .content(json.dumps(card))
                    .build()
                )
                .build()
            )
            loop = asyncio.get_event_loop()
            resp = await loop.run_in_executor(
                None, lambda: self._lark_client.im.v1.message.create(request)
            )
            if not resp.success():
                logger.error(f"[FeishuBot] 发送卡片失败: {resp.msg}")
        except Exception as e:
            logger.exception(f"[FeishuBot] 发送卡片异常: {e}")
