// Un graphique : chargement des données, temps réel, dessins, alertes, indicateurs et mode replay.
// Tout le rendu passe par un canvas (klinecharts) ; React ne redessine jamais les bougies.
import { dispose, init, type ActionType, type Chart, type OverlayCreate, type OverlayEvent } from 'klinecharts'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, useSyncExternalStore } from 'react'
import { api, fetchCandles, fmt, openStream, TF_LABEL, TF_MS, type Bar } from './api'
import { Icon } from './icons'
import { INDICATORS, registerTools, TEXT_TOOLS } from './overlays'
import type { TradingSession } from './session'
import { alerts, quotes, type PaneConfig } from './stores'

export type { PaneConfig }

export interface ReplayState {
  active: boolean
  playing: boolean
  time: number
  left: number
  speed: number
  picking: boolean
}

export interface DrawStyle { color: string; size: number }

export interface SavedDrawing {
  name: string
  points: { timestamp?: number; value?: number }[]
  extendData?: unknown
  style?: DrawStyle
}

export interface PaneHandle {
  toggleIndicator: (id: string) => string[]
  indicators: () => string[]
  draw: (tool: string, data?: unknown) => void
  cancelDraw: () => void
  removeSelected: () => void
  clearDrawings: () => void
  restoreDrawings: (list: SavedDrawing[]) => void
  addHorizontalLine: (price: number) => void
  setFlags: (flags: { magnet?: boolean; lock?: boolean; visible?: boolean }) => void
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
}

const IDLE: ReplayState = { active: false, playing: false, time: 0, left: 0, speed: 4, picking: false }
const REPLAY_MAX_BARS = 60_000
const ALERT_COLOR = '#f5b800'
const DRAW_COLORS = ['#2962ff', '#26a69a', '#ef5350', '#f5b800', '#ff9800', '#9c27b0', '#ffffff', '#787b86']
const DRAW_SIZES = [1, 2, 4]

const tint = (color: string, alpha: number): string => {
  const n = parseInt(color.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}
/** Styles d'un dessin pour une couleur et une épaisseur données. */
function drawStyles(name: string, st: DrawStyle): OverlayCreate['styles'] {
  const shape = { color: tint(st.color, 0.15), borderColor: st.color, borderSize: st.size }
  const text = name === 'simpleAnnotation' || name === 'simpleTag' ? { backgroundColor: st.color } : { color: st.color }
  return { line: { color: st.color, size: st.size }, polygon: shape, circle: shape, rect: shape, arc: { color: st.color, size: st.size }, text } as OverlayCreate['styles']
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
  const { config, theme, chartType, active, session, onActivate, onReplay, onMessage, onDrawings, onContext } = props
  const box = useRef<HTMLDivElement>(null)
  const head = useRef<HTMLSpanElement>(null)
  const chart = useRef<Chart | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [sel, setSel] = useState<{ id: string; name: string; color: string; size: number } | null>(null)

  // État impératif (aucun re-rendu React pendant la lecture ou le temps réel).
  const cfg = useRef(config)
  cfg.current = config
  const cb = useRef({ onReplay, onMessage, onActivate, onDrawings, onContext, session, active })
  cb.current = { onReplay, onMessage, onActivate, onDrawings, onContext, session, active }
  const drawings = useRef(new Map<string, string>())      // id -> nom de l'outil
  const indicatorPanes = useRef(new Map<string, string>()) // indicateur -> id de fenêtre
  const flags = useRef({ magnet: false, lock: false, visible: true })
  const selected = useRef<string | null>(null)
  const styleMap = useRef(new Map<string, DrawStyle>())   // id -> couleur et épaisseur choisies
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
  const collect = (): SavedDrawing[] => {
    const c = chart.current
    const data: SavedDrawing[] = []
    if (!c) return data
    drawings.current.forEach((name, id) => {
      if (id === drawingId.current) return // dessin en cours de tracé : pas encore un vrai dessin
      const o = c.getOverlayById(id)
      const style = styleMap.current.get(id)
      if (o) data.push({ name, points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })), extendData: o.extendData, ...(style ? { style } : {}) })
    })
    return data
  }

  const scheduleSave = (): void => {
    window.clearTimeout(saveTimer.current)
    const { source, symbol } = cfg.current
    saveTimer.current = window.setTimeout(() => {
      if (!chart.current) return
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

  const overlayEvents = (): Partial<OverlayCreate> => ({
    onDrawEnd: () => {
      drawingId.current = null
      scheduleSave()
      return false
    },
    onPressedMoveEnd: () => {
      scheduleSave()
      return false
    },
    onSelected: (e: OverlayEvent) => {
      selected.current = e.overlay.id
      const st = styleMap.current.get(e.overlay.id)
      setSel({ id: e.overlay.id, name: e.overlay.name, color: st?.color ?? DRAW_COLORS[0], size: st?.size ?? 1 })
      return false
    },
    onDeselected: () => {
      selected.current = null
      setSel(null)
      return false
    },
    onRemoved: (e: OverlayEvent) => {
      drawings.current.delete(e.overlay.id)
      styleMap.current.delete(e.overlay.id)
      setSel((s) => (s?.id === e.overlay.id ? null : s))
      scheduleSave()
      return false
    },
    // Le clic droit ouvre notre menu : il ne supprime plus le dessin (Suppr le fait).
    onRightClick: () => true,
  })

  const addDrawing = (o: OverlayCreate, style?: DrawStyle): string | null => {
    const c = chart.current
    if (!c) return null
    const id = c.createOverlay({
      ...o,
      ...(style ? { styles: drawStyles(o.name, style) } : {}),
      ...overlayEvents(),
      lock: flags.current.lock,
      visible: flags.current.visible,
      mode: (flags.current.magnet ? 'weak_magnet' : 'normal') as OverlayCreate['mode'],
    }) as string | null
    if (id) drawings.current.set(id, o.name)
    if (id && style) styleMap.current.set(id, style)
    return id
  }

  /** Change la couleur ou l'épaisseur du dessin sélectionné. */
  const restyle = (patch: Partial<DrawStyle>): void => {
    if (!sel) return
    const style = { color: patch.color ?? sel.color, size: patch.size ?? sel.size }
    chart.current?.overrideOverlay({ id: sel.id, styles: drawStyles(sel.name, style) })
    styleMap.current.set(sel.id, style)
    setSel({ ...sel, ...style })
    scheduleSave()
  }
  const retext = (): void => {
    if (!sel) return
    const o = chart.current?.getOverlayById(sel.id)
    const text = window.prompt('Nouveau texte :', String(o?.extendData ?? ''))
    if (!text) return
    chart.current?.overrideOverlay({ id: sel.id, extendData: text })
    scheduleSave()
  }

  const wipeDrawings = (): void => {
    const c = chart.current
    const ids = [...drawings.current.keys()]
    drawings.current.clear()
    styleMap.current.clear()
    drawingId.current = null
    setSel(null)
    ids.forEach((id) => c?.removeOverlay(id))
  }

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
    let key = ''
    const onChange = (): void => {
      const c = chart.current
      if (!c) return
      const mine = alerts.alerts.filter((a) => a.source === cfg.current.source && a.symbol === cfg.current.symbol)
      const k = mine.map((a) => `${a.id}:${a.price}:${a.active}:${a.condition}`).join(',')
      if (k === key) return
      key = k
      c.removeOverlay({ groupId: 'alert' })
      const d = cfg.current.precision
      mine.forEach((a) => priceLine('alert', a.price, `🔔 ${a.price.toFixed(d)}${a.active ? '' : ' (en pause)'}`, a.active ? ALERT_COLOR : '#787b86', false,
        (v) => alerts.update(a.id, { price: v })))
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
        if (range !== null) fit(Math.min(bars.length, wanted))
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
    snapshot.current = '[]'
    void api<SavedDrawing[]>(`/api/drawings?source=${encodeURIComponent(config.source)}&symbol=${encodeURIComponent(config.symbol)}`)
      .then((list) => {
        if (dead) return
        list.forEach((d) => addDrawing({ name: d.name, points: d.points, extendData: d.extendData }, d.style))
        snapshot.current = JSON.stringify(list)
      })
      .catch(() => undefined)
    return () => {
      dead = true
      window.clearTimeout(saveTimer.current)
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
  const relative = (e: React.MouseEvent): { x: number; y: number } => {
    const rect = box.current!.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPick = (e: React.MouseEvent): void => {
    onActivate()
    const r = replay.current
    if (!r.picking || e.button !== 0) return
    const { x, y } = relative(e)
    const ts = priceAt(x, y)?.timestamp
    r.picking = false
    if (ts) void startReplay(ts)
    else notify(true)
  }

  const onMenu = (e: React.MouseEvent): void => {
    e.preventDefault()
    const { x, y } = relative(e)
    const at = priceAt(x, y)
    if (at) cb.current.onContext({ x: e.clientX, y: e.clientY, price: at.price })
  }

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
    draw: (tool, data) => {
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
    },
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
      drawings.current.forEach((_, id) => c?.overrideOverlay({
        id, lock: flags.current.lock, visible: flags.current.visible,
        mode: (flags.current.magnet ? 'weak_magnet' : 'normal') as OverlayCreate['mode'],
      }))
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
      onMouseMove={(e) => { pointer.current = relative(e) }} onMouseLeave={() => { pointer.current = null }}>
      <div ref={box} className="pane-chart" />
      <div className="pane-head">
        <span className="ph-sym">{config.symbol}</span>
        <span className="ph-tf">{TF_LABEL[config.tf]}</span>
        <span ref={head} className="ph-ohlc" />
        {tradable && <QuickTrade session={session} precision={config.precision} onMessage={onMessage} />}
      </div>
      {sel && (
        <div className="draw-bar" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
          {DRAW_COLORS.map((c) => (
            <button key={c} className={`swatch${sel.color === c ? ' on' : ''}`} style={{ background: c }} title="Couleur du dessin" onClick={() => restyle({ color: c })} />
          ))}
          <span className="vsep" />
          {DRAW_SIZES.map((n) => (
            <button key={n} className={`icon${sel.size === n ? ' on' : ''}`} title={`Épaisseur ${n}`} onClick={() => restyle({ size: n })}>
              <span className="stroke" style={{ height: n }} />
            </button>
          ))}
          {(TEXT_TOOLS.has(sel.name)) && (
            <button className="icon" title="Modifier le texte" onClick={retext}><Icon name="edit" size={15} /></button>
          )}
          <span className="vsep" />
          <button className="icon danger" title="Supprimer ce dessin (Suppr)" onClick={() => chart.current?.removeOverlay(sel.id)}><Icon name="trash" size={15} /></button>
        </div>
      )}
      {loading && <div className="pane-loading"><span className="spinner" />Chargement…</div>}
    </div>
  )
})

export default ChartPane
