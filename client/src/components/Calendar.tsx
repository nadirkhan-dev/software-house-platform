import { useMemo, useState } from 'react';
import type { Task } from '../lib/types';

/**
 * Month calendar for tasks, keyed on due date.
 *
 * Deliberately a month grid rather than a week or agenda: due dates are the
 * thing people scan for, and a month is the unit a delivery lead thinks in.
 * Tasks with no due date are listed separately rather than hidden — an
 * undated task is usually a planning gap, not something to disappear.
 */

const PRI_COLOUR: Record<string, string> = {
  urgent: 'var(--cost)', high: 'var(--warn)', medium: 'var(--rev)', low: 'var(--muted)',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function Calendar({ tasks, onOpen }: { tasks: Task[]; onOpen?: (t: Task) => void }) {
  const [cursor, setCursor] = useState(() => {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0); return d;
  });

  const { cells, undated, monthLabel } = useMemo(() => {
    const year = cursor.getFullYear(), month = cursor.getMonth();
    const first = new Date(year, month, 1);
    // Monday-first: getDay() is Sunday-first, so shift it.
    const lead = (first.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    const byDay = new Map<string, Task[]>();
    for (const t of tasks) {
      if (!t.due_on) continue;
      const key = t.due_on.slice(0, 10);
      byDay.set(key, [...(byDay.get(key) ?? []), t]);
    }

    const out: { date: Date | null; key: string; tasks: Task[] }[] = [];
    for (let i = 0; i < lead; i++) out.push({ date: null, key: `pad-${i}`, tasks: [] });
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(year, month, d);
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      out.push({ date, key, tasks: byDay.get(key) ?? [] });
    }
    while (out.length % 7 !== 0) out.push({ date: null, key: `tail-${out.length}`, tasks: [] });

    return {
      cells: out,
      undated: tasks.filter(t => !t.due_on && t.status !== 'done'),
      monthLabel: first.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    };
  }, [cursor, tasks]);

  const today = new Date().toDateString();
  const shift = (n: number) => setCursor(c => new Date(c.getFullYear(), c.getMonth() + n, 1));

  return (
    <>
      <div className="calbar">
        <button className="btn tiny" onClick={() => shift(-1)} aria-label="Previous month">←</button>
        <strong>{monthLabel}</strong>
        <button className="btn tiny" onClick={() => shift(1)} aria-label="Next month">→</button>
        <button className="btn tiny" onClick={() => {
          const d = new Date(); d.setDate(1); setCursor(d);
        }}>Today</button>
      </div>

      <div className="calgrid">
        {WEEKDAYS.map(w => <div key={w} className="calhead">{w}</div>)}
        {cells.map(c => (
          <div key={c.key} className={`calcell ${!c.date ? 'pad' : ''} ${
            c.date?.toDateString() === today ? 'today' : ''}`}>
            {c.date && <div className="caldate">{c.date.getDate()}</div>}
            {c.tasks.slice(0, 4).map(t => {
              const overdue = t.status !== 'done' && c.date! < new Date(new Date().toDateString());
              return (
                <button key={t.id} className={`calpill ${t.status === 'done' ? 'done' : ''}`}
                  style={{ borderLeftColor: overdue ? 'var(--cost)' : PRI_COLOUR[t.priority] }}
                  title={`${t.title} — ${t.project_name}${t.assignee_name ? ` · ${t.assignee_name}` : ''}`}
                  onClick={() => onOpen?.(t)}>
                  {t.title}
                </button>
              );
            })}
            {c.tasks.length > 4 && <div className="calmore">+{c.tasks.length - 4} more</div>}
          </div>
        ))}
      </div>

      {!!undated.length && (
        <div className="calundated">
          <div className="navlbl">No due date · {undated.length}</div>
          <div className="calpills">
            {undated.map(t => (
              <button key={t.id} className="calpill"
                style={{ borderLeftColor: PRI_COLOUR[t.priority] }}
                title={`${t.title} — ${t.project_name}`} onClick={() => onOpen?.(t)}>
                {t.title}
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
