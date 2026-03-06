/**
 * Test Agent：运行测试，验证代码变更
 */

import { runAgent, loadSystemPrompt, getOutputPath, ensureOutputDir, readOutputFile, parseResultMarker, storeAgentOutput } from './base_agent.js';
import type { AgentMemoryClient } from '../memory_client.js';

const SYSTEM_PROMPT_FILE = '.claude/agents/test.md';
const ALLOWED_TOOLS = ['Read', 'Write', 'Bash', 'Glob'];

export async function runTests(opts: {
  storyPath: string;
  devReportPath: string;
  testCommand: string;
  memoryContext: string;
  taskId: string;
  cwd: string;
  retryCount?: number;
  memory?: AgentMemoryClient;
}): Promise<{ passed: boolean; reportPath: string }> {
  const { storyPath, devReportPath, testCommand, memoryContext, taskId, cwd, retryCount = 0, memory } = opts;
  const systemPrompt = loadSystemPrompt(SYSTEM_PROMPT_FILE, 'test');
  const outputPath = ensureOutputDir(getOutputPath('test-report.md', taskId, cwd));
  const feedbackPath = getOutputPath('test-feedback.md', taskId, cwd);

  const prompt = `
## 你的任务

验证代码变更是否通过测试，并检查是否满足验收标准。

## 输入文件

- Story（验收标准）：\`${storyPath}\`
- 开发报告（变更范围）：\`${devReportPath}\`
- 当前重试次数：${retryCount}

## 测试命令

\`\`\`
${testCommand}
\`\`\`

## 执行步骤

1. 读取 \`${storyPath}\` 了解验收标准
2. 读取 \`${devReportPath}\` 了解变更范围
3. 执行测试命令（使用 Bash 工具）
4. 分析测试结果
5. 如测试失败，检查 \`memory/bugs/\` 中是否有已知 Bug
6. 将测试报告写入 \`${outputPath}\`
7. 如有失败，额外生成 Dev Agent 反馈文件 \`${feedbackPath}\`

请在报告末尾用 \`RESULT: PASS\` 或 \`RESULT: FAIL\` 标记最终结论。
`;

  await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
  const content = readOutputFile(outputPath);
  const passed = parseResultMarker(content, 'RESULT: PASS');
  await storeAgentOutput(
    content, memory,
    passed ? 'ci_cd' : 'bug',
    { taskId, importance: passed ? undefined : 0.8 },
    1000,
  );
  return { passed, reportPath: outputPath };
}

export function getFeedbackPath(taskId: string, cwd: string): string {
  return getOutputPath('test-feedback.md', taskId, cwd);
}
