/**
 * 共享记忆层（简化版，去掉 ChromaDB，使用关键词匹配 recall）
 * 文件结构与 Python 版兼容：facts.md, decisions/, patterns/, bugs/, daily/
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, appendFileSync } from 'fs';
import { join } from 'path';

const WRITE_PERMISSIONS: Record<string, string[]> = {
  orchestrator: ['daily', 'decisions'],
  design:       ['decisions', 'patterns'],
  dev:          ['patterns'],
  test:         ['bugs'],
  pm:           [],
};

export class MemoryManager {
  private basePath: string;
  private recallTopK: number;

  constructor(basePath = './memory', recallTopK = 5) {
    this.basePath = basePath;
    this.recallTopK = recallTopK;
  }

  // ── 读接口 ──────────────────────────────────────────────────────── //

  readFacts(): string {
    return this.readFile(join(this.basePath, 'facts.md'));
  }

  listDecisions(): string[] {
    return this.listMdFiles(join(this.basePath, 'decisions'));
  }

  readDecision(filename: string): string {
    return this.readFile(join(this.basePath, 'decisions', filename));
  }

  listPatterns(): string[] {
    return this.listMdFiles(join(this.basePath, 'patterns'));
  }

  readPattern(filename: string): string {
    return this.readFile(join(this.basePath, 'patterns', filename));
  }

  listBugs(): string[] {
    return this.listMdFiles(join(this.basePath, 'bugs'));
  }

  readBug(filename: string): string {
    return this.readFile(join(this.basePath, 'bugs', filename));
  }

  recall(query: string, topK?: number): string {
    return this.recallKeyword(query, topK ?? this.recallTopK);
  }

  // ── 写接口 ──────────────────────────────────────────────────────── //

  writeDailyLog(agentName: string, content: string): string {
    this.checkPermission(agentName, 'daily');
    const today = new Date().toISOString().slice(0, 10);
    const dir = this.ensureDir(join(this.basePath, 'daily'));
    const path = join(dir, `${today}.md`);
    const timestamp = new Date().toTimeString().slice(0, 8);
    appendFileSync(path, `\n\n## [${timestamp}] ${agentName}\n${content}`, 'utf-8');
    return path;
  }

  writeDecision(agentName: string, title: string, content: string): string {
    this.checkPermission(agentName, 'decisions');
    const today = new Date().toISOString().slice(0, 10);
    const filename = this.sanitizeFilename(title, `${today}-`);
    const path = join(this.ensureDir(join(this.basePath, 'decisions')), filename);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  writePattern(agentName: string, title: string, content: string): string {
    this.checkPermission(agentName, 'patterns');
    const filename = this.sanitizeFilename(title);
    const path = join(this.ensureDir(join(this.basePath, 'patterns')), filename);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  writeBug(agentName: string, title: string, content: string): string {
    this.checkPermission(agentName, 'bugs');
    const filename = this.sanitizeFilename(title);
    const path = join(this.ensureDir(join(this.basePath, 'bugs')), filename);
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  updateFacts(agentName: string, content: string): string {
    if (agentName !== 'orchestrator') {
      throw new Error(`[MemoryManager] ${agentName} 无权修改 facts.md`);
    }
    const path = join(this.basePath, 'facts.md');
    writeFileSync(path, content, 'utf-8');
    return path;
  }

  // ── 内部方法 ─────────────────────────────────────────────────────── //

  private checkPermission(agentName: string, directory: string): void {
    const allowed = WRITE_PERMISSIONS[agentName] ?? [];
    if (!allowed.includes(directory)) {
      throw new Error(`[MemoryManager] ${agentName} 无权写入 ${directory}/ 目录`);
    }
  }

  private sanitizeFilename(title: string, prefix = '', maxLen = 50): string {
    const safe = title.replace(/[^\w\-]/g, '-').slice(0, maxLen);
    return `${prefix}${safe}.md`;
  }

  private ensureDir(dir: string): string {
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private readFile(path: string): string {
    try {
      return readFileSync(path, 'utf-8');
    } catch {
      return '';
    }
  }

  private listMdFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter(f => f.endsWith('.md')).sort();
    } catch {
      return [];
    }
  }

  private recallKeyword(query: string, k: number): string {
    const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    const allFiles: string[] = [join(this.basePath, 'facts.md')];

    for (const sub of ['decisions', 'patterns', 'bugs', 'daily']) {
      try {
        const dir = join(this.basePath, sub);
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.md')) allFiles.push(join(dir, f));
        }
      } catch { /* 目录不存在，跳过 */ }
    }

    const matches: Array<{ score: number; path: string; content: string }> = [];
    for (const filePath of allFiles) {
      const content = this.readFile(filePath);
      const lower = content.toLowerCase();
      const score = keywords.reduce((acc, kw) => {
        let count = 0;
        let pos = 0;
        while ((pos = lower.indexOf(kw, pos)) !== -1) { count++; pos++; }
        return acc + count;
      }, 0);
      if (score > 0) matches.push({ score, path: filePath, content });
    }

    matches.sort((a, b) => b.score - a.score);
    const results = matches.slice(0, k).map(({ path, content }) => {
      const snippet = content.length > 500 ? content.slice(0, 500) + '...' : content;
      return `**来源**: ${path}\n${snippet}`;
    });

    return results.length > 0 ? results.join('\n\n---\n\n') : '（未找到相关记忆）';
  }
}
