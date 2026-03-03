"""
共享记忆层
- 文件存储：facts.md, decisions/, patterns/, bugs/, daily/
- 向量检索：ChromaDB（语义相似度搜索）
"""

import re
import datetime
from pathlib import Path
from typing import Optional
import toml

# chromadb 为可选依赖，未安装时降级为纯文件检索
try:
    import chromadb
    from chromadb.utils import embedding_functions
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False


class MemoryManager:
    """
    共享记忆层：所有 agent 通过此类读写结构化记忆。

    写入权限控制（通过 agent_name 参数实现软约束）：
    - orchestrator  → daily/, decisions/
    - design        → decisions/, patterns/
    - dev           → patterns/（只读其他）
    - test          → bugs/
    """

    _WRITE_PERMISSIONS = {
        "orchestrator": ["daily", "decisions"],
        "design":       ["decisions", "patterns"],
        "dev":          ["patterns"],
        "test":         ["bugs"],
        "pm":           [],
    }

    def __init__(self, config_path: str = "config.toml"):
        cfg = toml.load(config_path)
        mem_cfg = cfg.get("memory", {})
        self.base_path = Path(mem_cfg.get("base_path", "./memory"))
        self.recall_top_k = mem_cfg.get("recall_top_k", 5)
        chroma_path = mem_cfg.get("chroma_path", "./memory/chroma")

        # 目录按需创建（写入时创建，非启动时）
        self._chroma_client = None
        self._collection = None
        if CHROMA_AVAILABLE:
            try:
                self._chroma_client = chromadb.PersistentClient(path=chroma_path)
                ef = embedding_functions.DefaultEmbeddingFunction()
                self._collection = self._chroma_client.get_or_create_collection(
                    name="agent_memory",
                    embedding_function=ef,
                )
            except Exception as e:
                print(f"[MemoryManager] ChromaDB 初始化失败（降级为文件检索）: {e}")

    # ------------------------------------------------------------------ #
    # 读接口（所有 agent 可调用）
    # ------------------------------------------------------------------ #

    def read_facts(self) -> str:
        return self._read_file(self.base_path / "facts.md")

    def list_decisions(self) -> list[str]:
        return self._list_md_files(self.base_path / "decisions")

    def read_decision(self, filename: str) -> str:
        return self._read_file(self.base_path / "decisions" / filename)

    def list_patterns(self) -> list[str]:
        return self._list_md_files(self.base_path / "patterns")

    def read_pattern(self, filename: str) -> str:
        return self._read_file(self.base_path / "patterns" / filename)

    def list_bugs(self) -> list[str]:
        return self._list_md_files(self.base_path / "bugs")

    def read_bug(self, filename: str) -> str:
        return self._read_file(self.base_path / "bugs" / filename)

    def recall(self, query: str, top_k: Optional[int] = None) -> str:
        """
        语义召回：根据查询字符串，返回最相关的记忆片段。
        优先用 ChromaDB，降级时扫描全部 .md 文件做关键词匹配。
        """
        k = top_k or self.recall_top_k
        if self._collection is not None:
            return self._recall_chroma(query, k)
        return self._recall_keyword(query, k)

    # ------------------------------------------------------------------ #
    # 写接口（带权限检查）
    # ------------------------------------------------------------------ #

    def write_daily_log(self, agent_name: str, content: str) -> str:
        self._check_permission(agent_name, "daily")
        today = datetime.date.today().isoformat()
        path = self._ensure_dir(self.base_path / "daily") / f"{today}.md"
        timestamp = datetime.datetime.now().strftime("%H:%M:%S")
        # 追加模式：不读整个文件
        with path.open("a", encoding="utf-8") as f:
            f.write(f"\n\n## [{timestamp}] {agent_name}\n{content}")
        self._index_document(str(path), content)
        return str(path)

    def write_decision(self, agent_name: str, title: str, content: str) -> str:
        self._check_permission(agent_name, "decisions")
        today = datetime.date.today().isoformat()
        filename = self._sanitize_filename(title, prefix=f"{today}-")
        path = self._ensure_dir(self.base_path / "decisions") / filename
        path.write_text(content, encoding="utf-8")
        self._index_document(str(path), content)
        return str(path)

    def write_pattern(self, agent_name: str, title: str, content: str) -> str:
        self._check_permission(agent_name, "patterns")
        filename = self._sanitize_filename(title)
        path = self._ensure_dir(self.base_path / "patterns") / filename
        path.write_text(content, encoding="utf-8")
        self._index_document(str(path), content)
        return str(path)

    def write_bug(self, agent_name: str, title: str, content: str) -> str:
        self._check_permission(agent_name, "bugs")
        filename = self._sanitize_filename(title)
        path = self._ensure_dir(self.base_path / "bugs") / filename
        path.write_text(content, encoding="utf-8")
        self._index_document(str(path), content)
        return str(path)

    def update_facts(self, agent_name: str, content: str) -> str:
        if agent_name != "orchestrator":
            raise PermissionError(f"[MemoryManager] {agent_name} 无权修改 facts.md")
        path = self.base_path / "facts.md"
        path.write_text(content, encoding="utf-8")
        self._index_document(str(path), content)
        return str(path)

    # ------------------------------------------------------------------ #
    # 内部方法
    # ------------------------------------------------------------------ #

    def _check_permission(self, agent_name: str, directory: str):
        allowed = self._WRITE_PERMISSIONS.get(agent_name, [])
        if directory not in allowed:
            raise PermissionError(
                f"[MemoryManager] {agent_name} 无权写入 {directory}/ 目录"
            )

    def _sanitize_filename(self, title: str, prefix: str = "", max_len: int = 50) -> str:
        """生成安全的 .md 文件名。"""
        safe = re.sub(r"[^\w\-]", "-", title)[:max_len]
        return f"{prefix}{safe}.md"

    @staticmethod
    def _ensure_dir(directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        return directory

    def _read_file(self, path: Path) -> str:
        try:
            return path.read_text(encoding="utf-8")
        except FileNotFoundError:
            return ""

    def _list_md_files(self, directory: Path) -> list[str]:
        if not directory.exists():
            return []
        return sorted(f.name for f in directory.glob("*.md"))

    def _index_document(self, doc_id: str, content: str):
        if self._collection is None:
            return
        try:
            self._collection.upsert(documents=[content], ids=[doc_id])
        except Exception:
            pass

    def _recall_chroma(self, query: str, k: int) -> str:
        try:
            count = self._collection.count()
            if count == 0:
                return "（记忆库为空）"
            results = self._collection.query(
                query_texts=[query],
                n_results=min(k, count),
            )
            docs = results.get("documents", [[]])[0]
            return "\n\n---\n\n".join(docs) if docs else "（记忆库为空）"
        except Exception as e:
            return f"（ChromaDB 查询失败: {e}）"

    def _recall_keyword(self, query: str, k: int) -> str:
        """降级方案：关键词匹配，返回包含查询词的文件内容片段。"""
        keywords = query.lower().split()
        matches: list[tuple[int, str, str]] = []

        all_files: list[Path] = []
        for sub in ["facts.md", "decisions", "patterns", "bugs", "daily"]:
            p = self.base_path / sub
            if p.is_file():
                all_files.append(p)
            elif p.is_dir():
                all_files.extend(p.glob("*.md"))

        for file_path in all_files:
            content = self._read_file(file_path)
            lower_content = content.lower()
            score = sum(lower_content.count(kw) for kw in keywords)
            if score > 0:
                matches.append((score, str(file_path), content))

        matches.sort(key=lambda x: x[0], reverse=True)
        results = []
        for _, path, content in matches[:k]:
            snippet = content[:500] + ("..." if len(content) > 500 else "")
            results.append(f"**来源**: {path}\n{snippet}")

        return "\n\n---\n\n".join(results) if results else "（未找到相关记忆）"
