/**
 * Agent 基类
 * 用 @anthropic-ai/claude-agent-sdk 的 query() 封装工具调用循环，
 * 大幅简化原 Python base_agent.py 的 ~250 行实现。
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, parse as parsePath } from 'path';

export interface RunAgentOptions {
  prompt: string;
  systemPrompt: string;
  allowedTools: string[];
  cwd?: string;
}

/**
 * 核心函数：调用 Claude Agent SDK 的 query()，自动处理工具调用循环。
 * 返回最终文本结果。
 */
export async function runAgent(opts: RunAgentOptions): Promise<string> {
  let result = '';
  for await (const message of query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      allowedTools: opts.allowedTools,
      systemPrompt: opts.systemPrompt,
      permissionMode: 'acceptEdits',
    },
  })) {
    const msg = message as SDKMessage;
    if (msg.type === 'result') {
      result = (msg as { type: 'result'; result: string }).result;
    }
  }
  return result;
}

/**
 * 从 .claude/agents/*.md 读取系统提示文件
 */
export function loadSystemPrompt(promptFile: string, agentName: string): string {
  if (!promptFile) return `你是 ${agentName} agent。`;
  try {
    return readFileSync(promptFile, 'utf-8');
  } catch {
    return `你是 ${agentName} agent。`;
  }
}

/**
 * 生成标准输出路径
 */
export function getOutputPath(filename: string, taskId: string): string {
  if (taskId) return `./work/${taskId}/${filename}`;
  const today = new Date().toISOString().slice(0, 10);
  const { name, ext } = parsePath(filename);
  return `./work/${name}-${today}${ext}`;
}

/**
 * 确保文件所在目录存在，返回原路径
 */
export function ensureOutputDir(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

/**
 * 从输出文件或 fallback 文本中查找成功标记
 */
export function parseResultMarker(outputPath: string, marker: string, fallbackText: string): boolean {
  try {
    const content = readFileSync(outputPath, 'utf-8');
    return content.includes(marker);
  } catch {
    return fallbackText.includes(marker);
  }
}
