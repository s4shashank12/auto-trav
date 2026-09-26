import {
  KeyboardSensor, PointerSensor, TouchSensor, useSensor, useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { useEffect, useRef, useState } from 'react';

// Small stroke icons (24x24), drawn in currentColor.
const PATHS = {
  foot: 'M14.5 17.5 3 6V3h3l11.5 11.5M13 19l6-6M16 16l4 4M19 21l2-2',
  horse: 'M7 20v-8a5 5 0 0 1 10 0v8M4.5 20H9M15 20h4.5',
  siege: 'M12 9.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM12 9.5v9M7.5 14h9M4 5l8 4.5',
  chief: 'M4 18h16M5 18 4 8l5 4 3-6 3 6 5-4-1 10',
  settler: 'M3 20 12 5l9 15ZM10 20l2-5 2 5',
  grip: 'M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01',
  plus: 'M12 5v14M5 12h14',
  x: 'M6 6l12 12M18 6 6 18',
  play: 'M8 5v14l11-7Z',
  stop: 'M7 7h10v10H7Z',
  bolt: 'M13 3 5 14h6l-1 7 8-11h-6Z',
  check: 'M5 12.5 10 17l9-10',
  pause: 'M9 6v12M15 6v12',
  alert: 'M12 4 2.5 20h19ZM12 10v4.5M12 17.5h.01',
  lock: 'M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5Z',
  castle: 'M4 20V9h3V6h3v3h4V6h3v3h3v11ZM10 20v-5h4v5',
  menu: 'M4 7h16M4 12h16M4 17h16',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  moon: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z',
  book: 'M5 4h9a4 4 0 0 1 4 4v12H9a4 4 0 0 1-4-4ZM5 16a4 4 0 0 1 4-4h9',
  hammer: 'M13 4l7 7-2.5 2.5-2-2-8.8 8.8a1.6 1.6 0 0 1-2.3-2.3L13.2 9.2l-2.7-2.7Z',
  target: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 12h.01',
};

export function Icon({ name, size = 16, className = '' }) {
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.x} />
    </svg>
  );
}

const STATUS = {
  running: { label: 'Running', icon: 'play', tone: 'good' },
  sleeping: { label: 'Waiting', icon: 'pause', tone: 'info' },
  stopped: { label: 'Stopped', icon: 'stop', tone: 'muted' },
  error: { label: 'Error', icon: 'alert', tone: 'critical' },
  captcha: { label: 'CAPTCHA', icon: 'lock', tone: 'serious' },
};

// Status always carries an icon and a label, never color alone.
export function StatusBadge({ status }) {
  const s = STATUS[status] ?? STATUS.stopped;
  return (
    <span className={`status status-${s.tone}`}>
      <Icon name={s.icon} size={12} />
      {s.label}
    </span>
  );
}

const compact = (n) => {
  if (n == null || Number.isNaN(n)) return '—';
  if (Math.abs(n) >= 10_000) return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  return n.toLocaleString('en');
};

export function StatTile({ label, value, sub }) {
  return (
    <div className="stat-tile">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{typeof value === 'number' ? compact(value) : value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

// A value against a limit: the fill and its track are two steps of the same hue.
export function Meter({ value, max, label }) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value} aria-label={label}>
      <div className="meter-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Stepper({
  value, min = 0, max = 999, step = 1, onChange, label,
}) {
  const set = (v) => onChange(Math.max(min, Math.min(max, v)));
  return (
    <span className="stepper" aria-label={label}>
      <button type="button" aria-label={`Less ${label ?? ''}`} onClick={() => set(value - step)} disabled={value <= min}>−</button>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        aria-label={label}
        onChange={(e) => e.target.value !== '' && set(Number(e.target.value))}
      />
      <button type="button" aria-label={`More ${label ?? ''}`} onClick={() => set(value + step)} disabled={value >= max}>+</button>
    </span>
  );
}

// Unsaved changes, shared by every settings tab.
export function SaveBar({ draft }) {
  const { dirty, status } = draft;
  if (!dirty && !status.message && !status.error) return null;
  return (
    <div className={`savebar ${dirty ? 'dirty' : ''}`} role="status">
      <span>
        {status.error ? <span className="error">{status.error}</span>
          : dirty ? 'You have unsaved changes.' : status.message}
      </span>
      {dirty && (
        <span className="row">
          <button type="button" className="btn ghost" onClick={draft.discard} disabled={status.busy}>Discard</button>
          <button type="button" className="btn primary" onClick={() => draft.save()} disabled={status.busy}>{status.busy ? 'Saving…' : 'Save changes'}</button>
        </span>
      )}
    </div>
  );
}

// A button that opens a small list of actions.
export function Menu({ label, icon, items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        {icon && <Icon name={icon} />}
        {label}
      </button>
      {open && (
        <div className="menu-list" role="menu">
          {items.map((it) => (
            <button
              key={it.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              <span>{it.label}</span>
              {it.hint && <small>{it.hint}</small>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Mouse, touch (after a short press, so pages still scroll) and keyboard dragging.
export function useDragSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

export const UNIT_ICON = {
  foot: 'foot', horse: 'horse', siege: 'siege', chief: 'chief', settler: 'settler',
};
