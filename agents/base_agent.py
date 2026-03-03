"""
Agent 基类
- 统一封装 anthropic API 调用
- 读取系统提示文件
- 工具调用（Read/Write/Edit/Bash/Glob/Grep）的本地实现
"""

import datetime
import os
import subprocess
from pathlib import Path
from typing import Any, Optional
import anthropic
import toml


# 可用工具定义（anthropic tool_use 格式）
TOOL_DEFINITIONS = [
    {
        "name": "Read",
        "description": "读取文件内容",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "文件的绝对或相对路径"}
            },
            "required": ["file_path"],
        },
    },
    {
        "name": "Write",
        "description": "将内容写入文件（覆盖）",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path": {"type": "string", "description": "文件路径"},
                "content":   {"type": "string", "description": "文件内容"},
            },
            "required": ["file_path", "content"],
        },
    },
    {
        "name": "Edit",
        "description": "替换文件中的特定文本（精确匹配）",
        "input_schema": {
            "type": "object",
            "properties": {
                "file_path":  {"type": "string"},
                "old_string": {"type": "string"},
                "new_string": {"type": "string"},
            },
            "required": ["file_path", "old_string", "new_string"],
        },
    },
    {
        "name": "Glob",
        "description": "按 glob 模式列举文件",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern":   {"type": "string", "description": "glob 模式，如 **/*.go"},
                "directory": {"type": "string", "description": "搜索根目录（可选）"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "Grep",
        "description": "在文件中搜索内容（正则）",
        "input_schema": {
            "type": "object",
            "properties": {
                "pattern":   {"type": "string", "description": "正则表达式"},
                "path":      {"type": "string", "description": "搜索路径（文件或目录）"},
                "glob":      {"type": "string", "description": "文件过滤 glob，如 *.go"},
            },
            "required": ["pattern"],
        },
    },
    {
        "name": "Bash",
        "description": "执行 shell 命令",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {"type": "string", "description": "要执行的命令"},
                "timeout": {"type": "integer", "description": "超时秒数（默认60）"},
            },
            "required": ["command"],
        },
    },
]

_GLOB_LIMIT = 100
_GREP_LIMIT = 100


class BaseAgent:
    """
    所有 Agent 的基类。

    子类需设置：
    - AGENT_NAME: str
    - ALLOWED_TOOLS: list[str]  （从 TOOL_DEFINITIONS 中选）
    - SYSTEM_PROMPT_FILE: str   （.claude/agents/*.md）
    """

    AGENT_NAME: str = "base"
    ALLOWED_TOOLS: list[str] = []
    SYSTEM_PROMPT_FILE: str = ""

    def __init__(self, config_path: str = "config.toml"):
        cfg = toml.load(config_path)
        self._cfg = cfg
        claude_cfg = cfg.get("claude", {})
        self._model = claude_cfg.get("model", "claude-sonnet-4-6")
        self._max_tokens = claude_cfg.get("max_tokens", 8192)
        self._workspace = cfg.get("project", {}).get("workspace_path", ".")

        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
        self._client = anthropic.Anthropic(api_key=api_key)

        self._system_prompt = self._load_system_prompt()

    def _load_system_prompt(self) -> str:
        if not self.SYSTEM_PROMPT_FILE:
            return f"你是 {self.AGENT_NAME} agent。"
        path = Path(self.SYSTEM_PROMPT_FILE)
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return f"你是 {self.AGENT_NAME} agent。"

    def _get_tools(self) -> list[dict]:
        return [t for t in TOOL_DEFINITIONS if t["name"] in self.ALLOWED_TOOLS]

    # ------------------------------------------------------------------ #
    # 共享辅助方法
    # ------------------------------------------------------------------ #

    def _get_output_path(self, filename: str, task_id: str = "") -> str:
        """生成标准输出路径。task_id 为空时在文件名中附加日期。"""
        if task_id:
            return f"./work/{task_id}/{filename}"
        today = datetime.date.today().isoformat()
        stem, ext = filename.rsplit(".", 1) if "." in filename else (filename, "")
        suffix = f".{ext}" if ext else ""
        return f"./work/{stem}-{today}{suffix}"

    def _ensure_output_dir(self, file_path: str) -> str:
        """确保文件所在目录存在，返回原路径。"""
        Path(file_path).parent.mkdir(parents=True, exist_ok=True)
        return file_path

    def _parse_result_marker(self, output_path: str, marker: str, fallback_text: str) -> bool:
        """从输出文件或 fallback 文本中查找成功标记。"""
        try:
            content = Path(output_path).read_text(encoding="utf-8")
        except FileNotFoundError:
            content = fallback_text
        return marker in content

    # ------------------------------------------------------------------ #
    # 主运行循环
    # ------------------------------------------------------------------ #

    def run(self, prompt: str, extra_context: str = "") -> str:
        """运行 Agent，返回最终文本结果（工具调用循环直到无 tool_use）。"""
        full_prompt = prompt
        if extra_context:
            full_prompt = f"<context>\n{extra_context}\n</context>\n\n{prompt}"

        messages = [{"role": "user", "content": full_prompt}]
        tools = self._get_tools()

        while True:
            kwargs: dict[str, Any] = dict(
                model=self._model,
                max_tokens=self._max_tokens,
                system=self._system_prompt,
                messages=messages,
            )
            if tools:
                kwargs["tools"] = tools

            response = self._client.messages.create(**kwargs)

            text_parts: list[str] = []
            tool_uses: list[dict] = []

            for block in response.content:
                if block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_uses.append({
                        "id":    block.id,
                        "name":  block.name,
                        "input": block.input,
                    })

            if not tool_uses:
                return "\n".join(text_parts)

            assistant_content = response.content
            tool_results = []
            for tu in tool_uses:
                result = self._execute_tool(tu["name"], tu["input"])
                tool_results.append({
                    "type":        "tool_result",
                    "tool_use_id": tu["id"],
                    "content":     str(result),
                })

            messages.append({"role": "assistant", "content": assistant_content})
            messages.append({"role": "user",      "content": tool_results})

    # ------------------------------------------------------------------ #
    # 工具执行
    # ------------------------------------------------------------------ #

    def _execute_tool(self, name: str, inputs: dict) -> str:
        if name not in self.ALLOWED_TOOLS:
            return f"[错误] {self.AGENT_NAME} 无权使用工具 {name}"

        try:
            if name == "Read":
                return self._tool_read(inputs["file_path"])
            elif name == "Write":
                return self._tool_write(inputs["file_path"], inputs["content"])
            elif name == "Edit":
                return self._tool_edit(
                    inputs["file_path"], inputs["old_string"], inputs["new_string"]
                )
            elif name == "Glob":
                return self._tool_glob(inputs["pattern"], inputs.get("directory"))
            elif name == "Grep":
                return self._tool_grep(
                    inputs["pattern"],
                    inputs.get("path", "."),
                    inputs.get("glob"),
                )
            elif name == "Bash":
                return self._tool_bash(inputs["command"], inputs.get("timeout", 60))
            else:
                return f"[错误] 未知工具: {name}"
        except Exception as e:
            return f"[错误] 工具 {name} 执行失败: {e}"

    def _tool_read(self, file_path: str) -> str:
        try:
            return Path(file_path).read_text(encoding="utf-8")
        except FileNotFoundError:
            return f"[错误] 文件不存在: {file_path}"

    def _tool_write(self, file_path: str, content: str) -> str:
        path = Path(file_path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return f"已写入 {file_path}（{len(content)} 字节）"

    def _tool_edit(self, file_path: str, old_string: str, new_string: str) -> str:
        try:
            content = Path(file_path).read_text(encoding="utf-8")
        except FileNotFoundError:
            return f"[错误] 文件不存在: {file_path}"
        if old_string not in content:
            return "[错误] 未找到要替换的字符串"
        Path(file_path).write_text(content.replace(old_string, new_string, 1), encoding="utf-8")
        return f"已编辑 {file_path}"

    def _tool_glob(self, pattern: str, directory: Optional[str] = None) -> str:
        base = Path(directory) if directory else Path(".")
        matches: list[str] = []
        for p in base.glob(pattern):
            matches.append(str(p))
            if len(matches) >= _GLOB_LIMIT:
                break
        if not matches:
            return "（未找到匹配文件）"
        return "\n".join(sorted(matches))

    def _tool_grep(self, pattern: str, path: str, file_glob: Optional[str]) -> str:
        try:
            cmd = [
                "grep", "-rn",
                "--include", file_glob or "*",
                f"-m{_GREP_LIMIT}",
                pattern, path,
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            output = result.stdout.strip()
            return output if output else "（未找到匹配内容）"
        except Exception as e:
            return f"[错误] grep 执行失败: {e}"

    def _tool_bash(self, command: str, timeout: int = 60) -> str:
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=self._workspace,
            )
            output = []
            if result.stdout:
                output.append(result.stdout.strip())
            if result.stderr:
                output.append(f"[stderr] {result.stderr.strip()}")
            if result.returncode != 0:
                output.append(f"[退出码] {result.returncode}")
            return "\n".join(output) if output else "（命令执行完毕，无输出）"
        except subprocess.TimeoutExpired:
            return f"[错误] 命令超时（{timeout}秒）"
        except Exception as e:
            return f"[错误] 命令执行失败: {e}"
