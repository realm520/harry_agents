/**
 * Design Agent：根据 Story 生成技术方案
 */

import { runAgent, loadSystemPrompt, getOutputPath, ensureOutputDir, storeAgentOutput } from './base_agent.js';
import type { AgentMemoryClient } from '../memory_client.js';

const SYSTEM_PROMPT_FILE = '.claude/agents/design.md';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Grep', 'Write'];

export async function runDesign(
  storyPath: string,
  memoryContext: string,
  taskId: string,
  cwd: string,
  memory?: AgentMemoryClient,
): Promise<string> {
  const systemPrompt = loadSystemPrompt(SYSTEM_PROMPT_FILE, 'design');
  const outputPath = ensureOutputDir(getOutputPath('tech-spec.md', taskId));

  const prompt = `
## 你的任务

根据以下 Story，为项目生成详细的技术方案，保存到 \`${outputPath}\`。

## Story 文件路径

\`${storyPath}\`

## 相关记忆

${memoryContext || '（暂无相关记忆）'}

## 执行步骤

1. 读取 \`${storyPath}\` 获取需求详情
2. 读取 \`memory/facts.md\` 了解技术栈
3. 读取 \`memory/patterns/\` 目录，查看可复用的代码模式
4. 使用 Glob/Grep 分析项目代码结构（在项目 workspace 中）
5. 编写技术方案
6. 将 tech-spec.md 写入 \`${outputPath}\`

请按照系统提示中的格式输出技术方案，特别注意：
- 精确列出每个需要修改的文件
- 明确接口变更和数据库变更
- 识别风险点
`;

  await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
  await storeAgentOutput(outputPath, memory, 'arch', { taskId });
  return outputPath;
}
