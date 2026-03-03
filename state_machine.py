"""
工作流状态机
- 状态持久化到 JSON 文件，支持服务重启后恢复
- 每个任务（Task）有唯一 task_id，贯穿整个流水线
"""

import json
import uuid
import datetime
from enum import Enum
from pathlib import Path
from typing import Optional
from dataclasses import dataclass, field, asdict


class WorkflowState(str, Enum):
    INTAKE       = "INTAKE"           # 接收到飞书消息
    PLANNING     = "PLANNING"         # PM Agent 分析需求
    DESIGN       = "DESIGN"           # Design Agent 技术设计
    DEVELOPMENT  = "DEVELOPMENT"      # Dev Agent 实现
    TESTING      = "TESTING"          # Test Agent 测试
    REVIEW       = "REVIEW"           # 测试失败，等待人工介入
    DEPLOY_CONFIRM = "DEPLOY_CONFIRM" # 等待人工确认部署
    DEPLOYING    = "DEPLOYING"        # Deploy Agent 执行部署
    DONE         = "DONE"             # 完成
    FAILED       = "FAILED"           # 最终失败


# 状态转移表（允许的下一个状态）
TRANSITIONS: dict[WorkflowState, list[WorkflowState]] = {
    WorkflowState.INTAKE:          [WorkflowState.PLANNING, WorkflowState.DONE],
    WorkflowState.PLANNING:        [WorkflowState.DESIGN],
    WorkflowState.DESIGN:          [WorkflowState.DEVELOPMENT],
    WorkflowState.DEVELOPMENT:     [WorkflowState.TESTING],
    WorkflowState.TESTING:         [WorkflowState.DEPLOY_CONFIRM, WorkflowState.DEVELOPMENT, WorkflowState.REVIEW],
    WorkflowState.REVIEW:          [WorkflowState.DEVELOPMENT, WorkflowState.FAILED],
    WorkflowState.DEPLOY_CONFIRM:  [WorkflowState.DEPLOYING, WorkflowState.DONE],
    WorkflowState.DEPLOYING:       [WorkflowState.DONE, WorkflowState.FAILED],
    WorkflowState.DONE:            [],
    WorkflowState.FAILED:          [],
}


@dataclass
class TaskContext:
    """单个任务的完整上下文，持久化到 JSON"""
    task_id: str = field(default_factory=lambda: str(uuid.uuid4())[:8])
    state: str = WorkflowState.INTAKE.value

    # 飞书元信息
    feishu_chat_id: str = ""
    feishu_message_id: str = ""
    requester_user_id: str = ""
    original_request: str = ""

    # Agent 输出文件路径
    story_path: Optional[str] = None
    tech_spec_path: Optional[str] = None
    dev_report_path: Optional[str] = None
    test_report_path: Optional[str] = None
    deploy_report_path: Optional[str] = None

    # 测试重试计数
    test_retry_count: int = 0
    max_test_retries: int = 3

    # 时间戳
    created_at: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())
    updated_at: str = field(default_factory=lambda: datetime.datetime.utcnow().isoformat())

    # 错误信息（如有）
    error: Optional[str] = None

    # 额外上下文（自由格式 key-value）
    metadata: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "TaskContext":
        return cls(**data)


class StateMachine:
    """
    管理所有任务的状态，持久化到 ./states/ 目录。
    每个任务一个 JSON 文件：states/{task_id}.json
    """

    def __init__(self, states_dir: str = "./states"):
        self.states_dir = Path(states_dir)
        self.states_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ #
    # 任务生命周期
    # ------------------------------------------------------------------ #

    def create_task(
        self,
        original_request: str,
        feishu_chat_id: str = "",
        feishu_message_id: str = "",
        requester_user_id: str = "",
        max_test_retries: int = 3,
    ) -> TaskContext:
        ctx = TaskContext(
            original_request=original_request,
            feishu_chat_id=feishu_chat_id,
            feishu_message_id=feishu_message_id,
            requester_user_id=requester_user_id,
            max_test_retries=max_test_retries,
        )
        self._save(ctx)
        return ctx

    def load_task(self, task_id: str) -> Optional[TaskContext]:
        path = self.states_dir / f"{task_id}.json"
        if not path.exists():
            return None
        data = json.loads(path.read_text(encoding="utf-8"))
        return TaskContext.from_dict(data)

    def transition(
        self,
        ctx: TaskContext,
        new_state: WorkflowState,
        **updates,
    ) -> TaskContext:
        """
        执行状态转移。
        - 校验转移合法性
        - 更新 ctx 字段
        - 持久化
        """
        current = WorkflowState(ctx.state)
        allowed = TRANSITIONS.get(current, [])
        if new_state not in allowed:
            raise ValueError(
                f"[StateMachine] 非法状态转移 {current} → {new_state}，"
                f"允许的目标状态：{allowed}"
            )

        ctx.state = new_state.value
        ctx.updated_at = datetime.datetime.utcnow().isoformat()

        # 应用额外更新
        for key, value in updates.items():
            if hasattr(ctx, key):
                setattr(ctx, key, value)

        self._save(ctx)
        return ctx

    def fail_task(self, ctx: TaskContext, error: str) -> TaskContext:
        ctx.state = WorkflowState.FAILED.value
        ctx.error = error
        ctx.updated_at = datetime.datetime.utcnow().isoformat()
        self._save(ctx)
        return ctx

    def list_active_tasks(self) -> list[TaskContext]:
        """列出所有未完成的任务"""
        tasks = []
        terminal = {WorkflowState.DONE.value, WorkflowState.FAILED.value}
        for json_file in self.states_dir.glob("*.json"):
            data = json.loads(json_file.read_text(encoding="utf-8"))
            ctx = TaskContext.from_dict(data)
            if ctx.state not in terminal:
                tasks.append(ctx)
        return tasks

    def can_retry_test(self, ctx: TaskContext) -> bool:
        return ctx.test_retry_count < ctx.max_test_retries

    def increment_test_retry(self, ctx: TaskContext) -> TaskContext:
        ctx.test_retry_count += 1
        ctx.updated_at = datetime.datetime.utcnow().isoformat()
        self._save(ctx)
        return ctx

    # ------------------------------------------------------------------ #
    # 内部
    # ------------------------------------------------------------------ #

    def _save(self, ctx: TaskContext):
        path = self.states_dir / f"{ctx.task_id}.json"
        path.write_text(
            json.dumps(ctx.to_dict(), ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
