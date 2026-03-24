/**
 * 自定义错误类型 - 统一错误处理
 */

// 错误类型枚举
export enum ErrorType {
  TIMEOUT = 'TIMEOUT',           // 请求超时
  NETWORK = 'NETWORK',           // 网络错误
  API_ERROR = 'API_ERROR',       // API 返回错误
  VALIDATION = 'VALIDATION',     // 数据验证错误
  PARSE_ERROR = 'PARSE_ERROR',   // 解析错误
  CANCELLED = 'CANCELLED',       // 用户取消
  UNKNOWN = 'UNKNOWN',           // 未知错误
}

// 用户友好的错误消息
const ERROR_MESSAGES: Record<ErrorType, string> = {
  [ErrorType.TIMEOUT]: '请求超时，请检查网络连接后重试',
  [ErrorType.NETWORK]: '网络连接失败，请检查网络设置',
  [ErrorType.API_ERROR]: 'API 服务暂时不可用，请稍后重试',
  [ErrorType.VALIDATION]: '数据格式不正确，请检查输入内容',
  [ErrorType.PARSE_ERROR]: '文档解析失败，请检查文件格式',
  [ErrorType.CANCELLED]: '操作已取消',
  [ErrorType.UNKNOWN]: '发生未知错误，请重试',
};

// 建议的解决方案
const ERROR_SOLUTIONS: Record<ErrorType, string[]> = {
  [ErrorType.TIMEOUT]: [
    '检查网络连接是否稳定',
    '尝试刷新页面后重新操作',
    '如果文件较大，请耐心等待',
  ],
  [ErrorType.NETWORK]: [
    '检查网络连接',
    '尝试切换网络环境',
    '检查防火墙设置',
  ],
  [ErrorType.API_ERROR]: [
    '确认 API Key 配置正确',
    '稍后重试',
    '联系技术支持',
  ],
  [ErrorType.VALIDATION]: [
    '检查文件格式是否支持',
    '确保文件内容完整',
    '尝试使用其他文件',
  ],
  [ErrorType.PARSE_ERROR]: [
    '确认文件未损坏',
    '尝试重新上传文件',
    '检查文件格式是否正确',
  ],
  [ErrorType.CANCELLED]: [],
  [ErrorType.UNKNOWN]: [
    '刷新页面',
    '清除浏览器缓存',
    '联系技术支持',
  ],
};

/**
 * 自定义应用错误类
 */
export class AppError extends Error {
  readonly type: ErrorType;
  readonly originalError?: Error;
  readonly userMessage: string;
  readonly solutions: string[];
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(options: {
    type: ErrorType;
    message?: string;
    originalError?: Error;
    statusCode?: number;
    retryable?: boolean;
  }) {
    const userMessage = options.message || ERROR_MESSAGES[options.type];
    super(userMessage);

    this.name = 'AppError';
    this.type = options.type;
    this.originalError = options.originalError;
    this.userMessage = userMessage;
    this.solutions = ERROR_SOLUTIONS[options.type];
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? this.isRetryableByDefault(options.type);

    // 保持正确的原型链
    Object.setPrototypeOf(this, AppError.prototype);
  }

  private isRetryableByDefault(type: ErrorType): boolean {
    return [ErrorType.TIMEOUT, ErrorType.NETWORK, ErrorType.API_ERROR].includes(type);
  }

  /**
   * 获取完整的错误信息（用于日志）
   */
  toLogString(): string {
    const parts = [
      `[${this.type}] ${this.message}`,
      this.statusCode && `HTTP ${this.statusCode}`,
      this.originalError?.message,
    ].filter(Boolean);

    return parts.join(' | ');
  }

  /**
   * 转换为 JSON（用于存储或传输）
   */
  toJSON(): Record<string, unknown> {
    return {
      type: this.type,
      message: this.userMessage,
      solutions: this.solutions,
      retryable: this.retryable,
      statusCode: this.statusCode,
    };
  }
}

/**
 * 从原始错误创建 AppError
 */
export function createAppError(error: unknown, context?: {
  type?: ErrorType;
  statusCode?: number;
}): AppError {
  // 已经是 AppError
  if (error instanceof AppError) {
    return error;
  }

  // AbortError - 用户取消
  if (error instanceof Error && error.name === 'AbortError') {
    return new AppError({
      type: ErrorType.CANCELLED,
      originalError: error,
      retryable: false,
    });
  }

  // 从错误消息推断类型
  if (error instanceof Error) {
    const message = error.message.toLowerCase();

    if (message.includes('timeout') || message.includes('超时')) {
      return new AppError({
        type: ErrorType.TIMEOUT,
        originalError: error,
        statusCode: context?.statusCode,
      });
    }

    if (message.includes('network') || message.includes('fetch') || message.includes('网络')) {
      return new AppError({
        type: ErrorType.NETWORK,
        originalError: error,
        statusCode: context?.statusCode,
      });
    }

    if (message.includes('json') || message.includes('parse') || message.includes('解析')) {
      return new AppError({
        type: ErrorType.PARSE_ERROR,
        originalError: error,
      });
    }

    if (context?.statusCode) {
      return new AppError({
        type: ErrorType.API_ERROR,
        originalError: error,
        statusCode: context.statusCode,
        message: `API 错误 (${context.statusCode}): ${error.message}`,
      });
    }

    return new AppError({
      type: context?.type || ErrorType.UNKNOWN,
      originalError: error,
    });
  }

  // 非错误类型
  return new AppError({
    type: ErrorType.UNKNOWN,
    message: String(error),
  });
}

/**
 * 判断是否为可重试的错误
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }
  return false;
}

/**
 * 判断是否为用户取消错误
 */
export function isCancelledError(error: unknown): boolean {
  if (error instanceof AppError && error.type === ErrorType.CANCELLED) {
    return true;
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return true;
  }
  return false;
}
