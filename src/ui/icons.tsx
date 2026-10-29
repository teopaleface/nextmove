// One family of 24px outline icons (1.75 stroke). Icons support labels; they never carry meaning alone.

type P = { size?: number; className?: string; title?: string };

function Svg({ size = 24, className, title, children }: P & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden={title ? undefined : true} role={title ? "img" : undefined}>
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

export const Icon = {
  home: (p: P) => (
    <Svg {...p}>
      <path d="M4 10.5 12 4l8 6.5" />
      <path d="M6 9.5V20h12V9.5" />
      <path d="M10 20v-5h4v5" />
    </Svg>
  ),
  activity: (p: P) => (
    <Svg {...p}>
      <path d="M8 6h12M8 12h12M8 18h12" />
      <path d="M4 6h.01M4 12h.01M4 18h.01" />
    </Svg>
  ),
  goals: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="4" />
      <path d="M12 12h.01" />
    </Svg>
  ),
  agent: (p: P) => (
    <Svg {...p}>
      <path d="M12 3.5 14.2 9.8 20.5 12l-6.3 2.2L12 20.5l-2.2-6.3L3.5 12l6.3-2.2z" />
    </Svg>
  ),
  chevronRight: (p: P) => (
    <Svg {...p}>
      <path d="m9 6 6 6-6 6" />
    </Svg>
  ),
  chevronLeft: (p: P) => (
    <Svg {...p}>
      <path d="m15 6-6 6 6 6" />
    </Svg>
  ),
  chevronDown: (p: P) => (
    <Svg {...p}>
      <path d="m6 9 6 6 6-6" />
    </Svg>
  ),
  check: (p: P) => (
    <Svg {...p}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  ),
  checkCircle: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12.5 3 3 5-6" />
    </Svg>
  ),
  clock: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </Svg>
  ),
  warning: (p: P) => (
    <Svg {...p}>
      <path d="M12 4 2.8 19.5h18.4z" />
      <path d="M12 10v4.5M12 17h.01" />
    </Svg>
  ),
  x: (p: P) => (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6 6 18" />
    </Svg>
  ),
  xCircle: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </Svg>
  ),
  doc: (p: P) => (
    <Svg {...p}>
      <path d="M7 3.5h7l4 4V20.5H7z" />
      <path d="M14 3.5V8h4M10 12h5M10 15.5h5" />
    </Svg>
  ),
  lock: (p: P) => (
    <Svg {...p}>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
    </Svg>
  ),
  plus: (p: P) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  image: (p: P) => (
    <Svg {...p}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m20.5 16-4.5-4.5L7 19" />
    </Svg>
  ),
  bell: (p: P) => (
    <Svg {...p}>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </Svg>
  ),
  card: (p: P) => (
    <Svg {...p}>
      <rect x="3" y="6" width="18" height="12.5" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </Svg>
  ),
  send: (p: P) => (
    <Svg {...p}>
      <path d="M5 12h13M13 6l6 6-6 6" />
    </Svg>
  ),
  arrowUp: (p: P) => (
    <Svg {...p}>
      <path d="M12 19V5M6 11l6-6 6 6" />
    </Svg>
  ),
  stop: (p: P) => (
    <Svg {...p}>
      <rect x="6.5" y="6.5" width="11" height="11" rx="1.5" />
    </Svg>
  ),
  refresh: (p: P) => (
    <Svg {...p}>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </Svg>
  ),
  external: (p: P) => (
    <Svg {...p}>
      <path d="M14 5h5v5M19 5l-8 8" />
      <path d="M17 13.5V19H5V7h5.5" />
    </Svg>
  ),
  info: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5.5M12 7.5h.01" />
    </Svg>
  ),
  calendar: (p: P) => (
    <Svg {...p}>
      <rect x="4" y="5.5" width="16" height="15" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </Svg>
  ),
  repeat: (p: P) => (
    <Svg {...p}>
      <path d="M17 3.5 20 6.5l-3 3" />
      <path d="M4 11.5v-1a4 4 0 0 1 4-4h12" />
      <path d="M7 20.5 4 17.5l3-3" />
      <path d="M20 12.5v1a4 4 0 0 1-4 4H4" />
    </Svg>
  ),
  shield: (p: P) => (
    <Svg {...p}>
      <path d="M12 3.5 19 6v5.5c0 4.3-3 7.6-7 9-4-1.4-7-4.7-7-9V6z" />
    </Svg>
  ),
  eye: (p: P) => (
    <Svg {...p}>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </Svg>
  ),
  pause: (p: P) => (
    <Svg {...p}>
      <path d="M9 6v12M15 6v12" />
    </Svg>
  ),
  briefcase: (p: P) => (
    <Svg {...p}>
      <rect x="3.5" y="7.5" width="17" height="12" rx="2" />
      <path d="M9 7.5V5.5h6v2M3.5 12.5h17" />
    </Svg>
  ),
  user: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 20c.8-3.6 3.6-5.5 7-5.5s6.2 1.9 7 5.5" />
    </Svg>
  ),
  globe: (p: P) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.7 5.6 3.7 9s-1.2 6.4-3.7 9c-2.5-2.6-3.7-5.6-3.7-9S9.5 5.6 12 3z" />
    </Svg>
  ),
  download: (p: P) => (
    <Svg {...p}>
      <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
    </Svg>
  ),
};

/** The N mark: a small geometric glyph on the yellow square. */
export function NMark({ size = 28 }: { size?: number }) {
  return (
    <span className="nmark" style={{ width: size, height: size, background: "none" }} aria-hidden="true">
      {/* The app icon (demo-video/assets/brand/nextmove-icon.svg): an N whose last stroke stops short, then the move. */}
      <svg width={size} height={size} viewBox="0 0 256 256">
        <rect width="256" height="256" rx="56" fill="#151515" />
        <path fill="#F7F7F2" d="M82.88 190.57A17.86 17.86 0 0 1 47.16 190.57L47.16 70.25A17.86 17.86 0 0 1 82.88 70.25ZM52.39 82.88A17.86 17.86 0 0 1 77.65 57.62L197.97 177.94A17.86 17.86 0 0 1 172.71 203.2ZM203.2 190.57A17.86 17.86 0 0 1 167.48 190.57L167.48 151.09A17.86 17.86 0 0 1 203.2 151.09Z" />
        <path fill="#FEE600" d="M160.9 73.07A24.439999999999998 24.439999999999998 0 1 1 209.78 73.07A24.439999999999998 24.439999999999998 0 1 1 160.9 73.07Z" />
      </svg>
    </span>
  );
}

/** Small geometric agent signature used on agent-originated surfaces. */
export function AgentSig({ label = "NextMove agent" }: { label?: string }) {
  return (
    <span className="agent-sig">
      <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
        <rect x="1" y="1" width="12" height="12" rx="3" fill="#FEE600" />
        <path d="M7 3.6 8.1 5.9 10.4 7 8.1 8.1 7 10.4 5.9 8.1 3.6 7 5.9 5.9z" fill="#151515" />
      </svg>
      {label}
    </span>
  );
}
