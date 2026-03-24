import React, { useState } from 'react';
import { parseDocument, getSupportedFormats } from '../../utils/documentParser';

// 定义 Props 类型
interface UploadParserProps {
  setText: (text: string) => void;
}

const UploadParser: React.FC<UploadParserProps> = ({ setText }) => {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError('');
    setFileName(file.name);

    try {
      const { text, format } = await parseDocument(file);
      setText(text);
      console.log(`成功解析 ${format} 文件: ${file.name}`);
    } catch (err: any) {
      console.error('文件解析失败:', err);
      setError(err.message || '文件解析失败');
      setText('');
    } finally {
      setLoading(false);
    }
  };

  const handleTextPaste = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value || '');
  };

  const supportedFormats = getSupportedFormats();

  return (
    <div className="p-4 border rounded shadow-md">
      <h2 className="text-lg font-bold mb-4">文档上传与解析</h2>

      {/* 文件上传区域 */}
      <div className="mb-4">
        <label className="block mb-2 text-sm text-gray-600">
          支持格式: {supportedFormats.join(', ')}
        </label>
        <input
          type="file"
          accept={supportedFormats.join(',')}
          onChange={handleFileUpload}
          className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
          disabled={loading}
        />
      </div>

      {/* 状态显示 */}
      {loading && (
        <div className="flex items-center text-blue-500 mb-4">
          <svg className="animate-spin h-5 w-5 mr-2" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
          正在解析文档...
        </div>
      )}

      {fileName && !loading && !error && (
        <div className="text-green-600 mb-4">
          ✓ 已加载: {fileName}
        </div>
      )}

      {error && (
        <div className="text-red-600 mb-4">
          ✗ {error}
        </div>
      )}

      {/* 文本粘贴区域 */}
      <div className="border-t pt-4">
        <label className="block mb-2 text-sm text-gray-600">
          或直接粘贴文本:
        </label>
        <textarea
          placeholder="在此粘贴文本内容..."
          onChange={handleTextPaste}
          className="w-full h-40 p-2 border rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
    </div>
  );
};

export default UploadParser;
