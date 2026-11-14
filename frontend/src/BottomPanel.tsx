// Panneau du bas : testeur de stratégie, trading simulé, éditeur de stratégies, journal.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { api, fmt, fmtDate, TF_MS } from './api'
import type { PaneConfig, ReplayState } from './ChartPane'
import type { TradingSession } from './session'

interface Props {
  config: PaneConfig
  session: TradingSession
  replay: ReplayState
  goTo: (ts: number) => void
  onMessage: (text: string, kind?: 'error' | 'info') => void
}

interface Builtin { id: string; label: string; params: Record<string, number> }
interface Custom { id: number | string; name: string; code: string }
interface StrategyList { builtin: Builtin[]; template: string; custom: Custom[]; custom_code: boolean }
interface BtTrade { side: number; entry_time: number; entry_price: number; exit_time: number; exit_price: number; size: number; pnl: number; fees: number; reason: string }
interface BtResult { metrics: Record<string, number | null>; trades: BtTrade[]; equity: [number, number][]; bars: number; duration_ms: number }
interface Job { status: string; progress: number; result: BtResult | null; error: string | null }
interface JournalRow { id: number; kind: string; source: string; symbol: string; tf: string; created_at: number; data: Record<string, number | string> }

const TABS = ['Testeur de stratégie', 'Trading', 'Éditeur de stratégies', 'Journal'] as const
const CONFIG_FIELDS: [string, string, number][] = [
  ['capital', 'Capital', 10000], ['position_pct', 'Capital engagé %', 100], ['risk_pct', 'Risque par trade %', 0],
  ['sl_pct', 'Stop loss %', 0], ['tp_pct', 'Take profit %', 0], ['spread', 'Spread (prix)', 0],
  ['slippage', 'Slippage (prix)', 0], ['commission_pct', 'Commission %', 0.1],
]
const num = (v: string): number | null => (v.trim() === '' || Number.isNaN(Number(v.replace(',', '.'))) ? null : Number(v.replace(',', '.')))

// --- État du panneau (ouvert/fermé + hauteur), mémorisé dans le navigateur ---
const PANEL_KEY = 'bbc_panel'
const MIN_HEIGHT = 160
const maxHeight = (): number => Math.max(MIN_HEIGHT, Math.round(window.innerHeight * 0.75))
const clampHeight = (h: number): number => Math.min(maxHeight(), Math.max(MIN_HEIGHT, Math.round(h)))

function loadPanel(): { open: boolean; height: number } {
  try {
    const p = JSON.parse(localStorage.getItem(PANEL_KEY) ?? '{}') as { open?: boolean; height?: number }
    return { open: p.open === true, height: clampHeight(Number(p.height) || 300) }
  } catch {
    return { open: false, height: 300 } // stockage indisponible : replié par défaut
  }
}

/** Courbe de capital dessinée sur un canvas (léger, net sur tous les écrans). */
function EquityCurve({ points }: { points: [number, number][] }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const draw = (): void => {
      const dpr = window.devicePixelRatio || 1
      const w = cv.clientWidth
      const h = cv.clientHeight
      cv.width = w * dpr
      cv.height = h * dpr
      const ctx = cv.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.clearRect(0, 0, w, h)
      if (points.length < 2) return
      const ys = points.map((p) => p[1])
      const min = Math.min(...ys)
      const max = Math.max(...ys)
      const span = max - min || 1
      const x = (i: number): number => (i / (points.length - 1)) * (w - 8) + 4
      const y = (v: number): number => h - 6 - ((v - min) / span) * (h - 12)
      const up = ys[ys.length - 1] >= ys[0]
      const color = up ? '#26a69a' : '#ef5350'
      ctx.beginPath()
      points.forEach((p, i) => (i ? ctx.lineTo(x(i), y(p[1])) : ctx.moveTo(x(i), y(p[1]))))
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.lineTo(x(points.length - 1), h)
      ctx.lineTo(x(0), h)
      ctx.closePath()
      ctx.fillStyle = up ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.12)'
      ctx.fill()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#787b86'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(0, y(ys[0]))
      ctx.lineTo(w, y(ys[0]))
      ctx.stroke()
    }
    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(cv)
    return () => ro.disconnect()
  }, [points])
  return <canvas ref={ref} className="equity" />
}

export default function BottomPanel({ config, session, replay, goTo, onMessage }: Props): JSX.Element {
  const [tab, setTab] = useState(0)
  const [open, setOpen] = useState(() => loadPanel().open)
  const [height, setHeight] = useState(() => loadPanel().height)
  const [full, setFull] = useState(false)
  const drag = useRef<{ y: number; h: number; raf: number; next: number } | null>(null)

  // Mémorise l'état à chaque changement.
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, JSON.stringify({ open, height }))
    } catch {
      /* stockage indisponible (navigation privée) : on continue sans mémoriser */
    }
  }, [open, height])

  // Alt+B ouvre ou replie ; Échap quitte le plein écran ; la hauteur suit la taille de la fenêtre.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        setOpen((o) => !o)
        setFull(false)
      } else if (e.key === 'Escape') setFull(false)
    }
    const onResize = (): void => setHeight((h) => clampHeight(h))
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [])

  const pickTab = (i: number): void => {
    if (open && i === tab) {
      setOpen(false)
      setFull(false)
    } else {
      setTab(i)
      setOpen(true)
    }
  }

  // Poignée : la hauteur suit la souris, au plus une mise à jour par image.
  const onGripDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y: e.clientY, h: height, raf: 0, next: height }
  }
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    d.next = clampHeight(d.h + (d.y - e.clientY))
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        setHeight(d.next)
      })
    }
  }
  const onGripUp = (): void => {
    if (drag.current) cancelAnimationFrame(drag.current.raf)
    if (drag.current) setHeight(drag.current.next)
    drag.current = null
  }

  const [strategies, setStrategies] = useState<StrategyList | null>(null)
  const [code, setCode] = useState('')
  const [name, setName] = useState('Ma stratégie')

  const loadStrategies = (): void => {
    api<StrategyList>('/api/strategies').then((s) => {
      setStrategies(s)
      setCode((c) => c || s.template)
    }).catch((e) => onMessage((e as Error).message, 'error'))
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(loadStrategies, [])

  return (
    <section className={`bottom${open ? '' : ' closed'}${open && full ? ' full' : ''}`} style={open && !full ? { height } : undefined}>
      {open && !full && (
        <div className="panel-grip" title="Glisser pour redimensionner" onPointerDown={onGripDown} onPointerMove={onGripMove}
          onPointerUp={onGripUp} onPointerCancel={onGripUp} onDoubleClick={() => setHeight(300)} />
      )}
      <div className="tabs">
        {TABS.map((t, i) => (
          <button key={t} className={open && i === tab ? 'on' : ''} onClick={() => pickTab(i)}
            title={open && i === tab ? 'Replier le panneau' : `Ouvrir ${t}`}>{t}</button>
        ))}
        <span className="tabs-info">{config.symbol} · {config.tf}{replay.active ? ' · replay' : ''}</span>
        {open && (
          <button className="icon" onClick={() => setFull(!full)} title={full ? 'Réduire le panneau (Échap)' : 'Agrandir le panneau en plein écran'}>
            {full ? '⤡' : '⤢'}
          </button>
        )}
        <button className="icon" onClick={() => { setOpen(!open); setFull(false) }} title={open ? 'Replier le panneau (Alt+B)' : 'Ouvrir le panneau (Alt+B)'}>
          {open ? '▼' : '▲'}
        </button>
      </div>
      <div className="bottom-body" hidden={!open}>
        <div hidden={tab !== 0} className="fill"><Backtest config={config} strategies={strategies} code={code} goTo={goTo} onMessage={onMessage} /></div>
        {tab === 1 && <Trading config={config} session={session} replay={replay} goTo={goTo} onMessage={onMessage} />}
        {tab === 2 && (
          <div className="editor">
            <div className="editor-bar">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Nom de la stratégie" />
              <button className="primary" onClick={() => api('/api/strategies', 'POST', { name, code }).then(() => { onMessage('Stratégie enregistrée.'); loadStrategies() }).catch((e) => onMessage((e as Error).message, 'error'))}>Enregistrer</button>
              <select value="" onChange={(e) => {
                const s = strategies?.custom.find((c) => String(c.id) === e.target.value)
                if (s) { setCode(s.code); setName(s.name) }
              }}>
                <option value="">Ouvrir une stratégie…</option>
                {strategies?.custom.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button onClick={() => {
                const s = strategies?.custom.find((c) => c.name === name)
                if (s && window.confirm(`Supprimer « ${s.name} » ?`)) void api(`/api/strategies/${s.id}`, 'DELETE').then(loadStrategies)
              }}>Supprimer</button>
              <button onClick={() => strategies && setCode(strategies.template)}>Modèle</button>
              <button onClick={() => setTab(0)}>Tester →</button>
              {strategies && !strategies.custom_code && <span className="down">Code personnalisé désactivé sur ce serveur.</span>}
            </div>
            <textarea spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Tab') return
                e.preventDefault()
                const el = e.currentTarget
                const { selectionStart: a, selectionEnd: b } = el
                setCode(code.slice(0, a) + '    ' + code.slice(b))
                requestAnimationFrame(() => { el.selectionStart = el.selectionEnd = a + 4 })
              }} />
          </div>
        )}
        {tab === 3 && <Journal onMessage={onMessage} />}
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- testeur de stratégie
function Backtest(props: { config: PaneConfig; strategies: StrategyList | null; code: string; goTo: (ts: number) => void; onMessage: Props['onMessage'] }): JSX.Element {
  const { config, strategies } = props
  const [strategy, setStrategy] = useState('sma_cross')
  const [params, setParams] = useState<Record<string, string>>({})
  const [bars, setBars] = useState(5000)
  const [cfg, setCfg] = useState<Record<string, string>>(Object.fromEntries(CONFIG_FIELDS.map(([k, , d]) => [k, String(d)])))
  const [allowShort, setAllowShort] = useState(true)
  const [job, setJob] = useState<Job | null>(null)
  const jobId = useRef('')
  const timer = useRef(0)
  const builtin = strategies?.builtin.find((b) => b.id === strategy)

  useEffect(() => {
    if (builtin) setParams(Object.fromEntries(Object.entries(builtin.params).map(([k, v]) => [k, String(v)])))
  }, [builtin])
  useEffect(() => () => window.clearInterval(timer.current), [])

  const run = async (): Promise<void> => {
    window.clearInterval(timer.current)
    setJob({ status: 'running', progress: 0, result: null, error: null })
    try {
      const end = Date.now()
      const body: Record<string, unknown> = {
        source: config.source, symbol: config.symbol, tf: config.tf, start: end - bars * TF_MS[config.tf], end,
        config: { ...Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, num(v) ?? 0])), allow_short: allowShort },
        params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, num(v) ?? 0])),
      }
      if (strategy === 'editor') body.code = props.code
      else if (strategy.startsWith('custom:')) body.code = strategies?.custom.find((c) => `custom:${c.id}` === strategy)?.code
      else body.strategy = strategy
      const { job_id } = await api<{ job_id: string }>('/api/backtest', 'POST', body)
      jobId.current = job_id
      timer.current = window.setInterval(async () => {
        try {
          const j = await api<Job>(`/api/backtest/${job_id}`)
          if (jobId.current !== job_id) return
          setJob(j)
          if (j.status !== 'running') window.clearInterval(timer.current)
        } catch (e) {
          window.clearInterval(timer.current)
          setJob({ status: 'error', progress: 0, result: null, error: (e as Error).message })
        }
      }, 200)
    } catch (e) {
      setJob({ status: 'error', progress: 0, result: null, error: (e as Error).message })
    }
  }
  const cancel = (): void => { void api(`/api/backtest/${jobId.current}`, 'DELETE') }

  const m = job?.result?.metrics
  const money = (k: string): string => fmt(m?.[k] as number, 2)
  const cards: [string, string, string?][] = m ? [
    ['Profit net', money('profit_net'), (m.profit_net ?? 0) >= 0 ? 'up' : 'down'],
    ['Rendement', `${fmt(m.rendement_pct as number, 2)} %`, (m.rendement_pct ?? 0) >= 0 ? 'up' : 'down'],
    ['Drawdown max', `${fmt(m.drawdown_max_pct as number, 2)} %`, 'down'],
    ['Trades', String(m.nb_trades)],
    ['Taux de réussite', `${fmt(m.taux_reussite_pct as number, 1)} %`],
    ['Profit factor', m.profit_factor === null ? '∞' : fmt(m.profit_factor, 2)],
    ['Ratio de Sharpe', fmt(m.sharpe as number, 2)],
    ['Gain moyen', money('gain_moyen'), 'up'],
    ['Perte moyenne', money('perte_moyenne'), 'down'],
    ['Espérance / trade', money('esperance')],
    ['Frais payés', money('frais_total')],
    ['Capital final', money('capital_final')],
  ] : []

  return (
    <div className="backtest">
      <div className="bt-form">
        <label className="wide">Stratégie
          <select value={strategy} onChange={(e) => setStrategy(e.target.value)}>
            {strategies?.builtin.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
            <option value="editor">Code de l’éditeur (Python)</option>
            {strategies?.custom.map((c) => <option key={c.id} value={`custom:${c.id}`}>Enregistrée : {c.name}</option>)}
          </select>
        </label>
        {builtin && Object.keys(params).map((k) => (
          <label key={k}>{k}<input value={params[k]} onChange={(e) => setParams({ ...params, [k]: e.target.value })} /></label>
        ))}
        <label>Historique
          <select value={bars} onChange={(e) => setBars(Number(e.target.value))}>
            {[1000, 5000, 20000, 50000, 200000].map((n) => <option key={n} value={n}>{n.toLocaleString('fr-FR')} bougies</option>)}
          </select>
        </label>
        {CONFIG_FIELDS.map(([k, label]) => (
          <label key={k}>{label}<input value={cfg[k]} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value })} /></label>
        ))}
        <label className="check"><input type="checkbox" checked={allowShort} onChange={(e) => setAllowShort(e.target.checked)} />Ventes à découvert</label>
        <div className="bt-actions">
          {job?.status === 'running'
            ? <button onClick={cancel}>Annuler</button>
            : <button className="primary" onClick={() => void run()}>▶ Lancer le backtest</button>}
        </div>
        {job?.status === 'running' && <div className="progress"><div style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>}
        {job?.status === 'error' && <div className="form-error">{job.error}</div>}
        {job?.status === 'cancelled' && <div className="form-error">Backtest annulé.</div>}
      </div>
      <div className="bt-result">
        {!job?.result && <div className="empty">Choisis une stratégie puis lance le backtest sur {config.symbol} ({config.tf}).<br />Les ordres sont exécutés à l’ouverture de la bougie suivante, frais inclus.</div>}
        {job?.result && (
          <>
            <div className="cards">
              {cards.map(([label, value, cls]) => <div key={label} className="card"><small>{label}</small><b className={cls}>{value}</b></div>)}
            </div>
            <EquityCurve points={job.result.equity} />
            <small className="muted">{job.result.bars.toLocaleString('fr-FR')} bougies calculées en {job.result.duration_ms} ms · clique sur un trade pour l’afficher sur le graphique</small>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Sens</th><th>Entrée</th><th>Prix</th><th>Sortie</th><th>Prix</th><th>Motif</th><th>Frais</th><th>Résultat</th></tr></thead>
                <tbody>
                  {job.result.trades.slice(-400).reverse().map((t, i) => (
                    <tr key={i} onClick={() => props.goTo(t.entry_time)}>
                      <td className={t.side > 0 ? 'up' : 'down'}>{t.side > 0 ? 'Achat' : 'Vente'}</td>
                      <td>{fmtDate(t.entry_time)}</td><td>{fmt(t.entry_price, config.precision)}</td>
                      <td>{fmtDate(t.exit_time)}</td><td>{fmt(t.exit_price, config.precision)}</td>
                      <td>{t.reason}</td><td>{fmt(t.fees, 2)}</td>
                      <td className={t.pnl >= 0 ? 'up' : 'down'}>{fmt(t.pnl, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {job.result.trades.length > 400 && <small className="muted">400 derniers trades affichés sur {job.result.trades.length}.</small>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- trading simulé
function Trading({ config, session, replay, goTo, onMessage }: Props): JSX.Element {
  useSyncExternalStore(session.subscribe, session.getVersion)
  const [type, setType] = useState<'market' | 'limit' | 'stop'>('market')
  const [price, setPrice] = useState('')
  const [sl, setSl] = useState('')
  const [tp, setTp] = useState('')
  const [risk, setRisk] = useState('1')
  const [qty, setQty] = useState('')
  const d = config.precision
  const stats = session.stats()

  const send = (side: 1 | -1): void => {
    const entry = type === 'market' ? session.price : num(price) ?? 0
    const stop = num(sl)
    const target = num(tp)
    let size = num(qty) ?? 0
    if (!size) {
      if (stop === null) return onMessage('Indique un stop loss (taille calculée selon le risque) ou une quantité.', 'error')
      size = session.sizeForRisk(num(risk) ?? 1, entry, stop)
    }
    const err = type === 'market' ? session.market(side, size, stop, target) : session.place(side, type, entry, size, stop, target)
    if (err) onMessage(err, 'error')
  }

  return (
    <div className="trading">
      <div className="ticket">
        <div className="quote">{config.symbol} <b>{fmt(session.price, d)}</b><small>{replay.active ? 'replay' : 'temps réel (simulation)'}</small></div>
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as typeof type)}>
            <option value="market">Au marché</option><option value="limit">Limite</option><option value="stop">Stop</option>
          </select>
        </label>
        {type !== 'market' && <label>Prix<input value={price} onChange={(e) => setPrice(e.target.value)} placeholder={session.price.toFixed(d)} /></label>}
        <label>Stop loss<input value={sl} onChange={(e) => setSl(e.target.value)} placeholder="prix" /></label>
        <label>Take profit<input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="prix" /></label>
        <label>Risque %<input value={risk} onChange={(e) => setRisk(e.target.value)} /></label>
        <label>Quantité<input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="auto (risque)" /></label>
        <div className="buysell">
          <button className="buy" onClick={() => send(1)}>Acheter</button>
          <button className="sell" onClick={() => send(-1)}>Vendre</button>
        </div>
        <button onClick={() => session.closeAll()} disabled={!session.positions.length}>Tout clôturer</button>
      </div>
      <div className="trade-lists">
        <div className="cards">
          <div className="card"><small>Solde</small><b>{fmt(session.balance, 2)}</b></div>
          <div className="card"><small>Capital (avec positions)</small><b>{fmt(session.equity(), 2)}</b></div>
          <div className="card"><small>Résultat net</small><b className={stats.net >= 0 ? 'up' : 'down'}>{fmt(stats.net, 2)}</b></div>
          <div className="card"><small>Trades</small><b>{stats.trades}</b></div>
          <div className="card"><small>Taux de réussite</small><b>{fmt(stats.winRate, 1)} %</b></div>
          <div className="card"><small>Profit factor</small><b>{Number.isFinite(stats.profitFactor) ? fmt(stats.profitFactor, 2) : '∞'}</b></div>
          <div className="card"><small>Drawdown max</small><b className="down">{fmt(stats.maxDrawdown, 2)} %</b></div>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>État</th><th>Sens</th><th>Quantité</th><th>Entrée</th><th>Stop</th><th>Objectif</th><th>Sortie</th><th>Résultat</th><th /></tr></thead>
            <tbody>
              {session.positions.map((p) => (
                <tr key={`p${p.id}`}>
                  <td>Ouverte</td><td className={p.side > 0 ? 'up' : 'down'}>{p.side > 0 ? 'Achat' : 'Vente'}</td><td>{fmt(p.size, 4)}</td>
                  <td>{fmt(p.entry, d)}</td><td>{fmt(p.sl, d)}</td><td>{fmt(p.tp, d)}</td><td>—</td>
                  <td className={session.unrealized(p) >= 0 ? 'up' : 'down'}>{fmt(session.unrealized(p), 2)}</td>
                  <td><button onClick={() => session.close(p.id)}>Clôturer</button></td>
                </tr>
              ))}
              {session.orders.map((o) => (
                <tr key={`o${o.id}`}>
                  <td>En attente ({o.type})</td><td className={o.side > 0 ? 'up' : 'down'}>{o.side > 0 ? 'Achat' : 'Vente'}</td><td>{fmt(o.size, 4)}</td>
                  <td>{fmt(o.price, d)}</td><td>{fmt(o.sl, d)}</td><td>{fmt(o.tp, d)}</td><td>—</td><td>—</td>
                  <td><button onClick={() => session.cancelOrder(o.id)}>Annuler</button></td>
                </tr>
              ))}
              {session.history.slice(0, 200).map((t, i) => (
                <tr key={`h${i}`} onClick={() => goTo(t.time)}>
                  <td>Clôturée ({t.reason})</td><td className={t.side > 0 ? 'up' : 'down'}>{t.side > 0 ? 'Achat' : 'Vente'}</td><td>{fmt(t.size, 4)}</td>
                  <td>{fmt(t.entry, d)}</td><td>{fmt(t.sl, d)}</td><td>{fmt(t.tp, d)}</td><td>{fmt(t.exit, d)}</td>
                  <td className={t.pnl >= 0 ? 'up' : 'down'}>{fmt(t.pnl, 2)}</td><td />
                </tr>
              ))}
            </tbody>
          </table>
          {!session.positions.length && !session.orders.length && !session.history.length && (
            <div className="empty">Aucun trade. Lance un replay ou passe un ordre : les lignes de stop et d’objectif se déplacent à la souris sur le graphique.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- journal
function Journal({ onMessage }: { onMessage: Props['onMessage'] }): JSX.Element {
  const [rows, setRows] = useState<JournalRow[] | null>(null)
  const load = (): void => { api<JournalRow[]>('/api/journal').then(setRows).catch((e) => onMessage((e as Error).message, 'error')) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [])
  const total = (rows ?? []).reduce((s, r) => s + Number(r.data.pnl ?? 0), 0)
  return (
    <div className="journal">
      <div className="editor-bar">
        <span>{rows ? `${rows.length} trades enregistrés · résultat cumulé ` : 'Chargement…'}{rows && <b className={total >= 0 ? 'up' : 'down'}>{fmt(total, 2)}</b>}</span>
        <div className="spacer" />
        <button onClick={load}>Actualiser</button>
        <button onClick={() => { if (window.confirm('Vider tout le journal ?')) void api('/api/journal', 'DELETE').then(load) }}>Vider</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>Enregistré le</th><th>Symbole</th><th>UT</th><th>Sens</th><th>Entrée</th><th>Sortie</th><th>Motif</th><th>Résultat</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td>{fmtDate(r.created_at * 1000)}</td><td>{r.symbol}</td><td>{r.tf}</td>
                <td className={Number(r.data.side) > 0 ? 'up' : 'down'}>{Number(r.data.side) > 0 ? 'Achat' : 'Vente'}</td>
                <td>{fmt(Number(r.data.entry), 5)}</td><td>{fmt(Number(r.data.exit), 5)}</td><td>{String(r.data.reason ?? '')}</td>
                <td className={Number(r.data.pnl) >= 0 ? 'up' : 'down'}>{fmt(Number(r.data.pnl), 2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <div className="empty">Le journal est vide. Chaque trade clôturé en replay ou en simulation s’enregistre ici.</div>}
      </div>
    </div>
  )
}
