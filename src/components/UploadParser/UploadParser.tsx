import React, { useState } from 'react';
import { parseDocument, getSupportedFormats } from '../../utils/documentParser';
import { validateFileSize, validateFileType } from '../../utils/validators';
import { logger } from '../../services/logger';

// 最大文件大小 (10MB)
const MAX_FILE_SIZE_MB = 10;

// 定义 Props 类型
interface UploadParserProps {
  setText: (text: string) => void;
}

const UploadParser: React.FC<UploadParserProps> = ({ setText }) => {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [fileSize, setFileSize] = useState<string>('');

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // 重置状态
    setError('');
    setFileName(file.name);
    setFileSize(formatFileSize(file.size));

    logger.info('UploadParser', '开始上传文件', {
      name: file.name,
      size: file.size,
      type: file.type,
    });

    // 1. 验证文件大小
    const sizeValidation = validateFileSize(file, MAX_FILE_SIZE_MB);
    if (!sizeValidation.valid) {
      setError(sizeValidation.error || '文件大小超出限制');
      logger.warn('UploadParser', '文件大小验证失败', { size: file.size });
      return;
    }

    // 2. 验证文件类型
    const supportedFormats = getSupportedFormats();
    const typeValidation = validateFileType(file, supportedFormats);
    if (!typeValidation.valid) {
      setError(typeValidation.error || '不支持的文件格式');
      logger.warn('UploadParser', '文件类型验证失败', { type: file.type });
      return;
    }

    setLoading(true);

    try {
      const { text, format } = await parseDocument(file);

      // 检查解析结果
      if (!text || text.trim().length === 0) {
        throw new Error('文件内容为空或无法提取文本');
      }

      setText(text);
      logger.info('UploadParser', '文件解析成功', {
        format,
        textLength: text.length,
      });
    } catch (err: any) {
      const errorMessage = err.message || '文件解析失败';
      setError(errorMessage);
      setText('');
      logger.error('UploadParser', '文件解析失败', err);
    } finally {
      setLoading(false);
    }

    // 清空 input 以便再次选择同一文件
    event.target.value = '';
  };

  const handleTextPaste = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = event.target.value || '';
    setText(text);
    setFileName('');
    setFileSize('');
    setError('');
  };

  const supportedFormats = getSupportedFormats();

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="p-4 border rounded shadow-md">
      <h2 className="text-lg font-bold mb-4">文档上传与解析</h2>

      {/* 文件上传区域 */}
      <div className="mb-4">
        <label className="block mb-2 text-sm text-gray-600">
          支持格式: {supportedFormats.join(', ')} (最大 {MAX_FILE_SIZE_MB}MB)
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
        <div className="mb-4 p-3 bg-green-50 border border-green-200 rounded">
          <div className="flex items-center gap-2 text-green-700">
            <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
            </svg>
            <div>
              <p className="font-medium">已加载: {fileName}</p>
              {fileSize && <p className="text-xs text-green-600">大小: {fileSize}</p>}
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded text-red-700">
          <div className="flex items-start gap-2">
            <svg className="w-5 h-5 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
            </svg>
            <div className="flex-1">
              <p className="font-medium">文件处理失败</p>
              <p className="text-sm">{error}</p>
            </div>
            <button
              onClick={() => setError('')}
              className="text-red-400 hover:text-red-600"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
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
