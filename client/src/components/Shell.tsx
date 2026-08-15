import { useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useSession } from '../lib/session';
import { applyTheme, readTheme, type Theme } from '../lib/theme';
import type { Notification, SearchHit } from '../lib/types';
import { dayLabel } from '../lib/format';
import { QuickCreate } from './QuickCreate';

const NAV = [
  { to: '/', label: 'Dashboard', key: '1' },
  { to: '/leads', label: 'Pipeline', key: '2', sales: true },
  { to: '/quotes', label: 'Quotes', key: '3' },
  { to: '/projects', label: 'Projects', key: '4' },
  { to: '/tasks', label: 'Tasks', key: '5' },
  { to: '/time', label: 'Timesheet', key: '6' },
  { to: '/expenses', label: 'Expenses', key: '7', internal: true },
  { to: '/invoices', label: 'Invoices', key: '8' },
  { to: '/documents', label: 'Documents', key: '9' },
  { to: '/team', label: 'Team', key: '0', revenue: true },
  { to: '/reports', label: 'Reports', revenue: true },
  { to: '/settings', label: 'Settings', revenue: true },
];

const SALES_ROLES = ['admin', 'sales', 'pm'];

export function Shell({ children }: { children: React.ReactNode }) {
  const { user, perms, signOut } = useSession();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [collapsed, setCollapsed] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [sel, setSel] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => applyTheme(theme), [theme]);

  // Debounced: a request per keystroke is a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term), 200);
    return () => clearTimeout(t);
  }, [term]);

  const { data: results } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<{ results: SearchHit[] }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.trim().length >= 2,
  });

  const { data: notes } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ notifications: Notification[]; unread: number }>('/notifications'),
    refetchInterval: 60_000,
  });

  // "/" focuses search from anywhere, the way every tool people already use does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement).tagName);
      if (e.key === '/' && !typing) { e.preventDefault(); searchRef.current?.focus(); return; }
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault(); setQuickOpen(true); return;
      }
      if (typing) return;
      const item = NAV.find(n => n.key === e.key);
      if (item) nav(item.to);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nav]);

  if (!user || !perms) return null;

  const items = NAV.filter(n =>
    (!n.revenue || perms.seesRevenue) &&
    (!n.internal || !perms.isAssignedOnly) &&
    (!n.sales || SALES_ROLES.includes(user.role)) &&
    (!perms.isClient || ['/', '/projects', '/quotes', '/invoices', '/documents'].includes(n.to)));

  const hits = results?.results ?? [];

  const openHit = (h: SearchHit) => {
    setTerm(''); setSel(-1);
    nav(h.link.startsWith('project:') ? `/projects/${h.link.slice(8)}` : `/${h.link.replace(/^\//, '')}`);
  };

  return (
    <div className={`app ${collapsed ? 'collapsed' : ''}`}>
      <aside className="rail">
        <div className="brand">
          <b>Marginly</b><span>v1.0</span>
          <button className="railtoggle" onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>{collapsed ? '›' : '‹'}</button>
        </div>
        <div className="brandrule" />
        <nav className="navgrp">
          <div className="navlbl">{perms.isClient ? 'Client' : 'Operations'}</div>
          {items.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/'}
              className={({ isActive }) => `nav ${isActive ? 'on' : ''}`}>
              <span className="k">{n.key ?? '·'}</span><span className="nt">{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="railfoot">
          <div className="who">
            <div className="avatar">{user.name.split(' ').map(w => w[0]).slice(0, 2).join('')}</div>
            <div className="nt">
              <div className="nm">{user.name}</div>
              <div className="rl">{user.role} · {user.tenant}</div>
            </div>
          </div>
          <button className="btn tiny" onClick={() => { void signOut(); }}>Sign out</button>
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <div className="searchbox">
            <input ref={searchRef} value={term} onChange={e => { setTerm(e.target.value); setSel(-1); }}
              onKeyDown={e => {
                if (e.key === 'Escape') { setTerm(''); e.currentTarget.blur(); }
                if (!hits.length) return;
                if (e.key === 'ArrowDown') { e.preventDefault(); setSel(s => (s + 1) % hits.length); }
                if (e.key === 'ArrowUp') { e.preventDefault(); setSel(s => (s - 1 + hits.length) % hits.length); }
                if (e.key === 'Enter') { e.preventDefault(); const h = hits[sel < 0 ? 0 : sel]; if (h) openHit(h); }
              }}
              type="search" placeholder="Search…  press /" aria-label="Search" autoComplete="off" />
            {term.trim().length >= 2 && (
              <div className="results">
                {hits.length ? hits.map((h, i) => (
                  <div key={`${h.type}-${h.id}`} className={`rrow ${i === sel ? 'sel' : ''}`}
                    onMouseDown={() => openHit(h)}>
                    <span className="rt">{h.type}</span>
                    <span className="rl">{h.label}</span>
                    <span className="rh">{h.hint}</span>
                  </div>
                )) : <div className="rrow"><span className="rl" style={{ color: 'var(--muted)' }}>Nothing found</span></div>}
              </div>
            )}
          </div>

          <div className="topspace" />

          {!perms.isClient && (
            <button className="btn pri" onClick={() => setQuickOpen(true)} title="Create anything  ⌘K">
              + Create
            </button>
          )}
          <button className="topbtn" onClick={() => setBellOpen(o => !o)} aria-label="Notifications">
            ◔{notes?.unread ? <span className="dot-badge">{notes.unread > 9 ? '9+' : notes.unread}</span> : null}
          </button>
          <button className="topbtn" onClick={() => setTheme(t => (t === 'dark' ? 'light' : 'dark'))}
            aria-label="Toggle light or dark theme">◐</button>

          {bellOpen && (
            <div className="panel" onMouseLeave={() => setBellOpen(false)}>
              {notes?.notifications.length ? notes.notifications.map(n => (
                <div key={n.id} className={`nrow ${n.read_at ? '' : 'unread'}`}
                  onClick={() => { setBellOpen(false); if (n.link) nav(n.link); }}>
                  {n.title}<time>{dayLabel(n.created_at)}</time>
                </div>
              )) : <div className="empty"><b>Nothing new.</b>Approvals, payments and assignments land here.</div>}
              {!!notes?.unread && (
                <button className="btn tiny" style={{ margin: 10 }}
                  onClick={async () => {
                    await api('/notifications/read', { method: 'POST', body: {} });
                    void qc.invalidateQueries({ queryKey: ['notifications'] });
                  }}>Mark all read</button>
              )}
            </div>
          )}
        </header>

        <main className="view">{children}</main>
      </div>

      {quickOpen && <QuickCreate onClose={() => setQuickOpen(false)} />}
    </div>
  );
}
