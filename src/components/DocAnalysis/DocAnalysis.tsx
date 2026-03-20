import React, { useState } from "react";
import FlowChart from "../FlowChart/FlowChart"; // 引入 FlowChart 组件

const DocAnalysis: React.FC<{ text: string }> = ({ text }) => {
  const [loading, setLoading] = useState(false); // 添加 loading 状态
  const [analysisResult, setAnalysisResult] = useState<any>(null); // 保存分析结果
  const [flowData, setFlowData] = useState<{
    nodes: any[];
    edges: any[];
  }>({ nodes: [], edges: [] }); // 保存流程图数据
  const [question, setQuestion] = useState(''); // 用户输入的问题
  const [answer, setAnswer] = useState(''); // API 返回的回答
  const promt = `你是一个业务流程图生成助手。请分析用户提供的业务文档，提取其中的流程步骤，并生成可以在React Flow中渲染的节点和边数据。
            
请严格按照以下JSON格式返回，不要包含其他说明文字：
{
  "nodes": [
    { "id": "1", "label": "开始", "type": "start" },
    { "id": "2", "label": "输入用户名密码", "type": "process" },
    { "id": "3", "label": "验证通过？", "type": "decision" }
  ],
  "edges": [
    { "source": "1", "target": "2" },
    { "source": "2", "target": "3" },
    { "source": "3", "target": "4", "label": "是" },
    { "source": "3", "target": "5", "label": "否" }
  ]
}

节点类型说明：
- start: 开始节点
- process: 处理节点  
- decision: 决策节点
- end: 结束节点
- input/output: 输入输出节点`;

  const analyzeDocument = async () => {
    if (!text || text.trim() === '') {
      alert('文本内容不能为空！');
      return;
    }

    setLoading(true); // 开始加载
    setAnalysisResult(null); // 清空之前的结果

    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${import.meta.env.VITE_DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'deepseek-chat',
          messages: [
            { role: 'system', content: promt },
            { role: 'user', content: text }
          ],
          temperature: 0.1, // 降低温度，让输出更稳定
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('API 错误详情：', errorData);
        throw new Error(`${response.status} ${errorData.message || 'Unknown error'}`);
      }

      const data = await response.json();
      console.log('API 响应数据：', data); // 打印完整的 API 响应
      // 从API响应中提取content
    const content = data.choices[0]?.message?.content;
    if (!content) {
      throw new Error('API返回的内容为空');
    }
      setAnalysisResult(data); // 保存分析结果

      // 验证 data.nodes 和 data.edges 是否存在
      // if (!data.nodes || !Array.isArray(data.nodes) || !data.edges || !Array.isArray(data.edges)) {
      //   throw new Error('API 返回的数据结构无效，缺少 nodes 或 edges');
      // }

      // const nodes = data.nodes.map((node: any, index: number) => ({
      //   id: `${index + 1}`,
      //   data: { label: node.label || `节点 ${index + 1}` },
      //   position: { x: node.x || 100, y: node.y || index * 100 },
      // }));

      // const edges = data.edges.map((edge: any, index: number) => ({
      //   id: `e${index + 1}`,
      //   source: edge.source,
      //   target: edge.target,
      // }));

      // setFlowData({ nodes, edges });
      // 尝试解析JSON
    try {
      // 有时候AI会在JSON前后加一些说明文字，需要提取JSON部分
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('无法从返回内容中提取JSON');
      }
      
      const flowJson = JSON.parse(jsonMatch[0]);
      console.log('解析后的流程图数据：', flowJson);

      // 验证数据结构
      if (!flowJson.nodes || !Array.isArray(flowJson.nodes) || 
          !flowJson.edges || !Array.isArray(flowJson.edges)) {
        throw new Error('返回的数据结构无效，缺少 nodes 或 edges');
      }

      // 转换为React Flow需要的格式
      const nodes = flowJson.nodes.map((node: any, index: number) => ({
        id: node.id || `${index + 1}`,
        type: node.type === 'start' ? 'input' : 
              node.type === 'end' ? 'output' : 
              node.type === 'decision' ? 'default' : 'default',
        data: { label: node.label || `节点 ${index + 1}` },
        position: node.position || { x: 100, y: index * 80 }, // 提供默认位置
      }));

      const edges = flowJson.edges.map((edge: any, index: number) => ({
        id: `e${index + 1}`,
        source: edge.source,
        target: edge.target,
        label: edge.label || '',
        type: 'smoothstep', // 平滑曲线
      }));

      setFlowData({ nodes, edges });
    } catch (parseError) {
      console.error('JSON解析失败，原始内容：', content);
      throw new Error('无法解析AI返回的流程图数据，请检查输出格式');
    }
    
    } catch (error: any) {
      console.error('分析文档时出错：', error);
      alert(`分析文档时出错：${error.message}`);
    } finally {
      setLoading(false); // 结束加载
    }
  };

  const askQuestion = async () => {
    if (!question.trim()) {
      alert('请输入一个问题！');
      return;
    }

    setLoading(true);
    setAnswer('');

    try {
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
              { role: 'user', content: `文档内容：${text}\n\n问题：${question}` },  // 合并成一条
          ],
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        console.error('API 错误详情：', errorData);
        throw new Error(`${response.status} ${errorData.message || 'Unknown error'}`);
      }

      const data = await response.json();
      setAnswer(data.choices[0].message.content); // 假设回答在此字段中
    } catch (error: any) {
      console.error('提问时出错：', error);
      alert(`提问时出错：${error.message}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="p-4 border rounded shadow-md">
      <h2 className="text-lg font-bold mb-4">文档分析</h2>
      <button
        onClick={analyzeDocument}
        className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600"
      >
        分析文档
      </button>

      {loading && <p className="mt-4 text-blue-500">正在处理，请稍候...</p>}

      {analysisResult && (
        <div className="mt-4">
          <h3 className="font-bold">分析结果：</h3>
          <pre className="whitespace-pre-wrap bg-gray-100 p-2 rounded">
            {JSON.stringify(analysisResult, null, 2)}
          </pre>
        </div>
      )}

      {flowData.nodes.length > 0 && (
        <div className="mt-4">
          <h3 className="font-bold">流程图：</h3>
          <FlowChart nodes={flowData.nodes} edges={flowData.edges} />
        </div>
      )}

      <div className="mt-4">
        <h3 className="font-bold">提问：</h3>
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="请输入您的问题"
          className="w-full p-2 border rounded mb-2"
        />
        <button
          onClick={askQuestion}
          className="px-4 py-2 bg-green-500 text-white rounded hover:bg-green-600"
        >
          提问
        </button>

        {answer && (
          <div className="mt-4">
            <h3 className="font-bold">回答：</h3>
            <p className="whitespace-pre-wrap bg-gray-100 p-2 rounded">{answer}</p>
          </div>
        )}
      </div>
    </div>
  );
};

export default DocAnalysis;