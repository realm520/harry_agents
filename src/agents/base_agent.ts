/**
 * Agent 基类
 * 用 @anthropic-ai/claude-agent-sdk 的 query() 封装工具调用循环，
 * 大幅简化原 Python base_agent.py 的 ~250 行实现。
 */

import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, parse as parsePath, resolve } from 'path';
import type { AgentMemoryClient, MemoryType } from '../memory_client.js';

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

function datestampedRelPath(filename: string): string {
  const today = new Date().toISOString().slice(0, 10);
  const { name, ext } = parsePath(filename);
  return `work/${name}-${today}${ext}`;
}

/**
 * 生成标准输出路径（绝对路径）。
 * cwd 应传入 workspace_path，确保 node 进程与 Agent 子进程读写同一位置。
 */
export function getOutputPath(filename: string, taskId: string, cwd: string): string {
  const rel = taskId ? `work/${taskId}/${filename}` : datestampedRelPath(filename);
  return resolve(cwd, rel);
}

/**
 * 确保文件所在目录存在，返回原路径
 */
export function ensureOutputDir(filePath: string): string {
  mkdirSync(dirname(filePath), { recursive: true });
  return filePath;
}

/**
 * 尝试读取 Agent 输出文件，失败时返回 fallback 文本。
 */
export function readOutputFile(outputPath: string, fallback = ''): string {
  try {
    return readFileSync(outputPath, 'utf-8');
  } catch {
    return fallback;
  }
}

/**
 * 在 content 中查找成功标记。
 */
export function parseResultMarker(content: string, marker: string): boolean {
  return content.includes(marker);
}

/**
 * 将 content 存入 Memory API（失败时静默忽略）。
 * content 由调用方通过 readOutputFile() 获取，避免重复读文件。
 */
export async function storeAgentOutput(
  content: string,
  memory: AgentMemoryClient | undefined,
  memoryType: MemoryType,
  opts?: { taskId?: string; module?: string; importance?: number },
  maxChars = 2000,
): Promise<void> {
  if (!memory || !content) return;
  try {
    await memory.store(content.slice(0, maxChars), memoryType, opts);
  } catch (e) {
    console.warn(`[Agent] 存储 ${memoryType} 记忆失败: ${e}`);
  }
}
