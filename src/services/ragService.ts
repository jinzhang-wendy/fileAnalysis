import { createLogger } from './logger';

const log = createLogger('RAGService');

// DeepSeek API 配置
const DEEPSEEK_API_URL = 'https://api.deepseek.com/v1';

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

  constructor() {
    this.splitter = new SimpleTextSplitter({
      chunkSize: 500,
      chunkOverlap: 100,
    });
    this.apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
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
      const response = await fetch(`${DEEPSEEK_API_URL}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-embed',
          input: 'test',
        }),
      });

      const text = await response.text();

      if (!response.ok) {
        return { available: false, error: `HTTP ${response.status}: ${text.substring(0, 100)}` };
      }

      const data = JSON.parse(text);
      if (!data.data || !data.data[0]?.embedding) {
        return { available: false, error: '响应格式不符合预期' };
      }

      return { available: true };
    } catch (error: any) {
      return { available: false, error: error.message };
    }
  }

  /**
   * 获取文本的向量嵌入 (DeepSeek API)
   */
  async getEmbedding(text: string, retries = 3): Promise<number[]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        log.debug(`调用 DeepSeek Embedding API (尝试 ${attempt}/${retries})`, {
          textLength: text.length,
          preview: text.substring(0, 30) + '...',
        });

        const startTime = Date.now();

        const response = await fetch(`${DEEPSEEK_API_URL}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: 'deepseek-embed',
            input: text,
          }),
        });

        // 先获取原始文本响应
        const responseText = await response.text();
        log.debug('API 原始响应', {
          status: response.status,
          statusText: response.statusText,
          bodyLength: responseText.length,
          bodyPreview: responseText.substring(0, 200),
        });

        if (!response.ok) {
          // 尝试解析错误信息
          let errorMsg = `HTTP ${response.status}`;
          try {
            const errorJson = JSON.parse(responseText);
            errorMsg = errorJson.error?.message || errorJson.message || errorMsg;
          } catch {
            errorMsg = responseText.substring(0, 100) || errorMsg;
          }
          throw new Error(errorMsg);
        }

        // 解析 JSON
        let data;
        try {
          data = JSON.parse(responseText);
        } catch (parseError: any) {
          log.error('JSON 解析失败', { responseText: responseText.substring(0, 500) });
          throw new Error('API 返回了非 JSON 格式的响应');
        }

        // 检查数据结构
        if (!data.data || !Array.isArray(data.data) || !data.data[0]?.embedding) {
          log.error('API 响应结构异常', { data: JSON.stringify(data).substring(0, 500) });
          throw new Error('API 响应结构不符合预期，可能 DeepSeek 不支持 embedding API');
        }

        const embedding = data.data[0].embedding;
        const elapsed = Date.now() - startTime;

        log.debug('DeepSeek Embedding API 调用成功', {
          elapsedMs: elapsed,
          embeddingDim: embedding.length,
          model: data.model,
        });

        return embedding;

      } catch (error: any) {
        const errorInfo = {
          message: error.message,
          attempt,
          retries,
        };

        log.error(`DeepSeek Embedding API 调用失败`, errorInfo);

        // 特定错误处理
        if (error.message?.includes('401') || error.message?.includes('Unauthorized')) {
          throw new Error('DeepSeek API Key 无效，请检查配置');
        }
        if (error.message?.includes('404')) {
          throw new Error('DeepSeek Embedding API 不存在，该服务可能不支持 embedding 功能');
        }
        if (error.message?.includes('429') || error.message?.includes('Rate limit')) {
          log.warn('API 限流，等待重试...');
          await this.sleep(1000 * attempt);
          continue;
        }

        // 最后一次尝试失败
        if (attempt === retries) {
          throw new Error(`Embedding API 调用失败: ${error.message}`);
        }

        await this.sleep(500 * attempt);
      }
    }

    throw new Error('Embedding API 调用失败，已达最大重试次数');
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
   * RAG 问答 (使用 DeepSeek Chat API)
   */
  async askQuestion(
    question: string,
    options?: {
      topK?: number;
      onRetrieved?: (chunks: DocumentChunk[]) => void;
    }
  ): Promise<string> {
    log.info('RAG 问答', { question, topK: options?.topK || 3 });

    const relevantChunks = await this.similaritySearch(question, options?.topK || 3);
    options?.onRetrieved?.(relevantChunks);

    const context = relevantChunks
      .map((chunk, i) => `[相关段落 ${i + 1}]\n${chunk.content}`)
      .join('\n\n');

    log.debug('构建的上下文', { contextLength: context.length });

    try {
      const response = await fetch(`${DEEPSEEK_API_URL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            {
              role: 'system',
              content: `你是一个文档分析助手。请根据提供的上下文内容回答用户问题。
要求：
1. 优先使用上下文中的信息回答
2. 如果上下文中没有相关信息，请明确说明
3. 回答要简洁准确
4. 可以适当引用原文`,
            },
            {
              role: 'user',
              content: `上下文：
${context}

问题：${question}`,
            },
          ],
          temperature: 0.3,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`API Error: ${errorData.error?.message || response.status}`);
      }

      const data = await response.json();
      const answer = data.choices[0].message.content || '无法生成回答';

      log.info('RAG 问答完成', { answerLength: answer.length });

      return answer;

    } catch (error: any) {
      log.error('RAG 问答失败', error);
      throw new Error(`问答生成失败: ${error.message}`);
    }
  }

  /**
   * 辅助函数：延迟
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getChunkCount(): number {
    return this.chunks.length;
  }

  getChunks(): DocumentChunk[] {
    return this.chunks;
  }

  clear(): void {
    log.debug('清空文档块');
    this.chunks = [];
  }

  hasDocument(): boolean {
    return this.chunks.length > 0;
  }
}

export const ragService = new RAGService();
