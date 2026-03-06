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

> **当前实现**：TypeScript（Node.js）+ `@anthropic-ai/claude-agent-sdk`

### 核心框架

```typescript
// src/agents/base_agent.ts
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';

export async function runAgent(opts: RunAgentOptions): Promise<string> {
  let result = '';
  for await (const message of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
      permissionMode: 'acceptEdits',  // 自动接受文件编辑
    },
  })) {
    const msg = message as SDKMessage;
    if (msg.type === 'result') {
      result = (msg as { type: 'result'; result: string }).result;
    }
  }
  return result;
}
```

```typescript
// src/orchestrator.ts（核心流水线）
async runPipeline(ctx: TaskContext): Promise<void> {
  const memoryCtx = this.memory.recall(ctx.original_request);

  // PM → Design → Dev（前后端并行）→ Test（带重试）→ Deploy 确认
  const storyPath = await analyzePM(ctx.original_request, memoryCtx, ctx.task_id, this.cwd);
  const techSpecPath = await runDesign(storyPath, memoryCtx, ctx.task_id, this.cwd);

  // 前后端并行开发
  const [beReport, feReport] = await Promise.all([
    runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, true),   // 后端
    runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, false),  // 前端
  ]);

  await this.runTestingLoop(ctx, memoryCtx);  // 最多重试 3 次
}
```

### 意图分类（Blackbox API）

意图分类使用 Blackbox API（deepseek-chat-v3），不走 Claude：
- `feature` → 启动完整开发流水线
- `bug` → 启动 Bug 修复流水线
- `query` → 返回当前活跃任务列表
- `invalid` → 引导用户正确使用

需配置 `BLACKBOX_API_KEY` 环境变量或 `config.toml` 的 `[blackbox]` 段。

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
└── daily/                # 每日任务日志
    └── 2026-03-03.md
```

> 注：当前实现使用关键词匹配召回记忆（`memory_manager.ts`），不依赖 ChromaDB。

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
multi-agent-system/
├── src/
│   ├── main.ts              # 主入口
│   ├── orchestrator.ts      # 流水线编排 + 意图分类（Blackbox API）
│   ├── feishu_bot.ts        # 飞书 HTTP 推送集成（express）
│   ├── config.ts            # 配置加载
│   ├── state_machine.ts     # 工作流状态持久化（JSON）
│   ├── memory_manager.ts    # 共享记忆层（关键词匹配）
│   └── agents/
│       ├── base_agent.ts    # runAgent() 封装
│       ├── pm_agent.ts
│       ├── design_agent.ts
│       ├── dev_agent.ts     # 前后端并行
│       ├── test_agent.ts
│       └── deploy_agent.ts
├── config.toml              # 飞书 credentials + 项目路径
├── package.json             # @anthropic-ai/claude-agent-sdk, @larksuiteoapi/node-sdk
├── .claude/agents/          # 各 agent 系统提示（*.md）
├── memory/                  # 共享记忆文件（facts.md, decisions/, patterns/, bugs/）
└── states/                  # 任务状态 JSON 文件
```

启动：`npm start`（`tsx src/main.ts`）
认证：`claude login` OAuth，无需 `ANTHROPIC_API_KEY`
意图分类：需设置 `BLACKBOX_API_KEY` 环境变量

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
