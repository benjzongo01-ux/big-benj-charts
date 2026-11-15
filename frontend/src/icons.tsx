// Icônes de l'interface : tracés SVG fins, nets à toutes les tailles et dans les deux thèmes.
const P: Record<string, JSX.Element> = {
  cross: <path d="M12 3v18M3 12h18" />,
  path: <><path d="M4 17l5-8 4 5 7-8" /><path d="M16 6h4v4" /></>,
  long: <><path d="M4 4h16M4 20h16M4 12h16" /><path d="M10 8.5v7h4" /></>,
  short: <><path d="M4 4h16M4 20h16M4 12h16" /><path d="M14.5 9c-.6-.7-1.5-1-2.5-1-1.4 0-2.5.8-2.5 1.9 0 2.4 5 1.4 5 3.9 0 1.1-1.1 2.2-2.6 2.2-1 0-2-.4-2.6-1.1" /></>,
  gear: <><circle cx="12" cy="12" r="3" /><path d="M12 2l2 3 3.5-1 .5 3.5 3 2-2 3 2 3-3 2-.5 3.5-3.5-1-2 3-2-3-3.5 1-.5-3.5-3-2 2-3-2-3 3-2L6.5 4 10 5z" /></>,
  unlock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 017.5-2" /></>,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" strokeWidth="3" />,
  pencil: <path d="M4 20h4L19 9l-4-4L4 16zM14 6l4 4" />,
  keep: <><path d="M5 19L19 5" /><path d="M14 5h5v5" /><path d="M4 13a8 8 0 007 7" /></>,
  line: <><path d="M5.5 18.5l13-13" /><circle cx="4" cy="20" r="2" /><circle cx="20" cy="4" r="2" /></>,
  ray: <><path d="M5.5 18.5L21 3" /><circle cx="4" cy="20" r="2" /></>,
  hline: <><path d="M3 12h7M14 12h7" /><circle cx="12" cy="12" r="2" /></>,
  hray: <><path d="M6 12h15" /><circle cx="4" cy="12" r="2" /></>,
  vline: <><path d="M12 3v7M12 14v7" /><circle cx="12" cy="12" r="2" /></>,
  channel: <path d="M3 15L15 3M9 21L21 9" />,
  fib: <path d="M3 5h18M3 10h18M3 14h18M3 20h18" />,
  fibext: <path d="M3 20L10 8l4 6 7-11M14 8h7M14 14h7M3 20h18" />,
  shape: <rect x="4" y="6" width="16" height="12" rx="1" />,
  text: <path d="M5 6V4h14v2M12 4v16M9 20h6" />,
  emoji: <><circle cx="12" cy="12" r="9" /><path d="M8.5 14.5c1.6 2 5.4 2 7 0M9 9.5v.5M15 9.5v.5" /></>,
  ruler: <path d="M3 17L17 3l4 4L7 21zM7.5 12.5l2 2M10.5 9.5l2 2M13.5 6.5l2 2" />,
  zoomIn: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-5-5M8 11h6M11 8v6" /></>,
  zoomOut: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-5-5M8 11h6" /></>,
  magnet: <path d="M6 3v9a6 6 0 0012 0V3h-4v9a2 2 0 01-4 0V3zM6 7h4M14 7h4" />,
  lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 018 0v3" /></>,
  eye: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  eyeOff: <><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z" /><path d="M4 4l16 16" /></>,
  trash: <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="M21 21l-5-5" /></>,
  fx: <path d="M4 19c3 0 3-14 6-14M4 11h6M13 12l7 7M20 12l-7 7" />,
  alarm: <><circle cx="12" cy="13" r="7" /><path d="M12 9.5V13l2.5 1.5M5 4L2 7M19 4l3 3" /></>,
  rewind: <path d="M11 6l-8 6 8 6zM21 6l-8 6 8 6z" />,
  undo: <path d="M9 14L4 9l5-5M4 9h10a6 6 0 010 12h-3" />,
  redo: <path d="M15 14l5-5-5-5M20 9H10a6 6 0 000 12h3" />,
  layout: <><rect x="3" y="3" width="18" height="18" rx="2" /><path d="M12 3v18M3 12h18" /></>,
  fullscreen: <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />,
  camera: <><path d="M4 8h3l2-3h6l2 3h3v11H4z" /><circle cx="12" cy="13" r="3.5" /></>,
  star: <path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z" />,
  list: <path d="M4 6h16M4 12h16M4 18h10" />,
  orders: <><path d="M6 3h12v18H6z" /><path d="M9 8h6M9 12h6M9 16h4" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M4 10h16M8 3v4M16 3v4" /></>,
  bell: <path d="M6 16v-5a6 6 0 0112 0v5l2 2H4zM10 21h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  down: <path d="M6 9l6 6 6-6" />,
  up: <path d="M6 15l6-6 6 6" />,
  right: <path d="M9 6l6 6-6 6" />,
  left: <path d="M15 6l-6 6 6 6" />,
  pattern: <path d="M3 17l5-9 4 6 4-10 5 13" />,
  position: <path d="M8 20V4M4 8l4-4 4 4M16 4v16M12 16l4 4 4-4" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></>,
  moon: <path d="M20 14A8 8 0 1110 4a6 6 0 0010 10z" />,
  logout: <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />,
  grip: <path d="M9 6v.01M15 6v.01M9 12v.01M15 12v.01M9 18v.01M15 18v.01" strokeWidth="2.6" />,
  pause: <path d="M8 5v14M16 5v14" />,
  play: <path d="M7 4l13 8-13 8z" />,
  edit: <path d="M4 20h4L20 8l-4-4L4 16z" />,
  candles: <><path d="M7 3v4M7 16v5M17 3v6M17 17v4" /><rect x="5" y="7" width="4" height="9" /><rect x="15" y="9" width="4" height="8" /></>,
  expand: <path d="M4 14v6h6M20 10V4h-6M4 20l7-7M20 4l-7 7" />,
  shrink: <path d="M10 20v-6H4M14 4v6h6M4 20l6-6M20 4l-6 6" />,
}

export type IconName = keyof typeof P

export function Icon({ name, size = 18 }: { name: string; size?: number }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[name] ?? P.cross}
    </svg>
  )
}

export const hasIcon = (name: string): boolean => name in P
