import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config: proxy API calls to the bridge (port 3002) so the frontend can use relative URLs (/polls, /client)
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Only proxy API calls under /api to the bridge. This avoids proxying SPA routes like /client and /server.
    proxy: {
      '/api': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})
