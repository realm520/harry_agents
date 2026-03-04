/**
 * 工作流状态机
 * - 状态持久化到 JSON 文件，支持服务重启后恢复
 * - 与 Python 版 state_machine.py 的 JSON 格式完全兼容
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

export enum WorkflowState {
  INTAKE         = 'INTAKE',
  PLANNING       = 'PLANNING',
  DESIGN         = 'DESIGN',
  DEVELOPMENT    = 'DEVELOPMENT',
  TESTING        = 'TESTING',
  REVIEW         = 'REVIEW',
  DEPLOY_CONFIRM = 'DEPLOY_CONFIRM',
  DEPLOYING      = 'DEPLOYING',
  DONE           = 'DONE',
  FAILED         = 'FAILED',
}

const TERMINAL_STATES = new Set([WorkflowState.DONE, WorkflowState.FAILED]);

// 状态转移表
const TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  [WorkflowState.INTAKE]:         [WorkflowState.PLANNING, WorkflowState.DONE],
  [WorkflowState.PLANNING]:       [WorkflowState.DESIGN],
  [WorkflowState.DESIGN]:         [WorkflowState.DEVELOPMENT],
  [WorkflowState.DEVELOPMENT]:    [WorkflowState.TESTING],
  [WorkflowState.TESTING]:        [WorkflowState.DEPLOY_CONFIRM, WorkflowState.DEVELOPMENT, WorkflowState.REVIEW],
  [WorkflowState.REVIEW]:         [WorkflowState.DEVELOPMENT, WorkflowState.FAILED],
  [WorkflowState.DEPLOY_CONFIRM]: [WorkflowState.DEPLOYING, WorkflowState.DONE],
  [WorkflowState.DEPLOYING]:      [WorkflowState.DONE, WorkflowState.FAILED],
  [WorkflowState.DONE]:           [],
  [WorkflowState.FAILED]:         [],
};

export interface TaskContext {
  task_id: string;
  state: string;
  feishu_chat_id: string;
  feishu_message_id: string;
  requester_user_id: string;
  original_request: string;
  story_path: string | null;
  tech_spec_path: string | null;
  dev_report_path: string | null;
  test_report_path: string | null;
  deploy_report_path: string | null;
  test_retry_count: number;
  max_test_retries: number;
  created_at: string;
  updated_at: string;
  error: string | null;
  metadata: Record<string, unknown>;
}

function newTaskContext(overrides: Partial<TaskContext> = {}): TaskContext {
  const now = new Date().toISOString();
  return {
    task_id: randomUUID().slice(0, 8),
    state: WorkflowState.INTAKE,
    feishu_chat_id: '',
    feishu_message_id: '',
    requester_user_id: '',
    original_request: '',
    story_path: null,
    tech_spec_path: null,
    dev_report_path: null,
    test_report_path: null,
    deploy_report_path: null,
    test_retry_count: 0,
    max_test_retries: 3,
    created_at: now,
    updated_at: now,
    error: null,
    metadata: {},
    ...overrides,
  };
}

export class StateMachine {
  private statesDir: string;

  constructor(statesDir = './states') {
    this.statesDir = statesDir;
    mkdirSync(statesDir, { recursive: true });
  }

  createTask(opts: {
    original_request: string;
    feishu_chat_id?: string;
    feishu_message_id?: string;
    requester_user_id?: string;
    max_test_retries?: number;
  }): TaskContext {
    const ctx = newTaskContext({
      original_request: opts.original_request,
      feishu_chat_id: opts.feishu_chat_id ?? '',
      feishu_message_id: opts.feishu_message_id ?? '',
      requester_user_id: opts.requester_user_id ?? '',
      max_test_retries: opts.max_test_retries ?? 3,
    });
    this.save(ctx);
    return ctx;
  }

  loadTask(taskId: string): TaskContext | null {
    const path = join(this.statesDir, `${taskId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf-8')) as TaskContext;
  }

  transition(
    ctx: TaskContext,
    newState: WorkflowState,
    updates: Partial<TaskContext> = {},
  ): TaskContext {
    const current = ctx.state as WorkflowState;
    const allowed = TRANSITIONS[current] ?? [];
    if (!allowed.includes(newState)) {
      throw new Error(
        `[StateMachine] 非法状态转移 ${current} → ${newState}，允许的目标状态：${allowed.join(', ')}`,
      );
    }

    const updated: TaskContext = {
      ...ctx,
      ...updates,
      state: newState,
      updated_at: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  failTask(ctx: TaskContext, error: string): TaskContext {
    const updated: TaskContext = {
      ...ctx,
      state: WorkflowState.FAILED,
      error,
      updated_at: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  listActiveTasks(): TaskContext[] {
    const tasks: TaskContext[] = [];
    for (const file of readdirSync(this.statesDir)) {
      if (!file.endsWith('.json')) continue;
      const ctx = JSON.parse(
        readFileSync(join(this.statesDir, file), 'utf-8'),
      ) as TaskContext;
      if (!TERMINAL_STATES.has(ctx.state as WorkflowState)) {
        tasks.push(ctx);
      }
    }
    return tasks;
  }

  canRetryTest(ctx: TaskContext): boolean {
    return ctx.test_retry_count < ctx.max_test_retries;
  }

  incrementTestRetry(ctx: TaskContext): TaskContext {
    const updated: TaskContext = {
      ...ctx,
      test_retry_count: ctx.test_retry_count + 1,
      updated_at: new Date().toISOString(),
    };
    this.save(updated);
    return updated;
  }

  private save(ctx: TaskContext): void {
    const path = join(this.statesDir, `${ctx.task_id}.json`);
    writeFileSync(path, JSON.stringify(ctx, null, 2), 'utf-8');
  }
}
