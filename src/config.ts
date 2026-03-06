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

/**
 * 注意：claude-agent-sdk 使用 `claude login` 后的账户默认模型，
 * 这里的 model / max_tokens 当前未传入 SDK，仅作文档记录。
 */
export interface ClaudeConfig {
  model: string;
  max_tokens: number;
}

export interface BlackboxConfig {
  api_key: string;
  endpoint: string;
  model: string;
  timeout_ms: number;
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
  blackbox: BlackboxConfig;
  project: ProjectConfig;
  memory: MemoryConfig;
  logging: LoggingConfig;
}

/** 启动时校验必填配置，缺失则 fail-fast */
export function validateConfig(cfg: AppConfig): void {
  const errors: string[] = [];
  if (!cfg.feishu.app_id) errors.push('feishu.app_id 不能为空');
  if (!cfg.feishu.app_secret) errors.push('feishu.app_secret 不能为空');
  if (!cfg.project.workspace_path) errors.push('project.workspace_path 不能为空');
  if (errors.length > 0) {
    throw new Error(`[Config] 配置校验失败:\n${errors.map(e => `  - ${e}`).join('\n')}`);
  }

  // 非致命性提示
  const warn = (key: string, msg: string) =>
    console.warn(`[Config] 警告：${key} 未配置，${msg}`);

  if (!cfg.feishu.verification_token) warn('feishu.verification_token', '飞书请求将不做 token 校验（存在安全风险）');
  if (!cfg.blackbox.api_key) warn('blackbox.api_key', '意图分类将降级为关键词匹配');
  console.info('[Config] 提示：Memory API 需独立启动（默认 http://localhost:8000），未启动时自动降级为空上下文');
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
    blackbox: {
      api_key: (parsed.blackbox as Partial<BlackboxConfig> | undefined)?.api_key ?? process.env.BLACKBOX_API_KEY ?? '',
      endpoint: (parsed.blackbox as Partial<BlackboxConfig> | undefined)?.endpoint ?? 'https://api.blackbox.ai/chat/completions',
      model: (parsed.blackbox as Partial<BlackboxConfig> | undefined)?.model ?? 'blackboxai/deepseek/deepseek-chat-v3-0324',
      timeout_ms: (parsed.blackbox as Partial<BlackboxConfig> | undefined)?.timeout_ms ?? 10000,
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
