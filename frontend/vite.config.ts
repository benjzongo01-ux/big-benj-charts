import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// En développement, l'interface (port 5173) relaie les appels vers le serveur Python (port 8000).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
})
