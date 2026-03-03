"""Dev Agent：根据技术方案实现代码"""

from .base_agent import BaseAgent


class DevAgent(BaseAgent):
    AGENT_NAME = "dev"
    ALLOWED_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "Bash"]

    def __init__(self, backend: bool = True, config_path: str = "config.toml"):
        super().__init__(config_path)
        self._backend = backend
        self.SYSTEM_PROMPT_FILE = (
            ".claude/agents/dev_backend.md" if backend else ".claude/agents/dev_frontend.md"
        )
        self._system_prompt = self._load_system_prompt()

    def implement(self, tech_spec_path: str, memory_context: str = "", task_id: str = "") -> str:
        """
        读取 tech-spec.md，实现代码变更，生成开发报告。
        Returns: dev-report-{mode}.md 的路径
        """
        mode = "backend" if self._backend else "frontend"
        output_path = self._ensure_output_dir(
            self._get_output_path(f"dev-report-{mode}.md", task_id)
        )

        prompt = f"""
## 你的任务

根据技术方案实现{"后端 Go" if self._backend else "前端 Next.js"}代码变更。

## 技术方案路径

`{tech_spec_path}`

## 相关记忆（代码模式参考）

{memory_context or "（暂无相关记忆）"}

## 执行步骤

1. 读取 `{tech_spec_path}` 获取技术方案详情
2. 读取"影响文件列表"中的每个文件，了解现有代码
3. 读取 `memory/patterns/` 中相关的代码模式
4. 按方案实现代码变更（Edit/Write 文件）
5. 运行编译命令确认无误
6. 将开发报告写入 `{output_path}`

**重要约束**：
- 只修改技术方案中列出的文件
- 不重构无关代码
- 遇到不确定的地方在报告中注明
"""
        self.run(prompt)
        return output_path
