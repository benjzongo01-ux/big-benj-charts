// Compléments : indicateurs et outils de dessin absents de la bibliothèque graphique.
import {
  registerIndicator, registerOverlay,
  type Bounding, type Coordinate, type IndicatorTemplate, type KLineData, type OverlayFigure, type OverlayTemplate,
} from 'klinecharts'

const BLUE = '#2962ff'
const GREEN = '#26a69a'
const RED = '#ef5350'
const ORANGE = '#f7931a'
const PURPLE = '#9c27b0'
const GREY = '#787b86'
const rgba = (color: string, alpha: number): string => {
  const n = parseInt(color.slice(1), 16)
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
}

// =====================================================================================
// Indicateurs
// =====================================================================================
type Row = Record<string, number | undefined>
type Calc = (d: KLineData[], params: number[]) => Row[]

const sma = (v: number[], n: number): (number | undefined)[] => {
  const out: (number | undefined)[] = new Array(v.length)
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    sum += v[i]
    if (i >= n) sum -= v[i - n]
    out[i] = i >= n - 1 ? sum / n : undefined
  }
  return out
}
const ema = (v: (number | undefined)[], n: number): (number | undefined)[] => {
  const out: (number | undefined)[] = new Array(v.length)
  const k = 2 / (n + 1)
  let prev: number | undefined
  let count = 0
  let sum = 0
  for (let i = 0; i < v.length; i++) {
    const x = v[i]
    if (x === undefined) continue
    if (prev === undefined) {
      sum += x
      if (++count === n) prev = sum / n
    } else prev = x * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}
/** Moyenne de Wilder (RSI, ATR). */
const rma = (v: number[], n: number): (number | undefined)[] => {
  const out: (number | undefined)[] = new Array(v.length)
  let prev = 0
  for (let i = 0; i < v.length; i++) {
    if (i < n) {
      prev += v[i] / n
      if (i === n - 1) out[i] = prev
    } else {
      prev = (prev * (n - 1) + v[i]) / n
      out[i] = prev
    }
  }
  return out
}
const wma = (v: (number | undefined)[], n: number): (number | undefined)[] => {
  const out: (number | undefined)[] = new Array(v.length)
  const den = (n * (n + 1)) / 2
  for (let i = n - 1; i < v.length; i++) {
    let s = 0
    let ok = true
    for (let j = 0; j < n; j++) {
      const x = v[i - j]
      if (x === undefined) { ok = false; break }
      s += x * (n - j)
    }
    if (ok) out[i] = s / den
  }
  return out
}
const highest = (v: number[], n: number, i: number): number => {
  let m = -Infinity
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (v[j] > m) m = v[j]
  return m
}
const lowest = (v: number[], n: number, i: number): number => {
  let m = Infinity
  for (let j = Math.max(0, i - n + 1); j <= i; j++) if (v[j] < m) m = v[j]
  return m
}
const trueRange = (d: KLineData[]): number[] =>
  d.map((k, i) => (i === 0 ? k.high - k.low : Math.max(k.high - k.low, Math.abs(k.high - d[i - 1].close), Math.abs(k.low - d[i - 1].close))))
const rsiOf = (close: number[], n: number): (number | undefined)[] => {
  const up = close.map((c, i) => (i ? Math.max(c - close[i - 1], 0) : 0))
  const dn = close.map((c, i) => (i ? Math.max(close[i - 1] - c, 0) : 0))
  const a = rma(up, n)
  const b = rma(dn, n)
  return close.map((_, i) => (a[i] === undefined || b[i] === undefined ? undefined : b[i] === 0 ? 100 : 100 - 100 / (1 + a[i]! / b[i]!)))
}
const col = (d: KLineData[], key: 'open' | 'high' | 'low' | 'close'): number[] => d.map((k) => k[key])
const vol = (d: KLineData[]): number[] => d.map((k) => k.volume ?? 0)

interface Def {
  id: string
  label: string
  main: boolean
  params: number[]
  lines: [string, string, string?][] // clé, titre, couleur
  calc: Calc
  bars?: string // clé dessinée en histogramme
}

const DEFS: Def[] = [
  {
    id: 'ATR', label: 'ATR (volatilité moyenne)', main: false, params: [14], lines: [['atr', 'ATR : ']],
    calc: (d, [n]) => rma(trueRange(d), n).map((atr) => ({ atr })),
  },
  {
    id: 'SUPERTREND', label: 'Supertrend', main: true, params: [10, 3], lines: [['up', 'Hausse : ', GREEN], ['down', 'Baisse : ', RED]],
    calc: (d, [n, mult]) => {
      const atr = rma(trueRange(d), n)
      const out: Row[] = []
      let upper = 0
      let lower = 0
      let dir = 1
      for (let i = 0; i < d.length; i++) {
        const a = atr[i]
        if (a === undefined) { out.push({}); continue }
        const mid = (d[i].high + d[i].low) / 2
        const bu = mid + mult * a
        const bl = mid - mult * a
        const prevClose = i ? d[i - 1].close : d[i].close
        upper = upper === 0 || bu < upper || prevClose > upper ? bu : upper
        lower = lower === 0 || bl > lower || prevClose < lower ? bl : lower
        if (dir === 1 && d[i].close < lower) dir = -1
        else if (dir === -1 && d[i].close > upper) dir = 1
        out.push(dir === 1 ? { up: lower } : { down: upper })
      }
      return out
    },
  },
  {
    id: 'ICHIMOKU', label: 'Ichimoku', main: true, params: [9, 26, 52],
    lines: [['tenkan', 'Tenkan : ', BLUE], ['kijun', 'Kijun : ', RED], ['spanA', 'Senkou A : ', GREEN], ['spanB', 'Senkou B : ', ORANGE], ['chikou', 'Chikou : ', PURPLE]],
    calc: (d, [a, b, c]) => {
      const h = col(d, 'high')
      const l = col(d, 'low')
      const mid = (n: number, i: number): number | undefined => (i >= n - 1 ? (highest(h, n, i) + lowest(l, n, i)) / 2 : undefined)
      return d.map((_, i) => {
        const j = i - b // le nuage est projeté de `b` bougies vers l'avant
        const t = j >= 0 ? mid(a, j) : undefined
        const k = j >= 0 ? mid(b, j) : undefined
        return {
          tenkan: mid(a, i), kijun: mid(b, i),
          spanA: t !== undefined && k !== undefined ? (t + k) / 2 : undefined,
          spanB: j >= 0 ? mid(c, j) : undefined,
          chikou: i + b < d.length ? d[i + b].close : undefined,
        }
      })
    },
  },
  {
    id: 'VWAP', label: 'VWAP (remis à zéro chaque jour)', main: true, params: [], lines: [['vwap', 'VWAP : ', ORANGE]],
    calc: (d) => {
      let pv = 0
      let v = 0
      let day = -1
      return d.map((k) => {
        const cur = Math.floor(k.timestamp / 86_400_000)
        if (cur !== day) { day = cur; pv = 0; v = 0 }
        const volume = k.volume ?? 0
        pv += ((k.high + k.low + k.close) / 3) * volume
        v += volume
        return { vwap: v > 0 ? pv / v : undefined }
      })
    },
  },
  {
    id: 'PIVOTS', label: 'Points pivots journaliers', main: true, params: [],
    lines: [['p', 'P : ', ORANGE], ['r1', 'R1 : ', RED], ['s1', 'S1 : ', GREEN], ['r2', 'R2 : ', RED], ['s2', 'S2 : ', GREEN]],
    calc: (d) => {
      let day = -1
      let h = -Infinity
      let l = Infinity
      let c = 0
      let lv: Row = {}
      return d.map((k) => {
        const cur = Math.floor(k.timestamp / 86_400_000)
        if (cur !== day) {
          if (day !== -1) {
            const p = (h + l + c) / 3
            lv = { p, r1: 2 * p - l, s1: 2 * p - h, r2: p + (h - l), s2: p - (h - l) }
          }
          day = cur; h = -Infinity; l = Infinity
        }
        h = Math.max(h, k.high); l = Math.min(l, k.low); c = k.close
        return lv
      })
    },
  },
  {
    id: 'DONCHIAN', label: 'Canal de Donchian', main: true, params: [20], lines: [['up', 'Haut : ', BLUE], ['mid', 'Milieu : ', GREY], ['dn', 'Bas : ', BLUE]],
    calc: (d, [n]) => {
      const h = col(d, 'high')
      const l = col(d, 'low')
      return d.map((_, i) => {
        if (i < n - 1) return {}
        const up = highest(h, n, i)
        const dn = lowest(l, n, i)
        return { up, mid: (up + dn) / 2, dn }
      })
    },
  },
  {
    id: 'KELTNER', label: 'Canal de Keltner', main: true, params: [20, 2], lines: [['up', 'Haut : ', PURPLE], ['mid', 'Milieu : ', GREY], ['dn', 'Bas : ', PURPLE]],
    calc: (d, [n, mult]) => {
      const mid = ema(col(d, 'close'), n)
      const atr = rma(trueRange(d), n)
      return d.map((_, i) => (mid[i] === undefined || atr[i] === undefined ? {} : { up: mid[i]! + mult * atr[i]!, mid: mid[i], dn: mid[i]! - mult * atr[i]! }))
    },
  },
  {
    id: 'ENVELOPE', label: 'Enveloppes de moyenne mobile', main: true, params: [20, 2.5], lines: [['up', 'Haut : ', GREEN], ['mid', 'Milieu : ', GREY], ['dn', 'Bas : ', RED]],
    calc: (d, [n, pct]) => sma(col(d, 'close'), n).map((m) => (m === undefined ? {} : { up: m * (1 + pct / 100), mid: m, dn: m * (1 - pct / 100) })),
  },
  {
    id: 'WMA', label: 'Moyenne pondérée (WMA)', main: true, params: [20], lines: [['wma', 'WMA : ', BLUE]],
    calc: (d, [n]) => wma(col(d, 'close'), n).map((x) => ({ wma: x })),
  },
  {
    id: 'HMA', label: 'Moyenne de Hull (HMA)', main: true, params: [21], lines: [['hma', 'HMA : ', PURPLE]],
    calc: (d, [n]) => {
      const c = col(d, 'close')
      const half = wma(c, Math.max(1, Math.floor(n / 2)))
      const full = wma(c, n)
      const diff = c.map((_, i) => (half[i] === undefined || full[i] === undefined ? undefined : 2 * half[i]! - full[i]!))
      return wma(diff, Math.max(1, Math.round(Math.sqrt(n)))).map((x) => ({ hma: x }))
    },
  },
  {
    id: 'STOCH', label: 'Stochastique (%K, %D)', main: false, params: [14, 3, 3], lines: [['k', '%K : ', BLUE], ['d', '%D : ', ORANGE]],
    calc: (d, [n, sk, sd]) => {
      const h = col(d, 'high')
      const l = col(d, 'low')
      const raw = d.map((x, i) => {
        const hi = highest(h, n, i)
        const lo = lowest(l, n, i)
        return hi === lo ? 50 : ((x.close - lo) / (hi - lo)) * 100
      })
      const k = sma(raw, sk)
      const dd = sma(k.map((x) => x ?? 50), sd)
      return d.map((_, i) => (i < n + sk - 2 ? {} : { k: k[i], d: i < n + sk + sd - 3 ? undefined : dd[i] }))
    },
  },
  {
    id: 'STOCHRSI', label: 'RSI stochastique', main: false, params: [14, 14, 3, 3], lines: [['k', '%K : ', BLUE], ['d', '%D : ', ORANGE]],
    calc: (d, [rn, sn, sk, sd]) => {
      const r = rsiOf(col(d, 'close'), rn)
      const filled = r.map((x) => x ?? 50)
      const raw = filled.map((x, i) => {
        const hi = highest(filled, sn, i)
        const lo = lowest(filled, sn, i)
        return hi === lo ? 50 : ((x - lo) / (hi - lo)) * 100
      })
      const k = sma(raw, sk)
      const dd = sma(k.map((x) => x ?? 50), sd)
      const start = rn + sn + sk
      return d.map((_, i) => (i < start ? {} : { k: k[i], d: i < start + sd ? undefined : dd[i] }))
    },
  },
  {
    id: 'MFI', label: 'Money Flow Index', main: false, params: [14], lines: [['mfi', 'MFI : ', PURPLE]],
    calc: (d, [n]) => {
      const tp = d.map((k) => (k.high + k.low + k.close) / 3)
      const v = vol(d)
      return d.map((_, i) => {
        if (i < n) return {}
        let pos = 0
        let neg = 0
        for (let j = i - n + 1; j <= i; j++) {
          if (tp[j] > tp[j - 1]) pos += tp[j] * v[j]
          else if (tp[j] < tp[j - 1]) neg += tp[j] * v[j]
        }
        return { mfi: neg === 0 ? 100 : 100 - 100 / (1 + pos / neg) }
      })
    },
  },
  {
    id: 'CMF', label: 'Chaikin Money Flow', main: false, params: [20], lines: [['cmf', 'CMF : ', GREEN]],
    calc: (d, [n]) => {
      const v = vol(d)
      const mfv = d.map((k, i) => (k.high === k.low ? 0 : (((k.close - k.low) - (k.high - k.close)) / (k.high - k.low)) * v[i]))
      const a = sma(mfv, n)
      const b = sma(v, n)
      return d.map((_, i) => ({ cmf: a[i] === undefined || !b[i] ? undefined : a[i]! / b[i]! }))
    },
  },
  {
    id: 'AROON', label: 'Aroon', main: false, params: [25], lines: [['up', 'Haut : ', GREEN], ['down', 'Bas : ', RED]],
    calc: (d, [n]) => d.map((_, i) => {
      if (i < n) return {}
      let hi = i - n
      let lo = i - n
      for (let j = i - n; j <= i; j++) {
        if (d[j].high >= d[hi].high) hi = j
        if (d[j].low <= d[lo].low) lo = j
      }
      return { up: ((n - (i - hi)) / n) * 100, down: ((n - (i - lo)) / n) * 100 }
    }),
  },
  {
    id: 'STDDEV', label: 'Écart-type', main: false, params: [20], lines: [['sd', 'Écart-type : ', BLUE]],
    calc: (d, [n]) => {
      const c = col(d, 'close')
      const m = sma(c, n)
      return d.map((_, i) => {
        if (m[i] === undefined) return {}
        let s = 0
        for (let j = i - n + 1; j <= i; j++) s += (c[j] - m[i]!) ** 2
        return { sd: Math.sqrt(s / n) }
      })
    },
  },
  {
    id: 'CHOP', label: 'Choppiness Index (marché en range)', main: false, params: [14], lines: [['chop', 'CHOP : ', ORANGE]],
    calc: (d, [n]) => {
      const tr = trueRange(d)
      const h = col(d, 'high')
      const l = col(d, 'low')
      return d.map((_, i) => {
        if (i < n) return {}
        let sum = 0
        for (let j = i - n + 1; j <= i; j++) sum += tr[j]
        const range = highest(h, n, i) - lowest(l, n, i)
        return { chop: range > 0 ? (100 * Math.log10(sum / range)) / Math.log10(n) : undefined }
      })
    },
  },
  {
    id: 'FORCE', label: 'Force Index', main: false, params: [13], lines: [['fi', 'Force : ', BLUE]],
    calc: (d, [n]) => ema(d.map((k, i) => (i ? (k.close - d[i - 1].close) * (k.volume ?? 0) : undefined)), n).map((x) => ({ fi: x })),
  },
]

export const EXTRA_INDICATORS = DEFS.map(({ id, label, main }) => ({ id, label, main }))

export function registerExtraIndicators(): void {
  DEFS.forEach((def) => {
    const template: IndicatorTemplate<Row> = {
      name: def.id,
      shortName: def.id,
      calcParams: def.params,
      precision: def.main ? undefined : 2,
      series: (def.main ? 'price' : 'normal') as IndicatorTemplate['series'],
      figures: def.lines.map(([key, title, color]) => ({
        key, title, type: 'line',
        ...(color ? { styles: () => ({ color }) } : {}),
      })),
      calc: (dataList, indicator) => def.calc(dataList, indicator.calcParams as number[]),
    }
    if (template.precision === undefined) delete template.precision
    registerIndicator(template)
  })
}

// =====================================================================================
// Outils de dessin
// =====================================================================================
const base = { needDefaultPointFigure: true, needDefaultXAxisFigure: true, needDefaultYAxisFigure: true }
const tag = (x: number, y: number, text: string, bg = BLUE, align: CanvasTextAlign = 'center'): OverlayFigure => ({
  type: 'text', ignoreEvent: true,
  attrs: { x, y, text, align, baseline: 'middle' },
  styles: { color: '#ffffff', backgroundColor: bg, size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 3 },
})
const seg = (a: Coordinate, b: Coordinate, color = BLUE, dashed = false): OverlayFigure => ({
  type: 'line', attrs: { coordinates: [a, b] }, styles: { color, style: dashed ? 'dashed' : 'solid' },
})
/** Prolonge la demi-droite a -> b jusqu'au bord du graphique. */
const ray = (a: Coordinate, b: Coordinate, box: Bounding): Coordinate => {
  if (b.x === a.x) return { x: a.x, y: b.y > a.y ? box.height : 0 }
  const x = b.x > a.x ? box.width : 0
  return { x, y: a.y + ((b.y - a.y) / (b.x - a.x)) * (x - a.x) }
}
const area = (points: Coordinate[], color: string, alpha = 0.12): OverlayFigure => ({
  type: 'polygon', ignoreEvent: true, attrs: { coordinates: points }, styles: { style: 'fill', color: rgba(color, alpha) },
})

/** Figure faite de points reliés et étiquetés (vagues d'Elliott, figures harmoniques…). */
const labelled = (name: string, labels: string[], fills: number[][] = []): OverlayTemplate => ({
  name, totalStep: labels.length + 1, ...base,
  createPointFigures: ({ coordinates: c }) => [
    ...fills.filter((f) => f.every((i) => i < c.length)).map((f) => area(f.map((i) => c[i]), BLUE)),
    { type: 'line', attrs: { coordinates: c } },
    ...c.map((p, i) => tag(p.x, p.y + (i > 0 && p.y > c[i - 1].y ? 14 : -14), labels[i])),
  ],
})

const FIB_EXT = [0, 0.618, 1, 1.272, 1.618, 2, 2.618]
const FIB_FAN = [0.236, 0.382, 0.5, 0.618, 0.786]
const FIB_TIME = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
const GANN: [string, number][] = [['1×8', 1 / 8], ['1×4', 1 / 4], ['1×3', 1 / 3], ['1×2', 1 / 2], ['1×1', 1], ['2×1', 2], ['3×1', 3], ['4×1', 4], ['8×1', 8]]
const GRID = [0.25, 0.382, 0.5, 0.618, 0.75]

const TEMPLATES: OverlayTemplate[] = [
  {
    // Extension de Fibonacci : 3 clics (départ, fin de l'impulsion, fin de la correction).
    name: 'fibExtension', totalStep: 4, ...base,
    createPointFigures: ({ coordinates: c, overlay, precision, bounding }) => {
      if (c.length < 2) return []
      const figures: OverlayFigure[] = [seg(c[0], c[1], GREY, true)]
      if (c.length < 3) return figures
      figures.push(seg(c[1], c[2], GREY, true))
      const p = overlay.points
      const dy = c[1].y - c[0].y
      const dv = (p[1].value ?? 0) - (p[0].value ?? 0)
      FIB_EXT.forEach((lv) => {
        const y = c[2].y + dy * lv
        figures.push(seg({ x: c[2].x, y }, { x: bounding.width, y }),
          tag(c[2].x, y, `${lv} (${((p[2].value ?? 0) + dv * lv).toFixed(precision.price)})`, BLUE, 'right'))
      })
      return figures
    },
  },
  {
    name: 'fibTimeZones', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, bounding }) => {
      if (c.length < 2) return []
      const dx = c[1].x - c[0].x
      return FIB_TIME.flatMap((n) => {
        const x = c[0].x + dx * n
        return x < 0 || x > bounding.width ? [] : [seg({ x, y: 0 }, { x, y: bounding.height }), tag(x, bounding.height - 12, String(n))]
      })
    },
  },
  {
    name: 'fibFan', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, bounding }) => {
      if (c.length < 2) return []
      const figures: OverlayFigure[] = [seg(c[0], ray(c[0], c[1], bounding), GREY, true)]
      FIB_FAN.forEach((lv) => {
        const through = { x: c[1].x, y: c[0].y + (c[1].y - c[0].y) * lv }
        figures.push(seg(c[0], ray(c[0], through, bounding)), tag(through.x, through.y, String(lv)))
      })
      return figures
    },
  },
  {
    name: 'gannFan', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, bounding }) => {
      if (c.length < 2) return []
      return GANN.flatMap(([name, ratio]) => {
        const through = { x: c[1].x, y: c[0].y + (c[1].y - c[0].y) * ratio }
        return [seg(c[0], ray(c[0], through, bounding), ratio === 1 ? ORANGE : BLUE),
          tag(c[0].x + (through.x - c[0].x) * 0.6, c[0].y + (through.y - c[0].y) * 0.6, name, ratio === 1 ? ORANGE : BLUE)]
      })
    },
  },
  {
    name: 'gannBox', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c }) => {
      if (c.length < 2) return []
      const [a, b] = c
      const figures: OverlayFigure[] = [
        { type: 'polygon', attrs: { coordinates: [a, { x: b.x, y: a.y }, b, { x: a.x, y: b.y }] }, styles: { style: 'stroke_fill', color: rgba(BLUE, 0.06), borderColor: BLUE } },
        seg(a, b, ORANGE), seg({ x: a.x, y: b.y }, { x: b.x, y: a.y }, ORANGE),
      ]
      GRID.forEach((g) => {
        const x = a.x + (b.x - a.x) * g
        const y = a.y + (b.y - a.y) * g
        figures.push(seg({ x, y: a.y }, { x, y: b.y }, GREY, true), seg({ x: a.x, y }, { x: b.x, y }, GREY, true), tag(a.x, y, String(g), GREY, 'right'))
      })
      return figures
    },
  },
  {
    // Fourchette d'Andrews : pivot, puis les deux points de réaction.
    name: 'pitchfork', totalStep: 4, ...base,
    createPointFigures: ({ coordinates: c, bounding }) => {
      if (c.length < 2) return []
      if (c.length < 3) return [seg(c[0], c[1], GREY, true)]
      const mid = { x: (c[1].x + c[2].x) / 2, y: (c[1].y + c[2].y) / 2 }
      const dir = { x: mid.x - c[0].x, y: mid.y - c[0].y }
      const far = (p: Coordinate): Coordinate => ray(p, { x: p.x + dir.x, y: p.y + dir.y }, bounding)
      return [
        area([c[1], far(c[1]), far(c[2]), c[2]], BLUE, 0.07),
        seg(c[1], c[2], GREY, true), seg(c[0], far(c[0]), ORANGE), seg(c[1], far(c[1])), seg(c[2], far(c[2])),
      ]
    },
  },
  labelled('elliottImpulse', ['0', '1', '2', '3', '4', '5']),
  labelled('elliottCorrection', ['0', 'A', 'B', 'C']),
  labelled('elliottTriangle', ['0', 'A', 'B', 'C', 'D', 'E']),
  labelled('xabcd', ['X', 'A', 'B', 'C', 'D'], [[0, 1, 2], [2, 3, 4]]),
  labelled('abcd', ['A', 'B', 'C', 'D']),
  labelled('headShoulders', ['Départ', 'Épaule G', 'Creux', 'Tête', 'Creux', 'Épaule D', 'Fin']),
  labelled('threeDrives', ['Départ', '1', 'A', '2', 'B', '3']),
  labelled('polyline', ['', '', '', '', '', '']),
  {
    name: 'crossLine', totalStep: 2, ...base,
    createPointFigures: ({ coordinates: c, bounding }) => c.length < 1 ? [] : [
      seg({ x: 0, y: c[0].y }, { x: bounding.width, y: c[0].y }), seg({ x: c[0].x, y: 0 }, { x: c[0].x, y: bounding.height }),
    ],
  },
  {
    name: 'ellipse', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c }) => {
      if (c.length < 2) return []
      const cx = (c[0].x + c[1].x) / 2
      const cy = (c[0].y + c[1].y) / 2
      const rx = Math.abs(c[1].x - c[0].x) / 2
      const ry = Math.abs(c[1].y - c[0].y) / 2
      const pts: Coordinate[] = []
      for (let i = 0; i < 64; i++) pts.push({ x: cx + rx * Math.cos((i / 64) * 2 * Math.PI), y: cy + ry * Math.sin((i / 64) * 2 * Math.PI) })
      return [{ type: 'polygon', attrs: { coordinates: pts }, styles: { style: 'stroke_fill', color: rgba(BLUE, 0.15), borderColor: BLUE } }]
    },
  },
  {
    name: 'priceRange', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, overlay, precision, bounding }) => {
      if (c.length < 2) return []
      const a = overlay.points[0].value ?? 0
      const b = overlay.points[1].value ?? 0
      const color = b >= a ? GREEN : RED
      return [
        area([{ x: 0, y: c[0].y }, { x: bounding.width, y: c[0].y }, { x: bounding.width, y: c[1].y }, { x: 0, y: c[1].y }], color),
        seg({ x: 0, y: c[0].y }, { x: bounding.width, y: c[0].y }, color), seg({ x: 0, y: c[1].y }, { x: bounding.width, y: c[1].y }, color),
        tag((c[0].x + c[1].x) / 2, (c[0].y + c[1].y) / 2, `${(b - a).toFixed(precision.price)} (${a ? (((b - a) / a) * 100).toFixed(2) : '0'} %)`, color),
      ]
    },
  },
  {
    name: 'dateRange', totalStep: 3, ...base,
    createPointFigures: ({ coordinates: c, overlay, bounding }) => {
      if (c.length < 2) return []
      const p = overlay.points
      const bars = Math.abs((p[1].dataIndex ?? 0) - (p[0].dataIndex ?? 0))
      const ms = Math.abs((p[1].timestamp ?? 0) - (p[0].timestamp ?? 0))
      const span = ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(1)} j` : `${(ms / 3_600_000).toFixed(1)} h`
      return [
        area([{ x: c[0].x, y: 0 }, { x: c[1].x, y: 0 }, { x: c[1].x, y: bounding.height }, { x: c[0].x, y: bounding.height }], BLUE),
        seg({ x: c[0].x, y: 0 }, { x: c[0].x, y: bounding.height }), seg({ x: c[1].x, y: 0 }, { x: c[1].x, y: bounding.height }),
        tag((c[0].x + c[1].x) / 2, c[1].y, `${bars} bougies · ${span}`),
      ]
    },
  },
  ...([['arrowUp', GREEN, 1], ['arrowDown', RED, -1]] as [string, string, number][]).map(([name, color, s]): OverlayTemplate => ({
    name, totalStep: 2, needDefaultPointFigure: false, needDefaultXAxisFigure: false, needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates: c }) => c.length < 1 ? [] : [{
      type: 'polygon', styles: { style: 'fill', color },
      attrs: { coordinates: [c[0], { x: c[0].x - 8, y: c[0].y + 12 * s }, { x: c[0].x - 3, y: c[0].y + 12 * s }, { x: c[0].x - 3, y: c[0].y + 24 * s },
        { x: c[0].x + 3, y: c[0].y + 24 * s }, { x: c[0].x + 3, y: c[0].y + 12 * s }, { x: c[0].x + 8, y: c[0].y + 12 * s }] },
    }],
  })),
]

export function registerExtraTools(): void {
  TEMPLATES.forEach(registerOverlay)
}

interface ExtraTool { id: string; label: string; icon: string }
/** Outils ajoutés, rangés par catégorie de la barre de gauche. */
export const EXTRA_TOOLS: Record<string, ExtraTool[]> = {
  Lignes: [
    { id: 'crossLine', label: 'Ligne croisée', icon: '┼' },
    { id: 'polyline', label: 'Polyligne (6 points)', icon: '⌇' },
  ],
  Canaux: [{ id: 'pitchfork', label: 'Fourchette d’Andrews (3 clics)', icon: '⑂' }],
  Fibonacci: [
    { id: 'fibExtension', label: 'Extension de Fibonacci (3 clics)', icon: '𝑬' },
    { id: 'fibFan', label: 'Éventail de Fibonacci', icon: '⩘' },
    { id: 'fibTimeZones', label: 'Zones temporelles de Fibonacci', icon: '⫼' },
    { id: 'gannFan', label: 'Éventail de Gann', icon: '⟁' },
    { id: 'gannBox', label: 'Boîte de Gann', icon: '▦' },
  ],
  Formes: [{ id: 'ellipse', label: 'Ellipse', icon: '⬭' }],
  Annotations: [
    { id: 'arrowUp', label: 'Flèche haut', icon: '⬆' },
    { id: 'arrowDown', label: 'Flèche bas', icon: '⬇' },
  ],
  'Positions et mesure': [
    { id: 'priceRange', label: 'Plage de prix', icon: '↕' },
    { id: 'dateRange', label: 'Plage de dates', icon: '↔' },
  ],
  'Figures chartistes': [
    { id: 'xabcd', label: 'Figure XABCD (harmonique)', icon: '𝑿' },
    { id: 'abcd', label: 'Figure ABCD', icon: '𝑨' },
    { id: 'headShoulders', label: 'Tête et épaules', icon: '⩚' },
    { id: 'threeDrives', label: 'Three Drives', icon: '③' },
    { id: 'elliottImpulse', label: 'Vagues d’Elliott : impulsion (12345)', icon: '⑤' },
    { id: 'elliottCorrection', label: 'Vagues d’Elliott : correction (ABC)', icon: 'ⓒ' },
    { id: 'elliottTriangle', label: 'Vagues d’Elliott : triangle (ABCDE)', icon: 'ⓔ' },
  ],
}
