import React, { useState, useEffect } from "react";
import FlowChart from "../FlowChart/FlowChart";
import { ragService } from "../../services/ragService";
import { logger } from "../../services/logger";

// 分析模式类型
type AnalysisMode = 'flowchart' | 'summary' | 'structure' | 'auto';
// 问答模式类型
type QAMode = 'direct' | 'rag';

// 相关段落类型
interface RelevantChunk {
  content: string;
  chunkIndex: number;
}

const DocAnalysis: React.FC<{ text: string }> = ({ text }) => {
  const [loading, setLoading] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<any>(null);
  const [flowData, setFlowData] = useState<{
    nodes: any[];
    edges: any[];
  }>({ nodes: [], edges: [] });
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>('auto');
  const [qaMode, setQaMode] = useState<QAMode>('rag');

  // RAG 相关状态
  const [ragReady, setRagReady] = useState(false);
  const [ragIndexing, setRagIndexing] = useState(false);
  const [ragProgress, setRagProgress] = useState(0);
  const [ragStatus, setRagStatus] = useState('');
  const [chunkCount, setChunkCount] = useState(0);
  const [relevantChunks, setRelevantChunks] = useState<RelevantChunk[]>([]);

  // 错误和日志状态
  const [error, setError] = useState<string | null>(null);
  const [showLogs, setShowLogs] = useState(false);
  const [apiReady, setApiReady] = useState(false);

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
    // 重置 RAG 状态
    setRagReady(false);
    setRagProgress(0);
    setChunkCount(0);
    setRelevantChunks([]);
    setError(null);
    ragService.clear();

    // 重置问答相关状态
    setAnswer('');
    setQuestion('');

    // 重置分析结果
    setAnalysisResult(null);
    setFlowData({ nodes: [], edges: [] });
  }, [text]);

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
}

节点类型说明：
- start: 开始节点（流程起点）
- process: 处理节点（具体操作步骤）
- decision: 决策节点（条件判断，用菱形表示）
- end: 结束节点（流程终点）
- input/output: 输入输出节点（数据输入或输出）

注意：如果文档内容不适合生成流程图，请返回：{"error": "文档内容不包含可识别的流程信息"}`,

      summary: `${basePrompt}

你的任务是对文档进行智能摘要分析。请返回以下 JSON 格式：
{
  "title": "文档标题",
  "summary": "文档核心内容摘要（200字以内）",
  "keyPoints": ["要点1", "要点2", "要点3"],
  "keywords": ["关键词1", "关键词2", "关键词3"],
  "documentType": "文档类型（如：报告、合同、规范、数据表等）"
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

请首先判断文档类型，然后选择最合适的分析方式：

1. 如果是流程类文档（操作指南、审批流程、工作规范等）→ 生成流程图
2. 如果是报告/论文/文章类文档 → 生成摘要和要点
3. 如果是合同/规范类文档 → 提取结构和关键实体
4. 如果是表格数据类文档 → 分析数据特征和统计信息

请返回以下 JSON 格式：
{
  "documentType": "判断出的文档类型",
  "analysisType": "flowchart/summary/structure/data",
  "result": {
    // 根据分析类型返回对应的结果
  }
}`
    };

    return modePrompts[mode];
  };

  // 文档分析
  const analyzeDocument = async () => {
    if (!text || text.trim() === '') {
      setError('文本内容不能为空！');
      return;
    }

    if (!apiReady) {
      setError('DeepSeek API Key 未配置，请检查 .env.local 文件');
      return;
    }

    setLoading(true);
    setError(null);
    setAnalysisResult(null);
    setFlowData({ nodes: [], edges: [] });

    try {
      const prompt = getPromptByMode(analysisMode);

      const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: text }
          ],
          temperature: 0.1,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(`${response.status} ${errorData.message || errorData.error?.message || 'Unknown error'}`);
      }

      const data = await response.json();
      const content = data.choices[0]?.message?.content;
      if (!content) {
        throw new Error('API返回的内容为空');
      }

      setAnalysisResult(data);

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('无法从返回内容中提取JSON');
      }

      const resultJson = JSON.parse(jsonMatch[0]);

      if (resultJson.error) {
        setError(resultJson.error);
        return;
      }

      const analysisData = analysisMode === 'auto' ? resultJson.result : resultJson;

      if (analysisData.nodes && Array.isArray(analysisData.nodes)) {
        const nodes = analysisData.nodes.map((node: any, index: number) => ({
          id: node.id || `${index + 1}`,
          type: node.type === 'start' ? 'input' :
                node.type === 'end' ? 'output' :
                node.type === 'decision' ? 'default' : 'default',
          data: { label: node.label || `节点 ${index + 1}` },
          position: node.position || { x: 100, y: index * 80 },
        }));

        const edges = (analysisData.edges || []).map((edge: any, index: number) => ({
          id: `e${index + 1}`,
          source: edge.source,
          target: edge.target,
          label: edge.label || '',
          type: 'smoothstep',
        }));

        setFlowData({ nodes, edges });
      }

      // 设置分析结果（智能识别模式需要展开 result）
      if (analysisMode === 'auto' && resultJson.result) {
        // 智能识别模式：将 result 的内容展开到顶层，同时保留 documentType 和 analysisType
        setAnalysisResult({
          documentType: resultJson.documentType,
          analysisType: resultJson.analysisType,
          ...resultJson.result,
          rawContent: content
        });
      } else {
        setAnalysisResult({
          ...resultJson,
          rawContent: content
        });
      }

    } catch (err: any) {
      setError(`分析失败: ${err.message}`);
      logger.error('DocAnalysis', '文档分析失败', err);
    } finally {
      setLoading(false);
    }
  };

  // 建立 RAG 索引
  const buildRagIndex = async () => {
    if (!text || text.trim() === '') {
      setError('文本内容不能为空！');
      return;
    }

    // 检查 OpenAI API 配置
    const configCheck = ragService.checkApiConfig();
    if (!configCheck.valid) {
      setError(configCheck.message);
      logger.error('DocAnalysis', 'API 配置检查失败', configCheck);
      return;
    }

    setRagIndexing(true);
    setRagProgress(0);
    setRagStatus('初始化...');
    setError(null);
    setRelevantChunks([]);

    logger.info('DocAnalysis', '开始建立 RAG 索引');

    try {
      // 1. 分割文档
      setRagStatus('正在分割文档...');
      logger.info('DocAnalysis', '开始分割文档', { textLength: text.length });

      const chunks = await ragService.splitDocument(text);
      setChunkCount(chunks.length);
      setRagProgress(20);
      setRagStatus(`已分割为 ${chunks.length} 个文档块`);

      logger.info('DocAnalysis', '文档分割完成', { chunkCount: chunks.length });

      // 2. 生成向量嵌入
      setRagStatus('正在生成向量嵌入...');
      logger.info('DocAnalysis', '开始生成向量嵌入');

      const result = await ragService.embedChunks((progress, status) => {
        setRagProgress(20 + Math.round(progress * 0.8));
        setRagStatus(status);
        logger.debug('DocAnalysis', '嵌入进度', { progress, status });
      });

      setRagReady(true);
      setRagStatus(result.mode === 'api'
        ? '索引完成 (API 模式)'
        : '索引完成 (本地模式)');
      logger.info('DocAnalysis', 'RAG 索引建立完成', {
        chunkCount: chunks.length,
        mode: result.mode,
        message: result.message
      });

    } catch (err: any) {
      setError(`建立索引失败: ${err.message}`);
      setRagStatus('索引失败');
      logger.error('DocAnalysis', '建立 RAG 索引失败', err);
    } finally {
      setRagIndexing(false);
    }
  };

  // 提问
  const askQuestion = async () => {
    if (!question.trim()) {
      setError('请输入问题！');
      return;
    }

    setLoading(true);
    setError(null);
    setAnswer('');
    setRelevantChunks([]);

    try {
      if (qaMode === 'rag' && ragReady) {
        const result = await ragService.askQuestion(question, {
          topK: 3,
          onRetrieved: (chunks) => {
            setRelevantChunks(
              chunks.map((c) => ({
                content: c.content,
                chunkIndex: c.metadata?.chunkIndex || 0,
              }))
            );
          },
        });
        setAnswer(result);
      } else {
        if (!apiReady) {
          setError('DeepSeek API Key 未配置');
          return;
        }

        const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${import.meta.env.VITE_DEEPSEEK_API_KEY}`,
          },
          body: JSON.stringify({
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: '根据以下文档内容回答用户问题：' },
              { role: 'user', content: `文档内容：${text}\n\n问题：${question}` },
            ],
          }),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`${response.status} ${errorData.message || 'Unknown error'}`);
        }

        const data = await response.json();
        setAnswer(data.choices[0].message.content);
      }
    } catch (err: any) {
      setError(`提问失败: ${err.message}`);
      logger.error('DocAnalysis', '提问失败', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded shadow-md">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">文档分析</h2>

        {/* API 状态指示器 */}
        <div className="flex items-center gap-3 text-xs">
          <span className={`flex items-center gap-1 ${apiReady ? 'text-green-600' : 'text-red-500'}`}>
            <span className={`w-2 h-2 rounded-full ${apiReady ? 'bg-green-500' : 'bg-red-500'}`}></span>
            DeepSeek API
          </span>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="text-gray-500 hover:text-gray-700"
          >
            {showLogs ? '隐藏日志' : '显示日志'}
          </button>
        </div>
      </div>

      {/* 错误提示 */}
      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-medium">错误</p>
              <p>{error}</p>
            </div>
          </div>
        </div>
      )}

      {/* 日志面板 */}
      {showLogs && (
        <div className="mb-4 p-3 bg-gray-900 rounded text-xs text-gray-300 max-h-48 overflow-auto font-mono">
          <div className="flex justify-between items-center mb-2">
            <span className="text-gray-500">日志面板</span>
            <button onClick={() => logger.clear()} className="text-gray-500 hover:text-gray-300">
              清空
            </button>
          </div>
          {logger.getRecentLogs(20).map((log, i) => (
            <div key={i} className={`py-0.5 ${
              log.level === 'error' ? 'text-red-400' :
              log.level === 'warn' ? 'text-yellow-400' :
              log.level === 'info' ? 'text-blue-400' : 'text-gray-400'
            }`}>
              <span className="text-gray-500">[{log.timestamp.split('T')[1].split('.')[0]}]</span>
              <span className="text-purple-400">[{log.module}]</span>
              {' '}{log.message}
              {log.data && <span className="text-gray-500"> {JSON.stringify(log.data)}</span>}
            </div>
          ))}
        </div>
      )}

      {/* 分析模式选择 */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-2">分析模式：</label>
        <div className="flex gap-2 flex-wrap">
          {[
            { value: 'auto', label: '智能识别', desc: '自动判断文档类型' },
            { value: 'flowchart', label: '流程图', desc: '提取流程步骤' },
            { value: 'summary', label: '内容摘要', desc: '生成文档摘要' },
            { value: 'structure', label: '结构分析', desc: '分析文档结构' },
          ].map((mode) => (
            <button
              key={mode.value}
              onClick={() => setAnalysisMode(mode.value as AnalysisMode)}
              className={`px-3 py-2 rounded text-sm transition-colors ${
                analysisMode === mode.value
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title={mode.desc}
            >
              {mode.label}
            </button>
          ))}
        </div>
      </div>

      <button
        onClick={analyzeDocument}
        disabled={loading || !apiReady}
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
      >
        {loading ? '分析中...' : '分析文档'}
      </button>

      {loading && (
        <div className="flex items-center text-blue-500 mt-4">
          <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          正在分析文档...
        </div>
      )}

      {/* 分析结果显示 */}
      {analysisResult && !loading && (
        <div className="mt-4">
          <h3 className="font-bold mb-2">分析结果：</h3>
          <div className="bg-gray-100 p-3 rounded text-sm overflow-auto max-h-96">
            {/* 文档类型 */}
            {analysisResult.documentType && (
              <div className="mb-2">
                <span className="font-medium">文档类型：</span>
                <span className="ml-2 px-2 py-1 bg-blue-100 text-blue-700 rounded text-xs">
                  {analysisResult.documentType}
                </span>
                {analysisResult.analysisType && (
                  <span className="ml-1 px-2 py-1 bg-purple-100 text-purple-700 rounded text-xs">
                    {analysisResult.analysisType === 'flowchart' ? '流程图分析' :
                     analysisResult.analysisType === 'summary' ? '摘要分析' :
                     analysisResult.analysisType === 'structure' ? '结构分析' : '数据分析'}
                  </span>
                )}
              </div>
            )}
            {/* 标题 */}
            {analysisResult.title && (
              <div className="mb-2">
                <span className="font-medium">标题：</span>
                <span className="text-gray-700">{analysisResult.title}</span>
              </div>
            )}
            {/* 摘要 */}
            {analysisResult.summary && (
              <div className="mb-2">
                <span className="font-medium">摘要：</span>
                <p className="mt-1 text-gray-700">{analysisResult.summary}</p>
              </div>
            )}
            {/* 要点 */}
            {analysisResult.keyPoints && analysisResult.keyPoints.length > 0 && (
              <div className="mb-2">
                <span className="font-medium">要点：</span>
                <ul className="list-disc list-inside mt-1 text-gray-700">
                  {analysisResult.keyPoints.map((point: string, i: number) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {/* 关键词 */}
            {analysisResult.keywords && analysisResult.keywords.length > 0 && (
              <div className="mb-2">
                <span className="font-medium">关键词：</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {analysisResult.keywords.map((keyword: string, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-gray-200 rounded text-xs">{keyword}</span>
                  ))}
                </div>
              </div>
            )}
            {/* 结构分析 - 章节 */}
            {analysisResult.sections && analysisResult.sections.length > 0 && (
              <div className="mb-2">
                <span className="font-medium">文档结构：</span>
                <div className="mt-1 space-y-1">
                  {analysisResult.sections.map((section: any, i: number) => (
                    <div key={i} className="pl-4 border-l-2 border-gray-300">
                      <span className="font-medium text-gray-700">{section.title}</span>
                      {section.content && (
                        <p className="text-gray-600 text-xs mt-0.5">{section.content}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* 结构分析 - 实体 */}
            {analysisResult.entities && analysisResult.entities.length > 0 && (
              <div className="mb-2">
                <span className="font-medium">关键实体：</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {analysisResult.entities.slice(0, 10).map((entity: any, i: number) => (
                    <span key={i} className="px-2 py-0.5 bg-orange-100 text-orange-700 rounded text-xs">
                      {entity.name} ({entity.type})
                    </span>
                  ))}
                </div>
              </div>
            )}
            {/* 流程图提示 */}
            {analysisResult.analysisType === 'flowchart' && flowData.nodes.length === 0 && (
              <div className="text-gray-500 italic">
                未检测到有效的流程信息
              </div>
            )}
          </div>
        </div>
      )}

      {/* 流程图展示 */}
      {flowData.nodes.length > 0 && (
        <div className="mt-4">
          <h3 className="font-bold mb-2">
            {analysisResult?.analysisType === 'flowchart' ? '业务流程图：' : '流程图：'}
          </h3>
          <FlowChart nodes={flowData.nodes} edges={flowData.edges} />
        </div>
      )}

      {/* RAG 索引区域 */}
      <div className="mt-4 border-t pt-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-bold">智能问答 (RAG)：</h3>
          <div className="flex items-center gap-2">
            {ragReady && (
              <span className="text-sm text-green-600 flex items-center">
                <svg className="w-4 h-4 mr-1" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                已索引 ({chunkCount} 块)
              </span>
            )}
            <button
              onClick={buildRagIndex}
              disabled={ragIndexing || !text || !apiReady}
              className="px-3 py-1.5 text-sm bg-purple-500 text-white rounded hover:bg-purple-600 disabled:bg-gray-400"
            >
              {ragIndexing ? `索引中 ${ragProgress}%` : ragReady ? '重建索引' : '建立索引'}
            </button>
          </div>
        </div>

        {/* 索引进度条 */}
        {ragIndexing && (
          <div className="mb-3">
            <div className="w-full bg-gray-200 rounded-full h-2">
              <div
                className="bg-purple-500 h-2 rounded-full transition-all duration-300"
                style={{ width: `${ragProgress}%` }}
              />
            </div>
            <p className="text-xs text-gray-500 mt-1">{ragStatus}</p>
          </div>
        )}

        {/* 问答模式切换 */}
        <div className="flex gap-2 mb-3">
          <button
            onClick={() => setQaMode('rag')}
            disabled={!ragReady}
            className={`px-3 py-1.5 text-sm rounded ${
              qaMode === 'rag'
                ? 'bg-purple-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            } ${!ragReady ? 'opacity-50 cursor-not-allowed' : ''}`}
          >
            RAG 模式 {!ragReady && '(需先建立索引)'}
          </button>
          <button
            onClick={() => setQaMode('direct')}
            className={`px-3 py-1.5 text-sm rounded ${
              qaMode === 'direct'
                ? 'bg-green-500 text-white'
                : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
            }`}
          >
            直接问答
          </button>
        </div>

        {/* 提问输入 */}
        <div className="flex gap-2">
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && askQuestion()}
            placeholder={qaMode === 'rag' ? '基于文档内容智能检索回答...' : '直接基于全文回答...'}
            className="flex-1 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-purple-500"
          />
          <button
            onClick={askQuestion}
            disabled={loading}
            className="px-4 py-2 bg-purple-500 text-white rounded hover:bg-purple-600 disabled:bg-gray-400"
          >
            {loading ? '回答中...' : '提问'}
          </button>
        </div>

        {/* 相关段落展示 */}
        {relevantChunks.length > 0 && (
          <div className="mt-4">
            <h4 className="text-sm font-medium text-gray-600 mb-2">检索到的相关段落：</h4>
            <div className="space-y-2">
              {relevantChunks.map((chunk, i) => (
                <div
                  key={i}
                  className="p-2 bg-purple-50 border border-purple-200 rounded text-sm"
                >
                  <span className="text-purple-600 font-medium">段落 {chunk.chunkIndex + 1}：</span>
                  <p className="text-gray-700 mt-1 line-clamp-3">{chunk.content}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 回答展示 */}
        {answer && (
          <div className="mt-4">
            <h4 className="text-sm font-medium text-gray-600 mb-2">回答：</h4>
            <p className="whitespace-pre-wrap bg-gray-100 p-3 rounded">{answer}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocAnalysis;
