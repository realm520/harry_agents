/**
 * 主入口：启动飞书机器人 + Orchestrator
 */

import 'dotenv/config';
import { mkdirSync, createWriteStream } from 'fs';
import { dirname } from 'path';
import { loadConfig, validateConfig } from './config.js';
import { Orchestrator } from './orchestrator.js';
import { FeishuBot } from './feishu_bot.js';

function setupLogging(cfg: ReturnType<typeof loadConfig>): void {
  const logFile = cfg.logging.file;
  mkdirSync(dirname(logFile), { recursive: true });

  const stream = createWriteStream(logFile, { flags: 'a' });
  stream.on('error', (err) => origError(`[main] 日志文件写入异常: ${err}`));

  const fmt = (level: string, args: unknown[]): string =>
    `${new Date().toISOString()} [${level}] ${args.map(String).join(' ')}\n`;

  const origLog   = console.log.bind(console);
  const origError = console.error.bind(console);
  const origWarn  = console.warn.bind(console);

  console.log = (...args) => { origLog(...args);   stream.write(fmt('INFO',  args)); };
  console.error = (...args) => { origError(...args); stream.write(fmt('ERROR', args)); };
  console.warn  = (...args) => { origWarn(...args);  stream.write(fmt('WARN',  args)); };

  console.log(`[main] 日志级别: ${cfg.logging.level}, 文件: ${logFile}`);
}

function main(): void {
  const cfg = loadConfig('config.toml');
  validateConfig(cfg);
  setupLogging(cfg);

  const bot = new FeishuBot(cfg);

  const orchestrator = new Orchestrator(cfg, (chatId, payload) => bot.handleNotify(chatId, payload));
  bot.setOrchestrator(orchestrator);

  console.log('='.repeat(60));
  console.log('多 Agent 自动化开发系统启动（TypeScript 版）');
  console.log('='.repeat(60));

  bot.start();
}

main();
