# 多 Agent 协作的自动化软件开发系统架构

## Context

目标：通过飞书接收需求/Bug，由多个 AI agent 协作完成从「需求理解 → 设计 → 开发 → 测试 → 部署」的完整软件开发链路，无需人工介入代码层面。

参考：openclaw 的 pi agent + 长期记忆，Claude Agent SDK subagents，trellis 工作流模式。

---

## 整体架构图

```
用户(飞书)
    │
    ▼
┌──────────────────────────────────────────────────────┐
│              Orchestrator Agent（指挥官）              │
│  - 理解意图（需求 or Bug？）                           │
│  - 分解任务，编排 Agent 流水线                         │
│  - 汇总结果，回复飞书                                  │
└────────┬──────────┬──────────┬──────────┬────────────┘
         │          │          │          │
         ▼          ▼          ▼          ▼
    [PM Agent] [Design   ] [Dev      ] [Test     ] [Deploy  ]
    需求分析    Agent      Agent      Agent      Agent
    拆分Story  系统设计    写代码      跑测试      触发CI/CD
         │          │          │          │          │
         └──────────┴──────────┴──────────┴──────────┘
                              │
                              ▼
                   ┌──────────────────┐
                   │   共享记忆层      │
                   │  - 项目知识库     │
                   │  - 历史决策       │
                   │  - 代码模式库     │
                   │  - 已知Bug库      │
                   └──────────────────┘
```

---

## 五类 Agent 职责

### 1. Orchestrator Agent（主控 / 常驻）
- **触发**：接收飞书消息
- **职责**：
  - 意图分类：新需求 / Bug 修复 / 问询 / 查进度
  - 从记忆库拉取相关上下文（类似功能历史、相关代码路径）
  - 按工作流编排子 agent 执行顺序
  - 汇总各 agent 结果，格式化回复飞书
- **工具**：`WebSearch`, `Read`（读记忆文件）, `Task`（调用子agent）

### 2. PM Agent（产品/需求分析）
- **输入**：原始需求文字 / Bug 描述
- **输出**：结构化 Story（验收标准 + 技术约束 + 影响范围估算）
- **工具**：`Read`（读高层文档）, `Glob`（列举模块结构）, `Write`（生成 story.md）
- **记忆**：读取历史需求模式，避免重复建轮子
- **代码阅读策略**：PM Agent **读高层、不读实现**

  | 读 ✅ | 不读 ❌ |
  |-------|--------|
  | `CLAUDE.md`（架构概述、模块说明） | 具体 `.go`/`.tsx` 源文件 |
  | 数据模型摘要（claudedocs/） | SQL 迁移细节 |
  | API 路由列表（handler 文件名/路径） | 算法实现逻辑 |
  | 历史 stories/decisions/ | 测试代码 |

  **原因**：PM 要判断「这个需求涉及哪些模块」「是否已有类似功能」，需要系统级视图，但不需要实现细节（那是 Design Agent 的职责）。这和人类 PM 工作方式一致。

### 3. Design Agent（架构设计）
- **输入**：PM Agent 的 Story
- **输出**：技术方案（影响文件列表 + 接口变更 + 数据库变更 + 风险点）
- **工具**：`Read`, `Glob`, `Grep`（分析现有代码结构）
- **记忆**：读取架构决策记录（ADR），保持一致性

### 4. Dev Agent（实现，最关键）
- **输入**：Design Agent 的技术方案
- **输出**：实际代码变更（Edit/Write 文件）
- **工具**：全套 `Read/Write/Edit/Bash/Glob/Grep`
- **记忆**：读取项目编码规范（CLAUDE.md）、类似代码 pattern
- **特性**：可并行多个 Dev Agent（前端/后端/数据库分别跑）

### 5. Test Agent（测试验证）
- **输入**：Dev Agent 的变更 diff
- **输出**：测试结果 + 覆盖率报告
- **工具**：`Bash`（运行测试命令）, `Read`, `Write`（补测试用例）
- **流程**：如果测试失败 → 回馈 Dev Agent 修复 → 重测（最多3轮）

### 6. Deploy Agent（部署）
- **输入**：测试通过的代码
- **输出**：部署结果（CI/CD 触发 or git push）
- **工具**：`Bash`（git push, make deploy）
- **安全**：需要人工在飞书确认后才执行（`AskUserQuestion` hook）

---

## 工作流状态机

```
飞书消息
    │
    ▼
[INTAKE] → 分类 → 需求/Bug/查询
    │
    ▼
[PLANNING] PM Agent → Story.md
    │
    ▼
[DESIGN] Design Agent → tech-spec.md
    │
    ▼
[DEVELOPMENT] Dev Agent(s) 并行实现
    │           ↑ 失败回环（最多3次）
    ▼
[TESTING] Test Agent → pass/fail
    │
    ├──fail──→ [REVIEW] 人工飞书通知，等待决策
    │
    ▼ pass
[DEPLOY_CONFIRM] 飞书请求确认 ←── 人工节点
    │
    ▼ 确认
[DEPLOY] Deploy Agent → 触发 CI/CD
    │
    ▼
[DONE] 飞书汇报结果 + 写入记忆
```

---

## 技术实现方案

### 核心框架

```python
# orchestrator.py
from claude_agent_sdk import query, ClaudeAgentOptions, AgentDefinition

AGENTS = {
    "pm": AgentDefinition(
        description="产品需求分析，将用户需求转化为结构化Story",
        prompt=open(".claude/agents/pm.md").read(),
        tools=["Read", "Write", "Glob"],
    ),
    "design": AgentDefinition(
        description="技术架构设计，分析代码影响范围",
        prompt=open(".claude/agents/design.md").read(),
        tools=["Read", "Glob", "Grep", "Write"],
    ),
    "dev-backend": AgentDefinition(
        description="后端Go代码实现",
        prompt=open(".claude/agents/server.md").read(),
        tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    ),
    "dev-frontend": AgentDefinition(
        description="前端Next.js代码实现",
        prompt=open(".claude/agents/web.md").read(),
        tools=["Read", "Write", "Edit", "Bash", "Glob", "Grep"],
    ),
    "test": AgentDefinition(
        description="运行测试，验证变更",
        prompt=open(".claude/agents/test.md").read(),
        tools=["Read", "Write", "Bash", "Glob"],
    ),
}

async def run_pipeline(user_id: str, request: str):
    # 1. 注入相关记忆
    memory_ctx = memory.recall(request)

    # 2. Orchestrator 编排
    async for msg in query(
        prompt=f"<memory>{memory_ctx}</memory>\n用户请求：{request}",
        options=ClaudeAgentOptions(
            allowed_tools=["Read", "Task"],  # Task 工具调用子 agent
            agents=AGENTS,
            system_prompt=ORCHESTRATOR_SYSTEM_PROMPT,
        ),
    ):
        yield msg
```

### Agent 系统提示（关键设计）

每个 Agent 有独立的 `.claude/agents/*.md` 系统提示，定义：
- 该 agent 的角色和职责
- 输入/输出格式（结构化 Markdown）
- 禁止越权操作（如 PM Agent 不能修改代码）
- 与项目的对接约定（引用 CLAUDE.md 中的规范）

现有项目已有：`.claude/agents/server.md`, `web.md`, `admin.md`, `db.md` 可直接复用。

---

## 共享记忆层设计

```
memory/
├── facts.md              # 项目长期事实（技术栈、约定、重要配置）
├── decisions/            # 架构决策记录 (ADR)
│   └── 2026-03-03-auth.md
├── patterns/             # 常用代码 pattern
│   ├── api-handler.md
│   └── db-migration.md
├── bugs/                 # 已知Bug和解法
│   └── wallet-race-condition.md
├── daily/                # 每日任务日志
│   └── 2026-03-03.md
└── chroma/               # 向量嵌入（ChromaDB）
```

**所有 agent 共享同一个记忆层，但写入权限分级：**

| Agent | 可写目录 |
|-------|---------|
| Orchestrator | `daily/`, `decisions/` |
| Design Agent | `decisions/`, `patterns/` |
| Dev Agent | `patterns/`（只读其他） |
| Test Agent | `bugs/` |

---

## 人机协作节点

不是全自动，关键节点需要飞书确认：

| 阶段 | 自动/手动 | 飞书交互 |
|------|---------|---------|
| 需求理解 | 自动 | 显示 Story 供确认（可选） |
| 技术方案 | 自动 | 显示影响范围，等确认 |
| 代码实现 | 自动 | 展示 diff 摘要 |
| 测试通过 | 自动 | - |
| **测试失败3次** | **手动** | **飞书报警，等待决策** |
| **生产部署** | **手动** | **飞书确认，防止误操作** |

---

## 与现有项目对接（PitchOne-v2）

现有资产可直接复用：

| 资产 | 用途 |
|------|------|
| `.claude/agents/server.md` | Dev Agent 后端系统提示 |
| `.claude/agents/web.md` | Dev Agent 前端系统提示 |
| `CLAUDE.md` | 注入所有 agent 的记忆（项目规范） |
| `server/Makefile` | Test/Deploy Agent 的命令来源 |
| GitLab CI | Deploy Agent 的触发目标（`git push origin v2`） |

---

## 部署方案

```
lark-agent-system/
├── orchestrator.py       # 主程序，飞书长连接 + agent 编排
├── memory_manager.py     # 记忆读写
├── state_machine.py      # 工作流状态持久化
├── config.toml           # 飞书 credentials + 项目路径
├── .claude/agents/       # 各 agent 系统提示（复用现有）
└── requirements.txt      # lark-oapi-sdk, claude-agent-sdk, chromadb
```

守护进程：systemd 24/7，飞书 WebSocket 长连自动重连。

---

## 验证方式

1. 飞书发：`修复一个bug：用户搜索接口返回重复数据`
2. 观察 agent 链路日志：intake → pm → design → dev → test → 等待确认 → deploy
3. 检查生成文件：`story.md`, `tech-spec.md`, 代码变更 diff
4. 确认测试通过后，飞书回复「确认部署」
5. 检查 GitLab CI 被触发，服务正常部署

---

## 参考资源

- [Claude Agent SDK 子agent文档](https://platform.claude.com/docs/en/agent-sdk/overview)
- [cc-connect 飞书集成参考](https://github.com/chenhg5/cc-connect)
- [openclaw 记忆系统](https://docs.openclaw.ai/concepts/memory)
- [openclaw Feishu 集成](https://openclawlab.com/en/docs/channels/feishu/)
- 现有 agent 文档：`.claude/agents/*.md`（可直接复用）
