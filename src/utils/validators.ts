/**
 * 数据验证工具
 * 用于验证 API 响应和用户数据格式
 */

// 流程图节点类型
export interface FlowNode {
  id: string;
  label: string;
  type?: 'start' | 'end' | 'process' | 'decision' | 'input' | 'output';
  position?: { x: number; y: number };
}

// 流程图边类型
export interface FlowEdge {
  source: string;
  target: string;
  label?: string;
}

// Chat API 响应类型
interface ChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
  };
}

// Embedding API 响应类型
interface EmbeddingResponse {
  data?: Array<{
    embedding?: number[];
  }>;
  error?: {
    message?: string;
  };
}

/**
 * 验证结果类型
 */
interface ValidationResult<T> {
  valid: boolean;
  data?: T;
  error?: string;
}

/**
 * 验证 Chat API 响应
 */
export function validateChatResponse(response: unknown): ValidationResult<string> {
  if (!response || typeof response !== 'object') {
    return {
      valid: false,
      error: 'API 响应为空或格式错误',
    };
  }

  const data = response as ChatResponse;

  // 检查 API 错误
  if (data.error) {
    return {
      valid: false,
      error: data.error.message || `API 错误: ${data.error.type || '未知'}`,
    };
  }

  // 检查 choices
  if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0) {
    return {
      valid: false,
      error: 'API 响应缺少 choices 字段',
    };
  }

  const content = data.choices[0]?.message?.content;

  if (content === undefined || content === null) {
    return {
      valid: false,
      error: 'API 响应中 message.content 为空',
    };
  }

  return {
    valid: true,
    data: content,
  };
}

/**
 * 验证 Embedding API 响应
 */
export function validateEmbeddingResponse(response: unknown): ValidationResult<number[]> {
  if (!response || typeof response !== 'object') {
    return {
      valid: false,
      error: 'Embedding API 响应为空或格式错误',
    };
  }

  const data = response as EmbeddingResponse;

  // 检查 API 错误
  if (data.error) {
    return {
      valid: false,
      error: data.error.message || 'Embedding API 错误',
    };
  }

  // 检查 data 字段
  if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
    return {
      valid: false,
      error: 'Embedding API 响应缺少 data 字段',
    };
  }

  const embedding = data.data[0]?.embedding;

  if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
    return {
      valid: false,
      error: 'Embedding 数据为空或格式错误',
    };
  }

  // 检查 embedding 是否为数字数组
  const isValidNumbers = embedding.every(v => typeof v === 'number' && !isNaN(v));
  if (!isValidNumbers) {
    return {
      valid: false,
      error: 'Embedding 数据包含非数字值',
    };
  }

  return {
    valid: true,
    data: embedding,
  };
}

/**
 * 验证流程图数据
 */
export function validateFlowchartData(data: unknown): ValidationResult<{
  nodes: FlowNode[];
  edges: FlowEdge[];
}> {
  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      error: '流程图数据为空或格式错误',
    };
  }

  const obj = data as Record<string, unknown>;

  // 检查 nodes
  if (!obj.nodes || !Array.isArray(obj.nodes)) {
    return {
      valid: false,
      error: '流程图数据缺少有效的 nodes 数组',
    };
  }

  // 检查 edges
  if (!obj.edges || !Array.isArray(obj.edges)) {
    return {
      valid: false,
      error: '流程图数据缺少有效的 edges 数组',
    };
  }

  // 验证每个节点
  const validNodes: FlowNode[] = [];
  const nodeIds = new Set<string>();

  for (let i = 0; i < obj.nodes.length; i++) {
    const node = obj.nodes[i];

    if (!node || typeof node !== 'object') {
      continue; // 跳过无效节点
    }

    const nodeObj = node as Record<string, unknown>;

    // 必须有 id
    if (typeof nodeObj.id !== 'string' || !nodeObj.id) {
      continue;
    }

    // 必须有 label
    if (typeof nodeObj.label !== 'string') {
      continue;
    }

    // 有效节点类型
    const validTypes = ['start', 'end', 'process', 'decision', 'input', 'output', undefined];
    if (nodeObj.type && !validTypes.includes(nodeObj.type as string)) {
      nodeObj.type = 'process'; // 默认类型
    }

    nodeIds.add(nodeObj.id);
    validNodes.push({
      id: nodeObj.id,
      label: nodeObj.label,
      type: nodeObj.type as FlowNode['type'],
      position: nodeObj.position as { x: number; y: number },
    });
  }

  if (validNodes.length === 0) {
    return {
      valid: false,
      error: '流程图没有有效的节点',
    };
  }

  // 验证每条边
  const validEdges: FlowEdge[] = [];

  for (let i = 0; i < obj.edges.length; i++) {
    const edge = obj.edges[i];

    if (!edge || typeof edge !== 'object') {
      continue;
    }

    const edgeObj = edge as Record<string, unknown>;

    // source 和 target 必须存在且指向有效节点
    if (typeof edgeObj.source !== 'string' || typeof edgeObj.target !== 'string') {
      continue;
    }

    if (!nodeIds.has(edgeObj.source) || !nodeIds.has(edgeObj.target)) {
      continue; // 跳过指向不存在节点的边
    }

    validEdges.push({
      source: edgeObj.source,
      target: edgeObj.target,
      label: typeof edgeObj.label === 'string' ? edgeObj.label : undefined,
    });
  }

  return {
    valid: true,
    data: {
      nodes: validNodes,
      edges: validEdges,
    },
  };
}

/**
 * 从文本中提取和验证 JSON
 */
export function extractAndValidateJson<T>(
  text: string,
  validator: (data: unknown) => ValidationResult<T>
): ValidationResult<T> {
  if (!text || typeof text !== 'string') {
    return {
      valid: false,
      error: '输入文本为空',
    };
  }

  // 尝试提取 JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      valid: false,
      error: '无法从文本中提取 JSON 数据',
    };
  }

  // 解析 JSON
  let data: unknown;
  try {
    data = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return {
      valid: false,
      error: 'JSON 解析失败: ' + (e instanceof Error ? e.message : '未知错误'),
    };
  }

  // 验证数据
  return validator(data);
}

/**
 * 验证文件大小
 */
export function validateFileSize(file: File, maxSizeMB: number = 10): ValidationResult<File> {
  const maxSizeBytes = maxSizeMB * 1024 * 1024;

  if (file.size > maxSizeBytes) {
    return {
      valid: false,
      error: `文件大小超过限制 (最大 ${maxSizeMB}MB，当前 ${(file.size / 1024 / 1024).toFixed(2)}MB)`,
    };
  }

  return {
    valid: true,
    data: file,
  };
}

/**
 * 验证文件类型
 */
export function validateFileType(
  file: File,
  allowedExtensions: string[]
): ValidationResult<File> {
  const extension = file.name.split('.').pop()?.toLowerCase() || '';

  if (!allowedExtensions.includes(`.${extension}`)) {
    return {
      valid: false,
      error: `不支持的文件格式: .${extension}，支持: ${allowedExtensions.join(', ')}`,
    };
  }

  return {
    valid: true,
    data: file,
  };
}

/**
 * 验证文档分析结果
 */
export function validateAnalysisResult(data: unknown): ValidationResult<{
  documentType?: string;
  analysisType?: string;
  result?: unknown;
  error?: string;
}> {
  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      error: '分析结果为空或格式错误',
    };
  }

  const obj = data as Record<string, unknown>;

  // 检查是否有错误标志
  if (obj.error) {
    return {
      valid: true,
      data: { error: String(obj.error) },
    };
  }

  return {
    valid: true,
    data: {
      documentType: typeof obj.documentType === 'string' ? obj.documentType : undefined,
      analysisType: typeof obj.analysisType === 'string' ? obj.analysisType : undefined,
      result: obj.result,
    },
  };
}

/**
 * 安全地获取嵌套属性
 */
export function safeGet<T>(obj: unknown, path: string, defaultValue: T): T {
  if (!obj || typeof obj !== 'object') {
    return defaultValue;
  }

  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return defaultValue;
    }
    current = (current as Record<string, unknown>)[key];
  }

  return current !== undefined && current !== null ? (current as T) : defaultValue;
}
