"""Design Agent：根据 Story 生成技术方案"""

from .base_agent import BaseAgent


class DesignAgent(BaseAgent):
    AGENT_NAME = "design"
    ALLOWED_TOOLS = ["Read", "Glob", "Grep", "Write"]
    SYSTEM_PROMPT_FILE = ".claude/agents/design.md"

    def design(self, story_path: str, memory_context: str = "", task_id: str = "") -> str:
        """
        读取 story.md，生成 tech-spec.md。
        Returns: tech-spec.md 的路径
        """
        output_path = self._ensure_output_dir(self._get_output_path("tech-spec.md", task_id))

        prompt = f"""
## 你的任务

根据以下 Story，为项目生成详细的技术方案，保存到 `{output_path}`。

## Story 文件路径

`{story_path}`

## 相关记忆

{memory_context or "（暂无相关记忆）"}

## 执行步骤

1. 读取 `{story_path}` 获取需求详情
2. 读取 `memory/facts.md` 了解技术栈
3. 读取 `memory/patterns/` 目录，查看可复用的代码模式
4. 使用 Glob/Grep 分析项目代码结构（在项目 workspace 中）
5. 编写技术方案
6. 将 tech-spec.md 写入 `{output_path}`

请按照系统提示中的格式输出技术方案，特别注意：
- 精确列出每个需要修改的文件
- 明确接口变更和数据库变更
- 识别风险点
"""
        self.run(prompt)
        return output_path
