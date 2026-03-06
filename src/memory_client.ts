/**
 * AgentMemoryClient - Agent Memory API HTTP 客户端
 * 替换基于关键词匹配的 MemoryManager，提供三因子评分检索
 * API 地址：http://localhost:8000
 */

const DEFAULT_BASE = 'http://localhost:8000';
const DEFAULT_PROJECT = 'multi-agent-system';

export type MemoryType =
  | 'working' | 'episodic' | 'semantic' | 'reflection'
  | 'prd' | 'code' | 'bug' | 'ci_cd' | 'arch' | 'tool';

export interface MemorySearchResult {
  id: string;
  content: string;
  type: MemoryType;
  score: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export class AgentMemoryClient {
  private base: string;
  private project: string;

  constructor(base = DEFAULT_BASE, project = DEFAULT_PROJECT) {
    this.base = base;
    this.project = project;
  }

  /** 存储记忆，返回记忆 id */
  async store(
    content: string,
    type: MemoryType,
    opts?: { taskId?: string; module?: string; importance?: number; tags?: string[] },
  ): Promise<string> {
    const res = await this.request('/memory/store', {
      method: 'POST',
      body: JSON.stringify({
        content,
        memory_type: type,
        project: this.project,
        task_id: opts?.taskId,
        module: opts?.module,
        importance: opts?.importance ?? 0.5,
        tags: opts?.tags ?? [],
      }),
    });
    return (res as { id: string }).id;
  }

  /** 三因子检索（语义相似度 + 时效性 + 重要性） */
  async retrieve(
    task: string,
    opts?: { memoryTypes?: MemoryType[]; limit?: number; threshold?: number },
  ): Promise<MemorySearchResult[]> {
    const res = await this.request('/memory/retrieve', {
      method: 'POST',
      body: JSON.stringify({
        query: task,
        project: this.project,
        memory_types: opts?.memoryTypes,
        limit: opts?.limit ?? 5,
        threshold: opts?.threshold ?? 0.5,
      }),
    });
    return (res as { results: MemorySearchResult[] }).results ?? [];
  }

  /** 构建 LLM 注入格式 context（带 token 预算控制），失败时返回空字符串 */
  async buildContext(task: string, tokenBudget = 2000): Promise<string> {
    try {
      const res = await this.request('/memory/context', {
        method: 'POST',
        body: JSON.stringify({
          query: task,
          project: this.project,
          token_budget: tokenBudget,
        }),
      });
      return (res as { context: string }).context ?? '';
    } catch (e) {
      console.warn(`[MemoryClient] buildContext 失败，降级为空: ${e}`);
      return '';
    }
  }

  /** 任务完成后触发 reflection 生成 */
  async reflect(taskId: string): Promise<void> {
    try {
      await this.request('/memory/reflect', {
        method: 'POST',
        body: JSON.stringify({ task_id: taskId, project: this.project }),
      });
    } catch (e) {
      console.warn(`[MemoryClient] reflect 失败: ${e}`);
    }
  }

  /** 设置 Agent 工作记忆（用于流水线 Agent 间传递状态） */
  async setWorking(
    agentId: string,
    data: Record<string, unknown>,
    ttl = 3600,
  ): Promise<void> {
    try {
      await this.request('/memory/working', {
        method: 'PUT',
        body: JSON.stringify({
          agent_id: agentId,
          project: this.project,
          data,
          ttl,
        }),
      });
    } catch (e) {
      console.warn(`[MemoryClient] setWorking(${agentId}) 失败: ${e}`);
    }
  }

  /** 获取 Agent 工作记忆 */
  async getWorking(agentId: string): Promise<Record<string, unknown>> {
    try {
      const res = await this.request(
        `/memory/working/${encodeURIComponent(agentId)}?project=${encodeURIComponent(this.project)}`,
        { method: 'GET' },
      );
      return (res as { data: Record<string, unknown> }).data ?? {};
    } catch (e) {
      console.warn(`[MemoryClient] getWorking(${agentId}) 失败: ${e}`);
      return {};
    }
  }

  /** 定期剪枝（清理过期/低重要性记忆） */
  async prune(): Promise<void> {
    try {
      await this.request('/memory/prune', {
        method: 'POST',
        body: JSON.stringify({ project: this.project }),
      });
    } catch (e) {
      console.warn(`[MemoryClient] prune 失败: ${e}`);
    }
  }

  // ── 内部 ────────────────────────────────────────────────────────────── //

  private async request(path: string, init: RequestInit): Promise<unknown> {
    const url = `${this.base}${path}`;
    const res = await globalThis.fetch(url, {
      ...init,
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`[MemoryClient] ${init.method ?? 'GET'} ${path} => HTTP ${res.status}: ${body}`);
    }
    return res.json();
  }
}
