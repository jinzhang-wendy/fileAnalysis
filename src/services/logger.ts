/**
 * 日志服务 - 用于调试和监控
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  module: string;
  message: string;
  data?: any;
}

class Logger {
  private logs: LogEntry[] = [];
  private maxLogs = 100;
  private enabled = true;

  /**
   * 记录日志
   */
  log(level: LogLevel, module: string, message: string, data?: any) {
    if (!this.enabled) return;

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      module,
      message,
      data,
    };

    this.logs.push(entry);

    // 保持日志数量限制
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // 控制台输出（带颜色）
    const colors: Record<LogLevel, string> = {
      debug: 'color: gray',
      info: 'color: blue',
      warn: 'color: orange',
      error: 'color: red',
    };

    const prefix = `[${entry.timestamp}] [${module}]`;
    const consoleMethod = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';

    console[consoleMethod](
      `%c${prefix} ${message}`,
      colors[level],
      data !== undefined ? data : ''
    );

    // 错误日志额外处理
    if (level === 'error' && data instanceof Error) {
      console.error('Stack trace:', data.stack);
    }
  }

  debug(module: string, message: string, data?: any) {
    this.log('debug', module, message, data);
  }

  info(module: string, message: string, data?: any) {
    this.log('info', module, message, data);
  }

  warn(module: string, message: string, data?: any) {
    this.log('warn', module, message, data);
  }

  error(module: string, message: string, data?: any) {
    this.log('error', module, message, data);
  }

  /**
   * 获取所有日志
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * 获取最近 N 条日志
   */
  getRecentLogs(count: number = 20): LogEntry[] {
    return this.logs.slice(-count);
  }

  /**
   * 清空日志
   */
  clear() {
    this.logs = [];
  }

  /**
   * 启用/禁用日志
   */
  setEnabled(enabled: boolean) {
    this.enabled = enabled;
  }
}

// 导出单例
export const logger = new Logger();

// 创建模块专用日志器
export function createLogger(module: string) {
  return {
    debug: (message: string, data?: any) => logger.debug(module, message, data),
    info: (message: string, data?: any) => logger.info(module, message, data),
    warn: (message: string, data?: any) => logger.warn(module, message, data),
    error: (message: string, data?: any) => logger.error(module, message, data),
  };
}
