"""
飞书机器人集成
- 使用 lark-oapi 接收 WebSocket 事件
- 发送文本消息和卡片消息（用于确认按钮）
- 解析用户命令（/deploy, /cancel, /status）
"""

import asyncio
import logging
import json
import re
import threading
from typing import TYPE_CHECKING

import lark_oapi as lark
from lark_oapi.api.im.v1 import (
    CreateMessageRequest,
    CreateMessageRequestBody,
)
import toml

if TYPE_CHECKING:
    from orchestrator import Orchestrator

logger = logging.getLogger(__name__)

# 编译好的命令正则（类级常量，避免重复编译）
_RE_DEPLOY  = re.compile(r"^/deploy\s+(\S+)",        re.IGNORECASE)
_RE_CANCEL  = re.compile(r"^/cancel\s+(\S+)\s*(.*)", re.IGNORECASE)
_RE_STATUS  = re.compile(r"^/status$",               re.IGNORECASE)
_RE_AT      = re.compile(r"@\S+\s*")


class FeishuBot:
    """
    飞书机器人。接收消息 → 调用 Orchestrator → 回复消息。

    支持的命令（在飞书群中 @机器人 发送）：
    - 普通文本 → 启动新任务
    - `/deploy <task_id>` → 确认部署
    - `/cancel <task_id> [原因]` → 取消任务
    - `/status` → 查询当前任务状态
    """

    def __init__(self, config_path: str = "config.toml"):
        cfg = toml.load(config_path)
        feishu_cfg = cfg["feishu"]

        self._app_id     = feishu_cfg["app_id"]
        self._app_secret = feishu_cfg["app_secret"]

        self._lark_client = (
            lark.Client.builder()
            .app_id(self._app_id)
            .app_secret(self._app_secret)
            .log_level(lark.LogLevel.WARNING)
            .build()
        )

        self._orchestrator: "Orchestrator | None" = None
        # 专用事件循环在独立线程中运行，避免 asyncio.run() 每次创建新循环
        self._loop = asyncio.new_event_loop()
        self._loop_thread = threading.Thread(target=self._loop.run_forever, daemon=True)
        self._loop_thread.start()

    def set_orchestrator(self, orchestrator: "Orchestrator"):
        self._orchestrator = orchestrator

    # ------------------------------------------------------------------ #
    # 启动（WebSocket 长连）
    # ------------------------------------------------------------------ #

    def start(self):
        """启动飞书 WebSocket 事件监听（阻塞）"""
        event_handler = (
            lark.EventDispatcherHandler.builder("", "")
            .register_p2_im_message_receive_v1(self._on_message_receive)
            .build()
        )
        cli = lark.ws.Client(
            self._app_id,
            self._app_secret,
            event_handler=event_handler,
            log_level=lark.LogLevel.INFO,
        )
        logger.info("[FeishuBot] 启动 WebSocket 长连...")
        cli.start()

    # ------------------------------------------------------------------ #
    # 事件处理
    # ------------------------------------------------------------------ #

    def _on_message_receive(self, data: lark.im.v1.P2ImMessageReceiveV1):
        """收到飞书消息时的同步回调 —— 向专用事件循环提交协程，不阻塞 WebSocket 线程。"""
        try:
            event = data.event
            msg   = event.message

            if msg.message_type != "text":
                return

            content_dict = json.loads(msg.content)
            text = _RE_AT.sub("", content_dict.get("text", "")).strip()
            if not text:
                return

            chat_id    = msg.chat_id
            message_id = msg.message_id
            sender_id  = event.sender.sender_id.open_id

            logger.info(f"[FeishuBot] 收到消息: chat={chat_id}, text={text[:80]}")

            # 提交到专用事件循环（非阻塞）
            asyncio.run_coroutine_threadsafe(
                self._dispatch(chat_id, message_id, sender_id, text),
                self._loop,
            )
        except Exception as e:
            logger.exception(f"[FeishuBot] 消息处理异常: {e}")

    async def _dispatch(
        self, chat_id: str, message_id: str, sender_id: str, text: str
    ):
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
            resp = self._lark_client.im.v1.message.create(request)
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
            resp = self._lark_client.im.v1.message.create(request)
            if not resp.success():
                logger.error(f"[FeishuBot] 发送卡片失败: {resp.msg}")
        except Exception as e:
            logger.exception(f"[FeishuBot] 发送卡片异常: {e}")
