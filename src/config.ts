/**
 * 配置加载模块
 * 读取 config.toml，导出强类型配置对象，与现有 config.toml 格式完全兼容。
 */

import { readFileSync } from 'fs';
import { parse } from '@iarna/toml';

export interface FeishuConfig {
  app_id: string;
  app_secret: string;
  intake_chat_id: string;
  notify_user_id: string;
  verification_token: string;
  encrypt_key: string;
  port: number;
}

export interface ClaudeConfig {
  model: string;
  max_tokens: number;
}

export interface ProjectConfig {
  workspace_path: string;
  test_command: string;
  deploy_command: string;
  max_test_retries: number;
}

export interface MemoryConfig {
  base_path: string;
  recall_top_k: number;
}

export interface LoggingConfig {
  level: string;
  file: string;
}

export interface AppConfig {
  feishu: FeishuConfig;
  claude: ClaudeConfig;
  project: ProjectConfig;
  memory: MemoryConfig;
  logging: LoggingConfig;
}

export function loadConfig(configPath = 'config.toml'): AppConfig {
  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parse(raw) as unknown as Partial<AppConfig>;

  return {
    feishu: {
      app_id: parsed.feishu?.app_id ?? '',
      app_secret: parsed.feishu?.app_secret ?? '',
      intake_chat_id: parsed.feishu?.intake_chat_id ?? '',
      notify_user_id: parsed.feishu?.notify_user_id ?? '',
      verification_token: parsed.feishu?.verification_token ?? '',
      encrypt_key: parsed.feishu?.encrypt_key ?? '',
      port: parsed.feishu?.port ?? 8765,
    },
    claude: {
      model: parsed.claude?.model ?? 'claude-sonnet-4-6',
      max_tokens: parsed.claude?.max_tokens ?? 8192,
    },
    project: {
      workspace_path: parsed.project?.workspace_path ?? '.',
      test_command: parsed.project?.test_command ?? 'make test',
      deploy_command: parsed.project?.deploy_command ?? 'git push origin main',
      max_test_retries: parsed.project?.max_test_retries ?? 3,
    },
    memory: {
      base_path: parsed.memory?.base_path ?? './memory',
      recall_top_k: parsed.memory?.recall_top_k ?? 5,
    },
    logging: {
      level: parsed.logging?.level ?? 'INFO',
      file: parsed.logging?.file ?? './logs/agent.log',
    },
  };
}
