"""
主入口：启动飞书机器人 + Orchestrator
"""

import asyncio
import logging
import sys
import toml

from orchestrator import Orchestrator
from feishu_bot import FeishuBot

# 配置日志
def setup_logging(config_path: str = "config.toml"):
    cfg = toml.load(config_path)
    log_cfg = cfg.get("logging", {})
    level = getattr(logging, log_cfg.get("level", "INFO").upper(), logging.INFO)
    log_file = log_cfg.get("file", "./logs/agent.log")

    import os
    os.makedirs(os.path.dirname(log_file), exist_ok=True)

    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(levelname)s: %(message)s",
        handlers=[
            logging.StreamHandler(sys.stdout),
            logging.FileHandler(log_file, encoding="utf-8"),
        ],
    )


def main():
    config_path = "config.toml"
    setup_logging(config_path)
    logger = logging.getLogger("main")

    # 初始化飞书机器人
    bot = FeishuBot(config_path)

    # 初始化 Orchestrator，注入飞书通知回调
    orchestrator = Orchestrator(
        config_path=config_path,
        notify_callback=bot.send_text,
    )
    bot.set_orchestrator(orchestrator)

    logger.info("=" * 60)
    logger.info("多 Agent 自动化开发系统启动")
    logger.info("=" * 60)

    # 启动（阻塞，飞书 WebSocket 长连）
    bot.start()


if __name__ == "__main__":
    main()
