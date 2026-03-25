/**
 * 请求队列管理器
 * 控制并发请求数量，避免触发 API 限流
 */

import { createLogger } from './logger';

const log = createLogger('RequestQueue');

// 队列请求项
interface QueueItem<T> {
  id: string;
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  priority: number;  // 优先级，数字越大越优先
  retryCount: number;
  createdAt: number;
}

// 队列配置
interface QueueConfig {
  maxConcurrent: number;      // 最大并发数
  rateLimitPerMinute: number; // 每分钟请求限制
  retryDelay: number;         // 重试延迟（毫秒）
  maxRetries: number;         // 最大重试次数
}

// 默认配置
const DEFAULT_CONFIG: QueueConfig = {
  maxConcurrent: 3,           // 同时最多 3 个请求
  rateLimitPerMinute: 30,     // 每分钟最多 30 个请求
  retryDelay: 1000,           // 重试延迟 1 秒
  maxRetries: 3,
};

/**
 * 请求队列类
 */
export class RequestQueue {
  private config: QueueConfig;
  private queue: QueueItem<unknown>[] = [];
  private activeCount = 0;
  private requestTimestamps: number[] = [];  // 记录请求时间戳
  private isProcessing = false;
  private paused = false;

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.info('请求队列初始化', { config: this.config });
  }

  /**
   * 添加请求到队列
   */
  async add<T>(
    execute: () => Promise<T>,
    options: {
      priority?: number;
      id?: string;
    } = {}
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const item: QueueItem<T> = {
        id: options.id || `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        execute,
        resolve: resolve as (value: unknown) => void,
        reject,
        priority: options.priority || 0,
        retryCount: 0,
        createdAt: Date.now(),
      };

      this.queue.push(item as QueueItem<unknown>);

      // 按优先级排序（优先级高的在前）
      this.queue.sort((a, b) => b.priority - a.priority);

      log.debug('请求已加入队列', {
        id: item.id,
        priority: item.priority,
        queueLength: this.queue.length,
        activeCount: this.activeCount,
      });

      this.process();
    });
  }

  /**
   * 处理队列
   */
  private async process(): Promise<void> {
    if (this.isProcessing || this.paused) return;

    this.isProcessing = true;

    while (this.queue.length > 0) {
      // 检查并发限制
      if (this.activeCount >= this.config.maxConcurrent) {
        log.debug('达到并发限制，等待中...', {
          activeCount: this.activeCount,
          maxConcurrent: this.config.maxConcurrent,
        });
        break;
      }

      // 检查速率限制
      if (!this.canMakeRequest()) {
        log.debug('达到速率限制，等待中...');
        const waitTime = this.getTimeUntilNextRequest();
        await this.sleep(waitTime);
      }

      const item = this.queue.shift();
      if (!item) break;

      this.executeItem(item);
    }

    this.isProcessing = false;
  }

  /**
   * 执行单个请求
   */
  private async executeItem(item: QueueItem<unknown>): Promise<void> {
    this.activeCount++;
    this.requestTimestamps.push(Date.now());

    // 清理过期的时间戳
    this.cleanOldTimestamps();

    log.debug('开始执行请求', {
      id: item.id,
      activeCount: this.activeCount,
    });

    try {
      const result = await item.execute();

      log.debug('请求成功', { id: item.id });

      item.resolve(result);
    } catch (error: any) {
      // 检查是否需要重试
      if (this.shouldRetry(error) && item.retryCount < this.config.maxRetries) {
        item.retryCount++;

        log.warn('请求失败，准备重试', {
          id: item.id,
          error: error.message,
          retryCount: item.retryCount,
        });

        // 延迟后重新加入队列
        await this.sleep(this.config.retryDelay * item.retryCount);

        this.queue.unshift(item);  // 加到队首优先处理
        this.activeCount--;
        this.process();
        return;
      }

      log.error('请求失败', { id: item.id, error: error.message });
      item.reject(error);
    } finally {
      this.activeCount--;
      this.process();  // 继续处理队列
    }
  }

  /**
   * 检查是否可以发送请求（速率限制）
   */
  private canMakeRequest(): boolean {
    this.cleanOldTimestamps();
    return this.requestTimestamps.length < this.config.rateLimitPerMinute;
  }

  /**
   * 获取到下次可以请求的等待时间
   */
  private getTimeUntilNextRequest(): number {
    if (this.requestTimestamps.length === 0) return 0;

    const oneMinuteAgo = Date.now() - 60000;
    const oldestInWindow = this.requestTimestamps.find(t => t > oneMinuteAgo);

    if (!oldestInWindow) return 0;

    // 等待最早的那个请求"过期"
    return oldestInWindow + 60000 - Date.now() + 100;  // 加 100ms 缓冲
  }

  /**
   * 清理超过 1 分钟的时间戳
   */
  private cleanOldTimestamps(): void {
    const oneMinuteAgo = Date.now() - 60000;
    this.requestTimestamps = this.requestTimestamps.filter(t => t > oneMinuteAgo);
  }

  /**
   * 判断是否应该重试
   */
  private shouldRetry(error: any): boolean {
    // 429 限流错误
    if (error.statusCode === 429) return true;
    if (error.message?.includes('429') || error.message?.includes('rate limit')) return true;

    // 网络错误
    if (error.message?.includes('network') || error.message?.includes('timeout')) return true;

    // 服务器错误
    if (error.statusCode >= 500) return true;

    return false;
  }

  /**
   * 暂停队列处理
   */
  pause(): void {
    this.paused = true;
    log.info('请求队列已暂停');
  }

  /**
   * 恢复队列处理
   */
  resume(): void {
    this.paused = false;
    log.info('请求队列已恢复');
    this.process();
  }

  /**
   * 清空队列
   */
  clear(): void {
    const pending = this.queue.length;
    this.queue = [];
    log.info('请求队列已清空', { pendingCount: pending });
  }

  /**
   * 获取队列状态
   */
  getStatus(): {
    queueLength: number;
    activeCount: number;
    paused: boolean;
    requestCount: number;
  } {
    return {
      queueLength: this.queue.length,
      activeCount: this.activeCount,
      paused: this.paused,
      requestCount: this.requestTimestamps.length,
    };
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }
}

// 导出单例
export const requestQueue = new RequestQueue();

// 导出工厂函数
export function createRequestQueue(config?: Partial<QueueConfig>): RequestQueue {
  return new RequestQueue(config);
}
