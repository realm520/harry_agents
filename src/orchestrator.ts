/**
 * Orchestrator - 主控制器
 * 编排 PM → Design → Dev → Test → Deploy 流水线
 */

import { MemoryManager } from './memory_manager.js';
import { StateMachine, WorkflowState, TaskContext } from './state_machine.js';
import { AppConfig } from './config.js';
import { analyzePM } from './agents/pm_agent.js';
import { runDesign } from './agents/design_agent.js';
import { runDev, runDevFix } from './agents/dev_agent.js';
import { runTests, getFeedbackPath } from './agents/test_agent.js';
import { runDeploy } from './agents/deploy_agent.js';

const QUERY_RE = /查询|进度|状态|怎么|什么|如何|帮我查|查一下/;
const BUG_RE   = /bug|错误|报错|问题|修复|fix|崩溃|异常|失败/i;

export type NotifyCallback = (chatId: string, text: string) => Promise<void>;

export class Orchestrator {
  private cfg: AppConfig;
  private notify: NotifyCallback;
  private memory: MemoryManager;
  private state: StateMachine;
  private cwd: string;

  constructor(cfg: AppConfig, notifyCallback?: NotifyCallback) {
    this.cfg = cfg;
    this.notify = notifyCallback ?? this.defaultNotify.bind(this);
    this.memory = new MemoryManager(cfg.memory.base_path, cfg.memory.recall_top_k);
    this.state = new StateMachine();
    this.cwd = cfg.project.workspace_path;
  }

  // ── 对外接口 ──────────────────────────────────────────────────────── //

  async handleFeishuMessage(
    chatId: string,
    messageId: string,
    userId: string,
    text: string,
  ): Promise<void> {
    const intent = this.classifyIntent(text);
    console.log(`[Orchestrator] 意图分类: ${intent} | 内容: ${text.slice(0, 80)}`);

    if (intent === 'query') {
      await this.notify(chatId, this.answerQuery());
      return;
    }

    const ctx = this.state.createTask({
      original_request: text,
      feishu_chat_id: chatId,
      feishu_message_id: messageId,
      requester_user_id: userId,
      max_test_retries: this.cfg.project.max_test_retries,
    });
    ctx.metadata['intent'] = intent;

    const label = intent === 'feature' ? '需求' : 'Bug修复';
    await this.notify(
      chatId,
      `✅ 已收到${label}请求，任务 ID：\`${ctx.task_id}\`\n正在启动 AI 流水线，请稍候...`,
    );

    // 异步启动，不 await，避免阻塞飞书响应
    this.runPipeline(ctx).catch(e =>
      console.error(`[Orchestrator] 流水线异常: ${e}`),
    );
  }

  async confirmDeploy(taskId: string, userId: string): Promise<void> {
    const ctx = this.state.loadTask(taskId);
    if (!ctx) return;
    if (ctx.state !== WorkflowState.DEPLOY_CONFIRM) {
      await this.notify(ctx.feishu_chat_id, `❌ 任务 ${taskId} 当前状态不是等待部署确认`);
      return;
    }
    const updated = this.state.transition(ctx, WorkflowState.DEPLOYING);
    updated.metadata['confirmed_by'] = userId;
    this.runDeploy(updated).catch(e =>
      console.error(`[Orchestrator] 部署异常: ${e}`),
    );
  }

  async rejectTask(taskId: string, reason = ''): Promise<void> {
    const ctx = this.state.loadTask(taskId);
    if (ctx) {
      this.state.failTask(ctx, `人工终止: ${reason}`);
      await this.notify(ctx.feishu_chat_id, `⛔ 任务 ${taskId} 已终止。${reason}`);
    }
  }

  listActiveTasks(): TaskContext[] {
    return this.state.listActiveTasks();
  }

  // ── 内部：流水线 ─────────────────────────────────────────────────── //

  private async runPipeline(ctx: TaskContext): Promise<void> {
    try {
      const memoryCtx = this.memory.recall(ctx.original_request);

      // ── PLANNING ──────────────────────────────────────────────────
      ctx = this.state.transition(ctx, WorkflowState.PLANNING);
      await this.notify(ctx.feishu_chat_id, `📋 [${ctx.task_id}] PM Agent 正在分析需求...`);
      const storyPath = await analyzePM(ctx.original_request, memoryCtx, ctx.task_id, this.cwd);
      ctx = this.state.transition(ctx, WorkflowState.DESIGN, { story_path: storyPath });

      // ── DESIGN ────────────────────────────────────────────────────
      await this.notify(ctx.feishu_chat_id, `🏗️ [${ctx.task_id}] Design Agent 正在设计技术方案...`);
      const techSpecPath = await runDesign(storyPath, memoryCtx, ctx.task_id, this.cwd);
      ctx = this.state.transition(ctx, WorkflowState.DEVELOPMENT, { tech_spec_path: techSpecPath });
      await this.notify(
        ctx.feishu_chat_id,
        `📐 [${ctx.task_id}] 技术方案已生成：\`${techSpecPath}\`\n🚀 开始代码实现...`,
      );

      // ── DEVELOPMENT ───────────────────────────────────────────────
      const [beReport, feReport] = await Promise.all([
        runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, true),
        runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, false),
      ]);
      ctx = this.state.transition(ctx, WorkflowState.TESTING, { dev_report_path: beReport });
      await this.notify(
        ctx.feishu_chat_id,
        `✍️ [${ctx.task_id}] 代码实现完成\n- 后端报告: \`${beReport}\`\n- 前端报告: \`${feReport}\``,
      );

      // ── TESTING（带重试）─────────────────────────────────────────
      await this.runTestingLoop(ctx, memoryCtx);
    } catch (e) {
      console.error(`[Orchestrator] 流水线异常: ${e}`);
      this.state.failTask(ctx, String(e));
      await this.notify(
        ctx.feishu_chat_id,
        `❌ [${ctx.task_id}] 流水线异常：${e}\n请查看日志排查问题。`,
      );
    }
  }

  private async runTestingLoop(ctx: TaskContext, memoryCtx: string): Promise<void> {
    const testCommand = this.cfg.project.test_command;

    while (true) {
      const retry = ctx.test_retry_count;

      const { passed, reportPath } = await runTests({
        storyPath: ctx.story_path ?? '',
        devReportPath: ctx.dev_report_path ?? '',
        testCommand,
        memoryContext: memoryCtx,
        taskId: ctx.task_id,
        cwd: this.cwd,
        retryCount: retry,
      });
      ctx = this.state.transition(ctx, WorkflowState.TESTING, { test_report_path: reportPath });

      if (passed) {
        await this.notify(
          ctx.feishu_chat_id,
          `✅ [${ctx.task_id}] 测试全部通过！\n\n是否部署到生产？请回复：\n• **确认部署** \`/deploy ${ctx.task_id}\`\n• **取消** \`/cancel ${ctx.task_id}\``,
        );
        ctx = this.state.transition(ctx, WorkflowState.DEPLOY_CONFIRM);
        this.memory.writeDailyLog(
          'orchestrator',
          `任务 ${ctx.task_id} 测试通过，等待部署确认。需求：${ctx.original_request.slice(0, 100)}`,
        );
        return;
      }

      ctx = this.state.incrementTestRetry(ctx);

      if (!this.state.canRetryTest(ctx)) {
        ctx = this.state.transition(ctx, WorkflowState.REVIEW);
        await this.notify(
          ctx.feishu_chat_id,
          `🚨 [${ctx.task_id}] 测试连续失败 ${ctx.max_test_retries} 次，需要人工介入！\n测试报告：\`${reportPath}\`\n• \`/reject ${ctx.task_id} <原因>\` - 终止任务`,
        );
        return;
      }

      const feedbackPath = getFeedbackPath(ctx.task_id);
      await this.notify(
        ctx.feishu_chat_id,
        `⚠️ [${ctx.task_id}] 第 ${retry + 1} 轮测试失败，Dev Agent 正在修复...`,
      );
      ctx = this.state.transition(ctx, WorkflowState.DEVELOPMENT);
      await runDevFix(feedbackPath, ctx.task_id, this.cwd, true);
      ctx = this.state.transition(ctx, WorkflowState.TESTING);
    }
  }

  private async runDeploy(ctx: TaskContext): Promise<void> {
    const deployCommand = this.cfg.project.deploy_command;
    try {
      const { success, reportPath } = await runDeploy({
        testReportPath: ctx.test_report_path ?? '',
        deployCommand,
        taskId: ctx.task_id,
        cwd: this.cwd,
        confirmed: true,
      });
      if (success) {
        this.state.transition(ctx, WorkflowState.DONE, { deploy_report_path: reportPath });
        await this.notify(
          ctx.feishu_chat_id,
          `🎉 [${ctx.task_id}] 部署成功！\n需求「${ctx.original_request.slice(0, 60)}...」已上线。`,
        );
        this.memory.writeDailyLog(
          'orchestrator',
          `任务 ${ctx.task_id} 部署成功。需求：${ctx.original_request.slice(0, 100)}`,
        );
      } else {
        this.state.failTask(ctx, '部署失败');
        await this.notify(
          ctx.feishu_chat_id,
          `❌ [${ctx.task_id}] 部署失败！\n报告：\`${reportPath}\`\n请人工检查 CI/CD 状态。`,
        );
      }
    } catch (e) {
      this.state.failTask(ctx, String(e));
      await this.notify(ctx.feishu_chat_id, `❌ [${ctx.task_id}] 部署异常：${e}`);
    }
  }

  // ── 意图分类 ─────────────────────────────────────────────────────── //

  private classifyIntent(text: string): string {
    if (QUERY_RE.test(text)) return 'query';
    if (BUG_RE.test(text)) return 'bug';
    return 'feature';
  }

  private answerQuery(): string {
    const activeTasks = this.state.listActiveTasks();
    if (activeTasks.length === 0) return '当前没有进行中的任务。';
    const lines = ['当前进行中的任务：'];
    for (const t of activeTasks) {
      lines.push(`• \`${t.task_id}\` [${t.state}] ${t.original_request.slice(0, 50)}...`);
    }
    return lines.join('\n');
  }

  private async defaultNotify(chatId: string, text: string): Promise<void> {
    console.log(`\n[飞书] chat=${chatId}: ${text}\n`);
  }
}
