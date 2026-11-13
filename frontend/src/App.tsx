// Écran principal : barre du haut, outils de dessin, graphiques, watchlist, panneau du bas.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, fetchCandles, fmt, fmtDate, getToken, setToken, TF_LABEL, TIMEFRAMES, type SourceInfo, type SymbolInfo } from './api'
import BottomPanel from './BottomPanel'
import ChartPane, { type PaneConfig, type PaneHandle, type ReplayState } from './ChartPane'
import { INDICATORS, TOOL_GROUPS } from './overlays'
import { TradingSession } from './session'

interface WatchItem extends PaneConfig { name: string }
interface Settings {
  theme: 'dark' | 'light'
  chartType: string
  layout: 1 | 2 | 4
  panes: PaneConfig[]
  watchlist: WatchItem[]
  indicators: string[]
}
interface Toast { id: number; text: string; kind: 'error' | 'info' }

const DEFAULT_WATCH: WatchItem[] = [
  { source: 'binance', symbol: 'BTCUSDT', tf: '1h', precision: 2, name: 'Bitcoin' },
  { source: 'binance', symbol: 'ETHUSDT', tf: '1h', precision: 2, name: 'Ethereum' },
  { source: 'binance', symbol: 'SOLUSDT', tf: '1h', precision: 2, name: 'Solana' },
  { source: 'dukascopy', symbol: 'EURUSD', tf: '1h', precision: 5, name: 'Euro / Dollar' },
  { source: 'dukascopy', symbol: 'XAUUSD', tf: '1h', precision: 2, name: 'Or' },
  { source: 'dukascopy', symbol: 'USA500IDXUSD', tf: '1h', precision: 1, name: 'S&P 500' },
  { source: 'yahoo', symbol: 'AAPL', tf: '1d', precision: 2, name: 'Apple' },
  { source: 'yahoo', symbol: 'NVDA', tf: '1d', precision: 2, name: 'Nvidia' },
]
const DEFAULTS: Settings = {
  theme: 'dark', chartType: 'candle_solid', layout: 1, watchlist: DEFAULT_WATCH, indicators: ['VOL'],
  panes: [0, 1, 2, 3].map((i) => ({ source: 'binance', symbol: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'][i], tf: '1h', precision: 2 })),
}
const CHART_TYPES = [
  ['candle_solid', 'Bougies'], ['candle_stroke', 'Bougies creuses'], ['candle_up_stroke', 'Hausse creuse'],
  ['ohlc', 'Barres'], ['area', 'Ligne'],
]
const SPEEDS = [1, 2, 4, 10, 30, 100]
const MARKET_LABEL: Record<string, string> = { crypto: 'Crypto', forex: 'Forex', indices: 'Indices', matieres: 'Matières premières', actions: 'Actions' }

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('bbc_settings') ?? '{}') } as Settings
    if (!Array.isArray(s.panes) || s.panes.length < 4) s.panes = DEFAULTS.panes
    if (!Array.isArray(s.watchlist)) s.watchlist = DEFAULT_WATCH
    if (!Array.isArray(s.indicators)) s.indicators = ['VOL']
    return s
  } catch {
    return DEFAULTS
  }
}

// ---------------------------------------------------------------- connexion (version publique)
function Login({ onDone }: { onDone: () => void }): JSX.Element {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const submit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault()
    try {
      const r = await api<{ token: string }>(`/api/auth/${mode}`, 'POST', { email, password })
      setToken(r.token)
      onDone()
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="login">
      <form onSubmit={submit}>
        <div className="brand big"><span className="logo">B</span>Big Benj Charts</div>
        <input type="email" placeholder="Adresse e-mail" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input type="password" placeholder="Mot de passe (8 caractères minimum)" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <div className="form-error">{error}</div>}
        <button className="primary" type="submit">{mode === 'login' ? 'Se connecter' : 'Créer mon compte'}</button>
        <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Pas encore de compte ? Créer un compte' : 'Déjà un compte ? Se connecter'}
        </button>
      </form>
    </div>
  )
}

// ---------------------------------------------------------------- recherche de symbole
function SymbolSearch(props: {
  sources: SourceInfo[]; current: PaneConfig; watchlist: WatchItem[]
  onPick: (s: SymbolInfo, source: string) => void; onStar: (s: SymbolInfo, source: string) => void; onClose: () => void
}): JSX.Element {
  const [source, setSource] = useState(props.current.source)
  const [query, setQuery] = useState('')
  const [list, setList] = useState<SymbolInfo[]>([])
  const [error, setError] = useState('')
  const info = props.sources.find((s) => s.name === source)
  useEffect(() => {
    let dead = false
    setList([])
    setError('')
    if (info && !info.available) {
      setError(info.message)
      return
    }
    api<SymbolInfo[]>(`/api/symbols?source=${source}`).then((l) => !dead && setList(l)).catch((e) => !dead && setError((e as Error).message))
    return () => { dead = true }
  }, [source, info])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (q ? list.filter((s) => s.symbol.toLowerCase().includes(q) || s.name.toLowerCase().includes(q)) : list).slice(0, 150)
  }, [list, query])
  const starred = (s: SymbolInfo): boolean => props.watchlist.some((w) => w.source === source && w.symbol === s.symbol)
  return (
    <div className="modal-back" onMouseDown={props.onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <input autoFocus placeholder="Rechercher un symbole (BTC, EURUSD, Apple…)" value={query} onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && shown[0]) props.onPick(shown[0], source); if (e.key === 'Escape') props.onClose() }} />
          <button className="icon" onClick={props.onClose} title="Fermer">✕</button>
        </div>
        <div className="tabs">
          {props.sources.map((s) => (
            <button key={s.name} className={s.name === source ? 'on' : ''} onClick={() => setSource(s.name)} title={s.markets.map((m) => MARKET_LABEL[m] ?? m).join(', ')}>
              {s.label}{!s.available && ' ⚠'}
            </button>
          ))}
        </div>
        <div className="modal-list">
          {error && <div className="empty">{error}</div>}
          {!error && !shown.length && <div className="empty">{list.length ? 'Aucun résultat.' : 'Chargement…'}</div>}
          {shown.map((s) => (
            <div key={s.symbol} className="row" onClick={() => props.onPick(s, source)}>
              <b>{s.symbol}</b><span>{s.name}</span><em>{MARKET_LABEL[s.market] ?? s.market}</em>
              <button className={`icon star${starred(s) ? ' on' : ''}`} title="Ajouter ou retirer de la liste de surveillance"
                onClick={(e) => { e.stopPropagation(); props.onStar(s, source) }}>★</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- liste de surveillance
function Watchlist(props: { items: WatchItem[]; current: PaneConfig; onPick: (w: WatchItem) => void; onRemove: (w: WatchItem) => void }): JSX.Element {
  const [quotes, setQuotes] = useState<Record<string, { price: number; change: number }>>({})
  const key = props.items.map((w) => `${w.source}:${w.symbol}`).join(',')
  useEffect(() => {
    let dead = false
    const refresh = async (): Promise<void> => {
      // Toutes les cotations partent en parallèle : une source lente ne retarde pas les autres.
      await Promise.all(props.items.map(async (w) => {
        try {
          // Dukascopy : variation sur 24 h à partir des bougies 15 minutes (rapide à charger).
          const intraday = w.source === 'dukascopy'
          const bars = await fetchCandles(w.source, w.symbol, intraday ? '15m' : '1d', { limit: intraday ? 96 : 5 })
          if (dead || !bars.length) return
          const last = bars[bars.length - 1]
          const ref = intraday ? bars[0].open : bars.length > 1 ? bars[bars.length - 2].close : last.open
          setQuotes((q) => ({ ...q, [`${w.source}:${w.symbol}`]: { price: last.close, change: ref ? ((last.close - ref) / ref) * 100 : 0 } }))
        } catch {
          /* source indisponible : la ligne reste sans prix */
        }
      }))
    }
    void refresh()
    const timer = window.setInterval(() => void refresh(), 30_000)
    return () => { dead = true; window.clearInterval(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return (
    <aside className="right">
      <div className="panel-title">Liste de surveillance</div>
      <div className="watch">
        {props.items.map((w) => {
          const q = quotes[`${w.source}:${w.symbol}`]
          const on = w.source === props.current.source && w.symbol === props.current.symbol
          return (
            <div key={`${w.source}:${w.symbol}`} className={`row${on ? ' on' : ''}`} onClick={() => props.onPick(w)} title={w.name}>
              <div><b>{w.symbol}</b><small>{w.name}</small></div>
              <div className="num">
                <span>{q ? fmt(q.price, w.precision) : '—'}</span>
                <small className={q && q.change < 0 ? 'down' : 'up'}>{q ? `${q.change >= 0 ? '+' : ''}${q.change.toFixed(2)} %` : ''}</small>
              </div>
              <button className="icon del" title="Retirer" onClick={(e) => { e.stopPropagation(); props.onRemove(w) }}>✕</button>
            </div>
          )
        })}
        {!props.items.length && <div className="empty">Ajoute des symboles avec l’étoile dans la recherche.</div>}
      </div>
    </aside>
  )
}

// ---------------------------------------------------------------- application
export default function App(): JSX.Element {
  const [ready, setReady] = useState<'boot' | 'login' | 'ok'>('boot')
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [menu, setMenu] = useState<string | null>(null)
  const [toolGroup, setToolGroup] = useState<number | null>(null)
  const [indicators, setIndicators] = useState<string[]>(settings.indicators)
  const [flags, setFlags] = useState({ magnet: false, lock: false, visible: true })
  const [replay, setReplay] = useState<ReplayState>({ active: false, playing: false, time: 0, left: 0, speed: 4, picking: false })
  const [replayOpen, setReplayOpen] = useState(false)
  const [replayDate, setReplayDate] = useState('')
  const [toasts, setToasts] = useState<Toast[]>([])
  const [showRight, setShowRight] = useState(window.innerWidth > 1000)
  const [showBottom, setShowBottom] = useState(window.innerWidth > 800)
  const session = useMemo(() => new TradingSession(), [])
  const panes = useRef<(PaneHandle | null)[]>([])
  const idx = Math.min(activeIdx, settings.layout - 1)
  const current = settings.panes[idx]
  const pane = useCallback((): PaneHandle | null => panes.current[idx] ?? null, [idx])

  const message = useCallback((text: string, kind: 'error' | 'info' = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t.slice(-3), { id, text, kind }])
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500)
  }, [])

  // Démarrage : mode d'authentification, réglages sauvegardés, sources disponibles.
  const boot = useCallback(async () => {
    try {
      const conf = await api<{ auth_required: boolean }>('/api/auth/config')
      if (conf.auth_required) {
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
      if (saved && Array.isArray(saved.panes) && saved.panes.length >= 4) setSettings((s) => ({ ...s, ...saved }))
      setReady('ok')
    } catch (e) {
      message((e as Error).message, 'error')
      setReady('ok')
    }
  }, [message])
  useEffect(() => { void boot() }, [boot])

  // Sauvegarde des réglages (navigateur tout de suite, serveur avec un léger délai).
  useEffect(() => {
    if (ready !== 'ok') return
    localStorage.setItem('bbc_settings', JSON.stringify(settings))
    const t = window.setTimeout(() => void api('/api/settings', 'PUT', settings).catch(() => undefined), 800)
    return () => window.clearTimeout(t)
  }, [settings, ready])

  useEffect(() => { document.documentElement.dataset.theme = settings.theme }, [settings.theme])

  // La session de trading suit le symbole du graphique actif (hors replay).
  useEffect(() => {
    if (replay.active) return
    const c = session.context
    if (c.source !== current.source || c.symbol !== current.symbol) session.reset({ source: current.source, symbol: current.symbol, tf: current.tf })
    else c.tf = current.tf
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.source, current.symbol, current.tf, replay.active])

  useEffect(() => { const list = pane()?.indicators(); if (list) setIndicators(list) }, [pane, settings.layout])

  const update = (patch: Partial<Settings>): void => setSettings((s) => ({ ...s, ...patch }))
  const setPane = (patch: Partial<PaneConfig>): void =>
    setSettings((s) => ({ ...s, panes: s.panes.map((p, i) => (i === idx ? { ...p, ...patch } : p)) }))

  const draw = useCallback((tool: string) => {
    setToolGroup(null)
    pane()?.draw(tool)
  }, [pane])

  const toggleFlag = (name: 'magnet' | 'lock' | 'visible'): void => {
    const next = { ...flags, [name]: !flags[name] }
    setFlags(next)
    panes.current.forEach((p) => p?.setFlags(next))
  }

  const startReplay = (): void => {
    if (!replayDate) {
      message('Choisis une date de départ, ou clique sur le graphique.', 'info')
      return
    }
    void pane()?.enterReplay(new Date(replayDate).getTime())
  }

  // Raccourcis clavier.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (e.key === 'Escape') {
        setMenu(null)
        setToolGroup(null)
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const p = pane()
      if (e.altKey && ['t', 'f', 'h', 'v'].includes(e.key.toLowerCase())) {
        e.preventDefault()
        draw({ t: 'segment', f: 'fibonacciLine', h: 'horizontalStraightLine', v: 'verticalStraightLine' }[e.key.toLowerCase()]!)
      } else if (e.key === 'Escape') {
        p?.cancelDraw()
        setMenu(null)
        setToolGroup(null)
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
  }, [pane, draw, replay.active, replay.playing])

  if (ready === 'boot') return <div className="splash"><span className="spinner" />Big Benj Charts</div>
  if (ready === 'login') return <Login onDone={() => { setReady('boot'); void boot() }} />

  const toggleWatch = (s: { symbol: string; name: string; precision: number }, source: string): void => {
    const exists = settings.watchlist.some((w) => w.source === source && w.symbol === s.symbol)
    update({
      watchlist: exists
        ? settings.watchlist.filter((w) => !(w.source === source && w.symbol === s.symbol))
        : [...settings.watchlist, { source, symbol: s.symbol, name: s.name, precision: s.precision, tf: current.tf }],
    })
  }

  return (
    <div className="app" onClick={() => { if (menu) setMenu(null); if (toolGroup !== null) setToolGroup(null) }}>
      {/* ------------------------------------------------ barre du haut */}
      <header className="top">
        <div className="brand"><span className="logo">B</span><span className="brand-name">Big Benj Charts</span></div>
        <button className="symbol-btn" onClick={(e) => { e.stopPropagation(); setMenu('symbol') }} title="Changer de symbole">
          🔍 <b>{current.symbol}</b>
        </button>
        <div className="tfs">
          {TIMEFRAMES.map((tf) => (
            <button key={tf} className={tf === current.tf ? 'on' : ''} disabled={replay.active} onClick={() => setPane({ tf })}>{TF_LABEL[tf]}</button>
          ))}
        </div>
        <select value={settings.chartType} onChange={(e) => update({ chartType: e.target.value })} title="Type de graphique">
          {CHART_TYPES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
        </select>
        <div className="menu-wrap">
          <button onClick={(e) => { e.stopPropagation(); setMenu(menu === 'ind' ? null : 'ind') }}>ƒ Indicateurs</button>
          {menu === 'ind' && (
            <div className="menu" onClick={(e) => e.stopPropagation()}>
              {INDICATORS.map((i) => (
                <label key={i.id}>
                  <input type="checkbox" checked={indicators.includes(i.id)} onChange={() => { const list = pane()?.toggleIndicator(i.id) ?? []; setIndicators(list); update({ indicators: list }) }} />
                  {i.label}<em>{i.main ? 'prix' : 'fenêtre'}</em>
                </label>
              ))}
            </div>
          )}
        </div>
        <select value={settings.layout} onChange={(e) => update({ layout: Number(e.target.value) as 1 | 2 | 4 })} title="Disposition" disabled={replay.active}>
          <option value={1}>1 graphique</option><option value={2}>2 graphiques</option><option value={4}>4 graphiques</option>
        </select>
        <button className={replayOpen || replay.active ? 'on' : ''} onClick={() => setReplayOpen(!replayOpen)} title="Rejouer le marché bougie par bougie">⏪ Replay</button>
        <div className="spacer" />
        <button className="icon" onClick={() => pane()?.screenshot()} title="Capture d’écran">📷</button>
        <button className="icon" onClick={() => update({ theme: settings.theme === 'dark' ? 'light' : 'dark' })} title="Thème clair / sombre">{settings.theme === 'dark' ? '☀' : '🌙'}</button>
        <button className="icon" onClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen())} title="Plein écran">⛶</button>
        <button className={`icon${showBottom ? ' on' : ''}`} onClick={() => setShowBottom(!showBottom)} title="Panneau du bas">▁</button>
        <button className={`icon${showRight ? ' on' : ''}`} onClick={() => setShowRight(!showRight)} title="Liste de surveillance">▕</button>
        {getToken() && <button className="icon" onClick={() => { setToken(''); location.reload() }} title="Se déconnecter">⎋</button>}
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
                {replay.picking ? 'Clique sur une bougie…' : '✛ Choisir sur le graphique'}
              </button>
              <button className="icon" onClick={() => { pane()?.cancelDraw(); setReplayOpen(false) }} title="Fermer">✕</button>
            </>
          ) : (
            <>
              <button className="primary" onClick={() => pane()?.play(!replay.playing)} title="Espace">{replay.playing ? '⏸ Pause' : '▶ Lecture'}</button>
              <button onClick={() => pane()?.step()} title="Flèche droite">⏭ Bougie suivante</button>
              <label>Vitesse
                <select value={replay.speed} onChange={(e) => pane()?.setSpeed(Number(e.target.value))}>
                  {SPEEDS.map((s) => <option key={s} value={s}>{s} bougies/s</option>)}
                </select>
              </label>
              <span className="replay-time">{fmtDate(replay.time)} · {replay.left.toLocaleString('fr-FR')} bougies restantes</span>
              <div className="spacer" />
              <button onClick={() => { pane()?.exitReplay(); setReplayOpen(false) }}>⏹ Retour au temps réel</button>
            </>
          )}
        </div>
      )}

      <div className="body">
        {/* ------------------------------------------------ barre de gauche : outils de dessin */}
        <nav className="left" onClick={(e) => e.stopPropagation()}>
          {TOOL_GROUPS.map((g, gi) => (
            <div key={g.label} className="tool-group">
              <button className={`icon${toolGroup === gi ? ' on' : ''}`} title={g.label}
                onClick={() => (g.tools.length === 1 ? draw(g.tools[0].id) : setToolGroup(toolGroup === gi ? null : gi))}>{g.icon}</button>
              {toolGroup === gi && (
                <div className="flyout">
                  <div className="flyout-title">{g.label}</div>
                  {g.tools.map((t) => (
                    <button key={t.id} onClick={() => draw(t.id)}><span>{t.icon}</span>{t.label}{t.hint && <em>{t.hint}</em>}</button>
                  ))}
                </div>
              )}
            </div>
          ))}
          <div className="sep" />
          <button className={`icon${flags.magnet ? ' on' : ''}`} onClick={() => toggleFlag('magnet')} title="Aimant : accroche les dessins aux prix des bougies">🧲</button>
          <button className={`icon${flags.lock ? ' on' : ''}`} onClick={() => toggleFlag('lock')} title="Verrouiller tous les dessins">🔒</button>
          <button className={`icon${!flags.visible ? ' on' : ''}`} onClick={() => toggleFlag('visible')} title="Masquer / afficher les dessins">👁</button>
          <button className="icon" title="Supprimer tous les dessins de ce symbole"
            onClick={() => { if (window.confirm('Supprimer tous les dessins de ce symbole ?')) pane()?.clearDrawings() }}>🗑</button>
        </nav>

        <div className="center">
          <div className={`charts layout-${settings.layout}`}>
            {settings.panes.slice(0, settings.layout).map((p, i) => (
              <ChartPane key={i} ref={(h) => { panes.current[i] = h }} config={p} initialIndicators={settings.indicators} theme={settings.theme} chartType={settings.chartType}
                active={i === idx} session={session} onActivate={() => i !== idx && !replay.active && setActiveIdx(i)}
                onReplay={(s) => i === idx && setReplay(s)} onMessage={message} />
            ))}
          </div>
          {showBottom && <BottomPanel config={current} session={session} replay={replay} goTo={(ts) => pane()?.goTo(ts)} onMessage={message} />}
        </div>

        {showRight && (
          <Watchlist items={settings.watchlist} current={current} onRemove={(w) => toggleWatch(w, w.source)}
            onPick={(w) => !replay.active && setPane({ source: w.source, symbol: w.symbol, precision: w.precision })} />
        )}
      </div>

      {menu === 'symbol' && (
        <SymbolSearch sources={sources} current={current} watchlist={settings.watchlist} onClose={() => setMenu(null)}
          onStar={toggleWatch}
          onPick={(s, source) => {
            if (replay.active) pane()?.exitReplay()
            setPane({ source, symbol: s.symbol, precision: s.precision })
            setMenu(null)
          }} />
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>)}
      </div>
    </div>
  )
}
