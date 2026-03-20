import React from 'react';

// 定义 Props 类型
interface UploadParserProps {
  setText: (text: string) => void;
}

const UploadParser: React.FC<UploadParserProps> = ({ setText }) => {
const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const fileContent = e.target?.result as string;
            setText(fileContent); // 确保设置的是文件内容
        };
        reader.onerror = () => {
            console.error('文件读取失败');
            setText(''); // 如果读取失败，设置为空字符串
        };
        reader.readAsText(file, 'UTF-8');
    }
};

const handleTextPaste = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    setText(event.target.value || ''); // 确保设置的是文本框的值
};

return (
    <div className="p-4 border rounded shadow-md">
      <h2 className="text-lg font-bold mb-4">文档上传与解析</h2>
      <input type="file" accept=".txt,.md" onChange={handleFileUpload} className="mb-4" />
      <textarea
        placeholder="或者直接粘贴文本"
        onChange={handleTextPaste}
        className="w-full h-40 p-2 border rounded"
      />
    </div>
  );
};

export default UploadParser;