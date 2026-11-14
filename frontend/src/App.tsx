// Écran principal : barre du haut, outils de dessin, favoris, graphiques, panneau de droite, panneau du bas.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { api, fmt, fmtDate, getToken, setToken, TF_LABEL, TIMEFRAMES, type SourceInfo } from './api'
import BottomPanel from './BottomPanel'
import ChartPane, { type PaneHandle, type ReplayState, type SavedDrawing } from './ChartPane'
import { AlertDialog, Login, SymbolSearch, type AlertDraft } from './Dialogs'
import { googleEmail, initGoogle, signOutGoogle, type FirebaseWebConfig } from './google'
import { hasIcon, Icon } from './icons'
import { initPush } from './push'
import { DEFAULT_FAVORITES, EMOJIS, findTool, GROUP_ICON, INDICATORS, TOOL_GROUPS, TOOL_ICON } from './overlays'
import RightPanel, { SIDE_MAX, SIDE_MIN, type SideTab } from './RightPanel'
import { TradingSession } from './session'
import { alerts, history, loadPref, savePref, type Alert, type HistoryEntry, type PaneConfig, type WatchItem } from './stores'

interface Settings {
  theme: 'dark' | 'light'
  chartType: string
  layout: 1 | 2 | 4
  panes: PaneConfig[]
  watchlist: WatchItem[]
  indicators: string[]
  /** Version de la liste par défaut (sert à migrer les anciennes listes). */
  watchVersion?: number
}
interface Layout {
  side: SideTab | null
  sideWidth: number
  favorites: string[]
  favPos: { x: number; y: number }
}
interface Toast { id: number; text: string; kind: 'error' | 'info' }
interface ChartMenu { x: number; y: number; price: number }

const DEFAULT_WATCH: WatchItem[] = [
  { source: 'binance', symbol: 'BTCUSDT', tf: '1h', precision: 2, name: 'Bitcoin', market: 'crypto' },
  { source: 'binance', symbol: 'ETHUSDT', tf: '1h', precision: 2, name: 'Ethereum', market: 'crypto' },
  { source: 'binance', symbol: 'SOLUSDT', tf: '1h', precision: 2, name: 'Solana', market: 'crypto' },
  { source: 'fx', symbol: 'EURUSD', tf: '1h', precision: 5, name: 'Euro / Dollar', market: 'forex' },
  { source: 'fx', symbol: 'GBPUSD', tf: '1h', precision: 5, name: 'Livre / Dollar', market: 'forex' },
  { source: 'fx', symbol: 'USDJPY', tf: '1h', precision: 3, name: 'Dollar / Yen', market: 'forex' },
  { source: 'binance', symbol: 'XAUUSDT', tf: '1h', precision: 2, name: 'Or (XAU/USD)', market: 'matieres' },
  { source: 'binance', symbol: 'XAGUSDT', tf: '1h', precision: 2, name: 'Argent (XAG/USD)', market: 'matieres' },
  { source: 'binance', symbol: 'CLUSDT', tf: '1h', precision: 2, name: 'Pétrole WTI', market: 'matieres' },
]
const WATCH_VERSION = 2
const DEFAULTS: Settings = {
  theme: 'dark', chartType: 'candle_solid', layout: 1, watchlist: DEFAULT_WATCH, indicators: ['VOL'], watchVersion: WATCH_VERSION,
  panes: [
    { source: 'binance', symbol: 'BTCUSDT', tf: '1h', precision: 2 }, { source: 'binance', symbol: 'XAUUSDT', tf: '1h', precision: 2 },
    { source: 'fx', symbol: 'EURUSD', tf: '1h', precision: 5 }, { source: 'binance', symbol: 'ETHUSDT', tf: '1h', precision: 2 },
  ],
}

/** Met à jour d'anciens réglages : les actions et les sources retirées disparaissent, l'or et le forex rapides arrivent. */
function migrate(s: Settings, valid?: Set<string>): Settings {
  const old = s.watchVersion !== WATCH_VERSION
  let watchlist = s.watchlist
  if (old) {
    const keep = watchlist.filter((w) => w.source === 'binance')
    watchlist = [...keep, ...DEFAULT_WATCH.filter((d) => !keep.some((k) => k.symbol === d.symbol))]
  }
  if (valid) watchlist = watchlist.filter((w) => valid.has(w.source))
  const panes = s.panes.map((p, i) => ((valid && !valid.has(p.source)) || (old && p.source !== 'binance') ? DEFAULTS.panes[i] : p))
  return { ...s, watchlist, panes, watchVersion: WATCH_VERSION }
}
const DEFAULT_LAYOUT: Layout = { side: 'watch', sideWidth: 300, favorites: DEFAULT_FAVORITES, favPos: { x: 60, y: 44 } }
const CHART_TYPES = [
  ['candle_solid', 'Bougies'], ['candle_stroke', 'Bougies creuses'], ['candle_up_stroke', 'Hausse creuse'],
  ['ohlc', 'Barres'], ['area', 'Ligne'],
]
const SPEEDS = [1, 2, 4, 10, 30, 100]
const DAY = 86_400_000
/** Boutons de période : libellé, durée affichée, unité de temps choisie pour que tout tienne à l'écran. */
const RANGES: [string, () => number, string][] = [
  ['1J', () => DAY, '5m'], ['5J', () => 5 * DAY, '15m'], ['1M', () => 30 * DAY, '1h'], ['3M', () => 91 * DAY, '4h'],
  ['6M', () => 182 * DAY, '1d'], ['YTD', () => Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1), '1d'],
  ['1A', () => 365 * DAY, '1d'], ['5A', () => 5 * 365 * DAY, '1w'], ['Tout', () => Infinity, '1w'],
]

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bbc_settings') ?? '{}') } as Settings
    if (!Array.isArray(s.panes) || s.panes.length < 4) s.panes = DEFAULTS.panes
    if (!Array.isArray(s.watchlist)) s.watchlist = DEFAULT_WATCH
    if (!Array.isArray(s.indicators)) s.indicators = ['VOL']
    return migrate(s)
  } catch {
    return DEFAULTS
  }
}

/** Icône d'un outil : tracé SVG s'il existe, sinon son symbole texte. */
function ToolIcon({ id, size = 18 }: { id: string; size?: number }): JSX.Element {
  const name = TOOL_ICON[id]
  return name && hasIcon(name) ? <Icon name={name} size={size} /> : <span className="glyph">{findTool(id)?.icon ?? '?'}</span>
}

/** Heure UTC en direct (une mise à jour par seconde, isolée du reste de l'écran). */
function UtcClock(): JSX.Element {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000)
    return () => window.clearInterval(t)
  }, [])
  return <span className="clock" title="Heure universelle (UTC)">{now.toISOString().slice(11, 19)} UTC</span>
}

/** Barre de favoris flottante, déplaçable par sa poignée. */
function Favorites(props: {
  tools: string[]; pos: { x: number; y: number }; onMove: (p: { x: number; y: number }) => void
  onDraw: (tool: string) => void; onMenu: (e: React.MouseEvent, tool: string) => void
}): JSX.Element | null {
  const el = useRef<HTMLDivElement>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const clamp = useCallback((x: number, y: number): { x: number; y: number } => {
    const parent = el.current?.parentElement
    if (!parent || !el.current) return { x, y }
    return {
      x: Math.min(Math.max(0, x), Math.max(0, parent.clientWidth - el.current.offsetWidth)),
      y: Math.min(Math.max(0, y), Math.max(0, parent.clientHeight - el.current.offsetHeight)),
    }
  }, [])
  // Position affichée : celle mémorisée, ramenée dans la zone visible si la fenêtre a rétréci.
  // La position mémorisée, elle, ne change que quand l'utilisateur déplace la barre.
  const [shown, setShown] = useState(props.pos)
  useEffect(() => {
    const fix = (): void => setShown(clamp(props.pos.x, props.pos.y))
    fix()
    const parent = el.current?.parentElement
    const ro = parent ? new ResizeObserver(fix) : null
    if (parent) ro?.observe(parent)
    return () => ro?.disconnect()
  }, [props.pos.x, props.pos.y, props.tools.length, clamp])
  if (!props.tools.length) return null
  return (
    <div ref={el} className="favs" style={{ left: shown.x, top: shown.y }} onClick={(e) => e.stopPropagation()}>
      <div className="favs-grip" title="Glisser pour déplacer la barre de favoris"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          drag.current = { dx: e.clientX - shown.x, dy: e.clientY - shown.y }
        }}
        onPointerMove={(e) => { if (drag.current) props.onMove(clamp(e.clientX - drag.current.dx, e.clientY - drag.current.dy)) }}
        onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}>
        <Icon name="grip" size={16} />
      </div>
      {props.tools.map((id) => (
        <button key={id} className="icon" title={`${findTool(id)?.label ?? id} · clic droit pour retirer des favoris`}
          onClick={() => props.onDraw(id)} onContextMenu={(e) => props.onMenu(e, id)}><ToolIcon id={id} /></button>
      ))}
    </div>
  )
}

export default function App(): JSX.Element {
  const [ready, setReady] = useState<'boot' | 'login' | 'ok'>('boot')
  const [google, setGoogle] = useState(false)
  const googleReady = useRef(false)
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [layout, setLayout] = useState<Layout>(() => {
    const l = loadPref('bbc_layout', DEFAULT_LAYOUT)
    if (!Array.isArray(l.favorites)) l.favorites = DEFAULT_FAVORITES
    if (window.innerWidth < 1000) l.side = null
    return l
  })
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [menu, setMenu] = useState<string | null>(null)          // menu ouvert dans la barre du haut
  const [flyout, setFlyout] = useState<string | null>(null)      // sous-menu ouvert dans la barre de gauche
  const [toolMenu, setToolMenu] = useState<{ x: number; y: number; tool: string } | null>(null)
  const [chartMenu, setChartMenu] = useState<ChartMenu | null>(null)
  const [alertDraft, setAlertDraft] = useState<AlertDraft | null>(null)
  const [indicators, setIndicators] = useState<string[]>(settings.indicators)
  const [flags, setFlags] = useState({ magnet: false, lock: false, visible: true })
  const [replay, setReplay] = useState<ReplayState>({ active: false, playing: false, time: 0, left: 0, speed: 4, picking: false })
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayDate, setReplayDate] = useState('')
  const [gotoOpen, setGotoOpen] = useState(false)
  const [gotoDate, setGotoDate] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const session = useMemo(() => new TradingSession(), [])
  const panes = useRef<(PaneHandle | null)[]>([])
  useSyncExternalStore(history.subscribe, history.getVersion)
  const idx = Math.min(activeIdx, settings.layout - 1)
  const current = settings.panes[idx]
  const pane = useCallback((): PaneHandle | null => panes.current[idx] ?? null, [idx])

  const message = useCallback((text: string, kind: 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, text, kind }])
    if (kind === 'error') alerts.notify(text, 'error')
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000)
  }, [])

  // Démarrage : mode d'authentification, réglages sauvegardés, sources disponibles, alertes.
  const boot = useCallback(async () => {
    try {
      const conf = await api<{ auth_required: boolean; firebase: FirebaseWebConfig | null }>('/api/auth/config')
      if (conf.firebase) {
        // Version en ligne : la session Google est restaurée si elle existe, sinon écran de connexion.
        setGoogle(true)
        if (!googleReady.current) {
          const signedIn = await initGoogle(conf.firebase)
          googleReady.current = true
          if (!signedIn) {
            setReady('login')
            return
          }
        } else if (!getToken()) {
          setReady('login')
          return
        }
      } else if (conf.auth_required) {
        try {
          await api('/api/auth/me')
        } catch {
          setToken('')
          setReady('login')
          return
        }
      }
      const [srcs, saved] = await Promise.all([api<SourceInfo[]>('/api/sources'), api<Partial<Settings>>('/api/settings')])
      setSources(srcs)
      const valid = new Set(srcs.map((x) => x.name))
      // La version vient des réglages enregistrés : d'anciens réglages du serveur doivent être migrés eux aussi.
      setSettings((s) => migrate(saved && Array.isArray(saved.panes) && saved.panes.length >= 4 ? { ...s, ...saved, watchVersion: saved.watchVersion } : s, valid))
      if (!alerts.loaded) {
        alerts.onTrigger = (text) => message(text)
        void alerts.load()
        void initPush(conf.firebase, (body, tag) => alerts.external(body, tag))
      }
      setReady('ok')
    } catch (e) {
      message((e as Error).message, 'error')
      setReady('ok')
    }
  }, [message])
  useEffect(() => { void boot() }, [boot])

  // Sauvegarde des réglages (navigateur tout de suite, serveur avec un léger délai) et de la disposition.
  useEffect(() => {
    if (ready !== 'ok') return
    savePref('bbc_settings', settings)
    const t = window.setTimeout(() => void api('/api/settings', 'PUT', settings).catch(() => undefined), 800)
    return () => window.clearTimeout(t)
  }, [settings, ready])
  useEffect(() => savePref('bbc_layout', layout), [layout])
  useEffect(() => { document.documentElement.dataset.theme = settings.theme }, [settings.theme])

  // La session de trading suit le symbole du graphique actif (hors replay).
  useEffect(() => {
    if (replay.active) return
    const c = session.context
    if (c.source !== current.source || c.symbol !== current.symbol) session.reset({ source: current.source, symbol: current.symbol, tf: current.tf })
    else c.tf = current.tf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.source, current.symbol, current.tf, replay.active])

  useEffect(() => {
    const list = pane()?.indicators()
    if (list) setIndicators(list)
  }, [pane, settings.layout])

  const update = (patch: Partial<Settings>): void => setSettings((s) => ({ ...s, ...patch }))
  const setPane = (patch: Partial<PaneConfig>): void =>
    setSettings((s) => ({ ...s, panes: s.panes.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }))
  const patchLayout = (patch: Partial<Layout>): void => setLayout((l) => ({ ...l, ...patch }))
  const closeMenus = useCallback((): void => {
    setMenu(null)
    setFlyout(null)
    setToolMenu(null)
    setChartMenu(null)
    setGotoOpen(false)
  }, [])

  const draw = useCallback((tool: string, data?: unknown) => {
    closeMenus()
    pane()?.draw(tool, data)
  }, [pane, closeMenus])

  const toggleFlag = (name: 'magnet' | 'lock' | 'visible'): void => {
    const next = { ...flags, [name]: !flags[name] }
    setFlags(next)
    panes.current.forEach((p) => p?.setFlags(next))
  }

  const toggleFavorite = (tool: string): void => {
    patchLayout({ favorites: layout.favorites.includes(tool) ? layout.favorites.filter((t) => t !== tool) : [...layout.favorites, tool] })
    setToolMenu(null)
  }
  const openToolMenu = (e: React.MouseEvent, tool: string): void => {
    e.preventDefault()
    e.stopPropagation()
    setToolMenu({ x: e.clientX, y: e.clientY, tool })
  }

  // ---------------------------------------------------------------- alertes
  const openAlert = useCallback((price?: number | null) => {
    closeMenus()
    const p = price ?? pane()?.lastPrice() ?? 0
    setAlertDraft({ source: current.source, symbol: current.symbol, precision: current.precision, price: p, condition: 'cross', message: '', once: true })
  }, [closeMenus, pane, current.source, current.symbol, current.precision])
  const saveAlert = (d: AlertDraft): void => {
    if (d.id) alerts.update(d.id, { price: d.price, condition: d.condition, message: d.message, once: d.once, active: true })
    else alerts.add(d)
    setAlertDraft(null)
    message(`Alerte ${d.id ? 'modifiée' : 'créée'} sur ${d.symbol} à ${fmt(d.price, d.precision)}`)
  }

  // ---------------------------------------------------------------- annuler / rétablir
  const applyHistory = useCallback((entry: HistoryEntry | null, side: 'before' | 'after') => {
    if (!entry) return
    history.replaying = true
    try {
      if (entry.kind === 'alerts') alerts.commit(entry[side], false)
      else {
        const i = settings.panes.slice(0, settings.layout).findIndex((p) => p.source === entry.source && p.symbol === entry.symbol)
        if (i >= 0) panes.current[i]?.restoreDrawings(entry[side] as SavedDrawing[])
        else {
          // Le symbole n'est plus à l'écran : on corrige directement sa sauvegarde.
          void api(`/api/drawings?source=${encodeURIComponent(entry.source)}&symbol=${encodeURIComponent(entry.symbol)}`, 'PUT', entry[side]).catch(() => undefined)
          message(`Dessins de ${entry.symbol} ${side === 'before' ? 'annulés' : 'rétablis'}`)
        }
      }
    } finally {
      history.replaying = false
    }
  }, [settings.panes, settings.layout, message])
  const undo = useCallback(() => applyHistory(history.undo(), 'before'), [applyHistory])
  const redo = useCallback(() => applyHistory(history.redo(), 'after'), [applyHistory])

  // ---------------------------------------------------------------- périodes, date, replay
  const setRange = (ms: number, tf: string): void => {
    const p = pane()
    if (!p || replay.active) return
    p.setRange(ms)
    if (tf === current.tf) p.reload()
    else setPane({ tf })
  }
  const goToDate = (): void => {
    if (!gotoDate) return
    void pane()?.goToDate(new Date(gotoDate).getTime())
    setGotoOpen(false)
  }
  const startReplay = (): void => {
    if (!replayDate) {
      message('Choisis une date de départ, ou clique sur le graphique.', 'info')
      return
    }
    void pane()?.enterReplay(new Date(replayDate).getTime())
  }

  // ---------------------------------------------------------------- raccourcis clavier
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
      const k = e.key.toLowerCase()
      if (e.key === 'Escape') {
        closeMenus()
        if (!typing) pane()?.cancelDraw()
        return
      }
      if (typing) return
      const p = pane()
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'y')) {
        e.preventDefault()
        if (k === 'y' || e.shiftKey) redo()
        else undo()
      } else if (e.altKey && ['t', 'f', 'v'].includes(k)) {
        e.preventDefault()
        draw({ t: 'segment', f: 'fibonacciLine', v: 'verticalStraightLine' }[k]!)
      } else if (e.altKey && k === 'h') {
        e.preventDefault()
        // Souris sur le graphique : la ligne est posée au prix visé ; sinon l'outil s'active.
        const price = p?.pointerPrice()
        if (price !== null && price !== undefined) p?.addHorizontalLine(price)
        else draw('horizontalStraightLine')
      } else if (e.altKey && k === 'a') {
        e.preventDefault()
        openAlert(p?.pointerPrice())
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        p?.removeSelected()
      } else if (replay.active && e.key === ' ') {
        e.preventDefault()
        p?.play(!replay.playing)
      } else if (replay.active && e.key === 'ArrowRight') {
        e.preventDefault()
        p?.step()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pane, draw, undo, redo, openAlert, closeMenus, replay.active, replay.playing])

  if (ready === 'boot') return <div className="splash"><span className="spinner" />Big Benj Charts</div>
  if (ready === 'login') return <Login google={google} onDone={() => { setReady('boot'); void boot() }} />

  const toggleWatch = (s: { symbol: string; name: string; precision: number; market?: string }, source: string): void => {
    const exists = settings.watchlist.some((w) => w.source === source && w.symbol === s.symbol)
    update({
      watchlist: exists
        ? settings.watchlist.filter((w) => !(w.source === source && w.symbol === s.symbol))
        : [...settings.watchlist, { source, symbol: s.symbol, name: s.name, precision: s.precision, tf: current.tf, market: s.market }],
    })
  }

  // Menu du clic droit sur le graphique.
  const cm = chartMenu
  const last = cm ? pane()?.lastPrice() ?? 0 : 0
  const above = cm ? cm.price > last : false
  const qty = session.defaultSize()
  const p$ = cm ? fmt(cm.price, current.precision) : ''
  const pending = (side: 1 | -1, type: 'limit' | 'stop'): void => {
    if (!cm) return
    const err = session.place(side, type, cm.price, qty, null, null)
    message(err ?? `Ordre ${type === 'limit' ? 'limite' : 'stop'} simulé placé à ${p$}`, err ? 'error' : 'info')
    setChartMenu(null)
  }

  return (
    <div className="app" onClick={closeMenus}>
      {/* ------------------------------------------------ barre du haut */}
      <header className="top" onClick={(e) => e.stopPropagation()}>
        <div className="brand" title="Big Benj Charts"><span className="logo">B</span></div>
        <button className="symbol-btn" onClick={() => { closeMenus(); setMenu('symbol') }} title="Changer de symbole">
          <Icon name="search" size={15} /><b>{current.symbol}</b>
        </button>
        <span className="vsep" />
        <div className="tfs">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className={tf === current.tf ? 'on' : ''} onClick={() => setPane({ tf })}
              title={replay.active ? 'Changer d’unité de temps sans quitter le replay' : undefined}>{TF_LABEL[tf]}</button>
          ))}
        </div>
        <span className="vsep" />
        <label className="select-icon" title="Type de graphique"><Icon name="candles" size={16} />
          <select value={settings.chartType} onChange={(e) => update({ chartType: e.target.value })}>
            {CHART_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
        </label>
        <div className="menu-wrap">
          <button className={menu === 'ind' ? 'on' : ''} onClick={() => { const open = menu !== 'ind'; closeMenus(); if (open) setMenu('ind') }}>
            <Icon name="fx" size={16} /> Indicateurs
          </button>
          {menu === 'ind' && (
            <div className="menu">
              {INDICATORS.map((i) => (
                <label key={i.id}>
                  <input type="checkbox" checked={indicators.includes(i.id)}
                    onChange={() => { const list = pane()?.toggleIndicator(i.id) ?? []; setIndicators(list); update({ indicators: list }) }} />
                  {i.label}<em>{i.main ? 'prix' : 'fenêtre'}</em>
                </label>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => openAlert()} title="Créer une alerte de prix (Alt+A)"><Icon name="alarm" size={16} /> Alerte</button>
        <button className={replayOpen || replay.active ? 'on' : ''} onClick={() => setReplayOpen(!replayOpen)} title="Rejouer le marché bougie par bougie">
          <Icon name="rewind" size={16} /> Replay
        </button>
        <span className="vsep" />
        <button className="icon" onClick={undo} disabled={!history.canUndo} title="Annuler (Ctrl+Z)"><Icon name="undo" /></button>
        <button className="icon" onClick={redo} disabled={!history.canRedo} title="Rétablir (Ctrl+Y)"><Icon name="redo" /></button>
        <span className="vsep" />
        <label className="select-icon" title="Disposition des graphiques"><Icon name="layout" size={16} />
          <select value={settings.layout} onChange={(e) => update({ layout: Number(e.target.value) as 1 | 2 | 4 })} disabled={replay.active}>
            <option value={1}>1 graphique</option><option value={2}>2 graphiques</option><option value={4}>4 graphiques</option>
          </select>
        </label>
        <button className="icon" title="Plein écran"
          onClick={() => void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())}><Icon name="fullscreen" /></button>
        <button className="icon" onClick={() => pane()?.screenshot()} title="Capture d’écran du graphique"><Icon name="camera" /></button>
        <div className="spacer" />
        <button className="icon" onClick={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title="Thème clair / sombre">
          <Icon name={settings.theme === 'dark' ? 'sun' : 'moon'} />
        </button>
        {getToken() && (
          <button className="icon" title={google ? `Se déconnecter (${googleEmail()})` : 'Se déconnecter'}
            onClick={() => void (google ? signOutGoogle() : Promise.resolve(setToken(''))).then(() => location.reload())}><Icon name="logout" /></button>
        )}
      </header>

      {/* ------------------------------------------------ contrôles du replay */}
      {(replayOpen || replay.active || replay.picking) && (
        <div className="replay-bar">
          {!replay.active ? (
            <>
              <span>Départ du replay :</span>
              <input type="datetime-local" value={replayDate} onChange={(e) => setReplayDate(e.target.value)} />
              <button className="primary" onClick={startReplay}>Démarrer</button>
              <button className={replay.picking ? 'on' : ''} onClick={() => pane()?.pickReplayStart()}>
                {replay.picking ? 'Clique sur une bougie…' : 'Choisir sur le graphique'}
              </button>
              <button className="icon" onClick={() => { pane()?.cancelDraw(); setReplayOpen(false) }} title="Fermer"><Icon name="close" size={14} /></button>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => pane()?.play(!replay.playing)} title="Espace">{replay.playing ? 'Pause' : 'Lecture'}</button>
              <button onClick={() => pane()?.step()} title="Flèche droite">Bougie suivante</button>
              <label>Vitesse
                <select value={replay.speed} onChange={(e) => pane()?.setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => <option key={s} value={s}>{s} bougies/s</option>)}
                </select>
              </label>
              <span className="replay-time">{fmtDate(replay.time)} · {replay.left.toLocaleString('fr-FR')} bougies restantes</span>
              <div className="spacer" />
              <button onClick={() => { pane()?.exitReplay(); setReplayOpen(false) }}>Retour au temps réel</button>
            </>
          )}
        </div>
      )}

      <div className="body">
        {/* ------------------------------------------------ barre de gauche : outils de dessin */}
        <nav className="left" onClick={(e) => e.stopPropagation()}>
          <button className="icon" title="Curseur : arrêter l’outil en cours (Échap)" onClick={() => { closeMenus(); pane()?.cancelDraw() }}><Icon name="cross" /></button>
          {TOOL_GROUPS.map((g) => (
            <div key={g.label} className="tool-group">
              <button className={`icon${flyout === g.label ? ' on' : ''}`} title={g.label}
                onClick={() => { const open = flyout !== g.label; closeMenus(); if (open) setFlyout(g.label) }}>
                <Icon name={GROUP_ICON[g.label] ?? 'line'} />
              </button>
              {flyout === g.label && (
                <div className="flyout">
                  <div className="flyout-title">{g.label} · clic droit : favoris</div>
                  {g.tools.map((t) => (
                    <button key={t.id} onClick={() => draw(t.id)} onContextMenu={(e) => openToolMenu(e, t.id)}>
                      <span className="fi"><ToolIcon id={t.id} size={16} /></span>{t.label}
                      {layout.favorites.includes(t.id) && <span className="fav-mark"><Icon name="star" size={12} /></span>}
                      {t.hint && <em>{t.hint}</em>}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="tool-group">
            <button className={`icon${flyout === 'emoji' ? ' on' : ''}`} title="Emoji"
              onClick={() => { const open = flyout !== 'emoji'; closeMenus(); if (open) setFlyout('emoji') }}><Icon name="emoji" /></button>
            {flyout === 'emoji' && (
              <div className="flyout emojis">
                {EMOJIS.map((e) => <button key={e} onClick={() => draw('emoji', e)}>{e}</button>)}
              </div>
            )}
          </div>
          <div className="tool-group">
            <button className={`icon${flyout === 'zoom' ? ' on' : ''}`} title="Zoom"
              onClick={() => { const open = flyout !== 'zoom'; closeMenus(); if (open) setFlyout('zoom') }}><Icon name="zoomIn" /></button>
            {flyout === 'zoom' && (
              <div className="flyout">
                <button onClick={() => pane()?.zoom(1.35)}><span className="fi"><Icon name="zoomIn" size={16} /></span>Zoom avant</button>
                <button onClick={() => pane()?.zoom(1 / 1.35)}><span className="fi"><Icon name="zoomOut" size={16} /></span>Zoom arrière</button>
                <button onClick={() => { pane()?.zoom(0); setFlyout(null) }}><span className="fi"><Icon name="fullscreen" size={16} /></span>Réinitialiser le zoom</button>
              </div>
            )}
          </div>
          <div className="sep" />
          <button className={`icon${flags.magnet ? ' on' : ''}`} onClick={() => toggleFlag('magnet')} title="Aimant : accroche les dessins aux prix des bougies"><Icon name="magnet" /></button>
          <button className={`icon${flags.lock ? ' on' : ''}`} onClick={() => toggleFlag('lock')} title="Verrouiller tous les dessins"><Icon name="lock" /></button>
          <button className={`icon${!flags.visible ? ' on' : ''}`} onClick={() => toggleFlag('visible')} title="Masquer / afficher les dessins">
            <Icon name={flags.visible ? 'eye' : 'eyeOff'} />
          </button>
          <button className="icon" title="Supprimer tous les dessins de ce symbole (annulable avec Ctrl+Z)" onClick={() => pane()?.clearDrawings()}><Icon name="trash" /></button>
        </nav>

        <div className="center">
          <div className={`charts layout-${settings.layout}`}>
            {settings.panes.slice(0, settings.layout).map((p, i) => (
              <ChartPane key={i} ref={(h) => { panes.current[i] = h }} config={p} initialIndicators={settings.indicators} theme={settings.theme}
                chartType={settings.chartType} active={i === idx} session={session}
                onActivate={() => i !== idx && !replay.active && setActiveIdx(i)}
                onReplay={(s) => i === idx && setReplay(s)} onMessage={message}
                onDrawings={(source, symbol, before, after) => history.push({ kind: 'drawings', source, symbol, before, after })}
                onContext={(at) => { closeMenus(); setChartMenu(at) }} />
            ))}
            <Favorites tools={layout.favorites} pos={layout.favPos} onMove={(favPos) => patchLayout({ favPos })} onDraw={draw} onMenu={openToolMenu} />
          </div>

          {/* ------------------------------------------------ périodes, date, heure */}
          <div className="range-bar" onClick={(e) => e.stopPropagation()}>
            {RANGES.map(([label, ms, tf]) => (
              <button key={label} disabled={replay.active} onClick={() => setRange(ms(), tf)} title={`Afficher ${label} (unité ${TF_LABEL[tf]})`}>{label}</button>
            ))}
            <span className="vsep" />
            <div className="menu-wrap">
              <button className={`icon${gotoOpen ? ' on' : ''}`} disabled={replay.active} title="Aller à une date"
                onClick={() => { const open = !gotoOpen; closeMenus(); setGotoOpen(open) }}><Icon name="calendar" size={16} /></button>
              {gotoOpen && (
                <div className="menu goto">
                  <input type="datetime-local" autoFocus value={gotoDate} onChange={(e) => setGotoDate(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') goToDate() }} />
                  <button className="primary" onClick={goToDate}>Aller à la date</button>
                </div>
              )}
            </div>
            <div className="spacer" />
            <UtcClock />
          </div>

          <BottomPanel config={current} session={session} replay={replay} goTo={(ts) => pane()?.goTo(ts)} onMessage={message} />
        </div>

        <RightPanel tab={layout.side} width={Math.min(SIDE_MAX, Math.max(SIDE_MIN, layout.sideWidth))} items={settings.watchlist} current={current} session={session}
          onTab={(side) => patchLayout({ side })} onWidth={(sideWidth) => patchLayout({ sideWidth })}
          onPick={(w) => !replay.active && setPane({ source: w.source, symbol: w.symbol, precision: w.precision })}
          onRemove={(w) => toggleWatch(w, w.source)} onAdd={() => { closeMenus(); setMenu('symbol') }}
          onNewAlert={() => openAlert()}
          onEditAlert={(a: Alert) => setAlertDraft({ id: a.id, source: a.source, symbol: a.symbol, precision: a.precision, price: a.price, condition: a.condition, message: a.message, once: a.once })} />
      </div>

      {/* ------------------------------------------------ menus flottants et fenêtres */}
      {toolMenu && (
        <div className="ctx" style={{ left: toolMenu.x, top: toolMenu.y }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => toggleFavorite(toolMenu.tool)}>
            <Icon name="star" size={15} />{layout.favorites.includes(toolMenu.tool) ? 'Retirer des favoris' : 'Ajouter aux favoris'}
          </button>
        </div>
      )}
      {cm && (
        <div className="ctx" style={{ left: Math.min(cm.x, window.innerWidth - 380), top: Math.min(cm.y, window.innerHeight - 220) }} onClick={(e) => e.stopPropagation()}>
          <button onClick={() => openAlert(cm.price)}><Icon name="alarm" size={15} />Ajouter une alerte sur {current.symbol} à {p$}<em>Alt+A</em></button>
          <div className="ctx-sep" />
          {above ? (
            <>
              <button onClick={() => pending(-1, 'limit')}><Icon name="down" size={15} />Vendre {fmt(qty, 4)} {current.symbol} à {p$} limite</button>
              <button onClick={() => pending(1, 'stop')}><Icon name="up" size={15} />Acheter {fmt(qty, 4)} {current.symbol} à {p$} stop</button>
            </>
          ) : (
            <>
              <button onClick={() => pending(1, 'limit')}><Icon name="up" size={15} />Acheter {fmt(qty, 4)} {current.symbol} à {p$} limite</button>
              <button onClick={() => pending(-1, 'stop')}><Icon name="down" size={15} />Vendre {fmt(qty, 4)} {current.symbol} à {p$} stop</button>
            </>
          )}
          <button onClick={() => { window.dispatchEvent(new CustomEvent('bbc-order', { detail: { price: cm.price } })); setChartMenu(null) }}>
            <Icon name="orders" size={15} />Ajouter un ordre sur {current.symbol} à {p$}…
          </button>
          <div className="ctx-sep" />
          <button onClick={() => { pane()?.addHorizontalLine(cm.price); setChartMenu(null) }}>
            <Icon name="hline" size={15} />Tracer une ligne horizontale à {p$}<em>Alt+H</em>
          </button>
        </div>
      )}

      {menu === 'symbol' && (
        <SymbolSearch sources={sources} current={current} watchlist={settings.watchlist} onClose={() => setMenu(null)}
          onStar={toggleWatch}
          onPick={(s, source) => {
            if (replay.active) pane()?.exitReplay()
            setPane({ source, symbol: s.symbol, precision: s.precision })
            setMenu(null)
          }} />
      )}
      {alertDraft && <AlertDialog draft={alertDraft} onSave={saveAlert} onClose={() => setAlertDraft(null)} />}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  )
}
