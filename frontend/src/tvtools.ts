// Outils de dessin « comme sur TradingView » : propriétés par dessin (couleur, opacité, épaisseur, style de trait,
// texte, prolongements, visibilité par unité de temps), ligne de tendance complète, chemin, positions longue et courte.
import {
  registerOverlay,
  type Coordinate, type KLineData, type OverlayCreate, type OverlayFigure, type OverlayTemplate,
} from 'klinecharts'

export type Dash = 'solid' | 'dashed' | 'dotted'

/** Toutes les propriétés modifiables d'un dessin (enregistrées avec lui). */
export interface DrawProps {
  color: string          // couleur principale (#rrggbb)
  opacity: number        // 0 à 1
  size: number           // épaisseur en pixels
  dash?: Dash
  textColor?: string
  fontSize?: number
  bold?: boolean
  italic?: boolean
  text?: string          // texte affiché sur une ligne
  vAlign?: 'top' | 'middle' | 'bottom'
  hAlign?: 'left' | 'center' | 'right'
  extendLeft?: boolean
  extendRight?: boolean
  middle?: boolean       // point médian
  priceLabels?: boolean  // étiquettes de prix aux extrémités
  hideOn?: string[]      // unités de temps où le dessin est masqué
  hidden?: boolean
  lock?: boolean
  z?: number
  // Positions longue et courte
  targetColor?: string
  stopColor?: string
  account?: number
  risk?: number          // % du compte risqué
}

export const DEFAULT_PROPS: DrawProps = { color: '#2962ff', opacity: 1, size: 2, dash: 'solid' }
export const POSITION_TOOLS = new Set(['longPosition', 'shortPosition'])
/** Outils dont le texte se saisit directement sur le graphique. */
export const INLINE_TEXT_TOOLS = new Set(['textNote'])
/** Outils dont la ligne peut être prolongée et porter un texte. */
export const LINE_TOOLS = new Set(['segment'])

/** Propriétés de chaque dessin affiché, lues par les gabarits de dessin au moment du rendu. */
export const drawProps = new Map<string, DrawProps>()
/** Bougies du graphique qui porte chaque dessin (pour le résultat des positions). */
export const drawData = new Map<string, () => KLineData[]>()
/** Dessins sélectionnés : les positions n'affichent leurs textes (montants, stop, cible) que dans ce cas. */
export const selectedDrawings = new Set<string>()

export function rgba(hex: string, alpha = 1): string {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex
  const n = parseInt(hex.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
export const dashValue = (dash: Dash | undefined, size: number): number[] =>
  dash === 'dotted' ? [Math.max(1, size), Math.max(2, size * 2)] : dash === 'dashed' ? [size * 4, size * 3] : [0, 0]
const lineType = (dash?: Dash): string => (dash && dash !== 'solid' ? 'dashed' : 'solid')
const font = (p: DrawProps): string => `${p.italic ? 'italic ' : ''}${p.bold ? 'bold' : 'normal'}`

/** Styles pour les outils de la bibliothèque (lignes horizontales, Fibonacci, canaux…). */
export function libraryStyles(name: string, p: DrawProps): OverlayCreate['styles'] {
  const color = rgba(p.color, p.opacity)
  const line = { color, size: p.size, style: lineType(p.dash), dashedValue: dashValue(p.dash, p.size) }
  const shape = { color: rgba(p.color, 0.15 * p.opacity), borderColor: color, borderSize: p.size, borderStyle: lineType(p.dash), borderDashedValue: dashValue(p.dash, p.size) }
  const text = name === 'simpleAnnotation' || name === 'simpleTag' ? { backgroundColor: color } : { color: rgba(p.textColor ?? p.color, 1) }
  return { line, polygon: shape, circle: shape, rect: shape, arc: line, text } as OverlayCreate['styles']
}

/** Applique les propriétés d'un dessin aux figures des outils maison (rectangle, flèches, Gann…). */
export function applyProps(id: string, figures: OverlayFigure | OverlayFigure[], fill: boolean): OverlayFigure[] {
  const list = Array.isArray(figures) ? figures : [figures]
  const p = drawProps.get(id)
  if (!p) return list
  const color = rgba(p.color, p.opacity)
  return list.map((f): OverlayFigure => {
    const s = (f.styles ?? {}) as Record<string, unknown>
    if (f.type === 'line') return { ...f, styles: { ...s, color, size: p.size, style: lineType(p.dash), dashedValue: dashValue(p.dash, p.size) } }
    if (f.type === 'text') return s.backgroundColor && s.backgroundColor !== 'transparent' ? { ...f, styles: { ...s, backgroundColor: color } } : f
    if (!fill) return f
    return {
      ...f,
      styles: {
        ...s, borderColor: color, borderSize: p.size, borderStyle: lineType(p.dash), borderDashedValue: dashValue(p.dash, p.size),
        color: s.style === 'fill' ? color : rgba(p.color, 0.15 * p.opacity),
      },
    }
  })
}

// ---------------------------------------------------------------- outils
const base = { needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true }
const fmtPrice = (v: number, d: number): string => v.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })

const tag = (x: number, y: number, text: string, bg: string, align: CanvasTextAlign = 'center', baseline: CanvasTextBaseline = 'middle'): OverlayFigure => ({
  type: 'text', ignoreEvent: true,
  attrs: { x, y, text, align, baseline },
  styles: { color: '#ffffff', backgroundColor: bg, size: 11, paddingLeft: 5, paddingRight: 5, paddingTop: 3, paddingBottom: 3, borderRadius: 3 },
})

/** Prolonge la droite a -> b jusqu'aux bords du graphique (vers b, puis vers a). */
function extend(a: Coordinate, b: Coordinate, w: number, h: number, left: boolean, right: boolean): [Coordinate, Coordinate] {
  const toEdge = (from: Coordinate, to: Coordinate): Coordinate => {
    if (to.x === from.x) return { x: from.x, y: to.y > from.y ? h : 0 }
    const x = to.x > from.x ? w : 0
    return { x, y: from.y + ((to.y - from.y) / (to.x - from.x)) * (x - from.x) }
  }
  const [l, r] = a.x <= b.x ? [a, b] : [b, a]
  return [left ? toEdge(r, l) : l, right ? toEdge(l, r) : r]
}

/** Texte d'un dessin, aligné comme dans les réglages (au-dessus, au milieu ou en dessous de la ligne). */
function lineText(p: DrawProps, a: Coordinate, b: Coordinate): OverlayFigure[] {
  if (!p.text) return []
  const h = p.hAlign ?? 'center'
  const v = p.vAlign ?? 'top'
  const anchor = h === 'left' ? (a.x <= b.x ? a : b) : h === 'right' ? (a.x <= b.x ? b : a) : { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
  const size = p.fontSize ?? 14
  return p.text.split('\n').map((line, i, all): OverlayFigure => ({
    type: 'text', ignoreEvent: true,
    attrs: {
      x: anchor.x, y: anchor.y + (v === 'top' ? -6 - (all.length - 1 - i) * (size + 2) : v === 'bottom' ? 6 + i * (size + 2) : (i - (all.length - 1) / 2) * (size + 2)),
      text: line, align: h, baseline: v === 'top' ? 'bottom' : v === 'bottom' ? 'top' : 'middle',
    },
    styles: { color: p.textColor ?? p.color, size, weight: font(p), backgroundColor: 'transparent', paddingLeft: 0, paddingRight: 0, paddingTop: 0, paddingBottom: 0 },
  }))
}

const trendLine: OverlayTemplate = {
  name: 'segment', totalStep: 3, ...base,
  createPointFigures: ({ overlay, coordinates: c, bounding, precision }) => {
    if (c.length < 2) return []
    const p = drawProps.get(overlay.id) ?? DEFAULT_PROPS
    const [a, b] = extend(c[0], c[1], bounding.width, bounding.height, !!p.extendLeft, !!p.extendRight)
    const color = rgba(p.color, p.opacity)
    const figures: OverlayFigure[] = [{
      type: 'line', attrs: { coordinates: [a, b] },
      styles: { color, size: p.size, style: lineType(p.dash), dashedValue: dashValue(p.dash, p.size) },
    }]
    if (p.middle) figures.push({ type: 'circle', ignoreEvent: true, attrs: { x: (c[0].x + c[1].x) / 2, y: (c[0].y + c[1].y) / 2, r: 3 }, styles: { style: 'fill', color } })
    if (p.priceLabels) {
      overlay.points.slice(0, 2).forEach((pt, i) => {
        if (pt.value !== undefined) figures.push(tag(c[i].x, c[i].y - 12, fmtPrice(pt.value, precision.price), color))
      })
    }
    return [...figures, ...lineText(p, c[0], c[1])]
  },
}

/** Chemin : un clic par point, double-clic pour terminer. Une flèche marque la fin. */
function pathFigures({ overlay, coordinates: c }: { overlay: { id: string }; coordinates: Coordinate[] }): OverlayFigure[] {
  if (c.length < 2) return []
  const p = drawProps.get(overlay.id) ?? DEFAULT_PROPS
  const color = rgba(p.color, p.opacity)
  const last = c[c.length - 1]
  const prev = c[c.length - 2]
  const ang = Math.atan2(last.y - prev.y, last.x - prev.x)
  const head = (d: number): Coordinate => ({ x: last.x - 10 * Math.cos(ang + d), y: last.y - 10 * Math.sin(ang + d) })
  return [
    { type: 'line', attrs: { coordinates: c }, styles: { color, size: p.size, style: lineType(p.dash), dashedValue: dashValue(p.dash, p.size) } },
    { type: 'line', ignoreEvent: true, attrs: { coordinates: [head(0.45), last, head(-0.45)] }, styles: { color, size: p.size, style: 'solid' } },
  ]
}
export const PATH_MAX = 60
const path: OverlayTemplate = { name: 'path', totalStep: PATH_MAX, ...base, createPointFigures: pathFigures }
const pathCache = new Set<number>()
/** Nom du gabarit pour réafficher un chemin terminé de n points (un gabarit par nombre de points). */
export function pathName(n: number): string {
  if (!pathCache.has(n)) {
    pathCache.add(n)
    registerOverlay({ name: `path_${n}`, totalStep: n + 1, ...base, createPointFigures: pathFigures })
  }
  return `path_${n}`
}

/** Texte posé d'un clic et saisi directement sur le graphique. */
const textNote: OverlayTemplate = {
  name: 'textNote', totalStep: 2, ...base, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
  createPointFigures: ({ overlay, coordinates: c }) => {
    if (c.length < 1) return []
    const p = drawProps.get(overlay.id) ?? { ...DEFAULT_PROPS, textColor: '#2962ff' }
    const text = String(overlay.extendData ?? '')
    const size = p.fontSize ?? 14
    const lines = (text || ' ').split('\n')
    return lines.map((line, i): OverlayFigure => ({
      type: 'text',
      attrs: { x: c[0].x, y: c[0].y + i * (size + 3), text: line || ' ', align: 'left', baseline: 'middle' },
      styles: { color: p.textColor ?? p.color, size, weight: font(p), backgroundColor: 'transparent', paddingLeft: 2, paddingRight: 2, paddingTop: 2, paddingBottom: 2 },
    }))
  },
}

// ---------------------------------------------------------------- positions longue et courte
// Points : 0 = entrée (coin gauche), 1 = bord droit (largeur), 2 = cible, 3 = stop.
interface PositionResult { pnl: number; closed: boolean; qty: number }

function positionResult(id: string, side: 1 | -1, entry: number, target: number, stop: number, i0: number, i1: number, qty: number): PositionResult {
  const bars = drawData.get(id)?.() ?? []
  const end = Math.min(Math.floor(i1), bars.length - 1)
  let last: number | null = null
  for (let i = Math.max(0, Math.floor(i0) + 1); i <= end; i++) {
    const b = bars[i]
    const hitStop = side === 1 ? b.low <= stop : b.high >= stop
    const hitTarget = side === 1 ? b.high >= target : b.low <= target
    if (hitStop) return { pnl: -Math.abs(entry - stop) * qty, closed: true, qty } // les deux dans la même bougie : stop retenu (prudent)
    if (hitTarget) return { pnl: Math.abs(target - entry) * qty, closed: true, qty }
    last = b.close
  }
  return { pnl: last === null ? 0 : (last - entry) * side * qty, closed: false, qty }
}

function positionTemplate(name: 'longPosition' | 'shortPosition'): OverlayTemplate {
  const side: 1 | -1 = name === 'longPosition' ? 1 : -1
  return {
    name, totalStep: 2, ...base,
    createPointFigures: ({ overlay, coordinates: c, precision }) => {
      const pts = overlay.points
      if (c.length < 4 || pts.length < 4) return []
      const p = drawProps.get(overlay.id) ?? DEFAULT_PROPS
      const d = precision.price
      const tick = Math.pow(10, -d)
      const x0 = c[0].x
      const x1 = Math.max(c[1].x, x0 + 8)
      const yE = c[0].y
      const yT = c[2].y
      const yS = c[3].y
      const entry = pts[0].value ?? 0
      const target = pts[2].value ?? 0
      const stop = pts[3].value ?? 0
      const reward = Math.abs(target - entry)
      const risk = Math.abs(entry - stop)
      const account = p.account ?? 1000
      const riskAmount = (account * (p.risk ?? 25)) / 100
      const rawQty = risk > 0 ? riskAmount / risk : 0
      const qty = rawQty >= 1 ? Math.floor(rawQty) : Math.floor(rawQty * 1000) / 1000
      const rr = risk > 0 ? reward / risk : 0
      const res = positionResult(overlay.id, side, entry, target, stop, pts[0].dataIndex ?? 0, pts[1].dataIndex ?? 0, qty)
      const green = p.targetColor ?? '#26a69a'
      const red = p.stopColor ?? '#ef5350'
      const pct = (v: number): string => (entry ? ((v / entry) * 100).toFixed(3).replace('.', ',') : '0')
      const box = (y: number, color: string): OverlayFigure => ({
        type: 'polygon',
        attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }, { x: x1, y }, { x: x0, y }] },
        styles: { style: 'fill', color: rgba(color, 0.22) },
      })
      const mid = (x0 + x1) / 2
      const above = (y1: number, y2: number): number => Math.min(y1, y2)
      const below = (y1: number, y2: number): number => Math.max(y1, y2)
      const tLabel = `Cible: ${fmtPrice(reward, d)} (${pct(reward)}%) ${Math.round(reward / tick)}, Montant: ${fmtPrice(account + riskAmount * rr, 2)}`
      const sLabel = `Stop: ${fmtPrice(risk, d)} (${pct(risk)}%) ${Math.round(risk / tick)}, Montant: ${fmtPrice(account - riskAmount, 2)}`
      const pnlColor = res.pnl >= 0 ? green : red
      const shapes: OverlayFigure[] = [
        box(yT, green),
        box(yS, red),
        { type: 'line', ignoreEvent: true, attrs: { coordinates: [{ x: x0, y: yE }, { x: x1, y: yE }] }, styles: { color: '#787b86', size: 1, style: 'solid' } },
      ]
      // Hors sélection, seule la position reste visible : les textes n'apparaissent qu'au clic sur l'outil.
      if (!selectedDrawings.has(overlay.id)) return shapes
      return [
        ...shapes,
        tag(mid, side === 1 ? above(yT, yE) - 4 : below(yT, yE) + 4, tLabel, green, 'center', side === 1 ? 'bottom' : 'top'),
        tag(mid, side === 1 ? below(yS, yE) + 4 : above(yS, yE) - 4, sLabel, red, 'center', side === 1 ? 'top' : 'bottom'),
        tag(mid, yE + 10, `P&L ${res.closed ? 'fermé' : 'ouvert'}: ${fmtPrice(res.pnl, 2)}, Qté: ${qty}`, pnlColor, 'center', 'middle'),
        tag(mid, yE + 28, `Ratio Risque/Récompense: ${rr.toFixed(2).replace('.', ',')}`, pnlColor, 'center', 'middle'),
      ]
    },
    // Les poignées restent alignées : entrée et largeur partagent le prix d'entrée ; cible et stop restent à gauche.
    performEventPressedMove: ({ points, performPointIndex }) => {
      const p0 = points[0]
      if (!p0 || points.length < 4) return
      if (performPointIndex === 0) {
        points[1].value = p0.value
        for (const i of [2, 3]) {
          points[i].dataIndex = p0.dataIndex
          points[i].timestamp = p0.timestamp
        }
      } else if (performPointIndex === 1) {
        points[1].value = p0.value
      } else {
        points[performPointIndex].dataIndex = p0.dataIndex
        points[performPointIndex].timestamp = p0.timestamp
      }
    },
  }
}

/** Points par défaut d'une position posée d'un clic : 25 bougies de large, cible et stop à égale distance. */
export function positionPoints(name: string, entry: { dataIndex: number; value: number }, span: number, toTime: (i: number) => number | undefined) {
  const side = name === 'longPosition' ? 1 : -1
  const dist = span * 0.12
  const right = entry.dataIndex + 25
  const at = (i: number, value: number) => ({ dataIndex: i, timestamp: toTime(i), value })
  return [at(entry.dataIndex, entry.value), at(right, entry.value), at(entry.dataIndex, entry.value + side * dist), at(entry.dataIndex, entry.value - side * dist)]
}

/** Ligne d'alerte : pointillés fins, rond à droite ; au survol, « SYMBOLE Croisement prix » et une corbeille. */
export interface AlertLineData { label: string; color: string; hover: boolean }
const alertLine: OverlayTemplate = {
  name: 'alertLine', totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: true,
  createPointFigures: ({ overlay, coordinates: c, bounding }) => {
    if (c.length < 1) return []
    const d = (overlay.extendData ?? { label: '', color: '#f5b800', hover: false }) as AlertLineData
    const y = c[0].y
    const right = bounding.width - 26
    const figures: OverlayFigure[] = [
      { type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: d.color, size: 1, style: 'dashed', dashedValue: [4, 3] } },
      // Zone de prise plus large que le trait, pour attraper la ligne facilement (souris ou doigt).
      { type: 'line', attrs: { coordinates: [{ x: 0, y }, { x: bounding.width, y }] }, styles: { color: 'rgba(0,0,0,0.001)', size: 12, style: 'solid' } },
      { type: 'circle', attrs: { x: right, y, r: 4 }, styles: { style: 'stroke_fill', color: '#131722', borderColor: d.color, borderSize: 1.5 } },
    ]
    if (d.hover) {
      const x = Math.max(8, bounding.width * 0.32)
      figures.push(
        {
          type: 'text', key: 'label',
          attrs: { x, y, text: d.label, align: 'left', baseline: 'middle' },
          styles: { color: '#d1d4dc', backgroundColor: '#131722', borderColor: d.color, borderSize: 1, borderRadius: 3, size: 11, paddingLeft: 6, paddingRight: 22, paddingTop: 3, paddingBottom: 3 },
        },
        {
          type: 'text', key: 'delete',
          attrs: { x: x + d.label.length * 6.2 + 12, y, text: '🗑', align: 'left', baseline: 'middle' },
          styles: { color: '#d1d4dc', backgroundColor: 'transparent', size: 11, paddingLeft: 2, paddingRight: 2, paddingTop: 2, paddingBottom: 2 },
        },
      )
    }
    return figures
  },
}

let done = false
export function registerTvTools(): void {
  if (done) return
  done = true
  ;[trendLine, path, textNote, positionTemplate('longPosition'), positionTemplate('shortPosition'), alertLine].forEach(registerOverlay)
}
