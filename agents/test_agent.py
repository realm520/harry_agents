"""Test Agent：运行测试，验证代码变更"""

from .base_agent import BaseAgent


class TestAgent(BaseAgent):
    AGENT_NAME = "test"
    ALLOWED_TOOLS = ["Read", "Write", "Bash", "Glob"]
    SYSTEM_PROMPT_FILE = ".claude/agents/test.md"

    def run_tests(
        self,
        story_path: str,
        dev_report_path: str,
        test_command: str,
        memory_context: str = "",
        task_id: str = "",
        retry_count: int = 0,
    ) -> tuple[bool, str]:
        """
        运行测试，返回 (passed, report_path)。
        """
        output_path = self._ensure_output_dir(self._get_output_path("test-report.md", task_id))
        feedback_path = self._get_output_path("test-feedback.md", task_id)

        prompt = f"""
## 你的任务

验证代码变更是否通过测试，并检查是否满足验收标准。

## 输入文件

- Story（验收标准）：`{story_path}`
- 开发报告（变更范围）：`{dev_report_path}`
- 当前重试次数：{retry_count}

## 测试命令

```
{test_command}
```

## 执行步骤

1. 读取 `{story_path}` 了解验收标准
2. 读取 `{dev_report_path}` 了解变更范围
3. 执行测试命令（使用 Bash 工具）
4. 分析测试结果
5. 如测试失败，检查 `memory/bugs/` 中是否有已知 Bug
6. 将测试报告写入 `{output_path}`
7. 如有失败，额外生成 Dev Agent 反馈文件 `{feedback_path}`

请在报告末尾用 `RESULT: PASS` 或 `RESULT: FAIL` 标记最终结论。
"""
        result = self.run(prompt)
        passed = self._parse_result_marker(output_path, "RESULT: PASS", result)
        return passed, output_path

    def get_feedback_path(self, task_id: str) -> str:
        return self._get_output_path("test-feedback.md", task_id)
