import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    open: true, // 自动打开浏览器
    port: 3000, // 开发服务器端口
  },
});