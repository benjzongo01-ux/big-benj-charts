import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * La bibliothèque du graphique ne sélectionne un trait que si le clic tombe à moins de 2 pixels de lui :
 * presque impossible à la souris, impossible au doigt. On élargit cette zone (7 px à la souris, 14 px au doigt),
 * comme sur TradingView. Elle corrige aussi une boucle sans fin de l'échelle de prix (voir plus bas).
 */
function wideClickZone(): Plugin {
  return {
    name: 'bbc-zone-de-clic',
    enforce: 'pre',
    transform(code, id) {
      if (!id.includes('klinecharts') || !code.includes('var DEVIATION = 2;')) return null
      const loop = 'while (f <= last) {'
      if (!code.includes(loop)) throw new Error('klinecharts : boucle des graduations introuvable')
      return code
        .replace(
          'var DEVIATION = 2;',
          "var DEVIATION = (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 14 : 7;",
        )
        // Graduations de l'échelle de prix : si l'écart entre deux graduations devient minuscule par rapport
        // au prix, « f += interval » ne fait plus avancer f et la boucle tourne sans fin (page figée).
        .replace(loop, 'while (f <= last && n < 500 && f + interval !== f) {')
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
