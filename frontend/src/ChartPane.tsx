// Un graphique : chargement des données, temps réel, dessins, alertes, indicateurs et mode replay.
// Tout le rendu passe par un canvas (klinecharts) ; React ne redessine jamais les bougies.
import { dispose, init, type ActionType, type Chart, type OverlayCreate, type OverlayEvent } from 'klinecharts'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { api, fetchCandles, fmt, openStream, TF_LABEL, TF_MS, type Bar } from './api'
import DrawToolbar, { type DrawPoint } from './DrawToolbar'
import { Icon } from './icons'
import { findTool, INDICATORS, registerTools, TEXT_TOOLS } from './overlays'
import type { TradingSession } from './session'
import { alerts, quotes, type PaneConfig } from './stores'
import {
  DEFAULT_PROPS, drawData, drawProps, INLINE_TEXT_TOOLS, libraryStyles, pathName, POSITION_TOOLS, positionPoints, type DrawProps,
} from './tvtools'

export type { PaneConfig }

export interface ReplayState {
  active: boolean
  playing: boolean
  time: number
  left: number
  speed: number
  picking: boolean
}

export interface SavedDrawing {
  name: string
  points: { timestamp?: number; value?: number }[]
  extendData?: unknown
  /** Propriétés du dessin (couleur, épaisseur, texte, verrou…). */
  style?: Partial<DrawProps>
}

export interface PaneHandle {
  toggleIndicator: (id: string) => string[]
  indicators: () => string[]
  draw: (tool: string, data?: unknown) => void
  cancelDraw: () => void
  removeSelected: () => void
  clearDrawings: () => void
  restoreDrawings: (list: SavedDrawing[]) => void
  /** Revenir à la vue normale : dernière bougie, échelle de prix automatique. */
  resetView: () => void
  addHorizontalLine: (price: number) => void
  setFlags: (flags: { magnet?: boolean; lock?: boolean; visible?: boolean; keep?: boolean }) => void
  copy: () => void
  paste: () => void
  screenshot: () => void
  goTo: (ts: number) => void
  goToDate: (ts: number) => Promise<void>
  setRange: (ms: number) => void
  reload: () => void
  zoom: (factor: number) => void
  pointerPrice: () => number | null
  lastPrice: () => number
  pickReplayStart: () => void
  enterReplay: (ts: number) => Promise<void>
  exitReplay: () => void
  play: (on: boolean) => void
  step: () => void
  setSpeed: (barsPerSecond: number) => void
}

interface Props {
  config: PaneConfig
  theme: 'dark' | 'light'
  chartType: string
  /** Indicateurs à afficher à l'ouverture (mémorisés dans les réglages). */
  initialIndicators: string[]
  active: boolean
  session: TradingSession
  onActivate: () => void
  onReplay: (s: ReplayState) => void
  onMessage: (text: string, kind?: 'error' | 'info') => void
  /** Un dessin a été ajouté, déplacé ou supprimé (pour annuler / rétablir). */
  onDrawings: (source: string, symbol: string, before: SavedDrawing[], after: SavedDrawing[]) => void
  /** Clic droit sur le graphique : position de la souris et prix visé. */
  onContext: (at: { x: number; y: number; price: number }) => void
  /** Créer une alerte au prix d'un dessin. */
  onAlert: (price: number) => void
  /** Modifier une alerte (clic sur sa ligne). */
  onEditAlert: (id: string) => void
}

const IDLE: ReplayState = { active: false, playing: false, time: 0, left: 0, speed: 4, picking: false }
const REPLAY_MAX_BARS = 60_000
const ALERT_COLOR = '#f5b800'

// ---------------------------------------------------------------- vue mémorisée par paire
/** Zoom, position dans le temps et échelle de prix d'une paire (pour la retrouver telle qu'on l'a laissée). */
interface ChartView { barSpace: number; rightBars: number; auto: boolean; range: unknown }
const VIEW_KEY = 'bbc_views'
const views: Map<string, ChartView> = (() => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(VIEW_KEY) ?? '{}') as Record<string, ChartView>))
  } catch {
    return new Map()
  }
})()
function saveViews(): void {
  try {
    localStorage.setItem(VIEW_KEY, JSON.stringify(Object.fromEntries([...views.entries()].slice(-60))))
  } catch {
    /* stockage indisponible */
  }
}
const DEFAULT_BAR_SPACE = 8

/* La bibliothèque ne publie pas ces réglages : on passe par ses objets internes (version 9). */
interface Internals {
  getChartStore: () => { getTimeScaleStore: () => { getLastBarRightSideDiffBarCount: () => number; setLastBarRightSideDiffBarCount: (n: number) => void } }
  getDrawPaneById: (id: string) => { getAxisComponent: () => { getAutoCalcTickFlag: () => boolean; setAutoCalcTickFlag: (f: boolean) => void; getRange: () => unknown; setRange: (r: unknown) => void } } | null
  adjustPaneViewport: (...flags: boolean[]) => void
}
function readView(c: Chart): ChartView | null {
  try {
    const i = c as unknown as Internals
    const axis = i.getDrawPaneById('candle_pane')?.getAxisComponent()
    return {
      barSpace: c.getBarSpace(), rightBars: i.getChartStore().getTimeScaleStore().getLastBarRightSideDiffBarCount(),
      auto: axis?.getAutoCalcTickFlag() ?? true, range: axis?.getRange(),
    }
  } catch {
    return null
  }
}
function applyView(c: Chart, v: ChartView | null): void {
  try {
    const i = c as unknown as Internals
    const axis = i.getDrawPaneById('candle_pane')?.getAxisComponent()
    if (!v) {
      // Vue « normale » : échelle de prix automatique, zoom par défaut, dernière bougie à l'écran.
      axis?.setAutoCalcTickFlag(true)
      c.setBarSpace(DEFAULT_BAR_SPACE)
      c.scrollToRealTime()
    } else {
      c.setBarSpace(v.barSpace)
      i.getChartStore().getTimeScaleStore().setLastBarRightSideDiffBarCount(v.rightBars)
      if (v.auto || !v.range) axis?.setAutoCalcTickFlag(true)
      else axis?.setRange(v.range)
    }
    i.adjustPaneViewport(false, true, true, true, true)
  } catch {
    c.scrollToRealTime()
  }
}

/** Dessins copiés (Ctrl+C), partagés entre graphiques. */
let clipboard: SavedDrawing[] = []

/** Propriétés complètes d'un dessin : celles enregistrées, complétées par les valeurs par défaut de l'outil. */
function fullProps(name: string, saved?: Partial<DrawProps>): DrawProps {
  const base: DrawProps = INLINE_TEXT_TOOLS.has(name) ? { ...DEFAULT_PROPS, textColor: '#2962ff', fontSize: 14 }
    : POSITION_TOOLS.has(name) ? { ...DEFAULT_PROPS, size: 1, account: 1000, risk: 25 } : { ...DEFAULT_PROPS }
  return { ...base, ...(saved ?? {}) }
}

function themeStyles(theme: 'dark' | 'light', chartType: string): Record<string, unknown> {
  const dark = theme === 'dark'
  const grid = dark ? '#1f2430' : '#eef0f3'
  const text = dark ? '#9598a1' : '#50535e'
  const up = '#26a69a'
  const down = '#ef5350'
  const bar = { upColor: up, downColor: down, noChangeColor: '#888888', upBorderColor: up, downBorderColor: down, noChangeBorderColor: '#888888', upWickColor: up, downWickColor: down, noChangeWickColor: '#888888' }
  const axis = { axisLine: { color: grid }, tickLine: { color: grid }, tickText: { color: text } }
  return {
    grid: { horizontal: { color: grid }, vertical: { color: grid } },
    candle: {
      type: chartType,
      bar,
      area: { lineColor: '#2962ff', backgroundColor: [{ offset: 0, color: 'rgba(41,98,255,0.01)' }, { offset: 1, color: 'rgba(41,98,255,0.25)' }] },
      priceMark: { high: { color: text }, low: { color: text } },
      // La légende O/H/B/C est affichée par notre propre en-tête : ici, une ligne vide réserve sa place.
      tooltip: { custom: [{ title: ' ', value: ' ' }], text: { color: text } },
    },
    indicator: { tooltip: { text: { color: text } } },
    xAxis: axis,
    yAxis: axis,
    separator: { color: grid },
    crosshair: {
      horizontal: { line: { color: text }, text: { backgroundColor: dark ? '#363a45' : '#131722' } },
      vertical: { line: { color: text }, text: { backgroundColor: dark ? '#363a45' : '#131722' } },
    },
  }
}

/** Boutons VENTE / ACHAT rapides avec le spread, dans l'en-tête du graphique actif. */
function QuickTrade({ session, precision, onMessage }: { session: TradingSession; precision: number; onMessage: Props['onMessage'] }): JSX.Element {
  useSyncExternalStore(session.subscribe, session.getVersion)
  const order = (side: 1 | -1): void => {
    const size = session.defaultSize()
    const err = session.market(side, size, null, null)
    if (err) onMessage(err, 'error')
    else onMessage(`${side === 1 ? 'Achat' : 'Vente'} simulé de ${fmt(size, 4)} ${session.context.symbol} à ${fmt(side === 1 ? session.ask : session.bid, precision)}`)
  }
  return (
    <span className="quick" onMouseDown={(e) => e.stopPropagation()}>
      <button className="q-sell" onClick={() => order(-1)} title="Vendre au marché (simulation)"><b>{fmt(session.bid, precision)}</b><small>VENTE</small></button>
      <span className="q-spread" title="Spread simulé (réglable dans l'onglet Trading)">{fmt(session.spread, precision)}</span>
      <button className="q-buy" onClick={() => order(1)} title="Acheter au marché (simulation)"><b>{fmt(session.ask, precision)}</b><small>ACHAT</small></button>
    </span>
  )
}

const ChartPane = forwardRef<PaneHandle, Props>(function ChartPane(props, ref) {
  const { config, theme, chartType, active, session, onActivate, onReplay, onMessage, onDrawings, onContext, onAlert, onEditAlert } = props
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLSpanElement>(null)
  const chart = useRef<Chart | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [sel, setSel] = useState<{ id: string; name: string; v: number } | null>(null)
  const [editor, setEditor] = useState<{ id: string; x: number; y: number; value: string; size: number; color: string; fresh: boolean } | null>(null)

  // État impératif (aucun re-rendu React pendant la lecture ou le temps réel).
  const cfg = useRef(config)
  cfg.current = config
  const cb = useRef({ onReplay, onMessage, onActivate, onDrawings, onContext, onAlert, onEditAlert, session, active })
  cb.current = { onReplay, onMessage, onActivate, onDrawings, onContext, onAlert, onEditAlert, session, active }
  const [plus, setPlus] = useState<{ x: number; y: number } | null>(null) // bouton « + » de l'échelle de prix
  const [selAlert, setSelAlert] = useState<string | null>(null)            // alerte cliquée sur le graphique
  const plusRaf = useRef(0)
  const drawings = useRef(new Map<string, string>())      // id -> nom de l'outil
  const indicatorPanes = useRef(new Map<string, string>()) // indicateur -> id de fenêtre
  const flags = useRef({ magnet: false, lock: false, visible: true, keep: false })
  const selected = useRef<string | null>(null)
  const symKey = useRef('')
  const reloadSeen = useRef(0)
  const switchToken = useRef(0)
  const drawingId = useRef<string | null>(null)
  const saveTimer = useRef(0)
  const snapshot = useRef('[]')       // dernier état connu des dessins (pour annuler / rétablir)
  const restoring = useRef(false)     // vrai pendant un annuler / rétablir : pas de nouvelle entrée d'historique
  const pointer = useRef<{ x: number; y: number } | null>(null)
  const hovering = useRef(false)
  const pendingRange = useRef<number | null>(null)
  const stopStream = useRef<(() => void) | null>(null)
  const replay = useRef({
    active: false, playing: false, bars: [] as Bar[], idx: 0, speed: 4, acc: 0, last: 0, raf: 0, picking: false, notified: 0,
    tf: '1h', now: 0, partial: null as Bar | null, // unité du replay, instant simulé, bougie en cours de formation
  })

  // ---------------------------------------------------------------- en-tête O / H / B / C
  const showBar = (bar: Bar | undefined, prev: Bar | undefined): void => {
    const el = head.current
    if (!el) return
    if (!bar) {
      el.textContent = ''
      return
    }
    const d = cfg.current.precision
    const ref0 = prev ? prev.close : bar.open
    const diff = bar.close - ref0
    const pct = ref0 ? (diff / ref0) * 100 : 0
    const cls = bar.close >= bar.open ? 'up' : 'down'
    const v = (label: string, n: number): string => `<i>${label}</i><b class="${cls}">${fmt(n, d)}</b>`
    // Uniquement des nombres formatés : aucun texte venant de l'extérieur n'entre dans ce HTML.
    el.innerHTML = `${v('O', bar.open)}${v('H', bar.high)}${v('B', bar.low)}${v('C', bar.close)}`
      + `<b class="${diff >= 0 ? 'up' : 'down'}">${diff >= 0 ? '+' : ''}${fmt(diff, d)} (${diff >= 0 ? '+' : ''}${pct.toFixed(2)} %)</b>`
  }
  const showLast = (): void => {
    const list = chart.current?.getDataList() ?? []
    showBar(list[list.length - 1] as Bar | undefined, list[list.length - 2] as Bar | undefined)
  }

  // ---------------------------------------------------------------- création du graphique
  useEffect(() => {
    registerTools()
    const c = init(box.current!, { locale: 'fr-FR' })!
    chart.current = c
    c.setOffsetRightDistance(80)
    c.setPaneOptions({ id: 'candle_pane', minHeight: 180 }) // le prix garde toujours la place principale
    props.initialIndicators.forEach((id) => {
      const main = INDICATORS.find((i) => i.id === id)?.main
      const pane = main ? c.createIndicator(id, true, { id: 'candle_pane' }) : c.createIndicator(id, false, { height: id === 'VOL' ? 70 : 90, minHeight: 40 })
      indicatorPanes.current.set(id, pane ?? 'candle_pane')
    })
    c.subscribeAction('onCrosshairChange' as ActionType, (data?: { kLineData?: Bar; dataIndex?: number }) => {
      if (data?.kLineData && data.dataIndex !== undefined) {
        hovering.current = true
        showBar(data.kLineData, c.getDataList()[data.dataIndex - 1] as Bar | undefined)
      } else {
        hovering.current = false
        showLast()
      }
    })
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(box.current!)
    return () => {
      ro.disconnect()
      dispose(box.current!)
      indicatorPanes.current.clear()
      chart.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    chart.current?.setStyles(theme)
    chart.current?.setStyles(themeStyles(theme, chartType))
  }, [theme, chartType])

  // ---------------------------------------------------------------- dessins
  /** Bougies futures : un point placé à droite de la dernière bougie est enregistré par une date extrapolée. */
  const lastBar = (): { idx: number; ts: number } => {
    const list = chart.current?.getDataList() ?? []
    return { idx: list.length - 1, ts: list[list.length - 1]?.timestamp ?? Date.now() }
  }
  const toSaved = (p: { timestamp?: number; dataIndex?: number; value?: number }): { timestamp?: number; value?: number } => {
    if (p.timestamp !== undefined || p.dataIndex === undefined) return { timestamp: p.timestamp, value: p.value }
    const last = lastBar()
    return { timestamp: last.ts + (p.dataIndex - last.idx) * TF_MS[cfg.current.tf], value: p.value }
  }
  const fromSaved = (p: { timestamp?: number; value?: number }): { timestamp?: number; dataIndex?: number; value?: number } => {
    const last = lastBar()
    if (p.timestamp === undefined || p.timestamp <= last.ts || last.idx < 0) return p
    return { dataIndex: last.idx + Math.round((p.timestamp - last.ts) / TF_MS[cfg.current.tf]), value: p.value }
  }

  const collect = (): SavedDrawing[] => {
    const c = chart.current
    const data: SavedDrawing[] = []
    if (!c) return data
    drawings.current.forEach((name, id) => {
      if (id === drawingId.current) return // dessin en cours de tracé : pas encore un vrai dessin
      const o = c.getOverlayById(id)
      const style = drawProps.get(id)
      if (o) data.push({ name, points: o.points.map(toSaved), extendData: o.extendData, ...(style ? { style } : {}) })
    })
    return data
  }

  /** Enregistre tout de suite les dessins affichés pour la paire indiquée. */
  const saveNow = (source: string, symbol: string): void => {
    if (!chart.current) return
    const data = collect()
    const after = JSON.stringify(data)
    if (after !== snapshot.current) {
      if (!restoring.current) cb.current.onDrawings(source, symbol, JSON.parse(snapshot.current) as SavedDrawing[], data)
      snapshot.current = after
    }
    restoring.current = false
    void api(`/api/drawings?source=${encodeURIComponent(source)}&symbol=${encodeURIComponent(symbol)}`, 'PUT', data).catch(() => undefined)
  }
  const pendingSave = useRef<{ source: string; symbol: string } | null>(null)
  const wiping = useRef(false)

  const scheduleSave = (): void => {
    if (wiping.current) return // effacement de l'affichage au changement de paire : rien à enregistrer
    window.clearTimeout(saveTimer.current)
    const { source, symbol } = cfg.current
    pendingSave.current = { source, symbol }
    saveTimer.current = window.setTimeout(() => {
      pendingSave.current = null
      // Sécurité : on n'enregistre jamais les dessins d'une paire sous le nom d'une autre.
      if (!chart.current || cfg.current.source !== source || cfg.current.symbol !== symbol) return
      const data = collect()
      const after = JSON.stringify(data)
      if (after !== snapshot.current) {
        if (!restoring.current) cb.current.onDrawings(source, symbol, JSON.parse(snapshot.current) as SavedDrawing[], data)
        snapshot.current = after
      }
      restoring.current = false
      void api(`/api/drawings?source=${encodeURIComponent(source)}&symbol=${encodeURIComponent(symbol)}`, 'PUT', data).catch(() => undefined)
    }, 300)
  }

  /** Visible si l'utilisateur ne l'a ni caché, ni masqué pour cette unité de temps, et si les dessins sont affichés. */
  const isVisible = (p: DrawProps): boolean => flags.current.visible && !p.hidden && !(p.hideOn ?? []).includes(cfg.current.tf)

  /** Applique des propriétés à un dessin déjà affiché. */
  const applyLive = (id: string, p: DrawProps): void => {
    const name = drawings.current.get(id) ?? ''
    drawProps.set(id, p)
    chart.current?.overrideOverlay({
      id, styles: libraryStyles(name, p), lock: !!p.lock || flags.current.lock, visible: isVisible(p), zLevel: p.z ?? 0,
    })
  }

  /** Ouvre la zone de saisie du texte, posée sur le graphique à l'endroit du dessin. */
  const openEditor = (id: string, fresh: boolean): void => {
    const c = chart.current
    const o = c?.getOverlayById(id)
    if (!c || !o?.points.length) return
    const px = c.convertToPixel(o.points[0], { paneId: 'candle_pane' }) as { x?: number; y?: number }
    const p = drawProps.get(id) ?? fullProps('textNote')
    setEditor({ id, x: px.x ?? 40, y: px.y ?? 40, value: String(o.extendData ?? ''), size: p.fontSize ?? 14, color: p.textColor ?? p.color, fresh })
  }
  const closeEditor = (commit: boolean): void => {
    setEditor((ed) => {
      if (!ed) return null
      const c = chart.current
      const value = ed.value.trim() ? ed.value : ''
      if (commit && value) {
        c?.overrideOverlay({ id: ed.id, extendData: value })
        scheduleSave()
      } else if (!value && (ed.fresh || commit)) {
        c?.removeOverlay(ed.id) // texte vide : rien n'est posé
      }
      return null
    })
  }

  const overlayEvents = (): Partial<OverlayCreate> => ({
    onDrawEnd: (e: OverlayEvent) => {
      const c = chart.current
      const o = e.overlay
      drawingId.current = null
      if (c && POSITION_TOOLS.has(o.name) && o.points.length === 1) {
        // Position posée d'un clic : cible et stop à égale distance, 25 bougies de large (comme sur TradingView).
        const size = c.getSize('candle_pane', 'main' as never)
        const top = c.convertFromPixel([{ x: 0, y: 0 }], { paneId: 'candle_pane' }) as { value?: number }[]
        const bottom = c.convertFromPixel([{ x: 0, y: size?.height ?? 300 }], { paneId: 'candle_pane' }) as { value?: number }[]
        const span = Math.abs((top[0]?.value ?? 0) - (bottom[0]?.value ?? 0)) || Math.abs(o.points[0].value ?? 1) * 0.02
        const list = c.getDataList()
        const p0 = o.points[0]
        const entry = { dataIndex: p0.dataIndex ?? list.length - 1, value: p0.value ?? 0 }
        c.overrideOverlay({ id: o.id, points: positionPoints(o.name, entry, span, (i) => list[i]?.timestamp) })
      }
      if (INLINE_TEXT_TOOLS.has(o.name)) openEditor(o.id, true)
      else if (o.name === 'path') {
        // Le double-clic qui termine le chemin ajoute un point en double : il est retiré.
        const pts = o.points.filter((pt, i, all) => i === 0 || pt.dataIndex !== all[i - 1].dataIndex || pt.value !== all[i - 1].value)
        if (pts.length !== o.points.length) c?.overrideOverlay({ id: o.id, points: pts })
      }
      scheduleSave()
      // « Continuer à dessiner » : le même outil reste actif pour le dessin suivant.
      if (flags.current.keep && !INLINE_TEXT_TOOLS.has(o.name)) window.setTimeout(() => startTool(o.name), 0)
      return false
    },
    onPressedMoveEnd: () => {
      scheduleSave()
      setSel((s) => (s ? { ...s, v: s.v + 1 } : s))
      return false
    },
    onSelected: (e: OverlayEvent) => {
      selected.current = e.overlay.id
      if (drawings.current.has(e.overlay.id)) setSel({ id: e.overlay.id, name: drawings.current.get(e.overlay.id) ?? e.overlay.name, v: 0 })
      return false
    },
    onDeselected: () => {
      selected.current = null
      setSel(null)
      return false
    },
    onDoubleClick: (e: OverlayEvent) => {
      if (INLINE_TEXT_TOOLS.has(e.overlay.name)) openEditor(e.overlay.id, false)
      return false
    },
    onRemoved: (e: OverlayEvent) => {
      drawings.current.delete(e.overlay.id)
      drawProps.delete(e.overlay.id)
      drawData.delete(e.overlay.id)
      setSel((s) => (s?.id === e.overlay.id ? null : s))
      scheduleSave()
      return false
    },
    // Le clic droit ouvre notre menu : il ne supprime plus le dessin (Suppr le fait).
    onRightClick: () => true,
  })

  const addDrawing = (o: OverlayCreate, saved?: Partial<DrawProps>): string | null => {
    const c = chart.current
    if (!c) return null
    const name = o.name
    const p = fullProps(name, saved)
    // Un chemin terminé se réaffiche avec un gabarit à son nombre exact de points.
    const shown = name === 'path' && o.points && o.points.length > 1 ? pathName(o.points.length) : name
    const id = c.createOverlay({
      ...o,
      name: shown,
      points: o.points?.map(fromSaved),
      styles: libraryStyles(name, p),
      ...overlayEvents(),
      lock: !!p.lock || flags.current.lock,
      visible: isVisible(p),
      zLevel: p.z ?? 0,
      mode: (flags.current.magnet ? 'weak_magnet' : 'normal') as OverlayCreate['mode'],
    }) as string | null
    if (id) {
      drawings.current.set(id, name)
      drawProps.set(id, p)
      drawData.set(id, () => chart.current?.getDataList() ?? [])
    }
    return id
  }

  /** Arme un outil : le prochain clic sur le graphique pose le dessin. */
  function startTool(tool: string, data?: unknown): void {
    const c = chart.current
    if (!c) return
    if (drawingId.current) {
      drawings.current.delete(drawingId.current)
      c.removeOverlay(drawingId.current)
    }
    let extendData = data
    if (TEXT_TOOLS.has(tool)) {
      const text = window.prompt('Texte à afficher :', '')
      if (!text) return
      extendData = text
    }
    drawingId.current = addDrawing({ name: tool, extendData })
  }

  // ---------------------------------------------------------------- actions sur le dessin sélectionné
  const selProps = (): DrawProps => (sel ? drawProps.get(sel.id) ?? fullProps(sel.name) : DEFAULT_PROPS)
  const changeSel = (patch: Partial<DrawProps>): void => {
    if (!sel) return
    applyLive(sel.id, { ...selProps(), ...patch })
    if (patch.hidden) {
      chart.current?.overrideOverlay({ id: sel.id, visible: false })
      setSel(null)
    } else setSel({ ...sel, v: sel.v + 1 })
    scheduleSave()
  }
  const selPoints = (): DrawPoint[] => (sel ? (chart.current?.getOverlayById(sel.id)?.points ?? []).map(toSaved) : [])
  const pointsSel = (pts: DrawPoint[]): void => {
    if (!sel) return
    const o = chart.current?.getOverlayById(sel.id)
    if (!o) return
    // Le nouveau prix remplace l'ancien ; la position dans le temps de chaque point ne change pas.
    chart.current?.overrideOverlay({ id: sel.id, points: o.points.map((pt, i) => ({ ...pt, value: pts[i]?.value ?? pt.value })) })
    setSel({ ...sel, v: sel.v + 1 })
    scheduleSave()
  }
  const snapshotOf = (id: string): SavedDrawing | null => {
    const o = chart.current?.getOverlayById(id)
    const name = drawings.current.get(id)
    if (!o || !name) return null
    return { name, points: o.points.map(toSaved), extendData: o.extendData, style: { ...(drawProps.get(id) ?? {}) } }
  }
  const pasteAll = (list: SavedDrawing[], shiftBars: number): void => {
    const step = TF_MS[cfg.current.tf]
    list.forEach((d) => {
      const pts = d.points.map((p) => ({ ...p, timestamp: p.timestamp !== undefined ? p.timestamp + shiftBars * step : p.timestamp }))
      addDrawing({ name: d.name, points: pts, extendData: d.extendData }, { ...d.style, lock: false, hidden: false })
    })
    scheduleSave()
  }
  const cloneSel = (): void => {
    const d = sel && snapshotOf(sel.id)
    if (d) pasteAll([d], 5)
  }
  const copySel = (): void => {
    const d = sel && snapshotOf(sel.id)
    if (!d) return
    clipboard = [d]
    cb.current.onMessage('Dessin copié : Ctrl+V pour le coller.')
  }
  const orderSel = (where: 'front' | 'back'): void => {
    const all = [...drawProps.values()].map((p) => p.z ?? 0)
    changeSel({ z: where === 'front' ? Math.max(0, ...all) + 1 : Math.min(0, ...all) - 1 })
  }
  const alertSel = (): void => {
    const pts = selPoints().filter((p) => p.value !== undefined)
    if (!pts.length || !sel) return
    // Position : alerte sur la cible ; autres dessins : sur le dernier point posé.
    const pick = POSITION_TOOLS.has(sel.name) ? pts[2] ?? pts[0] : pts[pts.length - 1]
    cb.current.onAlert(pick.value ?? 0)
  }

  const wipeDrawings = (): void => {
    const c = chart.current
    const ids = [...drawings.current.keys()]
    drawings.current.clear()
    ids.forEach((id) => {
      drawProps.delete(id)
      drawData.delete(id)
    })
    drawingId.current = null
    setSel(null)
    setEditor(null)
    wiping.current = true
    try {
      ids.forEach((id) => c?.removeOverlay(id))
    } finally {
      wiping.current = false
    }
  }

  // Masquage par unité de temps : appliqué à chaque changement d'unité.
  useEffect(() => {
    drawings.current.forEach((_, id) => {
      const p = drawProps.get(id)
      if (p) chart.current?.overrideOverlay({ id, visible: isVisible(p) })
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.tf])

  // ---------------------------------------------------------------- lignes d'ordres (trading)
  const priceLine = (group: string, value: number, text: string, color: string, locked: boolean, onMove?: (v: number) => void): void => {
    chart.current?.createOverlay({
      name: 'tradeLine', groupId: group, lock: locked,
      points: [{ timestamp: cb.current.session.time || Date.now(), value }], extendData: { text, color },
      onPressedMoveEnd: (e: OverlayEvent) => {
        const v = e.overlay.points[0]?.value
        if (v !== undefined && onMove) onMove(v)
        return false
      },
      onRightClick: () => true,
    })
  }

  useEffect(() => {
    const sync = (): void => {
      const c = chart.current
      if (!c) return
      c.removeOverlay({ groupId: 'trade' })
      const s = cb.current.session
      if (!cb.current.active || s.context.symbol !== cfg.current.symbol) return
      const d = cfg.current.precision
      s.positions.forEach((p) => {
        priceLine('trade', p.entry, `${p.side === 1 ? 'Achat' : 'Vente'} ${p.size.toFixed(4)} @ ${p.entry.toFixed(d)}`, '#2962ff', true)
        if (p.sl !== null) priceLine('trade', p.sl, `Stop ${p.sl.toFixed(d)}`, '#ef5350', false, (v) => s.modify(p.id, { sl: v }))
        if (p.tp !== null) priceLine('trade', p.tp, `Objectif ${p.tp.toFixed(d)}`, '#26a69a', false, (v) => s.modify(p.id, { tp: v }))
      })
      s.orders.forEach((o) => priceLine('trade', o.price, `${o.side === 1 ? 'Achat' : 'Vente'} ${o.type} ${o.price.toFixed(d)}`, '#f7931a', false, (v) => s.modifyOrder(o.id, v)))
    }
    // On ne redessine que si la liste d'ordres change, pas à chaque variation de prix.
    let key = ''
    const onChange = (): void => {
      const s = cb.current.session
      const k = `${cb.current.active}|${s.context.symbol}|` + s.positions.map((p) => `${p.id}:${p.sl}:${p.tp}`).join(',') + '|' + s.orders.map((o) => `${o.id}:${o.price}`).join(',')
      if (k !== key) {
        key = k
        sync()
      }
    }
    onChange()
    return session.subscribe(onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, active, config.symbol])

  // ---------------------------------------------------------------- lignes d'alertes
  useEffect(() => {
    // Nouvelle paire : les lignes de l'ancienne disparaissent tout de suite (ses alertes restent actives en arrière-plan).
    chart.current?.removeOverlay({ groupId: 'alert' })
    setSelAlert(null)
    let key: string | null = null
    const onChange = (): void => {
      const c = chart.current
      if (!c) return
      const mine = alerts.alerts.filter((a) => a.source === cfg.current.source && a.symbol === cfg.current.symbol)
      const k = mine.map((a) => `${a.id}:${a.price}:${a.active}:${a.condition}`).join(',')
      if (k === key) return
      key = k
      c.removeOverlay({ groupId: 'alert' })
      const d = cfg.current.precision
      const word: Record<string, string> = { cross: 'Croisement', above: 'Au-dessus de', below: 'En dessous de' }
      mine.forEach((a) => {
        const data = {
          label: `${a.symbol} ${word[a.condition] ?? 'Croisement'} ${fmt(a.price, d)}${a.active ? '' : ' (en pause)'}`,
          color: a.active ? ALERT_COLOR : '#787b86', hover: false,
        }
        c.createOverlay({
          name: 'alertLine', groupId: 'alert', points: [{ timestamp: lastBar().ts, value: a.price }], extendData: data,
          // Glisser la ligne déplace l'alerte ; le prix suivi est mis à jour à la fin du glissement.
          onPressedMoveEnd: (e: OverlayEvent) => {
            const v = e.overlay.points[0]?.value
            if (v !== undefined) alerts.update(a.id, { price: Number(v.toFixed(d)) })
            return false
          },
          onMouseEnter: (e: OverlayEvent) => { c.overrideOverlay({ id: e.overlay.id, extendData: { ...data, hover: true } }); return false },
          onMouseLeave: (e: OverlayEvent) => { c.overrideOverlay({ id: e.overlay.id, extendData: { ...data, hover: false } }); return false },
          // Corbeille : supprime l'alerte ; ailleurs sur la ligne : ouvre la modification (prix à taper).
          // Clic sur la ligne : barre de l'alerte (prix à taper, pause, supprimer) ; corbeille : suppression directe.
          onClick: (e: OverlayEvent) => {
            if (e.figureKey === 'delete') {
              alerts.remove(a.id)
              setSelAlert(null)
            } else setSelAlert(a.id)
            return false
          },
          onDoubleClick: () => { cb.current.onEditAlert(a.id); return false },
          onRightClick: () => true,
        })
      })
    }
    onChange()
    return alerts.subscribe(onChange)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source, config.symbol])

  // ---------------------------------------------------------------- données + temps réel
  // Chaque prix reçu alimente les cotations (donc les alertes) ; la session de trading, elle,
  // ne suit que le graphique actif.
  const feed = (price: number): void => {
    quotes.setPrice(cfg.current.source, cfg.current.symbol, price)
    const s = cb.current.session
    if (cb.current.active && s.context.symbol === cfg.current.symbol && s.context.source === cfg.current.source) s.onPrice(price, Date.now())
  }

  /** Règle le zoom pour afficher exactement `count` bougies. */
  const fit = (count: number): void => {
    const c = chart.current
    if (!c || !box.current || count < 1) return
    const width = box.current.clientWidth - 150 // échelle de prix et marge de droite
    c.setBarSpace(Math.min(50, Math.max(1, width / count)))
    c.scrollToRealTime()
  }

  useEffect(() => {
    const c = chart.current
    if (!c) return
    let dead = false
    const { source, symbol, tf, precision } = config
    const viewKey = `${source}:${symbol}:${tf}`
    // Pendant un replay, changer d'unité de temps ne quitte pas le replay : on reconstruit les bougies.
    if (replay.current.active && symKey.current === `${source}:${symbol}` && reloadSeen.current === reload) {
      void switchReplayTf(tf)
      return
    }
    symKey.current = `${source}:${symbol}`
    reloadSeen.current = reload
    stopReplay(false)
    const step = TF_MS[tf]
    const range = pendingRange.current
    pendingRange.current = null
    setLoading(true)
    c.setPriceVolumePrecision(precision, 2)
    ;(async () => {
      try {
        // Dukascopy est lent au premier téléchargement : on commence par moins de bougies.
        const page = source === 'dukascopy' ? 600 : 3000
        const wanted = range === null ? page : Math.min(20_000, Math.ceil(Math.min(range, 40 * 365 * 86_400_000) / step) + 5)
        const bars = await fetchCandles(source, symbol, tf, { limit: Math.max(wanted, range === null ? 0 : 50) })
        if (dead) return
        c.applyNewData(bars, bars.length > 0)
        if (range !== null) {
          fit(Math.min(bars.length, wanted))
          ;(c as unknown as Internals).getDrawPaneById('candle_pane')?.getAxisComponent().setAutoCalcTickFlag(true)
        } else {
          const saved = views.get(viewKey)
          window.setTimeout(() => { if (!dead) applyView(c, saved ?? null) }, 0)
        }
        if (!hovering.current) showLast()
        if (bars.length) feed(bars[bars.length - 1].close)
        c.loadMore((ts) => {
          if (ts === null || replay.current.active) return
          void fetchCandles(source, symbol, tf, { end: ts - 1, limit: page })
            .then((older) => !dead && c.applyMoreData(older, older.length > 0))
            .catch(() => !dead && c.applyMoreData([], false))
        })
        stopStream.current = openStream(source, symbol, tf, (bar) => {
          if (dead || replay.current.active) return
          c.updateData(bar)
          if (!hovering.current) showLast()
          feed(bar.close)
        })
      } catch (e) {
        if (!dead) {
          c.applyNewData([], false)
          showBar(undefined, undefined)
          cb.current.onMessage((e as Error).message, 'error')
        }
      } finally {
        if (!dead) setLoading(false)
      }
    })()
    return () => {
      dead = true
      stopStream.current?.()
      stopStream.current = null
      // On quitte cette paire (ou cette unité) : sa vue est mémorisée pour la retrouver telle quelle.
      if (!replay.current.active) {
        const v = readView(c)
        if (v) {
          views.delete(viewKey)
          views.set(viewKey, v)
          saveViews()
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source, config.symbol, config.tf, reload])

  // À la fermeture du graphique, la lecture du replay s'arrête.
  useEffect(() => () => cancelAnimationFrame(replay.current.raf), [])

  // Dessins sauvegardés : rechargés à chaque changement de symbole.
  useEffect(() => {
    let dead = false
    wipeDrawings()
    window.clearTimeout(saveTimer.current)
    pendingSave.current = null
    snapshot.current = '[]'
    void api<SavedDrawing[]>(`/api/drawings?source=${encodeURIComponent(config.source)}&symbol=${encodeURIComponent(config.symbol)}`)
      .then((list) => {
        if (dead) return
        list.forEach((d) => addDrawing({ name: d.name, points: d.points, extendData: d.extendData }, d.style))
        snapshot.current = JSON.stringify(collect())
      })
      .catch(() => undefined)
    const leaving = { source: config.source, symbol: config.symbol }
    return () => {
      dead = true
      window.clearTimeout(saveTimer.current)
      // Une modification faite juste avant de changer de paire est enregistrée sur SA paire, pas perdue.
      if (pendingSave.current && pendingSave.current.source === leaving.source && pendingSave.current.symbol === leaving.symbol) {
        pendingSave.current = null
        saveNow(leaving.source, leaving.symbol)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source, config.symbol])

  // ---------------------------------------------------------------- replay
  const notify = (force = false): void => {
    const r = replay.current
    const now = performance.now()
    if (!force && now - r.notified < 120) return // au plus ~8 mises à jour de l'interface par seconde
    r.notified = now
    cb.current.onReplay({
      active: r.active, playing: r.playing, speed: r.speed, picking: r.picking,
      time: r.active ? r.now : 0, left: r.active ? r.bars.length - r.idx : 0, // heure simulée = fin de la dernière bougie révélée
    })
  }

  const stepOnce = (): boolean => {
    const r = replay.current
    const c = chart.current
    if (!c || !r.active || r.idx >= r.bars.length) return false
    const bar = r.bars[r.idx++]
    c.updateData(bar)
    r.now = bar.timestamp + TF_MS[r.tf]
    r.partial = null
    if (cb.current.active) cb.current.session.onBar(bar)
    return true
  }

  const frame = (now: number): void => {
    const r = replay.current
    if (!r.playing) return
    // Le temps écoulé est plafonné (onglet en arrière-plan, image lente) pour éviter tout rattrapage brutal.
    r.acc += (Math.min(now - r.last, 100) / 1000) * r.speed
    r.last = now
    // Budget de 6 ms par image : la lecture ne bloque jamais l'affichage, même à vitesse maximale.
    const deadline = performance.now() + 6
    while (r.acc >= 1 && performance.now() < deadline) {
      r.acc -= 1
      if (!stepOnce()) {
        r.playing = false
        cb.current.onMessage('Fin des données du replay.', 'info')
        break
      }
    }
    if (r.acc > r.speed) r.acc = 0 // machine trop lente pour cette vitesse : on ne cumule pas de retard
    if (!hovering.current) showLast()
    notify(!r.playing)
    if (r.playing) r.raf = requestAnimationFrame(frame)
  }

  function stopReplay(reloadLive: boolean): void {
    const r = replay.current
    cancelAnimationFrame(r.raf)
    const was = r.active || r.picking
    Object.assign(r, { active: false, playing: false, bars: [], idx: 0, picking: false, partial: null })
    if (was) cb.current.onReplay({ ...IDLE, speed: r.speed })
    if (was && reloadLive) setReload((n) => n + 1)
  }

  async function startReplay(ts: number): Promise<void> {
    const c = chart.current
    if (!c) return
    const { source, symbol, tf } = cfg.current
    const step = TF_MS[tf]
    setLoading(true)
    try {
      // Toutes les données de la session sont chargées en mémoire AVANT la lecture :
      // aucune requête réseau pendant le replay.
      const end = Math.min(Date.now(), ts + REPLAY_MAX_BARS * step)
      const bars = await fetchCandles(source, symbol, tf, { start: ts - 1500 * step, end })
      let idx = bars.findIndex((b) => b.timestamp >= ts)
      if (idx < 0) idx = bars.length
      if (bars.length < 2 || idx < 1) throw new Error('Pas de données à cette date pour ce symbole.')
      stopStream.current?.()
      stopStream.current = null
      const r = replay.current
      cancelAnimationFrame(r.raf)
      Object.assign(r, { active: true, playing: false, bars, idx, acc: 0, picking: false, tf, now: bars[idx - 1].timestamp + step, partial: null })
      c.applyNewData(bars.slice(0, idx), false)
      c.scrollToRealTime()
      showLast()
      const s = cb.current.session
      s.reset({ source, symbol, tf })
      s.price = bars[idx - 1].close
      s.time = bars[idx - 1].timestamp
      notify(true)
    } catch (e) {
      cb.current.onMessage((e as Error).message, 'error')
    } finally {
      setLoading(false)
    }
  }

  /** Replay : passe à une autre unité de temps en gardant l'instant simulé, sans montrer le futur. */
  async function switchReplayTf(tf: string): Promise<void> {
    const c = chart.current
    const r = replay.current
    if (!c || tf === r.tf) return
    const token = ++switchToken.current
    const { source, symbol } = cfg.current
    const step = TF_MS[tf]
    const now = r.now
    const wasPlaying = r.playing
    r.playing = false
    cancelAnimationFrame(r.raf)
    // Bougies déjà révélées dans l'ancienne unité (plus la bougie partielle s'il y en avait une).
    const revealed = r.bars.slice(0, r.idx).filter((b) => !r.partial || b.timestamp !== r.partial.timestamp)
    if (r.partial) revealed.push(r.partial)
    setLoading(true)
    try {
      const bars = await fetchCandles(source, symbol, tf, { start: now - 1500 * step, end: Math.min(Date.now(), now + REPLAY_MAX_BARS * step) })
      if (token !== switchToken.current || !r.active) return
      // Première bougie pas encore terminée à l'instant simulé.
      let idx = bars.findIndex((b) => b.timestamp + step > now)
      if (idx < 0) idx = bars.length
      const shown = bars.slice(0, idx)
      let partial: Bar | null = null
      if (idx < bars.length && bars[idx].timestamp < now) {
        // Bougie en cours : reconstruite uniquement avec ce qui a déjà été révélé (aucune donnée future).
        const bucket = bars[idx].timestamp
        const parts = revealed.filter((b) => b.timestamp >= bucket && b.timestamp < now)
        if (parts.length) {
          partial = {
            timestamp: bucket, open: parts[0].open, close: parts[parts.length - 1].close,
            high: Math.max(...parts.map((b) => b.high)), low: Math.min(...parts.map((b) => b.low)),
            volume: parts.reduce((s, b) => s + b.volume, 0),
          }
          shown.push(partial)
        }
      }
      if (!shown.length) throw new Error('Pas de données dans cette unité de temps à cette date.')
      Object.assign(r, { bars, idx, acc: 0, tf, partial })
      c.applyNewData(shown, false)
      c.scrollToRealTime()
      showLast()
      const s = cb.current.session
      s.context.tf = tf
      s.price = shown[shown.length - 1].close
      if (wasPlaying) {
        r.playing = true
        r.last = performance.now()
        r.raf = requestAnimationFrame(frame)
      }
      notify(true)
    } catch (e) {
      cb.current.onMessage((e as Error).message, 'error')
      notify(true)
    } finally {
      if (token === switchToken.current) setLoading(false)
    }
  }

  // ---------------------------------------------------------------- souris : position, clic droit, choix du replay
  /** Prix sous un point du graphique (null hors de la zone des bougies). */
  const priceAt = (x: number, y: number): { price: number; timestamp?: number } | null => {
    const c = chart.current
    if (!c) return null
    const size = c.getSize('candle_pane', 'main' as never)
    if (!size || y < 0 || y > size.height || x < 0 || x > size.width) return null
    const pt = c.convertFromPixel([{ x, y }], { paneId: 'candle_pane' }) as { value?: number; timestamp?: number }[]
    const price = pt[0]?.value
    return price !== undefined && Number.isFinite(price) ? { price, timestamp: pt[0]?.timestamp } : null
  }
  const relative = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = box.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPick = (e: React.MouseEvent): void => {
    onActivate()
    if (selAlert && !(e.target as HTMLElement).closest('.alert-bar')) setSelAlert(null)
    const r = replay.current
    if (!r.picking || e.button !== 0) return
    const { x, y } = relative(e)
    const ts = priceAt(x, y)?.timestamp
    r.picking = false
    if (ts) void startReplay(ts)
    else notify(true)
  }

  /** Le « + » suit le curseur le long de l'échelle de prix (souris ou doigt). */
  const trackPlus = (x: number, y: number): void => {
    cancelAnimationFrame(plusRaf.current)
    plusRaf.current = requestAnimationFrame(() => {
      const size = chart.current?.getSize('candle_pane', 'main' as never)
      if (!size || y < 4 || y > size.height - 4 || x < 0) setPlus(null)
      else setPlus({ x: size.width - 22, y })
    })
  }
  const openPlus = (e: React.MouseEvent): void => {
    e.stopPropagation()
    e.preventDefault()
    if (!plus) return
    const at = priceAt(plus.x - 4, plus.y)
    const rect = box.current!.getBoundingClientRect()
    if (at) cb.current.onContext({ x: rect.left + plus.x + 20, y: rect.top + plus.y + 12, price: at.price })
  }

  // Clic droit : plus de menu (il est désormais sur le « + » de l'échelle de prix).
  const onMenu = (e: React.MouseEvent): void => e.preventDefault()

  // ---------------------------------------------------------------- commandes exposées
  useImperativeHandle(ref, (): PaneHandle => ({
    indicators: () => [...indicatorPanes.current.keys()],
    toggleIndicator: (id) => {
      const c = chart.current
      if (!c) return []
      const map = indicatorPanes.current
      if (map.has(id)) {
        c.removeIndicator(map.get(id)!, id)
        map.delete(id)
      } else {
        const main = INDICATORS.find((i) => i.id === id)?.main
        const pane = main ? c.createIndicator(id, true, { id: 'candle_pane' }) : c.createIndicator(id, false, { height: 90, minHeight: 40 })
        map.set(id, pane ?? 'candle_pane')
      }
      return [...map.keys()]
    },
    draw: (tool, data) => startTool(tool, data),
    cancelDraw: () => {
      if (drawingId.current) {
        const id = drawingId.current
        drawings.current.delete(id)
        drawingId.current = null
        chart.current?.removeOverlay(id)
      }
      if (replay.current.picking) {
        replay.current.picking = false
        notify(true)
      }
    },
    removeSelected: () => {
      if (selected.current && drawings.current.has(selected.current)) chart.current?.removeOverlay(selected.current)
      selected.current = null
    },
    clearDrawings: () => {
      wipeDrawings()
      scheduleSave()
    },
    resetView: () => {
      const c = chart.current
      if (!c || replay.current.active) return
      views.delete(`${cfg.current.source}:${cfg.current.symbol}:${cfg.current.tf}`)
      saveViews()
      applyView(c, null)
    },
    restoreDrawings: (list) => {
      restoring.current = true
      wipeDrawings()
      list.forEach((d) => addDrawing({ name: d.name, points: d.points, extendData: d.extendData }, d.style))
      scheduleSave()
    },
    addHorizontalLine: (price) => {
      const list = chart.current?.getDataList() ?? []
      addDrawing({ name: 'horizontalStraightLine', points: [{ timestamp: list[list.length - 1]?.timestamp ?? Date.now(), value: price }] })
      scheduleSave()
    },
    setFlags: (f) => {
      Object.assign(flags.current, f)
      const c = chart.current
      drawings.current.forEach((_, id) => {
        const p = drawProps.get(id) ?? DEFAULT_PROPS
        // Réafficher tous les dessins fait aussi réapparaître ceux cachés un par un.
        if (f.visible === true && p.hidden) drawProps.set(id, { ...p, hidden: false })
        c?.overrideOverlay({
          id, lock: flags.current.lock || !!p.lock, visible: isVisible(drawProps.get(id) ?? p),
          mode: (flags.current.magnet ? 'weak_magnet' : 'normal') as OverlayCreate['mode'],
        })
      })
      if (f.visible === true) scheduleSave()
    },
    copy: () => copySel(),
    paste: () => {
      if (!clipboard.length) return
      // Collé sur ce graphique, décalé de quelques bougies pour ne pas recouvrir l'original.
      pasteAll(clipboard, clipboard.some((d) => drawings.current.size && d.points.length) ? 5 : 0)
    },
    screenshot: () => {
      const c = chart.current
      if (!c) return
      const a = document.createElement('a')
      a.href = c.getConvertPictureUrl(true, 'png', theme === 'dark' ? '#131722' : '#ffffff')
      a.download = `${cfg.current.symbol}_${cfg.current.tf}.png`
      a.click()
    },
    goTo: (ts) => chart.current?.scrollToTimestamp(ts, 300),
    goToDate: async (ts) => {
      const c = chart.current
      if (!c || replay.current.active) return
      const list = c.getDataList()
      if (list.length && ts >= list[0].timestamp) {
        c.scrollToTimestamp(ts, 300)
        return
      }
      const { source, symbol, tf } = cfg.current
      const step = TF_MS[tf]
      if ((Date.now() - ts) / step > 60_000) {
        cb.current.onMessage('Date trop éloignée pour cette unité de temps : choisis une unité plus grande.', 'error')
        return
      }
      setLoading(true)
      try {
        const bars = await fetchCandles(source, symbol, tf, { start: ts - 300 * step })
        if (!bars.length) throw new Error('Pas de données à cette date pour ce symbole.')
        c.applyNewData(bars, true)
        c.scrollToTimestamp(Math.max(ts, bars[0].timestamp), 0)
      } catch (e) {
        cb.current.onMessage((e as Error).message, 'error')
      } finally {
        setLoading(false)
      }
    },
    setRange: (ms) => { pendingRange.current = ms },
    reload: () => setReload((n) => n + 1),
    zoom: (factor) => {
      const c = chart.current
      if (!c) return
      if (factor === 0) {
        c.setBarSpace(8)
        c.scrollToRealTime()
      } else c.setBarSpace(Math.min(50, Math.max(1, c.getBarSpace() * factor)))
    },
    pointerPrice: () => (pointer.current ? priceAt(pointer.current.x, pointer.current.y)?.price ?? null : null),
    lastPrice: () => {
      const list = chart.current?.getDataList() ?? []
      return list.length ? list[list.length - 1].close : 0
    },
    pickReplayStart: () => {
      replay.current.picking = true
      notify(true)
    },
    enterReplay: startReplay,
    exitReplay: () => stopReplay(true),
    play: (on) => {
      const r = replay.current
      if (!r.active || r.playing === on) return
      r.playing = on
      cancelAnimationFrame(r.raf)
      if (on) {
        r.last = performance.now()
        r.acc = 0
        r.raf = requestAnimationFrame(frame)
      }
      notify(true)
    },
    step: () => {
      if (!stepOnce()) cb.current.onMessage('Fin des données du replay.', 'info')
      if (!hovering.current) showLast()
      notify(true)
    },
    setSpeed: (v) => {
      replay.current.speed = v
      notify(true)
    },
  }))

  const tradable = active && session.context.symbol === config.symbol && session.context.source === config.source
  return (
    <div className={`pane${active ? ' active' : ''}`} onMouseDownCapture={onPick} onContextMenu={onMenu}
      onPointerMove={(e) => { const r = relative(e); pointer.current = r; trackPlus(r.x, r.y) }}
      onPointerDown={(e) => { if (e.pointerType !== 'mouse') { const r = relative(e); trackPlus(r.x, r.y) } }}
      onMouseLeave={() => { pointer.current = null; cancelAnimationFrame(plusRaf.current); setPlus(null) }}>
      <div ref={box} className="pane-chart" />
      <div className="pane-head">
        <span className="ph-sym">{config.symbol}</span>
        <span className="ph-tf">{TF_LABEL[config.tf]}</span>
        <span ref={head} className="ph-ohlc" />
        {tradable && <QuickTrade session={session} precision={config.precision} onMessage={onMessage} />}
      </div>
      {sel && !editor && sel.id !== drawingId.current && (
        <DrawToolbar key={sel.id} name={sel.name} label={findTool(sel.name)?.label ?? 'Dessin'} props={selProps()} points={selPoints()}
          text={String(chart.current?.getOverlayById(sel.id)?.extendData ?? '')} precision={config.precision}
          onChange={changeSel} onPoints={pointsSel}
          onText={(t) => {
            if (!t.trim()) chart.current?.removeOverlay(sel.id)
            else { chart.current?.overrideOverlay({ id: sel.id, extendData: t }); scheduleSave() }
          }}
          onAlert={alertSel} onDelete={() => chart.current?.removeOverlay(sel.id)} onClone={cloneSel} onCopy={copySel} onOrder={orderSel} />
      )}
      {editor && (
        <textarea className="text-editor" autoFocus value={editor.value} placeholder="Ajouter du texte"
          style={{ left: editor.x, top: editor.y - editor.size, fontSize: editor.size, color: editor.color }}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => setEditor({ ...editor, value: e.target.value })}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); closeEditor(true) }
            if (e.key === 'Escape') closeEditor(false)
          }}
          onBlur={() => closeEditor(true)} />
      )}
      {selAlert && (() => {
        const a = alerts.alerts.find((x) => x.id === selAlert)
        if (!a || a.symbol !== config.symbol || a.source !== config.source) return null
        return (
          <div className="alert-bar" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
            <Icon name="alarm" size={15} />
            <b>{a.symbol}</b>
            <select value={a.condition} onChange={(e) => alerts.update(a.id, { condition: e.target.value as typeof a.condition })} title="Condition">
              <option value="cross">Croisement</option><option value="above">Au-dessus de</option><option value="below">En dessous de</option>
            </select>
            <input key={`${a.id}:${a.price}`} defaultValue={a.price.toFixed(config.precision)} inputMode="decimal" title="Prix de l'alerte (Entrée pour valider)"
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return
                const v = Number((e.target as HTMLInputElement).value.replace(',', '.'))
                if (v > 0) alerts.update(a.id, { price: v, active: true })
              }}
              onBlur={(e) => {
                const v = Number(e.target.value.replace(',', '.'))
                if (v > 0 && v !== a.price) alerts.update(a.id, { price: v, active: true })
              }} />
            <button className="icon" title={a.active ? 'Mettre en pause' : 'Réactiver'} onClick={() => alerts.update(a.id, { active: !a.active })}>
              <Icon name={a.active ? 'pause' : 'play'} size={15} />
            </button>
            <button className="icon" title="Plus de réglages (message, une fois / à chaque fois)" onClick={() => cb.current.onEditAlert(a.id)}><Icon name="gear" size={15} /></button>
            <button className="icon danger" title="Supprimer l'alerte" onClick={() => { alerts.remove(a.id); setSelAlert(null) }}><Icon name="trash" size={15} /></button>
            <button className="icon" title="Fermer (l'alerte reste active)" onClick={() => setSelAlert(null)}><Icon name="close" size={14} /></button>
          </div>
        )
      })()}
      {plus && !replay.current.picking && (
        <button className="price-plus" style={{ left: plus.x, top: plus.y }} title="Alerte, ordre ou ligne à ce prix"
          onPointerDown={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onClick={openPlus}><Icon name="plus" size={13} /></button>
      )}
      {loading && <div className="pane-loading"><span className="spinner" />Chargement…</div>}
    </div>
  )
})

export default ChartPane
