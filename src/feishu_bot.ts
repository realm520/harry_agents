/**
 * 飞书机器人集成（HTTP 推送模式）
 * 用 @larksuiteoapi/node-sdk + express 替代 Python lark-oapi + aiohttp
 */

import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from './config.js';
import type { Orchestrator, NotifyPayload } from './orchestrator.js';

const RE_DEPLOY = /^\/deploy\s+(\S+)/i;
const RE_CANCEL = /^\/cancel\s+(\S+)\s*(.*)/i;
const RE_STATUS = /^\/status$/i;
const RE_AT     = /@\S+\s*/g;

export class FeishuBot {
  private cfg: AppConfig;
  private client: lark.Client;
  private orchestrator: Orchestrator | null = null;
  private port: number;

  constructor(cfg: AppConfig) {
    this.cfg = cfg;
    this.port = cfg.feishu.port;
    this.client = new lark.Client({
      appId: cfg.feishu.app_id,
      appSecret: cfg.feishu.app_secret,
      loggerLevel: lark.LoggerLevel.warn,
    });
  }

  setOrchestrator(orchestrator: Orchestrator): void {
    this.orchestrator = orchestrator;
  }

  // ── 启动 HTTP 服务器 ─────────────────────────────────────────────── //

  start(): void {
    const app = express();
    app.use(express.json());

    app.post('/', (req, res) => {
      void this.handleHttpEvent(req, res);
    });

    app.listen(this.port, () => {
      console.log(`[FeishuBot] HTTP 服务器启动，监听端口 ${this.port}`);
    });
  }

  // ── 事件处理 ─────────────────────────────────────────────────────── //

  private async handleHttpEvent(
    req: express.Request,
    res: express.Response,
  ): Promise<void> {
    try {
      const body = req.body as Record<string, unknown>;

      // URL 验证（握手阶段，跳过 token 校验）
      if (body['type'] === 'url_verification') {
        res.json({ challenge: body['challenge'] });
        return;
      }

      const header = body['header'] as Record<string, unknown> | undefined;

      // verification_token 校验（飞书在 header.token 中下发）
      if (this.cfg.feishu.verification_token) {
        const token = header?.['token'] as string | undefined;
        if (token !== this.cfg.feishu.verification_token) {
          console.warn('[FeishuBot] 非法请求：token 验证失败，已拒绝');
          res.status(403).json({});
          return;
        }
      }

      const eventType = header?.['event_type'] as string | undefined;

      // 消息事件
      if (eventType === 'im.message.receive_v1') {
        const event = body['event'] as Record<string, unknown>;
        this.handleMessageEvent(event).catch(e =>
          console.error(`[FeishuBot] 消息处理异常: ${e}`),
        );
        res.json({});
        return;
      }

      // 卡片按钮点击事件
      if (eventType === 'card.action.trigger') {
        const event = body['event'] as Record<string, unknown>;
        const actionValue = (event['action'] as Record<string, unknown> | undefined)
          ?.['value'] as { action?: string; task_id?: string } | undefined;
        const operator = event['operator'] as Record<string, unknown> | undefined;
        const userId = (operator?.['open_id'] as string | undefined) ?? '';

        if (actionValue?.action === 'deploy' && actionValue.task_id) {
          this.orchestrator?.confirmDeploy(actionValue.task_id, userId).catch(e =>
            console.error(`[FeishuBot] 卡片部署确认异常: ${e}`),
          );
          res.json({ toast: { type: 'success', content: '部署已确认，正在执行...' } });
        } else if (actionValue?.action === 'cancel' && actionValue.task_id) {
          this.orchestrator?.rejectTask(actionValue.task_id, '用户通过卡片取消').catch(e =>
            console.error(`[FeishuBot] 卡片取消异常: ${e}`),
          );
          res.json({ toast: { type: 'info', content: '任务已取消' } });
        } else {
          res.json({});
        }
        return;
      }

      res.json({});
    } catch (e) {
      console.error(`[FeishuBot] 事件处理异常: ${e}`);
      res.status(400).json({});
    }
  }

  private async handleMessageEvent(event: Record<string, unknown>): Promise<void> {
    try {
      const msg = event['message'] as Record<string, unknown>;
      if (msg['message_type'] !== 'text') return;

      const contentStr = msg['content'] as string ?? '{}';
      let contentDict: { text?: string } = {};
      try {
        contentDict = JSON.parse(contentStr) as { text?: string };
      } catch {
        console.warn(`[FeishuBot] 消息内容不是合法 JSON，已忽略: ${contentStr.slice(0, 100)}`);
        return;
      }
      const text = (contentDict.text ?? '').replace(RE_AT, '').trim();
      if (!text) return;

      const chatId    = msg['chat_id'] as string ?? '';
      const messageId = msg['message_id'] as string ?? '';
      const sender    = event['sender'] as Record<string, unknown> | undefined;
      const senderId  = (sender?.['sender_id'] as Record<string, string> | undefined)?.['open_id'] ?? '';

      console.log(`[FeishuBot] 收到消息: chat=${chatId}, text=${text.slice(0, 80)}`);
      await this.dispatch(chatId, messageId, senderId, text);
    } catch (e) {
      console.error(`[FeishuBot] 消息处理异常: ${e}`);
    }
  }

  private async dispatch(
    chatId: string,
    messageId: string,
    senderId: string,
    text: string,
  ): Promise<void> {
    if (!this.orchestrator) {
      console.error('[FeishuBot] Orchestrator 未初始化');
      return;
    }

    let m: RegExpMatchArray | null;

    m = text.match(RE_DEPLOY);
    if (m) {
      await this.orchestrator.confirmDeploy(m[1], senderId);
      return;
    }

    m = text.match(RE_CANCEL);
    if (m) {
      await this.orchestrator.rejectTask(m[1], m[2].trim());
      return;
    }

    if (RE_STATUS.test(text)) {
      const active = this.orchestrator.listActiveTasks();
      if (active.length === 0) {
        await this.sendText(chatId, '当前没有进行中的任务。');
      } else {
        const lines = ['**进行中的任务：**'];
        for (const t of active) {
          lines.push(`• \`${t.task_id}\` [${t.state}]\n  ${t.original_request.slice(0, 60)}`);
        }
        await this.sendText(chatId, lines.join('\n'));
      }
      return;
    }

    await this.orchestrator.handleFeishuMessage(chatId, messageId, senderId, text);
  }

  // ── NotifyCallback：Orchestrator 调用的统一通知入口 ─────────────── //

  async handleNotify(chatId: string, payload: NotifyPayload): Promise<void> {
    if (payload.kind === 'text') {
      await this.sendText(chatId, payload.text);
    } else {
      await this.sendDeployConfirmCard(chatId, payload.taskId, payload.summary);
    }
  }

  // ── 发送消息 ─────────────────────────────────────────────────────── //

  private async sendMessage(chatId: string, msgType: string, content: unknown): Promise<void> {
    await this.client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(content),
      },
    });
  }

  async sendText(chatId: string, text: string): Promise<void> {
    try {
      await this.sendMessage(chatId, 'text', { text });
    } catch (e) {
      console.error(`[FeishuBot] 发送消息异常: ${e}`);
    }
  }

  async sendDeployConfirmCard(chatId: string, taskId: string, summary: string): Promise<void> {
    const card = {
      schema: '2.0',
      body: {
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: `**任务 \`${taskId}\` 需要确认部署**\n\n${summary}`,
            },
          },
          {
            tag: 'action',
            actions: [
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '✅ 确认部署' },
                type: 'primary',
                value: { action: 'deploy', task_id: taskId },
              },
              {
                tag: 'button',
                text: { tag: 'plain_text', content: '❌ 取消' },
                type: 'danger',
                value: { action: 'cancel', task_id: taskId },
              },
            ],
          },
        ],
      },
    };

    try {
      await this.sendMessage(chatId, 'interactive', card);
    } catch (e) {
      console.error(`[FeishuBot] 发送卡片异常: ${e}`);
      // 降级为文本
      await this.sendText(
        chatId,
        `✅ [${taskId}] 测试通过！\n${summary}\n\n• 确认部署：\`/deploy ${taskId}\`\n• 取消：\`/cancel ${taskId}\``,
      );
    }
  }
}
