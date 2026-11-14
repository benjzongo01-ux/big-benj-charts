// État partagé hors de React : cotations, alertes de prix, historique annuler/rétablir, préférences d'affichage.
import { api, fetchCandles, fmt } from './api'

export interface PaneConfig {
  source: string
  symbol: string
  tf: string
  precision: number
}

export interface WatchItem extends PaneConfig {
  name: string
  market?: string
}

export const MARKET_LABEL: Record<string, string> = {
  crypto: 'Crypto', forex: 'Forex', indices: 'Indices', matieres: 'Matières premières', actions: 'Actions',
}
export const MARKET_ORDER = ['crypto', 'forex', 'indices', 'matieres', 'actions']

/** Catégorie d'un symbole (devinée pour les anciens éléments de la liste, qui ne la connaissent pas). */
export function marketOf(w: { source: string; symbol: string; market?: string }): string {
  if (w.market) return w.market
  if (w.source === 'binance') return 'crypto'
  if (w.source === 'yahoo' || w.source === 'twelvedata') return w.symbol.startsWith('^') ? 'indices' : 'actions'
  if (/IDX/.test(w.symbol)) return 'indices'
  if (/^(XAU|XAG)|CMD/.test(w.symbol)) return 'matieres'
  return 'forex'
}

export const keyOf = (source: string, symbol: string): string => `${source}:${symbol}`

// ---------------------------------------------------------------- préférences (localStorage)
export function loadPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? ({ ...fallback, ...JSON.parse(raw) } as T) : fallback
  } catch {
    return fallback // stockage indisponible (navigation privée)
  }
}

export function savePref(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* stockage indisponible : on continue sans mémoriser */
  }
}

/** Base commune : abonnement pour useSyncExternalStore. */
class Store {
  version = 0
  private listeners = new Set<() => void>()
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  getVersion = (): number => this.version
  protected emit(): void {
    this.version++
    this.listeners.forEach((fn) => fn())
  }
}

// ---------------------------------------------------------------- cotations
export interface Quote {
  price: number
  ref: number      // prix de référence pour la variation (clôture précédente)
  high: number
  low: number
  time: number
}

class QuoteStore extends Store {
  quotes: Record<string, Quote> = {}
  private pending = 0

  /** Prix en direct venant d'un graphique ouvert. L'affichage est regroupé (4 fois par seconde au plus). */
  setPrice(source: string, symbol: string, price: number): void {
    const k = keyOf(source, symbol)
    const q = this.quotes[k]
    if (q) {
      if (q.price === price) return
      this.quotes[k] = { ...q, price, high: Math.max(q.high, price), low: Math.min(q.low, price), time: Date.now() }
    } else this.quotes[k] = { price, ref: price, high: price, low: price, time: Date.now() }
    alerts.check(source, symbol, price)
    if (!this.pending) {
      this.pending = window.setTimeout(() => {
        this.pending = 0
        this.emit()
      }, 250)
    }
  }

  /** Rafraîchit les cotations de la liste de surveillance, toutes en parallèle. */
  async refresh(items: WatchItem[]): Promise<void> {
    await Promise.all(items.map(async (w) => {
      try {
        // Dukascopy : variation sur 24 h à partir des bougies 15 minutes (rapide à charger).
        const intraday = w.source === 'dukascopy'
        const bars = await fetchCandles(w.source, w.symbol, intraday ? '15m' : '1d', { limit: intraday ? 96 : 5 })
        if (!bars.length) return
        const last = bars[bars.length - 1]
        const ref = intraday ? bars[0].open : bars.length > 1 ? bars[bars.length - 2].close : last.open
        const high = intraday ? Math.max(...bars.map((b) => b.high)) : last.high
        const low = intraday ? Math.min(...bars.map((b) => b.low)) : last.low
        this.quotes[keyOf(w.source, w.symbol)] = { price: last.close, ref, high, low, time: Date.now() }
        alerts.check(w.source, w.symbol, last.close)
        this.emit()
      } catch {
        /* source indisponible : la ligne reste sans prix */
      }
    }))
  }
}

// ---------------------------------------------------------------- alertes de prix
export type AlertCondition = 'cross' | 'above' | 'below'
export const CONDITION_LABEL: Record<AlertCondition, string> = {
  cross: 'croise', above: 'passe au-dessus de', below: 'passe en dessous de',
}

export interface Alert {
  id: string
  source: string
  symbol: string
  precision: number
  price: number
  condition: AlertCondition
  message: string
  once: boolean       // true = une seule fois, false = à chaque fois
  active: boolean
  createdAt: number
  triggeredAt?: number
}

export interface Notice {
  id: number
  time: number
  text: string
  kind: 'alert' | 'info' | 'error'
}

const SEEN_KEY = 'bbc_alerts_seen'

function beep(): void {
  try {
    const ctx = new AudioContext()
    ;[0, 0.22].forEach((delay, i) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.frequency.value = i ? 1175 : 880
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay)
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.2)
      osc.connect(gain).connect(ctx.destination)
      osc.start(ctx.currentTime + delay)
      osc.stop(ctx.currentTime + delay + 0.22)
    })
    window.setTimeout(() => void ctx.close(), 800)
  } catch {
    /* son bloqué par le navigateur tant que l'utilisateur n'a pas cliqué sur la page */
  }
}

class AlertStore extends Store {
  alerts: Alert[] = []
  notices: Notice[] = []
  unread = 0
  loaded = false
  /** Appelé à chaque modification faite par l'utilisateur (pour annuler / rétablir). */
  onHistory: ((before: Alert[], after: Alert[]) => void) | null = null
  /** Appelé au déclenchement (toast dans l'application). */
  onTrigger: ((text: string) => void) | null = null
  private last = new Map<string, number>()
  private saveTimer = 0

  async load(): Promise<void> {
    try {
      this.alerts = await api<Alert[]>('/api/alerts')
    } catch {
      this.alerts = []
    }
    this.loaded = true
    this.emit()
    void this.catchUp()
    window.setInterval(() => savePref(SEEN_KEY, { t: Date.now() }), 30_000)
  }

  private save(): void {
    window.clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void api('/api/alerts', 'PUT', this.alerts).catch(() => undefined), 500)
  }

  /** Remplace la liste. `record` = l'action entre dans l'historique annuler / rétablir. */
  commit(next: Alert[], record = true): void {
    const before = this.alerts
    this.alerts = next
    if (record) this.onHistory?.(before, next)
    this.save()
    this.emit()
  }

  add(a: Omit<Alert, 'id' | 'createdAt' | 'active'>): void {
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission()
    this.commit([...this.alerts, { ...a, id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, createdAt: Date.now(), active: true }])
  }

  update(id: string, patch: Partial<Alert>): void {
    this.commit(this.alerts.map((a) => (a.id === id ? { ...a, ...patch } : a)))
  }

  remove(id: string): void {
    this.commit(this.alerts.filter((a) => a.id !== id))
  }

  notify(text: string, kind: Notice['kind'] = 'info'): void {
    this.notices = [{ id: Date.now() + Math.random(), time: Date.now(), text, kind }, ...this.notices].slice(0, 100)
    this.unread++
    this.emit()
  }

  markRead(): void {
    if (!this.unread) return
    this.unread = 0
    this.emit()
  }

  /** Nouveau prix connu pour un symbole : teste les alertes actives de ce symbole. */
  check(source: string, symbol: string, price: number): void {
    const k = keyOf(source, symbol)
    const prev = this.last.get(k)
    this.last.set(k, price)
    if (prev === undefined || prev === price || !this.alerts.length) return
    const hit = this.alerts.filter((a) => a.active && a.source === source && a.symbol === symbol && (
      a.condition === 'above' ? prev < a.price && price >= a.price
        : a.condition === 'below' ? prev > a.price && price <= a.price
          : (prev - a.price) * (price - a.price) <= 0 && prev !== a.price))
    if (hit.length) this.trigger(hit, price, false)
  }

  private trigger(hit: Alert[], price: number, late: boolean): void {
    const ids = new Set(hit.map((a) => a.id))
    hit.forEach((a) => {
      const text = `${a.symbol} ${CONDITION_LABEL[a.condition]} ${fmt(a.price, a.precision)}`
        + (late ? ' (pendant ton absence)' : ` · prix ${fmt(price, a.precision)}`) + (a.message ? ` · ${a.message}` : '')
      this.notify(`Alerte : ${text}`, 'alert')
      this.onTrigger?.(`🔔 ${text}`)
      try {
        if ('Notification' in window && Notification.permission === 'granted') new Notification('Big Benj Charts', { body: text, tag: a.id })
      } catch {
        /* notifications refusées ou indisponibles */
      }
    })
    beep()
    // Une alerte « une seule fois » se désactive ; les autres restent armées.
    this.commit(this.alerts.map((a) => (ids.has(a.id) ? { ...a, triggeredAt: Date.now(), active: a.once ? false : a.active } : a)), false)
  }

  /** À l'ouverture : vérifie dans l'historique si une alerte a été franchie pendant que l'onglet était fermé. */
  private async catchUp(): Promise<void> {
    const seen = loadPref<{ t: number }>(SEEN_KEY, { t: 0 }).t
    savePref(SEEN_KEY, { t: Date.now() })
    const gap = Date.now() - seen
    if (!seen || gap < 90_000) return
    const groups = new Map<string, Alert[]>()
    this.alerts.filter((a) => a.active && a.createdAt < Date.now() - 60_000).forEach((a) => {
      const k = keyOf(a.source, a.symbol)
      groups.set(k, [...(groups.get(k) ?? []), a])
    })
    for (const list of groups.values()) {
      try {
        const bars = await fetchCandles(list[0].source, list[0].symbol, gap < 2 * 86_400_000 ? '5m' : '1h', { start: seen })
        if (!bars.length) continue
        const ref = bars[0].open
        const high = Math.max(...bars.map((b) => b.high))
        const low = Math.min(...bars.map((b) => b.low))
        const hit = list.filter((a) => a.createdAt <= bars[bars.length - 1].timestamp && (
          a.condition === 'above' ? ref < a.price && high >= a.price
            : a.condition === 'below' ? ref > a.price && low <= a.price
              : low <= a.price && high >= a.price))
        if (hit.length) this.trigger(hit, bars[bars.length - 1].close, true)
      } catch {
        /* données indisponibles : pas de rattrapage pour ce symbole */
      }
    }
  }
}

// ---------------------------------------------------------------- annuler / rétablir
export type HistoryEntry =
  | { kind: 'drawings'; source: string; symbol: string; before: unknown[]; after: unknown[] }
  | { kind: 'alerts'; before: Alert[]; after: Alert[] }

class HistoryStore extends Store {
  private undoStack: HistoryEntry[] = []
  private redoStack: HistoryEntry[] = []
  /** Vrai pendant qu'on rejoue une action : elle ne doit pas se réenregistrer elle-même. */
  replaying = false

  get canUndo(): boolean { return this.undoStack.length > 0 }
  get canRedo(): boolean { return this.redoStack.length > 0 }

  push(entry: HistoryEntry): void {
    if (this.replaying) return
    this.undoStack.push(entry)
    if (this.undoStack.length > 100) this.undoStack.shift()
    this.redoStack = []
    this.emit()
  }

  undo(): HistoryEntry | null {
    const e = this.undoStack.pop() ?? null
    if (e) this.redoStack.push(e)
    this.emit()
    return e
  }

  redo(): HistoryEntry | null {
    const e = this.redoStack.pop() ?? null
    if (e) this.undoStack.push(e)
    this.emit()
    return e
  }
}

export const alerts = new AlertStore()
export const quotes = new QuoteStore()
export const history = new HistoryStore()
alerts.onHistory = (before, after) => history.push({ kind: 'alerts', before, after })
