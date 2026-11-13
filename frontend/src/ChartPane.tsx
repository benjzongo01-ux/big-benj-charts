// Un graphique : chargement des données, temps réel, dessins, indicateurs et mode replay.
// Tout le rendu passe par un canvas (klinecharts) ; React ne redessine jamais les bougies.
import { dispose, init, type Chart, type OverlayCreate, type OverlayEvent } from 'klinecharts'
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { api, fetchCandles, openStream, TF_MS, type Bar } from './api'
import { INDICATORS, registerTools, TEXT_TOOLS } from './overlays'
import type { TradingSession } from './session'

export interface PaneConfig {
  source: string
  symbol: string
  tf: string
  precision: number
}

export interface ReplayState {
  active: boolean
  playing: boolean
  time: number
  left: number
  speed: number
  picking: boolean
}

export interface PaneHandle {
  toggleIndicator: (id: string) => string[]
  indicators: () => string[]
  draw: (tool: string) => void
  cancelDraw: () => void
  removeSelected: () => void
  clearDrawings: () => void
  setFlags: (flags: { magnet?: boolean; lock?: boolean; visible?: boolean }) => void
  screenshot: () => void
  goTo: (ts: number) => void
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
}

interface SavedDrawing {
  name: string
  points: { timestamp?: number; value?: number }[]
  extendData?: unknown
}

const IDLE: ReplayState = { active: false, playing: false, time: 0, left: 0, speed: 4, picking: false }
const REPLAY_MAX_BARS = 60_000

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
      tooltip: { text: { color: text } },
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

const ChartPane = forwardRef<PaneHandle, Props>(function ChartPane(props, ref) {
  const { config, theme, chartType, active, session, onActivate, onReplay, onMessage } = props
  const box = useRef<HTMLDivElement>(null)
  const chart = useRef<Chart | null>(null)
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)

  // État impératif (aucun re-rendu React pendant la lecture ou le temps réel).
  const cfg = useRef(config)
  cfg.current = config
  const cb = useRef({ onReplay, onMessage, onActivate, session, active })
  cb.current = { onReplay, onMessage, onActivate, session, active }
  const drawings = useRef(new Map<string, string>())      // id -> nom de l'outil
  const indicatorPanes = useRef(new Map<string, string>()) // indicateur -> id de fenêtre
  const flags = useRef({ magnet: false, lock: false, visible: true })
  const selected = useRef<string | null>(null)
  const drawingId = useRef<string | null>(null)
  const saveTimer = useRef(0)
  const stopStream = useRef<(() => void) | null>(null)
  const replay = useRef({ active: false, playing: false, bars: [] as Bar[], idx: 0, speed: 4, acc: 0, last: 0, raf: 0, picking: false, notified: 0 })

  // ---------------------------------------------------------------- création du graphique
  useEffect(() => {
    registerTools()
    const c = init(box.current!, { locale: 'fr-FR' })!
    chart.current = c
    c.setOffsetRightDistance(80)
    props.initialIndicators.forEach((id) => {
      const main = INDICATORS.find((i) => i.id === id)?.main
      const pane = main ? c.createIndicator(id, true, { id: 'candle_pane' }) : c.createIndicator(id, false, { height: id === 'VOL' ? 80 : 110 })
      indicatorPanes.current.set(id, pane ?? 'candle_pane')
    })
    const ro = new ResizeObserver(() => c.resize())
    ro.observe(box.current!)
    return () => {
      ro.disconnect()
      dispose(box.current!)
      indicatorPanes.current.clear()
      chart.current = null
    }
  }, [])

  useEffect(() => {
    chart.current?.setStyles(theme)
    chart.current?.setStyles(themeStyles(theme, chartType))
  }, [theme, chartType])

  // ---------------------------------------------------------------- dessins
  const scheduleSave = (): void => {
    window.clearTimeout(saveTimer.current)
    const { source, symbol } = cfg.current
    saveTimer.current = window.setTimeout(() => {
      const c = chart.current
      if (!c) return
      const data: SavedDrawing[] = []
      drawings.current.forEach((name, id) => {
        const o = c.getOverlayById(id)
        if (o) data.push({ name, points: o.points.map((p) => ({ timestamp: p.timestamp, value: p.value })), extendData: o.extendData })
      })
      void api(`/api/drawings?source=${encodeURIComponent(source)}&symbol=${encodeURIComponent(symbol)}`, 'PUT', data).catch(() => undefined)
    }, 400)
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
      return false
    },
    onDeselected: () => {
      selected.current = null
      return false
    },
    onRemoved: (e: OverlayEvent) => {
      drawings.current.delete(e.overlay.id)
      scheduleSave()
      return false
    },
  })

  const addDrawing = (o: OverlayCreate): string | null => {
    const c = chart.current
    if (!c) return null
    const id = c.createOverlay({
      ...o,
      ...overlayEvents(),
      lock: flags.current.lock,
      visible: flags.current.visible,
      mode: (flags.current.magnet ? 'weak_magnet' : 'normal') as OverlayCreate['mode'],
    }) as string | null
    if (id) drawings.current.set(id, o.name)
    return id
  }

  const wipeDrawings = (): void => {
    const c = chart.current
    const ids = [...drawings.current.keys()]
    drawings.current.clear()
    ids.forEach((id) => c?.removeOverlay(id))
  }

  // ---------------------------------------------------------------- lignes d'ordres (trading)
  useEffect(() => {
    const sync = (): void => {
      const c = chart.current
      if (!c) return
      c.removeOverlay({ groupId: 'trade' })
      const s = cb.current.session
      if (!cb.current.active || s.context.symbol !== cfg.current.symbol) return
      const t = s.time || Date.now()
      const line = (value: number, text: string, color: string, locked: boolean, onMove?: (v: number) => void): void => {
        c.createOverlay({
          name: 'tradeLine', groupId: 'trade', lock: locked, points: [{ timestamp: t, value }], extendData: { text, color },
          onPressedMoveEnd: (e: OverlayEvent) => {
            const v = e.overlay.points[0]?.value
            if (v !== undefined && onMove) onMove(v)
            return false
          },
          onRightClick: () => true,
        })
      }
      const d = cfg.current.precision
      s.positions.forEach((p) => {
        line(p.entry, `${p.side === 1 ? 'Achat' : 'Vente'} ${p.size.toFixed(4)} @ ${p.entry.toFixed(d)}`, '#2962ff', true)
        if (p.sl !== null) line(p.sl, `Stop ${p.sl.toFixed(d)}`, '#ef5350', false, (v) => s.modify(p.id, { sl: v }))
        if (p.tp !== null) line(p.tp, `Objectif ${p.tp.toFixed(d)}`, '#26a69a', false, (v) => s.modify(p.id, { tp: v }))
      })
      s.orders.forEach((o) => line(o.price, `${o.side === 1 ? 'Achat' : 'Vente'} ${o.type} ${o.price.toFixed(d)}`, '#f7931a', false, (v) => s.modifyOrder(o.id, v)))
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
  }, [session, active, config.symbol])

  // ---------------------------------------------------------------- données + temps réel
  // Le prix n'alimente la session de trading que si elle suit bien ce graphique.
  const feed = (price: number): void => {
    const s = cb.current.session
    if (cb.current.active && s.context.symbol === cfg.current.symbol && s.context.source === cfg.current.source) s.onPrice(price, Date.now())
  }

  useEffect(() => {
    const c = chart.current
    if (!c) return
    let dead = false
    const { source, symbol, tf, precision } = config
    setLoading(true)
    c.setPriceVolumePrecision(precision, 2)
    ;(async () => {
      try {
        // Dukascopy est lent au premier téléchargement : on commence par moins de bougies.
        const bars = await fetchCandles(source, symbol, tf, { limit: source === 'dukascopy' ? 600 : 3000 })
        if (dead) return
        c.applyNewData(bars, bars.length > 0)
        if (bars.length) feed(bars[bars.length - 1].close)
        c.loadMore((ts) => {
          if (ts === null || replay.current.active) return
          void fetchCandles(source, symbol, tf, { end: ts - 1, limit: source === 'dukascopy' ? 600 : 3000 })
            .then((older) => !dead && c.applyMoreData(older, older.length > 0))
            .catch(() => !dead && c.applyMoreData([], false))
        })
        stopStream.current = openStream(source, symbol, tf, (bar) => {
          if (dead || replay.current.active) return
          c.updateData(bar)
          feed(bar.close)
        })
      } catch (e) {
        if (!dead) {
          c.applyNewData([], false)
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
      stopReplay(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.source, config.symbol, config.tf, reload])

  // Dessins sauvegardés : rechargés à chaque changement de symbole.
  useEffect(() => {
    let dead = false
    wipeDrawings()
    void api<SavedDrawing[]>(`/api/drawings?source=${encodeURIComponent(config.source)}&symbol=${encodeURIComponent(config.symbol)}`)
      .then((list) => {
        if (dead) return
        list.forEach((d) => addDrawing({ name: d.name, points: d.points, extendData: d.extendData }))
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
      time: r.active && r.idx > 0 ? r.bars[r.idx - 1].timestamp : 0, left: r.active ? r.bars.length - r.idx : 0,
    })
  }

  const stepOnce = (): boolean => {
    const r = replay.current
    const c = chart.current
    if (!c || !r.active || r.idx >= r.bars.length) return false
    const bar = r.bars[r.idx++]
    c.updateData(bar)
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
    notify(!r.playing)
    if (r.playing) r.raf = requestAnimationFrame(frame)
  }

  function stopReplay(reloadLive: boolean): void {
    const r = replay.current
    cancelAnimationFrame(r.raf)
    const was = r.active || r.picking
    Object.assign(r, { active: false, playing: false, bars: [], idx: 0, picking: false })
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
      Object.assign(r, { active: true, playing: false, bars, idx, acc: 0, picking: false })
      c.applyNewData(bars.slice(0, idx), false)
      c.scrollToRealTime()
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

  // Choix de la date de départ en cliquant sur le graphique.
  const onPick = (e: React.MouseEvent): void => {
    onActivate()
    const r = replay.current
    const c = chart.current
    if (!r.picking || !c) return
    const rect = box.current!.getBoundingClientRect()
    const pt = c.convertFromPixel([{ x: e.clientX - rect.left, y: e.clientY - rect.top }], { paneId: 'candle_pane' }) as { timestamp?: number }[]
    const ts = pt[0]?.timestamp
    r.picking = false
    if (ts) void startReplay(ts)
    else notify(true)
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
        const pane = main ? c.createIndicator(id, true, { id: 'candle_pane' }) : c.createIndicator(id, false, { height: 110 })
        map.set(id, pane ?? 'candle_pane')
      }
      return [...map.keys()]
    },
    draw: (tool) => {
      const c = chart.current
      if (!c) return
      if (drawingId.current) c.removeOverlay(drawingId.current)
      let extendData: unknown
      if (TEXT_TOOLS.has(tool)) {
        const text = window.prompt('Texte à afficher :', '')
        if (!text) return
        extendData = text
      }
      drawingId.current = addDrawing({ name: tool, extendData })
    },
    cancelDraw: () => {
      if (drawingId.current) {
        drawings.current.delete(drawingId.current)
        chart.current?.removeOverlay(drawingId.current)
        drawingId.current = null
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
      notify(true)
    },
    setSpeed: (v) => {
      replay.current.speed = v
      notify(true)
    },
  }))

  return (
    <div className={`pane${active ? ' active' : ''}`} onMouseDownCapture={onPick}>
      <div className="pane-title">{config.symbol} · {config.tf}</div>
      <div ref={box} className="pane-chart" />
      {loading && <div className="pane-loading"><span className="spinner" />Chargement…</div>}
    </div>
  )
})

export default ChartPane
