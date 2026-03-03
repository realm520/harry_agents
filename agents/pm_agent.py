"""PM Agent：将原始需求转化为结构化 Story"""

from .base_agent import BaseAgent


class PMAgent(BaseAgent):
    AGENT_NAME = "pm"
    ALLOWED_TOOLS = ["Read", "Glob", "Write"]
    SYSTEM_PROMPT_FILE = ".claude/agents/pm.md"

    def analyze(self, request: str, memory_context: str = "", task_id: str = "") -> str:
        """
        分析需求，生成 story.md。
        Returns: story.md 的文件路径
        """
        output_path = self._ensure_output_dir(self._get_output_path("story.md", task_id))

        prompt = f"""
## 你的任务

分析以下用户需求，生成结构化的 Story 文档，并保存到 `{output_path}`。

## 用户需求

{request}

## 相关历史记忆

{memory_context or "（暂无相关记忆）"}

## 执行步骤

1. 先读取 `memory/facts.md` 了解项目结构
2. 列出 `memory/decisions/` 目录，查阅相关决策
3. 分析需求，编写结构化 Story
4. 将 story.md 写入 `{output_path}`

请按照系统提示中的格式输出 story.md。
"""
        self.run(prompt)
        return output_path
