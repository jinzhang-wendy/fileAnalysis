/**
 * 本地缓存服务
 * 缓存文档解析结果、向量嵌入数据，避免重复计算
 */

import { createLogger } from './logger';

const log = createLogger('CacheService');

// 缓存项
interface CacheItem<T> {
  data: T;
  hash: string;
  createdAt: number;
  expiresAt: number;
  size: number;  // 字节数，用于管理存储空间
}

// 缓存配置
interface CacheConfig {
  defaultTTL: number;      // 默认过期时间（毫秒）
  maxSize: number;         // 最大存储大小（字节）
  storageKey: string;      // localStorage 存储键
}

// 默认配置
const DEFAULT_CONFIG: CacheConfig = {
  defaultTTL: 1000 * 60 * 60 * 24,  // 24 小时
  maxSize: 50 * 1024 * 1024,        // 50MB
  storageKey: 'ai-doc-analyzer-cache',
};

/**
 * 简单的文本哈希函数
 */
async function hashText(text: string): Promise<string> {
  // 使用 SubtleCrypto API 进行 SHA-256 哈希
  const encoder = new TextEncoder();
  const data = encoder.encode(text);

  // 如果 SubtleCrypto 可用，使用它
  if (crypto.subtle) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // 回退到简单哈希
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * 计算文件哈希
 */
async function hashFile(file: File): Promise<string> {
  // 使用文件名 + 大小 + 最后修改时间作为简单哈希
  // 对于更大的准确性，可以读取文件内容计算哈希
  const fileInfo = `${file.name}-${file.size}-${file.lastModified}`;
  return hashText(fileInfo);
}

/**
 * 缓存服务类
 */
export class CacheService {
  private config: CacheConfig;
  private cache: Map<string, CacheItem<unknown>> = new Map();
  private currentSize = 0;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.init();
  }

  /**
   * 初始化缓存，从 localStorage 加载
   */
  private init(): void {
    try {
      const stored = localStorage.getItem(this.config.storageKey);
      if (stored) {
        const data = JSON.parse(stored);
        const now = Date.now();

        // 只加载未过期的项
        for (const [key, item] of Object.entries(data)) {
          const cacheItem = item as CacheItem<unknown>;
          if (cacheItem.expiresAt > now) {
            this.cache.set(key, cacheItem);
            this.currentSize += cacheItem.size;
          }
        }

        log.info('缓存初始化完成', {
          items: this.cache.size,
          sizeMB: (this.currentSize / 1024 / 1024).toFixed(2),
        });
      }
    } catch (error) {
      log.warn('缓存初始化失败，将使用空缓存', { error });
      this.cache = new Map();
    }
  }

  /**
   * 保存缓存到 localStorage
   */
  private persist(): void {
    try {
      const data: Record<string, CacheItem<unknown>> = {};
      this.cache.forEach((item, key) => {
        data[key] = item;
      });
      localStorage.setItem(this.config.storageKey, JSON.stringify(data));
    } catch (error: any) {
      // 可能是存储空间不足
      if (error.name === 'QuotaExceededError') {
        log.warn('存储空间不足，清理部分缓存');
        this.evictOldest();
        this.persist();
      } else {
        log.error('缓存持久化失败', { error: error.message });
      }
    }
  }

  /**
   * 清理最旧的缓存项
   */
  private evictOldest(): void {
    const items = Array.from(this.cache.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt);

    // 清理最旧的 25% 或直到有足够空间
    const toRemove = Math.ceil(items.length * 0.25);

    for (let i = 0; i < toRemove && this.currentSize > this.config.maxSize * 0.5; i++) {
      const [key, item] = items[i];
      this.cache.delete(key);
      this.currentSize -= item.size;
    }

    log.debug('清理旧缓存', { removed: toRemove, newSize: this.currentSize });
  }

  /**
   * 设置缓存
   */
  async set<T>(
    key: string,
    data: T,
    options: {
      ttl?: number;
      hash?: string;
    } = {}
  ): Promise<void> {
    const now = Date.now();
    const ttl = options.ttl || this.config.defaultTTL;

    // 计算数据大小
    const size = this.estimateSize(data);

    // 检查是否需要清理空间
    if (this.currentSize + size > this.config.maxSize) {
      this.evictOldest();
    }

    const item: CacheItem<T> = {
      data,
      hash: options.hash || await hashText(JSON.stringify(data)),
      createdAt: now,
      expiresAt: now + ttl,
      size,
    };

    // 如果已存在，先减去旧大小
    const existing = this.cache.get(key);
    if (existing) {
      this.currentSize -= existing.size;
    }

    this.cache.set(key, item as CacheItem<unknown>);
    this.currentSize += size;

    log.debug('缓存已设置', {
      key,
      sizeKB: (size / 1024).toFixed(2),
      ttlMinutes: ttl / 60000,
    });

    // 异步持久化
    setTimeout(() => this.persist(), 0);
  }

  /**
   * 获取缓存
   */
  get<T>(key: string): T | null {
    const item = this.cache.get(key) as CacheItem<T> | undefined;

    if (!item) {
      return null;
    }

    // 检查是否过期
    if (item.expiresAt < Date.now()) {
      this.cache.delete(key);
      this.currentSize -= item.size;
      log.debug('缓存已过期', { key });
      return null;
    }

    log.debug('缓存命中', { key });
    return item.data;
  }

  /**
   * 检查缓存是否存在
   */
  has(key: string): boolean {
    const item = this.cache.get(key);
    if (!item) return false;

    if (item.expiresAt < Date.now()) {
      this.cache.delete(key);
      this.currentSize -= item.size;
      return false;
    }

    return true;
  }

  /**
   * 删除缓存
   */
  delete(key: string): boolean {
    const item = this.cache.get(key);
    if (item) {
      this.cache.delete(key);
      this.currentSize -= item.size;
      log.debug('缓存已删除', { key });
      setTimeout(() => this.persist(), 0);
      return true;
    }
    return false;
  }

  /**
   * 清空所有缓存
   */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
    localStorage.removeItem(this.config.storageKey);
    log.info('缓存已清空');
  }

  /**
   * 清理过期缓存
   */
  cleanup(): void {
    const now = Date.now();
    let removed = 0;

    this.cache.forEach((item, key) => {
      if (item.expiresAt < now) {
        this.cache.delete(key);
        this.currentSize -= item.size;
        removed++;
      }
    });

    if (removed > 0) {
      log.info('清理过期缓存完成', { removed });
      this.persist();
    }
  }

  /**
   * 获取缓存统计信息
   */
  getStats(): {
    items: number;
    sizeMB: number;
    maxSizeMB: number;
    utilization: number;
  } {
    return {
      items: this.cache.size,
      sizeMB: this.currentSize / 1024 / 1024,
      maxSizeMB: this.config.maxSize / 1024 / 1024,
      utilization: this.currentSize / this.config.maxSize,
    };
  }

  /**
   * 估算数据大小
   */
  private estimateSize(data: unknown): number {
    try {
      return new Blob([JSON.stringify(data)]).size;
    } catch {
      // 如果无法序列化，返回估算值
      return 1024;  // 1KB
    }
  }

  /**
   * 生成文档解析缓存键
   */
  static async docParseKey(file: File): Promise<string> {
    const hash = await hashFile(file);
    return `doc-parse-${hash}`;
  }

  /**
   * 生成向量嵌入缓存键
   */
  static async embeddingKey(text: string): Promise<string> {
    const hash = await hashText(text);
    return `embedding-${hash}`;
  }

  /**
   * 生成文档分块缓存键
   */
  static async chunksKey(text: string): Promise<string> {
    const hash = await hashText(text);
    return `chunks-${hash}`;
  }
}

// 导出单例
export const cacheService = new CacheService();

// 定期清理过期缓存
setInterval(() => {
  cacheService.cleanup();
}, 1000 * 60 * 30);  // 每 30 分钟
