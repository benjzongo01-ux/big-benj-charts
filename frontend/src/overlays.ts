// Outils de dessin : ceux fournis par la bibliothèque + des outils maison (formes, mesure, position…).
import { registerLocale, registerOverlay, type Coordinate, type OverlayFigure, type OverlayTemplate } from 'klinecharts'

import { EXTRA_INDICATORS, EXTRA_TOOLS, registerExtraIndicators, registerExtraTools } from './extras'

const BLUE = '#2962ff'
const GREEN = '#26a69a'
const RED = '#ef5350'
const fill = (color: string, alpha = 0.18): string => {
  const n = parseInt(color.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
const label = (x: number, y: number, text: string, bg: string, align: CanvasTextAlign = 'left'): OverlayFigure => ({
  type: 'text',
  ignoreEvent: true,
  attrs: { x, y, text, align, baseline: 'middle' },
  styles: { color: '#ffffff', backgroundColor: bg, size: 11, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3, borderRadius: 3 },
})
const base = { needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true }

const templates: OverlayTemplate[] = [
  {
    name: 'arrow', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c }) => {
      if (c.length < 2) return []
      const a = Math.atan2(c[1].y - c[0].y, c[1].x - c[0].x)
      const head = (d: number): Coordinate => ({ x: c[1].x - 12 * Math.cos(a + d), y: c[1].y - 12 * Math.sin(a + d) })
      return [
        { type: 'line', attrs: { coordinates: [c[0], c[1]] } },
        { type: 'polygon', ignoreEvent: true, attrs: { coordinates: [c[1], head(0.4), head(-0.4)] }, styles: { style: 'fill', color: BLUE } },
      ]
    },
  },
  {
    name: 'rect', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c }) => c.length < 2 ? [] : [{
      type: 'polygon',
      attrs: { coordinates: [c[0], { x: c[1].x, y: c[0].y }, c[1], { x: c[0].x, y: c[1].y }] },
      styles: { style: 'stroke_fill', color: fill(BLUE), borderColor: BLUE },
    }],
  },
  {
    name: 'circle', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c }) => c.length < 2 ? [] : [{
      type: 'circle',
      attrs: { x: c[0].x, y: c[0].y, r: Math.hypot(c[1].x - c[0].x, c[1].y - c[0].y) },
      styles: { style: 'stroke_fill', color: fill(BLUE), borderColor: BLUE },
    }],
  },
  {
    name: 'triangle', totalStep: 4, ...base,
    createPointFigures: ({ coordinates: c }) => {
      if (c.length < 2) return []
      if (c.length === 2) return [{ type: 'line', attrs: { coordinates: c } }]
      return [{ type: 'polygon', attrs: { coordinates: c }, styles: { style: 'stroke_fill', color: fill(BLUE), borderColor: BLUE } }]
    },
  },
  {
    // Règle : écart de prix, pourcentage et nombre de bougies entre deux points.
    name: 'measure', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, overlay, precision }) => {
      if (c.length < 2) return []
      const [p0, p1] = overlay.points
      const diff = (p1.value ?? 0) - (p0.value ?? 0)
      const pct = p0.value ? (diff / p0.value) * 100 : 0
      const bars = Math.abs((p1.dataIndex ?? 0) - (p0.dataIndex ?? 0))
      const color = diff >= 0 ? GREEN : RED
      return [
        {
          type: 'polygon',
          attrs: { coordinates: [c[0], { x: c[1].x, y: c[0].y }, c[1], { x: c[0].x, y: c[1].y }] },
          styles: { style: 'stroke_fill', color: fill(color), borderColor: color },
        },
        label((c[0].x + c[1].x) / 2, c[1].y + (diff >= 0 ? -14 : 14),
          `${diff >= 0 ? '+' : ''}${diff.toFixed(precision.price)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)} %) · ${bars} bougies`, color, 'center'),
      ]
    },
  },
  {
    // Position : 1er clic = entrée, 2e = stop loss, 3e = objectif. Affiche le ratio risque/rendement.
    name: 'position', totalStep: 4, ...base,
    createPointFigures: ({ coordinates: c, overlay, precision }) => {
      if (c.length < 2) return []
      const pts = overlay.points
      const x0 = c[0].x
      const x1 = Math.max(x0 + 90, ...c.map((p) => p.x))
      const zone = (y: number, color: string): OverlayFigure => ({
        type: 'polygon',
        attrs: { coordinates: [{ x: x0, y: c[0].y }, { x: x1, y: c[0].y }, { x: x1, y }, { x: x0, y }] },
        styles: { style: 'stroke_fill', color: fill(color, 0.22), borderColor: color },
      })
      const entry = pts[0].value ?? 0
      const stop = pts[1].value ?? 0
      const risk = Math.abs(entry - stop)
      const figures: OverlayFigure[] = [zone(c[1].y, RED),
        label(x1, c[1].y, `Stop ${stop.toFixed(precision.price)} (${entry ? ((risk / entry) * 100).toFixed(2) : '0'} %)`, RED, 'right')]
      if (c.length > 2) {
        const target = pts[2].value ?? 0
        const reward = Math.abs(target - entry)
        figures.push(zone(c[2].y, GREEN),
          label(x1, c[2].y, `Objectif ${target.toFixed(precision.price)} (${entry ? ((reward / entry) * 100).toFixed(2) : '0'} %)`, GREEN, 'right'),
          label(x0, c[0].y, `${stop < entry ? 'Achat' : 'Vente'} ${entry.toFixed(precision.price)} · R/R ${risk ? (reward / risk).toFixed(2) : '—'}`, '#434651'))
      }
      return figures
    },
  },
  {
    name: 'textNote', totalStep: 2, ...base, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates: c, overlay }) => c.length < 1 ? [] : [{
      type: 'text',
      attrs: { x: c[0].x, y: c[0].y, text: String(overlay.extendData ?? 'Texte'), align: 'left', baseline: 'bottom' },
      styles: { color: '#ffffff', backgroundColor: BLUE, size: 12, paddingLeft: 6, paddingRight: 6, paddingTop: 4, paddingBottom: 4, borderRadius: 3 },
    }],
  },
  {
    // Ligne d'ordre (entrée, stop, objectif) utilisée par le module de trading. Déplaçable à la souris.
    name: 'tradeLine', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
    createPointFigures: ({ coordinates: c, overlay, bounding }) => {
      if (c.length < 1) return []
      const d = (overlay.extendData ?? {}) as { text?: string; color?: string }
      const color = d.color ?? BLUE
      return [
        { type: 'line', attrs: { coordinates: [{ x: 0, y: c[0].y }, { x: bounding.width, y: c[0].y }] }, styles: { style: 'dashed', color, size: 1 } },
        label(8, c[0].y, d.text ?? '', color),
      ]
    },
  },
]

let done = false
/** Enregistre les outils maison (une seule fois). */
export function registerTools(): void {
  if (done) return
  done = true
  templates.forEach(registerOverlay)
  registerExtraTools()
  registerExtraIndicators()
  registerLocale('fr-FR', {
    time: 'Date : ', open: 'Ouv. : ', high: 'Haut : ', low: 'Bas : ', close: 'Clôt. : ', volume: 'Volume : ',
    change: 'Variation : ', turnover: 'Montant : ',
  })
}

export interface Tool { id: string; label: string; icon: string; hint?: string }
export interface ToolGroup { label: string; icon: string; tools: Tool[] }

/** Catalogue affiché dans la barre de gauche, par catégorie. */
export const TOOL_GROUPS: ToolGroup[] = [
  {
    label: 'Lignes', icon: '╱', tools: [
      { id: 'segment', label: 'Ligne de tendance', icon: '╱', hint: 'Alt+T' },
      { id: 'rayLine', label: 'Rayon', icon: '↗' },
      { id: 'straightLine', label: 'Ligne étendue', icon: '⟋' },
      { id: 'arrow', label: 'Segment fléché', icon: '➚' },
      { id: 'horizontalStraightLine', label: 'Ligne horizontale', icon: '─', hint: 'Alt+H' },
      { id: 'horizontalRayLine', label: 'Rayon horizontal', icon: '╾' },
      { id: 'horizontalSegment', label: 'Segment horizontal', icon: '╌' },
      { id: 'verticalStraightLine', label: 'Ligne verticale', icon: '│', hint: 'Alt+V' },
      { id: 'priceLine', label: 'Ligne de prix', icon: '⎯' },
    ],
  },
  {
    label: 'Canaux', icon: '∥', tools: [
      { id: 'parallelStraightLine', label: 'Canal parallèle', icon: '∥' },
      { id: 'priceChannelLine', label: 'Canal de prix', icon: '⫽' },
    ],
  },
  {
    label: 'Fibonacci', icon: '𝑭', tools: [
      { id: 'fibonacciLine', label: 'Retracement de Fibonacci', icon: '𝑭', hint: 'Alt+F' },
    ],
  },
  {
    label: 'Formes', icon: '▭', tools: [
      { id: 'rect', label: 'Rectangle', icon: '▭' },
      { id: 'circle', label: 'Cercle', icon: '◯' },
      { id: 'triangle', label: 'Triangle', icon: '△' },
    ],
  },
  {
    label: 'Annotations', icon: 'T', tools: [
      { id: 'textNote', label: 'Texte', icon: 'T' },
      { id: 'simpleAnnotation', label: 'Note fléchée', icon: '⚑' },
      { id: 'simpleTag', label: 'Étiquette de prix', icon: '🏷' },
    ],
  },
  {
    label: 'Positions et mesure', icon: '⇅', tools: [
      { id: 'position', label: 'Position achat / vente (entrée, stop, objectif)', icon: '⇅' },
      { id: 'measure', label: 'Règle (prix, %, bougies)', icon: '📏' },
    ],
  },
]

// Outils complémentaires (extras.ts) ajoutés à leur catégorie.
for (const [label, tools] of Object.entries(EXTRA_TOOLS)) {
  const group = TOOL_GROUPS.find((g) => g.label === label)
  if (group) group.tools.push(...tools)
  else TOOL_GROUPS.splice(TOOL_GROUPS.length - 2, 0, { label, icon: tools[0].icon, tools })
}

/** Outils qui demandent un texte à l'utilisateur avant d'être posés. */
export const TEXT_TOOLS = new Set(['textNote', 'simpleAnnotation', 'simpleTag'])

/** Indicateurs : nom affiché + emplacement (sur le prix ou dans une sous-fenêtre). */
export const INDICATORS: { id: string; label: string; main: boolean }[] = [
  { id: 'MA', label: 'Moyennes mobiles (MA)', main: true },
  { id: 'EMA', label: 'Moyennes exponentielles (EMA)', main: true },
  { id: 'SMA', label: 'Moyenne lissée (SMA)', main: true },
  { id: 'BOLL', label: 'Bandes de Bollinger', main: true },
  { id: 'SAR', label: 'Parabolic SAR', main: true },
  { id: 'BBI', label: 'Bull and Bear Index', main: true },
  { id: 'VOL', label: 'Volume', main: false },
  { id: 'MACD', label: 'MACD', main: false },
  { id: 'RSI', label: 'RSI', main: false },
  { id: 'KDJ', label: 'Stochastique (KDJ)', main: false },
  { id: 'CCI', label: 'CCI', main: false },
  { id: 'DMI', label: 'ADX / DMI', main: false },
  { id: 'WR', label: 'Williams %R', main: false },
  { id: 'OBV', label: 'On Balance Volume', main: false },
  { id: 'MTM', label: 'Momentum', main: false },
  { id: 'ROC', label: 'Rate of Change', main: false },
  { id: 'AO', label: 'Awesome Oscillator', main: false },
  { id: 'TRIX', label: 'TRIX', main: false },
  { id: 'BIAS', label: 'BIAS', main: false },
  { id: 'BRAR', label: 'BRAR', main: false },
  { id: 'CR', label: 'CR', main: false },
  { id: 'PSY', label: 'Ligne psychologique', main: false },
  { id: 'DMA', label: 'DMA', main: false },
  { id: 'VR', label: 'Volume Ratio', main: false },
  { id: 'EMV', label: 'Ease of Movement', main: false },
  { id: 'PVT', label: 'Price Volume Trend', main: false },
  { id: 'AVP', label: 'Prix moyen', main: false },
]
INDICATORS.push(...EXTRA_INDICATORS)
INDICATORS.sort((a, b) => Number(b.main) - Number(a.main) || a.label.localeCompare(b.label, 'fr'))

// ---------------------------------------------------------------- barre de gauche et favoris
// Les canaux sont rangés avec les lignes pour alléger la barre.
const canaux = TOOL_GROUPS.findIndex((g) => g.label === 'Canaux')
if (canaux >= 0) {
  TOOL_GROUPS[0].tools.push(...TOOL_GROUPS[canaux].tools)
  TOOL_GROUPS.splice(canaux, 1)
}

// Emoji posé sur le graphique (le caractère choisi est gardé dans extendData).
templates.push({
  name: 'emoji', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ coordinates: c, overlay }) => c.length < 1 ? [] : [{
    type: 'text',
    attrs: { x: c[0].x, y: c[0].y, text: String(overlay.extendData ?? '🙂'), align: 'center', baseline: 'middle' },
    styles: { size: 26, backgroundColor: 'transparent', color: '#ffffff', paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
  }],
})

export const EMOJIS = ['🙂', '😎', '🤔', '😱', '🚀', '🔥', '💰', '💎', '✅', '❌', '⚠️', '⭐', '🎯', '📈', '📉', '🐂', '🐻', '👍', '👎', '❓']

/** Icône SVG de chaque catégorie de la barre de gauche (voir icons.tsx). */
export const GROUP_ICON: Record<string, string> = {
  Lignes: 'line', Fibonacci: 'fib', Formes: 'shape', Annotations: 'text', 'Figures chartistes': 'pattern', 'Positions et mesure': 'ruler',
}

/** Icône SVG des outils courants ; les autres gardent leur symbole texte. */
export const TOOL_ICON: Record<string, string> = {
  segment: 'line', rayLine: 'ray', horizontalStraightLine: 'hline', horizontalRayLine: 'hray', verticalStraightLine: 'vline',
  crossLine: 'cross', rect: 'shape', fibonacciLine: 'fib', fibExtension: 'fibext', parallelStraightLine: 'channel',
  textNote: 'text', measure: 'ruler', position: 'position',
}

/** Favoris proposés au premier lancement (modifiable par clic droit sur un outil). */
export const DEFAULT_FAVORITES = [
  'segment', 'rect', 'fibonacciLine', 'fibExtension', 'parallelStraightLine', 'textNote',
  'rayLine', 'horizontalStraightLine', 'horizontalRayLine', 'crossLine', 'verticalStraightLine',
]

export function findTool(id: string): Tool | undefined {
  for (const g of TOOL_GROUPS) {
    const t = g.tools.find((x) => x.id === id)
    if (t) return t
  }
  return undefined
}
