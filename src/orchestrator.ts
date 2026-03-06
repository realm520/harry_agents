/**
 * Orchestrator - 主控制器
 * 编排 PM → Design → Dev → Test → Deploy 流水线
 */

import { AgentMemoryClient } from './memory_client.js';
import { StateMachine, WorkflowState, TaskContext } from './state_machine.js';
import { AppConfig } from './config.js';
import { analyzePM } from './agents/pm_agent.js';
import { runDesign } from './agents/design_agent.js';
import { runDev, runDevFix } from './agents/dev_agent.js';
import { runTests, getFeedbackPath } from './agents/test_agent.js';
import { runDeploy } from './agents/deploy_agent.js';

type IntentType = 'feature' | 'bug' | 'query' | 'invalid';

const VALID_INTENTS = new Set<IntentType>(['feature', 'bug', 'query', 'invalid']);

const INTENT_SYSTEM_PROMPT = `你是意图分类器。将用户消息分类为以下类别之一：
- feature：新功能需求或开发任务
- bug：Bug修复、错误处理请求
- query：查询任务状态、进度、结果
- invalid：问候、测试、无意义内容、太短的消息`;

export type NotifyPayload =
  | { kind: 'text'; text: string }
  | { kind: 'deploy_card'; taskId: string; summary: string };

export type NotifyCallback = (chatId: string, payload: NotifyPayload) => Promise<void>;

export class Orchestrator {
  private cfg: AppConfig;
  private notify: NotifyCallback;
  private memory: AgentMemoryClient;
  private state: StateMachine;
  private cwd: string;
  private blackboxApiKey: string;

  constructor(cfg: AppConfig, notifyCallback?: NotifyCallback) {
    this.cfg = cfg;
    this.notify = notifyCallback ?? this.defaultNotify.bind(this);
    this.memory = new AgentMemoryClient();
    this.state = new StateMachine();
    this.cwd = cfg.project.workspace_path;
    this.blackboxApiKey = cfg.blackbox.api_key;
    if (!this.blackboxApiKey) console.warn('[Orchestrator] BLACKBOX_API_KEY 未配置，意图分类将失败');
  }

  // ── 便捷方法 ──────────────────────────────────────────────────────── //

  private text(chatId: string, msg: string): Promise<void> {
    return this.notify(chatId, { kind: 'text', text: msg });
  }

  // ── 对外接口 ──────────────────────────────────────────────────────── //

  async handleFeishuMessage(
    chatId: string,
    messageId: string,
    userId: string,
    text: string,
  ): Promise<void> {
    let intent: IntentType;
    try {
      intent = await this.classifyIntent(text);
    } catch (e) {
      console.error(`[Orchestrator] 意图分类失败: ${e}`);
      await this.text(chatId, `⚠️ 意图识别暂时不可用，请稍后重试。`);
      return;
    }
    console.log(`[Orchestrator] 意图分类: ${intent} | 内容: ${text.slice(0, 80)}`);

    if (intent === 'invalid') {
      await this.text(chatId, '👋 你好！请描述你的需求或 Bug，我会为你启动 AI 开发流水线。\n\n例如：\n• "实现用户登录功能"\n• "修复首页加载慢的问题"');
      return;
    }

    if (intent === 'query') {
      await this.text(chatId, this.answerQuery());
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
    await this.text(
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
      await this.text(ctx.feishu_chat_id, `❌ 任务 ${taskId} 当前状态不是等待部署确认`);
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
      await this.text(ctx.feishu_chat_id, `⛔ 任务 ${taskId} 已终止。${reason}`);
    }
  }

  listActiveTasks(): TaskContext[] {
    return this.state.listActiveTasks();
  }

  // ── 内部：流水线 ─────────────────────────────────────────────────── //

  private async runPipeline(ctx: TaskContext): Promise<void> {
    try {
      const memoryCtx = await this.memory.buildContext(ctx.original_request);

      // ── PLANNING ──────────────────────────────────────────────────
      ctx = this.state.transition(ctx, WorkflowState.PLANNING);
      await this.text(ctx.feishu_chat_id, `📋 [${ctx.task_id}] PM Agent 正在分析需求...`);
      void this.memory.setWorking('pm_agent', { taskId: ctx.task_id, status: 'running' });
      const storyPath = await analyzePM(ctx.original_request, memoryCtx, ctx.task_id, this.cwd, this.memory);
      ctx = this.state.transition(ctx, WorkflowState.DESIGN, { story_path: storyPath });

      // ── DESIGN ────────────────────────────────────────────────────
      await this.text(ctx.feishu_chat_id, `🏗️ [${ctx.task_id}] Design Agent 正在设计技术方案...`);
      void this.memory.setWorking('design_agent', { taskId: ctx.task_id, status: 'running', storyPath });
      const techSpecPath = await runDesign(storyPath, memoryCtx, ctx.task_id, this.cwd, this.memory);
      ctx = this.state.transition(ctx, WorkflowState.DEVELOPMENT, { tech_spec_path: techSpecPath });
      await this.text(
        ctx.feishu_chat_id,
        `📐 [${ctx.task_id}] 技术方案已生成：\`${techSpecPath}\`\n🚀 开始代码实现...`,
      );

      // ── DEVELOPMENT ───────────────────────────────────────────────
      void this.memory.setWorking('dev_agent', { taskId: ctx.task_id, status: 'running', techSpecPath });
      const [beReport, feReport] = await Promise.all([
        runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, true, this.memory),
        runDev(techSpecPath, memoryCtx, ctx.task_id, this.cwd, false, this.memory),
      ]);
      ctx = this.state.transition(ctx, WorkflowState.TESTING, { dev_report_path: beReport, frontend_report_path: feReport });
      await this.text(
        ctx.feishu_chat_id,
        `✍️ [${ctx.task_id}] 代码实现完成\n- 后端报告: \`${beReport}\`\n- 前端报告: \`${feReport}\``,
      );

      // ── TESTING（带重试）─────────────────────────────────────────
      await this.runTestingLoop(ctx, memoryCtx);
    } catch (e) {
      console.error(`[Orchestrator] 流水线异常: ${e}`);
      // 重新加载最新 ctx，避免使用流水线中途被覆盖的过期引用
      const latestCtx = this.state.loadTask(ctx.task_id) ?? ctx;
      this.state.failTask(latestCtx, String(e));
      await this.text(
        latestCtx.feishu_chat_id,
        `❌ [${latestCtx.task_id}] 流水线异常：${e}\n请查看日志排查问题。`,
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
        memory: this.memory,
      });
      ctx = this.state.transition(ctx, WorkflowState.TESTING, { test_report_path: reportPath });

      if (passed) {
        const summary = `需求「${ctx.original_request.slice(0, 80)}」已通过全部测试，等待确认部署到生产。`;
        await this.notify(ctx.feishu_chat_id, {
          kind: 'deploy_card',
          taskId: ctx.task_id,
          summary,
        });
        ctx = this.state.transition(ctx, WorkflowState.DEPLOY_CONFIRM);
        void this.memory.reflect(ctx.task_id);
        void this.memory.store(
          `任务 ${ctx.task_id} 测试通过，等待部署确认。需求：${ctx.original_request.slice(0, 100)}`,
          'episodic',
          { taskId: ctx.task_id },
        );
        return;
      }

      ctx = this.state.incrementTestRetry(ctx);

      if (!this.state.canRetryTest(ctx)) {
        ctx = this.state.transition(ctx, WorkflowState.REVIEW);
        await this.text(
          ctx.feishu_chat_id,
          `🚨 [${ctx.task_id}] 测试连续失败 ${ctx.max_test_retries} 次，需要人工介入！\n测试报告：\`${reportPath}\`\n• \`/cancel ${ctx.task_id} <原因>\` - 终止任务`,
        );
        return;
      }

      const feedbackPath = getFeedbackPath(ctx.task_id, this.cwd);
      await this.text(
        ctx.feishu_chat_id,
        `⚠️ [${ctx.task_id}] 第 ${retry + 1} 轮测试失败，Dev Agent 正在修复...`,
      );
      ctx = this.state.transition(ctx, WorkflowState.DEVELOPMENT);
      await Promise.all([
        runDevFix(feedbackPath, ctx.task_id, this.cwd, true, this.memory),
        runDevFix(feedbackPath, ctx.task_id, this.cwd, false, this.memory),
      ]);
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
        memory: this.memory,
      });
      if (success) {
        this.state.transition(ctx, WorkflowState.DONE, { deploy_report_path: reportPath });
        await this.text(
          ctx.feishu_chat_id,
          `🎉 [${ctx.task_id}] 部署成功！\n需求「${ctx.original_request.slice(0, 60)}...」已上线。`,
        );
        void this.memory.store(
          `任务 ${ctx.task_id} 部署成功。需求：${ctx.original_request.slice(0, 100)}`,
          'ci_cd',
          { taskId: ctx.task_id },
        );
      } else {
        this.state.failTask(ctx, '部署失败');
        await this.text(
          ctx.feishu_chat_id,
          `❌ [${ctx.task_id}] 部署失败！\n报告：\`${reportPath}\`\n请人工检查 CI/CD 状态。`,
        );
      }
    } catch (e) {
      this.state.failTask(ctx, String(e));
      await this.text(ctx.feishu_chat_id, `❌ [${ctx.task_id}] 部署异常：${e}`);
    }
  }

  // ── 意图分类 ─────────────────────────────────────────────────────── //

  private async classifyIntent(text: string): Promise<IntentType> {
    if (this.blackboxApiKey) {
      try {
        return await this.classifyByBlackbox(text);
      } catch (e) {
        console.warn(`[Orchestrator] Blackbox API 失败，降级为关键词匹配: ${e}`);
      }
    } else {
      console.warn('[Orchestrator] BLACKBOX_API_KEY 未配置，使用关键词匹配兜底');
    }
    return this.classifyByKeywords(text);
  }

  private async classifyByBlackbox(text: string): Promise<IntentType> {
    const { endpoint, model, timeout_ms } = this.cfg.blackbox;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout_ms);

    let res: Response;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.blackboxApiKey}`,
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: INTENT_SYSTEM_PROMPT },
            { role: 'user', content: text },
          ],
          tools: [{
            type: 'function',
            function: {
              name: 'set_intent',
              description: '设置意图分类结果',
              parameters: {
                type: 'object',
                properties: {
                  intent: { type: 'string', enum: ['feature', 'bug', 'query', 'invalid'] },
                },
                required: ['intent'],
              },
            },
          }],
          tool_choice: { type: 'function', function: { name: 'set_intent' } },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const err = await res.json() as { error?: { message?: string } };
        detail = err.error?.message ?? detail;
      } catch { /* ignore */ }
      throw new Error(`Blackbox API 错误: ${detail}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { tool_calls?: Array<{ function?: { arguments?: string } }> } }>;
    };
    const raw = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!raw) throw new Error('Blackbox API 返回结构异常：缺少 tool_calls.arguments');

    let args: { intent?: string };
    try {
      args = JSON.parse(raw) as { intent?: string };
    } catch {
      throw new Error(`Blackbox API 返回的 arguments 不是合法 JSON: ${raw}`);
    }

    if (!VALID_INTENTS.has(args.intent as IntentType)) {
      throw new Error(`Blackbox API 返回了非法意图值: ${args.intent}`);
    }
    return args.intent as IntentType;
  }

  /** 关键词兜底分类，无需外部依赖 */
  private classifyByKeywords(text: string): IntentType {
    const t = text.toLowerCase();
    if (t.length < 4) return 'invalid';
    if (/修复|bug|报错|错误|崩溃|异常|失败|不对|问题/.test(t)) return 'bug';
    if (/状态|进度|结果|查询|怎么样|完成了|多少|有没有/.test(t)) return 'query';
    if (/实现|开发|新增|添加|功能|需求|做|帮我|支持|接入/.test(t)) return 'feature';
    return 'invalid';
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

  private async defaultNotify(chatId: string, payload: NotifyPayload): Promise<void> {
    if (payload.kind === 'text') {
      console.log(`\n[飞书] chat=${chatId}: ${payload.text}\n`);
    } else {
      console.log(`\n[飞书] chat=${chatId}: [部署确认卡片] task=${payload.taskId} ${payload.summary}\n`);
    }
  }
}
