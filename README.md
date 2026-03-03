# 多 Agent 协作自动化软件开发系统

通过飞书接收需求/Bug，由多个 AI Agent 协作完成从「需求理解 → 设计 → 开发 → 测试 → 部署」的完整软件开发链路。

## 架构图

```
用户(飞书)
    │
    ▼
Orchestrator（主控）
    ├─── PM Agent       → story.md
    ├─── Design Agent   → tech-spec.md
    ├─── Dev Agent(s)   → 代码变更（前后端并行）
    ├─── Test Agent     → test-report.md（最多3次重试）
    └─── Deploy Agent   → 人工确认后部署
         │
         ▼
    共享记忆层（memory/）
    ├── facts.md        项目长期事实
    ├── decisions/      架构决策记录
    ├── patterns/       代码模式库
    ├── bugs/           已知Bug库
    └── daily/          每日任务日志
```

## 快速开始

### 1. 安装依赖

```bash
pip install -r requirements.txt
```

### 2. 配置

编辑 `config.toml`，填写以下信息：
- `[feishu]` - 飞书机器人 App ID 和 Secret
- `[project]` - 目标代码仓库路径和命令
- `[claude]` - Claude 模型配置

同时设置环境变量：
```bash
export ANTHROPIC_API_KEY="your-api-key"
```

### 3. 初始化记忆库

编辑 `memory/facts.md`，填写项目的技术栈、模块结构等基本信息。

### 4. 启动

```bash
python main.py
```

## 飞书使用方式

在飞书群中 @机器人 发送：

| 命令 | 作用 |
|------|------|
| `修复用户搜索接口返回重复数据的bug` | 启动 Bug 修复流水线 |
| `新增用户头像上传功能` | 启动新需求流水线 |
| `/status` | 查询进行中的任务 |
| `/deploy <task_id>` | 确认部署 |
| `/cancel <task_id> <原因>` | 取消任务 |

## 工作流程

```
飞书消息
    │
    ▼
[INTAKE] → 意图分类（需求/Bug/查询）
    │
    ▼
[PLANNING] PM Agent → story.md
    │
    ▼
[DESIGN] Design Agent → tech-spec.md
    │
    ▼
[DEVELOPMENT] Dev Agent 前后端并行实现
    │
    ▼
[TESTING] Test Agent → 最多重试3次
    │
    ├──fail×3──→ 飞书报警，等待人工
    │
    ▼ pass
[DEPLOY_CONFIRM] 飞书发送确认卡片 ← 人工节点
    │ 确认
    ▼
[DEPLOYING] Deploy Agent → CI/CD
    │
    ▼
[DONE] 飞书汇报 + 写入记忆
```

## 项目结构

```
multi-agent-system/
├── main.py              # 主入口
├── orchestrator.py      # 主编排器
├── feishu_bot.py        # 飞书集成
├── memory_manager.py    # 共享记忆层
├── state_machine.py     # 工作流状态机
├── agents/
│   ├── base_agent.py    # Agent基类（工具调用封装）
│   ├── pm_agent.py
│   ├── design_agent.py
│   ├── dev_agent.py
│   ├── test_agent.py
│   └── deploy_agent.py
├── .claude/agents/      # Agent系统提示
│   ├── pm.md
│   ├── design.md
│   ├── dev_backend.md
│   ├── dev_frontend.md
│   ├── test.md
│   └── deploy.md
├── memory/              # 共享记忆目录
├── states/              # 任务状态（JSON持久化）
├── work/                # Agent工作文件（story/spec/reports）
├── logs/                # 日志
├── config.toml          # 配置
└── requirements.txt
```

## 验证

```bash
# 1. 飞书发送：修复一个bug：用户搜索接口返回重复数据
# 2. 观察日志：intake → pm → design → dev → test → 等待确认 → deploy
# 3. 检查生成文件：work/<task_id>/story.md, tech-spec.md, dev-report*.md
# 4. 确认测试通过后，飞书回复：/deploy <task_id>
# 5. 检查 CI/CD 被触发
```

## 扩展

- **增加新 Agent**：继承 `BaseAgent`，设置 `ALLOWED_TOOLS` 和 `SYSTEM_PROMPT_FILE`
- **增加记忆类型**：在 `MemoryManager` 中添加新的目录和读写方法
- **替换 LLM**：修改 `BaseAgent._model` 配置
- **并行 Dev Agent**：`DevAgent` 已支持前后端并行，可继续拆分为更细粒度
