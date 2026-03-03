"""Deploy Agent：在获得人工确认后执行部署"""

from .base_agent import BaseAgent


class DeployAgent(BaseAgent):
    AGENT_NAME = "deploy"
    ALLOWED_TOOLS = ["Read", "Write", "Bash"]
    SYSTEM_PROMPT_FILE = ".claude/agents/deploy.md"

    def deploy(
        self,
        test_report_path: str,
        deploy_command: str,
        task_id: str = "",
        confirmed: bool = False,
    ) -> tuple[bool, str]:
        """
        执行部署。必须 confirmed=True 才会实际执行。
        Returns: (success, deploy_report_path)
        """
        if not confirmed:
            raise RuntimeError("[DeployAgent] 部署未经人工确认，拒绝执行")

        output_path = self._ensure_output_dir(self._get_output_path("deploy-report.md", task_id))

        prompt = f"""
## 你的任务

执行生产部署。**已获得人工确认**（confirmed=True）。

## 输入

- 测试报告：`{test_report_path}`
- 部署命令：`{deploy_command}`

## 执行步骤

1. 读取 `{test_report_path}` 确认测试全部通过
2. 执行 `git status` 检查工作区状态
3. 执行部署命令：`{deploy_command}`
4. 将部署报告写入 `{output_path}`

部署完成后在报告末尾用 `DEPLOY: SUCCESS` 或 `DEPLOY: FAILED` 标记结论。
"""
        result = self.run(prompt)
        success = self._parse_result_marker(output_path, "DEPLOY: SUCCESS", result)
        return success, output_path
