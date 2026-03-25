import { createLogger } from './logger';
import { ApiClient, createApiClient } from './apiClient';
import { AppError, ErrorType, createAppError, isCancelledError } from '../utils/errors';
import {
  validateChatResponse,
  validateEmbeddingResponse,
} from '../utils/validators';
import { requestQueue } from './requestQueue';
import { cacheService, CacheService } from './cacheService';
import { parallelLimit, ProgressReporter, processInChunks } from './asyncProcessor';
import {
  contextManager,
  ContextManager,
  estimateTokens,
  countMessagesTokens,
} from './contextManager';

const log = createLogger('RAGService');

// DeepSeek API 配置
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1';

// 对话消息类型
export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// 短期记忆配置
const SHORT_TERM_MEMORY_LIMIT = 6;  // 保留最近 3 轮对话（6 条消息）

// 并发配置
const MAX_CONCURRENT_EMBEDDINGS = 3;  // 同时处理的 embedding 请求数

// 是否使用本地相似度计算（当 Embedding API 不可用时）
let useLocalSimilarity = false;

/**
 * 本地文本向量化（简单词频向量）
 * 当 API embedding 不可用时使用
 */
function textToVector(text: string, vocabulary: Map<string, number>): number[] {
  const words = text.toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);

  const vector = new Array(vocabulary.size).fill(0);

  words.forEach(word => {
    const idx = vocabulary.get(word);
    if (idx !== undefined) {
      vector[idx]++;
    }
  });

  // 归一化
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  return norm > 0 ? vector.map(v => v / norm) : vector;
}

/**
 * 构建词汇表
 */
function buildVocabulary(texts: string[]): Map<string, number> {
  const wordSet = new Set<string>();

  texts.forEach(text => {
    const words = text.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 1); // 过滤单字符

    words.forEach(word => wordSet.add(word));
  });

  const vocabulary = new Map<string, number>();
  let idx = 0;
  wordSet.forEach(word => {
    if (idx < 5000) { // 限制词汇表大小
      vocabulary.set(word, idx++);
    }
  });

  return vocabulary;
}

// 文档块类型
interface DocumentChunk {
  id: string;
  content: string;
  embedding?: number[];
  metadata?: {
    source?: string;
    chunkIndex: number;
  };
}

/**
 * 简单的文本分割器
 */
class SimpleTextSplitter {
  private chunkSize: number;
  private chunkOverlap: number;
  private separators: string[];

  constructor(options: { chunkSize?: number; chunkOverlap?: number; separators?: string[] } = {}) {
    this.chunkSize = options.chunkSize || 500;
    this.chunkOverlap = options.chunkOverlap || 100;
    this.separators = options.separators || ['\n\n', '\n', '。', '！', '？', '.', '!', '?', ' ', ''];
  }

  splitText(text: string): string[] {
    const chunks: string[] = [];
    let currentChunk = '';
    const splits = this.splitBySeparators(text);

    for (const split of splits) {
      if (currentChunk.length + split.length > this.chunkSize) {
        if (currentChunk.length > 0) {
          chunks.push(currentChunk.trim());
          currentChunk = this.getLastNChars(currentChunk, this.chunkOverlap);
        }
      }
      currentChunk += split;
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter(chunk => chunk.length > 0);
  }

  private splitBySeparators(text: string): string[] {
    let result = [text];

    for (const separator of this.separators) {
      const newResult: string[] = [];
      for (const segment of result) {
        if (segment.length <= this.chunkSize) {
          newResult.push(segment);
        } else {
          const parts = segment.split(separator);
          for (let i = 0; i < parts.length; i++) {
            if (i < parts.length - 1) {
              newResult.push(parts[i] + separator);
            } else {
              newResult.push(parts[i]);
            }
          }
        }
      }
      result = newResult;
    }

    return result;
  }

  private getLastNChars(text: string, n: number): string {
    return text.slice(-n);
  }

  createDocuments(texts: string[]): Array<{ pageContent: string; metadata: {} }> {
    const docs: Array<{ pageContent: string; metadata: {} }> = [];

    for (const text of texts) {
      const chunks = this.splitText(text);
      for (const chunk of chunks) {
        docs.push({ pageContent: chunk, metadata: {} });
      }
    }

    return docs;
  }
}

// RAG 服务类
export class RAGService {
  private chunks: DocumentChunk[] = [];
  private splitter: SimpleTextSplitter;
  private apiKey: string;
  private vocabulary: Map<string, number> = new Map();
  private apiClient: ApiClient;
  private conversationHistory: ChatMessage[] = [];  // 短期记忆：对话历史

  constructor() {
    this.splitter = new SimpleTextSplitter({
      chunkSize: 500,
      chunkOverlap: 100,
    });
    this.apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
    this.apiClient = createApiClient({
      defaultTimeout: 30000,
      maxRetries: 3,
    });
    log.debug('RAGService 实例创建', {
      hasApiKey: !!this.apiKey,
      keyPrefix: this.apiKey ? this.apiKey.substring(0, 7) + '...' : 'none'
    });
  }

  /**
   * 检查 API 配置
   */
  checkApiConfig(): { valid: boolean; message: string } {
    if (!this.apiKey) {
      return {
        valid: false,
        message: 'DeepSeek API Key 未配置，请在 .env.local 中设置 VITE_DEEPSEEK_API_KEY',
      };
    }

    if (this.apiKey.length < 20) {
      return {
        valid: false,
        message: 'DeepSeek API Key 格式可能不正确（长度不足）',
      };
    }

    return {
      valid: true,
      message: 'DeepSeek API Key 已配置',
    };
  }

  /**
   * 分割文档为多个块
   */
  async splitDocument(text: string, source?: string): Promise<DocumentChunk[]> {
    log.info('开始分割文档', { textLength: text.length, source });

    if (!text || text.trim().length === 0) {
      log.error('文档内容为空');
      throw new Error('文档内容为空');
    }

    const startTime = Date.now();
    const docs = this.splitter.createDocuments([text]);

    this.chunks = docs.map((doc, index: number) => ({
      id: `chunk_${index}`,
      content: doc.pageContent,
      metadata: {
        source,
        chunkIndex: index,
      },
    }));

    // 构建词汇表（用于本地相似度计算）
    this.vocabulary = buildVocabulary(this.chunks.map(c => c.content));
    log.info('词汇表构建完成', { vocabularySize: this.vocabulary.size });

    const elapsed = Date.now() - startTime;
    log.info('文档分割完成', {
      chunkCount: this.chunks.length,
      elapsedMs: elapsed,
      avgChunkSize: Math.round(text.length / this.chunks.length),
    });

    return this.chunks;
  }

  /**
   * 测试 DeepSeek Embedding API 是否可用
   */
  async testEmbeddingApi(): Promise<{ available: boolean; error?: string }> {
    try {
      const data = await this.apiClient.request<unknown>({
        url: `${DEEPSEEK_API_URL}/embeddings`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: {
          model: 'deepseek-embed',
          input: 'test',
        },
        timeout: 10000,  // 测试时使用较短超时
        retries: 1,      // 测试时只重试一次
      });

      const result = validateEmbeddingResponse(data);
      return { available: result.valid };
    } catch (error: any) {
      if (isCancelledError(error)) {
        return { available: false, error: '测试已取消' };
      }
      return { available: false, error: error.message };
    }
  }

  /**
   * 获取文本的向量嵌入 (DeepSeek API)
   */
  async getEmbedding(text: string): Promise<number[]> {
    log.debug('调用 DeepSeek Embedding API', {
      textLength: text.length,
      preview: text.substring(0, 30) + '...',
    });

    const startTime = Date.now();

    try {
      const data = await this.apiClient.request<unknown>({
        url: `${DEEPSEEK_API_URL}/embeddings`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: {
          model: 'deepseek-embed',
          input: text,
        },
      });

      // 验证响应
      const result = validateEmbeddingResponse(data);
      if (!result.valid || !result.data) {
        throw new AppError({
          type: ErrorType.VALIDATION,
          message: result.error || 'Embedding 响应验证失败',
        });
      }

      const embedding = result.data;
      const elapsed = Date.now() - startTime;

      log.debug('DeepSeek Embedding API 调用成功', {
        elapsedMs: elapsed,
        embeddingDim: embedding.length,
      });

      return embedding;

    } catch (error: any) {
      if (isCancelledError(error)) {
        throw error;  // 取消错误直接抛出
      }

      log.error('DeepSeek Embedding API 调用失败', { error: error.message });
      throw createAppError(error);
    }
  }

  /**
   * 为所有文档块生成向量嵌入（带并发控制和缓存）
   */
  async embedChunks(
    onProgress?: (progress: number, status: string) => void
  ): Promise<{ mode: 'api' | 'local'; message: string }> {
    const total = this.chunks.length;

    log.info('开始生成向量嵌入', { totalChunks: total });

    const progressReporter = new ProgressReporter(200);

    // 先测试 API 是否可用
    if (!useLocalSimilarity) {
      onProgress?.(0, '检测 Embedding API...');
      const testResult = await this.testEmbeddingApi();

      if (!testResult.available) {
        log.warn('DeepSeek Embedding API 不可用，切换到本地模式', testResult);
        useLocalSimilarity = true;
      } else {
        log.info('DeepSeek Embedding API 可用');
      }
    }

    // 使用本地相似度计算
    if (useLocalSimilarity) {
      log.info('使用本地相似度计算模式');
      onProgress?.(10, '使用本地模式生成向量...');

      // 使用分片处理，避免阻塞 UI
      await processInChunks(this.chunks, async (chunk, index) => {
        // 检查缓存
        const cacheKey = await CacheService.embeddingKey(chunk.content);
        const cached = cacheService.get<number[]>(cacheKey);

        if (cached) {
          chunk.embedding = cached;
          log.debug('使用缓存的向量', { chunkId: chunk.id });
        } else {
          chunk.embedding = textToVector(chunk.content, this.vocabulary);
          // 缓存结果
          cacheService.set(cacheKey, chunk.embedding);
        }

        progressReporter.report(index + 1, total, (progress, status) => {
          onProgress?.(10 + Math.round(progress * 0.9), `本地模式: ${status}`);
        });
      }, { chunkSize: 5 });

      log.info('本地向量化完成', { totalChunks: total });
      return {
        mode: 'local',
        message: '使用本地相似度计算（DeepSeek Embedding API 不可用）'
      };
    }

    // 使用 API embedding（带并发控制和请求队列）
    log.info('使用 API embedding 模式', {
      maxConcurrent: MAX_CONCURRENT_EMBEDDINGS,
    });

    let failed = false;
    let completed = 0;

    try {
      await parallelLimit(
        this.chunks,
        MAX_CONCURRENT_EMBEDDINGS,
        async (chunk) => {
          if (failed) return null;

          // 检查缓存
          const cacheKey = await CacheService.embeddingKey(chunk.content);
          const cached = cacheService.get<number[]>(cacheKey);

          if (cached) {
            chunk.embedding = cached;
            log.debug('使用缓存的向量', { chunkId: chunk.id });
            completed++;
            progressReporter.report(completed, total, (progress, status) => {
              onProgress?.(10 + Math.round(progress * 0.9), `API 模式: ${status}`);
            });
            return cached;
          }

          // 通过请求队列发送请求
          const embedding = await requestQueue.add(
            () => this.getEmbedding(chunk.content),
            { priority: 0 }
          );

          chunk.embedding = embedding;
          completed++;

          // 缓存结果
          cacheService.set(cacheKey, embedding);

          progressReporter.report(completed, total, (progress, status) => {
            onProgress?.(10 + Math.round(progress * 0.9), `API 模式: ${status}`);
          });

          return embedding;
        },
        {
          onItemComplete: (_chunk, index, _result) => {
            log.debug(`文档块 ${index + 1}/${total} 完成`);
          },
        }
      );

      log.info('所有文档块向量化完成', { totalChunks: total });
      return {
        mode: 'api',
        message: '使用 DeepSeek Embedding API'
      };

    } catch (error: any) {
      log.error('API embedding 失败，切换到本地模式', error);
      useLocalSimilarity = true;

      // 用本地模式处理
      for (const chunk of this.chunks) {
        chunk.embedding = textToVector(chunk.content, this.vocabulary);
      }

      return {
        mode: 'local',
        message: 'API 失败，已切换到本地相似度计算'
      };
    }
  }

  /**
   * 计算余弦相似度
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 相似度检索
   */
  async similaritySearch(query: string, topK: number = 3): Promise<DocumentChunk[]> {
    log.info('执行相似度检索', { query, topK, useLocalSimilarity });

    if (this.chunks.length === 0) {
      throw new Error('请先加载文档');
    }

    const startTime = Date.now();

    // 根据模式选择向量生成方式
    let queryEmbedding: number[];
    if (useLocalSimilarity) {
      queryEmbedding = textToVector(query, this.vocabulary);
      log.debug('使用本地向量计算查询');
    } else {
      queryEmbedding = await this.getEmbedding(query);
    }

    const similarities = this.chunks.map((chunk) => ({
      chunk,
      similarity: chunk.embedding
        ? this.cosineSimilarity(queryEmbedding, chunk.embedding)
        : 0,
    }));

    similarities.sort((a, b) => b.similarity - a.similarity);
    const results = similarities.slice(0, topK).map((s) => s.chunk);

    log.info('相似度检索完成', {
      elapsedMs: Date.now() - startTime,
      topScores: similarities.slice(0, topK).map(s => s.similarity.toFixed(4)),
    });

    return results;
  }

  /**
   * RAG 问答 (长短记忆联动 + 降级策略 + 成本控制)
   * - 长期记忆：RAG 检索文档相关内容
   * - 短期记忆：最近对话历史
   * - 降级策略：根据系统状态自动降级
   */
  async askQuestion(
    question: string,
    options?: {
      topK?: number;
      onRetrieved?: (chunks: DocumentChunk[]) => void;
      useMemory?: boolean;
      userId?: string;
    }
  ): Promise<string> {
    const startTime = Date.now();

    // 1. 权限校验
    const permissionChecker = contextManager.getPermissionChecker();
    const requestCheck = options?.userId
      ? permissionChecker.checkAndRecordRequest(options.userId)
      : { allowed: true, remaining: 999 };

    if (!requestCheck.allowed) {
      throw new AppError({
        type: ErrorType.API_ERROR,
        message: '今日请求次数已达上限',
        retryable: false,
      });
    }

    // 2. 获取降级配置
    const degradationConfig = contextManager.getDegradationConfig();
    log.info('RAG 问答', {
      question: question.substring(0, 50),
      topK: options?.topK || 3,
      useMemory: options?.useMemory !== false,
      degradationLevel: contextManager.getDegradationLevel(),
      remainingRequests: requestCheck.remaining,
    });

    // 3. 长期记忆：RAG 检索相关文档
    let relevantChunks: DocumentChunk[] = [];

    if (!degradationConfig.skipEmbedding) {
      relevantChunks = await this.similaritySearch(question, options?.topK || 3);
      options?.onRetrieved?.(relevantChunks);
    } else {
      // 降级：使用简单的关键词匹配
      relevantChunks = this.simpleKeywordSearch(question, options?.topK || 3);
      log.warn('使用降级模式：关键词匹配替代向量检索');
    }

    const longTermContext = relevantChunks
      .map((chunk, i) => `[文档段落 ${i + 1}]\n${chunk.content}`)
      .join('\n\n');

    // 4. 根据降级级别调整上下文
    let contextTokens = estimateTokens(longTermContext);

    // 如果超出降级配置的限制，截断上下文
    let finalContext = longTermContext;
    if (contextTokens > degradationConfig.maxTokens * 0.5) {
      // 保留最重要的部分
      const maxChars = Math.floor(degradationConfig.maxTokens * 0.5 * 4);
      finalContext = longTermContext.substring(0, maxChars) + '\n...[上下文已截断]';
      contextTokens = estimateTokens(finalContext);
      log.warn('上下文已截断', {
        originalTokens: estimateTokens(longTermContext),
        truncatedTokens: contextTokens,
        maxTokens: degradationConfig.maxTokens,
      });
    }

    // 5. 构建消息列表
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];

    // 系统提示（根据降级级别调整）
    const systemPrompt = this.getSystemPrompt(degradationConfig.responseMode);
    messages.push({ role: 'system', content: systemPrompt });

    // 6. 获取上下文管理器管理的对话历史
    if (options?.useMemory !== false) {
      const contextResult = await contextManager.getContextForAPI(question, {
        maxTokens: Math.floor(degradationConfig.maxTokens * 0.3),
        includeCore: true,
      });

      // 添加对话历史
      for (const msg of contextResult.messages) {
        messages.push({
          role: msg.role as 'system' | 'user' | 'assistant',
          content: msg.content,
        });
      }

      log.debug('上下文管理器消息', {
        historyItems: contextResult.stats.memoryItems,
        compressedItems: contextResult.stats.compressedItems,
        truncated: contextResult.stats.truncated,
      });
    }

    // 7. 添加当前问题和文档知识
    const userPrompt = degradationConfig.responseMode === 'minimal'
      ? `文档: ${finalContext.substring(0, 500)}\n\n问: ${question}\n\n简短回答:`
      : `【文档知识 - 长期记忆】\n${finalContext}\n\n【当前问题】\n${question}`;

    messages.push({ role: 'user', content: userPrompt });

    // 8. 检查总 Token 数
    const totalTokens = countMessagesTokens(messages);
    const tokenCheck = permissionChecker.checkTokenLimit(totalTokens);

    if (!tokenCheck.allowed) {
      // 进一步压缩
      while (messages.length > 3 && countMessagesTokens(messages) > permissionChecker.getLimits().maxTokensPerRequest) {
        messages.splice(2, 1);  // 移除最早的对话
      }
      log.warn('Token 超限，已压缩消息列表');
    }

    log.debug('消息列表构建完成', {
      messageCount: messages.length,
      estimatedTokens: totalTokens,
    });

    try {
      // 9. 通过请求队列发送请求
      const data = await requestQueue.add(
        () => this.apiClient.request<unknown>({
          url: `${DEEPSEEK_API_URL}/chat/completions`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: {
            model: 'deepseek-chat',
            messages,
            temperature: degradationConfig.responseMode === 'minimal' ? 0.1 : 0.3,
            max_tokens: degradationConfig.responseMode === 'full' ? 2000 : 500,
          },
        }),
        { priority: permissionChecker.getUserLevel() === 'premium' ? 10 : 0 }
      );

      // 验证响应
      const result = validateChatResponse(data);
      if (!result.valid || result.data === undefined) {
        throw new AppError({
          type: ErrorType.VALIDATION,
          message: result.error || 'Chat 响应验证失败',
        });
      }

      const answer = result.data || '无法生成回答';

      // 10. 记录使用情况
      const responseTokens = estimateTokens(answer);
      contextManager.recordUsage(totalTokens, responseTokens);

      // 11. 更新对话历史（短期记忆）
      if (options?.useMemory !== false) {
        // 旧方式
        this.addToConversationHistory('user', question);
        this.addToConversationHistory('assistant', answer);

        // 新方式：使用上下文管理器
        await contextManager.addMessage('user', question, {
          importance: 0.7,
        });
        await contextManager.addMessage('assistant', answer, {
          importance: 0.5,
        });
      }

      // 12. 记录指标
      const metrics = contextManager.getMetrics();
      metrics.recordMetric('latency', Date.now() - startTime);
      metrics.recordMetric('question_tokens', estimateTokens(question));
      metrics.recordMetric('answer_tokens', responseTokens);

      log.info('RAG 问答完成', {
        answerLength: answer.length,
        latencyMs: Date.now() - startTime,
        tokensUsed: totalTokens + responseTokens,
        degradationLevel: contextManager.getDegradationLevel(),
      });

      return answer;

      return answer;

    } catch (error: any) {
      if (isCancelledError(error)) {
        throw error;
      }

      log.error('RAG 问答失败', error);
      throw createAppError(error);
    }
  }

  /**
   * 添加消息到对话历史（短期记忆）
   */
  private addToConversationHistory(role: 'user' | 'assistant', content: string): void {
    this.conversationHistory.push({
      role,
      content,
      timestamp: Date.now(),
    });

    // 保持对话历史在限制内
    while (this.conversationHistory.length > SHORT_TERM_MEMORY_LIMIT) {
      this.conversationHistory.shift();
    }

    log.debug('对话历史更新', {
      total: this.conversationHistory.length,
      limit: SHORT_TERM_MEMORY_LIMIT
    });
  }

  /**
   * 获取对话历史
   */
  getConversationHistory(): ChatMessage[] {
    return [...this.conversationHistory];
  }

  /**
   * 清空对话历史
   */
  clearConversationHistory(): void {
    this.conversationHistory = [];
    contextManager.clearMemory();
    log.info('对话历史已清空');
  }

  /**
   * 根据响应模式获取系统提示
   */
  private getSystemPrompt(mode: 'full' | 'brief' | 'minimal'): string {
    const basePrompt = '你是一个智能文档分析助手。';

    const prompts: Record<typeof mode, string> = {
      full: `${basePrompt}你需要结合文档知识（长期记忆）和对话历史（短期记忆）来回答用户问题。

回答原则：
1. 优先使用【文档知识】中的信息回答
2. 如果文档中没有相关信息，可以参考【对话历史】中的内容
3. 如果都没有相关信息，请明确说明"根据当前文档，我无法回答这个问题"
4. 回答要简洁准确，可以适当引用原文
5. 如果用户追问，要结合之前的对话上下文理解意图`,

      brief: `${basePrompt}根据文档内容简要回答问题。保持回答简洁，不超过100字。如果文档中没有相关信息，请直接说明。`,

      minimal: `${basePrompt}简短回答。`,
    };

    return prompts[mode];
  }

  /**
   * 简单关键词搜索（降级时使用）
   */
  private simpleKeywordSearch(query: string, topK: number): DocumentChunk[] {
    const keywords = query.toLowerCase()
      .replace(/[^\w\u4e00-\u9fa5]/g, ' ')
      .split(/\s+/)
      .filter(k => k.length > 1);

    if (keywords.length === 0) {
      return this.chunks.slice(0, topK);
    }

    // 计算每个块的关键词匹配分数
    const scores = this.chunks.map(chunk => {
      const content = chunk.content.toLowerCase();
      let score = 0;

      for (const keyword of keywords) {
        const matches = (content.match(new RegExp(keyword, 'g')) || []).length;
        score += matches;
      }

      return { chunk, score };
    });

    // 按分数排序
    scores.sort((a, b) => b.score - a.score);

    return scores.slice(0, topK).map(s => s.chunk);
  }

  /**
   * 获取上下文管理器（用于高级操作）
   */
  getContextManager(): ContextManager {
    return contextManager;
  }

  getChunkCount(): number {
    return this.chunks.length;
  }

  getChunks(): DocumentChunk[] {
    return this.chunks;
  }

  clear(): void {
    log.debug('清空文档块和对话历史');
    this.chunks = [];
    this.conversationHistory = [];
  }

  hasDocument(): boolean {
    return this.chunks.length > 0;
  }

  /**
   * 取消所有正在进行的 API 请求
   */
  abort(): void {
    log.info('取消所有 API 请求');
    this.apiClient.abort();
  }
}

export const ragService = new RAGService();
