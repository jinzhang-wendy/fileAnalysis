import React, { useState } from 'react';
import { Layout, Typography, theme } from 'antd';
import UploadParser from './components/UploadParser/UploadParser';
import DocAnalysis from './components/DocAnalysis/DocAnalysis';

const { Header, Content } = Layout;
const { Title } = Typography;

const App: React.FC = () => {
  const [text, setText] = useState<string>('');
  const { token: { colorBgContainer } } = theme.useToken();

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Header style={{
        display: 'flex',
        alignItems: 'center',
        background: colorBgContainer,
        borderBottom: '1px solid #f0f0f0'
      }}>
        <Title level={3} style={{ margin: 0, color: '#1890ff' }}>
          AI 智能文档分析工具
        </Title>
      </Header>
      <Content style={{ padding: '24px 50px' }}>
        <div style={{
          maxWidth: 1200,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 24
        }}>
          <UploadParser setText={setText} />
          <DocAnalysis text={text} />
        </div>
      </Content>
    </Layout>
  );
};

export default App;
