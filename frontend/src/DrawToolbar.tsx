// Barre d'options du dessin sélectionné et fenêtre de réglages, sur le modèle de TradingView :
// ⋮⋮ | couleur | couleur du texte | épaisseur | style de trait | réglages | alerte | verrou | supprimer | plus.
import { useEffect, useRef, useState } from 'react'
import { fmtDate, TF_LABEL, TIMEFRAMES } from './api'
import { Icon } from './icons'
import { INLINE_TEXT_TOOLS, LINE_TOOLS, POSITION_TOOLS, rgba, type Dash, type DrawProps } from './tvtools'

export interface DrawPoint { timestamp?: number; value?: number }

interface Props {
  name: string
  label: string
  props: DrawProps
  points: DrawPoint[]
  text: string
  precision: number
  onChange: (patch: Partial<DrawProps>) => void
  onPoints: (points: DrawPoint[]) => void
  onText: (text: string) => void
  onAlert: () => void
  onDelete: () => void
  onClone: () => void
  onCopy: () => void
  onOrder: (where: 'front' | 'back') => void
}

// Palette : une ligne de gris, une ligne de couleurs vives, puis six nuances de chaque couleur.
const GRAYS = ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000']
const HUES = ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63']
const mix = (hex: string, toward: number, t: number): string => {
  const n = parseInt(hex.slice(1), 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (toward - v) * t))
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`
}
const PALETTE = [GRAYS, HUES, ...[0.8, 0.6, 0.4].map((t) => HUES.map((h) => mix(h, 255, t))), ...[0.25, 0.45, 0.6].map((t) => HUES.map((h) => mix(h, 0, t)))]

function ColorPicker({ color, opacity, onPick, onOpacity }: { color: string; opacity?: number; onPick: (c: string) => void; onOpacity?: (o: number) => void }): JSX.Element {
  const [custom, setCustom] = useState(color)
  return (
    <div className="pop palette" onMouseDown={(e) => e.stopPropagation()}>
      {PALETTE.map((row, i) => (
        <div key={i} className={`pal-row${i === 2 ? ' gap' : ''}`}>
          {row.map((c) => <button key={c} className={`sw${c.toLowerCase() === color.toLowerCase() ? ' on' : ''}`} style={{ background: c }} onClick={() => onPick(c)} title={c} />)}
        </div>
      ))}
      <div className="pal-custom">
        <input type="color" value={custom} onChange={(e) => { setCustom(e.target.value); onPick(e.target.value) }} title="Couleur personnalisée" />
        <span>Couleur personnalisée</span>
      </div>
      {onOpacity && (
        <div className="pal-opacity">
          <span>Opacité</span>
          <input type="range" min={0} max={100} value={Math.round((opacity ?? 1) * 100)} onChange={(e) => onOpacity(Number(e.target.value) / 100)}
            style={{ background: `linear-gradient(90deg, transparent, ${color})` }} />
          <b>{Math.round((opacity ?? 1) * 100)}%</b>
        </div>
      )}
    </div>
  )
}

const DASHES: [Dash, string][] = [['solid', 'Droite'], ['dashed', 'Ligne traitillée'], ['dotted', 'Ligne pointillée']]
const dashCss = (d?: Dash): 'dashed' | 'dotted' | 'solid' => (d === 'dashed' ? 'dashed' : d === 'dotted' ? 'dotted' : 'solid')

export default function DrawToolbar(p: Props): JSX.Element {
  const [menu, setMenu] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => setMenu(null), [p.name])
  const position = POSITION_TOOLS.has(p.name)
  const hasText = INLINE_TEXT_TOOLS.has(p.name) || (LINE_TOOLS.has(p.name) && !!p.props.text)
  const toggle = (m: string): void => setMenu(menu === m ? null : m)

  return (
    <>
      <div ref={bar} className="draw-bar" style={pos ? { left: pos.x, top: pos.y, right: 'auto' } : undefined}
        onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.stopPropagation()}>
        <span className="db-grip" title="Déplacer la barre"
          onPointerDown={(e) => {
            const r = bar.current!.getBoundingClientRect()
            const parent = bar.current!.offsetParent!.getBoundingClientRect()
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { dx: e.clientX - (r.left - parent.left), dy: e.clientY - (r.top - parent.top) }
          }}
          onPointerMove={(e) => { if (drag.current) setPos({ x: Math.max(0, e.clientX - drag.current.dx), y: Math.max(0, e.clientY - drag.current.dy) }) }}
          onPointerUp={() => { drag.current = null }}><Icon name="grip" size={14} /></span>

        {position ? (
          <>
            <div className="db-item">
              <button className="icon" title="Couleur de la cible" onClick={() => toggle('target')}>
                <span className="db-color"><Icon name="pencil" size={15} /><i style={{ background: p.props.targetColor ?? '#26a69a' }} /></span>
              </button>
              {menu === 'target' && <ColorPicker color={p.props.targetColor ?? '#26a69a'} onPick={(c) => p.onChange({ targetColor: c })} />}
            </div>
            <div className="db-item">
              <button className="icon" title="Couleur du stop" onClick={() => toggle('stop')}>
                <span className="db-color"><Icon name="pencil" size={15} /><i style={{ background: p.props.stopColor ?? '#ef5350' }} /></span>
              </button>
              {menu === 'stop' && <ColorPicker color={p.props.stopColor ?? '#ef5350'} onPick={(c) => p.onChange({ stopColor: c })} />}
            </div>
          </>
        ) : (
          <>
            {!INLINE_TEXT_TOOLS.has(p.name) && (
              <div className="db-item">
                <button className="icon" title="Couleur" onClick={() => toggle('color')}>
                  <span className="db-color"><Icon name="pencil" size={15} /><i style={{ background: rgba(p.props.color, p.props.opacity) }} /></span>
                </button>
                {menu === 'color' && <ColorPicker color={p.props.color} opacity={p.props.opacity} onPick={(c) => p.onChange({ color: c })} onOpacity={(o) => p.onChange({ opacity: o })} />}
              </div>
            )}
            {hasText && (
              <div className="db-item">
                <button className="icon" title="Couleur du texte" onClick={() => toggle('text')}>
                  <span className="db-color"><span className="db-t">T</span><i style={{ background: p.props.textColor ?? p.props.color }} /></span>
                </button>
                {menu === 'text' && <ColorPicker color={p.props.textColor ?? p.props.color} onPick={(c) => p.onChange({ textColor: c })} />}
              </div>
            )}
            {INLINE_TEXT_TOOLS.has(p.name) ? (
              <div className="db-item">
                <button className="db-wide" title="Taille du texte" onClick={() => toggle('font')}>{p.props.fontSize ?? 14}</button>
                {menu === 'font' && (
                  <div className="pop list">
                    {[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map((n) => (
                      <button key={n} className={(p.props.fontSize ?? 14) === n ? 'on' : ''} onClick={() => { p.onChange({ fontSize: n }); setMenu(null) }}>{n}</button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="db-item">
                  <button className="db-wide" title="Épaisseur" onClick={() => toggle('size')}>
                    <span className="db-stroke" style={{ height: Math.min(4, p.props.size) }} />{p.props.size}px
                  </button>
                  {menu === 'size' && (
                    <div className="pop list">
                      {[1, 2, 3, 4].map((n) => (
                        <button key={n} className={p.props.size === n ? 'on' : ''} onClick={() => { p.onChange({ size: n }); setMenu(null) }}>
                          <span className="db-stroke" style={{ height: n }} />{n}px
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="db-item">
                  <button className="icon" title="Style du trait" onClick={() => toggle('dash')}>
                    <span className="db-dash" style={{ borderTopStyle: dashCss(p.props.dash) }} />
                  </button>
                  {menu === 'dash' && (
                    <div className="pop list">
                      {DASHES.map(([d, label]) => (
                        <button key={d} className={(p.props.dash ?? 'solid') === d ? 'on' : ''} onClick={() => { p.onChange({ dash: d }); setMenu(null) }}>
                          <span className="db-dash" style={{ borderTopStyle: dashCss(d) }} />{label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </>
        )}

        <button className="icon" title="Paramètres" onClick={() => { setMenu(null); setSettings(true) }}><Icon name="gear" size={16} /></button>
        <button className="icon" title="Ajouter une alerte au prix de ce dessin" onClick={p.onAlert}><Icon name="alarm" size={16} /></button>
        <button className={`icon${p.props.lock ? ' on' : ''}`} title={p.props.lock ? 'Déverrouiller' : 'Verrouiller'} onClick={() => p.onChange({ lock: !p.props.lock })}>
          <Icon name={p.props.lock ? 'lock' : 'unlock'} size={16} />
        </button>
        <button className="icon danger" title="Supprimer (Suppr)" onClick={p.onDelete}><Icon name="trash" size={16} /></button>
        <div className="db-item">
          <button className="icon" title="Plus" onClick={() => toggle('more')}><Icon name="more" size={16} /></button>
          {menu === 'more' && (
            <div className="pop list right">
              <button onClick={() => { p.onOrder('front'); setMenu(null) }}>Mettre au premier plan</button>
              <button onClick={() => { p.onOrder('back'); setMenu(null) }}>Mettre en arrière-plan</button>
              <button onClick={() => { setMenu(null); setSettings(true) }}>Visibilité des intervalles…</button>
              <div className="sep" />
              <button onClick={() => { p.onClone(); setMenu(null) }}>Cloner</button>
              <button onClick={() => { p.onCopy(); setMenu(null) }}>Copier<em>Ctrl + C</em></button>
              <button onClick={() => { p.onChange({ hidden: true }); setMenu(null) }}>Cacher</button>
            </div>
          )}
        </div>
      </div>
      {settings && <DrawSettings {...p} onClose={() => setSettings(false)} />}
    </>
  )
}

// ---------------------------------------------------------------- fenêtre de réglages
function DrawSettings(p: Props & { onClose: () => void }): JSX.Element {
  const position = POSITION_TOOLS.has(p.name)
  const textTool = INLINE_TEXT_TOOLS.has(p.name)
  const tabs = position ? ['Paramètres', 'Style', 'Visibilité'] : textTool ? ['Texte', 'Coordonnées', 'Visibilité']
    : LINE_TOOLS.has(p.name) ? ['Style', 'Texte', 'Coordonnées', 'Visibilité'] : ['Style', 'Coordonnées', 'Visibilité']
  const [tab, setTab] = useState(tabs[0])
  const [draft, setDraft] = useState<DrawProps>({ ...p.props })
  const [text, setText] = useState(textTool ? p.text : p.props.text ?? '')
  const [pts, setPts] = useState(p.points.map((x) => ({ value: x.value !== undefined ? String(x.value) : '', time: x.timestamp })))
  const set = (patch: Partial<DrawProps>): void => setDraft((d) => ({ ...d, ...patch }))
  const num = (v: string): number | undefined => (v.trim() === '' || Number.isNaN(Number(v.replace(',', '.'))) ? undefined : Number(v.replace(',', '.')))

  const ok = (): void => {
    p.onChange(textTool ? draft : { ...draft, text })
    if (textTool) p.onText(text)
    const next = p.points.map((x, i) => ({ ...x, value: num(pts[i]?.value ?? '') ?? x.value }))
    if (next.some((x, i) => x.value !== p.points[i].value)) p.onPoints(next)
    p.onClose()
  }

  const posEntry = p.points[0]?.value ?? 0
  return (
    <div className="modal-back" onMouseDown={p.onClose}>
      <div className="modal settings" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => { if (e.key === 'Escape') p.onClose(); if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement)) ok() }}>
        <div className="modal-head"><b>{p.label}</b><button className="icon" onClick={p.onClose} title="Fermer"><Icon name="close" size={16} /></button></div>
        <div className="tabs">{tabs.map((t) => <button key={t} className={t === tab ? 'on' : ''} onClick={() => setTab(t)}>{t}</button>)}</div>
        <div className="settings-body">
          {tab === 'Style' && !position && (
            <>
              <div className="s-row"><span>Ligne</span>
                <input type="color" value={draft.color} onChange={(e) => set({ color: e.target.value })} />
                <select value={draft.size} onChange={(e) => set({ size: Number(e.target.value) })}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}px</option>)}</select>
                <select value={draft.dash ?? 'solid'} onChange={(e) => set({ dash: e.target.value as Dash })}>{DASHES.map(([d, l]) => <option key={d} value={d}>{l}</option>)}</select>
              </div>
              <div className="s-row"><span>Opacité</span>
                <input type="range" min={0} max={100} value={Math.round(draft.opacity * 100)} onChange={(e) => set({ opacity: Number(e.target.value) / 100 })} /><b>{Math.round(draft.opacity * 100)}%</b>
              </div>
              {LINE_TOOLS.has(p.name) && (
                <>
                  <div className="s-row"><span>Prolonger</span>
                    <select value={`${draft.extendLeft ? 1 : 0}${draft.extendRight ? 1 : 0}`} onChange={(e) => set({ extendLeft: e.target.value[0] === '1', extendRight: e.target.value[1] === '1' })}>
                      <option value="00">Ne pas élargir</option><option value="10">À gauche</option><option value="01">À droite</option><option value="11">Des deux côtés</option>
                    </select>
                  </div>
                  <label className="s-check"><input type="checkbox" checked={!!draft.middle} onChange={(e) => set({ middle: e.target.checked })} />Point médian</label>
                  <label className="s-check"><input type="checkbox" checked={!!draft.priceLabels} onChange={(e) => set({ priceLabels: e.target.checked })} />Étiquettes de prix</label>
                </>
              )}
            </>
          )}
          {tab === 'Style' && position && (
            <>
              <div className="s-row"><span>Couleur de l’objectif</span><input type="color" value={draft.targetColor ?? '#26a69a'} onChange={(e) => set({ targetColor: e.target.value })} /></div>
              <div className="s-row"><span>Couleur du stop</span><input type="color" value={draft.stopColor ?? '#ef5350'} onChange={(e) => set({ stopColor: e.target.value })} /></div>
            </>
          )}
          {tab === 'Paramètres' && (
            <>
              <div className="s-row"><span>Taille du compte</span><input value={draft.account ?? 1000} onChange={(e) => set({ account: num(e.target.value) ?? 0 })} /></div>
              <div className="s-row"><span>Risque</span><input value={draft.risk ?? 25} onChange={(e) => set({ risk: num(e.target.value) ?? 0 })} /><b>%</b></div>
              <div className="s-row"><span>Prix d’entrée</span><input value={pts[0]?.value ?? ''} onChange={(e) => setPts(pts.map((x, i) => (i === 0 || i === 1 ? { ...x, value: e.target.value } : x)))} /></div>
              <div className="s-sub">Niveau de profit</div>
              <div className="s-row"><span>Prix</span><input value={pts[2]?.value ?? ''} onChange={(e) => setPts(pts.map((x, i) => (i === 2 ? { ...x, value: e.target.value } : x)))} />
                <small>{posEntry ? `${(Math.abs((num(pts[2]?.value ?? '') ?? posEntry) - posEntry)).toFixed(p.precision)} d’écart` : ''}</small></div>
              <div className="s-sub">Niveau du stop</div>
              <div className="s-row"><span>Prix</span><input value={pts[3]?.value ?? ''} onChange={(e) => setPts(pts.map((x, i) => (i === 3 ? { ...x, value: e.target.value } : x)))} />
                <small>{posEntry ? `${(Math.abs((num(pts[3]?.value ?? '') ?? posEntry) - posEntry)).toFixed(p.precision)} d’écart` : ''}</small></div>
            </>
          )}
          {tab === 'Texte' && (
            <>
              <div className="s-row">
                <input type="color" value={draft.textColor ?? draft.color} onChange={(e) => set({ textColor: e.target.value })} title="Couleur du texte" />
                <select value={draft.fontSize ?? 14} onChange={(e) => set({ fontSize: Number(e.target.value) })}>{[10, 11, 12, 14, 16, 20, 24, 28, 32, 40].map((n) => <option key={n} value={n}>{n}</option>)}</select>
                <button className={`fmt${draft.bold ? ' on' : ''}`} onClick={() => set({ bold: !draft.bold })} title="Gras"><b>B</b></button>
                <button className={`fmt${draft.italic ? ' on' : ''}`} onClick={() => set({ italic: !draft.italic })} title="Italique"><i>I</i></button>
              </div>
              <textarea className="s-text" autoFocus value={text} placeholder="Ajouter du texte" onChange={(e) => setText(e.target.value)} />
              {!textTool && (
                <div className="s-row"><span>Alignement du texte</span>
                  <select value={draft.vAlign ?? 'top'} onChange={(e) => set({ vAlign: e.target.value as DrawProps['vAlign'] })}><option value="top">Haut</option><option value="middle">Milieu</option><option value="bottom">Bas</option></select>
                  <select value={draft.hAlign ?? 'center'} onChange={(e) => set({ hAlign: e.target.value as DrawProps['hAlign'] })}><option value="left">Gauche</option><option value="center">Centre</option><option value="right">Droite</option></select>
                </div>
              )}
            </>
          )}
          {tab === 'Coordonnées' && pts.map((x, i) => (
            <div key={i} className="s-row"><span>#{i + 1} (prix)</span>
              <input value={x.value} onChange={(e) => setPts(pts.map((y, j) => (j === i ? { ...y, value: e.target.value } : y)))} />
              <small>{x.time ? fmtDate(x.time) : 'à venir'}</small>
            </div>
          ))}
          {tab === 'Visibilité' && (
            <>
              <div className="s-sub">Afficher ce dessin sur les unités de temps :</div>
              <div className="s-tfs">
                {TIMEFRAMES.map((tf) => (
                  <label key={tf} className="s-check">
                    <input type="checkbox" checked={!(draft.hideOn ?? []).includes(tf)}
                      onChange={(e) => set({ hideOn: e.target.checked ? (draft.hideOn ?? []).filter((x) => x !== tf) : [...(draft.hideOn ?? []), tf] })} />{TF_LABEL[tf]}
                  </label>
                ))}
              </div>
              <label className="s-check"><input type="checkbox" checked={!draft.hidden} onChange={(e) => set({ hidden: !e.target.checked })} />Dessin visible</label>
            </>
          )}
        </div>
        <div className="modal-actions"><button onClick={p.onClose}>Annuler</button><button className="primary" onClick={ok}>D’accord</button></div>
      </div>
    </div>
  )
}
