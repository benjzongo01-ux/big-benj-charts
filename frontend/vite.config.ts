import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * La bibliothèque du graphique ne sélectionne un trait que si le clic tombe à moins de 2 pixels de lui :
 * presque impossible à la souris, impossible au doigt. On élargit cette zone (7 px à la souris, 14 px au doigt),
 * comme sur TradingView.
 */
function wideClickZone(): Plugin {
  return {
    name: 'bbc-zone-de-clic',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('klinecharts') || !code.includes('var DEVIATION = 2;')) return null
      return code.replace(
        'var DEVIATION = 2;',
        "var DEVIATION = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 14 : 7;",
      )
    },
  }
}

// En développement, l'interface (port 5173) relaie les appels vers le serveur Python (port 8000).
export default defineConfig({
  plugins: [wideClickZone(), react()],
  // Sans pré-assemblage, la correction ci-dessus s'applique aussi en développement.
  optimizeDeps: { exclude: ['klinecharts'] },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8000',
      '/ws': { target: 'ws://127.0.0.1:8000', ws: true },
    },
  },
  build: { target: 'es2020', chunkSizeWarningLimit: 900 },
})
