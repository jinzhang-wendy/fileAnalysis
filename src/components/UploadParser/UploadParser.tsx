import React, { useState } from 'react';
import {
  Card,
  Upload,
  Input,
  Alert,
  Spin,
  Typography,
  Space,
  message,
} from 'antd';
import { InboxOutlined, FileTextOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { parseDocument, getSupportedFormats } from '../../utils/documentParser';
import { validateFileSize, validateFileType } from '../../utils/validators';
import { logger } from '../../services/logger';

const { Dragger } = Upload;
const { TextArea } = Input;
const { Text } = Typography;

// 最大文件大小 (10MB)
const MAX_FILE_SIZE_MB = 10;

interface UploadParserProps {
  setText: (text: string) => void;
}

const UploadParser: React.FC<UploadParserProps> = ({ setText }) => {
  const [loading, setLoading] = useState(false);
  const [fileName, setFileName] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [fileSize, setFileSize] = useState<string>('');

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const handleFileUpload = async (file: File) => {
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
      return false;
    }

    // 2. 验证文件类型
    const supportedFormats = getSupportedFormats();
    const typeValidation = validateFileType(file, supportedFormats);
    if (!typeValidation.valid) {
      setError(typeValidation.error || '不支持的文件格式');
      logger.warn('UploadParser', '文件类型验证失败', { type: file.type });
      return false;
    }

    setLoading(true);

    try {
      const { text, format } = await parseDocument(file);

      if (!text || text.trim().length === 0) {
        throw new Error('文件内容为空或无法提取文本');
      }

      setText(text);
      message.success(`文件解析成功，共 ${text.length} 个字符`);
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

    return false; // 阻止默认上传行为
  };

  const uploadProps: UploadProps = {
    name: 'file',
    multiple: false,
    accept: getSupportedFormats().join(','),
    beforeUpload: (file) => handleFileUpload(file),
    showUploadList: false,
    disabled: loading,
  };

  const handleTextPaste = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value || '';
    setText(text);
    setFileName('');
    setFileSize('');
    setError('');
  };

  return (
    <Card
      title={
        <Space>
          <FileTextOutlined />
          <span>文档上传与解析</span>
        </Space>
      }
    >
      {loading && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <Spin tip="正在解析文档..." />
        </div>
      )}

      {error && (
        <Alert
          message="文件处理失败"
          description={error}
          type="error"
          closable
          onClose={() => setError('')}
          style={{ marginBottom: 16 }}
        />
      )}

      {fileName && !loading && !error && (
        <Alert
          message={
            <Space>
              <span>已加载: {fileName}</span>
              {fileSize && <Text type="secondary">(大小: {fileSize})</Text>}
            </Space>
          }
          type="success"
          style={{ marginBottom: 16 }}
        />
      )}

      <Dragger {...uploadProps} style={{ marginBottom: 16 }}>
        <p className="ant-upload-drag-icon">
          <InboxOutlined />
        </p>
        <p className="ant-upload-text">点击或拖拽文件到此区域上传</p>
        <p className="ant-upload-hint">
          支持格式: {getSupportedFormats().join(', ')} (最大 {MAX_FILE_SIZE_MB}MB)
        </p>
      </Dragger>

      <div style={{ marginTop: 16 }}>
        <Text type="secondary" style={{ marginBottom: 8, display: 'block' }}>
          或直接粘贴文本:
        </Text>
        <TextArea
          placeholder="在此粘贴文本内容..."
          onChange={handleTextPaste}
          rows={6}
          disabled={loading}
        />
      </div>
    </Card>
  );
};

export default UploadParser;
