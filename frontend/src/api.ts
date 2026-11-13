// Accès au serveur : requêtes REST, bougies en binaire, flux temps réel.

export interface Bar {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface SymbolInfo {
  symbol: string
  name: string
  market: string
  precision: number
}

export interface SourceInfo {
  name: string
  label: string
  markets: string[]
  available: boolean
  message: string
}

export const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const
export const TF_LABEL: Record<string, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '4h': '4h', '1d': '1J', '1w': '1S',
}
export const TF_MS: Record<string, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
}

const TOKEN_KEY = 'bbc_token'
export const getToken = (): string => localStorage.getItem(TOKEN_KEY) ?? ''
export const setToken = (t: string): void => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

function headers(json = false): HeadersInit {
  const h: Record<string, string> = {}
  if (json) h['Content-Type'] = 'application/json'
  const t = getToken()
  if (t) h.Authorization = `Bearer ${t}`
  return h
}

async function fail(r: Response): Promise<never> {
  let message = `Erreur ${r.status}`
  try {
    const body = await r.json()
    if (body?.detail) message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
  } catch {
    /* réponse sans JSON */
  }
  const err = new Error(message) as Error & { status?: number }
  err.status = r.status
  throw err
}

export async function api<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  let r: Response
  try {
    r = await fetch(path, { method, headers: headers(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined })
  } catch {
    throw new Error('Serveur injoignable. Vérifie que le backend est lancé.')
  }
  if (!r.ok) return fail(r)
  return (await r.json()) as T
}

/** Bougies au format binaire (float64 x 6 colonnes) : décodage instantané, sans JSON. */
export async function fetchCandles(
  source: string, symbol: string, tf: string, opt: { start?: number; end?: number; limit?: number } = {},
): Promise<Bar[]> {
  const q = new URLSearchParams({ source, symbol, tf })
  if (opt.start !== undefined) q.set('start', String(Math.floor(opt.start)))
  if (opt.end !== undefined) q.set('end', String(Math.floor(opt.end)))
  if (opt.limit !== undefined) q.set('limit', String(opt.limit))
  let r: Response
  try {
    r = await fetch(`/api/candles?${q}`, { headers: headers() })
  } catch {
    throw new Error('Serveur injoignable. Vérifie que le backend est lancé.')
  }
  if (!r.ok) return fail(r)
  const f = new Float64Array(await r.arrayBuffer())
  const n = Math.floor(f.length / 6)
  const out: Bar[] = new Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 6) {
    out[i] = { timestamp: f[j], open: f[j + 1], high: f[j + 2], low: f[j + 3], close: f[j + 4], volume: f[j + 5] }
  }
  return out
}

/** Flux temps réel avec reconnexion automatique. Renvoie la fonction d'arrêt. */
export function openStream(source: string, symbol: string, tf: string, onBar: (b: Bar) => void): () => void {
  let ws: WebSocket | null = null
  let closed = false
  let retry = 0
  let timer = 0
  const connect = (): void => {
    if (closed) return
    const q = new URLSearchParams({ source, symbol, tf })
    if (getToken()) q.set('token', getToken())
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/stream?${q}`)
    ws.onmessage = (e) => {
      retry = 0
      const d = JSON.parse(e.data as string)
      if (Array.isArray(d)) onBar({ timestamp: d[0], open: d[1], high: d[2], low: d[3], close: d[4], volume: d[5] })
    }
    ws.onclose = () => {
      if (closed) return
      retry = Math.min(retry + 1, 10)
      timer = window.setTimeout(connect, retry * 1000)
    }
    ws.onerror = () => ws?.close()
  }
  connect()
  return () => {
    closed = true
    window.clearTimeout(timer)
    ws?.close()
  }
}

/** Formate un prix avec le bon nombre de décimales. */
export function fmt(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  return value.toLocaleString('fr-FR', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtDate(ts: number, withTime = true): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  const day = `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`
  return withTime ? `${day} ${p(d.getHours())}:${p(d.getMinutes())}` : day
}
