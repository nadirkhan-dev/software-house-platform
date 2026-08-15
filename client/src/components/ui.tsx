import { useEffect, useRef, useState, type ReactNode } from 'react';
import { has } from '../lib/format';

/** A value the server withheld. Never a zero — a zero is a fact, this is a gap. */
export const Redacted = () => (
  <span className="red num" title="Hidden at your permission level">▨▨▨▨▨</span>
);

/** Renders a value, or the redaction block when the field is absent. */
export function Money({ value, fmt }: { value?: number | null; fmt: (n: number | string) => string }) {
  return has(value) ? <>{fmt(value as number)}</> : <Redacted />;
}

export function Chip({ tone = 'flat', children }: { tone?: 'good' | 'warn' | 'bad' | 'flat'; children: ReactNode }) {
  return <span className={`chip ${tone}`}>{children}</span>;
}

const HEALTH = { good: 'On margin', warn: 'At risk', bad: 'Losing money' } as const;

export function Health({ value }: { value?: 'good' | 'warn' | 'bad' }) {
  if (!value) return null;
  return <span className={`chip ${value}`}><i className="dot" />{HEALTH[value]}</span>;
}

/** Skeleton rows, so a loading table holds its shape instead of collapsing. */
export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="pad">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skel" style={{ width: `${92 - i * 7}%` }} />
      ))}
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="empty"><b>{title}</b>{children}</div>;
}

export function ErrorState({ error, onRetry }: { error: Error; onRetry?: () => void }) {
  return (
    <div className="empty">
      <b>{error.message}</b>
      {onRetry && <button className="btn" style={{ marginTop: 12 }} onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function Card({ title, meta, children, className = '' }:
  { title?: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`card ${className}`}>
      {title && <h2>{title}{meta && <em>{meta}</em>}</h2>}
      {children}
    </div>
  );
}

/* -------------------------------------------------------------- modal */

/**
 * Escape closes, focus moves in on open and back on close, and a click on the
 * backdrop dismisses. A modal you can only leave with the mouse is a trap for
 * anyone using a keyboard.
 */
export function Modal({ title, meta, onClose, children, wide }:
  { title: string; meta?: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const returnTo = useRef<Element | null>(null);

  useEffect(() => {
    returnTo.current = document.activeElement;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      (returnTo.current as HTMLElement | null)?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-wrap" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <h2>{title}{meta && <em>{meta}</em>}</h2>
        {children}
      </div>
    </div>
  );
}

/** Destructive actions get a confirm step, always. */
export function Confirm({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }:
  { title: string; body: ReactNode; confirmLabel?: string; danger?: boolean;
    onConfirm: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose}>
      <div className="pad">
        <div style={{ fontSize: 13.5, lineHeight: 1.55 }}>{body}</div>
        <div className="modal-act">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className={`btn ${danger ? 'danger' : 'pri'}`} disabled={busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export function Field({ label: text, error, children }:
  { label: string; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label>{text}</label>
      {children}
      {error && <div className="fielderr">{error}</div>}
    </div>
  );
}

/** Table that becomes cards on a phone rather than a horizontal scrollbar. */
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="tscroll">
      <table><thead>{head}</thead><tbody>{children}</tbody></table>
    </div>
  );
}

export function Bar({ value, tone }: { value: number; tone: string }) {
  return (
    <div className="mini">
      <i style={{ width: `${Math.min(100, value * 100)}%`, background: tone }} />
    </div>
  );
}
