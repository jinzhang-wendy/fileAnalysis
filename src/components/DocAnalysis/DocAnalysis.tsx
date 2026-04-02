import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Card,
  Button,
  Radio,
  Input,
  Progress,
  Tag,
  Space,
  Typography,
  Divider,
  Switch,
  Tooltip,
  Badge,
  Spin,
  Alert,
  message,
} from 'antd';
import {
  FileSearchOutlined,
  ClearOutlined,
  MessageOutlined,
  SettingOutlined,
  CheckCircleOutlined,
} from '@ant-design/icons';
import FlowChart from "../FlowChart/FlowChart";
import { ragService } from "../../services/ragService";
import { logger } from "../../services/logger";
import { apiClient } from "../../services/apiClient";
import { AppError, ErrorType, isCancelledError } from "../../utils/errors";
import {
  validateChatResponse,
  validateFlowchartData,
  extractAndValidateJson,
} from "../../utils/validators";

const { Title, Text, Paragraph } = Typography;

// 分析模式类型
type AnalysisMode = 'flowchart' | 'summary' | 'structure' | 'auto';
// 问答模式类型
type QAMode = 'direct' | 'rag';

// 相关段落类型
interface RelevantChunk {
  content: string;
  chunkIndex: number;
}

// 对话消息类型
interface UIMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  relevantChunks?: RelevantChunk[];
  timestamp: number;
}

const DocAnalysis: React.FC<{ text: string }> = ({ text }) => {
  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [flowData, setFlowData] = useState<{
    nodes: any[];
    edges: any[];
  }>({ nodes: [], edges: [] });
  const [question, setQuestion] = useState('');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('auto');
  const [qaMode, setQaMode] = useState<QAMode>('rag');

  // 对话历史
  const [conversationMessages, setConversationMessages] = useState<UIMessage[]>([]);
  const [useMemory, setUseMemory] = useState(true);

  // RAG 相关状态
  const [ragReady, setRagReady] = useState(false);
  const [ragIndexing, setRagIndexing] = useState(false);
  const [ragProgress, setRagProgress] = useState(0);
  const [ragStatus, setRagStatus] = useState('');
  const [chunkCount, setChunkCount] = useState(0);

  // 错误和日志状态
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[] | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [apiReady, setApiReady] = useState(false);

  // 取消控制器
  const abortControllerRef = useRef<AbortController | null>(null);
  const conversationEndRef = useRef<HTMLDivElement | null>(null);

  // 检查 API 配置
  useEffect(() => {
    const deepseekKey = import.meta.env.VITE_DEEPSEEK_API_KEY;
    const isReady = !!deepseekKey && deepseekKey.length > 10;
    setApiReady(isReady);

    logger.info('DocAnalysis', 'DeepSeek API 配置检查', {
      configured: isReady,
      keyPrefix: deepseekKey ? `${deepseekKey.substring(0, 7)}...` : '未配置',
    });
  }, []);

  // 监听文本变化，重置状态
  useEffect(() => {
    setRagReady(false);
    setRagProgress(0);
    setChunkCount(0);
    setError(null);
    setErrorDetails(null);
    ragService.clear();
    setConversationMessages([]);
    setQuestion('');
    setAnalysisResult(null);
    setFlowData({ nodes: [], edges: [] });
  }, [text]);

  // 自动滚动到最新消息
  useEffect(() => {
    conversationEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [conversationMessages]);

  // 取消当前操作
  const handleCancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    ragService.abort();
    setLoading(false);
    setRagIndexing(false);
    setError('操作已取消');
    logger.info('DocAnalysis', '用户取消操作');
  }, []);

  // 处理错误
  const handleError = useCallback((err: unknown, operation: string) => {
    if (isCancelledError(err)) {
      setError('操作已取消');
      return;
    }

    if (err instanceof AppError) {
      setError(`${operation}失败: ${err.userMessage}`);
      setErrorDetails(err.solutions);
    } else if (err instanceof Error) {
      setError(`${operation}失败: ${err.message}`);
      setErrorDetails(null);
    } else {
      setError(`${operation}失败: 未知错误`);
      setErrorDetails(null);
    }

    logger.error('DocAnalysis', `${operation}失败`, err);
  }, []);

  // 组件卸载时清理
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      ragService.abort();
    };
  }, []);

  // 根据分析模式生成 prompt
  const getPromptByMode = (mode: AnalysisMode): string => {
    const basePrompt = `你是一个智能文档分析助手。请分析用户提供的文档内容。`;

    const modePrompts: Record<AnalysisMode, string> = {
      flowchart: `${basePrompt}
你的任务是提取文档中的流程步骤，生成可以在 React Flow 中渲染的节点和边数据。
请严格按照以下 JSON 格式返回，不要包含其他说明文字：
{
  "nodes": [
    { "id": "1", "label": "开始", "type": "start" },
    { "id": "2", "label": "处理步骤", "type": "process" },
    { "id": "3", "label": "判断条件？", "type": "decision" },
    { "id": "4", "label": "结束", "type": "end" }
  ],
  "edges": [
    { "source": "1", "target": "2" },
    { "source": "2", "target": "3" },
    { "source": "3", "target": "4", "label": "是" },
    { "source": "3", "target": "2", "label": "否" }
  ]
}`,
      summary: `${basePrompt}
你的任务是对文档进行智能摘要分析。请返回以下 JSON 格式：
{
  "title": "文档标题",
  "summary": "文档核心内容摘要（200字以内）",
  "keyPoints": ["要点1", "要点2", "要点3"],
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "documentType": "文档类型"
}`,
      structure: `${basePrompt}
你的任务是分析文档的结构和层级关系。请返回以下 JSON 格式：
{
  "title": "文档标题",
  "sections": [
    {
      "level": 1,
      "title": "章节标题",
      "content": "章节摘要",
      "subsections": []
    }
  ],
  "entities": [
    { "name": "实体名称", "type": "人物/组织/地点/日期/金额等" }
  ]
}`,
      auto: `${basePrompt}
请首先判断文档类型，然后选择最合适的分析方式返回 JSON 格式结果。`
    };

    return modePrompts[mode];
  };

  // 文档分析
  const analyzeDocument = async () => {
    if (!text || text.trim() === '') {
      message.warning('文本内容不能为空！');
      return;
    }

    if (!apiReady) {
      setError('DeepSeek API Key 未配置，请检查 .env.local 文件');
      return;
    }

    abortControllerRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setErrorDetails(null);
    setAnalysisResult(null);
    setFlowData({ nodes: [], edges: [] });

    try {
      const prompt = getPromptByMode(analysisMode);
      const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;

      const data = await apiClient.request<unknown>({
        url: 'https://api.deepseek.com/v1/chat/completions',
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}` },
        body: {
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: text }
          ],
          temperature: 0.1,
        },
        signal: abortControllerRef.current.signal,
      });

      const validationResult = validateChatResponse(data);
      if (!validationResult.valid || validationResult.data === undefined) {
        throw new AppError({
          type: ErrorType.VALIDATION,
          message: validationResult.error || 'API 响应验证失败',
        });
      }

      const content = validationResult.data;
      const result = extractAndValidateJson(content, (data) => ({ valid: true, data }));
      if (!result.valid || !result.data) {
        throw new AppError({
          type: ErrorType.PARSE_ERROR,
          message: '无法从返回内容中提取有效的 JSON 数据',
        });
      }

      const resultJson = result.data as Record<string, unknown>;

      if (resultJson.error) {
        setError(String(resultJson.error));
        return;
      }

      const analysisData = analysisMode === 'auto' ? resultJson.result : resultJson;

      if (analysisData && typeof analysisData === 'object') {
        const analysisObj = analysisData as Record<string, unknown>;
        if (analysisObj.nodes && Array.isArray(analysisObj.nodes)) {
          const flowResult = validateFlowchartData(analysisObj);
          if (flowResult.valid && flowResult.data) {
            const nodes = flowResult.data.nodes.map((node, index) => ({
              id: node.id,
              type: node.type === 'start' ? 'input' :
                    node.type === 'end' ? 'output' :
                    node.type === 'decision' ? 'default' : 'default',
              data: { label: node.label || `节点 ${index + 1}` },
              position: node.position || { x: 100, y: index * 80 },
            }));

            const edges = flowResult.data.edges.map((edge, index) => ({
              id: `e${index + 1}`,
              source: edge.source,
              target: edge.target,
              label: edge.label || '',
              type: 'smoothstep',
            }));

            setFlowData({ nodes, edges });
          }
        }
      }

      if (analysisMode === 'auto' && resultJson.result) {
        setAnalysisResult({
          documentType: resultJson.documentType,
          analysisType: resultJson.analysisType,
          ...(resultJson.result as object),
          rawContent: content
        });
      } else {
        setAnalysisResult({ ...resultJson, rawContent: content });
      }

    } catch (err: any) {
      handleError(err, '文档分析');
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  // 建立 RAG 索引
  const buildRagIndex = async () => {
    if (!text || text.trim() === '') {
      message.warning('文本内容不能为空！');
      return;
    }

    const configCheck = ragService.checkApiConfig();
    if (!configCheck.valid) {
      setError(configCheck.message);
      setErrorDetails(['请确保已在 .env.local 文件中配置 VITE_DEEPSEEK_API_KEY']);
      return;
    }

    setRagIndexing(true);
    setRagProgress(0);
    setRagStatus('初始化...');
    setError(null);
    setErrorDetails(null);

    try {
      setRagStatus('正在分割文档...');
      const chunks = await ragService.splitDocument(text);
      setChunkCount(chunks.length);
      setRagProgress(20);
      setRagStatus(`已分割为 ${chunks.length} 个文档块`);

      setRagStatus('正在生成向量嵌入...');
      const result = await ragService.embedChunks((progress, status) => {
        setRagProgress(20 + Math.round(progress * 0.8));
        setRagStatus(status);
      });

      setRagReady(true);
      setRagStatus(result.mode === 'api' ? '索引完成 (API 模式)' : '索引完成 (本地模式)');
      message.success('索引建立完成');

    } catch (err: any) {
      handleError(err, '建立索引');
      setRagStatus('索引失败');
    } finally {
      setRagIndexing(false);
    }
  };

  // 提问
  const askQuestion = async () => {
    if (!question.trim()) {
      message.warning('请输入问题！');
      return;
    }

    abortControllerRef.current = new AbortController();
    setLoading(true);
    setError(null);
    setErrorDetails(null);

    const userMessageId = `user_${Date.now()}`;
    const assistantMessageId = `assistant_${Date.now()}`;

    setConversationMessages(prev => [...prev, {
      id: userMessageId,
      role: 'user',
      content: question,
      timestamp: Date.now(),
    }]);

    let retrievedChunks: RelevantChunk[] = [];

    try {
      let answer: string;

      if (qaMode === 'rag' && ragReady) {
        answer = await ragService.askQuestion(question, {
          topK: 3,
          useMemory,
          onRetrieved: (chunks) => {
            retrievedChunks = chunks.map((c) => ({
              content: c.content,
              chunkIndex: c.metadata?.chunkIndex || 0,
            }));
          },
        });
      } else {
        if (!apiReady) {
          setError('DeepSeek API Key 未配置');
          setConversationMessages(prev => prev.filter(m => m.id !== userMessageId));
          return;
        }

        const apiKey = import.meta.env.VITE_DEEPSEEK_API_KEY;

        const data = await apiClient.request<unknown>({
          url: 'https://api.deepseek.com/v1/chat/completions',
          method: 'POST',
          headers: { 'Authorization': `Bearer ${apiKey}` },
          body: {
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: '根据以下文档内容回答用户问题：' },
              { role: 'user', content: `文档内容：${text}\n\n问题：${question}` },
            ],
          },
          signal: abortControllerRef.current.signal,
        });

        const validationResult = validateChatResponse(data);
        if (!validationResult.valid || validationResult.data === undefined) {
          throw new AppError({
            type: ErrorType.VALIDATION,
            message: validationResult.error || 'API 响应验证失败',
          });
        }

        answer = validationResult.data;
      }

      setConversationMessages(prev => [...prev, {
        id: assistantMessageId,
        role: 'assistant',
        content: answer,
        relevantChunks: retrievedChunks,
        timestamp: Date.now(),
      }]);

      setQuestion('');

    } catch (err: any) {
      setConversationMessages(prev => prev.filter(m => m.id !== userMessageId));
      handleError(err, '提问');
    } finally {
      setLoading(false);
      abortControllerRef.current = null;
    }
  };

  // 清空对话历史
  const clearConversation = useCallback(() => {
    setConversationMessages([]);
    ragService.clearConversationHistory();
    logger.info('DocAnalysis', '对话历史已清空');
  }, []);

  // 分析模式选项
  const analysisModeOptions = [
    { value: 'auto', label: '智能识别' },
    { value: 'flowchart', label: '流程图' },
    { value: 'summary', label: '内容摘要' },
    { value: 'structure', label: '结构分析' },
  ];

  return (
    <Card
      title={
        <Space>
          <FileSearchOutlined />
          <span>文档分析</span>
        </Space>
      }
      extra={
        <Space>
          <Badge
            status={apiReady ? 'success' : 'error'}
            text={apiReady ? 'DeepSeek API 已连接' : 'API 未配置'}
          />
          <Button
            type="text"
            icon={<SettingOutlined />}
            onClick={() => setShowLogs(!showLogs)}
          >
            {showLogs ? '隐藏日志' : '显示日志'}
          </Button>
        </Space>
      }
    >
      {/* 错误提示 */}
      {error && (
        <Alert
          message="错误"
          description={
            <>
              <Text>{error}</Text>
              {errorDetails && errorDetails.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {errorDetails.map((solution, i) => (
                    <li key={i}>{solution}</li>
                  ))}
                </ul>
              )}
            </>
          }
          type="error"
          closable
          onClose={() => { setError(null); setErrorDetails(null); }}
          style={{ marginBottom: 16 }}
        />
      )}

      {/* 日志面板 */}
      {showLogs && (
        <div style={{
          marginBottom: 16,
          padding: 12,
          background: '#1e1e1e',
          borderRadius: 6,
          maxHeight: 200,
          overflow: 'auto',
          fontFamily: 'monospace',
          fontSize: 12,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: '#888' }}>日志面板</Text>
            <Button size="small" onClick={() => logger.clear()}>清空</Button>
          </div>
          {logger.getRecentLogs(20).map((log, i) => (
            <div key={i} style={{
              color: log.level === 'error' ? '#ff6b6b' :
                     log.level === 'warn' ? '#ffd93d' :
                     log.level === 'info' ? '#6bcfff' : '#888'
            }}>
              <span style={{ color: '#666' }}>[{log.timestamp.split('T')[1].split('.')[0]}]</span>
              <span style={{ color: '#c792ea' }}>[{log.module}]</span>
              {' '}{log.message}
              {log.data && <span style={{ color: '#666' }}> {JSON.stringify(log.data)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 分析模式选择 */}
      <div style={{ marginBottom: 16 }}>
        <Text strong style={{ marginBottom: 8, display: 'block' }}>分析模式：</Text>
        <Radio.Group
          value={analysisMode}
          onChange={(e) => setAnalysisMode(e.target.value)}
          optionType="button"
          buttonStyle="solid"
        >
          {analysisModeOptions.map(opt => (
            <Radio.Button key={opt.value} value={opt.value}>{opt.label}</Radio.Button>
          ))}
        </Radio.Group>
      </div>

      <Space style={{ marginBottom: 16 }}>
        <Button
          type="primary"
          onClick={analyzeDocument}
          loading={loading}
          disabled={!apiReady}
        >
          分析文档
        </Button>
        {loading && (
          <Button danger onClick={handleCancel}>取消</Button>
        )}
      </Space>

      {/* 分析结果 */}
      {analysisResult && !loading && (
        <Card size="small" style={{ marginBottom: 16, background: '#fafafa' }}>
          {analysisResult.documentType && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>文档类型：</Text>
              <Tag color="blue">{analysisResult.documentType}</Tag>
              {analysisResult.analysisType && (
                <Tag color="purple">
                  {analysisResult.analysisType === 'flowchart' ? '流程图分析' :
                   analysisResult.analysisType === 'summary' ? '摘要分析' :
                   analysisResult.analysisType === 'structure' ? '结构分析' : '数据分析'}
                </Tag>
              )}
            </div>
          )}
          {analysisResult.title && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>标题：</Text>
              <Text>{analysisResult.title}</Text>
            </div>
          )}
          {analysisResult.summary && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>摘要：</Text>
              <Paragraph>{analysisResult.summary}</Paragraph>
            </div>
          )}
          {analysisResult.keyPoints && analysisResult.keyPoints.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>要点：</Text>
              <ul style={{ margin: '4px 0', paddingLeft: 20 }}>
                {analysisResult.keyPoints.map((point: string, i: number) => (
                  <li key={i}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {analysisResult.keywords && analysisResult.keywords.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>关键词：</Text>
              <Space wrap>
                {analysisResult.keywords.map((keyword: string, i: number) => (
                  <Tag key={i}>{keyword}</Tag>
                ))}
              </Space>
            </div>
          )}
          {analysisResult.entities && analysisResult.entities.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <Text strong>关键实体：</Text>
              <Space wrap>
                {analysisResult.entities.slice(0, 10).map((entity: any, i: number) => (
                  <Tag key={i} color="orange">{entity.name} ({entity.type})</Tag>
                ))}
              </Space>
            </div>
          )}
        </Card>
      )}

      {/* 流程图展示 */}
      {flowData.nodes.length > 0 && (
        <Card size="small" title="流程图" style={{ marginBottom: 16 }}>
          <FlowChart nodes={flowData.nodes} edges={flowData.edges} />
        </Card>
      )}

      <Divider />

      {/* RAG 智能问答 */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Title level={5} style={{ margin: 0 }}>
            <MessageOutlined style={{ marginRight: 8 }} />
            智能问答 (RAG)
          </Title>
          <Space>
            {ragReady && (
              <Tag icon={<CheckCircleOutlined />} color="success">
                已索引 ({chunkCount} 块)
              </Tag>
            )}
            <Button
              type="primary"
              onClick={buildRagIndex}
              loading={ragIndexing}
              disabled={!text || !apiReady}
            >
              {ragIndexing ? `索引中 ${ragProgress}%` : ragReady ? '重建索引' : '建立索引'}
            </Button>
            {ragIndexing && (
              <Button danger onClick={handleCancel}>取消</Button>
            )}
          </Space>
        </div>

        {/* 索引进度条 */}
        {ragIndexing && (
          <div style={{ marginBottom: 16 }}>
            <Progress percent={ragProgress} status="active" />
            <Text type="secondary">{ragStatus}</Text>
          </div>
        )}

        {/* 问答模式切换 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <Radio.Group
            value={qaMode}
            onChange={(e) => setQaMode(e.target.value)}
            optionType="button"
          >
            <Radio.Button value="rag" disabled={!ragReady}>
              RAG 模式 {!ragReady && '(需先建立索引)'}
            </Radio.Button>
            <Radio.Button value="direct">直接问答</Radio.Button>
          </Radio.Group>

          <Space>
            <Tooltip title="开启后会记住之前的对话内容">
              <Space>
                <Switch checked={useMemory} onChange={setUseMemory} size="small" />
                <Text type="secondary">记忆对话</Text>
              </Space>
            </Tooltip>
            {conversationMessages.length > 0 && (
              <Button type="link" danger onClick={clearConversation}>
                <ClearOutlined /> 清空对话
              </Button>
            )}
          </Space>
        </div>

        {/* 对话历史 */}
        {conversationMessages.length > 0 && (
          <div style={{
            marginBottom: 16,
            maxHeight: 400,
            overflow: 'auto',
            border: '1px solid #f0f0f0',
            borderRadius: 8,
            padding: 12,
            background: '#fafafa'
          }}>
            {conversationMessages.map((msg) => (
              <div
                key={msg.id}
                style={{
                  display: 'flex',
                  justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
                  marginBottom: 8
                }}
              >
                <div style={{
                  maxWidth: '80%',
                  padding: '8px 12px',
                  borderRadius: 8,
                  background: msg.role === 'user' ? '#1890ff' : '#fff',
                  color: msg.role === 'user' ? '#fff' : '#333',
                  border: msg.role === 'user' ? 'none' : '1px solid #e8e8e8'
                }}>
                  {msg.role === 'assistant' && msg.relevantChunks && msg.relevantChunks.length > 0 && (
                    <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #f0f0f0' }}>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        📚 检索到 {msg.relevantChunks.length} 个相关段落
                      </Text>
                    </div>
                  )}
                  <Text style={{ color: 'inherit', whiteSpace: 'pre-wrap' }}>{msg.content}</Text>
                </div>
              </div>
            ))}
            {loading && (
              <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
                <div style={{ padding: '8px 12px', background: '#fff', borderRadius: 8, border: '1px solid #e8e8e8' }}>
                  <Spin size="small" /> <Text type="secondary">思考中...</Text>
                </div>
              </div>
            )}
            <div ref={conversationEndRef} />
          </div>
        )}

        {/* 提问输入 */}
        <Input.Search
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onSearch={askQuestion}
          placeholder={conversationMessages.length === 0 ? '输入问题开始对话...' : '继续提问...'}
          enterButton={loading ? '...' : '发送'}
          loading={loading}
          disabled={loading}
        />

        {useMemory && conversationMessages.length > 0 && (
          <Text type="secondary" style={{ fontSize: 12, marginTop: 8, display: 'block' }}>
            💡 记忆已开启，助手会参考之前的对话上下文
          </Text>
        )}
      </div>
    </Card>
  );
};

export default DocAnalysis;
