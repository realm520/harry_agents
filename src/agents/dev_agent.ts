/**
 * Dev Agent：根据技术方案实现代码（前端/后端）
 */

import { runAgent, loadSystemPrompt, getOutputPath, ensureOutputDir } from './base_agent.js';

const ALLOWED_TOOLS = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash'];

function getSystemPromptFile(backend: boolean): string {
  return backend ? '.claude/agents/dev_backend.md' : '.claude/agents/dev_frontend.md';
}

export async function runDev(
  techSpecPath: string,
  memoryContext: string,
  taskId: string,
  cwd: string,
  backend: boolean,
): Promise<string> {
  const mode = backend ? 'backend' : 'frontend';
  const systemPrompt = loadSystemPrompt(getSystemPromptFile(backend), `dev_${mode}`);
  const outputPath = ensureOutputDir(getOutputPath(`dev-report-${mode}.md`, taskId));

  const prompt = `
## 你的任务

根据技术方案实现${backend ? '后端 Go' : '前端 Next.js'}代码变更。

## 技术方案路径

\`${techSpecPath}\`

## 相关记忆（代码模式参考）

${memoryContext || '（暂无相关记忆）'}

## 执行步骤

1. 读取 \`${techSpecPath}\` 获取技术方案详情
2. 读取"影响文件列表"中的每个文件，了解现有代码
3. 读取 \`memory/patterns/\` 中相关的代码模式
4. 按方案实现代码变更（Edit/Write 文件）
5. 运行编译命令确认无误
6. 将开发报告写入 \`${outputPath}\`

**重要约束**：
- 只修改技术方案中列出的文件
- 不重构无关代码
- 遇到不确定的地方在报告中注明
`;

  await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
  return outputPath;
}

export async function runDevFix(
  feedbackPath: string,
  taskId: string,
  cwd: string,
  backend: boolean,
): Promise<void> {
  const systemPrompt = loadSystemPrompt(getSystemPromptFile(backend), `dev_${backend ? 'backend' : 'frontend'}`);

  const prompt = `
测试失败，请根据以下反馈修复代码：

反馈文件：\`${feedbackPath}\`

读取反馈文件，找到并修复对应的代码问题。修复完成后更新开发报告。
`;

  await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
}
