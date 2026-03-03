"""
Orchestrator Agent - 主控制器
- 接收飞书消息
- 意图分类（需求/Bug/查询）
- 编排 Agent 流水线
- 汇总结果并回复飞书
"""

import asyncio
import logging
from typing import Optional, Callable, Awaitable
import toml

from memory_manager import MemoryManager
from state_machine import StateMachine, WorkflowState, TaskContext
from agents import PMAgent, DesignAgent, DevAgent, TestAgent, DeployAgent

logger = logging.getLogger(__name__)


class Orchestrator:
    """
    主编排器。

    外部接口：
    - handle_feishu_message(chat_id, message_id, user_id, text) → 启动流水线
    - confirm_deploy(task_id) → 人工确认部署
    - reject_task(task_id, reason) → 人工拒绝/终止任务
    - list_active_tasks() → 查询进行中的任务
    """

    _BUG_KEYWORDS   = ["bug", "错误", "报错", "问题", "修复", "fix", "崩溃", "异常", "失败"]
    _QUERY_KEYWORDS = ["查询", "进度", "状态", "怎么", "什么", "如何", "帮我查", "查一下"]

    def __init__(
        self,
        config_path: str = "config.toml",
        notify_callback: Optional[Callable[[str, str], Awaitable[None]]] = None,
    ):
        self._cfg = toml.load(config_path)
        self._notify = notify_callback or self._default_notify
        self._memory = MemoryManager(config_path)
        self._state  = StateMachine()
        self._proj_cfg = self._cfg.get("project", {})

        self._pm     = PMAgent(config_path)
        self._design = DesignAgent(config_path)
        self._dev_be = DevAgent(backend=True,  config_path=config_path)
        self._dev_fe = DevAgent(backend=False, config_path=config_path)
        self._test   = TestAgent(config_path)
        self._deploy = DeployAgent(config_path)

    # ------------------------------------------------------------------ #
    # 对外接口
    # ------------------------------------------------------------------ #

    async def handle_feishu_message(
        self,
        chat_id: str,
        message_id: str,
        user_id: str,
        text: str,
    ):
        """接收飞书消息，分类后启动对应流水线"""
        intent = self._classify_intent(text)
        logger.info(f"[Orchestrator] 意图分类: {intent} | 内容: {text[:80]}")

        if intent == "query":
            await self._notify(chat_id, self._answer_query())
            return

        ctx = self._state.create_task(
            original_request=text,
            feishu_chat_id=chat_id,
            feishu_message_id=message_id,
            requester_user_id=user_id,
            max_test_retries=self._proj_cfg.get("max_test_retries", 3),
        )
        ctx.metadata["intent"] = intent

        label = "需求" if intent == "feature" else "Bug修复"
        await self._notify(
            chat_id,
            f"✅ 已收到{label}请求，任务 ID：`{ctx.task_id}`\n正在启动 AI 流水线，请稍候...",
        )
        asyncio.create_task(self._run_pipeline(ctx))

    async def confirm_deploy(self, task_id: str, user_id: str):
        """人工确认部署（飞书按钮触发）"""
        ctx = self._state.load_task(task_id)
        if not ctx:
            return
        if ctx.state != WorkflowState.DEPLOY_CONFIRM.value:
            await self._notify(ctx.feishu_chat_id, f"❌ 任务 {task_id} 当前状态不是等待部署确认")
            return
        ctx = self._state.transition(ctx, WorkflowState.DEPLOYING)
        ctx.metadata["confirmed_by"] = user_id
        asyncio.create_task(self._run_deploy(ctx))

    async def reject_task(self, task_id: str, reason: str = ""):
        """人工拒绝/终止任务"""
        ctx = self._state.load_task(task_id)
        if ctx:
            self._state.fail_task(ctx, f"人工终止: {reason}")
            await self._notify(ctx.feishu_chat_id, f"⛔ 任务 {task_id} 已终止。{reason}")

    def list_active_tasks(self) -> list[TaskContext]:
        """查询所有进行中的任务（供 FeishuBot 等外部调用）"""
        return self._state.list_active_tasks()

    # ------------------------------------------------------------------ #
    # 内部：流水线
    # ------------------------------------------------------------------ #

    async def _run_pipeline(self, ctx: TaskContext):
        """完整的 PLANNING → DESIGN → DEVELOPMENT → TESTING 流水线"""
        try:
            # 整个流水线共享同一次 recall，避免重复查询
            memory_ctx = self._memory.recall(ctx.original_request)

            # ── PLANNING ──────────────────────────────────────────────
            ctx = self._state.transition(ctx, WorkflowState.PLANNING)
            await self._notify(ctx.feishu_chat_id, f"📋 [{ctx.task_id}] PM Agent 正在分析需求...")
            story_path = await asyncio.to_thread(
                self._pm.analyze, ctx.original_request, memory_ctx, ctx.task_id,
            )
            ctx = self._state.transition(ctx, WorkflowState.DESIGN, story_path=story_path)

            # ── DESIGN ────────────────────────────────────────────────
            await self._notify(ctx.feishu_chat_id, f"🏗️ [{ctx.task_id}] Design Agent 正在设计技术方案...")
            tech_spec_path = await asyncio.to_thread(
                self._design.design, story_path, memory_ctx, ctx.task_id,
            )
            ctx = self._state.transition(ctx, WorkflowState.DEVELOPMENT, tech_spec_path=tech_spec_path)
            await self._notify(
                ctx.feishu_chat_id,
                f"📐 [{ctx.task_id}] 技术方案已生成：`{tech_spec_path}`\n🚀 开始代码实现...",
            )

            # ── DEVELOPMENT ───────────────────────────────────────────
            be_report, fe_report = await self._run_development(ctx, tech_spec_path, memory_ctx)
            ctx = self._state.transition(
                ctx, WorkflowState.TESTING, dev_report_path=be_report,
            )
            await self._notify(ctx.feishu_chat_id, f"🧪 [{ctx.task_id}] 开始运行测试...")

            # ── TESTING（带重试）─────────────────────────────────────
            await self._run_testing_loop(ctx, memory_ctx)

        except Exception as e:
            logger.exception(f"[Orchestrator] 流水线异常: {e}")
            self._state.fail_task(ctx, str(e))
            await self._notify(
                ctx.feishu_chat_id,
                f"❌ [{ctx.task_id}] 流水线异常：{e}\n请查看日志排查问题。",
            )

    async def _run_development(
        self, ctx: TaskContext, tech_spec_path: str, memory_ctx: str
    ) -> tuple[str, str]:
        """并行运行前后端 Dev Agent"""
        be_task = asyncio.to_thread(
            self._dev_be.implement, tech_spec_path, memory_ctx, ctx.task_id,
        )
        fe_task = asyncio.to_thread(
            self._dev_fe.implement, tech_spec_path, memory_ctx, ctx.task_id,
        )
        be_report, fe_report = await asyncio.gather(be_task, fe_task)
        await self._notify(
            ctx.feishu_chat_id,
            f"✍️ [{ctx.task_id}] 代码实现完成\n- 后端报告: `{be_report}`\n- 前端报告: `{fe_report}`",
        )
        return be_report, fe_report

    async def _run_testing_loop(self, ctx: TaskContext, memory_ctx: str):
        """测试循环：最多重试 max_test_retries 次"""
        test_command = self._proj_cfg.get("test_command", "make test")

        while True:
            ctx = self._state.load_task(ctx.task_id)
            retry = ctx.test_retry_count

            passed, report_path = await asyncio.to_thread(
                self._test.run_tests,
                ctx.story_path,
                ctx.dev_report_path,
                test_command,
                memory_ctx,
                ctx.task_id,
                retry,
            )
            ctx = self._state.transition(ctx, WorkflowState.TESTING, test_report_path=report_path)

            if passed:
                await self._notify(
                    ctx.feishu_chat_id,
                    f"✅ [{ctx.task_id}] 测试全部通过！\n\n"
                    f"是否部署到生产？请回复：\n"
                    f"• **确认部署** `/deploy {ctx.task_id}`\n"
                    f"• **取消** `/cancel {ctx.task_id}`",
                )
                self._state.transition(ctx, WorkflowState.DEPLOY_CONFIRM)
                self._memory.write_daily_log(
                    "orchestrator",
                    f"任务 {ctx.task_id} 测试通过，等待部署确认。需求：{ctx.original_request[:100]}",
                )
                return

            self._state.increment_test_retry(ctx)

            if not self._state.can_retry_test(ctx):
                ctx = self._state.transition(ctx, WorkflowState.REVIEW)
                await self._notify(
                    ctx.feishu_chat_id,
                    f"🚨 [{ctx.task_id}] 测试连续失败 {ctx.max_test_retries} 次，需要人工介入！\n"
                    f"测试报告：`{report_path}`\n"
                    f"• `/reject {ctx.task_id} <原因>` - 终止任务",
                )
                return

            feedback_path = self._test.get_feedback_path(ctx.task_id)
            await self._notify(
                ctx.feishu_chat_id,
                f"⚠️ [{ctx.task_id}] 第 {retry + 1} 轮测试失败，Dev Agent 正在修复...",
            )
            ctx = self._state.transition(ctx, WorkflowState.DEVELOPMENT)
            await asyncio.to_thread(
                self._dev_be.run,
                f"测试失败，请根据以下反馈修复代码：\n\n反馈文件：`{feedback_path}`\n\n"
                f"读取反馈文件，找到并修复对应的代码问题。修复完成后更新开发报告。",
            )
            ctx = self._state.transition(ctx, WorkflowState.TESTING)

    async def _run_deploy(self, ctx: TaskContext):
        """执行部署"""
        deploy_command = self._proj_cfg.get("deploy_command", "git push origin main")
        try:
            success, report_path = await asyncio.to_thread(
                self._deploy.deploy,
                ctx.test_report_path,
                deploy_command,
                ctx.task_id,
                confirmed=True,
            )
            if success:
                ctx = self._state.transition(ctx, WorkflowState.DONE, deploy_report_path=report_path)
                await self._notify(
                    ctx.feishu_chat_id,
                    f"🎉 [{ctx.task_id}] 部署成功！\n需求「{ctx.original_request[:60]}...」已上线。",
                )
                self._memory.write_daily_log(
                    "orchestrator",
                    f"任务 {ctx.task_id} 部署成功。需求：{ctx.original_request[:100]}",
                )
            else:
                self._state.fail_task(ctx, "部署失败")
                await self._notify(
                    ctx.feishu_chat_id,
                    f"❌ [{ctx.task_id}] 部署失败！\n报告：`{report_path}`\n请人工检查 CI/CD 状态。",
                )
        except Exception as e:
            self._state.fail_task(ctx, str(e))
            await self._notify(ctx.feishu_chat_id, f"❌ [{ctx.task_id}] 部署异常：{e}")

    # ------------------------------------------------------------------ #
    # 意图分类
    # ------------------------------------------------------------------ #

    def _classify_intent(self, text: str) -> str:
        lower = text.lower()
        if any(kw in lower for kw in self._QUERY_KEYWORDS):
            return "query"
        if any(kw in lower for kw in self._BUG_KEYWORDS):
            return "bug"
        return "feature"

    def _answer_query(self) -> str:
        active_tasks = self._state.list_active_tasks()
        if not active_tasks:
            return "当前没有进行中的任务。"
        lines = ["当前进行中的任务："]
        for t in active_tasks:
            lines.append(f"• `{t.task_id}` [{t.state}] {t.original_request[:50]}...")
        return "\n".join(lines)

    async def _default_notify(self, chat_id: str, text: str):
        logger.info(f"[飞书通知] chat={chat_id}: {text}")
        print(f"\n[飞书] {text}\n")
