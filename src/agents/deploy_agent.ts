/**
 * Deploy Agent：在获得人工确认后执行部署
 */

import { runAgent, loadSystemPrompt, getOutputPath, ensureOutputDir, parseResultMarker } from './base_agent.js';

const SYSTEM_PROMPT_FILE = '.claude/agents/deploy.md';
const ALLOWED_TOOLS = ['Read', 'Write', 'Bash'];

export async function runDeploy(opts: {
  testReportPath: string;
  deployCommand: string;
  taskId: string;
  cwd: string;
  confirmed: boolean;
}): Promise<{ success: boolean; reportPath: string }> {
  const { testReportPath, deployCommand, taskId, cwd, confirmed } = opts;

  if (!confirmed) {
    throw new Error('[DeployAgent] 部署未经人工确认，拒绝执行');
  }

  const systemPrompt = loadSystemPrompt(SYSTEM_PROMPT_FILE, 'deploy');
  const outputPath = ensureOutputDir(getOutputPath('deploy-report.md', taskId));

  const prompt = `
## 你的任务

执行生产部署。**已获得人工确认**（confirmed=True）。

## 输入

- 测试报告：\`${testReportPath}\`
- 部署命令：\`${deployCommand}\`

## 执行步骤

1. 读取 \`${testReportPath}\` 确认测试全部通过
2. 执行 \`git status\` 检查工作区状态
3. 执行部署命令：\`${deployCommand}\`
4. 将部署报告写入 \`${outputPath}\`

部署完成后在报告末尾用 \`DEPLOY: SUCCESS\` 或 \`DEPLOY: FAILED\` 标记结论。
`;

  const result = await runAgent({ prompt, systemPrompt, allowedTools: ALLOWED_TOOLS, cwd });
  const success = parseResultMarker(outputPath, 'DEPLOY: SUCCESS', result);
  return { success, reportPath: outputPath };
}
