// Panneau de droite repliable : liste de surveillance, alertes, ordres, séances, notifications,
// avec la colonne d'icônes tout à droite.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { fmt, fmtDate } from './api'
import { Icon } from './icons'
import { canInstall, enablePush, installApp, needsHomeScreen, onPushChange, pushStatus, testPush } from './push'
import type { TradingSession } from './session'
import { alerts, CONDITION_LABEL, keyOf, MARKET_LABEL, MARKET_ORDER, marketOf, quotes, type Alert, type PaneConfig, type WatchItem } from './stores'

export type SideTab = 'watch' | 'alerts' | 'orders' | 'calendar' | 'notices'

interface Props {
  tab: SideTab | null
  width: number
  items: WatchItem[]
  current: PaneConfig
  session: TradingSession
  onTab: (tab: SideTab | null) => void
  onWidth: (w: number) => void
  onPick: (w: WatchItem) => void
  onRemove: (w: WatchItem) => void
  onAdd: () => void
  onNewAlert: () => void
  onEditAlert: (a: Alert) => void
}

const RAIL: [SideTab, string, string][] = [
  ['watch', 'list', 'Liste de surveillance'], ['alerts', 'alarm', 'Alertes'], ['orders', 'orders', 'Ordres et positions'],
  ['calendar', 'calendar', 'Séances de marché'], ['notices', 'bell', 'Notifications'],
]
export const SIDE_MIN = 240
export const SIDE_MAX = 520

const sign = (n: number): string => (n >= 0 ? '+' : '')

// ---------------------------------------------------------------- liste de surveillance + fiche du symbole
export function Watch({ items, current, onPick, onRemove, onAdd, onNewAlert }: Pick<Props, 'items' | 'current' | 'onPick' | 'onRemove' | 'onAdd' | 'onNewAlert'>): JSX.Element {
  useSyncExternalStore(quotes.subscribe, quotes.getVersion)
  const key = items.map((w) => keyOf(w.source, w.symbol)).join(',')
  useEffect(() => {
    void quotes.refresh(items)
    const timer = window.setInterval(() => void quotes.refresh(items), 30_000)
    return () => window.clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const groups = MARKET_ORDER.map((m) => ({ market: m, list: items.filter((w) => marketOf(w) === m) })).filter((g) => g.list.length)
  const cq = quotes.quotes[keyOf(current.source, current.symbol)]
  const info = items.find((w) => w.source === current.source && w.symbol === current.symbol)
  const diff = cq ? cq.price - cq.ref : 0
  return (
    <>
      <div className="side-title">Liste de surveillance
        <button className="icon" onClick={onAdd} title="Ajouter un symbole"><Icon name="plus" size={16} /></button>
      </div>
      <div className="watch">
        <div className="w-row w-head"><span>Symbole</span><span>Dernier</span><span>Var.</span><span>Var.%</span></div>
        {groups.map((g) => (
          <div key={g.market}>
            <div className="w-group">{MARKET_LABEL[g.market] ?? g.market}</div>
            {g.list.map((w) => {
              const q = quotes.quotes[keyOf(w.source, w.symbol)]
              const d = q ? q.price - q.ref : 0
              const cls = d >= 0 ? 'up' : 'down'
              const on = w.source === current.source && w.symbol === current.symbol
              return (
                <div key={keyOf(w.source, w.symbol)} className={`w-row${on ? ' on' : ''}`} onClick={() => onPick(w)} title={w.name}>
                  <span className="w-sym">{w.symbol}</span>
                  <span>{q ? fmt(q.price, w.precision) : '—'}</span>
                  <span className={q ? cls : ''}>{q ? `${sign(d)}${fmt(d, w.precision)}` : ''}</span>
                  <span className={q ? cls : ''}>{q && q.ref ? `${sign(d)}${((d / q.ref) * 100).toFixed(2)}%` : ''}</span>
                  <button className="icon del" title="Retirer de la liste" onClick={(e) => { e.stopPropagation(); onRemove(w) }}><Icon name="close" size={12} /></button>
                </div>
              )
            })}
          </div>
        ))}
        {!items.length && <div className="empty">Ajoute des symboles avec le bouton +.</div>}
      </div>
      <div className="symbol-card">
        <div className="sc-name"><b>{current.symbol}</b><span>{info?.name ?? ''}</span></div>
        <div className="sc-meta">{MARKET_LABEL[marketOf(info ?? current)] ?? ''} · {current.source}</div>
        <div className="sc-price">
          <b>{cq ? fmt(cq.price, current.precision) : '—'}</b>
          {cq && <span className={diff >= 0 ? 'up' : 'down'}>{sign(diff)}{fmt(diff, current.precision)} ({sign(diff)}{cq.ref ? ((diff / cq.ref) * 100).toFixed(2) : '0.00'} %)</span>}
        </div>
        {cq && <div className="sc-range"><span>Bas {fmt(cq.low, current.precision)}</span><span>Haut {fmt(cq.high, current.precision)}</span></div>}
        <button className="sc-alert" onClick={onNewAlert}><Icon name="alarm" size={14} /> Créer une alerte</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- cet appareil : notifications et installation
function DeviceBlock(): JSX.Element | null {
  const [, tick] = useState(0)
  const [busy, setBusy] = useState(false)
  const [info, setInfo] = useState('')
  useEffect(() => onPushChange(() => tick((n) => n + 1)), [])
  const status = pushStatus()
  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true)
    try {
      setInfo(await fn())
    } catch (e) {
      setInfo((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (status === 'local' && !canInstall()) return null
  return (
    <div className="device">
      {status === 'on' && <div className="device-state"><span className="dot on" />Cet appareil sonne quand une alerte est atteinte, même application fermée.</div>}
      {status === 'off' && (
        <>
          <div className="device-state"><span className="dot warn" />Cet appareil ne reçoit pas encore les alertes quand l’application est fermée.</div>
          {needsHomeScreen()
            ? <div className="side-note">Sur iPhone : ouvre le menu Partager de Safari, choisis « Sur l’écran d’accueil », puis rouvre l’application depuis son icône.</div>
            : <button className="primary" disabled={busy} onClick={() => void run(async () => ((await enablePush()) === 'on' ? 'Notifications activées sur cet appareil.' : 'Autorisation refusée.'))}>Activer la sonnerie sur cet appareil</button>}
        </>
      )}
      {status === 'denied' && <div className="device-state"><span className="dot bad" />Notifications bloquées pour ce site. Autorise-les dans les réglages du navigateur (icône à gauche de l’adresse), puis recharge la page.</div>}
      {status === 'unsupported' && <div className="device-state"><span className="dot" />Ce navigateur ne sait pas recevoir de notifications. Utilise Chrome, ou installe l’application.</div>}
      {status === 'on' && (
        <button disabled={busy} onClick={() => void run(async () => {
          const r = await testPush()
          return r.sent ? `Notification d’essai envoyée à ${r.sent} appareil${r.sent > 1 ? 's' : ''}. Passe sur une autre application pour la voir arriver.` : 'Aucun appareil inscrit pour le moment.'
        })}>Tester la sonnerie</button>
      )}
      {canInstall() && <button disabled={busy} onClick={() => void installApp()}>Installer l’application sur cet appareil</button>}
      {info && <div className="side-note">{info}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- alertes
export function Alerts({ onNewAlert, onEditAlert }: Pick<Props, 'onNewAlert' | 'onEditAlert'>): JSX.Element {
  useSyncExternalStore(alerts.subscribe, alerts.getVersion)
  return (
    <>
      <div className="side-title">Alertes
        <button className="icon" onClick={onNewAlert} title="Nouvelle alerte (Alt+A)"><Icon name="plus" size={16} /></button>
      </div>
      <div className="side-list">
        <DeviceBlock />
        {alerts.alerts.map((a) => (
          <div key={a.id} className={`a-row${a.active ? '' : ' off'}`}>
            <div className="a-main">
              <b>{a.symbol}</b> {CONDITION_LABEL[a.condition]} <b>{fmt(a.price, a.precision)}</b>
              <small>
                {a.active ? (a.once ? 'Active · une seule fois' : 'Active · à chaque fois') : a.triggeredAt && a.once ? `Déclenchée le ${fmtDate(a.triggeredAt)}` : 'En pause'}
                {a.message ? ` · ${a.message}` : ''}
              </small>
            </div>
            <button className="icon" title="Modifier" onClick={() => onEditAlert(a)}><Icon name="edit" size={14} /></button>
            <button className="icon" title={a.active ? 'Mettre en pause' : 'Réactiver'} onClick={() => alerts.update(a.id, { active: !a.active })}>
              <Icon name={a.active ? 'pause' : 'play'} size={14} />
            </button>
            <button className="icon" title="Supprimer" onClick={() => alerts.remove(a.id)}><Icon name="trash" size={14} /></button>
          </div>
        ))}
        {!alerts.alerts.length && (
          <div className="empty">Aucune alerte. Crée-en une avec le bouton +, un clic droit sur le graphique ou Alt+A.</div>
        )}
        <div className="side-note">Tes alertes sont les mêmes sur tous les appareils connectés à ton compte. Crypto, forex et matières premières sont surveillés par le serveur toutes les 10 secondes.</div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- ordres et positions (simulation)
export function Orders({ session }: { session: TradingSession }): JSX.Element {
  useSyncExternalStore(session.subscribe, session.getVersion)
  return (
    <>
      <div className="side-title">Ordres et positions</div>
      <div className="side-list">
        <div className="o-sum"><span>Solde <b>{fmt(session.balance, 2)}</b></span><span>Capital <b>{fmt(session.equity(), 2)}</b></span></div>
        {session.positions.map((p) => {
          const pnl = session.unrealized(p)
          return (
            <div key={`p${p.id}`} className="a-row">
              <div className="a-main">
                <b className={p.side > 0 ? 'up' : 'down'}>{p.side > 0 ? 'Achat' : 'Vente'}</b> {fmt(p.size, 4)} {session.context.symbol}
                <small>Entrée {fmt(p.entry, 5)} · <span className={pnl >= 0 ? 'up' : 'down'}>{sign(pnl)}{fmt(pnl, 2)}</span></small>
              </div>
              <button onClick={() => session.close(p.id)}>Clôturer</button>
            </div>
          )
        })}
        {session.orders.map((o) => (
          <div key={`o${o.id}`} className="a-row">
            <div className="a-main">
              <b className={o.side > 0 ? 'up' : 'down'}>{o.side > 0 ? 'Achat' : 'Vente'} {o.type === 'limit' ? 'limite' : 'stop'}</b> {fmt(o.size, 4)}
              <small>En attente à {fmt(o.price, 5)}</small>
            </div>
            <button onClick={() => session.cancelOrder(o.id)}>Annuler</button>
          </div>
        ))}
        {!session.positions.length && !session.orders.length && <div className="empty">Aucune position ni ordre en attente.</div>}
        <div className="side-note">Trading simulé : aucun ordre réel n’est envoyé à un courtier.</div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- séances de marché
const MARKETS: [string, string, string, number, number, boolean][] = [
  // nom, fuseau, ville, ouverture (minutes), fermeture (minutes), ouvert le week-end
  ['Crypto', 'UTC', '24 h / 24', 0, 1440, true],
  ['Forex · Sydney', 'Australia/Sydney', 'Sydney', 7 * 60, 16 * 60, false],
  ['Forex · Tokyo', 'Asia/Tokyo', 'Tokyo', 9 * 60, 18 * 60, false],
  ['Forex · Londres', 'Europe/London', 'Londres', 8 * 60, 17 * 60, false],
  ['Forex · New York', 'America/New_York', 'New York', 8 * 60, 17 * 60, false],
  ['Euronext Paris', 'Europe/Paris', 'Paris', 9 * 60, 17 * 60 + 30, false],
  ['NYSE / Nasdaq', 'America/New_York', 'New York', 9 * 60 + 30, 16 * 60, false],
]
const hm = (m: number): string => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export function Sessions(): JSX.Element {
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000)
    return () => window.clearInterval(t)
  }, [])
  const now = new Date()
  return (
    <>
      <div className="side-title">Séances de marché</div>
      <div className="side-list">
        {MARKETS.map(([name, zone, city, open, close, weekend]) => {
          const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now)
          const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? ''
          const minutes = (Number(get('hour')) % 24) * 60 + Number(get('minute'))
          const isOpen = weekend || (!['Sat', 'Sun'].includes(get('weekday')) && minutes >= open && minutes < close)
          return (
            <div key={name} className="a-row">
              <span className={`dot${isOpen ? ' on' : ''}`} />
              <div className="a-main"><b>{name}</b>
                <small>{weekend ? city : `${hm(open)} – ${hm(close)}, heure de ${city} (${get('hour')}:${get('minute')} là-bas)`}</small>
              </div>
              <span className={isOpen ? 'up' : 'muted'}>{isOpen ? 'Ouvert' : 'Fermé'}</span>
            </div>
          )
        })}
        <div className="side-note">Horaires habituels, hors jours fériés. Il n’y a pas de calendrier économique : aucune source gratuite fiable n’est branchée.</div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------- notifications
export function Notices(): JSX.Element {
  useSyncExternalStore(alerts.subscribe, alerts.getVersion)
  useEffect(() => { alerts.markRead() })
  return (
    <>
      <div className="side-title">Notifications</div>
      <div className="side-list">
        {alerts.notices.map((n) => (
          <div key={n.id} className="a-row">
            <span className={`dot${n.kind === 'alert' ? ' warn' : n.kind === 'error' ? ' bad' : ''}`} />
            <div className="a-main">{n.text}<small>{fmtDate(n.time)}</small></div>
          </div>
        ))}
        {!alerts.notices.length && <div className="empty">Aucune notification depuis l’ouverture de la page.</div>}
      </div>
    </>
  )
}

// ---------------------------------------------------------------- panneau + colonne d'icônes
export default function RightPanel(props: Props): JSX.Element {
  const { tab, width, onTab, onWidth } = props
  useSyncExternalStore(alerts.subscribe, alerts.getVersion)
  const drag = useRef<{ x: number; w: number } | null>(null)
  return (
    <aside className="side">
      {tab && (
        <div className="side-panel" style={{ width }}>
          <div className="side-grip" title="Glisser pour redimensionner"
            onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); drag.current = { x: e.clientX, w: width } }}
            onPointerMove={(e) => { if (drag.current) onWidth(Math.min(SIDE_MAX, Math.max(SIDE_MIN, drag.current.w + drag.current.x - e.clientX))) }}
            onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} />
          {tab === 'watch' && <Watch {...props} />}
          {tab === 'alerts' && <Alerts {...props} />}
          {tab === 'orders' && <Orders session={props.session} />}
          {tab === 'calendar' && <Sessions />}
          {tab === 'notices' && <Notices />}
        </div>
      )}
      <nav className="side-rail">
        {RAIL.map(([id, icon, label]) => (
          <button key={id} className={`icon${tab === id ? ' on' : ''}`} title={tab === id ? `Replier : ${label}` : label} onClick={() => onTab(tab === id ? null : id)}>
            <Icon name={icon} />
            {id === 'notices' && alerts.unread > 0 && <span className="badge">{alerts.unread > 9 ? '9+' : alerts.unread}</span>}
            {id === 'alerts' && alerts.alerts.some((a) => a.active) && <span className="badge quiet">{alerts.alerts.filter((a) => a.active).length}</span>}
          </button>
        ))}
      </nav>
    </aside>
  )
}
