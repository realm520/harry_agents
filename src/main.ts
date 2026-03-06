/**
 * 主入口：启动飞书机器人 + Orchestrator
 */

import 'dotenv/config';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { loadConfig, validateConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { FeishuBot } from './feishu_bot.js';

function setupLogging(cfg: ReturnType<typeof loadConfig>): void {
  mkdirSync(dirname(cfg.logging.file), { recursive: true });
  // Node.js 用 console，生产环境可替换为 winston/pino
  console.log(`[main] 日志级别: ${cfg.logging.level}, 文件: ${cfg.logging.file}`);
}

function main(): void {
  const cfg = loadConfig('config.toml');
  validateConfig(cfg);
  setupLogging(cfg);

  const bot = new FeishuBot(cfg);

  const orchestrator = new Orchestrator(cfg, (chatId, text) => bot.sendText(chatId, text));
  bot.setOrchestrator(orchestrator);

  console.log('='.repeat(60));
  console.log('多 Agent 自动化开发系统启动（TypeScript 版）');
  console.log('='.repeat(60));

  bot.start();
}

main();
