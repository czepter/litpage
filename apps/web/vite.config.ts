import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.NC_API ?? 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': api,
      '/files': api,
      
      '^/v1/': api,
      // MCP and its OAuth server (apps/server/src/ai/mcpOAuth.ts)
      '^/mcp$': api,
      '/oauth/': api,
      '/.well-known/oauth-': api,
      '/ws': { target: api.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: { target: 'es2023', sourcemap: true, chunkSizeWarningLimit: 4000 },
  test: { environment: 'jsdom' },
} as any);
