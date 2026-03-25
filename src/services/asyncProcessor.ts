/**
 * 异步处理器
 * 将大型任务分片执行，避免阻塞 UI
 */

import { createLogger } from './logger';

const log = createLogger('AsyncProcessor');

// 处理器配置
interface ProcessorConfig {
  chunkSize: number;      // 每次处理的数量
  yieldInterval: number;  // 让出主线程的间隔（毫秒）
}

const DEFAULT_CONFIG: ProcessorConfig = {
  chunkSize: 10,          // 每次处理 10 个
  yieldInterval: 16,      // 约 60fps
};

/**
 * 分片处理数组
 * 避免一次性处理大量数据阻塞 UI
 */
export async function processInChunks<T, R>(
  items: T[],
  processor: (item: T, index: number) => R | Promise<R>,
  options: {
    chunkSize?: number;
    onProgress?: (processed: number, total: number) => void;
  } = {}
): Promise<R[]> {
  const config = { ...DEFAULT_CONFIG, ...options };
  const results: R[] = [];
  const total = items.length;

  for (let i = 0; i < total; i += config.chunkSize) {
    const chunk = items.slice(i, i + config.chunkSize);

    // 处理当前批次
    for (let j = 0; j < chunk.length; j++) {
      const result = await processor(chunk[j], i + j);
      results.push(result);
    }

    // 报告进度
    options.onProgress?.(Math.min(i + config.chunkSize, total), total);

    // 让出主线程，给 UI 更新的机会
    await yieldToMain();
  }

  return results;
}

/**
 * 让出主线程
 */
function yieldToMain(): Promise<void> {
  return new Promise(resolve => {
    // 优先使用 scheduler.yield()（如果可用）
    if ('scheduler' in window && 'yield' in (window as any).scheduler) {
      (window as any).scheduler.yield().then(resolve);
    } else {
      // 回退到 setTimeout
      setTimeout(resolve, 0);
    }
  });
}

/**
 * 使用 requestIdleCallback 处理低优先级任务
 */
export function scheduleIdleTask(callback: () => void, timeout = 2000): void {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(callback, { timeout });
  } else {
    setTimeout(callback, 0);
  }
}

/**
 * 创建可取消的异步任务
 */
export class CancellableTask<T> {
  private cancelled = false;
  private promise: Promise<T>;

  constructor(
    executor: (checkCancelled: () => boolean) => Promise<T>
  ) {
    this.promise = executor(() => this.cancelled);
  }

  cancel(): void {
    this.cancelled = true;
    log.debug('任务已取消');
  }

  async getResult(): Promise<T> {
    return this.promise;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }
}

/**
 * 并发执行多个任务（带限制）
 */
export async function parallelLimit<T, R>(
  items: T[],
  limit: number,
  processor: (item: T, index: number) => Promise<R>,
  options: {
    onProgress?: (completed: number, total: number) => void;
    onItemStart?: (item: T, index: number) => void;
    onItemComplete?: (item: T, index: number, result: R) => void;
  } = {}
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let completed = 0;
  let currentIndex = 0;

  async function runNext(): Promise<void> {
    while (currentIndex < items.length) {
      const index = currentIndex++;

      options.onItemStart?.(items[index], index);

      try {
        const result = await processor(items[index], index);
        results[index] = result;
        completed++;

        options.onItemComplete?.(items[index], index, result);
        options.onProgress?.(completed, items.length);
      } catch (error) {
        log.error('任务执行失败', { index, error });
        throw error;
      }
    }
  }

  // 启动 limit 个并行任务
  const workers = Array(Math.min(limit, items.length))
    .fill(null)
    .map(() => runNext());

  await Promise.all(workers);

  return results;
}

/**
 * 进度报告器
 */
export class ProgressReporter {
  private lastReport = 0;
  private minInterval: number;

  constructor(minInterval = 100) {
    this.minInterval = minInterval;
  }

  report(
    current: number,
    total: number,
    callback: (progress: number, status: string) => void
  ): void {
    const now = Date.now();
    const progress = Math.round((current / total) * 100);

    // 限制报告频率
    if (now - this.lastReport >= this.minInterval || progress === 100) {
      this.lastReport = now;
      const status = `${current}/${total} (${progress}%)`;
      callback(progress, status);
    }
  }
}

/**
 * 超时包装器
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message = '操作超时'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);

    promise
      .then((result) => {
        clearTimeout(timeoutId);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timeoutId);
        reject(error);
      });
  });
}
