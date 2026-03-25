/**
 * 上下文管理服务
 * 解决：上下文窗口限制、截断记忆丢失、Token成本、并发锁、权限校验、可观测性、降级预案
 */

import { createLogger } from './logger';

const log = createLogger('ContextManager');

// ==================== 类型定义 ====================

// Token 使用统计
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;  // 美元
  timestamp: number;
}

// 上下文配置
interface ContextConfig {
  maxContextTokens: number;       // 最大上下文 Token 数
  maxHistoryTurns: number;        // 最大对话轮数
  coreMemoryRatio: number;        // 核心记忆占比（0-1）
  compressionThreshold: number;   // 压缩阈值（Token 数）
  budgetLimit: number;            // 预算限制（美元/天）
  budgetPeriod: number;           // 预算周期（毫秒）
}

// 记忆层级
type MemoryTier = 'core' | 'recent' | 'compressed' | 'dropped';

// 记忆项
interface MemoryItem {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  tokens: number;
  tier: MemoryTier;
  importance: number;  // 重要性分数 0-1
  timestamp: number;
  compressed?: string; // 压缩后的摘要
}

// 降级级别
type DegradationLevel = 'normal' | 'light' | 'medium' | 'heavy' | 'minimal';

// 系统状态
interface SystemStatus {
  degradationLevel: DegradationLevel;
  tokenUsageToday: number;
  costToday: number;
  activeRequests: number;
  lastError?: string;
}

// 默认配置
const DEFAULT_CONFIG: ContextConfig = {
  maxContextTokens: 4000,          // DeepSeek 约 4K 上下文
  maxHistoryTurns: 10,             // 最多保留 10 轮对话
  coreMemoryRatio: 0.3,            // 30% 用于核心记忆
  compressionThreshold: 2000,      // 超过 2000 Token 触发压缩
  budgetLimit: 10,                 // 每天 $10 预算
  budgetPeriod: 24 * 60 * 60 * 1000, // 24 小时
};

// Token 价格（DeepSeek）
const TOKEN_PRICES = {
  'deepseek-chat': { input: 0.0001 / 1000, output: 0.0002 / 1000 },      // $0.1/M input, $0.2/M output
  'deepseek-reasoner': { input: 0.00055 / 1000, output: 0.00219 / 1000 },
};

// ==================== Token 计数器 ====================

/**
 * 估算文本的 Token 数量
 * 规则：英文约 4 字符 = 1 token，中文约 1.5 字符 = 1 token
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计中英文字符
  let chineseChars = 0;
  let englishChars = 0;
  let otherChars = 0;

  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code >= 0x4e00 && code <= 0x9fff) {
      chineseChars++;
    } else if (/[a-zA-Z0-9]/.test(char)) {
      englishChars++;
    } else {
      otherChars++;
    }
  }

  // 估算 token
  const chineseTokens = Math.ceil(chineseChars / 1.5);
  const englishTokens = Math.ceil(englishChars / 4);
  const otherTokens = Math.ceil(otherChars / 2);

  return chineseTokens + englishTokens + otherTokens;
}

/**
 * 计算消息列表的总 Token 数
 */
export function countMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  let total = 0;

  for (const msg of messages) {
    // 每条消息有约 4 token 的格式开销
    total += 4;
    total += estimateTokens(msg.content);
    total += estimateTokens(msg.role);
  }

  // 对话有约 3 token 的额外开销
  total += 3;

  return total;
}

// ==================== 并发锁 ====================

/**
 * 简单的互斥锁
 */
export class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<void> {
    if (!this.locked) {
      this.locked = true;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.locked = false;
    }
  }

  isLocked(): boolean {
    return this.locked;
  }
}

/**
 * 读写锁（允许多读单写）
 */
export class ReadWriteLock {
  private readers = 0;
  private writers = 0;
  private writeQueue: Array<() => void> = [];

  async readLock(): Promise<void> {
    while (this.writers > 0) {
      await new Promise<void>((resolve) => this.writeQueue.push(resolve));
    }
    this.readers++;
  }

  readUnlock(): void {
    this.readers--;
    this.notifyWaiters();
  }

  async writeLock(): Promise<void> {
    this.writers++;
    while (this.readers > 0 || this.writeQueue.length > 0) {
      await new Promise<void>((resolve) => this.writeQueue.push(resolve));
    }
  }

  writeUnlock(): void {
    this.writers--;
    this.notifyWaiters();
  }

  private notifyWaiters(): void {
    if (this.writers === 0 && this.readers === 0) {
      const waiters = this.writeQueue.splice(0, this.writeQueue.length);
      waiters.forEach(resolve => resolve());
    }
  }
}

// ==================== 权限校验 ====================

// 用户权限级别
export type PermissionLevel = 'guest' | 'user' | 'premium' | 'admin';

// 权限配置
const PERMISSION_LIMITS: Record<PermissionLevel, {
  maxTokensPerRequest: number;
  maxRequestsPerDay: number;
  maxDocumentSize: number;
  features: string[];
}> = {
  guest: {
    maxTokensPerRequest: 2000,
    maxRequestsPerDay: 10,
    maxDocumentSize: 1 * 1024 * 1024,  // 1MB
    features: ['basic_qa'],
  },
  user: {
    maxTokensPerRequest: 4000,
    maxRequestsPerDay: 100,
    maxDocumentSize: 5 * 1024 * 1024,  // 5MB
    features: ['basic_qa', 'document_analysis', 'flowchart'],
  },
  premium: {
    maxTokensPerRequest: 8000,
    maxRequestsPerDay: 500,
    maxDocumentSize: 20 * 1024 * 1024,  // 20MB
    features: ['basic_qa', 'document_analysis', 'flowchart', 'priority_queue'],
  },
  admin: {
    maxTokensPerRequest: 16000,
    maxRequestsPerDay: 999999,
    maxDocumentSize: 100 * 1024 * 1024,  // 100MB
    features: ['*'],
  },
};

/**
 * 权限校验器
 */
export class PermissionChecker {
  private userLevel: PermissionLevel = 'user';
  private dailyRequestCount: Map<string, number> = new Map();

  setUserLevel(level: PermissionLevel): void {
    this.userLevel = level;
    log.info('用户权限级别已设置', { level });
  }

  getUserLevel(): PermissionLevel {
    return this.userLevel;
  }

  getLimits() {
    return PERMISSION_LIMITS[this.userLevel];
  }

  /**
   * 检查是否有某个功能权限
   */
  hasFeature(feature: string): boolean {
    const limits = this.getLimits();
    return limits.features.includes('*') || limits.features.includes(feature);
  }

  /**
   * 检查文档大小权限
   */
  checkDocumentSize(sizeBytes: number): { allowed: boolean; message?: string } {
    const limits = this.getLimits();
    if (sizeBytes > limits.maxDocumentSize) {
      return {
        allowed: false,
        message: `文档大小超过限制（最大 ${this.formatSize(limits.maxDocumentSize)}，当前 ${this.formatSize(sizeBytes)}）`,
      };
    }
    return { allowed: true };
  }

  /**
   * 检查并记录请求
   */
  checkAndRecordRequest(userId: string): { allowed: boolean; remaining: number } {
    const limits = this.getLimits();
    const today = new Date().toDateString();
    const key = `${userId}:${today}`;

    const count = this.dailyRequestCount.get(key) || 0;
    const remaining = limits.maxRequestsPerDay - count;

    if (count >= limits.maxRequestsPerDay) {
      return { allowed: false, remaining: 0 };
    }

    this.dailyRequestCount.set(key, count + 1);
    return { allowed: true, remaining: remaining - 1 };
  }

  /**
   * 检查 Token 限制
   */
  checkTokenLimit(tokens: number): { allowed: boolean; message?: string } {
    const limits = this.getLimits();
    if (tokens > limits.maxTokensPerRequest) {
      return {
        allowed: false,
        message: `请求 Token 数超过限制（最大 ${limits.maxTokensPerRequest}，当前 ${tokens}）`,
      };
    }
    return { allowed: true };
  }

  private formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}

// ==================== 可观测性 ====================

/**
 * 指标收集器
 */
export class MetricsCollector {
  private metrics: Map<string, number[]> = new Map();
  private tokenUsage: TokenUsage[] = [];
  private errors: Array<{ timestamp: number; error: string; context: string }> = [];

  /**
   * 记录指标
   */
  recordMetric(name: string, value: number): void {
    if (!this.metrics.has(name)) {
      this.metrics.set(name, []);
    }
    this.metrics.get(name)!.push(value);

    // 保留最近 1000 个值
    const values = this.metrics.get(name)!;
    if (values.length > 1000) {
      values.shift();
    }
  }

  /**
   * 记录 Token 使用
   */
  recordTokenUsage(usage: TokenUsage): void {
    this.tokenUsage.push(usage);
    log.info('Token 使用记录', {
      prompt: usage.promptTokens,
      completion: usage.completionTokens,
      total: usage.totalTokens,
      cost: `$${usage.cost.toFixed(6)}`,
    });

    // 保留最近 1000 条记录
    if (this.tokenUsage.length > 1000) {
      this.tokenUsage.shift();
    }
  }

  /**
   * 记录错误
   */
  recordError(error: Error, context: string): void {
    this.errors.push({
      timestamp: Date.now(),
      error: error.message,
      context,
    });
    log.error('错误记录', { error: error.message, context });

    // 保留最近 100 条错误
    if (this.errors.length > 100) {
      this.errors.shift();
    }
  }

  /**
   * 获取统计数据
   */
  getStats(): {
    avgLatency: number;
    totalTokens: number;
    totalCost: number;
    errorRate: number;
    requestCount: number;
  } {
    const latencies = this.metrics.get('latency') || [];
    const avgLatency = latencies.length > 0
      ? latencies.reduce((a, b) => a + b, 0) / latencies.length
      : 0;

    const totalTokens = this.tokenUsage.reduce((sum, u) => sum + u.totalTokens, 0);
    const totalCost = this.tokenUsage.reduce((sum, u) => sum + u.cost, 0);

    const recentErrors = this.errors.filter(e => e.timestamp > Date.now() - 60000).length;
    const recentRequests = this.tokenUsage.filter(u => u.timestamp > Date.now() - 60000).length;
    const errorRate = recentRequests > 0 ? recentErrors / recentRequests : 0;

    return {
      avgLatency,
      totalTokens,
      totalCost,
      errorRate,
      requestCount: this.tokenUsage.length,
    };
  }

  /**
   * 获取今日使用情况
   */
  getTodayUsage(): { tokens: number; cost: number; requests: number } {
    const today = new Date().toDateString();
    const todayUsage = this.tokenUsage.filter(u => {
      return new Date(u.timestamp).toDateString() === today;
    });

    return {
      tokens: todayUsage.reduce((sum, u) => sum + u.totalTokens, 0),
      cost: todayUsage.reduce((sum, u) => sum + u.cost, 0),
      requests: todayUsage.length,
    };
  }

  /**
   * 导出监控数据
   */
  export(): object {
    return {
      metrics: Object.fromEntries(this.metrics),
      tokenUsage: this.tokenUsage.slice(-100),
      errors: this.errors.slice(-20),
      stats: this.getStats(),
    };
  }
}

// ==================== 上下文管理器 ====================

/**
 * 上下文管理器
 */
export class ContextManager {
  private config: ContextConfig;
  private memory: MemoryItem[] = [];
  private coreMemory: MemoryItem[] = [];  // 核心记忆（永久保留）
  private mutex = new Mutex();
  private metrics = new MetricsCollector();
  private permissionChecker = new PermissionChecker();
  private status: SystemStatus = {
    degradationLevel: 'normal',
    tokenUsageToday: 0,
    costToday: 0,
    activeRequests: 0,
  };

  constructor(config: Partial<ContextConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info('上下文管理器初始化', { config: this.config });
  }

  /**
   * 添加消息到记忆
   */
  async addMessage(
    role: 'user' | 'assistant' | 'system',
    content: string,
    options: { importance?: number; isCore?: boolean } = {}
  ): Promise<void> {
    await this.mutex.acquire();
    try {
      const tokens = estimateTokens(content);
      const item: MemoryItem = {
        id: `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        role,
        content,
        tokens,
        tier: options.isCore ? 'core' : 'recent',
        importance: options.importance || this.calculateImportance(content),
        timestamp: Date.now(),
      };

      if (options.isCore || item.importance > 0.8) {
        // 核心记忆
        this.coreMemory.push(item);
        item.tier = 'core';
      } else {
        // 普通记忆
        this.memory.push(item);
      }

      // 检查是否需要压缩
      await this.checkAndCompress();

      log.debug('消息已添加到记忆', {
        id: item.id,
        role,
        tokens,
        tier: item.tier,
        importance: item.importance.toFixed(2),
      });

    } finally {
      this.mutex.release();
    }
  }

  /**
   * 计算消息重要性
   */
  private calculateImportance(content: string): number {
    let score = 0.5;  // 基础分

    // 长度因素：适中的长度更重要
    const tokens = estimateTokens(content);
    if (tokens > 50 && tokens < 500) score += 0.1;

    // 关键词因素
    const importantKeywords = [
      '重要', '关键', '必须', '核心', '结论', '结果', '答案',
      'important', 'key', 'critical', 'conclusion', 'result',
    ];
    for (const keyword of importantKeywords) {
      if (content.toLowerCase().includes(keyword)) {
        score += 0.1;
        break;
      }
    }

    // 问题因素：用户问题通常重要
    if (content.includes('?') || content.includes('？')) {
      score += 0.1;
    }

    // 数字/数据因素
    if (/\d+/.test(content)) {
      score += 0.05;
    }

    return Math.min(1, score);
  }

  /**
   * 检查并执行压缩
   */
  private async checkAndCompress(): Promise<void> {
    const totalTokens = this.getTotalTokens();

    if (totalTokens <= this.config.compressionThreshold) {
      return;
    }

    log.info('触发上下文压缩', {
      totalTokens,
      threshold: this.config.compressionThreshold,
    });

    // 1. 按重要性排序
    this.memory.sort((a, b) => b.importance - a.importance);

    // 2. 标记最不重要的消息为待压缩
    const tokensToRemove = totalTokens - this.config.maxContextTokens * 0.7;
    let removedTokens = 0;
    const toCompress: MemoryItem[] = [];

    // 从后往前遍历（重要性最低的）
    for (let i = this.memory.length - 1; i >= 0 && removedTokens < tokensToRemove; i--) {
      const item = this.memory[i];
      if (item.tier === 'recent') {
        item.tier = 'compressed';
        toCompress.push(item);
        removedTokens += item.tokens;
      }
    }

    // 3. 压缩内容（生成摘要）
    for (const item of toCompress) {
      item.compressed = this.compressContent(item.content);
      item.tokens = estimateTokens(item.compressed);
    }

    log.info('上下文压缩完成', {
      compressedCount: toCompress.length,
      tokensRemoved: removedTokens,
      newTotal: this.getTotalTokens(),
    });

    this.metrics.recordMetric('compression_count', 1);
  }

  /**
   * 压缩内容（简单摘要）
   */
  private compressContent(content: string): string {
    // 简单压缩：取前 100 字符 + 后 50 字符
    if (content.length <= 150) return content;

    const front = content.substring(0, 100);
    const back = content.substring(content.length - 50);

    return `${front}...[已压缩]...${back}`;
  }

  /**
   * 获取构建好的上下文（用于发送给 API）
   */
  async getContextForAPI(
    newQuery: string,
    options: {
      maxTokens?: number;
      includeCore?: boolean;
    } = {}
  ): Promise<{
    messages: Array<{ role: string; content: string }>;
    stats: {
      totalTokens: number;
      memoryItems: number;
      compressedItems: number;
      truncated: boolean;
    };
  }> {
    await this.mutex.acquire();
    try {
      const maxTokens = options.maxTokens || this.config.maxContextTokens;
      const queryTokens = estimateTokens(newQuery);

      // 预留给系统和响应的 Token
      const reservedTokens = 500 + queryTokens;
      const availableTokens = maxTokens - reservedTokens;

      const messages: Array<{ role: string; content: string }> = [];
      let totalTokens = 0;
      let compressedCount = 0;
      let truncated = false;

      // 1. 添加核心记忆
      if (options.includeCore !== false) {
        for (const item of this.coreMemory) {
          if (totalTokens + item.tokens > availableTokens) break;
          messages.push({
            role: item.role,
            content: item.compressed || item.content,
          });
          totalTokens += item.tokens;
        }
      }

      // 2. 添加最近对话（从后往前，保留最新的）
      const recentMemory = this.memory
        .filter(m => m.tier !== 'dropped')
        .reverse();

      const recentMessages: Array<{ role: string; content: string }> = [];

      for (const item of recentMemory) {
        const content = item.compressed || item.content;
        const tokens = estimateTokens(content);

        if (totalTokens + tokens > availableTokens) {
          truncated = true;
          break;
        }

        recentMessages.unshift({
          role: item.role,
          content,
        });
        totalTokens += tokens;

        if (item.tier === 'compressed') {
          compressedCount++;
        }
      }

      messages.push(...recentMessages);

      // 3. 记录指标
      this.metrics.recordMetric('context_tokens', totalTokens);
      this.metrics.recordMetric('context_items', messages.length);

      return {
        messages,
        stats: {
          totalTokens,
          memoryItems: messages.length,
          compressedItems: compressedCount,
          truncated,
        },
      };

    } finally {
      this.mutex.release();
    }
  }

  /**
   * 获取总 Token 数
   */
  private getTotalTokens(): number {
    const coreTokens = this.coreMemory.reduce((sum, m) => sum + m.tokens, 0);
    const memoryTokens = this.memory.reduce((sum, m) => sum + m.tokens, 0);
    return coreTokens + memoryTokens;
  }

  /**
   * 计算 Token 成本
   */
  calculateCost(promptTokens: number, completionTokens: number, model: string = 'deepseek-chat'): number {
    const prices = TOKEN_PRICES[model as keyof typeof TOKEN_PRICES] || TOKEN_PRICES['deepseek-chat'];
    return promptTokens * prices.input + completionTokens * prices.output;
  }

  /**
   * 记录 API 使用
   */
  recordUsage(promptTokens: number, completionTokens: number, model: string = 'deepseek-chat'): void {
    const cost = this.calculateCost(promptTokens, completionTokens, model);
    this.metrics.recordTokenUsage({
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cost,
      timestamp: Date.now(),
    });

    // 更新状态
    this.status.tokenUsageToday += promptTokens + completionTokens;
    this.status.costToday += cost;

    // 检查预算
    if (this.status.costToday > this.config.budgetLimit * 0.8) {
      log.warn('接近预算限制', {
        costToday: this.status.costToday.toFixed(4),
        budgetLimit: this.config.budgetLimit,
      });
    }

    if (this.status.costToday > this.config.budgetLimit) {
      this.status.degradationLevel = 'heavy';
      log.error('已超出预算限制', {
        costToday: this.status.costToday.toFixed(4),
        budgetLimit: this.config.budgetLimit,
      });
    }
  }

  // ==================== 降级策略 ====================

  /**
   * 获取当前降级级别
   */
  getDegradationLevel(): DegradationLevel {
    // 根据错误率和成本自动调整
    const stats = this.metrics.getStats();

    if (this.status.costToday > this.config.budgetLimit) {
      return 'minimal';
    }
    if (stats.errorRate > 0.3) {
      return 'heavy';
    }
    if (stats.errorRate > 0.1) {
      return 'medium';
    }
    if (this.status.costToday > this.config.budgetLimit * 0.8) {
      return 'light';
    }

    return 'normal';
  }

  /**
   * 获取降级配置
   */
  getDegradationConfig(): {
    useCacheOnly: boolean;
    maxTokens: number;
    skipEmbedding: boolean;
    useLocalModel: boolean;
    responseMode: 'full' | 'brief' | 'minimal';
  } {
    const level = this.getDegradationLevel();

    const configs: Record<DegradationLevel, ReturnType<typeof this.getDegradationConfig>> = {
      normal: {
        useCacheOnly: false,
        maxTokens: this.config.maxContextTokens,
        skipEmbedding: false,
        useLocalModel: false,
        responseMode: 'full',
      },
      light: {
        useCacheOnly: false,
        maxTokens: this.config.maxContextTokens * 0.7,
        skipEmbedding: false,
        useLocalModel: false,
        responseMode: 'full',
      },
      medium: {
        useCacheOnly: false,
        maxTokens: this.config.maxContextTokens * 0.5,
        skipEmbedding: true,
        useLocalModel: false,
        responseMode: 'brief',
      },
      heavy: {
        useCacheOnly: true,
        maxTokens: this.config.maxContextTokens * 0.3,
        skipEmbedding: true,
        useLocalModel: true,
        responseMode: 'brief',
      },
      minimal: {
        useCacheOnly: true,
        maxTokens: 1000,
        skipEmbedding: true,
        useLocalModel: true,
        responseMode: 'minimal',
      },
    };

    const config = configs[level];
    log.info('降级配置', { level, config });

    return config;
  }

  // ==================== 工具方法 ====================

  /**
   * 获取权限检查器
   */
  getPermissionChecker(): PermissionChecker {
    return this.permissionChecker;
  }

  /**
   * 获取指标收集器
   */
  getMetrics(): MetricsCollector {
    return this.metrics;
  }

  /**
   * 获取系统状态
   */
  getStatus(): SystemStatus {
    return { ...this.status };
  }

  /**
   * 清空记忆
   */
  async clearMemory(): Promise<void> {
    await this.mutex.acquire();
    try {
      this.memory = [];
      this.coreMemory = [];
      log.info('记忆已清空');
    } finally {
      this.mutex.release();
    }
  }

  /**
   * 重置每日统计
   */
  resetDailyStats(): void {
    this.status.tokenUsageToday = 0;
    this.status.costToday = 0;
    this.status.degradationLevel = 'normal';
    log.info('每日统计已重置');
  }
}

// 导出单例
export const contextManager = new ContextManager();
