import { createLogger } from './logger';
import { ApiClient, createApiClient } from './apiClient';
import { AppError, ErrorType, createAppError, isCancelledError } from '../utils/errors';
import {
  validateChatResponse,
  validateEmbeddingResponse,
} from '../utils/validators';

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
   * 为所有文档块生成向量嵌入
   */
  async embedChunks(
    onProgress?: (progress: number, status: string) => void
  ): Promise<{ mode: 'api' | 'local'; message: string }> {
    const total = this.chunks.length;

    log.info('开始生成向量嵌入', { totalChunks: total });

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

      for (let i = 0; i < this.chunks.length; i++) {
        const chunk = this.chunks[i];
        chunk.embedding = textToVector(chunk.content, this.vocabulary);

        const progress = Math.round(((i + 1) / total) * 100);
        onProgress?.(10 + Math.round(progress * 0.9), `本地模式: ${i + 1}/${total}`);
      }

      log.info('本地向量化完成', { totalChunks: total });
      return {
        mode: 'local',
        message: '使用本地相似度计算（DeepSeek Embedding API 不可用）'
      };
    }

    // 使用 API embedding
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      const status = `API 模式: 处理第 ${i + 1}/${total} 块...`;

      log.debug(`处理文档块 ${i + 1}/${total}`, {
        chunkId: chunk.id,
        contentLength: chunk.content.length,
      });

      onProgress?.(
        Math.round(((i + 1) / total) * 100),
        status
      );

      try {
        if (!chunk.embedding) {
          chunk.embedding = await this.getEmbedding(chunk.content);
        }
      } catch (error: any) {
        log.error(`文档块 ${chunk.id} 向量化失败，切换到本地模式`, error);
        useLocalSimilarity = true;

        // 重新用本地模式处理所有块
        for (const c of this.chunks) {
          c.embedding = textToVector(c.content, this.vocabulary);
        }

        return {
          mode: 'local',
          message: 'API 失败，已切换到本地相似度计算'
        };
      }
    }

    log.info('所有文档块向量化完成', { totalChunks: total });
    return {
      mode: 'api',
      message: '使用 DeepSeek Embedding API'
    };
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
   * RAG 问答 (长短记忆联动)
   * - 长期记忆：RAG 检索文档相关内容
   * - 短期记忆：最近对话历史
   */
  async askQuestion(
    question: string,
    options?: {
      topK?: number;
      onRetrieved?: (chunks: DocumentChunk[]) => void;
      useMemory?: boolean;  // 是否使用对话记忆
    }
  ): Promise<string> {
    log.info('RAG 问答', { question, topK: options?.topK || 3, useMemory: options?.useMemory !== false });

    // 1. 长期记忆：RAG 检索相关文档
    const relevantChunks = await this.similaritySearch(question, options?.topK || 3);
    options?.onRetrieved?.(relevantChunks);

    const longTermContext = relevantChunks
      .map((chunk, i) => `[文档段落 ${i + 1}]\n${chunk.content}`)
      .join('\n\n');

    log.debug('长期记忆（RAG 检索）', { chunkCount: relevantChunks.length, contextLength: longTermContext.length });

    // 2. 构建消息列表
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      {
        role: 'system',
        content: `你是一个智能文档分析助手。你需要结合文档知识（长期记忆）和对话历史（短期记忆）来回答用户问题。

回答原则：
1. 优先使用【文档知识】中的信息回答
2. 如果文档中没有相关信息，可以参考【对话历史】中的内容
3. 如果都没有相关信息，请明确说明"根据当前文档，我无法回答这个问题"
4. 回答要简洁准确，可以适当引用原文
5. 如果用户追问，要结合之前的对话上下文理解意图`,
      },
    ];

    // 3. 添加短期记忆（对话历史）
    if (options?.useMemory !== false && this.conversationHistory.length > 0) {
      messages.push({
        role: 'user',
        content: `【对话历史 - 短期记忆】
以下是我们的对话记录，请参考上下文理解我的问题：

${this.conversationHistory.map(msg =>
  msg.role === 'user' ? `用户: ${msg.content}` : `助手: ${msg.content}`
).join('\n\n')}`,
      });
    }

    // 4. 添加当前问题和文档知识
    messages.push({
      role: 'user',
      content: `【文档知识 - 长期记忆】
${longTermContext}

【当前问题】
${question}`,
    });

    log.debug('消息列表构建完成', { messageCount: messages.length });

    try {
      const data = await this.apiClient.request<unknown>({
        url: `${DEEPSEEK_API_URL}/chat/completions`,
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: {
          model: 'deepseek-chat',
          messages,
          temperature: 0.3,
        },
      });

      // 验证响应
      const result = validateChatResponse(data);
      if (!result.valid || result.data === undefined) {
        throw new AppError({
          type: ErrorType.VALIDATION,
          message: result.error || 'Chat 响应验证失败',
        });
      }

      const answer = result.data || '无法生成回答';

      // 5. 更新对话历史（短期记忆）
      if (options?.useMemory !== false) {
        this.addToConversationHistory('user', question);
        this.addToConversationHistory('assistant', answer);
      }

      log.info('RAG 问答完成', { answerLength: answer.length, historyLength: this.conversationHistory.length });

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
    log.info('对话历史已清空');
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
