/**
 * 飞书机器人集成（HTTP 推送模式）
 * 用 @larksuiteoapi/node-sdk + express 替代 Python lark-oapi + aiohttp
 */

import express from 'express';
import * as lark from '@larksuiteoapi/node-sdk';
import { AppConfig } from './config.js';
import type { Orchestrator } from './orchestrator.js';

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

      // URL 验证
      if (body['type'] === 'url_verification') {
        res.json({ challenge: body['challenge'] });
        return;
      }

      // 消息事件
      const header = body['header'] as Record<string, unknown> | undefined;
      if (header?.['event_type'] === 'im.message.receive_v1') {
        const event = body['event'] as Record<string, unknown>;
        this.handleMessageEvent(event).catch(e =>
          console.error(`[FeishuBot] 消息处理异常: ${e}`),
        );
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
      const contentDict = JSON.parse(contentStr) as { text?: string };
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
    }
  }
}
