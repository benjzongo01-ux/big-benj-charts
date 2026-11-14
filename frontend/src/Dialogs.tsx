// Fenêtres : connexion, recherche de symbole, création ou modification d'une alerte.
import { useEffect, useMemo, useState } from 'react'
import { api, setToken, type SourceInfo, type SymbolInfo } from './api'
import { signInGoogle } from './google'
import { CONDITION_LABEL, MARKET_LABEL, type AlertCondition, type PaneConfig, type WatchItem } from './stores'

// ---------------------------------------------------------------- connexion (version publique)
export function Login({ onDone, google }: { onDone: () => void; google: boolean }): JSX.Element {
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
  const [busy, setBusy] = useState(false)
  const withGoogle = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await signInGoogle()
      onDone()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }
  if (google) {
    return (
      <div className="login">
        <form onSubmit={(e) => e.preventDefault()}>
          <div className="brand big"><span className="logo">B</span>Big Benj Charts</div>
          <p className="login-text">Backtesting, replay et analyse des marchés en temps réel.</p>
          <button type="button" className="google" onClick={() => void withGoogle()} disabled={busy}>
            <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
              <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.2C12.4 13.6 17.7 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 7l7.6 5.9c4.4-4.1 6.7-10.1 6.7-17.3z" />
              <path fill="#FBBC05" d="M10.5 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.2C.9 16.5 0 20.1 0 24s.9 7.5 2.6 10.8l7.9-6.2z" />
              <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.6-5.9c-2.1 1.4-4.9 2.3-8.3 2.3-6.3 0-11.6-4.2-13.5-9.9l-7.9 6.2C6.5 42.6 14.6 48 24 48z" />
            </svg>
            {busy ? 'Connexion…' : 'Continuer avec Google'}
          </button>
          {error && <div className="form-error">{error}</div>}
          <small className="muted">Ton compte est créé automatiquement à la première connexion.</small>
        </form>
      </div>
    )
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
export function SymbolSearch(props: {
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

// ---------------------------------------------------------------- alerte de prix
export interface AlertDraft {
  id?: string
  source: string
  symbol: string
  precision: number
  price: number
  condition: AlertCondition
  message: string
  once: boolean
}

export function AlertDialog({ draft, onSave, onClose }: { draft: AlertDraft; onSave: (d: AlertDraft) => void; onClose: () => void }): JSX.Element {
  const [price, setPrice] = useState(draft.price.toFixed(draft.precision))
  const [condition, setCondition] = useState<AlertCondition>(draft.condition)
  const [message, setMessage] = useState(draft.message)
  const [once, setOnce] = useState(draft.once)
  const [error, setError] = useState('')
  const submit = (e: React.FormEvent): void => {
    e.preventDefault()
    const value = Number(price.replace(',', '.'))
    if (!(value > 0)) {
      setError('Indique un prix valide.')
      return
    }
    onSave({ ...draft, price: value, condition, message: message.trim(), once })
  }
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <form className="modal small" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}
        onKeyDown={(e) => { if (e.key === 'Escape') onClose() }}>
        <div className="modal-title">{draft.id ? 'Modifier l’alerte' : 'Nouvelle alerte'} · {draft.symbol}</div>
        <div className="form-grid">
          <label>Condition
            <select value={condition} onChange={(e) => setCondition(e.target.value as AlertCondition)}>
              {(Object.keys(CONDITION_LABEL) as AlertCondition[]).map((c) => <option key={c} value={c}>Le prix {CONDITION_LABEL[c]}</option>)}
            </select>
          </label>
          <label>Prix<input autoFocus value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" /></label>
          <label className="wide">Message (facultatif)
            <input value={message} onChange={(e) => setMessage(e.target.value)} maxLength={120} placeholder="Ex. : cassure de la résistance" />
          </label>
          <label className="check wide"><input type="radio" checked={once} onChange={() => setOnce(true)} />Une seule fois</label>
          <label className="check wide"><input type="radio" checked={!once} onChange={() => setOnce(false)} />À chaque fois</label>
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Annuler</button>
          <button type="submit" className="primary">{draft.id ? 'Enregistrer' : 'Créer l’alerte'}</button>
        </div>
      </form>
    </div>
  )
}
