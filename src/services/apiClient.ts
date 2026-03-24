/**
 * 统一 API 客户端
 * 提供超时控制、指数退避重试、请求取消功能
 */

import { AppError, ErrorType, createAppError } from '../utils/errors';
import { createLogger } from './logger';

const log = createLogger('ApiClient');

// API 客户端配置
interface ApiClientConfig {
  defaultTimeout: number;   // 默认超时时间（毫秒）
  maxRetries: number;       // 最大重试次数
  baseRetryDelay: number;   // 重试延迟基数（毫秒）
}

// 请求选项
interface RequestOptions {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  timeout?: number;         // 覆盖默认超时
  retries?: number;         // 覆盖默认重试次数
  signal?: AbortSignal;     // 外部 AbortSignal
}

// 默认配置
const DEFAULT_CONFIG: ApiClientConfig = {
  defaultTimeout: 30000,    // 30 秒
  maxRetries: 3,
  baseRetryDelay: 1000,     // 1 秒
};

/**
 * API 客户端类
 */
export class ApiClient {
  private config: ApiClientConfig;
  private abortController: AbortController | null = null;
  private activeRequests: Set<AbortController> = new Set();

  constructor(config: Partial<ApiClientConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    log.debug('ApiClient 初始化', { config: this.config });
  }

  /**
   * 发送请求
   */
  async request<T>(options: RequestOptions): Promise<T> {
    const {
      url,
      method,
      headers = {},
      body,
      timeout = this.config.defaultTimeout,
      retries = this.config.maxRetries,
      signal: externalSignal,
    } = options;

    // 创建 AbortController 用于超时和取消
    const abortController = new AbortController();
    this.activeRequests.add(abortController);

    // 如果有外部 signal，监听其取消事件
    if (externalSignal) {
      if (externalSignal.aborted) {
        throw new AppError({
          type: ErrorType.CANCELLED,
          retryable: false,
        });
      }
      externalSignal.addEventListener('abort', () => {
        abortController.abort();
      });
    }

    let lastError: Error | null = null;

    // 重试循环
    for (let attempt = 0; attempt <= retries; attempt++) {
      // 检查是否已取消
      if (abortController.signal.aborted) {
        throw new AppError({
          type: ErrorType.CANCELLED,
          retryable: false,
        });
      }

      try {
        log.debug(`发送请求 (尝试 ${attempt + 1}/${retries + 1})`, {
          url,
          method,
          attempt,
        });

        // 设置超时
        const timeoutId = setTimeout(() => {
          abortController.abort();
        }, timeout);

        // 发送请求
        const fetchOptions: RequestInit = {
          method,
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          signal: abortController.signal,
        };

        if (body && method === 'POST') {
          fetchOptions.body = JSON.stringify(body);
        }

        const response = await fetch(url, fetchOptions);

        // 清除超时定时器
        clearTimeout(timeoutId);

        // 处理 HTTP 错误
        if (!response.ok) {
          const errorText = await response.text();
          let errorMessage = errorText;

          try {
            const errorJson = JSON.parse(errorText);
            errorMessage = errorJson.error?.message || errorJson.message || errorText;
          } catch {
            // 保持原始文本
          }

          // 特殊状态码处理
          if (response.status === 401) {
            throw new AppError({
              type: ErrorType.API_ERROR,
              message: 'API Key 无效或已过期',
              statusCode: 401,
              retryable: false,
            });
          }

          if (response.status === 429) {
            // 限流，等待后重试
            const retryAfter = response.headers.get('Retry-After');
            const waitTime = retryAfter ? parseInt(retryAfter) * 1000 : this.calculateDelay(attempt);
            log.warn('API 限流，等待重试', { waitTime, attempt });
            await this.sleep(waitTime);
            continue;
          }

          if (response.status >= 500) {
            // 服务器错误，可重试
            throw new AppError({
              type: ErrorType.API_ERROR,
              message: `服务器错误 (${response.status}): ${errorMessage}`,
              statusCode: response.status,
              retryable: true,
            });
          }

          // 其他客户端错误
          throw new AppError({
            type: ErrorType.API_ERROR,
            message: errorMessage,
            statusCode: response.status,
            retryable: false,
          });
        }

        // 解析响应
        const responseText = await response.text();

        let data: T;
        try {
          data = JSON.parse(responseText);
        } catch (parseError) {
          throw new AppError({
            type: ErrorType.PARSE_ERROR,
            message: 'API 返回了非 JSON 格式的响应',
            originalError: parseError as Error,
          });
        }

        log.debug('请求成功', { url, status: response.status });

        // 清理
        this.activeRequests.delete(abortController);

        return data;

      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        // 如果是 AppError 且不可重试，直接抛出
        if (error instanceof AppError && !error.retryable) {
          this.activeRequests.delete(abortController);
          throw error;
        }

        // 取消错误
        if (error instanceof Error && error.name === 'AbortError') {
          this.activeRequests.delete(abortController);
          throw new AppError({
            type: ErrorType.CANCELLED,
            retryable: false,
          });
        }

        // 超时错误
        if (abortController.signal.aborted) {
          lastError = new AppError({
            type: ErrorType.TIMEOUT,
            message: `请求超时 (${timeout}ms)`,
            retryable: true,
          });
        }

        log.warn(`请求失败 (尝试 ${attempt + 1}/${retries + 1})`, {
          error: lastError.message,
          willRetry: attempt < retries,
        });

        // 如果还有重试机会，等待后重试
        if (attempt < retries) {
          const delay = this.calculateDelay(attempt);
          log.debug(`等待 ${delay}ms 后重试`);
          await this.sleep(delay);
        }
      }
    }

    // 所有重试都失败
    this.activeRequests.delete(abortController);

    throw createAppError(lastError);
  }

  /**
   * 计算指数退避延迟
   */
  private calculateDelay(attempt: number): number {
    // 指数退避: 1s, 2s, 4s
    const delay = this.config.baseRetryDelay * Math.pow(2, attempt);
    // 添加随机抖动 (±20%)
    const jitter = delay * 0.2 * (Math.random() - 0.5);
    return Math.round(delay + jitter);
  }

  /**
   * 延迟函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * 取消所有活动请求
   */
  abort(): void {
    log.info('取消所有活动请求');
    this.activeRequests.forEach(controller => {
      controller.abort();
    });
    this.activeRequests.clear();

    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  /**
   * 创建一个新的 AbortController 并返回
   */
  createAbortController(): AbortController {
    const controller = new AbortController();
    this.abortController = controller;
    return controller;
  }

  /**
   * 获取当前 AbortController 的 signal
   */
  getSignal(): AbortSignal | undefined {
    return this.abortController?.signal;
  }
}

// 导出单例
export const apiClient = new ApiClient();

// 导出工厂函数，用于创建独立实例
export function createApiClient(config?: Partial<ApiClientConfig>): ApiClient {
  return new ApiClient(config);
}
