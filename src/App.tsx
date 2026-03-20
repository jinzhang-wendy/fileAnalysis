import React, { useState } from 'react';
import UploadParser from './components/UploadParser/UploadParser';
import DocAnalysis from './components/DocAnalysis/DocAnalysis';

const App: React.FC = () => {
  // 定义 text 和 setText
  const [text, setText] = useState<string>('');

  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold mb-4">AI 文档分析工具</h1>
      {/* 将 setText 传递给 UploadParser */}
      <UploadParser setText={setText} />
      {/* 将 text 传递给 DocAnalysis */}
      <DocAnalysis text={text} />
    </div>
  );
};

export default App;