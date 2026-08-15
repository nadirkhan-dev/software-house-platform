/** Shared formatting. Redaction is a first-class case: a field the server
 *  withheld renders as a block, never as a zero. */

export const has = (v: unknown): boolean => v !== undefined && v !== null;

export const usd = (n: number | string) =>
  (Number(n) < 0 ? '−' : '') + '$' + Math.abs(Math.round(Number(n))).toLocaleString('en-US');

export const usdK = (n: number | string) => {
  const v = Number(n);
  return Math.abs(v) >= 1000
    ? (v < 0 ? '−' : '') + '$' + (Math.abs(v) / 1000).toFixed(Math.abs(v) < 10000 ? 1 : 0) + 'k'
    : usd(v);
};

export const pkr = (n: number | string) => {
  const v = Number(n);
  return '₨' + (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : Math.round(v).toLocaleString('en-US'));
};

export const pct = (n: number | string) => {
  const v = Number(n);
  return (v * 100).toFixed(v < 0 || v >= 1 ? 0 : 1) + '%';
};

export const hrs = (n: number | string) => {
  const v = Number(n);
  return v.toFixed(v < 10 ? 1 : 0) + 'h';
};

export const daysTo = (iso: string) => Math.round((new Date(iso).getTime() - Date.now()) / 86_400_000);

export const dayLabel = (iso?: string | null) => {
  if (!iso) return '—';
  const n = daysTo(iso);
  return n === 0 ? 'today' : n > 0 ? `in ${n}d` : `${-n}d ago`;
};

export const label = (s: string) => s.replace(/_/g, ' ');

export const bytes = (n: number) =>
  n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : n >= 1024 ? Math.round(n / 1024) + ' KB' : n + ' B';
