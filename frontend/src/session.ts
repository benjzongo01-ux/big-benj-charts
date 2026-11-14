// Session de trading simulé (replay ou temps réel) : ordres, positions, stops, statistiques.
import { api, type Bar } from './api'
import { loadPref, savePref } from './stores'

export interface Position {
  id: number
  side: 1 | -1
  size: number
  entry: number
  time: number
  sl: number | null
  tp: number | null
}

export interface Order extends Omit<Position, 'entry' | 'time'> {
  type: 'limit' | 'stop'
  price: number
}

export interface ClosedTrade extends Position {
  exit: number
  exitTime: number
  pnl: number
  reason: string
}

export interface Stats {
  trades: number
  winRate: number
  profitFactor: number
  net: number
  maxDrawdown: number
  avgWin: number
  avgLoss: number
}

export class TradingSession {
  startBalance = 10_000
  balance = 10_000
  positions: Position[] = []
  orders: Order[] = []
  history: ClosedTrade[] = []
  price = 0
  time = 0
  context = { source: '', symbol: '', tf: '' }
  version = 0
  /** Écart achat/vente simulé (en unités de prix) et quantité des boutons Achat / Vente rapides (0 = automatique). */
  spread = loadPref('bbc_trade', { spread: 0, quick: 0 }).spread
  quickQty = loadPref('bbc_trade', { spread: 0, quick: 0 }).quick
  private nextId = 1
  private peak = 10_000
  private maxDd = 0
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getVersion = (): number => this.version

  private emit(): void {
    this.version++
    this.listeners.forEach((fn) => fn())
  }

  /** Remet la session à zéro (nouveau symbole ou nouveau replay). */
  reset(context: { source: string; symbol: string; tf: string }, balance = this.startBalance): void {
    this.context = context
    this.startBalance = this.balance = this.peak = balance
    this.positions = []
    this.orders = []
    this.history = []
    this.maxDd = 0
    this.price = 0
    this.emit()
  }

  setTradeOptions(spread: number, quickQty: number): void {
    this.spread = Math.max(0, spread)
    this.quickQty = Math.max(0, quickQty)
    savePref('bbc_trade', { spread: this.spread, quick: this.quickQty })
    this.emit()
  }

  /** Prix de vente (bid) et d'achat (ask) autour du dernier prix. */
  get bid(): number { return this.price - this.spread / 2 }
  get ask(): number { return this.price + this.spread / 2 }

  /** Quantité des ordres rapides : celle choisie, sinon 10 % du capital. */
  defaultSize(): number {
    if (this.quickQty > 0) return this.quickQty
    return this.price > 0 ? (this.equity() * 0.1) / this.price : 0
  }

  unrealized(p: Position): number {
    return (this.price - p.entry) * p.size * p.side
  }

  equity(): number {
    return this.balance + this.positions.reduce((s, p) => s + this.unrealized(p), 0)
  }

  /** Taille de position pour risquer `riskPct` % du capital entre l'entrée et le stop. */
  sizeForRisk(riskPct: number, entry: number, sl: number): number {
    const distance = Math.abs(entry - sl)
    return distance > 0 ? (this.equity() * riskPct) / 100 / distance : 0
  }

  market(side: 1 | -1, size: number, sl: number | null, tp: number | null): string | null {
    if (!(this.price > 0)) return 'Aucun prix disponible pour le moment.'
    if (!(size > 0)) return 'Taille de position invalide.'
    const fill = side === 1 ? this.ask : this.bid // on achète au prix haut, on vend au prix bas
    const bad = this.checkLevels(side, fill, sl, tp)
    if (bad) return bad
    this.positions.push({ id: this.nextId++, side, size, entry: fill, time: this.time, sl, tp })
    this.emit()
    return null
  }

  place(side: 1 | -1, type: 'limit' | 'stop', price: number, size: number, sl: number | null, tp: number | null): string | null {
    if (!(price > 0) || !(size > 0)) return 'Prix ou taille invalide.'
    const bad = this.checkLevels(side, price, sl, tp)
    if (bad) return bad
    this.orders.push({ id: this.nextId++, side, type, price, size, sl, tp })
    this.emit()
    return null
  }

  private checkLevels(side: 1 | -1, entry: number, sl: number | null, tp: number | null): string | null {
    if (sl !== null && (side === 1 ? sl >= entry : sl <= entry)) return 'Le stop loss est du mauvais côté du prix d’entrée.'
    if (tp !== null && (side === 1 ? tp <= entry : tp >= entry)) return 'Le take profit est du mauvais côté du prix d’entrée.'
    return null
  }

  modify(id: number, change: { sl?: number | null; tp?: number | null }): void {
    const p = this.positions.find((x) => x.id === id)
    if (!p) return
    Object.assign(p, change)
    this.emit()
  }

  modifyOrder(id: number, price: number): void {
    const o = this.orders.find((x) => x.id === id)
    if (!o) return
    o.price = price
    this.emit()
  }

  cancelOrder(id: number): void {
    this.orders = this.orders.filter((o) => o.id !== id)
    this.emit()
  }

  close(id: number, price = this.price, reason = 'manuel', silent = false): void {
    const p = this.positions.find((x) => x.id === id)
    if (!p) return
    if (reason === 'manuel') price -= (p.side * this.spread) / 2 // clôture manuelle : du mauvais côté du spread
    const pnl = (price - p.entry) * p.size * p.side
    this.balance += pnl
    this.positions = this.positions.filter((x) => x.id !== id)
    const trade: ClosedTrade = { ...p, exit: price, exitTime: this.time, pnl, reason }
    this.history.unshift(trade)
    // Sauvegarde dans le journal (sans bloquer l'interface).
    void api('/api/journal', 'POST', { kind: 'trade', ...this.context, data: trade }).catch(() => undefined)
    if (!silent) this.emit()
  }

  closeAll(): void {
    ;[...this.positions].forEach((p) => this.close(p.id, this.price, 'manuel', true))
    this.emit()
  }

  /** Nouvelle bougie complète (mode replay) : exécute les ordres en attente puis teste stops et objectifs. */
  onBar(bar: Bar): void {
    this.time = bar.timestamp
    for (const o of [...this.orders]) {
      const hit = o.type === 'limit'
        ? (o.side === 1 ? bar.low <= o.price : bar.high >= o.price)
        : (o.side === 1 ? bar.high >= o.price : bar.low <= o.price)
      if (!hit) continue
      // En cas de gap, un ordre stop est exécuté à l'ouverture (prix moins favorable).
      const fill = o.type === 'stop' ? (o.side === 1 ? Math.max(o.price, bar.open) : Math.min(o.price, bar.open)) : o.price
      this.orders = this.orders.filter((x) => x.id !== o.id)
      this.positions.push({ id: o.id, side: o.side, size: o.size, entry: fill, time: bar.timestamp, sl: o.sl, tp: o.tp })
    }
    for (const p of [...this.positions]) {
      if (p.time === bar.timestamp && p.entry !== bar.open) continue // ouverte pendant cette bougie : testée à la suivante
      if (p.side === 1) {
        if (p.sl !== null && bar.low <= p.sl) this.close(p.id, Math.min(bar.open, p.sl), 'stop', true)
        else if (p.tp !== null && bar.high >= p.tp) this.close(p.id, Math.max(bar.open, p.tp), 'objectif', true)
      } else {
        if (p.sl !== null && bar.high >= p.sl) this.close(p.id, Math.max(bar.open, p.sl), 'stop', true)
        else if (p.tp !== null && bar.low <= p.tp) this.close(p.id, Math.min(bar.open, p.tp), 'objectif', true)
      }
    }
    this.price = bar.close
    this.track()
    this.emit()
  }

  /** Nouveau prix en temps réel : même logique, sur un seul prix. */
  onPrice(price: number, time: number): void {
    if (price === this.price) return
    this.onBar({ timestamp: time, open: price, high: price, low: price, close: price, volume: 0 })
  }

  private track(): void {
    const eq = this.equity()
    if (eq > this.peak) this.peak = eq
    const dd = this.peak > 0 ? ((this.peak - eq) / this.peak) * 100 : 0
    if (dd > this.maxDd) this.maxDd = dd
  }

  stats(): Stats {
    const wins = this.history.filter((t) => t.pnl > 0)
    const losses = this.history.filter((t) => t.pnl <= 0)
    const gain = wins.reduce((s, t) => s + t.pnl, 0)
    const loss = -losses.reduce((s, t) => s + t.pnl, 0)
    return {
      trades: this.history.length,
      winRate: this.history.length ? (wins.length / this.history.length) * 100 : 0,
      profitFactor: loss > 0 ? gain / loss : wins.length ? Infinity : 0,
      net: this.balance - this.startBalance,
      maxDrawdown: this.maxDd,
      avgWin: wins.length ? gain / wins.length : 0,
      avgLoss: losses.length ? -loss / losses.length : 0,
    }
  }
}
