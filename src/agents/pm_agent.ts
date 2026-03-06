/**
 * PM Agent：将原始需求转化为结构化 Story
 */

import { runAgent, loadSystemPrompt, getOutputPath, ensureOutputDir, storeAgentOutput } from './base_agent.js';
import type { AgentMemoryClient } from '../memory_client.js';

const SYSTEM_PROMPT_FILE = '.claude/agents/pm.md';
const ALLOWED_TOOLS = ['Read', 'Glob', 'Write'];

export async function analyzePM(
  request: string,
  memoryContext: string,
  taskId: string,
  cwd: string,
  memory?: AgentMemoryClient,
): Promise<string> {
  const systemPrompt = loadSystemPrompt(SYSTEM_PROMPT_FILE, 'pm');
  const outputPath = ensureOutputDir(getOutputPath('story.md', taskId));

  const prompt = `
## 你的任务

分析以下用户需求，生成结构化的 Story 文档，并保存到 \`${outputPath}\`。

## 用户需求

${request}

## 相关历史记忆

${memoryContext || '（暂无相关记忆）'}

## 执行步骤

1. 先读取 \`memory/facts.md\` 了解项目结构
2. 列出 \`memory/decisions/\` 目录，查阅相关决策
3. 分析需求，编写结构化 Story
4. 将 story.md 写入 \`${outputPath}\`

请按照系统提示中的格式输出 story.md。
`;

  await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
  await storeAgentOutput(outputPath, memory, 'prd', { taskId });
  return outputPath;
}
